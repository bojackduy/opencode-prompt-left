import { describe, expect, test } from "bun:test"
import {
  allSamples,
  attributeBurn,
  compactionTurnsUntil,
  computeEstimate,
  confidenceLabel,
  confidenceScore,
  contextGrowthPerTurn,
  featureWeight,
  regimeKey,
  regimeSamplesAt,
  safeBurnPerPrompt,
  sampleMean,
  sampleStd,
} from "./calibrator"
import type { BurnSample, ContextEstimate, QuotaSnapshot, RootTurn } from "./shared"
import { emptyTotals } from "./shared"

function turn(overrides: Partial<RootTurn>): RootTurn {
  return {
    rootSessionID: "s1",
    rootMessageID: "m1",
    startedAt: 0,
    finishedAt: 100,
    contextBefore: 0,
    byProvider: {},
    childSessions: 0,
    compactedSessions: 0,
    ...overrides,
  }
}

function openaiTotals() {
  const t = emptyTotals()
  t.requests = 4
  t.input = 100_000
  t.output = 8_000
  t.cacheRead = 120_000
  t.cacheWrite = 5_000
  return t
}

describe("featureWeight", () => {
  test("uses relative token weights", () => {
    expect(featureWeight(openaiTotals())).toBeCloseTo(100_000 + 4 * 8_000 + 0.25 * 120_000 + 1.25 * 5_000)
  })

  test("falls back to requests when all tokens are zero", () => {
    expect(featureWeight(emptyTotals())).toBe(0)
    const t = emptyTotals()
    t.requests = 3
    expect(featureWeight(t)).toBe(3)
  })
})

describe("attributeBurn", () => {
  test("a single turn receives the full delta", () => {
    const t = turn({ byProvider: { openai: openaiTotals() } })
    const out = attributeBurn(1.6, [t], "openai")
    const key = regimeKey("openai", "", "")
    expect(out.size).toBe(1)
    expect(out.get(key)![0].burn).toBeCloseTo(1.6)
  })

  test("splits proportionally and sums to the delta", () => {
    const t1 = turn({ byProvider: { openai: openaiTotals() } })
    const t2 = turn({ model: "mini", agent: "build", byProvider: { openai: { ...openaiTotals(), input: 300_000, output: 24_000, cacheRead: 0, cacheWrite: 0 } } })
    const out = attributeBurn(3, [t1, t2], "openai")
    const all = allSamples(Object.fromEntries(out))
    expect(all).toHaveLength(2)
    const sum = all.reduce((a, s) => a + s.burn, 0)
    expect(sum).toBeCloseTo(3)
  })

  test("ignores providers with no totals", () => {
    const t = turn({ byProvider: { anthropic: openaiTotals() } })
    expect(attributeBurn(3, [t], "openai").size).toBe(0)
  })
})

describe("stats", () => {
  const samples: BurnSample[] = [
    { at: 1, burn: 4 },
    { at: 2, burn: 4 },
    { at: 3, burn: 4 },
    { at: 4, burn: 4 },
  ]

  test("safe burn inflates single samples 1.5x", () => {
    expect(safeBurnPerPrompt(4, 0, 1)).toBeCloseTo(6)
  })

  test("safe burn uses P90 bound with a 5% floor", () => {
    expect(safeBurnPerPrompt(4, 0, 5)).toBeCloseTo(4 + 0.2)
    expect(safeBurnPerPrompt(4, 1, 5)).toBeCloseTo(4 + 1.28)
  })

  test("ema mean converges to constant samples", () => {
    expect(sampleMean(samples)).toBeCloseTo(4)
  })

  test("std is zero for constant samples", () => {
    expect(sampleStd(samples, 4)).toBeCloseTo(0)
  })
})

describe("confidence", () => {
  test("perfect inputs yield high confidence", () => {
    expect(confidenceScore({ n: 10, fallbackLevel: 0, quotaAgeSec: 10, externalShare: 0, cv: 0 })).toBeCloseTo(1)
  })

  test("fallback levels and external burn reduce confidence", () => {
    const perfect = confidenceScore({ n: 10, fallbackLevel: 0, quotaAgeSec: 10, externalShare: 0, cv: 0 })
    const fallback = confidenceScore({ n: 10, fallbackLevel: 3, quotaAgeSec: 10, externalShare: 0, cv: 0 })
    const external = confidenceScore({ n: 10, fallbackLevel: 0, quotaAgeSec: 10, externalShare: 0.5, cv: 0 })
    expect(fallback).toBeLessThan(perfect)
    expect(external).toBeLessThan(perfect)
  })

  test("labels follow thresholds", () => {
    expect(confidenceLabel(0.8)).toBe("high")
    expect(confidenceLabel(0.5)).toBe("medium")
    expect(confidenceLabel(0.2)).toBe("low")
  })
})

describe("regimeSamplesAt", () => {
  test("prefers exact regime then model then provider", () => {
    const samples = {
      openai: [{ at: 1, burn: 1 }],
      "openai|gpt|": [{ at: 1, burn: 2 }],
      "openai|gpt|deep": [{ at: 1, burn: 3 }],
    }
    expect(regimeSamplesAt(samples, { provider: "openai", model: "gpt", agent: "deep" })).toEqual({
      list: samples["openai|gpt|deep"],
      fallbackLevel: 0,
    })
    expect(regimeSamplesAt(samples, { provider: "openai", model: "gpt", agent: "build" })).toEqual({
      list: samples["openai|gpt|"],
      fallbackLevel: 1,
    })
    expect(regimeSamplesAt(samples, { provider: "openai", model: "other", agent: "" })).toEqual({
      list: samples["openai"],
      fallbackLevel: 2,
    })
    expect(regimeSamplesAt(samples, { provider: "anthropic" }).fallbackLevel).toBe(3)
  })
})

describe("computeEstimate", () => {
  const quota: QuotaSnapshot = {
    at: 1_000_000,
    fromExport: true,
    entries: [
      { provider: "openai", name: "5h", window: "5h", percentRemaining: 37 },
      { provider: "openai", name: "Weekly", window: "Weekly", percentRemaining: 64 },
      { provider: "anthropic", name: "5h", window: "5h", percentRemaining: 20 },
    ],
  }
  const ctx: ContextEstimate = { usable: null, current: null, growthPerTurn: null, untilCompaction: null }

  test("computes prompts from calibrated burn and picks the binding window", () => {
    const samples = { "openai|gpt|build": Array.from({ length: 10 }, (_, i) => ({ at: i, burn: 4.2 })) }
    const est = computeEstimate({
      now: 1_000_010,
      quota,
      regimeSamples: samples,
      selected: { provider: "openai", model: "gpt", agent: "build" },
      externalShare: 0,
      rootTurns: 12,
      context: ctx,
    })
    expect(est.status).toBe("ready")
    expect(est.binding?.window).toBe("5h")
    expect(est.binding?.remaining).toBe(37)
    expect(est.safe).toBe(Math.floor(37 / 4.2))
    expect(est.likely).toBe(Math.floor(37 / 4.2))
    expect(est.calibration.fallbackLevel).toBe(0)
    expect(est.calibration.regimeTurns).toBe(10)
    expect(est.calibration.rootTurns).toBe(12)
    expect(est.compact).toBe(`≈${Math.floor(37 / 4.2)} prompts · 5h`)
  })

  test("uses fallback provider samples with lower confidence", () => {
    const samples = { openai: [{ at: 1, burn: 4.2 }, { at: 2, burn: 4.2 }] }
    const est = computeEstimate({
      now: 1_000_010,
      quota,
      regimeSamples: samples,
      selected: { provider: "openai", model: "gpt", agent: "build" },
      externalShare: 0,
      rootTurns: 2,
      context: ctx,
    })
    expect(est.status).toBe("ready")
    expect(est.calibration.fallbackLevel).toBe(2)
    expect(est.safe).toBe(Math.floor(37 / (4.2 + 0.05 * 4.2)))
  })

  test("calibrating without any samples", () => {
    const est = computeEstimate({
      now: 1_000_010,
      quota,
      regimeSamples: {},
      selected: { provider: "openai", model: "gpt", agent: "build" },
      externalShare: 0,
      rootTurns: 0,
      context: ctx,
    })
    expect(est.status).toBe("calibrating")
    expect(est.safe).toBeNull()
    expect(est.compact).toContain("calibrating")
  })

  test("no-quota without snapshot", () => {
    const est = computeEstimate({
      now: 1_000_010,
      quota: null,
      regimeSamples: {},
      selected: {},
      externalShare: 0,
      rootTurns: 0,
      context: ctx,
    })
    expect(est.status).toBe("no-quota")
  })

  test("other providers listed with their own samples", () => {
    const samples = {
      "openai|gpt|build": [{ at: 1, burn: 4.2 }],
      anthropic: [{ at: 1, burn: 1 }],
    }
    const est = computeEstimate({
      now: 1_000_010,
      quota,
      regimeSamples: samples,
      selected: { provider: "openai", model: "gpt", agent: "build" },
      externalShare: 0,
      rootTurns: 1,
      context: ctx,
    })
    const anthropic = est.perProvider.find((p) => p.provider === "anthropic")
    expect(anthropic?.windows[0].prompts).toBe(Math.floor(20 / 1.5))
  })
})

describe("context", () => {
  test("growth averages recent turns", () => {
    const turns = [
      turn({ contextBefore: 10_000, contextAfter: 20_000 }),
      turn({ contextBefore: 20_000, contextAfter: 30_000 }),
    ]
    expect(contextGrowthPerTurn(turns)).toBeCloseTo(10_000)
  })

  test("compaction estimate floors headroom over growth", () => {
    expect(compactionTurnsUntil(176_000, 150_000, 8_000)).toBe(3)
    expect(compactionTurnsUntil(176_000, 176_000, 8_000)).toBe(0)
    expect(compactionTurnsUntil(176_000, 150_000, 0)).toBeNull()
    expect(compactionTurnsUntil(null, 150_000, 8_000)).toBeNull()
  })
})
