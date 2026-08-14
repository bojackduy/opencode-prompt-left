import type {
  BurnSample,
  ContextEstimate,
  EstimateFile,
  ProviderTotals,
  QuotaSnapshot,
  RootTurn,
  SelectedRegime,
} from "./shared"

const OUTPUT_WEIGHT = 4
const CACHE_READ_WEIGHT = 0.25
const CACHE_WRITE_WEIGHT = 1.25
const EMA_ALPHA = 0.35
const P90_Z = 1.28
const MAX_SAMPLES = 30

export const PRIOR_BURN_MEAN = 1.5
export const PRIOR_BURN_SAFE = 2.5

export function regimeKey(provider: string, model: string, agent: string): string {
  return `${provider}|${model}|${agent}`
}

export function featureWeight(p: ProviderTotals): number {
  const w =
    p.input +
    OUTPUT_WEIGHT * p.output +
    p.reasoning +
    CACHE_READ_WEIGHT * p.cacheRead +
    CACHE_WRITE_WEIGHT * p.cacheWrite
  return w > 0 ? w : p.requests
}

export function attributeBurn(delta: number, turns: RootTurn[], provider: string): Map<string, BurnSample[]> {
  const out = new Map<string, BurnSample[]>()
  const weights = turns.map((t) => {
    const p = t.byProvider[provider]
    return p ? featureWeight(p) : 0
  })
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) return out
  turns.forEach((t, i) => {
    if (weights[i] === 0) return
    const burn = (delta * weights[i]) / total
    const key = regimeKey(provider, t.model ?? "", t.agent ?? "")
    const list = out.get(key) ?? []
    list.push({ at: t.finishedAt ?? t.startedAt, burn })
    out.set(key, list)
  })
  return out
}

export function sampleMean(samples: BurnSample[]): number {
  if (samples.length === 0) return 0
  if (samples.length < 3) return samples.reduce((a, s) => a + s.burn, 0) / samples.length
  let mean = samples[0].burn
  for (let i = 1; i < samples.length; i++) {
    mean = EMA_ALPHA * samples[i].burn + (1 - EMA_ALPHA) * mean
  }
  return mean
}

export function sampleStd(samples: BurnSample[], mean: number): number {
  if (samples.length < 2) return 0
  const variance = samples.reduce((a, s) => a + (s.burn - mean) ** 2, 0) / samples.length
  return Math.sqrt(variance)
}

export function safeBurnPerPrompt(mean: number, std: number, n: number): number {
  if (n === 1) return mean * 1.5
  return mean + Math.max(P90_Z * std, 0.05 * mean)
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

export function regimeSamplesAt(samples: Record<string, BurnSample[]>, selected: SelectedRegime): {
  list: BurnSample[]
  fallbackLevel: number
} {
  const p = selected.provider ?? ""
  const m = selected.model ?? ""
  const a = selected.agent ?? ""
  const keys = [regimeKey(p, m, a), regimeKey(p, m, ""), p, "*"]
  for (let i = 0; i < keys.length; i++) {
    const list = samples[keys[i]]
    if (list && list.length > 0) return { list, fallbackLevel: i }
  }
  return { list: [], fallbackLevel: 3 }
}

export function allSamples(samples: Record<string, BurnSample[]>): BurnSample[] {
  return Object.values(samples).flat().sort((x, y) => x.at - y.at)
}

function promptsForRemaining(remaining: number, burn: number): number {
  if (burn <= 0) return Number.POSITIVE_INFINITY
  return remaining / burn
}

export interface EstimateInput {
  now: number
  quota: QuotaSnapshot | null
  regimeSamples: Record<string, BurnSample[]>
  selected: SelectedRegime
  externalShare: number
  rootTurns: number
  context: ContextEstimate
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
    context: input.context,
    calibration: {
      rootTurns: input.rootTurns,
      regimeTurns: 0,
      quotaAgeSec: quota ? Math.max(0, (now - quota.at) / 1000) : 0,
      externalShare: input.externalShare,
      fallbackLevel: 3,
      usingPrior: false,
    },
  }

  if (!quota || quota.entries.length === 0) return base

  const quotaAgeSec = Math.max(0, (now - quota.at) / 1000)

  const { list, fallbackLevel } = regimeSamplesAt(input.regimeSamples, selected)
  const selectedProviderEntries = quota.entries.filter((e) => e.provider === selected.provider)

  const fallbackAll = allSamples(input.regimeSamples)
  const globalList = list.length > 0 ? list : fallbackAll

  base.perProvider = [...new Set(quota.entries.map((e) => e.provider))].map((provider) => ({
    provider,
    windows: quota.entries
      .filter((e) => e.provider === provider)
      .map((e) => {
        const own = input.regimeSamples[provider]
        const samples = own && own.length > 0 ? own : fallbackAll
        const mean = sampleMean(samples)
        const std = sampleStd(samples, mean)
        const burn = samples.length > 0 ? safeBurnPerPrompt(mean, std, samples.length) : PRIOR_BURN_SAFE
        const prompts = Math.floor(promptsForRemaining(e.percentRemaining ?? 0, burn))
        return {
          window: e.window ?? e.name,
          remaining: e.percentRemaining ?? 0,
          prompts,
          resetAt: e.resetAt,
        }
      }),
  }))

  if (selectedProviderEntries.length === 0) {
    base.status = "calibrating"
    base.compact = "calibrating…"
    return base
  }

  if (globalList.length === 0) {
    let binding: EstimateFile["binding"] = null
    let bindingPrompts = Number.POSITIVE_INFINITY
    for (const e of selectedProviderEntries) {
      const remaining = e.percentRemaining ?? 0
      const prompts = promptsForRemaining(remaining, PRIOR_BURN_SAFE)
      if (prompts < bindingPrompts) {
        bindingPrompts = prompts
        binding = {
          provider: e.provider,
          window: e.window ?? e.name,
          remaining,
          burnMean: PRIOR_BURN_MEAN,
          burnSafe: PRIOR_BURN_SAFE,
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
    return base
  }

  const mean = sampleMean(globalList)
  const std = sampleStd(globalList, mean)
  const n = globalList.length
  const burnSafe = safeBurnPerPrompt(mean, std, n)
  const cv = mean > 0 ? std / mean : 0
  const confidence = confidenceScore({ n, fallbackLevel, quotaAgeSec, externalShare: input.externalShare, cv })

  let binding: EstimateFile["binding"] = null
  let bindingPrompts = Number.POSITIVE_INFINITY
  for (const e of selectedProviderEntries) {
    const remaining = e.percentRemaining ?? 0
    const prompts = promptsForRemaining(remaining, burnSafe)
    if (prompts < bindingPrompts) {
      bindingPrompts = prompts
      binding = {
        provider: e.provider,
        window: e.window ?? e.name,
        remaining,
        burnMean: mean,
        burnSafe,
        resetAt: e.resetAt,
      }
    }
  }

  const safeFloor = Math.floor(bindingPrompts)
  base.status = "ready"
  base.compact = binding ? `≈${safeFloor} prompts · ${binding.window}` : "quota unknown"
  base.likely = mean > 0 && binding ? Math.floor(binding.remaining / mean) : null
  base.safe = safeFloor
  base.confidence = confidence
  base.confidenceLabel = confidenceLabel(confidence)
  base.binding = binding
  base.calibration.regimeTurns = n
  base.calibration.fallbackLevel = fallbackLevel
  return base
}

export function contextGrowthPerTurn(turns: RootTurn[]): number | null {
  const recent = turns.filter((t) => t.contextAfter !== undefined && t.finishedAt).slice(-10)
  if (recent.length === 0) return null
  const growths = recent.map((t) => (t.contextAfter ?? 0) - t.contextBefore)
  return growths.reduce((a, b) => a + b, 0) / growths.length
}

export function compactionTurnsUntil(usable: number | null, current: number | null, growth: number | null): number | null {
  if (usable === null || current === null || growth === null || growth <= 0) return null
  const headroom = usable - current
  if (headroom <= 0) return 0
  return Math.floor(headroom / growth)
}
