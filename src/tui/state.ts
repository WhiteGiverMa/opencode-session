import type { Plugin } from "@opencode/plugin/tui"
import type { Store } from "solid-js/store"
import {
  META_KEY_SESSION,
  PLUGIN_ID,
  type HubItem,
  type O3pSessionMeta,
} from "../contract.ts"

export type SessionInfo = NonNullable<ReturnType<Plugin.Context["data"]["session"]["get"]>>
export type SessionMessage = ReturnType<Plugin.Context["data"]["session"]["message"]["list"]>[number]
export type SessionRoute = Extract<ReturnType<Plugin.Context["ui"]["router"]["current"]>, { type: "session" }>
export type HostEvent = Parameters<Parameters<Plugin.Context["data"]["listen"]>[0]>[0]["details"]

export interface ComposerRequest {
  rootSessionID: string
  kind: "btw" | "sub"
  agentID?: string
  nonce: number
}

export interface NativeViewReturn {
  rootSessionID: string
  selectedID: string
}

/** Hot-reload-safe TUI state. No conversation content is owned by this store. */
export interface TuiMemoryState {
  selectedByRoot: Record<string, string>
  drafts: Record<string, string>
  scrollOffsets: Record<string, number>
  composer: ComposerRequest | null
  nativeReturn: NativeViewReturn | null
}

export type UpdateTuiMemory = (mutation: (draft: TuiMemoryState) => void) => void
export type TuiMemory = readonly [Store<TuiMemoryState>, UpdateTuiMemory]

export function createInitialMemoryState(): TuiMemoryState {
  return {
    selectedByRoot: {},
    drafts: {},
    scrollOffsets: {},
    composer: null,
    nativeReturn: null,
  }
}

export function createTuiMemory(context: Plugin.Context): TuiMemory {
  return context.storage.memory<TuiMemoryState>(`${PLUGIN_ID}.tui`, {
    initial: createInitialMemoryState(),
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Validate untrusted persisted metadata instead of casting Json/unknown. */
export function readO3pSessionMeta(metadata: unknown): O3pSessionMeta | undefined {
  if (!isRecord(metadata)) return undefined
  const value = metadata[META_KEY_SESSION]
  if (!isRecord(value)) return undefined
  if (
    value.version !== 1 ||
    typeof value.rootSessionID !== "string" ||
    (value.kind !== "btw" && value.kind !== "sub") ||
    typeof value.readonly !== "boolean" ||
    typeof value.hidden !== "boolean" ||
    typeof value.label !== "string" ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    return undefined
  }
  return {
    version: 1,
    rootSessionID: value.rootSessionID,
    kind: value.kind,
    readonly: value.readonly,
    hidden: value.hidden,
    label: value.label,
    createdAt: value.createdAt,
  }
}

export function rootSessionIDFor(
  session: Pick<SessionInfo, "id" | "metadata"> | undefined,
  fallback: string | (() => string),
): string {
  const fromMetadata = readO3pSessionMeta(session?.metadata)?.rootSessionID
  if (fromMetadata) return fromMetadata
  return typeof fallback === "function" ? fallback() : fallback
}

export function parseBtwArguments(input?: string): string {
  return input?.trim() ?? ""
}

export interface SubagentChoice {
  readonly id: string
  readonly mode: "subagent" | "primary" | "all"
  readonly hidden?: boolean
}

export interface SubArguments {
  readonly agentID: string
  readonly task: string
  readonly explicitAgent: boolean
}

export function availableSubagents(agents: readonly SubagentChoice[]): readonly SubagentChoice[] {
  return agents.filter((agent) => agent.mode !== "primary" && agent.hidden !== true)
}

export function defaultSubagent(agents: readonly SubagentChoice[]): string {
  const available = availableSubagents(agents)
  if (available.some((agent) => agent.id === "explore")) return "explore"
  if (available.some((agent) => agent.id === "general")) return "general"
  return available[0]?.id ?? "explore"
}

/** Accepts `@explore task`, `explore task`, or an implicit-agent task. */
export function parseSubArguments(input: string | undefined, agents: readonly SubagentChoice[]): SubArguments {
  const text = input?.trim() ?? ""
  const fallback = defaultSubagent(agents)
  if (!text) return { agentID: fallback, task: "", explicitAgent: false }

  const first = text.split(/\s+/, 1)[0] ?? ""
  const requested = first.startsWith("@") ? first.slice(1) : first
  const matched = availableSubagents(agents).some((agent) => agent.id === requested)
  if (!matched) return { agentID: fallback, task: text, explicitAgent: false }

  return {
    agentID: requested,
    task: text.slice(first.length).trim(),
    explicitAgent: true,
  }
}

/** Merge server-owned asides with live native descendants without reordering existing tabs. */
export function mergeHubItems(
  remote: readonly HubItem[],
  live: readonly HubItem[],
): readonly HubItem[] {
  const byID = new Map<string, HubItem>()
  for (const item of live) byID.set(item.sessionID, item)
  for (const item of remote) byID.set(item.sessionID, item)
  return [...byID.values()].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.index - right.index ||
      left.sessionID.localeCompare(right.sessionID),
  )
}

export function visibleHubItems(items: readonly HubItem[]): readonly HubItem[] {
  return items.filter((item) => !item.hidden)
}

export function hiddenHubItems(items: readonly HubItem[]): readonly HubItem[] {
  return items.filter((item) => item.hidden)
}

export function nextTabID(
  items: readonly HubItem[],
  currentID: string | undefined,
  delta: -1 | 1,
): string | undefined {
  const visible = visibleHubItems(items)
  if (visible.length === 0) return undefined
  const index = visible.findIndex((item) => item.sessionID === currentID)
  if (index < 0) return delta === 1 ? visible[0]?.sessionID : visible.at(-1)?.sessionID
  return visible[(index + delta + visible.length) % visible.length]?.sessionID
}

export function resolveSelectedID(
  items: readonly HubItem[],
  preferredID: string | undefined,
): string | undefined {
  if (preferredID && items.some((item) => item.sessionID === preferredID && !item.hidden)) return preferredID
  return visibleHubItems(items)[0]?.sessionID
}

// ---------------------------------------------------------------------------
// Adaptive tab strip layout (mirrors OpenCode v2 `adaptiveSessionTabLayout`)
// ---------------------------------------------------------------------------

export const ASIDE_TAB_WIDTH = 20
export const ASIDE_TAB_MAX_WIDTH = 30
export const ASIDE_TAB_MIN_WIDTH = 9
export const asideOverflowMarkerWidth = (count: number): number => String(count).length + 2

export interface AdaptiveAsideTabLayout<T extends { readonly sessionID: string }> {
  readonly tabs: readonly T[]
  readonly widths: readonly number[]
  readonly before: number
  readonly after: number
  readonly start: number
  readonly total: number
}

export function adaptiveAsideTabLayout<T extends { readonly sessionID: string }>(
  tabs: readonly T[],
  activeID: string | undefined,
  available: number,
  previousStart = 0,
): AdaptiveAsideTabLayout<T> {
  if (tabs.length === 0 || available <= 0) {
    return { tabs: [], widths: [], before: 0, after: 0, start: 0, total: 0 }
  }

  const activeIndex = tabs.findIndex((tab) => tab.sessionID === activeID)
  const fit = (width: number) =>
    Math.min(
      tabs.length,
      Math.max(
        1,
        activeIndex === -1
          ? Math.floor(Math.max(0, width) / ASIDE_TAB_MIN_WIDTH)
          : 1 + Math.floor((Math.max(0, width) - ASIDE_TAB_WIDTH) / ASIDE_TAB_MIN_WIDTH),
      ),
    )

  const solve = (count: number, start: number, attempts: number): { count: number; start: number } => {
    const boundedStart = Math.min(Math.max(0, start), tabs.length - count)
    const nextStart = Math.min(
      Math.max(
        0,
        activeIndex === -1
          ? boundedStart
          : activeIndex < boundedStart
            ? activeIndex
            : activeIndex >= boundedStart + count
              ? activeIndex - count + 1
              : boundedStart,
      ),
      tabs.length - count,
    )
    const markers =
      (nextStart > 0 ? asideOverflowMarkerWidth(nextStart) : 0) +
      (nextStart + count < tabs.length ? asideOverflowMarkerWidth(tabs.length - nextStart - count) : 0)
    const nextCount = fit(available - markers)
    if (nextCount === count || attempts === 0) return { count, start: nextStart }
    return solve(nextCount, nextStart, attempts - 1)
  }

  const solved = solve(fit(available), previousStart, 3)
  const visible = tabs.slice(solved.start, solved.start + solved.count)
  const before = solved.start
  const after = tabs.length - solved.start - solved.count
  const contentWidth = Math.max(
    1,
    available -
      (before > 0 ? asideOverflowMarkerWidth(before) : 0) -
      (after > 0 ? asideOverflowMarkerWidth(after) : 0),
  )
  const roomy = contentWidth >= ASIDE_TAB_WIDTH * visible.length
  const total = roomy ? Math.min(contentWidth, ASIDE_TAB_MAX_WIDTH * visible.length) : contentWidth
  if (roomy || activeIndex === -1) {
    const width = Math.floor(total / visible.length)
    const remainder = total - width * visible.length
    return {
      tabs: visible,
      widths: visible.map((_, index) => width + Number(index < remainder)),
      before,
      after,
      start: solved.start,
      total,
    }
  }

  const inactiveWidth =
    visible.length === 1
      ? 0
      : Math.min(
          ASIDE_TAB_WIDTH,
          Math.max(
            ASIDE_TAB_MIN_WIDTH,
            Math.floor((total - Math.min(ASIDE_TAB_WIDTH, total)) / (visible.length - 1)),
          ),
        )
  const activeWidth = visible.length === 1 ? total : total - inactiveWidth * (visible.length - 1)

  return {
    tabs: visible,
    widths: visible.map((tab) => (tab.sessionID === activeID ? activeWidth : inactiveWidth)),
    before,
    after,
    start: solved.start,
    total,
  }
}

export function readDraft(drafts: Readonly<Record<string, string>>, key: string): string {
  return drafts[key] ?? ""
}

export function writeDraft(
  drafts: Readonly<Record<string, string>>,
  key: string,
  value: string,
): Record<string, string> {
  const next = { ...drafts }
  if (value.length === 0) delete next[key]
  else next[key] = value
  return next
}

export function rememberScrollOffset(
  offsets: Readonly<Record<string, number>>,
  sessionID: string,
  offset: number,
): Record<string, number> {
  const next = { ...offsets }
  const safe = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0
  if (safe === 0) delete next[sessionID]
  else next[sessionID] = safe
  return next
}

export interface ScrollPosition {
  readonly scrollTop: number
  readonly viewportHeight: number
  readonly scrollHeight: number
}

export function maximumScrollTop(position: ScrollPosition): number {
  return Math.max(0, position.scrollHeight - position.viewportHeight)
}

export function isAwayFromBottom(position: ScrollPosition, tolerance = 1): boolean {
  return position.scrollTop < Math.max(0, maximumScrollTop(position) - Math.max(0, tolerance))
}

export function clampScrollOffset(position: ScrollPosition): number {
  return Math.min(maximumScrollTop(position), Math.max(0, position.scrollTop))
}

export function shouldFollowStreaming(awayFromBottom: boolean): boolean {
  return !awayFromBottom
}

const ANSI_ESCAPE_RE = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g

export function stripAnsiCodes(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, "")
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function clipped(value: string, length = 96): string {
  const normalized = singleLine(value)
  return normalized.length > length ? `${normalized.slice(0, Math.max(0, length - 1))}…` : normalized
}

export function compactToolInput(input: unknown): string {
  if (typeof input === "string") {
    try {
      return compactToolInput(JSON.parse(input) as unknown)
    } catch {
      return clipped(input)
    }
  }
  if (!isRecord(input)) return input === undefined ? "" : clipped(String(input))

  const preferred = ["command", "path", "filePath", "pattern", "query", "url", "description"]
  for (const key of preferred) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return clipped(value)
  }
  try {
    return clipped(JSON.stringify(input))
  } catch {
    return ""
  }
}

export interface CollapsedShellPreview {
  readonly commandLine: string
  readonly previewOutput: string
  readonly overflow: boolean
  readonly hiddenLines: number
}

export function collapseShellPreview(
  command: string,
  output: string,
  maxOutputLines = 8,
  maxCommandChars = 160,
): CollapsedShellPreview {
  const cleanCmd = stripAnsiCodes(command).trim()
  const cmdOverflow = cleanCmd.length > maxCommandChars || cleanCmd.includes("\n")
  const commandLine = cmdOverflow
    ? `${cleanCmd.split("\n", 1)[0]?.slice(0, maxCommandChars) ?? ""}…`
    : cleanCmd

  const cleanOut = stripAnsiCodes(output).trim()
  if (!cleanOut) {
    return {
      commandLine,
      previewOutput: "",
      overflow: cmdOverflow,
      hiddenLines: 0,
    }
  }

  const lines = cleanOut.split("\n")
  if (lines.length <= maxOutputLines && cleanOut.length <= maxOutputLines * 140) {
    return {
      commandLine,
      previewOutput: cleanOut,
      overflow: cmdOverflow,
      hiddenLines: 0,
    }
  }

  const kept = lines.slice(0, maxOutputLines).join("\n")
  const capped = kept.length > maxOutputLines * 140 ? `${kept.slice(0, maxOutputLines * 140)}…` : kept
  return {
    commandLine,
    previewOutput: capped,
    overflow: true,
    hiddenLines: Math.max(1, lines.length - maxOutputLines),
  }
}

interface MessageRowBase {
  readonly id: string
  readonly messageID: string
}

export type MessageRow =
  | (MessageRowBase & {
      readonly kind: "user" | "synthetic" | "system"
      readonly text: string
      readonly description?: string
    })
  | (MessageRowBase & {
      readonly kind: "assistant"
      readonly text: string
      readonly streaming: boolean
    })
  | (MessageRowBase & {
      readonly kind: "reasoning"
      readonly text: string
      readonly preview: string
      readonly done: boolean
      readonly elapsedMs?: number
    })
  | (MessageRowBase & {
      readonly kind: "tool"
      readonly text: string
      readonly toolName: string
      readonly status: "streaming" | "running" | "completed" | "error"
      readonly error?: string
      readonly isShell?: boolean
      readonly command?: string
      readonly workdir?: string
      readonly output?: string
      readonly detail?: string
    })
  | (MessageRowBase & {
      readonly kind: "copy"
      readonly text: string
      readonly agent?: string
      readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string }
      readonly durationMs?: number
    })

type AssistantMessage = Extract<SessionMessage, { type: "assistant" }>
type AssistantPart = AssistantMessage["content"][number]
type ToolPart = Extract<AssistantPart, { type: "tool" }>

function durationLabel(part: ToolPart): string {
  const started = part.time.ran ?? part.time.created
  const completed = part.time.completed
  if (completed === undefined || completed < started) return ""
  return ` (${((completed - started) / 1000).toFixed(1)}s)`
}

function extractToolTextOutput(part: ToolPart): string {
  const state = part.state
  if (state.status !== "completed" && state.status !== "error") return ""
  if (!("content" in state) || !Array.isArray(state.content)) return ""
  const texts: string[] = []
  for (const item of state.content) {
    if (isRecord(item) && item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      texts.push(stripAnsiCodes(item.text))
    }
  }
  return texts.join("\n").trim()
}

function parseInputRecord(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) return raw
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

export function formatToolRow(part: ToolPart): Omit<Extract<MessageRow, { kind: "tool" }>, "id" | "messageID" | "kind"> {
  const status = part.state.status
  const marker = status === "completed" ? "✓" : status === "error" ? "✗" : "⟳"
  const inputSummary = compactToolInput(part.state.input)
  const base = `${marker} ${part.name}${inputSummary ? ` · ${inputSummary}` : ""}${durationLabel(part)}`
  const canonical = part.name.toLowerCase()
  const isShell = canonical === "shell" || canonical === "bash"
  const inputRecord = parseInputRecord(part.state.input)
  const command = isShell && typeof inputRecord?.command === "string" ? inputRecord.command : undefined
  const workdir = isShell && typeof inputRecord?.workdir === "string" ? inputRecord.workdir : undefined
  const output = extractToolTextOutput(part)

  let detail: string | undefined
  if (!isShell) {
    const sections: string[] = []
    if (inputRecord && Object.keys(inputRecord).length > 0) {
      try {
        sections.push(JSON.stringify(inputRecord, null, 2))
      } catch {
        // Ignore unserializable input
      }
    }
    if (output) {
      sections.push(output.length > 2400 ? `${output.slice(0, 2400)}\n…` : output)
    }
    if (sections.length > 0) detail = sections.join("\n\n")
  }

  const extra = {
    ...(isShell ? { isShell: true } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(workdir !== undefined ? { workdir } : {}),
    ...(output ? { output } : {}),
    ...(detail ? { detail } : {}),
  }

  if (status !== "error") {
    return { text: base, toolName: part.name, status, ...extra }
  }
  const error = part.state.error.message
  return {
    text: `${base}${error ? ` · ${clipped(error, 160)}` : ""}`,
    toolName: part.name,
    status,
    error,
    ...extra,
  }
}

export function formatDurationCompact(ms: number | undefined): string {
  if (ms === undefined || !(ms >= 0)) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const mins = Math.floor(sec / 60)
  const rem = Math.round(sec % 60)
  return `${mins}m ${rem}s`
}

/** Flatten the host's message union into renderer-agnostic transcript rows. */
export function formatMessageRows(messages: readonly SessionMessage[]): readonly MessageRow[] {
  const rows: MessageRow[] = []
  for (const message of messages) {
    if (message.type === "user" || message.type === "synthetic" || message.type === "system") {
      if (!message.text) continue
      const description =
        "description" in message && typeof message.description === "string" ? message.description : undefined
      // Mirror OpenCode native `rows.ts:392`: internal synthetics without a description (e.g. `<fork-notice>`) stay hidden.
      if (message.type === "synthetic" && !description?.trim()) continue
      rows.push({
        id: message.id,
        messageID: message.id,
        kind: message.type,
        text: message.text,
        ...(description ? { description } : {}),
      })
      continue
    }
    if (message.type === "shell") {
      const cmd = message.command ?? ""
      const out = message.output?.output ? stripAnsiCodes(message.output.output).trim() : ""
      const status =
        message.status === "running"
          ? ("running" as const)
          : message.exit !== undefined && message.exit !== 0
            ? ("error" as const)
            : ("completed" as const)
      rows.push({
        id: message.id,
        messageID: message.id,
        kind: "tool",
        toolName: "shell",
        status,
        isShell: true,
        command: cmd,
        ...(out ? { output: out } : {}),
        text: `${status === "completed" ? "✓" : status === "error" ? "✗" : "⟳"} shell · ${clipped(cmd)}`,
        ...(status === "error" && message.exit !== undefined ? { error: `exit code ${message.exit}` } : {}),
      })
      continue
    }
    if (message.type !== "assistant") continue

    const copyText: string[] = []
    const isMessageStreaming = message.time.completed === undefined
    message.content.forEach((part, index) => {
      const id = `${message.id}:${index}`
      const isTrailingPart = index === message.content.length - 1
      if (part.type === "text") {
        if (!part.text) return
        copyText.push(part.text)
        rows.push({
          id,
          messageID: message.id,
          kind: "assistant",
          text: part.text,
          streaming: isMessageStreaming && isTrailingPart,
        })
        return
      }
      if (part.type === "reasoning") {
        const cleaned = part.text.replace("[REDACTED]", "").trim()
        if (!cleaned) return
        const done = part.time?.completed !== undefined || message.time.completed !== undefined
        const end = part.time?.completed ?? message.time.completed
        const start = part.time?.created ?? message.time.created
        const elapsedMs = end !== undefined && start !== undefined ? Math.max(0, end - start) : undefined
        const previewLine = cleaned.split("\n").findLast((line) => line.trim()) ?? "Thinking…"
        rows.push({
          id,
          messageID: message.id,
          kind: "reasoning",
          text: cleaned,
          preview: clipped(previewLine.replace(/^#+\s*/, ""), 64),
          done,
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
        })
        return
      }
      rows.push({ id, messageID: message.id, kind: "tool", ...formatToolRow(part) })
    })
    const copied = copyText.join("\n\n")
    const durationMs =
      message.time.completed !== undefined && message.time.created !== undefined
        ? Math.max(0, message.time.completed - message.time.created)
        : undefined
    if (copied || message.time.completed !== undefined) {
      rows.push({
        id: `${message.id}:copy`,
        messageID: message.id,
        kind: "copy",
        text: copied,
        agent: message.agent,
        model: message.model,
        ...(durationMs !== undefined ? { durationMs } : {}),
      })
    }
    if (message.error) {
      rows.push({
        id: `${message.id}:error`,
        messageID: message.id,
        kind: "system",
        text: message.error.message,
      })
    }
  }
  return rows
}

export function formatFooterBadge(items: readonly HubItem[], running: ReadonlySet<string>): string {
  if (items.length === 0) return ""
  const kinds = new Set(items.map((item) => item.kind))
  const noun = kinds.size === 1 ? (items[0]?.kind === "subagent" ? "agents" : items[0]?.kind) : "asides"
  const active = items.some((item) => running.has(item.sessionID))
  return `◈ ${items.length} ${noun ?? "asides"}${active ? " ●" : ""}`
}

/** Turn the live family store into HubItems; remote metadata wins during merge. */
export function liveFamilyItems(context: Plugin.Context, rootSessionID: string): readonly HubItem[] {
  const family = context.data.session.family(rootSessionID)
  const items: HubItem[] = []
  family.forEach((sessionID, familyIndex) => {
    if (sessionID === rootSessionID) return
    const info = context.data.session.get(sessionID)
    if (!info?.parentID || readO3pSessionMeta(info.metadata)) return

    let depth = 1
    let parentID: string | undefined = info.parentID
    const visited = new Set<string>([sessionID])
    while (parentID && parentID !== rootSessionID && !visited.has(parentID)) {
      visited.add(parentID)
      depth += 1
      parentID = context.data.session.get(parentID)?.parentID
    }
    const agent = info.agent ?? null
    const label = info.title?.trim() || agent || sessionID
    items.push({
      sessionID,
      rootSessionID,
      parentID: info.parentID,
      kind: "subagent",
      depth,
      index: familyIndex + 1,
      alias: `↳${depth}`,
      title: info.title ?? label,
      label,
      agent,
      model: info.model
        ? {
            providerID: info.model.providerID,
            id: info.model.id,
            ...(info.model.variant ? { variant: info.model.variant } : {}),
          }
        : null,
      readonly: false,
      hidden: false,
      archived: info.time.archived !== undefined,
      createdAt: info.time.created,
      updatedAt: info.time.updated,
    })
  })
  return items
}

export interface ModelDisplayMeta {
  readonly modelName: string
  readonly providerName?: string
  readonly variant?: string
}

export function resolveModelDisplay(
  context: Plugin.Context,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string } | null | undefined,
): ModelDisplayMeta {
  if (!model) {
    const uiModel = context.ui.model.current()
    if (!uiModel) return { modelName: "" }
    return resolveModelDisplay(context, {
      providerID: uiModel.providerID,
      id: uiModel.modelID,
      ...(uiModel.variant ? { variant: uiModel.variant } : {}),
    })
  }
  const models = context.data.location.model.list(context.location) ?? []
  const providers = context.data.location.provider.list(context.location) ?? []
  const foundModel = models.find((item) => item.providerID === model.providerID && item.id === model.id)
  const foundProvider = providers.find((item) => item.id === model.providerID)
  return {
    modelName: foundModel?.name ?? model.id,
    ...(foundProvider?.name ? { providerName: foundProvider.name } : { providerName: model.providerID }),
    ...(model.variant && model.variant !== "default" ? { variant: model.variant } : {}),
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Applies live SSE deltas onto the panel-owned message mirror so forked `/btw`
 * sessions (`parentID === null`) stream smoothly even when OpenCode v2.3.0's
 * `createSessionRetention` evicts non-tab root sessions from `data.session.message`.
 */
export function applyPanelStreamEvent(
  current: readonly SessionMessage[],
  event: HostEvent,
  targetSessionID: string,
): { readonly next: readonly SessionMessage[]; readonly shouldRefetch: boolean } {
  if (!("sessionID" in event.data) || event.data.sessionID !== targetSessionID) {
    return { next: current, shouldRefetch: false }
  }

  switch (event.type) {
    case "session.inbox.enqueued": {
      if (event.data.item.type === "user") {
        const id = event.data.inboxID
        if (current.some((m) => m.id === id)) return { next: current, shouldRefetch: false }
        return {
          next: [
            ...current,
            {
              id,
              type: "user",
              text: event.data.item.payload.text,
              files: event.data.item.payload.files,
              time: { created: event.created },
            },
          ],
          shouldRefetch: false,
        }
      }
      return { next: current, shouldRefetch: true }
    }
    case "session.step.started": {
      const msgID = event.data.assistantMessageID
      if (current.some((m) => m.id === msgID)) return { next: current, shouldRefetch: false }
      return {
        next: [
          ...current,
          {
            id: msgID,
            type: "assistant",
            agent: event.data.agent,
            model: event.data.model,
            content: [],
            time: { created: event.data.started },
          },
        ],
        shouldRefetch: false,
      }
    }
    case "session.text.started": {
      const msgID = event.data.assistantMessageID
      return {
        next: current.map((m) =>
          m.id === msgID && m.type === "assistant"
            ? { ...m, content: [...m.content, { type: "text" as const, text: "" }] }
            : m,
        ),
        shouldRefetch: false,
      }
    }
    case "session.text.delta": {
      const msgID = event.data.assistantMessageID
      return {
        next: current.map((m) => {
          if (m.id !== msgID || m.type !== "assistant") return m
          const copy = [...m.content]
          const lastIdx = copy.findLastIndex((p) => p.type === "text")
          if (lastIdx === -1) {
            copy.push({ type: "text", text: event.data.delta })
          } else {
            const prev = copy[lastIdx]
            if (prev && prev.type === "text") {
              copy[lastIdx] = { ...prev, text: prev.text + event.data.delta }
            }
          }
          return { ...m, content: copy }
        }),
        shouldRefetch: false,
      }
    }
    case "session.reasoning.started": {
      const msgID = event.data.assistantMessageID
      return {
        next: current.map((m) =>
          m.id === msgID && m.type === "assistant"
            ? {
                ...m,
                content: [...m.content, { type: "reasoning" as const, text: "", time: { created: event.created } }],
              }
            : m,
        ),
        shouldRefetch: false,
      }
    }
    case "session.reasoning.delta": {
      const msgID = event.data.assistantMessageID
      return {
        next: current.map((m) => {
          if (m.id !== msgID || m.type !== "assistant") return m
          const copy = [...m.content]
          const lastIdx = copy.findLastIndex((p) => p.type === "reasoning")
          if (lastIdx === -1) {
            copy.push({ type: "reasoning", text: event.data.delta, time: { created: event.created } })
          } else {
            const prev = copy[lastIdx]
            if (prev && prev.type === "reasoning") {
              copy[lastIdx] = { ...prev, text: prev.text + event.data.delta }
            }
          }
          return { ...m, content: copy }
        }),
        shouldRefetch: false,
      }
    }
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed":
    case "session.step.ended":
    case "session.idle":
    case "session.synthetic":
      return { next: current, shouldRefetch: true }
    default:
      return { next: current, shouldRefetch: false }
  }
}
