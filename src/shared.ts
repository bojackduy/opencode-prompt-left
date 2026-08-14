import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"

export const CACHE_BASE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "opencode")

export const STATE_DIR = join(CACHE_BASE, "prompt-left")
export const HISTORY_PATH = join(STATE_DIR, "history.json")
export const ESTIMATE_PATH = join(STATE_DIR, "estimate.json")
export const QUOTA_EXPORT_PATH = join(CACHE_BASE, "quota-export.json")
export const QUOTA_STATE_DIR = join(CACHE_BASE, "quota-provider-state")

export interface ProviderTotals {
  requests: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  toolCalls: number
}

export interface RootTurn {
  rootSessionID: string
  rootMessageID: string
  startedAt: number
  finishedAt?: number
  agent?: string
  provider?: string
  model?: string
  contextBefore: number
  contextAfter?: number
  byProvider: Record<string, ProviderTotals>
  childSessions: number
  compactedSessions: number
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

export interface BurnSample {
  at: number
  burn: number
}

export interface SelectedRegime {
  provider?: string
  model?: string
  agent?: string
}

export interface HistoryState {
  version: 1
  turns: RootTurn[]
  regimeSamples: Record<string, BurnSample[]>
  lastQuotaSeen: Record<string, number>
  lastObsAt: Record<string, number>
  externalShare: number
  lastSelected?: SelectedRegime
}

export interface ContextEstimate {
  usable: number | null
  current: number | null
  growthPerTurn: number | null
  untilCompaction: number | null
}

export interface PerProviderEstimate {
  provider: string
  windows: {
    window: string
    remaining: number
    prompts: number | null
    resetAt?: number
  }[]
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
    burnMean: number
    burnSafe: number
    resetAt?: number
  } | null
  perProvider: PerProviderEstimate[]
  context: ContextEstimate
  calibration: {
    rootTurns: number
    regimeTurns: number
    quotaAgeSec: number
    externalShare: number
    fallbackLevel: number
    usingPrior: boolean
  }
}

export function emptyTotals(): ProviderTotals {
  return { requests: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, toolCalls: 0 }
}

export function freshHistory(): HistoryState {
  return {
    version: 1,
    turns: [],
    regimeSamples: {},
    lastQuotaSeen: {},
    lastObsAt: {},
    externalShare: 0,
  }
}

export function totalTokens(input: {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}): number {
  return input.input + input.output + input.reasoning + input.cache.read + input.cache.write
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
