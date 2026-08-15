import { CONFIG_PATH, readJson } from "./shared"

// Built-in plan defaults. Sources:
// - opencode-go: official usage-limits docs ($12 / 5h, $30 / week, $60 / month)
// - copilot "Copilot": GitHub AI Credits, 1 credit = $0.01; Copilot Pro includes
//   1,500 credits/mo (1,000 base + 500 flex) = $15/mo
//   https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals
// - copilot "Copilot Premium Interactions": legacy premium-request allowance, 300/mo on Pro
// - openai (ChatGPT Pro weekly) and ollama-cloud (usage units) do NOT publish
//   absolute limits, so no defaults — configure via prompt-left.json
export const DEFAULT_BUDGETS: Record<string, Record<string, number>> = {
  "opencode-go": { "5h": 12, Weekly: 30, Monthly: 60 },
  copilot: { Copilot: 15 },
}

export const DEFAULT_LIMITS: Record<string, Record<string, number>> = {
  copilot: { "Copilot Premium Interactions": 300 },
}

export interface PlansConfig {
  budgets?: Record<string, Record<string, number>>
  limits?: Record<string, Record<string, number>>
  tokenLimits?: Record<string, Record<string, number>>
}

export interface Plans {
  budgets: Record<string, Record<string, number>>
  limits: Record<string, Record<string, number>>
  tokenLimits: Record<string, Record<string, number>>
}

function merge(defaults: Record<string, Record<string, number>>, overrides?: Record<string, Record<string, number>>) {
  const out: Record<string, Record<string, number>> = {}
  for (const [provider, windows] of Object.entries(defaults)) {
    out[provider] = { ...windows }
  }
  for (const [provider, windows] of Object.entries(overrides ?? {})) {
    out[provider] = { ...(out[provider] ?? {}), ...windows }
  }
  return out
}

export function loadPlans(path = CONFIG_PATH): Plans {
  const cfg = readJson<PlansConfig>(path)
  return {
    budgets: merge(DEFAULT_BUDGETS, cfg?.budgets),
    limits: merge(DEFAULT_LIMITS, cfg?.limits),
    tokenLimits: merge({}, cfg?.tokenLimits),
  }
}

export function loadBudgets(path = CONFIG_PATH): Record<string, Record<string, number>> {
  return loadPlans(path).budgets
}
