import type { Event } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"
import { watch } from "node:fs"
import { basename } from "node:path"
import { Telemetry } from "./telemetry"
import { readQuotaSnapshot } from "./quota"
import {
  attributeBurn,
  compactionTurnsUntil,
  computeEstimate,
  contextGrowthPerTurn,
  type EstimateInput,
} from "./calibrator"
import {
  ESTIMATE_PATH,
  HISTORY_PATH,
  SELECTION_PATH,
  STATE_DIR,
  freshHistory,
  readJson,
  writeJsonAtomic,
  type ContextEstimate,
  type EstimateFile,
  type HistoryState,
  type TuiSelection,
} from "./shared"

const POLL_INTERVAL_MS = 60_000
const RECOMPUTE_DEBOUNCE_MS = 1_000
const EXTERNAL_EWMA_ALPHA = 0.3
const SELECTION_DEBOUNCE_MS = 300

const TRACKED_EVENTS = new Set([
  "session.created",
  "session.deleted",
  "session.idle",
  "session.compacted",
  "message.updated",
  "message.part.updated",
])

const plugin: Plugin = async ({ client }, _options) => {
  const history: HistoryState = readJson<HistoryState>(HISTORY_PATH) ?? freshHistory()
  const telemetry = new Telemetry(history)

  const modelLimits = new Map<string, { context?: number; output?: number }>()
  const modelNames = new Map<string, string>()
  let quota = readQuotaSnapshot()
  let lastSnapAt = 0
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let recomputeTimer: ReturnType<typeof setTimeout> | undefined
  let selectionWatcher: ReturnType<typeof watch> | undefined
  let selectionTimer: ReturnType<typeof setTimeout> | undefined

  function applySelection() {
    const sel = readJson<TuiSelection>(SELECTION_PATH)
    if (!sel?.providerID) return
    telemetry.overrideSelection({ provider: sel.providerID, model: sel.modelID })
  }

  function watchSelection() {
    applySelection()
    try {
      selectionWatcher = watch(STATE_DIR, (_event, filename) => {
        if (!filename || basename(String(filename)) !== "selection.json") return
        if (selectionTimer) clearTimeout(selectionTimer)
        selectionTimer = setTimeout(() => {
          selectionTimer = undefined
          applySelection()
          recompute()
        }, SELECTION_DEBOUNCE_MS)
      })
    } catch (err) {
      log(`selection watcher failed: ${String(err)}`)
    }
  }

  function log(msg: string) {
    try {
      void client.app.log({ body: { service: "opencode-prompt-left", level: "info", message: msg } })
    } catch {
      console.error(`[opencode-prompt-left] ${msg}`)
    }
  }

  async function init() {
    try {
      const sessions = await client.session.list()
      const rows = Array.isArray(sessions.data) ? sessions.data : []
      telemetry.hydrate(rows)
    } catch (err) {
      log(`session hydrate failed: ${String(err)}`)
    }
    try {
      const cfg = await client.config.get()
      const providers = (cfg.data?.provider ?? {}) as Record<string, { models?: Record<string, { name?: string; limit?: { context?: number; input?: number; output?: number } }> }>
      for (const [pid, p] of Object.entries(providers)) {
        for (const [mid, m] of Object.entries(p.models ?? {})) {
          modelLimits.set(mid, { context: m.limit?.context, output: m.limit?.output })
          if (m.name) modelNames.set(mid, m.name)
        }
      }
    } catch (err) {
      log(`config fetch failed: ${String(err)}`)
    }
    refreshQuota()
    recompute()
  }

  function saveHistory() {
    history.turns = telemetry.finished
    history.lastSelected = telemetry.lastSelected
    writeJsonAtomic(HISTORY_PATH, history)
  }

  function refreshQuota() {
    const snap = readQuotaSnapshot()
    if (!snap || snap.at <= lastSnapAt) return
    lastSnapAt = snap.at
    quota = snap
    const now = Date.now()
    for (const e of snap.entries) {
      if (typeof e.percentRemaining !== "number") continue
      const key = `${e.provider}::${e.name}`
      const prevSeen = history.lastQuotaSeen[key]
      if (prevSeen !== undefined) {
        const delta = prevSeen - e.percentRemaining
        if (delta > 0) {
          const since = history.lastObsAt[key] ?? 0
          const turns = telemetry.finished.filter(
            (t) => t.finishedAt !== undefined && t.finishedAt >= since && t.byProvider[e.provider],
          )
          const attributed = attributeBurn(delta, turns, e.provider)
          for (const [regime, samples] of attributed) {
            const list = (history.regimeSamples[regime] ??= [])
            list.push(...samples)
            history.regimeSamples[regime] = list.slice(-30)
          }
          const share = turns.length === 0 ? 1 : 0
          history.externalShare = EXTERNAL_EWMA_ALPHA * share + (1 - EXTERNAL_EWMA_ALPHA) * history.externalShare
        }
      }
      history.lastQuotaSeen[key] = e.percentRemaining
      history.lastObsAt[key] = now
    }
    saveHistory()
    recompute()
  }

  function scheduleRecompute() {
    if (recomputeTimer) clearTimeout(recomputeTimer)
    recomputeTimer = setTimeout(() => {
      recomputeTimer = undefined
      saveHistory()
      recompute()
    }, RECOMPUTE_DEBOUNCE_MS)
  }

  function recompute() {
    const selected = telemetry.activeSelected()
    const context: ContextEstimate = {
      usable: null,
      current: telemetry.contextNow(),
      growthPerTurn: contextGrowthPerTurn(telemetry.finished),
      untilCompaction: null,
    }
    if (selected.model) {
      const limits = modelLimits.get(selected.model)
      if (limits?.context) {
        context.usable = limits.context - Math.min(limits.output ?? 0, 20_000)
      }
    }
    context.untilCompaction = compactionTurnsUntil(context.usable, context.current, context.growthPerTurn)
    const input: EstimateInput = {
      now: Date.now(),
      quota,
      regimeSamples: history.regimeSamples,
      selected,
      externalShare: history.externalShare,
      rootTurns: telemetry.finished.length,
      modelLabel: selected.model ? (modelNames.get(selected.model) ?? selected.model) : undefined,
      context,
    }
    const estimate: EstimateFile = computeEstimate(input)
    writeJsonAtomic(ESTIMATE_PATH, estimate)
  }

  pollTimer = setInterval(refreshQuota, POLL_INTERVAL_MS)
  watchSelection()
  void init()

  return {
    async event({ event }: { event: Event }) {
      if (!TRACKED_EVENTS.has(event.type)) return
      telemetry.handle(event)
      scheduleRecompute()
    },
    async "chat.message"(input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } }) {
      if (input.model?.providerID) {
        telemetry.noteSelection(input.sessionID, {
          provider: input.model.providerID,
          model: input.model.modelID,
          agent: input.agent,
        })
        scheduleRecompute()
      }
    },
    async dispose() {
      if (pollTimer) clearInterval(pollTimer)
      if (recomputeTimer) clearTimeout(recomputeTimer)
      if (selectionTimer) clearTimeout(selectionTimer)
      if (selectionWatcher) selectionWatcher.close()
      saveHistory()
      recompute()
    },
  }
}

export default {
  id: "opencode-prompt-left",
  server: plugin,
}
