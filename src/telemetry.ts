import type { Event, Message, Part } from "@opencode-ai/sdk"
import type { HistoryState, ProviderTotals, RootTurn, SelectedRegime } from "./shared"
import { emptyTotals, totalTokens } from "./shared"

const MAX_TURNS = 200

export class Telemetry {
  private sessionToRoot = new Map<string, string>()
  private rootSessions = new Set<string>()
  private openTurns = new Map<string, RootTurn>()
  private toolCalls = new Map<string, Set<string>>()
  private idle = new Set<string>()
  private selected = new Map<string, SelectedRegime>()
  private lastAssistantTotal = new Map<string, number>()

  finished: RootTurn[] = []
  lastSelected?: SelectedRegime
  latestRoot?: string

  constructor(history: HistoryState) {
    this.finished = history.turns ?? []
    this.lastSelected = history.lastSelected
  }

  handle(e: Event): void {
    switch (e.type) {
      case "session.created": {
        const s = e.properties.info
        if (s.parentID) {
          const root = this.resolveRoot(s.parentID)
          this.sessionToRoot.set(s.id, root)
          const turn = this.openTurns.get(root)
          if (turn) turn.childSessions++
        } else {
          this.rootSessions.add(s.id)
          this.sessionToRoot.set(s.id, s.id)
        }
        return
      }
      case "session.deleted": {
        const id = e.properties.info.id
        this.sessionToRoot.delete(id)
        this.rootSessions.delete(id)
        this.selected.delete(id)
        this.lastAssistantTotal.delete(id)
        if (this.openTurns.has(id)) this.openTurns.delete(id)
        return
      }
      case "session.idle": {
        this.idle.add(e.properties.sessionID)
        const root = this.rootFor(e.properties.sessionID)
        this.maybeFinalize(root)
        return
      }
      case "session.compacted": {
        const root = this.rootFor(e.properties.sessionID)
        const turn = this.openTurns.get(root)
        if (turn) turn.compactedSessions++
        return
      }
      case "message.updated":
        this.onMessage(e.properties.info)
        return
      case "message.part.updated":
        this.onPart(e.properties.part)
        return
      default:
        return
    }
  }

  hydrate(sessions: { id: string; parentID?: string }[]): void {
    for (const s of sessions) {
      if (s.parentID) {
        this.sessionToRoot.set(s.id, this.resolveRoot(s.parentID))
      } else {
        this.rootSessions.add(s.id)
        this.sessionToRoot.set(s.id, s.id)
      }
    }
  }

  private resolveRoot(sessionID: string): string {
    const seen = new Set<string>()
    let current = sessionID
    while (!seen.has(current)) {
      seen.add(current)
      const next = this.sessionToRoot.get(current)
      if (!next || next === current) return current
      current = next
    }
    return sessionID
  }

  private rootFor(sessionID: string): string {
    return this.resolveRoot(sessionID)
  }

  private isRootSession(sessionID: string): boolean {
    const root = this.sessionToRoot.get(sessionID)
    return root === undefined || root === sessionID
  }

  private onMessage(m: Message): void {
    if (m.role === "assistant") {
      const root = this.rootFor(m.sessionID)
      let turn = this.openTurns.get(root)
      if (!turn) {
        if (m.sessionID !== root) return
        turn = {
          rootSessionID: root,
          rootMessageID: m.id,
          startedAt: m.time.created,
          contextBefore: this.lastAssistantTotal.get(root) ?? 0,
          byProvider: {},
          childSessions: 0,
          compactedSessions: 0,
        }
        this.openTurns.set(root, turn)
        this.toolCalls.set(root, new Set())
      }
      if (m.providerID) {
        const totals = (turn.byProvider[m.providerID] ??= emptyTotals())
        totals.requests++
        totals.input += m.tokens.input
        totals.output += m.tokens.output
        totals.reasoning += m.tokens.reasoning
        totals.cacheRead += m.tokens.cache.read
        totals.cacheWrite += m.tokens.cache.write
        totals.cost += m.cost
      }
      if (m.sessionID === root) {
        this.lastAssistantTotal.set(root, totalTokens(m.tokens))
        turn.provider = m.providerID
        turn.model = m.modelID
        turn.agent = m.mode
        const sel = { provider: m.providerID, model: m.modelID, agent: m.mode }
        this.selected.set(root, sel)
        this.lastSelected = sel
      }
      this.latestRoot = root
      return
    }
    if (this.isRootSession(m.sessionID)) {
      const root = this.rootFor(m.sessionID)
      this.finalize(root)
      const sel = this.selected.get(root) ?? this.lastSelected
      const turn: RootTurn = {
        rootSessionID: root,
        rootMessageID: m.id,
        startedAt: m.time.created,
        contextBefore: this.lastAssistantTotal.get(root) ?? 0,
        provider: sel?.provider,
        model: sel?.model,
        agent: sel?.agent,
        byProvider: {},
        childSessions: 0,
        compactedSessions: 0,
      }
      this.openTurns.set(root, turn)
      this.toolCalls.set(root, new Set())
      this.idle.delete(root)
      this.latestRoot = root
      return
    }
  }

  private onPart(p: Part): void {
    if (p.type !== "tool") return
    const root = this.rootFor(p.sessionID)
    const turn = this.openTurns.get(root)
    if (!turn) return
    const seen = this.toolCalls.get(root)
    if (!seen || seen.has(p.callID)) return
    seen.add(p.callID)
    const provider = this.selected.get(p.sessionID)?.provider
    if (provider) {
      const totals = (turn.byProvider[provider] ??= emptyTotals())
      totals.toolCalls++
    }
  }

  private childrenOf(root: string): string[] {
    const out: string[] = []
    for (const sessionID of this.sessionToRoot.keys()) {
      if (sessionID !== root && this.resolveRoot(sessionID) === root) out.push(sessionID)
    }
    return out
  }

  private maybeFinalize(root: string): void {
    const turn = this.openTurns.get(root)
    if (!turn) return
    if (!this.idle.has(root)) return
    const children = this.childrenOf(root)
    if (children.length > 0 && !children.every((c) => this.idle.has(c))) return
    this.finalize(root)
  }

  private finalize(root: string): void {
    const turn = this.openTurns.get(root)
    if (!turn) return
    turn.finishedAt = Date.now()
    turn.contextAfter = this.lastAssistantTotal.get(root)
    this.finished.push(turn)
    if (this.finished.length > MAX_TURNS) this.finished = this.finished.slice(-MAX_TURNS)
    this.openTurns.delete(root)
    this.toolCalls.delete(root)
  }

  contextNow(): number | null {
    if (!this.latestRoot) return null
    return this.lastAssistantTotal.get(this.latestRoot) ?? null
  }

  noteSelection(sessionID: string, sel: SelectedRegime): void {
    if (!sel.provider) return
    if (!this.isRootSession(sessionID)) return
    const root = this.rootFor(sessionID)
    this.selected.set(root, sel)
    this.lastSelected = sel
  }

  overrideSelection(sel: SelectedRegime): void {
    if (!sel.provider) return
    if (this.latestRoot) this.selected.set(this.latestRoot, sel)
    this.lastSelected = sel
  }

  activeSelected(): SelectedRegime {
    if (this.latestRoot) {
      const sel = this.selected.get(this.latestRoot)
      if (sel?.provider) return sel
    }
    return this.lastSelected ?? {}
  }
}
