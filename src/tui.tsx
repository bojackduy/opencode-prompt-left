/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { Show, For, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { readFileSync, watch, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { statePaths, workspaceKey, type ActiveFile, type EstimateFile, type TuiSelection } from "./shared"

const POLL_INTERVAL_MS = 2_500
const SLOT_ORDER = 95
const SELECTION_DEBOUNCE_MS = 300
const ACTIVE_WRITE_MS = 2_500
const MODEL_POLL_INTERVAL_MS = 5_000

const paths = statePaths(workspaceKey(process.cwd()))

function loadEstimate(): EstimateFile | null {
  try {
    return JSON.parse(readFileSync(paths.estimate, "utf8")) as EstimateFile
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

function writeSelection(path: string, model: { providerID: string; modelID: string }, last: { value: string }): void {
  const sel: TuiSelection = { providerID: model.providerID, modelID: model.modelID, at: Date.now() }
  writeAtomic(path, sel, last)
}

function writeActive(path: string, sessionID: string, last: { value: string }, model?: { providerID: string; modelID: string }, agent?: string): void {
  const active: ActiveFile = { sessionID, at: Date.now(), model, agent }
  writeAtomic(path, active, last)
}

function writeAtomic(path: string, value: unknown, last: { value: string }): void {
  const serialized = JSON.stringify(value)
  if (serialized === last.value) return
  last.value = serialized
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, serialized)
    renameSync(tmp, path)
  } catch {}
}

function readRecentModel(path: string): { providerID: string; modelID: string } | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      recent?: { providerID?: string; modelID?: string }[]
    }
    const first = raw.recent?.[0]
    if (first?.providerID && first?.modelID) return { providerID: first.providerID, modelID: first.modelID }
  } catch {}
  return null
}

function watchModelSelection(api: Parameters<TuiPlugin>[0]): () => void {
  const modelPath = join(api.state.path.state, "model.json")
  const last = { value: "" }
  const push = () => {
    const model = readRecentModel(modelPath)
    if (model) writeSelection(paths.selection, model, last)
  }
  push()
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: ReturnType<typeof watch> | undefined
  const poll = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      push()
    }, SELECTION_DEBOUNCE_MS)
  }
  try {
    watcher = watch(api.state.path.state, () => poll())
  } catch {}
  const pollTimer = setInterval(poll, MODEL_POLL_INTERVAL_MS)
  return () => {
    if (timer) clearTimeout(timer)
    clearInterval(pollTimer)
    watcher?.close()
  }
}

function compactFg(e: EstimateFile, api: Parameters<TuiPlugin>[0]) {
  const t = api.theme.current
  if (e.status !== "ready") return t.textMuted
  const n = e.likely ?? 0
  if (n >= 5) return t.success
  if (n >= 2) return t.warning
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

function activeModel(api: Parameters<TuiPlugin>[0], sessionID: string): { providerID: string; modelID: string } | undefined {
  try {
    const messages = api.state.session.messages(sessionID)
    const last = messages.at(-1)
    if (!last) return undefined
    if (last.role === "user" && last.model?.providerID && last.model?.modelID) {
      return { providerID: last.model.providerID, modelID: last.model.modelID }
    }
    if (last.role === "assistant" && last.providerID && last.modelID) {
      return { providerID: last.providerID, modelID: last.modelID }
    }
  } catch {}
  return undefined
}

function activeAgent(api: Parameters<TuiPlugin>[0], sessionID: string): string | undefined {
  try {
    const messages = api.state.session.messages(sessionID)
    const last = messages.at(-1)
    if (!last) return undefined
    if (last.role === "user") return last.agent
    return last.mode
  } catch {}
  return undefined
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
  const activeLast = { value: "" }
  const writeActiveNow = () =>
    writeActive(
      paths.active,
      props.sessionID,
      activeLast,
      activeModel(props.api, props.sessionID),
      activeAgent(props.api, props.sessionID),
    )
  onMount(() => {
    writeActiveNow()
    const timer = setInterval(writeActiveNow, ACTIVE_WRITE_MS)
    onCleanup(() => clearInterval(timer))
  })
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
    const head = e.status === "ready" && e.likely !== null ? `≈${e.likely} similar prompts left` : e.compact
    out.push({ text: head, fg: theme.text })
    if (e.selected.provider) {
      const regime = [e.selected.model, e.selected.agent].filter(Boolean).join(" · ")
      out.push({ text: `tracking ${e.selected.provider}${regime ? ` · ${regime}` : ""}`, fg: theme.textMuted })
    }
    if (e.status === "ready" && e.likely !== null) {
      const safe = e.safe !== null ? ` · safe ${e.safe}` : ""
      out.push({ text: `best ${e.likely}${safe} · ${e.confidenceLabel} confidence (${(e.confidence * 100).toFixed(0)}%)`, fg: theme.textMuted })
    }
    out.push({ text: "", fg: theme.text })
    if (e.binding) {
      out.push({ text: `binding: ${e.binding.provider} · ${e.binding.window}`, fg: theme.text })
      const burn = e.binding.burnPP !== null ? ` · burn ${e.binding.burnPP.toFixed(2)}pp/prompt` : ""
      out.push({ text: `  remaining ${fmtPercent(e.binding.remaining)}${burn}`, fg: theme.textMuted })
      if (e.binding.method === "budget" && e.binding.budget) {
        const cost = e.forecast?.cost ?? 0
        const costLine = cost > 0 ? ` · $${cost.toFixed(4)}/prompt` : ""
        out.push({ text: `  plan budget $${e.binding.budget} · $${(e.binding.remainingUSD ?? 0).toFixed(2)} left${costLine}`, fg: theme.textMuted })
      }
      if (e.binding.resetAt) out.push({ text: `  resets in ${fmtCountdown(e.binding.resetAt)}`, fg: theme.textMuted })
    }
    out.push({ text: "", fg: theme.text })
    for (const p of e.perProvider) {
      out.push({ text: p.provider, fg: theme.text })
      for (const w of p.windows) {
        const label = w.prompts === null ? `${fmtPercent(w.remaining)} left` : `≈${w.prompts} prompts`
        const reset = w.resetAt ? ` · reset ${fmtCountdown(w.resetAt)}` : ""
        out.push({ text: `  ${w.window}: ${fmtPercent(w.remaining)} → ${label}${reset}`, fg: theme.textMuted })
      }
    }
    if (e.forecast) {
      out.push({ text: "", fg: theme.text })
      out.push({ text: "forecast per prompt", fg: theme.text })
      const f = e.forecast
      const cache = f.cacheRead > 0 || f.cacheWrite > 0
        ? ` · cache r${(f.cacheRead / 1000).toFixed(0)}k/w${(f.cacheWrite / 1000).toFixed(0)}k`
        : ""
      out.push({ text: `  cost $${f.cost.toFixed(3)} · ${f.requests.toFixed(1)} requests · ${f.toolCalls.toFixed(1)} tools · ${f.childSessions.toFixed(1)} subagents`, fg: theme.textMuted })
      out.push({ text: `  in ${(f.input / 1000).toFixed(0)}k +${(f.output / 1000).toFixed(0)}k out +${(f.reasoning / 1000).toFixed(0)}k think${cache}`, fg: theme.textMuted })
      if (f.compactionRate > 0) {
        out.push({ text: `  compaction in ~${f.compactionRate >= 1 ? 1 : Math.round(1 / f.compactionRate)} prompts · cost $${f.compactionCost.toFixed(3)}`, fg: theme.textMuted })
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
    out.push({ text: `calibration: ${e.forecast?.sampleCount ?? 0} prompt samples · ${e.calibration.rateObs} quota obs · quota age ${Math.round(e.calibration.quotaAgeSec)}s`, fg: theme.textMuted })
    if (e.calibration.usingPrior) out.push({ text: "cold-start prior estimate (1.5–2.5pp/prompt) — calibrates with use", fg: theme.warning })
    if (e.calibration.fallbackLevel > 0) out.push({ text: `using fallback workload model (level ${e.calibration.fallbackLevel})`, fg: theme.warning })
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

  const stopModelWatch = watchModelSelection(api)
  api.lifecycle.onDispose(stopModelWatch)

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
