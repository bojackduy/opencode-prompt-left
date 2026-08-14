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

plan budget per window     = known dollar limits (OpenCode Go: $12/5h, $30/week,
                             $60/month — overridable in prompt-left.json)

prompts left               = (budget × remaining%) ÷ predicted cost per prompt
```

For providers with known plan budgets the estimate is **exact** — it converts
the reported remaining percentage into remaining dollars and divides by your
real per-prompt cost. For other providers it falls back to observed
quota-per-dollar rates (`Δpercent ÷ local cost`), then to a prior.

Per-window resolution order: **plan budget → quota-rate observations → prior**.
The binding window is the one with the fewest prompts left (e.g. Weekly usually
binds over 5h).

- A **root prompt** is one top-level user message, including everything it spawned: tool loops, retries, child/subagent sessions, and compaction.
- Workload comes from OpenCode's exact `step-finish` usage records (per-request tokens and cost), deduplicated — not cumulative message snapshots.
- Each quota window (5h / Weekly / Monthly) has its own rate. Rates are computed only from percentage changes that coincide with local usage; zero-delta polls keep accumulating cost so unchanged percentages are never miscounted as free prompts.
- Compaction: the trigger threshold mirrors OpenCode's own overflow check (`context tokens ≥ usable`), and post-compaction context is modeled as summary + ~25% retained tail (2k–15k tokens).
- The compact line shows the **best estimate**; the detail view also shows a conservative bound, confidence, and the full forecast breakdown.

## Status

| Compact line | Meaning |
|---|---|
| `opencode-go/deepseek-v4-flash ≈54 prompts · Weekly` | plan-budget estimate (real per-prompt cost ÷ remaining dollars), green/yellow/red by capacity |
| `opencode-go/deepseek-v4-flash $1.20 left · Weekly` | budget known but no usage history yet — exact dollars, count appears after a few prompts |
| `≈2 prompts · Weekly` (low confidence) | prior estimate — no budget config and no observations |
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

## Model and provider tracking

The estimate follows the **session you're currently viewing**, not a global "current model":

| Signal | How it works |
|---|---|
| Active session | The TUI plugin writes `active.json` with the session it renders; the server resolves selection, context, and calibration against it — switching sessions recomputes instantly |
| Prompt submit | `chat.message` records the real per-prompt model/provider/agent per session |
| Model picker bridge | `model.json` `recent[0]` → `selection.json` → applied to the **active** session |
| Model catalog | `client.provider.list()` — real names + context limits + pricing for every model (including auto-detected providers like `opencode-go`) |
| Persisted | last active session + selection survive restarts |

## Multi-directory isolation

opencode-prompt-left runs one plugin instance per opencode process, and every instance (one per project directory, even simultaneously) keeps its own state:

```
$XDG_CACHE_HOME/opencode/prompt-left/<workspace-hash>/
  history.json      prompt usage + quota-rate observations for THIS directory
  estimate.json     the current estimate for THIS directory
  selection.json    model-picker bridge for THIS directory
  active.json       which session is open in THIS directory
```

The workspace hash is derived from the project directory, so:

- Running several directories **at the same time** never races on shared files — no cross-talk, no flicker.
- Each directory calibrates its own workload and quota rates (cold-starts per directory; that's the price of accuracy).
- Sessions with different models inside one directory each keep their own selection, and the estimate follows whichever one you have open.

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

Restart OpenCode. State persists per project directory at `$XDG_CACHE_HOME/opencode/prompt-left/<workspace-hash>/`:

- `history.json` — root-prompt usage telemetry and per-window quota-rate observations (survives restarts)
- `estimate.json` — the current estimate, consumed by the TUI

## Plan budgets

`~/.config/opencode/prompt-left.json` overrides plan budgets (defaults apply without the file):

```jsonc
{
  "budgets": {
    "opencode-go": { "5h": 12, "Weekly": 30, "Monthly": 60 }
  }
}
```

Defaults (from the OpenCode Go plan docs): `opencode-go` → $12 / 5h, $30 / week, $60 / month. Add entries for other providers to give them the same exact-dollar treatment. The file is watched — edits apply on the next recompute.

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
