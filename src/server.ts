import type { Event } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"
import { watch, mkdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { Telemetry } from "./telemetry"
import { readQuotaSnapshot } from "./quota"
import { loadPlans, type Plans } from "./budget"
import { computeEstimate, type EstimateInput } from "./calibrator"
import {
  CONFIG_PATH,
  freshHistory,
  readJson,
  statePaths,
  workspaceKey,
  writeJsonAtomic,
  type ActiveFile,
  type EstimateFile,
  type HistoryState,
  type TuiSelection,
  type WindowTracker,
} from "./shared"

const POLL_INTERVAL_MS = 60_000
const RECOMPUTE_DEBOUNCE_MS = 1_000
const EXTERNAL_EWMA_ALPHA = 0.3
const SELECTION_DEBOUNCE_MS = 300
const BRIDGE_POLL_INTERVAL_MS = 5_000
const COMPACTION_BUFFER = 20_000
const MAX_WINDOW_OBSERVATIONS = 24

const TRACKED_EVENTS = new Set([
  "session.created",
  "session.deleted",
  "session.idle",
  "session.compacted",
  "session.next.model.switched",
  "session.next.agent.switched",
  "message.updated",
  "message.part.updated",
  "message.removed",
])

interface ModelInfo {
  name?: string
  context?: number
  output?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

const KEY = workspaceKey(process.cwd())
const paths = statePaths(KEY)

const plugin: Plugin = async ({ client }, _options) => {
  const raw = readJson<HistoryState>(paths.history)
  const history: HistoryState = raw?.version === 2 ? raw : freshHistory()
  const telemetry = new Telemetry(history)
  if (history.activeSession) telemetry.setActiveSession(history.activeSession)

  const modelCatalog = new Map<string, ModelInfo>()
  let plans: Plans = loadPlans()
  let quota = readQuotaSnapshot()
  let lastSnapAt = 0
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let bridgePollTimer: ReturnType<typeof setInterval> | undefined
  let recomputeTimer: ReturnType<typeof setTimeout> | undefined
  let dirWatcher: ReturnType<typeof watch> | undefined
  let bridgeTimer: ReturnType<typeof setTimeout> | undefined
  let lastSelKey = ""
  let lastActiveKey = ""
  const pluginCleanup: (() => void)[] = []

  function modelKey(providerID: string, modelID: string): string {
    return `${providerID}/${modelID}`
  }

  function applySelection(): boolean {
    const sel = readJson<TuiSelection>(paths.selection)
    const key = sel ? JSON.stringify(sel) : ""
    if (key === lastSelKey) return false
    lastSelKey = key
    if (sel?.providerID) {
      telemetry.overrideSelection({ provider: sel.providerID, model: sel.modelID })
      return true
    }
    return false
  }

  function applyActive(): boolean {
    const active = readJson<ActiveFile>(paths.active)
    const key = active ? JSON.stringify(active) : ""
    if (key === lastActiveKey) return false
    lastActiveKey = key
    if (!active?.sessionID) return false
    telemetry.setActiveSession(active.sessionID)
    if (active.model?.providerID && active.model?.modelID) {
      telemetry.noteBaseline(active.sessionID, {
        provider: active.model.providerID,
        model: active.model.modelID,
        agent: active.agent,
      })
    }
    return true
  }

  function refreshBridge() {
    const changed = applySelection() || applyActive()
    if (changed) {
      saveHistory()
      recompute()
    }
  }

  function watchFiles() {
    mkdirSync(paths.dir, { recursive: true })
    refreshBridge()
    try {
      dirWatcher = watch(paths.dir, () => {
        if (bridgeTimer) clearTimeout(bridgeTimer)
        bridgeTimer = setTimeout(() => {
          bridgeTimer = undefined
          refreshBridge()
        }, SELECTION_DEBOUNCE_MS)
      })
    } catch (err) {
      log(`state watcher failed: ${String(err)}`)
    }
    bridgePollTimer = setInterval(refreshBridge, BRIDGE_POLL_INTERVAL_MS)
    pluginCleanup.push(() => {
      if (bridgePollTimer) clearInterval(bridgePollTimer)
    })
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
      const resp = await client.provider.list()
      const all = Array.isArray(resp.data?.all) ? resp.data.all : []
      for (const provider of all) {
        for (const [mid, m] of Object.entries(provider.models ?? {})) {
          const key = modelKey(provider.id, mid)
          modelCatalog.set(key, {
            name: m.name,
            context: m.limit?.context,
            output: m.limit?.output,
            cost: {
              input: m.cost?.input,
              output: m.cost?.output,
              cacheRead: m.cost?.cache_read,
              cacheWrite: m.cost?.cache_write,
            },
          })
        }
      }
    } catch (err) {
      log(`provider catalog failed: ${String(err)}`)
    }
    try {
      const cfg = await client.config.get()
      const providers = (cfg.data?.provider ?? {}) as Record<
        string,
        { models?: Record<string, { name?: string; limit?: { context?: number; input?: number; output?: number } }> }
      >
      for (const [pid, p] of Object.entries(providers)) {
        for (const [mid, m] of Object.entries(p.models ?? {})) {
          const key = modelKey(pid, mid)
          const existing = modelCatalog.get(key) ?? {}
          modelCatalog.set(key, {
            ...existing,
            name: existing.name ?? m.name,
            context: existing.context ?? m.limit?.context,
            output: existing.output ?? m.limit?.output,
          })
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
    history.activeSession = telemetry.activeRoot
    writeJsonAtomic(paths.history, history)
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

  function usableContext(provider: string | undefined, model: string | undefined): number | null {
    if (!provider || !model) return null
    const info = modelCatalog.get(modelKey(provider, model))
    const context = info?.context
    if (!context || context === 0) return null
    const reserved = Math.min(COMPACTION_BUFFER, info.output ?? 20_000)
    return Math.max(0, context - reserved)
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
      usableContext: usableContext(selected.provider, selected.model),
      externalShare: history.externalShare,
      windowBudgets: selected.provider ? plans.budgets[selected.provider] : undefined,
      windowLimits: selected.provider ? plans.limits[selected.provider] : undefined,
      windowTokenLimits: selected.provider ? plans.tokenLimits[selected.provider] : undefined,
    }
    const estimate: EstimateFile = computeEstimate(input)
    writeJsonAtomic(paths.estimate, estimate)
  }

  function watchConfig() {
    let lastMtime = 0
    const reload = () => {
      try {
        const stat = statSync(CONFIG_PATH)
        if (stat.mtimeMs === lastMtime) return
        lastMtime = stat.mtimeMs
        plans = loadPlans()
        recompute()
      } catch {
        lastMtime = 0
      }
    }
    reload()
    try {
      const configWatcher = watch(dirname(CONFIG_PATH), () => reload())
      pluginCleanup.push(() => configWatcher.close())
    } catch {}
  }

  pollTimer = setInterval(refreshQuota, POLL_INTERVAL_MS)
  watchFiles()
  watchConfig()
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
      if (bridgeTimer) clearTimeout(bridgeTimer)
      if (dirWatcher) dirWatcher.close()
      for (const cleanup of pluginCleanup) {
        try {
          cleanup()
        } catch {}
      }
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
