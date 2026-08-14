import { describe, expect, test } from "bun:test"
import type { Event } from "@opencode-ai/sdk"
import { Telemetry } from "./telemetry"
import { freshHistory } from "./shared"

function assistantMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: `a-${Math.random()}`,
    sessionID: "root",
    role: "assistant",
    parentID: "u1",
    modelID: "gpt",
    providerID: "openai",
    mode: "build",
    cost: 0.01,
    time: { created: 10 },
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 2 } },
    path: { cwd: "/", root: "/" },
    ...overrides,
  }
}

function userMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: `u-${Math.random()}`,
    sessionID: "root",
    role: "user",
    parentID: "a0",
    time: { created: 0 },
    ...overrides,
  }
}

function evt(type: Event["type"], properties: unknown): Event {
  return { type, properties } as Event
}

function seedRoot(): { t: Telemetry; u: ReturnType<typeof userMsg> } {
  const t = new Telemetry(freshHistory())
  t.handle(evt("session.created", { info: { id: "root" } }))
  const u = userMsg()
  t.handle(evt("message.updated", { info: u }))
  return { t, u }
}

describe("Telemetry", () => {
  test("aggregates tokens, requests and cost into a root turn", () => {
    const { t } = seedRoot()
    t.handle(evt("message.updated", { info: assistantMsg() }))
    t.handle(evt("message.updated", { info: assistantMsg() }))
    t.handle(evt("session.idle", { sessionID: "root" }))
    expect(t.finished).toHaveLength(1)
    const turn = t.finished[0]
    expect(turn.rootMessageID).toBeDefined()
    const totals = turn.byProvider["openai"]
    expect(totals.requests).toBe(2)
    expect(totals.input).toBe(200)
    expect(totals.output).toBe(40)
    expect(totals.cacheRead).toBe(100)
    expect(totals.cost).toBeCloseTo(0.02)
  })

  test("child session usage rolls up into the root turn", () => {
    const { t } = seedRoot()
    t.handle(evt("session.created", { info: { id: "child", parentID: "root" } }))
    t.handle(evt("message.updated", { info: assistantMsg({ sessionID: "child", providerID: "anthropic", modelID: "opus" }) }))
    t.handle(evt("message.updated", { info: assistantMsg({ sessionID: "child", providerID: "anthropic", modelID: "opus" }) }))
    t.handle(evt("session.idle", { sessionID: "child" }))
    t.handle(evt("session.idle", { sessionID: "root" }))
    expect(t.finished).toHaveLength(1)
    expect(t.finished[0].childSessions).toBe(1)
    expect(t.finished[0].byProvider["anthropic"].requests).toBe(2)
    expect(t.finished[0].provider).toBeUndefined()
  })

  test("root finalizes only after children idle", () => {
    const { t } = seedRoot()
    t.handle(evt("session.created", { info: { id: "child", parentID: "root" } }))
    t.handle(evt("session.idle", { sessionID: "root" }))
    expect(t.finished).toHaveLength(0)
    t.handle(evt("session.idle", { sessionID: "child" }))
    expect(t.finished).toHaveLength(1)
  })

  test("nested subagents resolve to the ultimate root", () => {
    const { t } = seedRoot()
    t.handle(evt("session.created", { info: { id: "child", parentID: "root" } }))
    t.handle(evt("session.created", { info: { id: "grandchild", parentID: "child" } }))
    t.handle(evt("message.updated", { info: assistantMsg({ sessionID: "grandchild", providerID: "anthropic", modelID: "opus" }) }))
    t.handle(evt("session.idle", { sessionID: "child" }))
    t.handle(evt("session.idle", { sessionID: "root" }))
    t.handle(evt("session.idle", { sessionID: "grandchild" }))
    expect(t.finished).toHaveLength(1)
    expect(t.finished[0].childSessions).toBe(2)
    expect(t.finished[0].byProvider["anthropic"].requests).toBe(1)
  })

  test("new user message finalizes the previous turn lazily", () => {
    const { t } = seedRoot()
    t.handle(evt("message.updated", { info: assistantMsg() }))
    const u2 = userMsg()
    t.handle(evt("message.updated", { info: u2 }))
    expect(t.finished).toHaveLength(1)
    expect(t.finished[0].contextAfter).toBe(177)
  })

  test("orphan child messages after finalize are ignored", () => {
    const { t } = seedRoot()
    t.handle(evt("message.updated", { info: assistantMsg() }))
    t.handle(evt("session.idle", { sessionID: "root" }))
    t.handle(evt("session.created", { info: { id: "late", parentID: "root" } }))
    t.handle(evt("message.updated", { info: assistantMsg({ sessionID: "late" }) }))
    expect(t.finished).toHaveLength(1)
    expect(t.finished[0].byProvider["openai"].requests).toBe(1)
  })

  test("subagent user prompts do not start root turns", () => {
    const { t } = seedRoot()
    t.handle(evt("session.created", { info: { id: "child", parentID: "root" } }))
    t.handle(evt("message.updated", { info: userMsg({ sessionID: "child" }) }))
    expect(t.finished).toHaveLength(0)
    t.handle(evt("session.idle", { sessionID: "child" }))
    t.handle(evt("session.idle", { sessionID: "root" }))
    expect(t.finished).toHaveLength(1)
    expect(t.finished[0].childSessions).toBe(1)
  })

  test("selection only follows the main agent, not subagents", () => {
    const { t } = seedRoot()
    t.handle(evt("session.created", { info: { id: "child", parentID: "root" } }))
    t.handle(evt("message.updated", { info: assistantMsg({ providerID: "openai", modelID: "gpt" }) }))
    t.handle(evt("message.updated", { info: assistantMsg({ sessionID: "child", providerID: "anthropic", modelID: "opus" }) }))
    expect(t.activeSelected()).toEqual({ provider: "openai", model: "gpt", agent: "build" })
  })

  test("compaction flags the open turn", () => {
    const { t } = seedRoot()
    t.handle(evt("session.compacted", { sessionID: "root" }))
    t.handle(evt("session.idle", { sessionID: "root" }))
    expect(t.finished[0].compactedSessions).toBe(1)
  })

  test("context tracks root-session tokens only", () => {
    const { t } = seedRoot()
    t.handle(evt("session.created", { info: { id: "child", parentID: "root" } }))
    t.handle(evt("message.updated", { info: assistantMsg() }))
    t.handle(evt("message.updated", { info: assistantMsg({ sessionID: "child", tokens: { input: 99999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }) }))
    expect(t.contextNow()).toBe(177)
  })
})
