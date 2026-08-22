import { CONFIG_PATH, readJson } from "./shared"
import type { PricingConfig, PricingOverride } from "./shared"

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
  "opencode": { "5h": 12, Weekly: 30, Monthly: 60 },
  zen: { "5h": 12, Weekly: 30, Monthly: 60 },
  "muse-spark": { "5h": 12, Weekly: 30, Monthly: 60 },
  muse: { "5h": 12, Weekly: 30, Monthly: 60 },
  ox: { "5h": 12, Weekly: 30, Monthly: 60 },
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

export const DEFAULT_PRICING_OVERRIDES: Record<string, Record<string, PricingOverride>> = {
  "opencode-go": {
    "muse-spark-1.2-contributor": { input: 0.5, output: 2, cacheRead: 0.05 },
    "muse-spark-1-2-contributor": { input: 0.5, output: 2, cacheRead: 0.05 },
    "ox-alpha": { input: 0.5, output: 2, cacheRead: 0.05 },
    "ox_alpha": { input: 0.5, output: 2, cacheRead: 0.05 },
  },
  "opencode": {
    "muse-spark-1.2-contributor": { input: 0.5, output: 2, cacheRead: 0.05 },
    "ox-alpha": { input: 0.5, output: 2, cacheRead: 0.05 },
  },
}

export interface Plans {
  budgets: Record<string, Record<string, number>>
  limits: Record<string, Record<string, number>>
  tokenLimits: Record<string, Record<string, number>>
  pricingOverrides: Record<string, Record<string, PricingOverride>>
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

function mergePricing(
  defaults: Record<string, Record<string, PricingOverride>>,
  overrides?: Record<string, Record<string, PricingOverride>>,
): Record<string, Record<string, PricingOverride>> {
  const out: Record<string, Record<string, PricingOverride>> = {}
  for (const [p, ms] of Object.entries(defaults)) out[p] = { ...ms }
  for (const [p, ms] of Object.entries(overrides ?? {})) out[p] = { ...(out[p] ?? {}), ...ms }
  return out
}

export function loadPlans(path = CONFIG_PATH): Plans {
  const cfg = readJson<PricingConfig>(path)
  return {
    budgets: merge(DEFAULT_BUDGETS, cfg?.budgets),
    limits: merge(DEFAULT_LIMITS, cfg?.limits),
    tokenLimits: merge({}, cfg?.tokenLimits),
    pricingOverrides: mergePricing(DEFAULT_PRICING_OVERRIDES, cfg?.pricingOverrides),
  }
}

export function loadBudgets(path = CONFIG_PATH): Record<string, Record<string, number>> {
  return loadPlans(path).budgets
}
