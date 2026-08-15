import type {
  ContextEstimate,
  EstimateFile,
  GlobalPrior,
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
  const tokens = weighted(rows.map((u) => u.input + u.cacheRead + u.cacheWrite + u.output + u.reasoning))
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
    tokens,
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
  budgets?: Record<string, number>
  limits?: Record<string, number>
  tokenLimits?: Record<string, number>
}): WindowEstimate[] {
  return input.quota.entries
    .filter((e) => e.provider === input.provider)
    .map((e) => {
      const tracker = input.windows[`${e.provider}::${e.name}`]
      const stats = tracker ? rateStats(tracker.observations) : null
      const remaining = e.percentRemaining ?? 0
      const prompts =
        input.forecast && planValue(input.budgets, e) && input.forecast.cost > 0
          ? budgetPrompts(remaining, planValue(input.budgets, e)!, input.forecast.cost)
          : input.forecast && planValue(input.limits, e) && input.forecast.requests > 0
            ? limitPrompts(remaining, planValue(input.limits, e)!, input.forecast.requests)
            : input.forecast && planValue(input.tokenLimits, e) && input.forecast.tokens > 0
              ? limitPrompts(remaining, planValue(input.tokenLimits, e)!, input.forecast.tokens)
              : input.forecast && stats
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
  windowBudgets?: Record<string, number>
  windowLimits?: Record<string, number>
  windowTokenLimits?: Record<string, number>
  globalPrior?: GlobalPrior
}

function forecastFromGlobal(global: GlobalPrior, selected: SelectedRegime): PromptForecast | null {
  const modelKey = `${selected.provider ?? ""}|${selected.model ?? ""}`
  const entry = global.byRegime[modelKey] ?? global.byProvider[selected.provider ?? ""]
  if (!entry || entry.n <= 0 || entry.cost <= 0) return null
  return {
    sampleCount: Math.min(entry.n, 30),
    fallbackLevel: 2,
    cost: entry.cost,
    requests: entry.requests,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    toolCalls: 0,
    toolOutputTokens: 0,
    childSessions: 0,
    contextGrowth: 0,
    compactionCost: entry.cost,
    compactionRate: 0,
    costCv: 0,
    tokens: entry.tokens,
  }
}

function planValue(map: Record<string, number> | undefined, e: QuotaSnapshot["entries"][number]): number | undefined {
  if (!map) return undefined
  return map[e.window ?? ""] ?? map[e.name]
}

function compactPrefix(selected: SelectedRegime): string {
  if (selected.provider && selected.model) return `${selected.provider}/${selected.model} `
  return ""
}

function safeFactor(cv: number, n: number): number {
  if (n < 3) return 1.5
  return 1 + Math.max(1.28 * cv, 0.05)
}

function safeCost(cost: number, cv: number, n: number): number {
  return cost * safeFactor(cv, n)
}

function budgetPrompts(remainingPct: number, budget: number, cost: number): number | null {
  if (!budget || budget <= 0 || !cost || cost <= 0) return null
  return Math.floor(((budget * remainingPct) / 100) / cost)
}

function limitPrompts(remainingPct: number, limit: number, perPrompt: number): number | null {
  if (!limit || limit <= 0 || !perPrompt || perPrompt <= 0) return null
  return Math.floor(((limit * remainingPct) / 100) / perPrompt)
}

function worstBudgetEntry(
  selectedProviderEntries: QuotaSnapshot["entries"],
  windowBudgets?: Record<string, number>,
): { entry: QuotaSnapshot["entries"][number]; budget: number } | null {
  let best: { entry: QuotaSnapshot["entries"][number]; budget: number; usd: number } | null = null
  for (const e of selectedProviderEntries) {
    const budget = planValue(windowBudgets, e)
    if (!budget || budget <= 0) continue
    const usd = (budget * (e.percentRemaining ?? 0)) / 100
    if (!best || usd < best.usd) {
      best = { entry: e, budget, usd }
    }
  }
  return best ? { entry: best.entry, budget: best.budget } : null
}

function budgetOnlyEstimate(
  base: EstimateFile,
  entry: QuotaSnapshot["entries"][number],
  budget: number,
): EstimateFile {
  const remaining = entry.percentRemaining ?? 0
  const remainingUSD = (budget * remaining) / 100
  const prompts = Math.floor(remaining / PRIOR_BURN_SAFE)
  base.status = "ready"
  base.compact = `${compactPrefix(base.selected)}≈${Math.max(0, prompts)} prompts · ${entry.window ?? entry.name}`
  base.likely = Math.floor(remaining / PRIOR_BURN_MEAN)
  base.safe = Math.max(0, prompts)
  base.binding = {
    provider: entry.provider,
    window: entry.window ?? entry.name,
    remaining,
    burnPP: null,
    resetAt: entry.resetAt,
    method: "prior",
    budget,
    remainingUSD,
  }
  base.confidence = 0.3 * Math.max(0, 1 - base.calibration.quotaAgeSec / 1800)
  base.confidenceLabel = confidenceLabel(base.confidence)
  base.calibration.usingPrior = true
  base.calibration.fallbackLevel = 3
  return base
}

function priorEstimate(base: EstimateFile, selectedProviderEntries: QuotaSnapshot["entries"], quotaAgeSec: number): EstimateFile {
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
        method: "prior",
      }
    }
  }
  base.status = "ready"
  base.compact = binding ? `${compactPrefix(base.selected)}≈${Math.floor(bindingPrompts)} prompts · ${binding.window}` : "quota unknown"
  base.likely = binding ? Math.floor(binding.remaining / PRIOR_BURN_MEAN) : null
  base.safe = binding ? Math.floor(bindingPrompts) : null
  base.binding = binding
  base.confidence = 0.2 * Math.max(0, 1 - quotaAgeSec / 1800)
  base.confidenceLabel = confidenceLabel(base.confidence)
  base.calibration.usingPrior = true
  base.calibration.fallbackLevel = 3
  return base
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
  const forecast = buildForecast(input.prompts, selected) ?? (input.globalPrior ? forecastFromGlobal(input.globalPrior, selected) : null)
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
        budgets: provider === selected.provider ? input.windowBudgets : undefined,
        limits: provider === selected.provider ? input.windowLimits : undefined,
        tokenLimits: provider === selected.provider ? input.windowTokenLimits : undefined,
      }),
    }
  })

  if (selectedProviderEntries.length === 0) {
    if (!selected.provider) {
      base.status = "no-quota"
      base.compact = "no model yet"
      return base
    }
    base.status = "no-quota"
    base.compact = `no quota · ${selected.provider}`
    base.confidence = 0
    base.confidenceLabel = "low"
    return base
  }

  if (!forecast) {
    const worst = worstBudgetEntry(selectedProviderEntries, input.windowBudgets)
    if (worst) return budgetOnlyEstimate(base, worst.entry, worst.budget)
    return priorEstimate(base, selectedProviderEntries, quotaAgeSec)
  }

  const { fallbackLevel } = recentPrompts(input.prompts, selected)

  let binding: EstimateFile["binding"] = null
  let bindingPrompts = Number.POSITIVE_INFINITY
  let bindingSafe: number | null = null
  let bindingMethod: "budget" | "limit" | "rate" = "rate"
  let bindingCv = 0
  let rateObsCount = 0
  for (const e of selectedProviderEntries) {
    const remaining = e.percentRemaining ?? 0
    const budget = planValue(input.windowBudgets, e)
    const limit = planValue(input.windowLimits, e)
    const tokenLimit = planValue(input.windowTokenLimits, e)
    let best: number | null = null
    let safe: number | null = null
    let burnPP: number | null = null
    let method: "budget" | "limit" | "rate" = "rate"
    let stats: RateStats | null = null
    let limitUnit: "requests" | "tokens" | undefined
    if (budget && forecast.cost > 0) {
      best = budgetPrompts(remaining, budget, forecast.cost)
      safe = budgetPrompts(remaining, budget, safeCost(forecast.cost, forecast.costCv, forecast.sampleCount))
      burnPP = (forecast.cost / budget) * 100
      method = "budget"
    } else if (limit && forecast.requests > 0) {
      best = limitPrompts(remaining, limit, forecast.requests)
      safe = limitPrompts(
        remaining,
        limit,
        forecast.requests * safeFactor(forecast.costCv, forecast.sampleCount),
      )
      limitUnit = "requests"
      method = "limit"
    } else if (tokenLimit && forecast.tokens > 0) {
      best = limitPrompts(remaining, tokenLimit, forecast.tokens)
      safe = limitPrompts(remaining, tokenLimit, forecast.tokens * safeFactor(forecast.costCv, forecast.sampleCount))
      limitUnit = "tokens"
      method = "limit"
    } else {
      const tracker = input.windows[`${e.provider}::${e.name}`]
      stats = tracker ? rateStats(tracker.observations) : null
      if (stats) rateObsCount += stats.count
      best = stats
        ? simulatePrompts({
            forecast,
            rate: stats.median,
            remaining,
            contextNow: input.contextNow,
            usable: input.usableContext,
          })
        : null
      safe = stats
        ? simulatePrompts({
            forecast,
            rate: stats.safe,
            remaining,
            contextNow: input.contextNow,
            usable: input.usableContext,
          })
        : null
      burnPP = stats && forecast.cost > 0 ? forecast.cost * stats.median : null
    }
    if (best !== null && best < bindingPrompts) {
      bindingPrompts = best
      bindingSafe = safe
      bindingMethod = method
      bindingCv = method === "rate" ? (stats?.cv ?? 0) : forecast.costCv
      const limitValue = method === "limit" ? (limitUnit === "tokens" ? tokenLimit : limit) : undefined
      binding = {
        provider: e.provider,
        window: e.window ?? e.name,
        remaining,
        burnPP,
        resetAt: e.resetAt,
        method,
        budget: method === "budget" ? budget : undefined,
        remainingUSD: method === "budget" && budget ? (budget * remaining) / 100 : undefined,
        limit: limitValue,
        limitUnit: method === "limit" ? limitUnit : undefined,
        remainingAbs:
          method === "limit" && limitValue ? (limitValue * remaining) / 100 : undefined,
      }
    }
  }

  if (binding === null) {
    const worst = worstBudgetEntry(selectedProviderEntries, input.windowBudgets)
    if (worst) return budgetOnlyEstimate(base, worst.entry, worst.budget)
    return priorEstimate(base, selectedProviderEntries, quotaAgeSec)
  }

  const confidence = confidenceScore({
    n: Math.min(bindingMethod === "rate" ? rateObsCount : forecast.sampleCount, 10),
    fallbackLevel,
    quotaAgeSec,
    externalShare: input.externalShare,
    cv: bindingCv,
  })
  base.status = "ready"
  base.compact = `${compactPrefix(selected)}≈${bindingPrompts} prompts · ${binding.window}`
  base.likely = bindingPrompts
  base.safe = bindingSafe
  base.confidence = confidence
  base.confidenceLabel = confidenceLabel(confidence)
  base.binding = binding
  base.calibration.fallbackLevel = fallbackLevel
  base.calibration.rateObs = rateObsCount
  return base
}
