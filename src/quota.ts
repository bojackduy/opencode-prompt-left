import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { QuotaEntry, QuotaSnapshot } from "./shared"
import { QUOTA_EXPORT_PATH, QUOTA_STATE_DIR, readJson } from "./shared"

interface ExportFile {
  version?: number
  exportedAt?: number
  providers?: Record<
    string,
    {
      status?: string
      fetchedAt?: number
      entries?: {
        name: string
        window?: string
        percentRemaining?: number
        resetAt?: number
        unlimited?: boolean
      }[]
    }
  >
}

interface ProviderStateFile {
  version?: number
  packageVersion?: string
  providerId?: string
  timestamp?: number
  result?: {
    entries?: {
      name?: string
      group?: string
      percentRemaining?: number
      resetTimeIso?: string
      unlimited?: boolean
    }[]
  }
}

function windowFromName(name: string, group?: string): string | undefined {
  if (group && name.startsWith(group)) {
    const rest = name.slice(group.length).trim()
    if (rest) return rest
  }
  return name.includes(" ") ? name : undefined
}

function versionOf(raw: ProviderStateFile | null): number {
  if (!raw?.packageVersion) return 0
  const parts = raw.packageVersion.split(".").map((x) => {
    const n = Number.parseInt(x, 10)
    return Number.isFinite(n) ? n : 0
  })
  return (parts[0] ?? 0) * 1_000_000 + (parts[1] ?? 0) * 1_000 + (parts[2] ?? 0)
}

export function readQuotaExportFile(path: string): QuotaSnapshot | null {
  const raw = readJson<ExportFile>(path)
  if (!raw?.providers) return null
  const entries: QuotaEntry[] = []
  for (const [provider, p] of Object.entries(raw.providers)) {
    if (p.status !== "ok" || !p.entries) continue
    for (const e of p.entries) {
      if (e.unlimited) continue
      if (typeof e.percentRemaining !== "number") continue
      entries.push({
        provider,
        name: e.name,
        window: e.window ?? windowFromName(e.name),
        percentRemaining: e.percentRemaining,
        resetAt: typeof e.resetAt === "number" ? e.resetAt * 1000 : undefined,
      })
    }
  }
  if (entries.length === 0) return null
  return { at: (raw.exportedAt ?? 0) * 1000, fromExport: true, entries }
}

export function readProviderStateDir(dir: string): QuotaSnapshot | null {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return null
  }
  const best = new Map<string, { raw: ProviderStateFile; version: number }>()
  for (const file of files) {
    const raw = readJson<ProviderStateFile>(join(dir, file))
    if (!raw?.providerId) continue
    const version = versionOf(raw)
    const existing = best.get(raw.providerId)
    if (
      existing &&
      ((raw.timestamp ?? 0) < (existing.raw.timestamp ?? 0) ||
        ((raw.timestamp ?? 0) === (existing.raw.timestamp ?? 0) && version < existing.version))
    ) {
      continue
    }
    best.set(raw.providerId, { raw, version })
  }
  const entries: QuotaEntry[] = []
  const seen = new Set<string>()
  let latest = 0
  for (const { raw } of best.values()) {
    const providerId = raw.providerId!
    for (const e of raw.result?.entries ?? []) {
      if (e.unlimited) continue
      if (typeof e.percentRemaining !== "number" || !Number.isFinite(e.percentRemaining)) continue
      const name = e.name ?? providerId
      const dedupeKey = `${providerId}::${name}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      entries.push({
        provider: providerId,
        name,
        window: windowFromName(name, e.group),
        percentRemaining: e.percentRemaining,
        resetAt: e.resetTimeIso ? Date.parse(e.resetTimeIso) : undefined,
      })
    }
    if (raw.timestamp) latest = Math.max(latest, raw.timestamp)
  }
  if (entries.length === 0) return null
  return { at: latest, fromExport: false, entries }
}

export function readQuotaSnapshot(): QuotaSnapshot | null {
  return (
    readQuotaExportFile(QUOTA_EXPORT_PATH) ?? readProviderStateDir(QUOTA_STATE_DIR)
  )
}
