/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Show, For, createMemo, createSignal, onCleanup } from "solid-js"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ESTIMATE_PATH, type EstimateFile } from "./shared"

const POLL_INTERVAL_MS = 2_500
const SLOT_ORDER = 95

function loadEstimate(): EstimateFile | null {
  try {
    return JSON.parse(readFileSync(ESTIMATE_PATH, "utf8")) as EstimateFile
  } catch {
    return null
  }
}

function quotaRendersPrompt(api: Parameters<TuiPlugin>[0]): boolean {
  const quota = api.plugins
    .list()
    .find((p) => p.id.startsWith("@slkiser/opencode-quota") || p.id === "opencode-quota")
  if (!quota?.active) return false
  try {
    const sidecar = JSON.parse(
      readFileSync(join(api.state.path.config, "opencode-quota", "quota-toast.json"), "utf8"),
    ) as { tuiCompactStatus?: { enabled?: boolean; sessionPrompt?: boolean } }
    const compact = sidecar.tuiCompactStatus
    if (!compact) return false
    if (compact.enabled === false) return false
    return compact.sessionPrompt === true
  } catch {
    return false
  }
}

function compactFg(e: EstimateFile, api: Parameters<TuiPlugin>[0]) {
  const t = api.theme.current
  if (e.status !== "ready") return t.textMuted
  const safe = e.safe ?? 0
  if (e.calibration.usingPrior) return t.textMuted
  if (safe >= 5) return t.success
  if (safe >= 2) return t.warning
  return t.error
}

function StatusLine(props: { api: Parameters<TuiPlugin>[0]; estimate: EstimateFile | null }) {
  const theme = props.api.theme.current
  const text = () => props.estimate?.compact ?? ""
  const fg = () => (props.estimate ? compactFg(props.estimate, props.api) : theme.textMuted)
  return (
    <Show when={text().length > 0}>
      <box flexDirection="row" justifyContent="flex-end">
        <text fg={fg()} wrapMode="none">
          {text()}
        </text>
      </box>
    </Show>
  )
}

function PromptArea(props: {
  api: Parameters<TuiPlugin>[0]
  estimate: EstimateFile | null
  sessionID: string
  visible?: boolean
  disabled?: boolean
  on_submit?: () => void
  ref?: (ref: unknown) => void
}) {
  const quotaActive = createMemo(() => quotaRendersPrompt(props.api))
  return (
    <box gap={0}>
      <Show when={!quotaActive()}>
        <props.api.ui.Prompt
          sessionID={props.sessionID}
          visible={props.visible}
          disabled={props.disabled}
          onSubmit={props.on_submit}
          ref={props.ref}
        />
      </Show>
      <StatusLine api={props.api} estimate={props.estimate} />
    </box>
  )
}

function fmtPercent(v: number): string {
  return `${v.toFixed(1)}%`
}

function fmtCountdown(ms?: number): string {
  if (!ms) return "—"
  const s = Math.max(0, Math.floor((ms - Date.now()) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function DetailView(props: { api: Parameters<TuiPlugin>[0]; estimate: () => EstimateFile | null }) {
  const pop = props.api.mode.push("prompt-left.detail")
  onCleanup(pop)
  const theme = props.api.theme.current
  const lines = createMemo(() => {
    const e = props.estimate()
    const out: { text: string; fg: typeof theme.text }[] = []
    if (!e) {
      out.push({ text: "prompt-left: waiting for estimate…", fg: theme.textMuted })
      return out
    }
    const head = e.status === "ready" ? `≈${e.safe} similar prompts left` : e.compact
    out.push({ text: head, fg: theme.text })
    if (e.selected.provider) {
      const regime = [e.selected.model, e.selected.agent].filter(Boolean).join(" · ")
      out.push({ text: `tracking ${e.selected.provider}${regime ? ` · ${regime}` : ""}`, fg: theme.textMuted })
    }
    if (e.status === "ready" && e.likely !== null) {
      out.push({ text: `likely ${e.likely} · safe ${e.safe} · ${e.confidenceLabel} confidence (${(e.confidence * 100).toFixed(0)}%)`, fg: theme.textMuted })
    }
    out.push({ text: "", fg: theme.text })
    if (e.binding) {
      out.push({ text: `binding: ${e.binding.provider} · ${e.binding.window}`, fg: theme.text })
      out.push({ text: `  remaining ${fmtPercent(e.binding.remaining)} · burn ${e.binding.burnMean.toFixed(2)}pp/prompt (safe ${e.binding.burnSafe.toFixed(2)})`, fg: theme.textMuted })
      if (e.binding.resetAt) out.push({ text: `  resets in ${fmtCountdown(e.binding.resetAt)}`, fg: theme.textMuted })
    }
    out.push({ text: "", fg: theme.text })
    for (const p of e.perProvider) {
      out.push({ text: p.provider, fg: theme.text })
      for (const w of p.windows) {
        const label = w.prompts === null ? "unknown" : `≈${w.prompts} prompts`
        const reset = w.resetAt ? ` · reset ${fmtCountdown(w.resetAt)}` : ""
        out.push({ text: `  ${w.window}: ${fmtPercent(w.remaining)} → ${label}${reset}`, fg: theme.textMuted })
      }
    }
    if (e.context.usable !== null || e.context.untilCompaction !== null) {
      out.push({ text: "", fg: theme.text })
      out.push({ text: "context", fg: theme.text })
      if (e.context.usable !== null && e.context.current !== null) {
        out.push({ text: `  ${e.context.current} / ${e.context.usable} tokens`, fg: theme.textMuted })
      }
      if (e.context.untilCompaction !== null) {
        out.push({ text: `  compaction in ~${e.context.untilCompaction} similar turns`, fg: theme.textMuted })
      }
    }
    out.push({ text: "", fg: theme.text })
    out.push({ text: `calibration: ${e.calibration.regimeTurns} regime samples · ${e.calibration.rootTurns} root turns · quota age ${Math.round(e.calibration.quotaAgeSec)}s`, fg: theme.textMuted })
    if (e.calibration.usingPrior) out.push({ text: "cold-start prior estimate (1.5–2.5pp/prompt) — calibrates with use", fg: theme.warning })
    if (e.calibration.fallbackLevel > 0) out.push({ text: `using fallback burn model (level ${e.calibration.fallbackLevel})`, fg: theme.warning })
    if (e.calibration.externalShare > 0.15) out.push({ text: "external quota burn detected — confidence reduced", fg: theme.warning })
    return out
  })
  return (
    <box flexDirection="column" padding={1} gap={0}>
      <For each={lines()}>
        {(line) => <text fg={line.fg} wrapMode="none">{line.text}</text>}
      </For>
      <box height={1} />
      <text fg={theme.textMuted} wrapMode="none">esc closes</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  const [estimate, setEstimate] = createSignal<EstimateFile | null>(null)
  let last = ""

  const poll = () => {
    const next = loadEstimate()
    const serialized = next ? JSON.stringify(next) : ""
    if (serialized !== last) {
      last = serialized
      setEstimate(next)
    }
  }
  poll()
  const timer = setInterval(poll, POLL_INTERVAL_MS)
  api.lifecycle.onDispose(() => clearInterval(timer))

  api.slots.register({
    order: SLOT_ORDER,
    slots: {
      session_prompt(_ctx, props: { session_id: string; visible?: boolean; disabled?: boolean; on_submit?: () => void; ref?: (ref: unknown) => void }) {
        return (
          <PromptArea
            api={api}
            estimate={estimate()}
            sessionID={props.session_id}
            visible={props.visible}
            disabled={props.disabled}
            on_submit={props.on_submit}
            ref={props.ref}
          />
        )
      },
    },
  })

  api.keymap.registerLayer({
    mode: "base",
    commands: [
      {
        name: "prompt-left.detail.open",
        title: "Prompts left detail",
        category: "Plugin",
        namespace: "palette",
        slashName: "prompts-left",
        run() {
          api.route.navigate("prompt-left.detail")
        },
      },
    ],
  })

  api.keymap.registerLayer({
    mode: "prompt-left.detail",
    commands: [
      {
        name: "prompt-left.detail.close",
        title: "Close prompts left",
        run() {
          api.route.navigate("home")
        },
      },
    ],
    bindings: [{ key: "esc", cmd: "prompt-left.detail.close" }],
  })

  api.route.register([
    {
      name: "prompt-left.detail",
      render: () => <DetailView api={api} estimate={estimate} />,
    },
  ])
}

export default {
  id: "opencode-prompt-left",
  tui,
} satisfies TuiPluginModule & { id: string }
