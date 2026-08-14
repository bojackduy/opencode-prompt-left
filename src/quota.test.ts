import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readProviderStateDir } from "./quota"

function writeStateFile(dir: string, name: string, body: Record<string, unknown>) {
  writeFileSync(join(dir, name), JSON.stringify(body))
}

function stateBody(providerId: string, timestamp: number, percent: number, packageVersion = "4.0.0"): Record<string, unknown> {
  return {
    version: 2,
    packageVersion,
    providerId,
    timestamp,
    result: {
      entries: [
        { name: `${providerId} 5h`, group: providerId, percentRemaining: percent, resetTimeIso: "2026-08-14T07:17:35.000Z" },
        { name: `${providerId} Weekly`, group: providerId, percentRemaining: percent, resetTimeIso: "2026-08-17T00:00:00.000Z" },
      ],
    },
  }
}

describe("readProviderStateDir", () => {
  test("picks the newest file per provider and dedupes entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-test-"))
    writeStateFile(dir, "old.json", stateBody("opencode-go", 1000, 50))
    writeStateFile(dir, "new.json", stateBody("opencode-go", 2000, 40))
    const snap = readProviderStateDir(dir)
    expect(snap).not.toBeNull()
    expect(snap!.entries).toHaveLength(2)
    expect(snap!.entries[0].percentRemaining).toBe(40)
    expect(snap!.at).toBe(2000)
  })

  test("newer package version wins on timestamp ties", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-test-"))
    writeStateFile(dir, "a.json", stateBody("opencode-go", 1500, 50, "3.11.2"))
    writeStateFile(dir, "b.json", stateBody("opencode-go", 1500, 40, "4.8.0"))
    const snap = readProviderStateDir(dir)
    expect(snap!.entries[0].percentRemaining).toBe(40)
  })

  test("keeps distinct providers in one snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-test-"))
    writeStateFile(dir, "go.json", stateBody("opencode-go", 2000, 40))
    writeStateFile(dir, "openai.json", stateBody("openai", 3000, 85))
    const snap = readProviderStateDir(dir)
    expect([...new Set(snap!.entries.map((e) => e.provider))].sort()).toEqual(["openai", "opencode-go"])
  })

  test("skips unlimited and non-numeric entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-test-"))
    const body = stateBody("opencode-go", 2000, 40)
    const entries = (body.result as { entries: Record<string, unknown>[] }).entries
    entries.push({ name: "Unlimited", percentRemaining: 100, unlimited: true })
    entries.push({ name: "Broken", percentRemaining: "not-a-number" })
    writeStateFile(dir, "a.json", body)
    const snap = readProviderStateDir(dir)
    expect(snap!.entries).toHaveLength(2)
  })

  test("returns null for a missing directory", () => {
    expect(readProviderStateDir(join(tmpdir(), "definitely-missing-dir"))).toBeNull()
  })

  test("returns null when no files carry a providerId", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-test-"))
    mkdirSync(join(dir, "nested"), { recursive: true })
    writeStateFile(dir, "no-provider.json", { timestamp: 1000 })
    expect(readProviderStateDir(dir)).toBeNull()
  })
})
