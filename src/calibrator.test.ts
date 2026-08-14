import { describe, expect, test } from "bun:test"
import {
  buildForecast,
  computeEstimate,
  confidenceLabel,
  confidenceScore,
  rateStats,
  recentPrompts,
  regimeKey,
  simulatePrompts,
} from "./calibrator"
import { emptyUsage, type PromptForecast, type QuotaSnapshot, type RootPrompt } from "./shared"

function prompt(overrides: Partial<RootPrompt> = {}): RootPrompt {
  return {
    id: `p${Math.random().toString(36).slice(2, 8)}`,
    rootSessionID: "root",
    startedAt: 0,
    finishedAt: 100,
    contextBefore: 0,
    contextAfter: 10_000,
    compacted: false,
    compactionCost: 0,
    childSessions: 0,
    byProvider: {},
    ...overrides,
  }
}

function usage(overrides: Partial<ReturnType<typeof emptyUsage>> = {}) {
  return { ...emptyUsage(), cost: 0.05, requests: 3, toolCalls: 2, ...overrides }
}

function forecast(overrides: Partial<PromptForecast> = {}): PromptForecast {
  return {
    sampleCount: 4,
    fallbackLevel: 0,
    cost: 0.05,
    requests: 3,
    input: 50_000,
    cacheRead: 200_000,
    cacheWrite: 0,
    output: 2_000,
    reasoning: 1_000,
    toolCalls: 2,
    toolOutputTokens: 5_000,
    childSessions: 0,
    contextGrowth: 20_000,
    compactionCost: 0.05,
    compactionRate: 0,
    costCv: 0,
    ...overrides,
  }
}

const quota: QuotaSnapshot = {
  at: 1_000_000,
  fromExport: true,
  entries: [
    { provider: "opencode-go", name: "OpenCode Go 5h", window: "5h", percentRemaining: 65, resetAt: 1_000_000_000 },
    { provider: "opencode-go", name: "OpenCode Go Weekly", window: "Weekly", percentRemaining: 7, resetAt: 1_000_000_000 },
    { provider: "opencode-go", name: "OpenCode Go Monthly", window: "Monthly", percentRemaining: 7 },
    { provider: "openai", name: "OpenAI Weekly", window: "Weekly", percentRemaining: 85 },
  ],
}

describe("recentPrompts", () => {
  test("falls back from exact regime to provider to all", () => {
    const list = [
      prompt({ id: "a", finishedAt: 1, provider: "opencode-go", model: "flash", agent: "plan", byProvider: { "opencode-go": usage() } }),
      prompt({ id: "b", finishedAt: 2, provider: "opencode-go", model: "pro", agent: "build", byProvider: { "opencode-go": usage() } }),
    ]
    expect(recentPrompts(list, { provider: "opencode-go", model: "flash", agent: "plan" }).fallbackLevel).toBe(0)
    expect(recentPrompts(list, { provider: "opencode-go", model: "flash", agent: "build" }).fallbackLevel).toBe(1)
    expect(recentPrompts(list, { provider: "opencode-go", model: "zzz", agent: "build" }).fallbackLevel).toBe(2)
    expect(recentPrompts(list, { provider: "anthropic" }).fallbackLevel).toBe(3)
  })
})

describe("buildForecast", () => {
  test("weighted means favor recent prompts", () => {
    const list = [
      prompt({ finishedAt: 1, provider: "opencode-go", model: "m", agent: "build", contextBefore: 0, contextAfter: 20_000, byProvider: { "opencode-go": usage({ cost: 0.1, requests: 10 }) } }),
      prompt({ finishedAt: 2, provider: "opencode-go", model: "m", agent: "build", contextBefore: 0, contextAfter: 20_000, byProvider: { "opencode-go": usage({ cost: 0.1, requests: 10 }) } }),
      prompt({ finishedAt: 3, provider: "opencode-go", model: "m", agent: "build", contextBefore: 0, contextAfter: 20_000, byProvider: { "opencode-go": usage({ cost: 0.05, requests: 2 }) } }),
    ]
    const f = buildForecast(list, { provider: "opencode-go", model: "m", agent: "build" })!
    expect(f.sampleCount).toBe(3)
    expect(f.cost).toBeGreaterThan(0.05)
    expect(f.cost).toBeLessThan(0.1)
    expect(f.requests).toBeGreaterThan(2)
    expect(f.requests).toBeLessThan(10)
    expect(f.contextGrowth).toBeCloseTo(20_000)
  })

  test("compaction prompts are excluded from growth and feed compactionCost", () => {
    const list = [
      prompt({ finishedAt: 1, provider: "opencode-go", model: "m", agent: "b", contextBefore: 100_000, contextAfter: 10_000, compacted: true, compactionCost: 0.12, byProvider: { "opencode-go": usage({ cost: 0.2 }) } }),
      prompt({ finishedAt: 2, provider: "opencode-go", model: "m", agent: "b", contextBefore: 10_000, contextAfter: 30_000, byProvider: { "opencode-go": usage({ cost: 0.05 }) } }),
    ]
    const f = buildForecast(list, { provider: "opencode-go", model: "m", agent: "b" })!
    expect(f.contextGrowth).toBeCloseTo(20_000)
    expect(f.compactionCost).toBeCloseTo(0.12)
    expect(f.compactionRate).toBeCloseTo(0.5)
  })
})

describe("rateStats", () => {
  test("median, mean, and safe rate from observations", () => {
    const obs = [
      { at: 1, deltaPct: 2, localCost: 1 },
      { at: 2, deltaPct: 4, localCost: 2 },
      { at: 3, deltaPct: 6, localCost: 2 },
    ]
    const s = rateStats(obs)!
    expect(s.median).toBeCloseTo(2)
    expect(s.mean).toBeCloseTo(7 / 3)
    expect(s.safe).toBeCloseTo(7 / 3)
    expect(s.count).toBe(3)
  })

  test("single observation inflates safe rate 1.5x", () => {
    const s = rateStats([{ at: 1, deltaPct: 2, localCost: 1 }])!
    expect(s.median).toBeCloseTo(2)
    expect(s.safe).toBeCloseTo(3)
  })

  test("zero-cost observations are dropped", () => {
    expect(rateStats([{ at: 1, deltaPct: 2, localCost: 0 }])).toBeNull()
  })
})

describe("simulatePrompts", () => {
  test("burns forecast cost per prompt until quota exhausted", () => {
    const f = forecast({ cost: 0.05 })
    expect(simulatePrompts({ forecast: f, rate: 10, remaining: 7, contextNow: null, usable: null })).toBe(14)
  })

  test("compaction adds cost and resets context", () => {
    const f = forecast({ cost: 0.05, contextGrowth: 20_000, compactionCost: 0.05, compactionRate: 1 })
    const n = simulatePrompts({ forecast: f, rate: 10, remaining: 7, contextNow: 90_000, usable: 100_000 })
    expect(n).toBeDefined()
    expect(n!).toBeGreaterThan(0)
    expect(n!).toBeLessThan(14)
  })

  test("returns null without a usable rate", () => {
    expect(simulatePrompts({ forecast: forecast(), rate: 0, remaining: 7, contextNow: null, usable: null })).toBeNull()
  })
})

describe("confidence", () => {
  test("perfect inputs yield high confidence", () => {
    expect(confidenceScore({ n: 10, fallbackLevel: 0, quotaAgeSec: 10, externalShare: 0, cv: 0 })).toBeCloseTo(1)
  })

  test("fallback and external burn reduce confidence", () => {
    const perfect = confidenceScore({ n: 10, fallbackLevel: 0, quotaAgeSec: 10, externalShare: 0, cv: 0 })
    expect(confidenceScore({ n: 10, fallbackLevel: 3, quotaAgeSec: 10, externalShare: 0, cv: 0 })).toBeLessThan(perfect)
    expect(confidenceScore({ n: 10, fallbackLevel: 0, quotaAgeSec: 10, externalShare: 0.5, cv: 0 })).toBeLessThan(perfect)
  })

  test("labels follow thresholds", () => {
    expect(confidenceLabel(0.8)).toBe("high")
    expect(confidenceLabel(0.5)).toBe("medium")
    expect(confidenceLabel(0.2)).toBe("low")
  })
})

describe("computeEstimate", () => {
  const prompts = [
    prompt({ finishedAt: 1, provider: "opencode-go", model: "m", agent: "build", byProvider: { "opencode-go": usage({ cost: 0.05 }) } }),
    prompt({ finishedAt: 2, provider: "opencode-go", model: "m", agent: "build", byProvider: { "opencode-go": usage({ cost: 0.05 }) } }),
    prompt({ finishedAt: 3, provider: "opencode-go", model: "m", agent: "build", byProvider: { "opencode-go": usage({ cost: 0.05 }) } }),
  ]

  test("picks the binding window and derives prompts from cost and rate", () => {
    const windows = {
      "opencode-go::OpenCode Go 5h": { observations: [{ at: 1, deltaPct: 4, localCost: 2 }] },
      "opencode-go::OpenCode Go Weekly": { observations: [{ at: 1, deltaPct: 2, localCost: 1 }] },
    }
    const est = computeEstimate({
      now: 1_000_010,
      quota,
      prompts,
      windows,
      selected: { provider: "opencode-go", model: "m", agent: "build" },
      contextNow: 50_000,
      usableContext: 100_000,
      externalShare: 0,
    })
    expect(est.status).toBe("ready")
    expect(est.binding?.window).toBe("Weekly")
    expect(est.binding?.remaining).toBe(7)
    expect(est.binding?.burnPP).toBeCloseTo(0.1)
    expect(est.likely).toBeGreaterThan(0)
    expect(est.forecast?.cost).toBeCloseTo(0.05)
    expect(est.calibration.rateObs).toBe(2)
    expect(est.perProvider).toHaveLength(2)
  })

  test("calibrating when cost is known but quota rates are not", () => {
    const est = computeEstimate({
      now: 1_000_010,
      quota,
      prompts,
      windows: {},
      selected: { provider: "opencode-go", model: "m", agent: "build" },
      contextNow: null,
      usableContext: null,
      externalShare: 0,
    })
    expect(est.status).toBe("calibrating")
    expect(est.compact).toContain("% left")
    expect(est.likely).toBeNull()
  })

  test("cold start uses a prior burn when no prompts exist", () => {
    const est = computeEstimate({
      now: 1_000_010,
      quota,
      prompts: [],
      windows: {},
      selected: { provider: "opencode-go", model: "m", agent: "build" },
      contextNow: null,
      usableContext: null,
      externalShare: 0,
    })
    expect(est.status).toBe("ready")
    expect(est.calibration.usingPrior).toBe(true)
    expect(est.safe).toBe(Math.floor(7 / 2.5))
    expect(est.likely).toBe(Math.floor(7 / 1.5))
  })

  test("no-quota without snapshot", () => {
    const est = computeEstimate({
      now: 1_000_010,
      quota: null,
      prompts: [],
      windows: {},
      selected: {},
      contextNow: null,
      usableContext: null,
      externalShare: 0,
    })
    expect(est.status).toBe("no-quota")
  })

  test("context compaction horizon is derived from growth and usable headroom", () => {
    const windows = { "opencode-go::OpenCode Go Weekly": { observations: [{ at: 1, deltaPct: 2, localCost: 1 }] } }
    const est = computeEstimate({
      now: 1_000_010,
      quota,
      prompts,
      windows,
      selected: { provider: "opencode-go", model: "m", agent: "build" },
      contextNow: 60_000,
      usableContext: 100_000,
      externalShare: 0,
    })
    expect(est.context.untilCompaction).toBe(Math.floor((100_000 - 60_000) / est.forecast!.contextGrowth))
  })
})

describe("regimeKey", () => {
  test("joins provider, model and agent", () => {
    expect(regimeKey("a", "b", "c")).toBe("a|b|c")
  })
})
