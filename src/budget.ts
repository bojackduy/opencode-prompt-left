import { CONFIG_PATH, readJson } from "./shared"

export const DEFAULT_BUDGETS: Record<string, Record<string, number>> = {
  "opencode-go": { "5h": 12, Weekly: 30, Monthly: 60 },
}

export interface BudgetConfig {
  budgets?: Record<string, Record<string, number>>
}

export function loadBudgets(path = CONFIG_PATH): Record<string, Record<string, number>> {
  const cfg = readJson<BudgetConfig>(path)
  const out: Record<string, Record<string, number>> = {}
  for (const [provider, windows] of Object.entries(DEFAULT_BUDGETS)) {
    out[provider] = { ...windows }
  }
  for (const [provider, windows] of Object.entries(cfg?.budgets ?? {})) {
    out[provider] = { ...(out[provider] ?? {}), ...windows }
  }
  return out
}
