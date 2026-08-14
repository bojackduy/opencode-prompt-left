import type {
  ContextEstimate,
  EstimateFile,
  PromptForecast,
  PromptUsage,
  QuotaSnapshot,
  RootPrompt,
  SelectedRegime,
  WindowEstimate,
  WindowObservation,
  WindowTracker,
} from "./shared"

const RECENCY_DECAY = 0.75
const MAX_RECENT = 12
const TOOL_OUTPUT_TOKENS_PER_CHAR = 1 / 3.5
const SIMULATION_CAP = 500
const TAIL_MIN_TOKENS = 2000
const TAIL_MAX_TOKENS = 15_000
const PRIOR_BURN_MEAN = 1.5
const PRIOR_BURN_SAFE = 2.5
const MAX_WINDOW_OBSERVATIONS = 24

export function regimeKey(provider: string, model: string, agent: string): string {
  return `${provider}|${model}|${agent}`
}

export function usageFor(prompt: RootPrompt, provider: string, fallbackAll: boolean): PromptUsage | null {
  const exact = prompt.byProvider[provider]
  if (exact) return exact
  if (!fallbackAll) return null
  const merged = prompt.byProvider
  const entries = Object.values(merged)
  if (entries.length === 0) return null
  const out = { ...entries[0] }
  for (let i = 1; i < entries.length; i++) {
    const u = entries[i]
    out.requests += u.requests
    out.input += u.input
    out.cacheRead += u.cacheRead
    out.cacheWrite += u.cacheWrite
    out.output += u.output
    out.reasoning += u.reasoning
    out.cost += u.cost
    out.toolCalls += u.toolCalls
    out.toolOutputChars += u.toolOutputChars
  }
  return out
}

export function recentPrompts(
  prompts: RootPrompt[],
  selected: SelectedRegime,
): { list: RootPrompt[]; fallbackLevel: number } {
  const byTime = [...prompts]
    .filter((p) => p.finishedAt !== undefined)
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
  const p = selected.provider ?? ""
  const m = selected.model ?? ""
  const a = selected.agent ?? ""
  const levels = [
    (x: RootPrompt) => x.provider === p && x.model === m && x.agent === a && !!x.byProvider[p],
    (x: RootPrompt) => x.provider === p && x.model === m && !!x.byProvider[p],
    (x: RootPrompt) => !!x.byProvider[p],
    () => true,
  ]
  for (let level = 0; level < levels.length; level++) {
    const list = byTime.filter(levels[level]).slice(0, MAX_RECENT)
    if (list.length > 0) return { list, fallbackLevel: level }
  }
  return { list: [], fallbackLevel: 3 }
}

function weighted(values: number[]): number {
  if (values.length === 0) return 0
  const weights = values.map((_, i) => Math.pow(RECENCY_DECAY, values.length - 1 - i))
  const total = weights.reduce((x, y) => x + y, 0)
  return values.reduce((acc, v, i) => acc + (v * weights[i]) / total, 0)
}

function weightedStd(values: number[], mean: number): number {
  if (values.length < 2) return 0
  const weights = values.map((_, i) => Math.pow(RECENCY_DECAY, values.length - 1 - i))
  const total = weights.reduce((x, y) => x + y, 0)
  const variance = values.reduce((acc, v, i) => acc + ((v - mean) ** 2 * weights[i]) / total, 0)
  return Math.sqrt(variance)
}

export function buildForecast(
  prompts: RootPrompt[],
  selected: SelectedRegime,
): PromptForecast | null {
  const { list, fallbackLevel } = recentPrompts(prompts, selected)
  if (list.length === 0) return null
  const provider = selected.provider ?? ""
  const rows = list
    .map((p) => usageFor(p, provider, fallbackLevel >= 3))
    .filter((u): u is PromptUsage => u !== null)
  if (rows.length === 0) return null

  const cost = weighted(rows.map((u) => u.cost))
  const growthCandidates = list
    .filter((p) => !p.compacted && p.contextAfter !== undefined)
    .map((p) => Math.max(0, (p.contextAfter ?? 0) - p.contextBefore))
  const contextGrowth = weighted(growthCandidates)
  const compacted = list.filter((p) => p.compacted)
  const compactionCosts = compacted.map((p) => (p.compactionCost > 0 ? p.compactionCost : cost))
  const compactionCost = compactionCosts.length > 0 ? weighted(compactionCosts) : cost
  const costs = rows.map((u) => u.cost)
  const costStd = weightedStd(costs, cost)

  return {
    sampleCount: rows.length,
    fallbackLevel,
    cost,
    requests: weighted(rows.map((u) => u.requests)),
    input: weighted(rows.map((u) => u.input)),
    cacheRead: weighted(rows.map((u) => u.cacheRead)),
    cacheWrite: weighted(rows.map((u) => u.cacheWrite)),
    output: weighted(rows.map((u) => u.output)),
    reasoning: weighted(rows.map((u) => u.reasoning)),
    toolCalls: weighted(rows.map((u) => u.toolCalls)),
    toolOutputTokens: weighted(rows.map((u) => u.toolOutputChars)) * TOOL_OUTPUT_TOKENS_PER_CHAR,
    childSessions: weighted(list.map((p) => p.childSessions)),
    contextGrowth,
    compactionCost,
    compactionRate: list.length > 0 ? compacted.length / list.length : 0,
    costCv: cost > 0 ? costStd / cost : 0,
  }
}

export interface RateStats {
  median: number
  safe: number
  mean: number
  count: number
  cv: number
}

export function rateStats(obs: WindowObservation[]): RateStats | null {
  const rates = obs.filter((o) => o.localCost > 0).map((o) => o.deltaPct / o.localCost)
  if (rates.length === 0) return null
  const sorted = [...rates].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length
  const variance = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length
  const std = Math.sqrt(variance)
  const safe = rates.length >= 3 ? Math.max(median, mean) : median * 1.5
  return { median, safe, mean, count: rates.length, cv: mean > 0 ? std / mean : 0 }
}

export function simulatePrompts(input: {
  forecast: PromptForecast
  rate: number
  remaining: number
  contextNow: number | null
  usable: number | null
}): number | null {
  const { forecast, rate, remaining } = input
  if (!forecast || !rate || rate <= 0 || remaining <= 0) return null
  if (forecast.cost <= 0) return null
  const usable = input.usable
  let ctx = input.contextNow ?? 0
  const tail = usable ? Math.min(TAIL_MAX_TOKENS, Math.max(TAIL_MIN_TOKENS, usable * 0.25)) : 0
  let burn = 0
  let n = 0
  while (n < SIMULATION_CAP) {
    burn += forecast.cost * rate
    if (usable && ctx > 0 && forecast.contextGrowth > 0) {
      ctx += forecast.contextGrowth
      if (ctx >= usable) {
        burn += forecast.compactionCost * rate
        ctx = tail
      }
    }
    n++
    if (burn >= remaining) break
  }
  return n
}

export function windowEstimates(input: {
  quota: QuotaSnapshot
  provider: string
  windows: Record<string, WindowTracker>
  forecast: PromptForecast | null
  contextNow: number | null
  usable: number | null
}): WindowEstimate[] {
  return input.quota.entries
    .filter((e) => e.provider === input.provider)
    .map((e) => {
      const tracker = input.windows[`${e.provider}::${e.name}`]
      const stats = tracker ? rateStats(tracker.observations) : null
      const remaining = e.percentRemaining ?? 0
      const prompts = input.forecast && stats
        ? simulatePrompts({
            forecast: input.forecast,
            rate: stats.median,
            remaining,
            contextNow: input.contextNow,
            usable: input.usable,
          })
        : null
      return {
        window: e.window ?? e.name,
        remaining,
        ratePP: stats?.median ?? null,
        prompts,
        resetAt: e.resetAt,
      }
    })
}

export function confidenceScore(input: {
  n: number
  fallbackLevel: number
  quotaAgeSec: number
  externalShare: number
  cv: number
}): number {
  const coverage = Math.min(1, input.n / 10)
  const freshness = Math.max(0, 1 - input.quotaAgeSec / 1800)
  const purity = 1 - Math.min(1, input.externalShare)
  const stability = 1 - Math.min(1, input.cv)
  const fallback = [1, 0.8, 0.6, 0.4][Math.min(input.fallbackLevel, 3)]
  return Math.pow(coverage * freshness * purity * stability * fallback, 1 / 5)
}

export function confidenceLabel(score: number): "low" | "medium" | "high" {
  if (score >= 0.7) return "high"
  if (score >= 0.4) return "medium"
  return "low"
}

export interface EstimateInput {
  now: number
  quota: QuotaSnapshot | null
  prompts: RootPrompt[]
  windows: Record<string, WindowTracker>
  selected: SelectedRegime
  contextNow: number | null
  usableContext: number | null
  externalShare: number
  modelLabel?: string
}

export function computeEstimate(input: EstimateInput): EstimateFile {
  const { now, selected } = input
  const quota = input.quota

  const base: EstimateFile = {
    at: now,
    status: "no-quota",
    compact: "no quota",
    selected,
    likely: null,
    safe: null,
    confidence: 0,
    confidenceLabel: "low",
    binding: null,
    perProvider: [],
    forecast: null,
    context: { usable: input.usableContext, current: input.contextNow, growthPerTurn: null, untilCompaction: null },
    calibration: {
      prompts: input.prompts.length,
      quotaAgeSec: quota ? Math.max(0, (now - quota.at) / 1000) : 0,
      externalShare: input.externalShare,
      fallbackLevel: 3,
      usingPrior: false,
      rateObs: 0,
    },
  }

  if (!quota || quota.entries.length === 0) return base

  const quotaAgeSec = Math.max(0, (now - quota.at) / 1000)
  const selectedProviderEntries = quota.entries.filter((e) => e.provider === selected.provider)
  const forecast = buildForecast(input.prompts, selected)
  base.forecast = forecast

  if (forecast) {
    base.context.growthPerTurn = forecast.contextGrowth
    base.context.untilCompaction =
      input.usableContext !== null && input.contextNow !== null && forecast.contextGrowth > 0
        ? Math.floor((input.usableContext - input.contextNow) / forecast.contextGrowth)
        : null
  }

  const providerForecast = (provider: string) =>
    provider === selected.provider ? forecast : buildForecast(input.prompts, { provider, model: selected.model, agent: selected.agent })

  const providers = [...new Set(quota.entries.map((e) => e.provider))]
  base.perProvider = providers.map((provider) => {
    const f = providerForecast(provider)
    return {
      provider,
      windows: windowEstimates({
        quota,
        provider,
        windows: input.windows,
        forecast: f,
        contextNow: input.contextNow,
        usable: input.usableContext,
      }),
    }
  })

  if (selectedProviderEntries.length === 0) {
    base.status = "calibrating"
    base.compact = "calibrating…"
    return base
  }

  if (!forecast) {
    let binding: EstimateFile["binding"] = null
    let bindingPrompts = Number.POSITIVE_INFINITY
    for (const e of selectedProviderEntries) {
      const remaining = e.percentRemaining ?? 0
      const prompts = Math.floor(remaining / PRIOR_BURN_SAFE)
      if (prompts < bindingPrompts) {
        bindingPrompts = prompts
        binding = {
          provider: e.provider,
          window: e.window ?? e.name,
          remaining,
          burnPP: null,
          resetAt: e.resetAt,
        }
      }
    }
    base.status = "ready"
    base.compact = binding ? `≈${Math.floor(bindingPrompts)} prompts · ${binding.window}` : "quota unknown"
    base.likely = binding ? Math.floor(binding.remaining / PRIOR_BURN_MEAN) : null
    base.safe = binding ? Math.floor(bindingPrompts) : null
    base.binding = binding
    base.confidence = 0.3 * Math.max(0, 1 - quotaAgeSec / 1800)
    base.confidenceLabel = confidenceLabel(base.confidence)
    base.calibration.usingPrior = true
    base.calibration.fallbackLevel = 3
    base.compact = labelCompact(base.compact, input.modelLabel)
    return base
  }

  const { fallbackLevel } = recentPrompts(input.prompts, selected)

  let binding: EstimateFile["binding"] = null
  let bindingPrompts = Number.POSITIVE_INFINITY
  let bindingSafe: number | null = null
  let bindingRate: number | null = null
  let totalObs = 0
  let bindingCv = 0
  for (const e of selectedProviderEntries) {
    const tracker = input.windows[`${e.provider}::${e.name}`]
    const stats = tracker ? rateStats(tracker.observations) : null
    if (stats) totalObs += stats.count
    const best = stats
      ? simulatePrompts({
          forecast,
          rate: stats.median,
          remaining: e.percentRemaining ?? 0,
          contextNow: input.contextNow,
          usable: input.usableContext,
        })
      : null
    const safe = stats
      ? simulatePrompts({
          forecast,
          rate: stats.safe,
          remaining: e.percentRemaining ?? 0,
          contextNow: input.contextNow,
          usable: input.usableContext,
        })
      : null
    if (best !== null && best < bindingPrompts) {
      bindingPrompts = best
      bindingSafe = safe
      bindingRate = stats?.median ?? null
      bindingCv = stats?.cv ?? 0
      binding = {
        provider: e.provider,
        window: e.window ?? e.name,
        remaining: e.percentRemaining ?? 0,
        burnPP: stats && forecast.cost > 0 ? forecast.cost * stats.median : null,
        resetAt: e.resetAt,
      }
    }
  }

  if (binding === null) {
    const worst = selectedProviderEntries.reduce((a, b) =>
      (a.percentRemaining ?? 0) <= (b.percentRemaining ?? 0) ? a : b,
    )
    base.status = "calibrating"
    base.compact = `${(worst.percentRemaining ?? 0).toFixed(0)}% left · ${worst.window ?? worst.name}`
    base.binding = {
      provider: worst.provider,
      window: worst.window ?? worst.name,
      remaining: worst.percentRemaining ?? 0,
      burnPP: null,
      resetAt: worst.resetAt,
    }
    base.confidence = 0.2 * Math.max(0, 1 - quotaAgeSec / 1800)
    base.confidenceLabel = confidenceLabel(base.confidence)
    base.calibration.rateObs = 0
    base.compact = labelCompact(base.compact, input.modelLabel)
    return base
  }

  const confidence = confidenceScore({
    n: Math.min(totalObs, 10),
    fallbackLevel,
    quotaAgeSec,
    externalShare: input.externalShare,
    cv: bindingCv,
  })
  base.status = "ready"
  base.compact = `≈${bindingPrompts} prompts · ${binding.window}`
  base.likely = bindingPrompts
  base.safe = bindingSafe
  base.confidence = confidence
  base.confidenceLabel = confidenceLabel(confidence)
  base.binding = binding
  base.calibration.fallbackLevel = fallbackLevel
  base.calibration.rateObs = totalObs
  base.compact = labelCompact(base.compact, input.modelLabel)
  return base
}

function labelCompact(compact: string, modelLabel?: string): string {
  if (!modelLabel) return compact
  return `${modelLabel} ${compact}`
}
