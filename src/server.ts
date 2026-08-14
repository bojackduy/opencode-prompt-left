import type { Event } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"
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
  freshHistory,
  readJson,
  writeJsonAtomic,
  type ContextEstimate,
  type EstimateFile,
  type HistoryState,
} from "./shared"

const POLL_INTERVAL_MS = 60_000
const RECOMPUTE_DEBOUNCE_MS = 1_000
const EXTERNAL_EWMA_ALPHA = 0.3

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
  let quota = readQuotaSnapshot()
  let lastSnapAt = 0
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let recomputeTimer: ReturnType<typeof setTimeout> | undefined

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
      const providers = (cfg.data?.provider ?? {}) as Record<string, { models?: Record<string, { limit?: { context?: number; input?: number; output?: number } }> }>
      for (const [pid, p] of Object.entries(providers)) {
        for (const [mid, m] of Object.entries(p.models ?? {})) {
          modelLimits.set(mid, { context: m.limit?.context, output: m.limit?.output })
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
      context,
    }
    const estimate: EstimateFile = computeEstimate(input)
    writeJsonAtomic(ESTIMATE_PATH, estimate)
  }

  pollTimer = setInterval(refreshQuota, POLL_INTERVAL_MS)
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
      saveHistory()
      recompute()
    },
  }
}

export default {
  id: "opencode-prompt-left",
  server: plugin,
}
