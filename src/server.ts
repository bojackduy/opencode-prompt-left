import type { Event } from "@opencode-ai/sdk"
import type { Plugin } from "@opencode-ai/plugin"
import { watch, mkdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { Telemetry } from "./telemetry"
import { readQuotaSnapshot } from "./quota"
import { loadPlans, type Plans } from "./budget"
import { computeEstimate, rateStats, reconcilePendingUsage, type EstimateInput } from "./calibrator"
import {
  CONFIG_PATH,
  GLOBAL_PRIOR_PATH,
  emptyQuotaUsage,
  freshHistory,
  readJson,
  statePaths,
  workspaceKey,
  writeJsonAtomic,
  type ActiveFile,
  type CostFn,
  type EstimateFile,
  type GlobalPrior,
  type GlobalPriorEntry,
  type HistoryState,
  type PricingOverride,
  type QuotaEntry,
  type QuotaUsage,
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

interface PromptReservation {
  provider: string
  expected: QuotaUsage
  actual: QuotaUsage
}

const KEY = workspaceKey(process.cwd())
const paths = statePaths(KEY)

const plugin: Plugin = async ({ client }, _options) => {
  const raw = readJson<HistoryState>(paths.history)
  const history: HistoryState = raw?.version === 2 ? raw : freshHistory()
  const modelCatalog = new Map<string, ModelInfo>()
  const costFn: CostFn = (provider, model, usage) => {
    if (!model) return 0
    const c = modelCatalog.get(modelKey(provider, model))?.cost
    if (!c) return 0
    return (
      (usage.input * (c.input ?? 0) +
        (usage.output + usage.reasoning) * (c.output ?? 0) +
        usage.cacheRead * (c.cacheRead ?? 0) +
        usage.cacheWrite * (c.cacheWrite ?? 0)) /
      1_000_000
    )
  }
  const telemetry = new Telemetry(history, costFn)
  if (history.activeSession) telemetry.setActiveSession(history.activeSession)

  let plans: Plans = loadPlans()
  let quota = readQuotaSnapshot()
  const reservations = new Map<string, PromptReservation>()
  const rawPrior = readJson<GlobalPrior>(GLOBAL_PRIOR_PATH)
  let globalPrior: GlobalPrior =
    rawPrior?.version === 2 ? rawPrior : { version: 2, byRegime: {}, byProvider: {} }
  let lastSnapAt = 0
  let lastCatalogAt = 0
  const CATALOG_REFRESH_INTERVAL_MS = 300_000
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

  function applyPricingOverrides(overrides: Record<string, Record<string, PricingOverride>>) {
    for (const [provider, models] of Object.entries(overrides)) {
      for (const [modelId, override] of Object.entries(models)) {
        const key = modelKey(provider, modelId)
        const existing = modelCatalog.get(key) ?? {}
        modelCatalog.set(key, {
          ...existing,
          cost: {
            input: override.input ?? existing.cost?.input,
            output: override.output ?? existing.cost?.output,
            cacheRead: override.cacheRead ?? existing.cost?.cacheRead,
            cacheWrite: override.cacheWrite ?? existing.cost?.cacheWrite,
          },
        })
      }
    }
  }

  function refreshCatalog() {
    return (async () => {
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
      applyPricingOverrides(plans.pricingOverrides)
    })()
  }

  async function init() {
    try {
      const sessions = await client.session.list()
      const rows = Array.isArray(sessions.data) ? sessions.data : []
      telemetry.hydrate(rows, history.lastContext)
    } catch (err) {
      log(`session hydrate failed: ${String(err)}`)
    }
    await refreshCatalog()
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

  function mergePriorEntry(
    entry: GlobalPriorEntry | undefined,
    cost: number,
    requests: number,
    tokens: number,
    input: number,
    cacheRead: number,
    cacheWrite: number,
    output: number,
    reasoning: number,
  ): GlobalPriorEntry {
    const n = Math.min((entry?.n ?? 0) + 1, 200)
    const alpha = 1 / n
    return {
      cost: entry ? entry.cost * (1 - alpha) + cost * alpha : cost,
      requests: entry ? entry.requests * (1 - alpha) + requests * alpha : requests,
      tokens: entry ? entry.tokens * (1 - alpha) + tokens * alpha : tokens,
      input: entry ? entry.input * (1 - alpha) + input * alpha : input,
      cacheRead: entry ? entry.cacheRead * (1 - alpha) + cacheRead * alpha : cacheRead,
      cacheWrite: entry ? (entry.cacheWrite ?? 0) * (1 - alpha) + cacheWrite * alpha : cacheWrite,
      output: entry ? entry.output * (1 - alpha) + output * alpha : output,
      reasoning: entry ? entry.reasoning * (1 - alpha) + reasoning * alpha : reasoning,
      n,
    }
  }

  function updateGlobalPrior() {
    const counted = history.globalPriorCounted ?? 0
    const prompts = telemetry.finished
    if (prompts.length <= counted) return
    for (let i = counted; i < prompts.length; i++) {
      const p = prompts[i]
      for (const [provider, u] of Object.entries(p.byProvider)) {
        if (!provider || u.cost <= 0) continue
        const tokens = u.input + u.cacheRead + u.cacheWrite + u.output + u.reasoning
        globalPrior.byProvider[provider] = mergePriorEntry(
          globalPrior.byProvider[provider], u.cost, u.requests, tokens,
          u.input, u.cacheRead, u.cacheWrite, u.output, u.reasoning,
        )
        const modelKey = `${provider}|${p.model ?? ""}`
        globalPrior.byRegime[modelKey] = mergePriorEntry(
          globalPrior.byRegime[modelKey], u.cost, u.requests, tokens,
          u.input, u.cacheRead, u.cacheWrite, u.output, u.reasoning,
        )
      }
    }
    history.globalPriorCounted = prompts.length
    writeJsonAtomic(GLOBAL_PRIOR_PATH, globalPrior)
  }

  function saveHistory() {
    history.prompts = telemetry.finished
    history.lastSelected = telemetry.lastSelected
    history.lastContext = telemetry.contextNow() ?? history.lastContext
    history.activeSession = telemetry.activeRoot
    updateGlobalPrior()
    writeJsonAtomic(paths.history, history)
  }

  function windowValue(map: Record<string, number> | undefined, entry: QuotaEntry): number | undefined {
    if (!map) return undefined
    return map[entry.window ?? ""] ?? map[entry.name]
  }

  function addQuotaUsage(target: QuotaUsage, delta: QuotaUsage) {
    target.cost += delta.cost
    target.requests += delta.requests
    target.tokens += delta.tokens
  }

  function drainUsageDeltas() {
    for (const delta of telemetry.drainUsageDeltas()) {
      for (const entry of quota?.entries ?? []) {
        if (entry.provider !== delta.provider) continue
        const tracker = (history.windows[`${entry.provider}::${entry.name}`] ??= { observations: [] })
        const pending = (tracker.pending ??= emptyQuotaUsage())
        addQuotaUsage(pending, delta.usage)
      }
      const reservation = reservations.get(delta.rootSessionID)
      if (reservation?.provider === delta.provider) addQuotaUsage(reservation.actual, delta.usage)
    }
  }

  function pruneReservations() {
    for (const root of reservations.keys()) {
      if (!telemetry.hasActivePrompt(root)) reservations.delete(root)
    }
  }

  function pendingByWindow(): Record<string, QuotaUsage> {
    const out: Record<string, QuotaUsage> = {}
    for (const entry of quota?.entries ?? []) {
      const key = `${entry.provider}::${entry.name}`
      const persisted = history.windows[key]?.pending
      out[key] = persisted ? { ...persisted } : emptyQuotaUsage()
      for (const reservation of reservations.values()) {
        if (reservation.provider !== entry.provider) continue
        out[key].cost += Math.max(0, reservation.expected.cost - reservation.actual.cost)
        out[key].requests += Math.max(0, reservation.expected.requests - reservation.actual.requests)
        out[key].tokens += Math.max(0, reservation.expected.tokens - reservation.actual.tokens)
      }
    }
    return out
  }

  function estimateInput(): EstimateInput {
    const selected = telemetry.activeSelected()
    return {
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
      globalPrior,
      pendingByWindow: pendingByWindow(),
      modelPricing: (provider, model) => {
        const c = modelCatalog.get(modelKey(provider, model))?.cost
        return c
          ? { input: c.input ?? 0, output: c.output ?? 0, cacheRead: c.cacheRead ?? 0, cacheWrite: c.cacheWrite ?? 0 }
          : null
      },
    }
  }

  function reservePrompt(sessionID: string, provider: string | undefined, replace = true) {
    const root = telemetry.rootFor(sessionID)
    if (!replace && reservations.has(root)) return
    reservations.delete(root)
    if (!provider) return
    const forecast = computeEstimate(estimateInput()).forecast
    if (!forecast) return
    reservations.set(root, {
      provider,
      expected: { cost: forecast.cost, requests: forecast.requests, tokens: forecast.tokens },
      actual: emptyQuotaUsage(),
    })
  }

  function refreshQuota() {
    const now = Date.now()
    if (now - lastCatalogAt > CATALOG_REFRESH_INTERVAL_MS) {
      lastCatalogAt = now
      refreshCatalog()
    }
    const snap = readQuotaSnapshot()
    if (!snap || snap.at <= lastSnapAt) return
    lastSnapAt = snap.at
    quota = snap
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
        tracker.pending = reconcilePendingUsage(tracker.pending ?? emptyQuotaUsage(), delta, {
          budget: windowValue(plans.budgets[e.provider], e),
          limit: windowValue(plans.limits[e.provider], e),
          tokenLimit: windowValue(plans.tokenLimits[e.provider], e),
          ratePP: rateStats(tracker.observations)?.median,
        })
        tracker.observations.push({ at: now, deltaPct: delta, localCost })
        if (tracker.observations.length > MAX_WINDOW_OBSERVATIONS) tracker.observations.shift()
        tracker.lastPercent = e.percentRemaining
        tracker.lastPercentAt = now
        const share = localCost > 0 ? 0 : 1
        history.externalShare = EXTERNAL_EWMA_ALPHA * share + (1 - EXTERNAL_EWMA_ALPHA) * history.externalShare
      } else if (e.percentRemaining > prev) {
        tracker.pending = emptyQuotaUsage()
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
    const estimate: EstimateFile = computeEstimate(estimateInput())
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
        applyPricingOverrides(plans.pricingOverrides)
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
      drainUsageDeltas()
      pruneReservations()
      if (event.type === "message.updated" && event.properties.info.role === "user") {
        const message = event.properties.info
        reservePrompt(message.sessionID, message.model.providerID, false)
      }
      scheduleRecompute()
    },
    async "chat.message"(input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } }) {
      telemetry.noteSelection(input.sessionID, {
        provider: input.model?.providerID,
        model: input.model?.modelID,
        agent: input.agent,
      })
      telemetry.beginPrompt(input.sessionID, input.agent, input.model?.providerID, input.model?.modelID)
      drainUsageDeltas()
      reservePrompt(input.sessionID, input.model?.providerID)
      saveHistory()
      recompute()
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
      drainUsageDeltas()
      pruneReservations()
      saveHistory()
      recompute()
    },
  }
}

export default {
  id: "opencode-prompt-left",
  server: plugin,
}
