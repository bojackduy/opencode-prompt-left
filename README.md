# opencode-prompt-left

Estimates how many **similar prompts** remain before your provider quota runs out, shown in the OpenCode compact line (next to the prompt box).

```
≈14 prompts · Weekly            ← compact line (best estimate)
```

The number is a forward forecast of your own usage: recent per-prompt workload (cost, requests, tokens in/out, cache read/write, tool calls, subagents), projected against the current context/compaction state, then converted to quota burn using the observed percentage-per-dollar rate of each quota window.

## Core formula

```
predicted cost per prompt  = recency-weighted EWMA of recent root-prompt costs
                             (cost, requests, tokens in/out/reasoning, cache r/w,
                              tool calls, tool output, child sessions)

quota rate per window      = observed Δpercent / local OpenCode cost spent
                             since that window last changed (per window!)

burn per prompt            = predicted cost × quota rate

prompts left               = simulate prompts forward:
                             context grows per prompt → compaction resets it to
                             summary+tail and adds compaction cost → repeat
                             until any quota window hits zero
```

- A **root prompt** is one top-level user message, including everything it spawned: tool loops, retries, child/subagent sessions, and compaction.
- Workload comes from OpenCode's exact `step-finish` usage records (per-request tokens and cost), deduplicated — not cumulative message snapshots.
- Each quota window (5h / Weekly / Monthly) has its own rate. Rates are computed only from percentage changes that coincide with local usage; zero-delta polls keep accumulating cost so unchanged percentages are never miscounted as free prompts.
- Compaction: the trigger threshold mirrors OpenCode's own overflow check (`context tokens ≥ usable`), and post-compaction context is modeled as summary + ~25% retained tail (2k–15k tokens).
- The compact line shows the **best estimate**; the detail view also shows a conservative bound, confidence, and the full forecast breakdown.

## Status

| Compact line | Meaning |
|---|---|
| `≈14 prompts · Weekly` | calibrated forecast, green/yellow/red by remaining capacity |
| `7% left · Weekly` | cost forecast ready, waiting for quota-rate observations — calibrating |
| `≈4 prompts · Monthly` (muted) | cold-start prior (1.5–2.5pp/prompt) — no usage history yet, low confidence |
| `no quota` | no usable quota export found |

`/prompts-left` opens the full breakdown: best/safe counts, binding window + reset countdown, per-provider windows, forecast per prompt (cost, requests, tools, cache), context/compaction horizon, and calibration stats.

## Model-switch hot update

opencode never publishes a "model changed" event — the selection lives in the TUI's in-memory store and reaches the server only at prompt-submit. prompt-left works around that with a file bridge:

```
model picker → TUI writes ~/.local/share/opencode/model.json (recent[0] = selection)
             → prompt-left TUI plugin watches it → writes …/opencode/prompt-left/selection.json
             → prompt-left server plugin watches it → recomputes immediately
```

| Switch method | Hot update |
|---|---|
| Model picker (enter, or any `set(…, { recent: true })`) | ✅ instant, no prompt needed |
| Favorite model cycle (`model.cycle_favorite`) | ✅ instant (it also saves `recent`) |
| Tab cycle (`model.cycle_recent`) | ⚠️ at prompt-submit — the TUI writes nothing for this one, so there is nothing to observe |
| Prompt submit | ✅ always (server `chat.message` hook) |

## Coexisting with opencode-quota

prompt-left renders its line at the bottom, directly below opencode-quota's compact line — no quota configuration or patches needed:

```
[ prompt input box        ]
Copilot 94% | OpenAI 5h 100%   ← opencode-quota
≈14 prompts · Weekly           ← prompt-left
```

- If opencode-quota owns the prompt bar (`tuiCompactStatus.sessionPrompt: true`), prompt-left appends only its line below quota's.
- If quota's session prompt is disabled, prompt-left renders the prompt bar itself and keeps its line below it.

Either way both plugins stay fully enabled.

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

- `history.json` — root-prompt usage telemetry and per-window quota-rate observations (survives restarts)
- `estimate.json` — the current estimate, consumed by the TUI

## Development

```sh
bun install
bunx tsc --noEmit
bun test
```

## Notes and limitations

- Estimates are statistical. "≈N similar prompts" means *if you keep prompting like your recent root prompts do, in the current context state*.
- Quota-rate calibration needs at least one observable percentage change on the selected provider's windows; until then the compact line shows the remaining percentage and the forecast cost.
- Quota observations arrive at opencode-quota's refresh interval (~5 min), so rate observations are per interval, not per prompt.
- Quota used by other machines/windows is detected as external burn and lowers confidence.
- A window can reset before you exhaust it at your pace; the detail view shows reset countdowns.
