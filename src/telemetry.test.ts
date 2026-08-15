import { describe, expect, test } from "bun:test"
import type { Event, Message, Part } from "@opencode-ai/sdk"
import { Telemetry } from "./telemetry"
import { freshHistory, type RootPrompt } from "./shared"

function evt(type: string, properties: Record<string, unknown>): Event {
  return { type, properties } as unknown as Event
}

function sessionCreated(id: string, parentID?: string): Event {
  return evt("session.created", { info: { id, parentID } })
}

function assistantMsg(overrides: Record<string, unknown> = {}): Message {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    sessionID: "root",
    role: "assistant",
    time: { created: Date.now() },
    parentID: "user1",
    modelID: "deepseek-v4-pro",
    providerID: "opencode-go",
    mode: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  }
}

function stepFinish(overrides: Record<string, unknown> = {}): Part {
  return {
    id: `part_${Math.random().toString(36).slice(2, 10)}`,
    sessionID: "root",
    messageID: "msg1",
    type: "step-finish",
    reason: "stop",
    cost: 0.01,
    tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 4000, write: 0 } },
    ...overrides,
  }
}

function toolPart(overrides: Record<string, unknown> = {}): Part {
  return {
    id: `part_${Math.random().toString(36).slice(2, 10)}`,
    sessionID: "root",
    messageID: "msg1",
    type: "tool",
    tool: "bash",
    callID: "call1",
    state: {
      status: "completed",
      input: {},
      output: "abcdefgh",
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    },
    ...overrides,
  }
}

function prompt(id: string, overrides: Partial<RootPrompt> = {}): RootPrompt {
  return {
    id,
    rootSessionID: "root",
    startedAt: 1000,
    finishedAt: 2000,
    contextBefore: 0,
    compacted: false,
    compactionCost: 0,
    childSessions: 0,
    byProvider: {},
    ...overrides,
  }
}

function seed(t: Telemetry) {
  t.handle(sessionCreated("root"))
}

describe("Telemetry", () => {
  test("step-finish parts accumulate usage once per part id", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.beginPrompt("root", "build", "opencode-go", "deepseek-v4-pro")
    const p = stepFinish({ id: "sf1", messageID: "m1", cost: 0.02, tokens: { input: 500, output: 50, reasoning: 0, cache: { read: 2000, write: 0 } } })
    t.handle(evt("message.updated", { info: assistantMsg({ id: "m1" }) }))
    t.handle(evt("message.part.updated", { part: p }))
    t.handle(evt("message.part.updated", { part: p }))
    t.finalizeAll()
    const finished = t.finished.at(-1)!
    const u = finished.byProvider["opencode-go"]
    expect(u.requests).toBe(1)
    expect(u.cost).toBeCloseTo(0.02)
    expect(u.input).toBe(500)
    expect(u.cacheRead).toBe(2000)
    expect(finished.contextAfter).toBe(2500)
  })

  test("tool completions count once with output chars", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.beginPrompt("root", "build", "opencode-go", "m")
    const tool = toolPart({ id: "t1", messageID: "m1" })
    t.handle(evt("message.updated", { info: assistantMsg({ id: "m1" }) }))
    t.handle(evt("message.part.updated", { part: tool }))
    t.handle(evt("message.part.updated", { part: tool }))
    t.finalizeAll()
    const u = t.finished.at(-1)!.byProvider["opencode-go"]
    expect(u.toolCalls).toBe(1)
    expect(u.toolOutputChars).toBe(8)
  })

  test("child session usage attributes to the active root prompt", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.beginPrompt("root", "build", "opencode-go", "m")
    t.handle(sessionCreated("child", "root"))
    t.handle(evt("message.updated", { info: assistantMsg({ id: "c1", sessionID: "child" }) }))
    t.handle(evt("message.part.updated", { part: stepFinish({ id: "sf2", messageID: "c1", sessionID: "child", cost: 0.05, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }) }))
    t.finalizeAll()
    const finished = t.finished.at(-1)!
    expect(finished.byProvider["opencode-go"].cost).toBeCloseTo(0.05)
    expect(finished.childSessions).toBe(1)
  })

  test("beginPrompt finalizes the previous prompt with its context", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.beginPrompt("root", "build", "opencode-go", "m")
    t.handle(evt("message.part.updated", { part: stepFinish({ id: "sf1", tokens: { input: 100, output: 0, reasoning: 0, cache: { read: 900, write: 0 } } }) }))
    t.beginPrompt("root", "build", "opencode-go", "m")
    expect(t.finished).toHaveLength(1)
    const first = t.finished[0]
    expect(first.finishedAt).toBeDefined()
    expect(first.contextAfter).toBe(1000)
    const second = t.activeSelected()
    expect(second.model).toBe("m")
  })

  test("compaction messages flag the owning prompt and capture compaction cost", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.beginPrompt("root", "build", "opencode-go", "m")
    t.handle(evt("message.updated", { info: assistantMsg({ id: "comp", mode: "compaction", summary: true }) }))
    t.handle(evt("message.part.updated", { part: stepFinish({ id: "sfc", messageID: "comp", cost: 0.3, tokens: { input: 50000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } } }) }))
    t.finalizeAll()
    const finished = t.finished.at(-1)!
    expect(finished.compacted).toBe(true)
    expect(finished.compactionCost).toBeCloseTo(0.3)
  })

  test("session.compacted flags the active prompt", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.beginPrompt("root", "build", "opencode-go", "m")
    t.handle(evt("session.compacted", { sessionID: "root" }))
    t.finalizeAll()
    expect(t.finished.at(-1)!.compacted).toBe(true)
  })

  test("providerCostSince sums finished cost after the cutoff", () => {
    const t = new Telemetry(freshHistory())
    t.finished.push(prompt("p1", { finishedAt: 500, byProvider: { "opencode-go": { ...emptyUsage(), cost: 0.1 } } }))
    t.finished.push(prompt("p2", { finishedAt: 1500, byProvider: { "opencode-go": { ...emptyUsage(), cost: 0.2 } } }))
    expect(t.providerCostSince("opencode-go", 1000)).toBeCloseTo(0.2)
    expect(t.providerCostSince("opencode-go", 0)).toBeCloseTo(0.3)
  })

  test("user message starts a prompt as fallback; synthetic and compaction users are ignored", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    const real = { id: "u1", sessionID: "root", role: "user", agent: "build", model: { providerID: "opencode-go", modelID: "m" }, time: { created: Date.now() } }
    t.handle(evt("message.updated", { info: real }))
    expect(t.activeSelected().provider).toBe("opencode-go")
    t.finalizeAll()
    t.handle(evt("message.part.updated", { part: { id: "s1", sessionID: "root", messageID: "u2", type: "text", text: "x", synthetic: true } }))
    t.handle(evt("message.updated", { info: { ...real, id: "u2" } }))
    expect(t.finished).toHaveLength(1)
    t.handle(evt("message.part.updated", { part: { id: "c1", sessionID: "root", messageID: "u3", type: "compaction", auto: true } }))
    t.handle(evt("message.updated", { info: { ...real, id: "u3" } }))
    expect(t.finished).toHaveLength(1)
  })

  test("selection follows noteSelection and overrideSelection", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.noteSelection("root", { provider: "opencode-go", model: "m", agent: "build" })
    expect(t.activeSelected()).toEqual({ provider: "opencode-go", model: "m", agent: "build" })
    t.overrideSelection({ provider: "openai", model: "gpt" })
    expect(t.activeSelected().model).toBe("gpt")
  })

  test("root finalizes on idle only when all children are idle", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.beginPrompt("root", "build", "opencode-go", "m")
    t.handle(sessionCreated("child", "root"))
    t.handle(evt("session.idle", { sessionID: "root" }))
    expect(t.finished).toHaveLength(0)
    t.handle(evt("session.idle", { sessionID: "child" }))
    t.handle(evt("session.idle", { sessionID: "root" }))
    expect(t.finished).toHaveLength(1)
  })

  test("hydrate restores latest root and last context", () => {
    const t = new Telemetry(freshHistory())
    t.hydrate([{ id: "a" }, { id: "b" }], 4200)
    expect(t.latestRoot).toBe("b")
    expect(t.contextNow()).toBe(4200)
  })

  test("setActiveSession switches selection and context to the active session", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.handle(sessionCreated("b"))
    t.setActiveSession("root")
    t.noteSelection("root", { provider: "opencode-go", model: "flash", agent: "build" })
    t.noteSelection("b", { provider: "openai", model: "gpt", agent: "plan" })
    t.handle(evt("message.part.updated", { part: stepFinish({ id: "sfr", sessionID: "root", messageID: "m1", tokens: { input: 300, output: 0, reasoning: 0, cache: { read: 700, write: 0 } } }) }))
    t.handle(evt("message.part.updated", { part: stepFinish({ id: "sfb", sessionID: "b", messageID: "m2", tokens: { input: 1000, output: 0, reasoning: 0, cache: { read: 4000, write: 0 } } }) }))
    expect(t.activeSelected().model).toBe("flash")
    expect(t.contextNow()).toBe(1000)
    t.setActiveSession("b")
    expect(t.activeSelected().model).toBe("gpt")
    expect(t.contextNow()).toBe(5000)
  })

  test("overrideSelection wins while it is the freshest signal", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.handle(sessionCreated("b"))
    t.noteSelection("root", { provider: "opencode-go", model: "flash", agent: "build" })
    t.overrideSelection({ provider: "openai", model: "gpt" })
    expect(t.activeSelected()).toEqual({ provider: "openai", model: "gpt" })
    t.setActiveSession("root")
    expect(t.activeSelected()).toEqual({ provider: "openai", model: "gpt" })
  })

  test("a newer prompt selection overrides the picker", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.setActiveSession("root")
    t.overrideSelection({ provider: "openai", model: "gpt" })
    expect(t.activeSelected().model).toBe("gpt")
    t.noteSelection("root", { provider: "opencode-go", model: "flash", agent: "build" })
    expect(t.activeSelected().model).toBe("flash")
    expect(t.activeSelected().provider).toBe("opencode-go")
  })

  test("noteBaseline fills an unknown session but never overrides a known one", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.setActiveSession("ses_unknown")
    t.noteBaseline("ses_unknown", { provider: "opencode-go", model: "flash", agent: "plan" })
    expect(t.activeSelected()).toEqual({ provider: "opencode-go", model: "flash", agent: "plan" })
    t.noteSelection("ses_unknown", { provider: "openai", model: "gpt", agent: "build" })
    t.noteBaseline("ses_unknown", { provider: "opencode-go", model: "flash", agent: "plan" })
    expect(t.activeSelected()).toEqual({ provider: "openai", model: "gpt", agent: "build" })
  })

  test("session.next.model.switched and agent.switched events update selection", () => {
    const t = new Telemetry(freshHistory())
    seed(t)
    t.setActiveSession("root")
    t.handle(evt("session.next.model.switched", { sessionID: "root", model: { providerID: "openai", id: "gpt-5.6" } }))
    expect(t.activeSelected()).toEqual({ provider: "openai", model: "gpt-5.6" })
    t.handle(evt("session.next.agent.switched", { sessionID: "root", agent: "plan" }))
    expect(t.activeSelected().agent).toBe("plan")
  })

  test("costFn fills zero-cost usage at finalize using model pricing", () => {
    const costFn = (_provider: string, _model: string | undefined, u: ReturnType<typeof emptyUsage>) =>
      (u.input * 0.5 + u.output * 2 + u.cacheRead * 0.05) / 1_000_000
    const t = new Telemetry(freshHistory(), costFn)
    seed(t)
    t.beginPrompt("root", "build", "openai", "gpt")
    t.handle(evt("message.updated", { info: assistantMsg({ id: "m1", providerID: "openai" }) }))
    t.handle(evt("message.part.updated", { part: stepFinish({ id: "sf1", messageID: "m1", cost: 0, tokens: { input: 10_000, output: 1_000, reasoning: 0, cache: { read: 40_000, write: 0 } } }) }))
    t.finalizeAll()
    const u = t.finished.at(-1)!.byProvider["openai"]
    expect(u.cost).toBeCloseTo((10_000 * 0.5 + 1_000 * 2 + 40_000 * 0.05) / 1_000_000)
  })

  test("setActiveSession accepts sessions not seen in this instance", () => {
    const t = new Telemetry(freshHistory())
    t.setActiveSession("ses_never_seen")
    expect(t.activeRoot).toBe("ses_never_seen")
    t.noteBaseline("ses_never_seen", { provider: "opencode-go", model: "flash" })
    expect(t.activeSelected().model).toBe("flash")
  })
})

function emptyUsage() {
  return {
    requests: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
    toolCalls: 0,
    toolOutputChars: 0,
  }
}
