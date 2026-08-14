import type { Event, Message, Part } from "@opencode-ai/sdk"
import type { HistoryState, PromptUsage, RootPrompt, SelectedRegime } from "./shared"
import { emptyUsage } from "./shared"

const MAX_PROMPTS = 200
const MAX_OWNER_ENTRIES = 4000
const MAX_SEEN_ENTRIES = 8000

export class Telemetry {
  private sessionRoot = new Map<string, string>()
  private rootSessions = new Set<string>()
  private activeByRoot = new Map<string, RootPrompt>()
  private msgOwner = new Map<string, string>()
  private msgProvider = new Map<string, string>()
  private compactionMsgs = new Set<string>()
  private syntheticUserMsgs = new Set<string>()
  private compactionUserMsgs = new Set<string>()
  private seenStepParts = new Set<string>()
  private seenToolParts = new Set<string>()
  private idle = new Set<string>()
  private selected = new Map<string, { sel: SelectedRegime; seq: number }>()
  private picker?: { sel: SelectedRegime; seq: number }
  private lastContext = new Map<string, number>()
  private promptSeq = 0
  private selSeq = 0

  finished: RootPrompt[] = []
  lastSelected?: SelectedRegime
  latestRoot?: string
  activeRoot?: string

  constructor(history: HistoryState) {
    this.finished = history.prompts ?? []
    this.lastSelected = history.lastSelected
  }

  handle(e: Event): void {
    const type = (e as { type: string }).type
    if (type === "session.next.model.switched" || type === "session.next.agent.switched") {
      const props = (e as unknown as {
        properties: { sessionID: string; model?: { providerID?: string; id?: string; modelID?: string }; agent?: string }
      }).properties
      if (type === "session.next.model.switched") {
        const model = props.model
        if (model?.providerID && (model.id ?? model.modelID)) {
          this.noteSelection(props.sessionID, {
            provider: model.providerID,
            model: model.id ?? model.modelID,
          })
        }
      } else {
        if (props.agent) this.noteAgent(props.sessionID, props.agent)
      }
      return
    }
    switch (e.type) {
      case "session.created": {
        const s = e.properties.info
        if (s.parentID) {
          const root = this.resolveRoot(s.parentID)
          this.sessionRoot.set(s.id, root)
          const prompt = this.activeByRoot.get(root)
          if (prompt) prompt.childSessions++
        } else {
          this.rootSessions.add(s.id)
          this.sessionRoot.set(s.id, s.id)
        }
        return
      }
      case "session.deleted": {
        const id = e.properties.info.id
        const root = this.resolveRoot(id)
        this.sessionRoot.delete(id)
        this.rootSessions.delete(id)
        this.selected.delete(id)
        this.lastContext.delete(id)
        this.idle.delete(id)
        if (id === root) this.finalize(root)
        return
      }
      case "session.idle": {
        this.idle.add(e.properties.sessionID)
        const root = this.resolveRoot(e.properties.sessionID)
        if (e.properties.sessionID === root) this.maybeFinalize(root)
        return
      }
      case "session.compacted": {
        const root = this.resolveRoot(e.properties.sessionID)
        const prompt = this.activeByRoot.get(root)
        if (prompt) prompt.compacted = true
        return
      }
      case "message.updated":
        this.onMessage(e.properties.info)
        return
      case "message.part.updated":
        this.onPart(e.properties.part)
        return
      case "message.removed": {
        const id = e.properties.messageID
        this.msgOwner.delete(id)
        this.msgProvider.delete(id)
        this.compactionMsgs.delete(id)
        this.syntheticUserMsgs.delete(id)
        this.compactionUserMsgs.delete(id)
        return
      }
      default:
        return
    }
  }

  hydrate(sessions: { id: string; parentID?: string }[], lastContext?: number): void {
    let latestRoot: string | undefined
    for (const s of sessions) {
      if (s.parentID) {
        this.sessionRoot.set(s.id, this.resolveRoot(s.parentID))
      } else {
        this.rootSessions.add(s.id)
        this.sessionRoot.set(s.id, s.id)
        latestRoot = s.id
      }
    }
    if (latestRoot) {
      this.latestRoot = latestRoot
      if (lastContext !== undefined) this.lastContext.set(latestRoot, lastContext)
    }
  }

  private resolveRoot(sessionID: string): string {
    const seen = new Set<string>()
    let current = sessionID
    while (!seen.has(current)) {
      seen.add(current)
      const next = this.sessionRoot.get(current)
      if (!next || next === current) return current
      current = next
    }
    return sessionID
  }

  private isRootSession(sessionID: string): boolean {
    return this.sessionRoot.get(sessionID) === sessionID
  }

  private setOwner(messageID: string, promptID: string) {
    if (this.msgOwner.size > MAX_OWNER_ENTRIES) {
      const excess = this.msgOwner.size - MAX_OWNER_ENTRIES
      let removed = 0
      for (const key of [...this.msgOwner.keys()]) {
        if (removed >= excess) break
        this.msgOwner.delete(key)
        removed++
      }
    }
    this.msgOwner.set(messageID, promptID)
  }

  private seenPart(id: string, set: Set<string>): boolean {
    if (set.has(id)) return true
    if (set.size > MAX_SEEN_ENTRIES) set.clear()
    set.add(id)
    return false
  }

  private onMessage(m: Message): void {
    if (m.role === "assistant") {
      const root = this.resolveRoot(m.sessionID)
      const prompt = this.activeByRoot.get(root)
      if (prompt) this.setOwner(m.id, prompt.id)
      this.msgProvider.set(m.id, m.providerID)
      if (m.mode === "compaction") this.compactionMsgs.add(m.id)
      this.latestRoot = root
      if (m.sessionID === root && !prompt) return
      return
    }
    if (!this.isRootSession(m.sessionID)) return
    const root = this.resolveRoot(m.sessionID)
    if (this.syntheticUserMsgs.has(m.id) || this.compactionUserMsgs.has(m.id)) return
    if (!this.activeByRoot.has(root)) {
      this.beginPrompt(root, m.agent, m.model.providerID, m.model.modelID)
    }
    this.latestRoot = root
  }

  private onPart(p: Part): void {
    if (p.type === "step-finish") {
      if (this.seenPart(p.id, this.seenStepParts)) return
      const root = this.resolveRoot(p.sessionID)
      const prompt = this.activeByRoot.get(root) ?? this.finishedByOwner(p.messageID)
      if (prompt) {
        const provider = this.msgProvider.get(p.messageID) ?? prompt.provider ?? "unknown"
        const u = (prompt.byProvider[provider] ??= emptyUsage())
        u.requests++
        u.input += p.tokens.input
        u.cacheRead += p.tokens.cache.read
        u.cacheWrite += p.tokens.cache.write
        u.output += p.tokens.output
        u.reasoning += p.tokens.reasoning
        u.cost += p.cost
        if (this.compactionMsgs.has(p.messageID)) {
          prompt.compactionCost += p.cost
          prompt.compacted = true
        }
      }
      const context = p.tokens.input + p.tokens.cache.read + p.tokens.cache.write
      if (context > 0) this.lastContext.set(p.sessionID, context)
      return
    }
    if (p.type === "tool") {
      if (this.seenPart(p.id, this.seenToolParts)) return
      if (p.state.status !== "completed") return
      const root = this.resolveRoot(p.sessionID)
      const prompt = this.activeByRoot.get(root) ?? this.finishedByOwner(p.messageID)
      if (!prompt) return
      const provider = this.msgProvider.get(p.messageID) ?? prompt.provider ?? "unknown"
      const u = (prompt.byProvider[provider] ??= emptyUsage())
      u.toolCalls++
      u.toolOutputChars += p.state.output?.length ?? 0
      return
    }
    if (p.type === "text" && p.synthetic) {
      this.syntheticUserMsgs.add(p.messageID)
      return
    }
    if (p.type === "compaction") {
      this.compactionUserMsgs.add(p.messageID)
    }
  }

  private finishedByOwner(messageID: string): RootPrompt | undefined {
    const ownerID = this.msgOwner.get(messageID)
    if (!ownerID) return undefined
    return this.finished.find((p) => p.id === ownerID)
  }

  beginPrompt(rootSessionID: string, agent?: string, provider?: string, model?: string): void {
    if (!this.rootSessions.has(rootSessionID)) {
      this.rootSessions.add(rootSessionID)
      this.sessionRoot.set(rootSessionID, rootSessionID)
    }
    const existing = this.activeByRoot.get(rootSessionID)
    const existingUsage = existing
      ? Object.values(existing.byProvider).reduce((acc, u) => acc + u.cost, 0)
      : 0
    if (existing && existingUsage === 0) {
      existing.agent = agent ?? existing.agent
      existing.provider = provider ?? existing.provider
      existing.model = model ?? existing.model
      this.latestRoot = rootSessionID
      return
    }
    this.finalize(rootSessionID)
    if (provider) {
      const sel = { provider, model, agent }
      this.selected.set(rootSessionID, { sel, seq: ++this.selSeq })
      this.lastSelected = sel
    }
    const prompt: RootPrompt = {
      id: `${rootSessionID}:${Date.now()}:${this.promptSeq++}`,
      rootSessionID,
      startedAt: Date.now(),
      agent,
      provider,
      model,
      contextBefore: this.lastContext.get(rootSessionID) ?? 0,
      compacted: false,
      compactionCost: 0,
      childSessions: 0,
      byProvider: {},
    }
    this.activeByRoot.set(rootSessionID, prompt)
    this.idle.delete(rootSessionID)
    this.latestRoot = rootSessionID
  }

  private childrenOf(root: string): string[] {
    const out: string[] = []
    for (const sessionID of this.sessionRoot.keys()) {
      if (sessionID !== root && this.resolveRoot(sessionID) === root) out.push(sessionID)
    }
    return out
  }

  private maybeFinalize(root: string): void {
    if (!this.activeByRoot.has(root)) return
    if (!this.idle.has(root)) return
    const children = this.childrenOf(root)
    if (children.length > 0 && !children.every((c) => this.idle.has(c))) return
    this.finalize(root)
  }

  private finalize(root: string): void {
    const prompt = this.activeByRoot.get(root)
    if (!prompt) return
    prompt.finishedAt = Date.now()
    prompt.contextAfter = this.lastContext.get(root)
    this.finished.push(prompt)
    if (this.finished.length > MAX_PROMPTS) this.finished = this.finished.slice(-MAX_PROMPTS)
    this.activeByRoot.delete(root)
  }

  finalizeAll(): void {
    for (const root of [...this.activeByRoot.keys()]) this.finalize(root)
  }

  providerCostSince(provider: string, since: number): number {
    let total = 0
    for (const p of this.finished) {
      if ((p.finishedAt ?? p.startedAt) < since) continue
      total += p.byProvider[provider]?.cost ?? 0
    }
    for (const p of this.activeByRoot.values()) {
      total += p.byProvider[provider]?.cost ?? 0
    }
    return total
  }

  setActiveSession(sessionID: string): void {
    if (!this.rootSessions.has(sessionID) && !this.sessionRoot.has(sessionID)) {
      this.rootSessions.add(sessionID)
      this.sessionRoot.set(sessionID, sessionID)
    }
    const root = this.resolveRoot(sessionID)
    this.activeRoot = root
    this.latestRoot = root
  }

  contextNow(): number | null {
    const root = this.activeRoot ?? this.latestRoot
    if (!root) return null
    return this.lastContext.get(root) ?? null
  }

  noteSelection(sessionID: string, sel: SelectedRegime): void {
    if (!sel.provider) return
    if (!this.isRootSession(sessionID)) return
    const root = this.resolveRoot(sessionID)
    this.selected.set(root, { sel, seq: ++this.selSeq })
    this.lastSelected = sel
  }

  noteBaseline(sessionID: string, sel: SelectedRegime): void {
    if (!sel.provider) return
    const root = this.resolveRoot(sessionID)
    if (this.selected.has(root)) return
    this.selected.set(root, { sel, seq: ++this.selSeq })
    this.lastSelected = sel
  }

  noteAgent(sessionID: string, agent: string): void {
    const root = this.resolveRoot(sessionID)
    const current = this.selected.get(root)
    if (current) {
      current.sel = { ...current.sel, agent }
      return
    }
    if (this.lastSelected) this.lastSelected = { ...this.lastSelected, agent }
  }

  overrideSelection(sel: SelectedRegime): void {
    if (!sel.provider) return
    this.picker = { sel, seq: ++this.selSeq }
    this.lastSelected = sel
  }

  activeSelected(): SelectedRegime {
    const root = this.activeRoot ?? this.latestRoot
    const s = root ? this.selected.get(root) : undefined
    if (this.picker && (!s || this.picker.seq > s.seq)) return this.picker.sel
    if (s) return s.sel
    return this.lastSelected ?? {}
  }
}
