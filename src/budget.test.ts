import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_BUDGETS, loadBudgets } from "./budget"

describe("loadBudgets", () => {
  test("applies opencode-go defaults without a config file", () => {
    const b = loadBudgets(join(mkdtempSync(join(tmpdir(), "budget-")), "missing.json"))
    expect(b["opencode-go"]).toEqual({ "5h": 12, Weekly: 30, Monthly: 60 })
  })

  test("merges config overrides on top of defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "budget-"))
    const path = join(dir, "prompt-left.json")
    writeFileSync(path, JSON.stringify({ budgets: { "opencode-go": { Weekly: 50 }, "other": { Daily: 5 } } }))
    const b = loadBudgets(path)
    expect(b["opencode-go"]).toEqual({ "5h": 12, Weekly: 50, Monthly: 60 })
    expect(b["other"]).toEqual({ Daily: 5 })
  })
})

describe("DEFAULT_BUDGETS", () => {
  test("matches the documented OpenCode Go plan", () => {
    expect(DEFAULT_BUDGETS["opencode-go"]).toEqual({ "5h": 12, Weekly: 30, Monthly: 60 })
  })
})
