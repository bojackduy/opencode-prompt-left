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
| `≈4 prompts · Monthly` (muted) | cold-start prior (1.5–2.5pp/prompt) — no burn samples yet, low confidence |
| `no quota` | no usable quota export found |

`/prompts-left` opens a full breakdown: likely/safe counts, binding window + reset countdown, per-provider windows, context/compaction estimate, and calibration stats.

## Coexisting with opencode-quota

Both lines are visible at the same time:

- opencode-quota keeps its prompt bar + its own compact line (sessionPrompt stays `true`).
- prompt-left renders inline at the right of the prompt input via the `session_prompt_right` slot.

This requires a one-line patch to opencode-quota (it replaces the host prompt bar, which is where the right-slot lives). The patched local build is loaded instead of the npm package:

```diff
// ~/Code/opencode-quota/src/tui.tsx — SessionPromptWithCompactStatus
  <props.api.ui.Prompt
    sessionID={props.sessionID}
    visible={props.visible}
    disabled={props.disabled}
    onSubmit={props.onSubmit}
    ref={props.promptRef}
+   right={<props.api.ui.Slot name="session_prompt_right" session_id={props.sessionID} />}
  />
```

plus the matching `ui.Slot` entry in `src/types/tui-runtime-shims.d.ts`, then `pnpm install && pnpm run build`, and:

```jsonc
// tui.json
{ "plugin": ["/Users/duytrinh/Code/opencode-quota/"] }
// opencode.jsonc
{ "plugin": ["/Users/duytrinh/Code/opencode-quota/"] }
```

Without the patch, quota's replacement bar discards the right-slot and the line only appears when `sessionPrompt` is `false`.

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
