import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_BUDGETS, DEFAULT_LIMITS, loadPlans } from "./budget"

describe("loadPlans", () => {
  test("applies opencode-go budgets and copilot limits defaults without a config file", () => {
    const p = loadPlans(join(mkdtempSync(join(tmpdir(), "budget-")), "missing.json"))
    expect(p.budgets["opencode-go"]).toEqual({ "5h": 12, Weekly: 30, Monthly: 60 })
    expect(p.limits.copilot).toEqual({ Copilot: 300, "Copilot Premium Interactions": 300 })
    expect(p.tokenLimits).toEqual({})
  })

  test("merges config overrides on top of defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-"))
    const path = join(dir, "prompt-left.json")
    writeFileSync(
      path,
      JSON.stringify({
        budgets: { "opencode-go": { Weekly: 50 }, "other": { Daily: 5 } },
        limits: { openai: { Weekly: 8000 } },
        tokenLimits: { "ollama-cloud": { Weekly: 1_000_000 } },
      }),
    )
    const p = loadPlans(path)
    expect(p.budgets["opencode-go"]).toEqual({ "5h": 12, Weekly: 50, Monthly: 60 })
    expect(p.budgets["other"]).toEqual({ Daily: 5 })
    expect(p.limits.copilot.Copilot).toBe(300)
    expect(p.limits.openai).toEqual({ Weekly: 8000 })
    expect(p.tokenLimits["ollama-cloud"]).toEqual({ Weekly: 1_000_000 })
  })
})

describe("defaults", () => {
  test("matches the documented OpenCode Go plan", () => {
    expect(DEFAULT_BUDGETS["opencode-go"]).toEqual({ "5h": 12, Weekly: 30, Monthly: 60 })
  })

  test("matches Copilot Pro premium interactions", () => {
    expect(DEFAULT_LIMITS.copilot).toEqual({ Copilot: 300, "Copilot Premium Interactions": 300 })
  })
})
