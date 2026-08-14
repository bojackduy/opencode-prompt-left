import type { Event } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"
import { watch } from "node:fs"
import { basename } from "node:path"
import { Telemetry } from "./telemetry"
import { readQuotaSnapshot } from "./quota"
import { computeEstimate, type EstimateInput } from "./calibrator"
import {
  ESTIMATE_PATH,
  HISTORY_PATH,
  SELECTION_PATH,
  STATE_DIR,
  freshHistory,
  readJson,
  writeJsonAtomic,
  type EstimateFile,
  type HistoryState,
  type TuiSelection,
  type WindowTracker,
} from "./shared"

const POLL_INTERVAL_MS = 60_000
const RECOMPUTE_DEBOUNCE_MS = 1_000
const EXTERNAL_EWMA_ALPHA = 0.3
const SELECTION_DEBOUNCE_MS = 300
const COMPACTION_BUFFER = 20_000
const MAX_WINDOW_OBSERVATIONS = 24

const TRACKED_EVENTS = new Set([
  "session.created",
  "session.deleted",
  "session.idle",
  "session.compacted",
  "message.updated",
  "message.part.updated",
  "message.removed",
])

interface ModelLimits {
  context?: number
  input?: number
  output?: number
}

const plugin: Plugin = async ({ client }, _options) => {
  const raw = readJson<HistoryState>(HISTORY_PATH)
  const history: HistoryState = raw?.version === 2 ? raw : freshHistory()
  const telemetry = new Telemetry(history)

  const modelLimits = new Map<string, ModelLimits>()
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
      telemetry.hydrate(rows, history.lastContext)
    } catch (err) {
      log(`session hydrate failed: ${String(err)}`)
    }
    try {
      const cfg = await client.config.get()
      const providers = (cfg.data?.provider ?? {}) as Record<
        string,
        { models?: Record<string, { name?: string; limit?: { context?: number; input?: number; output?: number } }> }
      >
      for (const [pid, p] of Object.entries(providers)) {
        for (const [mid, m] of Object.entries(p.models ?? {})) {
          modelLimits.set(mid, { context: m.limit?.context, input: m.limit?.input, output: m.limit?.output })
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
    history.prompts = telemetry.finished
    history.lastSelected = telemetry.lastSelected
    history.lastContext = telemetry.contextNow() ?? history.lastContext
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
      const tracker: WindowTracker = (history.windows[key] ??= { observations: [] })
      const prev = tracker.lastPercent
      if (prev === undefined) {
        tracker.lastPercent = e.percentRemaining
        tracker.lastPercentAt = now
        continue
      }
      if (e.percentRemaining < prev) {
        const delta = prev - e.percentRemaining
        const localCost = telemetry.providerCostSince(e.provider, tracker.lastPercentAt ?? 0)
        tracker.observations.push({ at: now, deltaPct: delta, localCost })
        if (tracker.observations.length > MAX_WINDOW_OBSERVATIONS) tracker.observations.shift()
        tracker.lastPercent = e.percentRemaining
        tracker.lastPercentAt = now
        const share = localCost > 0 ? 0 : 1
        history.externalShare = EXTERNAL_EWMA_ALPHA * share + (1 - EXTERNAL_EWMA_ALPHA) * history.externalShare
      } else if (e.percentRemaining > prev) {
        tracker.lastPercent = e.percentRemaining
        tracker.lastPercentAt = now
      }
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

  function usableContext(model: string | undefined): number | null {
    if (!model) return null
    const limits = modelLimits.get(model)
    if (!limits) return null
    const context = limits.context
    if (!context || context === 0) return null
    const reserved = Math.min(COMPACTION_BUFFER, limits.output ?? 20_000)
    if (limits.input) return Math.max(0, limits.input - reserved)
    return Math.max(0, context - (limits.output ?? 20_000))
  }

  function recompute() {
    const selected = telemetry.activeSelected()
    const input: EstimateInput = {
      now: Date.now(),
      quota,
      prompts: telemetry.finished,
      windows: history.windows,
      selected,
      contextNow: telemetry.contextNow(),
      usableContext: usableContext(selected.model),
      externalShare: history.externalShare,
      modelLabel: selected.model ? (modelNames.get(selected.model) ?? selected.model) : undefined,
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
      telemetry.noteSelection(input.sessionID, {
        provider: input.model?.providerID,
        model: input.model?.modelID,
        agent: input.agent,
      })
      telemetry.beginPrompt(input.sessionID, input.agent, input.model?.providerID, input.model?.modelID)
      scheduleRecompute()
    },
    async dispose() {
      if (pollTimer) clearInterval(pollTimer)
      if (recomputeTimer) clearTimeout(recomputeTimer)
      if (selectionTimer) clearTimeout(selectionTimer)
      if (selectionWatcher) selectionWatcher.close()
      telemetry.finalizeAll()
      saveHistory()
      recompute()
    },
  }
}

export default {
  id: "opencode-prompt-left",
  server: plugin,
}
