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

interface MessageRowBase {
  readonly id: string
  readonly messageID: string
}

export type MessageRow =
  | (MessageRowBase & {
      readonly kind: "user" | "synthetic" | "system"
      readonly text: string
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
      readonly elapsedMs?: number
    })
  | (MessageRowBase & {
      readonly kind: "tool"
      readonly text: string
      readonly toolName: string
      readonly status: "streaming" | "running" | "completed" | "error"
      readonly error?: string
    })
  | (MessageRowBase & {
      readonly kind: "copy"
      readonly text: string
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

export function formatToolRow(part: ToolPart): Omit<Extract<MessageRow, { kind: "tool" }>, "id" | "messageID" | "kind"> {
  const status = part.state.status
  const marker = status === "completed" ? "✓" : status === "error" ? "✗" : "⟳"
  const input = compactToolInput(part.state.input)
  const base = `${marker} ${part.name}${input ? ` · ${input}` : ""}${durationLabel(part)}`
  if (status !== "error") return { text: base, toolName: part.name, status }
  const error = part.state.error.message
  return {
    text: `${base}${error ? ` · ${clipped(error, 160)}` : ""}`,
    toolName: part.name,
    status,
    error,
  }
}

/** Flatten the host's message union into renderer-agnostic transcript rows. */
export function formatMessageRows(messages: readonly SessionMessage[]): readonly MessageRow[] {
  const rows: MessageRow[] = []
  for (const message of messages) {
    if (message.type === "user" || message.type === "synthetic" || message.type === "system") {
      if (!message.text) continue
      rows.push({
        id: message.id,
        messageID: message.id,
        kind: message.type,
        text: message.text,
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
        if (!part.text) return
        const elapsedMs =
          part.time?.completed !== undefined && part.time.created !== undefined
            ? Math.max(0, part.time.completed - part.time.created)
            : undefined
        rows.push({
          id,
          messageID: message.id,
          kind: "reasoning",
          text: part.text,
          preview: clipped(part.text.split("\n").findLast((line) => line.trim()) ?? "思考中…", 72),
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
        })
        return
      }
      rows.push({ id, messageID: message.id, kind: "tool", ...formatToolRow(part) })
    })
    const copied = copyText.join("\n\n")
    if (copied) {
      rows.push({ id: `${message.id}:copy`, messageID: message.id, kind: "copy", text: copied })
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
