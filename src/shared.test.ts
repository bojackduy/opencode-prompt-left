import { describe, expect, test } from "bun:test"
import { statePaths, workspaceKey } from "./shared"

describe("workspaceKey", () => {
  test("is stable and derived from the directory", () => {
    expect(workspaceKey("/a/b/c")).toBe(workspaceKey("/a/b/c"))
    expect(workspaceKey("/a/b/c")).not.toBe(workspaceKey("/a/b/d"))
    expect(workspaceKey("/a/b/c")).toMatch(/^[0-9a-f]{12}$/)
  })

  test("statePaths scopes all files under the workspace directory", () => {
    const p = statePaths(workspaceKey("/a/b/c"))
    expect(p.dir).toContain("/prompt-left/")
    expect(p.history).toBe(`${p.dir}/history.json`)
    expect(p.estimate).toBe(`${p.dir}/estimate.json`)
    expect(p.selection).toBe(`${p.dir}/selection.json`)
    expect(p.active).toBe(`${p.dir}/active.json`)
  })
})
