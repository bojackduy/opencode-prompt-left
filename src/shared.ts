import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"

export const CACHE_BASE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode")

export const STATE_DIR = join(CACHE_BASE, "prompt-left")
export const QUOTA_EXPORT_PATH = join(CACHE_BASE, "quota-export.json")
export const QUOTA_STATE_DIR = join(CACHE_BASE, "quota-provider-state")

export function workspaceKey(root: string): string {
  return createHash("sha1").update(root).digest("hex").slice(0, 12)
}

export function statePaths(key: string) {
  const dir = join(STATE_DIR, key)
  return {
    dir,
    history: join(dir, "history.json"),
    estimate: join(dir, "estimate.json"),
    selection: join(dir, "selection.json"),
    active: join(dir, "active.json"),
  }
}

export interface ActiveFile {
  sessionID: string
  at: number
}

export interface TuiSelection {
  providerID: string
  modelID: string
  at: number
}

export interface PromptUsage {
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  cost: number
  toolCalls: number
  toolOutputChars: number
}

export function emptyUsage(): PromptUsage {
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

export interface RootPrompt {
  id: string
  rootSessionID: string
  startedAt: number
  finishedAt?: number
  agent?: string
  provider?: string
  model?: string
  contextBefore: number
  contextAfter?: number
  compacted: boolean
  compactionCost: number
  childSessions: number
  byProvider: Record<string, PromptUsage>
}

export interface QuotaEntry {
  provider: string
  name: string
  window?: string
  percentRemaining?: number
  resetAt?: number
  unlimited?: boolean
}

export interface QuotaSnapshot {
  at: number
  fromExport: boolean
  entries: QuotaEntry[]
}

export interface WindowObservation {
  at: number
  deltaPct: number
  localCost: number
}

export interface WindowTracker {
  lastPercent?: number
  lastPercentAt?: number
  observations: WindowObservation[]
}

export interface SelectedRegime {
  provider?: string
  model?: string
  agent?: string
}

export interface HistoryState {
  version: 2
  prompts: RootPrompt[]
  windows: Record<string, WindowTracker>
  lastSelected?: SelectedRegime
  lastContext?: number
  activeSession?: string
  externalShare: number
}

export function freshHistory(): HistoryState {
  return {
    version: 2,
    prompts: [],
    windows: {},
    externalShare: 0,
  }
}

export interface PromptForecast {
  sampleCount: number
  fallbackLevel: number
  cost: number
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  toolCalls: number
  toolOutputTokens: number
  childSessions: number
  contextGrowth: number
  compactionCost: number
  compactionRate: number
  costCv: number
}

export interface ContextEstimate {
  usable: number | null
  current: number | null
  growthPerTurn: number | null
  untilCompaction: number | null
}

export interface WindowEstimate {
  window: string
  remaining: number
  ratePP: number | null
  prompts: number | null
  resetAt?: number
}

export interface PerProviderEstimate {
  provider: string
  windows: WindowEstimate[]
}

export interface EstimateFile {
  at: number
  status: "ready" | "calibrating" | "no-quota"
  compact: string
  selected: SelectedRegime
  likely: number | null
  safe: number | null
  confidence: number
  confidenceLabel: "low" | "medium" | "high"
  binding: {
    provider: string
    window: string
    remaining: number
    burnPP: number | null
    resetAt?: number
  } | null
  perProvider: PerProviderEstimate[]
  forecast: PromptForecast | null
  context: ContextEstimate
  calibration: {
    prompts: number
    quotaAgeSec: number
    externalShare: number
    fallbackLevel: number
    usingPrior: boolean
    rateObs: number
  }
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, path)
}
