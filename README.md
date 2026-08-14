# opencode-prompt-left

Estimates how many **similar prompts** remain before your provider quota runs out, shown right in the OpenCode compact line (next to the prompt box).

```
≈6 prompts · Weekly            ← compact line (safe estimate)
```

The number is not a token guess. It is `quota remaining ÷ observed quota burn per root prompt`, calibrated from real quota deltas reported by [opencode-quota](https://github.com/slkiser/opencode-quota) and OpenCode's per-message token/cache/tool/child-session telemetry.

## Core formula

```
prompts left ≈ floor( percentRemaining / P90(burn per similar root prompt) )
```

- A **root prompt** is one top-level user message, including everything it spawned: steps, tool calls, retries, compaction, and child/subagent sessions.
- **Burn** is quota percentage points actually consumed, attributed across root prompts by their relative workload (tokens, cache read/write, requests).
- The **safe** estimate uses a one-sided ~90th-percentile bound on recent burn; the likely estimate uses the mean.
- The binding constraint is the minimum across the selected provider's quota windows (e.g. 5h wins over weekly).
- Model/provider/agent switches recompute immediately using that regime's own burn history, with a fallback hierarchy (`provider|model|agent → provider|model → provider → global`) and a confidence penalty for each fallback step.
- Confidence combines sample coverage, quota freshness, attribution purity (external burn detection), and workload stability.

## Status

| Compact line | Meaning |
|---|---|
| `≈6 prompts · Weekly` | calibrated estimate, green/yellow/red by remaining capacity |
| `86% · calibrating` | quota known, burn rate not yet measured (cold start) |
| `no quota` | no usable quota export found |

`/prompts-left` opens a full breakdown: likely/safe counts, binding window + reset countdown, per-provider windows, context/compaction estimate, and calibration stats.

## Requirements

- [opencode-quota](https://github.com/slkiser/opencode-quota) installed and refreshing (TUI compact/sidebar or toasts enabled).
- Quota source (either works):
  - `opencode-quota` export file: set `export.enabled: true` in `opencode-quota/quota-toast.json`, or
  - the provider cache at `$XDG_CACHE_HOME/opencode/quota-provider-state/*.json` (read automatically, no config needed).

## Install

```jsonc
// opencode.jsonc
{
  "plugin": ["/path/to/opencode-prompt-left/src/server.ts"]
}
```

```jsonc
// tui.json
{
  "plugin": ["/path/to/opencode-prompt-left/src/tui.tsx"]
}
```

Restart OpenCode. State persists at `$XDG_CACHE_HOME/opencode/prompt-left/`:

- `history.json` — root-turn telemetry and calibrated burn samples (survives restarts)
- `estimate.json` — the current estimate, consumed by the TUI

## Development

```sh
bun install
bunx tsc --noEmit
bun test
```

## Notes and limitations

- Estimates are statistical. "≈N similar prompts" means *if you keep prompting like your recent root prompts do*.
- Quota observations arrive at opencode-quota's refresh interval (~5 min), so burn attribution happens per observation interval, not per prompt.
- Quota used by other machines/windows is detected as external burn and lowers confidence.
- A window can reset before you exhaust it at your pace; the detail view shows reset countdowns.
