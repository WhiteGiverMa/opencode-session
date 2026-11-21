import type { Plugin } from "@opencode/plugin/tui"
import {
  MouseButton,
  RGBA,
  ScrollBoxRenderable,
  TabSelectRenderableEvents,
  TextAttributes,
  type KeyEvent,
  type MouseEvent,
  type TabSelectOption,
  type TabSelectRenderable,
  type TextareaRenderable,
} from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import type { Store } from "solid-js/store"
import stringWidth from "string-width"
import { SessionRpc, type DeliveryMode, type HubItem } from "../contract.ts"
import {
  createBtwAside,
  createSubAside,
  forceSyncSession,
  openInlineComposer,
  panelKeybindingCommands,
  resolveRootSessionID,
  rpcOptions,
  sendSessionPrompt,
} from "./commands.ts"
import {
  adaptiveAsideTabLayout,
  applyPanelStreamEvent,
  availableSubagents,
  collapseShellPreview,
  errorMessage,
  formatAsideTabTitle,
  formatDurationCompact,
  formatMessageRows,
  hiddenHubItems,
  isAwayFromBottom,
  liveFamilyItems,
  maximumScrollTop,
  mergeHubItems,
  nextTabID,
  readDraft,
  resolveModelDisplay,
  resolveSelectedID,
  shouldFollowStreaming,
  stabilizeHubItems,
  visibleHubItems,
  writeDraft,
  type MessageRow,
  type SessionMessage,
  type TuiMemoryState,
  type UpdateTuiMemory,
} from "./state.ts"
import { openSessionTreeManager } from "./tree-manager.tsx"
import {
  createHostScrollAcceleration,
  EmptyBorder,
  GraphicalPromptCard,
  GuiButton,
  PopupContextMenu,
  type PopupMenuItem,
  readHostCliScrollConfig,
  resolveHostAgentAccent,
  setPointer,
  SplitBorder,
  titlecaseAgent,
  useHostSyntaxStyle,
} from "./ui-primitives.tsx"
import { useSpinnerFrame } from "./spinner.ts"

type Theme = Plugin.Context["theme"]

// The published SDK also runs on hosts without the native transcript patch.
type NativeTranscriptUI = Plugin.Context["ui"] & {
  readonly session?: {
    transcript(input: {
      readonly sessionID: string
      readonly width?: number
      readonly onOpenSession?: (sessionID: string) => void
      readonly onActivate?: () => void
    }): JSX.Element
  }
}

type PanelInput = {
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly presentation: "panel" | "fullscreen"
  readonly focused: boolean
  readonly focus: () => void
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

export interface SessionPanelProps {
  readonly context: Plugin.Context
  readonly input: PanelInput
  readonly memory: Store<TuiMemoryState>
  readonly updateMemory: UpdateTuiMemory
}

interface ContextMenuState {
  readonly x: number
  readonly y: number
  readonly item?: HubItem
}

function AdaptiveTabCell(props: {
  readonly context: Plugin.Context
  readonly item: HubItem
  readonly width: number
  readonly selected: boolean
  readonly running: boolean
  readonly unread: boolean
  readonly newDesigns: boolean
  readonly onActivateHost: () => void
  readonly onSelect: () => void
  readonly onMiddleClose: () => void
  readonly onRightMenu: (event: MouseEvent) => void
}) {
  const theme = props.context.theme
  const [hovered, setHovered] = createSignal(false)
  const spinner = useSpinnerFrame(() => props.running)
  const accent = createMemo(() => resolveHostAgentAccent(props.context, props.item.agent, props.newDesigns))

  onCleanup(() => {
    if (hovered()) setPointer(props.context, "default")
  })

  const bg = createMemo(() => {
    if (props.selected) return theme.background.raised.max
    if (hovered()) return theme.background.raised.high
    return undefined
  })

  const hasIndicator = () => props.unread

  return (
    <box
      width={props.width}
      height={1}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      backgroundColor={bg()}
      border={props.selected ? ["left"] : undefined}
      borderColor={props.selected ? accent() : undefined}
      customBorderChars={SplitBorder.customBorderChars}
      paddingLeft={1}
      paddingRight={1}
      onMouseOver={() => {
        setHovered(true)
        setPointer(props.context, "pointer")
      }}
      onMouseOut={() => {
        setHovered(false)
        setPointer(props.context, "default")
      }}
      onMouseDown={(event: MouseEvent) => {
        if (event.button === MouseButton.MIDDLE) {
          event.preventDefault()
          event.stopPropagation()
          props.onMiddleClose()
          return
        }
        if (event.button === MouseButton.RIGHT) {
          event.preventDefault()
          event.stopPropagation()
          props.onRightMenu(event)
          return
        }
        if (event.button !== MouseButton.LEFT) return
        props.onActivateHost()
        event.stopPropagation()
      }}
      onMouseUp={(event: MouseEvent) => {
        if (event.button !== MouseButton.LEFT) return
        event.stopPropagation()
        props.onSelect()
      }}
    >
      <Show when={props.running}>
        <text fg={theme.text.feedback.info.base} wrapMode="none" flexShrink={0} selectable={false}>
          {`${spinner()} `}
        </text>
      </Show>
      <text
        fg={props.selected || hovered() ? theme.text.base : theme.text.muted}
        attributes={props.selected ? TextAttributes.BOLD : undefined}
        wrapMode="none"
        truncate
        flexGrow={1}
        minWidth={0}
        selectable={false}
      >
        {formatAsideTabTitle(props.item)}
      </text>
      <Show when={hasIndicator()}>
        <text fg={theme.text.feedback.warning.base} wrapMode="none" flexShrink={0} selectable={false}>
          {" •"}
        </text>
      </Show>
    </box>
  )
}

function ShellToolCard(props: {
  readonly context: Plugin.Context
  readonly row: Extract<MessageRow, { kind: "tool" }>
  readonly theme: Theme
  readonly expanded: boolean
  readonly onActivateHost: () => void
  readonly onToggle: () => void
}) {
  const [hovered, setHovered] = createSignal(false)
  const rawCommand = () => {
    const cmd = props.row.command ?? ""
    const wd = props.row.workdir
    const prefix = wd && wd !== "." ? `cd ${wd} && ` : ""
    return cmd ? `$ ${prefix}${cmd}` : props.row.text
  }
  const rawOutput = () => props.row.output ?? ""
  const collapsed = createMemo(() => collapseShellPreview(rawCommand(), rawOutput(), 8, 160))
  const expandable = createMemo(() => collapsed().overflow || Boolean(rawOutput()) || Boolean(props.row.error))

  onCleanup(() => {
    if (hovered()) setPointer(props.context, "default")
  })

  const baseBg = () => props.theme.decrease(props.theme.background.raised.base)
  const cardBg = () => (hovered() && expandable() ? props.theme.background.raised.high : baseBg())

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginLeft={1}
      marginRight={1}
      marginBottom={1}
      border={["left"]}
      borderColor={props.row.status === "error" ? props.theme.text.feedback.error.base : props.theme.border.base}
      customBorderChars={SplitBorder.customBorderChars}
      backgroundColor={cardBg()}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
      onMouseOver={() => {
        if (!expandable()) return
        setHovered(true)
        setPointer(props.context, "pointer")
      }}
      onMouseOut={() => {
        setHovered(false)
        setPointer(props.context, "default")
      }}
      onMouseDown={(event: MouseEvent) => {
        if (event.button !== MouseButton.LEFT) return
        props.onActivateHost()
        event.stopPropagation()
      }}
      onMouseUp={(event: MouseEvent) => {
        if (event.button !== MouseButton.LEFT || !expandable()) return
        if (props.context.renderer.getSelection()?.getSelectedText()) return
        event.stopPropagation()
        props.onToggle()
      }}
    >
      <text
        fg={props.row.status === "running" ? props.theme.text.feedback.info.base : props.theme.text.base}
        wrapMode={props.expanded ? "word" : "char"}
        maxHeight={props.expanded ? undefined : 2}
      >
        {props.expanded ? rawCommand() : collapsed().commandLine}
      </text>

      <Show when={props.expanded ? rawOutput() : collapsed().previewOutput}>
        {(out) => (
          <text fg={props.theme.text.muted} wrapMode="word">
            {out()}
          </text>
        )}
      </Show>

      <Show when={!props.expanded && collapsed().hiddenLines > 0}>
        <text fg={props.theme.text.faint} wrapMode="none" selectable={false}>
          {`… +${collapsed().hiddenLines} lines`}
        </text>
      </Show>

      <Show when={props.row.error}>
        {(err) => (
          <text fg={props.theme.text.feedback.error.base} wrapMode="word">
            {err()}
          </text>
        )}
      </Show>
    </box>
  )
}

function TranscriptRow(props: {
  readonly context: Plugin.Context
  readonly row: MessageRow
  readonly theme: Theme
  readonly newDesigns: boolean
  readonly accent: RGBA
  readonly syntaxStyle: ReturnType<ReturnType<typeof useHostSyntaxStyle>>
  readonly expanded: boolean
  readonly copied: boolean
  readonly onActivateHost: () => void
  readonly onToggle: () => void
  readonly onCopy: (text: string, id: string) => void
}) {
  const row = props.row
  const [hovered, setHovered] = createSignal(false)

  onCleanup(() => {
    if (hovered()) setPointer(props.context, "default")
  })

  // 1. Native-aligned Reasoning block (`+ Thought: ... · 3.5s` in warning gold)
  if (row.kind === "reasoning") {
    const duration = row.elapsedMs !== undefined ? formatDurationCompact(row.elapsedMs) : undefined
    const headerFg = () => {
      const warn = props.theme.text.feedback.warning.base
      return props.expanded ? RGBA.fromValues(warn.r, warn.g, warn.b, 0.65) : warn
    }
    return (
      <box flexDirection="column" flexShrink={0} paddingLeft={3} paddingRight={2} marginBottom={1}>
        <box
          height={1}
          flexShrink={0}
          backgroundColor={hovered() ? props.theme.background.raised.high : undefined}
          onMouseOver={() => {
            setHovered(true)
            setPointer(props.context, "pointer")
          }}
          onMouseOut={() => {
            setHovered(false)
            setPointer(props.context, "default")
          }}
          onMouseDown={(event: MouseEvent) => {
            if (event.button !== MouseButton.LEFT) return
            props.onActivateHost()
            event.stopPropagation()
          }}
          onMouseUp={(event: MouseEvent) => {
            if (event.button !== MouseButton.LEFT) return
            if (props.context.renderer.getSelection()?.getSelectedText()) return
            event.stopPropagation()
            props.onToggle()
          }}
          onKeyDown={(event: KeyEvent) => {
            if (event.name !== "space") return
            event.preventDefault()
            props.onToggle()
          }}
        >
          <text fg={headerFg()} wrapMode="none" truncate selectable={false}>
            <Show
              when={row.done}
              fallback={<span>{`⟳ Thinking${row.preview ? `: ${row.preview}` : "…"}`}</span>}
            >
              <span>{props.expanded ? "- Thought" : "+ Thought"}</span>
              <Show when={!props.expanded && row.preview}>
                <span>{`: ${row.preview}`}</span>
              </Show>
              <Show when={duration}>
                {(d) => <span>{`${!props.expanded && row.preview ? " · " : ": "}${d()}`}</span>}
              </Show>
            </Show>
          </text>
        </box>
        <Show when={props.expanded}>
          <box
            marginTop={1}
            border={["left"]}
            borderColor={props.theme.border.base}
            customBorderChars={SplitBorder.customBorderChars}
            paddingLeft={2}
          >
            <markdown
              content={row.text}
              streaming={!row.done}
              conceal
              internalBlockMode="top-level"
              syntaxStyle={props.syntaxStyle}
              fg={props.theme.text.muted}
            />
          </box>
        </Show>
      </box>
    )
  }

  // 2. Native-aligned expandable `$ shell` block or expandable inline tool row
  if (row.kind === "tool") {
    if (row.isShell) {
      return (
        <ShellToolCard
          context={props.context}
          row={row}
          theme={props.theme}
          expanded={props.expanded}
          onActivateHost={props.onActivateHost}
          onToggle={props.onToggle}
        />
      )
    }

    const expandable = Boolean(row.detail || row.error)
    return (
      <box flexDirection="column" flexShrink={0} paddingLeft={3} paddingRight={2}>
        <box
          height={1}
          flexShrink={0}
          backgroundColor={hovered() && expandable ? props.theme.background.raised.high : undefined}
          onMouseOver={() => {
            if (!expandable) return
            setHovered(true)
            setPointer(props.context, "pointer")
          }}
          onMouseOut={() => {
            setHovered(false)
            setPointer(props.context, "default")
          }}
          onMouseDown={(event: MouseEvent) => {
            if (event.button !== MouseButton.LEFT || !expandable) return
            props.onActivateHost()
            event.stopPropagation()
          }}
          onMouseUp={(event: MouseEvent) => {
            if (event.button !== MouseButton.LEFT || !expandable) return
            if (props.context.renderer.getSelection()?.getSelectedText()) return
            event.stopPropagation()
            props.onToggle()
          }}
        >
          <text
            fg={
              row.status === "error"
                ? props.theme.text.feedback.error.base
                : hovered() && expandable
                  ? props.theme.text.base
                  : props.theme.text.muted
            }
            wrapMode="none"
            truncate
          >
            {row.text}
          </text>
        </box>
        <Show when={props.expanded && (row.detail || row.error)}>
          <box
            marginLeft={1}
            marginBottom={1}
            border={["left"]}
            borderColor={row.status === "error" ? props.theme.text.feedback.error.base : props.theme.border.base}
            customBorderChars={SplitBorder.customBorderChars}
            backgroundColor={props.theme.decrease(props.theme.background.raised.base)}
            paddingLeft={2}
            paddingRight={1}
          >
            <Show when={row.detail}>
              {(detail) => (
                <text fg={props.theme.text.muted} wrapMode="word">
                  {detail()}
                </text>
              )}
            </Show>
            <Show when={row.error}>
              {(err) => (
                <text fg={props.theme.text.feedback.error.base} wrapMode="word">
                  {err()}
                </text>
              )}
            </Show>
          </box>
        </Show>
      </box>
    )
  }

  // 3. Native-aligned assistant signature & quiet copy footer (`Agent · Model · duration   ⧉ copy`)
  if (row.kind === "copy") {
    const rowAccent = createMemo(() => resolveHostAgentAccent(props.context, row.agent, props.newDesigns))
    const modelMeta = createMemo(() => (row.model ? resolveModelDisplay(props.context, row.model) : undefined))
    const duration = formatDurationCompact(row.durationMs)
    return (
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={3}
        paddingRight={2}
        marginBottom={1}
      >
        <box flexDirection="row" gap={1} flexGrow={1} minWidth={0}>
          <Show when={row.agent}>
            {(agent) => (
              <text fg={rowAccent()} wrapMode="none" flexShrink={0} selectable={false}>
                {titlecaseAgent(agent())}
              </text>
            )}
          </Show>
          <Show when={modelMeta()?.modelName}>
            {(modelName) => (
              <>
                <text fg={props.theme.text.muted} wrapMode="none" flexShrink={0} selectable={false}>
                  ·
                </text>
                <text fg={props.theme.text.muted} wrapMode="none" truncate flexShrink={1} minWidth={0} selectable={false}>
                  {modelName()}
                </text>
              </>
            )}
          </Show>
          <Show when={duration}>
            <text fg={props.theme.text.muted} wrapMode="none" flexShrink={0} selectable={false}>
              {`· ${duration}`}
            </text>
          </Show>
        </box>
        <Show when={row.text}>
          <GuiButton
            context={props.context}
            label={props.copied ? "copied" : "copy"}
            icon={props.copied ? "✓" : "⧉"}
            variant={props.copied ? "success" : "ghost"}
            onActivateHost={props.onActivateHost}
            onClick={() => props.onCopy(row.text, row.id)}
          />
        </Show>
      </box>
    )
  }

  // 4. Assistant Markdown body
  if (row.kind === "assistant") {
    return (
      <box flexShrink={0} paddingLeft={3} paddingRight={2} paddingTop={0} paddingBottom={0}>
        <markdown
          content={row.text}
          streaming={row.streaming}
          conceal
          internalBlockMode="top-level"
          tableOptions={{ style: "grid", cellPaddingX: 1 }}
          syntaxStyle={props.syntaxStyle}
          fg={props.theme.markdown.text}
        />
      </box>
    )
  }

  // 5. User / Synthetic / System message card
  const cardBg = props.theme.decrease(props.theme.background.raised.base)
  const barColor =
    row.kind === "user"
      ? props.accent
      : row.kind === "synthetic"
        ? props.theme.text.feedback.info.base
        : props.theme.border.base
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginLeft={1}
      marginRight={1}
      marginBottom={1}
      border={["left"]}
      borderColor={barColor}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box
        flexDirection="column"
        backgroundColor={cardBg}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <Show when={row.kind !== "user"}>
          <text fg={barColor} attributes={TextAttributes.BOLD} wrapMode="none" selectable={false}>
            {row.kind === "synthetic" ? row.description || "跨会话来信" : row.description || "系统提示"}
          </text>
        </Show>
        <text fg={props.theme.text.base} wrapMode="word">
          {row.text}
        </text>
      </box>
    </box>
  )
}

function AsideEmptyState(props: {
  readonly context: Plugin.Context
  readonly itemsCount: number
  readonly hiddenCount: number
  readonly onOpenTree: () => void
  readonly onNewBtw: () => void
  readonly onNewSub: () => void
  readonly onActivateHost: () => void
}) {
  const theme = props.context.theme
  const summary =
    props.itemsCount > 0
      ? `当前没有打开的旁路会话${props.hiddenCount > 0 ? ` · ${props.hiddenCount} 个已收起` : ""}`
      : "输入 /btw、/sub 或点右上角 + 开启旁路会话"
  return (
    <box padding={2} flexDirection="column" gap={1}>
      <text fg={theme.text.muted} selectable={false}>
        {summary}
      </text>
      <Show when={props.itemsCount > 0}>
        <box flexDirection="row">
          <GuiButton
            context={props.context}
            icon="⑂"
            label={`查看/恢复会话树 (${props.itemsCount}${props.hiddenCount > 0 ? ` · ${props.hiddenCount} 收起` : ""})`}
            variant={props.hiddenCount > 0 ? "primary" : "secondary"}
            onActivateHost={props.onActivateHost}
            onClick={props.onOpenTree}
          />
        </box>
      </Show>
      <box flexDirection="row" gap={1}>
        <GuiButton
          context={props.context}
          icon="+"
          label="新建 /btw"
          variant="secondary"
          onActivateHost={props.onActivateHost}
          onClick={props.onNewBtw}
        />
        <GuiButton
          context={props.context}
          label="派遣 /sub"
          variant="ghost"
          onActivateHost={props.onActivateHost}
          onClick={props.onNewSub}
        />
      </box>
    </box>
  )
}

export function SessionPanel(props: SessionPanelProps) {
  const context = props.context
  const theme = context.theme
  const rpc = context.client.rpc(SessionRpc)
  const sessionUI = (context.ui as NativeTranscriptUI).session
  const nativeTranscript = typeof sessionUI?.transcript === "function" ? sessionUI : undefined
  const syntaxStyle = useHostSyntaxStyle(context)
  const scrollConfig = readHostCliScrollConfig()
  const scrollAcceleration = createHostScrollAcceleration(scrollConfig)
  const keyboardScrollStep = Math.max(1, Math.round(scrollConfig.speed))

  const rootSessionID = createMemo(() => resolveRootSessionID(context, props.input.sessionID))
  const [remoteItems, setRemoteItems] = createSignal<readonly HubItem[]>([])
  const [hubError, setHubError] = createSignal("")
  const [expandedRows, setExpandedRows] = createSignal<ReadonlySet<string>>(new Set())
  const [away, setAway] = createSignal(false)
  const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set())
  const [copiedID, setCopiedID] = createSignal("")
  const [tabWindowStart, setTabWindowStart] = createSignal(0)
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState>()
  const [localMessages, setLocalMessages] = createSignal<readonly SessionMessage[]>([])
  let refreshRevision = 0
  let refreshInFlight: Promise<void> | undefined
  let refreshQueued = false
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let messageFetchRevision = 0
  let transcript: ScrollBoxRenderable | undefined
  let composer: TextareaRenderable | undefined
  let removeScrollListener: (() => void) | undefined

  const fetchPanelMessages = async (sessionID: string): Promise<void> => {
    const rev = ++messageFetchRevision
    try {
      const response = await context.client.message.list({
        sessionID,
        limit: 150,
        order: "desc",
      })
      if (rev !== messageFetchRevision || selectedID() !== sessionID) return
      setLocalMessages(response.data.slice().reverse())
    } catch {
      // Ignore transient races while a brand-new session commits
    }
  }

  const runRefresh = async (): Promise<void> => {
    const root = rootSessionID()
    const revision = ++refreshRevision
    try {
      const result = await rpc.listHub({ rootSessionID: root }, rpcOptions(context))
      if (revision !== refreshRevision || root !== rootSessionID()) return
      setRemoteItems((current) => stabilizeHubItems(current, result.items))
      setHubError("")
    } catch (error: unknown) {
      if (revision === refreshRevision) setHubError(errorMessage(error))
    }
  }

  /** Coalesces the panel and footer readers, plus update-event bursts, onto one RPC. */
  const refresh = (): Promise<void> => {
    if (refreshInFlight) {
      refreshQueued = true
      return refreshInFlight
    }
    const run = runRefresh().finally(() => {
      if (refreshInFlight === run) refreshInFlight = undefined
      if (refreshQueued) {
        refreshQueued = false
        void refresh()
      }
    })
    refreshInFlight = run
    return run
  }

  const scheduleRefresh = (): void => {
    if (refreshTimer !== undefined) return
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refresh()
    }, 60)
  }

  onMount(() => {
    onCleanup(
      rpc.events.on("updated", (event) => {
        if (event.data.rootSessionID === rootSessionID()) scheduleRefresh()
      }),
    )
    onCleanup(() => {
      if (refreshTimer !== undefined) {
        clearTimeout(refreshTimer)
        refreshTimer = undefined
      }
    })
    if (nativeTranscript) {
      // Native rows own message hydration and streaming. Only refresh the hub here.
      const refreshSelected = ({ data }: { data: { sessionID: string } }) => {
        if (data.sessionID === selectedID()) scheduleRefresh()
      }
      onCleanup(context.data.on("session.idle", refreshSelected))
      onCleanup(context.data.on("session.renamed", refreshSelected))
      return
    }
    onCleanup(
      context.data.listen(({ details }) => {
        const id = selectedID()
        if (!id) return
        const before = untrack(localMessages)
        const applied = applyPanelStreamEvent(before, details, id)
        if (applied.next !== before) setLocalMessages(applied.next)
        if (applied.shouldRefetch) void fetchPanelMessages(id)
        if (
          (details.type === "session.idle" ||
            details.type === "session.step.ended" ||
            details.type === "session.inbox.enqueued" ||
            details.type === "session.renamed") &&
          "sessionID" in details.data &&
          details.data.sessionID === id
        ) {
          context.data.session.invalidate(id)
          context.data.session.message.invalidate(id)
          void context.data.session.sync(id).catch(() => undefined)
          void context.data.session.message.sync(id).catch(() => undefined)
          scheduleRefresh()
        }
      }),
    )
  })

  createEffect(
    on(rootSessionID, () => {
      setRemoteItems([])
      setTabWindowStart(0)
      void refresh()
    }),
  )

  let previousItems: readonly HubItem[] = []
  const items = createMemo(() => {
    const next = mergeHubItems(remoteItems(), liveFamilyItems(context, rootSessionID()))
    const stable = stabilizeHubItems(previousItems, next)
    previousItems = stable
    return stable
  })
  const visible = createMemo(() => visibleHubItems(items()))
  const hidden = createMemo(() => hiddenHubItems(items()))
  const selectedID = createMemo(() => resolveSelectedID(items(), props.memory.selectedByRoot[rootSessionID()]))
  const selected = createMemo(() => items().find((item) => item.sessionID === selectedID()))
  const creation = createMemo(() => {
    const request = props.memory.composer
    return request?.rootSessionID === rootSessionID() ? request : undefined
  })

  // Adaptive tab layout matching OpenCode v2 top bar (reserves 4 cols for `+` button)
  // and the tree manager button, whose label grows with the hidden count.
  const treeLabel = createMemo(
    () => `${items().length}${hidden().length > 0 ? ` · ${hidden().length} 收起` : ""}`,
  )
  const treeCompact = createMemo(() => props.input.width < 44)
  const treeButtonText = createMemo(() => (treeCompact() ? `${items().length}` : treeLabel()))
  const treeButtonReserve = createMemo(() =>
    items().length > 0 ? stringWidth(treeButtonText()) + 4 : 0,
  )
  const tabLayout = createMemo(() => {
    const activeID = creation() ? undefined : selectedID()
    const available = Math.max(12, props.input.width - 4 - treeButtonReserve())
    return adaptiveAsideTabLayout(visible(), activeID, available, untrack(tabWindowStart))
  })
  createEffect(() => {
    setTabWindowStart(tabLayout().start)
  })

  const running = createMemo(() => {
    const id = selectedID()
    return id !== undefined && context.data.session.status(id) === "running"
  })
  const spinner = useSpinnerFrame(() => running())
  const messages = createMemo(() => {
    if (nativeTranscript) return []
    const id = selectedID()
    if (!id) return []
    const host = context.data.session.message.list(id)
    const mirror = localMessages()
    return host.length >= mirror.length && host.length > 0 ? host : mirror
  })
  const rows = createMemo(() => formatMessageRows(messages()))
  const composerKey = createMemo(() => {
    const request = creation()
    if (request) return `new:${request.kind}:${request.nonce}`
    return selectedID() ?? "none"
  })
  const agents = createMemo(() => availableSubagents(context.data.location.agent.list(context.location) ?? []))

  createEffect(() => {
    if (!props.input.focused) return
    queueMicrotask(() => {
      const current = context.renderer.currentFocusedRenderable
      if (current === transcript || current === composer) return
      if (nativeTranscript && current instanceof ScrollBoxRenderable) return
      if (composer && !composer.isDestroyed) composer.focus()
    })
  })

  const selectSession = (sessionID: string): void => {
    setUnread((current) => {
      const next = new Set(current)
      next.delete(sessionID)
      return next
    })
    props.updateMemory((draft) => {
      draft.selectedByRoot[rootSessionID()] = sessionID
      draft.composer = null
    })
    props.input.focus()
    queueMicrotask(() => {
      if (composer && !composer.isDestroyed) composer.focus()
    })
  }

  const patchRemoteHidden = (sessionID: string, hidden: boolean): void => {
    setRemoteItems((current) =>
      current.map((item) => (item.sessionID === sessionID && item.hidden !== hidden ? { ...item, hidden } : item)),
    )
  }

  const openTree = (): void => {
    openSessionTreeManager(context, rootSessionID(), props.updateMemory, {
      items,
      selectedID,
      onOpen: (sessionID) => {
        // The tree manager unhides before opening. Make the panel agree
        // immediately instead of waiting for the metadata round-trip.
        patchRemoteHidden(sessionID, false)
        selectSession(sessionID)
      },
      onChanged: () => void refresh(),
    })
  }

  const scrollPosition = () => {
    if (!transcript) return { scrollTop: 0, viewportHeight: 0, scrollHeight: 0 }
    return {
      scrollTop: transcript.scrollTop,
      viewportHeight: transcript.viewport.height,
      scrollHeight: transcript.scrollHeight,
    }
  }
  const syncAway = (): void => {
    if (!transcript || transcript.isDestroyed) return
    const next = isAwayFromBottom(scrollPosition())
    setAway(next)
    transcript.stickyScroll = shouldFollowStreaming(next)
  }
  const saveScroll = (sessionID: string | undefined): void => {
    if (!sessionID || !transcript || transcript.isDestroyed) return
    const offset = transcript.scrollTop
    props.updateMemory((draft) => {
      draft.scrollOffsets[sessionID] = offset
    })
  }
  const jumpToLatest = (): void => {
    if (!transcript || transcript.isDestroyed) return
    setAway(false)
    transcript.stickyScroll = true
    transcript.scrollTo(transcript.scrollHeight)
    transcript.afterLayout(() => transcript?.scrollTo(transcript.scrollHeight))
  }
  const scrollBy = (amount: number): void => {
    if (!transcript || transcript.isDestroyed) return
    transcript.scrollBy(amount)
    if (amount < 0) {
      setAway(true)
      transcript.stickyScroll = false
    }
    queueMicrotask(syncAway)
  }

  createEffect(
    on(selectedID, (sessionID, previous) => {
      if (nativeTranscript) return
      if (previous && previous !== sessionID) saveScroll(previous)
      setExpandedRows(new Set<string>())
      setLocalMessages([])
      if (!sessionID) return
      forceSyncSession(context, sessionID)
      void fetchPanelMessages(sessionID)
      const saved = untrack(() => props.memory.scrollOffsets[sessionID] ?? 0)
      setAway(saved > 0)
      queueMicrotask(() => {
        if (!transcript || selectedID() !== sessionID) return
        transcript.stickyScroll = saved === 0
        transcript.afterLayout(() => {
          if (!transcript || selectedID() !== sessionID) return
          transcript.scrollTo(saved > 0 ? Math.min(saved, maximumScrollTop(scrollPosition())) : transcript.scrollHeight)
          syncAway()
        })
      })
    }),
  )

  createEffect(() => {
    rows()
    const id = selectedID()
    if (!id || away() || !transcript || transcript.isDestroyed) return
    transcript.stickyScroll = true
    transcript.afterLayout(() => {
      if (!away()) transcript?.scrollTo(transcript.scrollHeight)
    })
  })

  const previousStatuses = new Map<string, "idle" | "running">()
  createEffect(() => {
    const currentSelection = selectedID()
    const nextUnread = new Set(untrack(unread))
    for (const item of items()) {
      const status = context.data.session.status(item.sessionID)
      const previous = previousStatuses.get(item.sessionID)
      if (previous === "running" && status === "idle" && item.sessionID !== currentSelection) {
        nextUnread.add(item.sessionID)
      }
      previousStatuses.set(item.sessionID, status)
    }
    if (currentSelection) nextUnread.delete(currentSelection)
    setUnread(nextUnread)
  })

  const hide = async (item: HubItem): Promise<void> => {
    if (item.hidden) return
    if (selectedID() === item.sessionID) {
      const next = nextTabID(items(), item.sessionID, 1)
      if (next && next !== item.sessionID) selectSession(next)
      else props.updateMemory((draft) => delete draft.selectedByRoot[rootSessionID()])
    }
    patchRemoteHidden(item.sessionID, true)
    try {
      await rpc.setHidden({ sessionID: item.sessionID, hidden: true }, rpcOptions(context))
      await refresh()
    } catch (error: unknown) {
      patchRemoteHidden(item.sessionID, false)
      context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    }
  }
  const restore = async (item: HubItem): Promise<void> => {
    if (!item.hidden) {
      selectSession(item.sessionID)
      return
    }
    patchRemoteHidden(item.sessionID, false)
    try {
      await rpc.setHidden({ sessionID: item.sessionID, hidden: false }, rpcOptions(context))
      await refresh()
      selectSession(item.sessionID)
    } catch (error: unknown) {
      patchRemoteHidden(item.sessionID, true)
      context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    }
  }
  const renameTab = async (item: HubItem): Promise<void> => {
    const nextTitle = await context.ui.dialog.prompt({
      title: "Rename session",
      value: item.title || item.label,
      placeholder: "Session title",
    })
    const trimmed = nextTitle?.trim()
    if (!trimmed || trimmed === item.title) return
    try {
      await context.client.session.update({ sessionID: item.sessionID, title: trimmed })
      setRemoteItems((current) =>
        current.map((entry) =>
          entry.sessionID === item.sessionID
            ? { ...entry, title: trimmed, ...(entry.kind === "subagent" ? { label: trimmed } : {}) }
            : entry,
        ),
      )
      context.data.session.invalidate(item.sessionID)
      await context.data.session.sync(item.sessionID)
      await refresh()
    } catch (error: unknown) {
      context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    }
  }
  const toggleReadonly = async (): Promise<void> => {
    const item = selected()
    if (!item || item.kind === "subagent") return
    try {
      await rpc.setReadonly({ sessionID: item.sessionID, readonly: !item.readonly }, rpcOptions(context))
      await refresh()
    } catch (error: unknown) {
      context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    }
  }
  const handoff = async (delivery: DeliveryMode): Promise<void> => {
    const id = selectedID()
    if (!id) return
    try {
      await rpc.handoff({ fromSessionID: id, toSessionID: rootSessionID(), delivery }, rpcOptions(context))
      context.ui.toast.show({
        message: delivery === "park" ? "已挂入主线收件箱（随轮生效）" : "已唤醒主线并送回结论",
        variant: "success",
        sessionID: rootSessionID(),
      })
    } catch (error: unknown) {
      context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    }
  }
  const interrupt = async (): Promise<void> => {
    const id = selectedID()
    if (!id || context.data.session.status(id) !== "running") return
    try {
      await context.client.session.interrupt({ sessionID: id })
    } catch (error: unknown) {
      context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    }
  }
  const openNativeSession = (sessionID: string | undefined): void => {
    if (!sessionID) return
    saveScroll(sessionID)
    props.updateMemory((draft) => {
      draft.nativeReturn = { rootSessionID: rootSessionID(), selectedID: sessionID }
    })
    props.input.close()
    context.ui.router.navigate({ type: "session", sessionID })
  }
  const escape = (): void => {
    if (contextMenu()) {
      setContextMenu(undefined)
      return
    }
    const id = selectedID()
    saveScroll(id)
    composer?.blur()
    context.keymap.dispatch("pane.focus.left")
  }
  const copy = (text: string, id: string): void => {
    const ok = context.renderer.copyToClipboardOSC52(text)
    if (ok) setCopiedID(id)
    context.ui.toast.show({
      message: ok ? "已复制内容" : "剪贴板不可用（OSC52 写入失败）",
      variant: ok ? "success" : "error",
    })
  }
  const copyLatest = (): void => {
    const row = rows().findLast((item) => item.kind === "copy" && item.text.length > 0)
    if (row) copy(row.text, row.id)
  }

  const buildContextMenuItems = (state: ContextMenuState): readonly PopupMenuItem[] => {
    const target = state.item
    const newActions: PopupMenuItem[] = [
      {
        title: "Session tree (find / reopen)",
        run: openTree,
      },
      {
        title: "New /btw aside",
        run: () => openInlineComposer(context, props.updateMemory, rootSessionID(), "btw"),
      },
      {
        title: "New /sub agent",
        run: () =>
          openInlineComposer(
            context,
            props.updateMemory,
            rootSessionID(),
            "sub",
            agents()[0]?.id ?? "explore",
          ),
      },
    ]

    if (target) {
      return [
        ...newActions,
        {
          title: "Rename",
          run: () => void renameTab(target),
        },
        {
          title: "Copy session ID",
          run: () => {
            const ok = context.renderer.copyToClipboardOSC52(target.sessionID)
            context.ui.toast.show({
              message: ok ? "Session ID copied to clipboard" : "Failed to copy session ID",
              variant: ok ? "info" : "error",
            })
          },
        },
        {
          title: "Open native view",
          run: () => openNativeSession(target.sessionID),
        },
        {
          title: "Close",
          run: () => void hide(target),
        },
      ]
    }

    const closed = hidden().slice().reverse().slice(0, 10)
    return [
      ...newActions,
      { title: "Recently closed tabs" },
      ...(closed.length > 0
        ? closed.map((item) => ({
            title: `  ${formatAsideTabTitle(item)}`,
            run: () => void restore(item),
          }))
        : [{ title: "  No recently closed tabs" }]),
    ]
  }

  const submitComposer = async (queue: boolean): Promise<void> => {
    const key = composerKey()
    if (key === "none" || !composer || composer.isDestroyed) return
    const text = composer.plainText.trim()
    if (!text) return
    const request = creation()
    const selectedAtSubmit = selectedID()
    composer.clear()
    props.updateMemory((draft) => {
      draft.drafts = writeDraft(draft.drafts, key, "")
    })
    try {
      if (request?.kind === "btw") {
        await createBtwAside(context, props.updateMemory, {
          sourceSessionID: rootSessionID(),
          rootSessionID: rootSessionID(),
          question: text,
        })
        return
      }
      if (request?.kind === "sub") {
        await createSubAside(context, props.updateMemory, {
          rootSessionID: rootSessionID(),
          agentID: request.agentID ?? agents()[0]?.id ?? "explore",
          task: text,
        })
        return
      }
      if (!selectedAtSubmit) return
      const isRunning = context.data.session.status(selectedAtSubmit) === "running"
      await sendSessionPrompt(
        context,
        selectedAtSubmit,
        text,
        isRunning ? (queue ? "queue" : "steer") : undefined,
        !nativeTranscript,
      )
      if (!nativeTranscript) await fetchPanelMessages(selectedAtSubmit)
    } catch (error: unknown) {
      context.ui.toast.show({ message: errorMessage(error), variant: "error" })
      if (composerKey() === key && composer && !composer.isDestroyed && !composer.plainText) {
        composer.setText(text)
        composer.gotoLineEnd()
      }
    }
  }

  context.keymap.layer(() => ({
    mode: "global",
    enabled: () => props.input.focused,
    priority: 20,
    commands: panelKeybindingCommands({
      cycleTab: (delta) => {
        const next = nextTabID(items(), selectedID(), delta)
        if (next) selectSession(next)
      },
      handoff: (delivery) => void handoff(delivery),
      interrupt: () => void interrupt(),
      escape,
      toggleFullscreen: props.input.toggleFullscreen,
      openTree,
      jumpToLatest: nativeTranscript ? undefined : jumpToLatest,
    }),
  }))

  context.keymap.layer(() => ({
    mode: "global",
    target: () => transcript,
    enabled: () => !nativeTranscript && props.input.focused,
    priority: 21,
    commands: [
      { bind: "up", run: () => scrollBy(-keyboardScrollStep) },
      { bind: "k", run: () => scrollBy(-keyboardScrollStep) },
      { bind: "down", run: () => scrollBy(keyboardScrollStep) },
      { bind: "j", run: () => scrollBy(keyboardScrollStep) },
      { bind: "ctrl+u", run: () => scrollBy(-Math.max(1, Math.floor((transcript?.viewport.height ?? 12) / 2))) },
      { bind: "ctrl+d", run: () => scrollBy(Math.max(1, Math.floor((transcript?.viewport.height ?? 12) / 2))) },
      { bind: "pageup", run: () => scrollBy(-Math.max(1, (transcript?.viewport.height ?? 10) - 1)) },
      { bind: "pagedown", run: () => scrollBy(Math.max(1, (transcript?.viewport.height ?? 10) - 1)) },
      { bind: "home", run: () => transcript?.scrollTo(0) },
      { bind: "g", run: () => transcript?.scrollTo(0) },
      { bind: "end", run: jumpToLatest },
      { bind: "shift+g", run: jumpToLatest },
      { bind: "c", title: "Copy latest assistant answer", run: copyLatest },
    ],
  }))

  onCleanup(() => {
    saveScroll(selectedID())
    removeScrollListener?.()
  })

  const currentAgentID = createMemo(() => {
    const req = creation()
    if (req?.kind === "sub") return req.agentID ?? agents()[0]?.id ?? "explore"
    if (req?.kind === "btw") return context.data.session.get(rootSessionID())?.agent ?? "build"
    return selected()?.agent ?? context.data.session.get(selectedID() ?? "")?.agent ?? "build"
  })
  const currentAccent = createMemo(() =>
    resolveHostAgentAccent(context, currentAgentID(), scrollConfig.newDesigns),
  )
  const currentModelDisplay = createMemo(() => {
    const item = selected()
    if (creation()) return resolveModelDisplay(context, undefined)
    return resolveModelDisplay(context, item?.model)
  })

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      minWidth={0}
      minHeight={0}
      backgroundColor={theme.background.raised.base}
    >
      {/* Layer 1: Adaptive Tab Strip matching OpenCode v2 SessionTabs + Right-Click Context Menu */}
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        alignItems="center"
        justifyContent="space-between"
        backgroundColor={theme.background.base}
        onMouseDown={(event: MouseEvent) => {
          if (event.button === MouseButton.RIGHT) {
            event.preventDefault()
            event.stopPropagation()
            setContextMenu({ x: event.x, y: event.y })
          }
        }}
        onMouseScroll={(event) => {
          const dir = event.scroll?.direction
          if (dir === "up" || dir === "left") {
            const prev = nextTabID(items(), selectedID(), -1)
            if (prev) selectSession(prev)
          } else if (dir === "down" || dir === "right") {
            const next = nextTabID(items(), selectedID(), 1)
            if (next) selectSession(next)
          }
        }}
      >
        <box height={1} flexDirection="row" flexGrow={1} minWidth={0} alignItems="center">
          <Show when={tabLayout().before > 0}>
            <GuiButton
              context={context}
              label={`‹${tabLayout().before}`}
              variant="ghost"
              paddingX={0}
              onActivateHost={props.input.focus}
              onClick={() => {
                const targetIdx = Math.max(0, tabLayout().start - 1)
                const item = visible()[targetIdx]
                if (item) selectSession(item.sessionID)
              }}
            />
          </Show>

          <For each={tabLayout().tabs}>
            {(item, idx) => (
              <AdaptiveTabCell
                context={context}
                item={item}
                width={tabLayout().widths[idx()] ?? 12}
                selected={selectedID() === item.sessionID && !creation()}
                running={context.data.session.status(item.sessionID) === "running"}
                unread={unread().has(item.sessionID)}
                newDesigns={scrollConfig.newDesigns}
                onActivateHost={props.input.focus}
                onSelect={() => selectSession(item.sessionID)}
                onMiddleClose={() => void hide(item)}
                onRightMenu={(event) => setContextMenu({ x: event.x, y: event.y, item })}
              />
            )}
          </For>

          <Show when={tabLayout().after > 0}>
            <GuiButton
              context={context}
              label={`${tabLayout().after}›`}
              variant="ghost"
              paddingX={0}
              onActivateHost={props.input.focus}
              onClick={() => {
                const targetIdx = Math.min(visible().length - 1, tabLayout().start + tabLayout().tabs.length)
                const item = visible()[targetIdx]
                if (item) selectSession(item.sessionID)
              }}
            />
          </Show>
        </box>

        <Show when={items().length > 0}>
          <GuiButton
            context={context}
            icon="⑂"
            label={treeButtonText()}
            variant={hidden().length > 0 ? "warning" : "ghost"}
            onActivateHost={props.input.focus}
            onClick={openTree}
          />
        </Show>
        <GuiButton
          context={context}
          label="+"
          variant="ghost"
          active={Boolean(creation())}
          onActivateHost={props.input.focus}
          onRightClick={(event) => setContextMenu({ x: event.x, y: event.y })}
          onClick={(shift) =>
            openInlineComposer(
              context,
              props.updateMemory,
              rootSessionID(),
              shift ? "sub" : "btw",
              shift ? (agents()[0]?.id ?? "explore") : undefined,
            )
          }
        />
      </box>

      {/* Layer 2: Compact GUI Toolbar */}
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
        marginBottom={1}
        gap={1}
      >
        <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
          <Show when={creation()}>
            <GuiButton
              context={context}
              label="/btw 分身"
              variant="ghost"
              active={creation()?.kind === "btw"}
              onActivateHost={props.input.focus}
              onClick={() => openInlineComposer(context, props.updateMemory, rootSessionID(), "btw")}
            />
            <GuiButton
              context={context}
              label="/sub 专家"
              variant="ghost"
              active={creation()?.kind === "sub"}
              onActivateHost={props.input.focus}
              onClick={() =>
                openInlineComposer(
                  context,
                  props.updateMemory,
                  rootSessionID(),
                  "sub",
                  agents()[0]?.id ?? "explore",
                )
              }
            />
          </Show>
          <Show when={!creation() && selected() && selected()?.kind !== "subagent"}>
            <GuiButton
              context={context}
              label={selected()?.readonly ? "只读保护" : "读写已开"}
              variant={selected()?.readonly ? "success" : "warning"}
              onActivateHost={props.input.focus}
              onClick={() => void toggleReadonly()}
            />
          </Show>
          <Show when={!creation() && selectedID()}>
            <GuiButton
              context={context}
              label="送回主线"
              variant="secondary"
              onActivateHost={props.input.focus}
              onClick={(shift) => void handoff(shift ? "wake" : "park")}
            />
            <GuiButton
              context={context}
              label="唤醒主线"
              variant="secondary"
              onActivateHost={props.input.focus}
              onClick={() => void handoff("wake")}
            />
          </Show>
        </box>

        <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
          <Show when={!creation() && selectedID()}>
            <GuiButton
              context={context}
              label="原生视图"
              variant="ghost"
              onActivateHost={props.input.focus}
              onClick={() => openNativeSession(selectedID())}
            />
          </Show>
          <GuiButton
            context={context}
            label={props.input.presentation === "fullscreen" ? "分屏" : "全屏"}
            icon={props.input.presentation === "fullscreen" ? "❐" : "⤢"}
            variant="ghost"
            onActivateHost={props.input.focus}
            onClick={() => props.input.toggleFullscreen()}
          />
          <GuiButton
            context={context}
            label="收起"
            icon="×"
            variant="ghost"
            onActivateHost={props.input.focus}
            onClick={() => {
              saveScroll(selectedID())
              props.input.close()
            }}
          />
        </box>
      </box>

      {/* Layer 3: Native-aligned Timeline Viewport */}
      <Show when={!nativeTranscript}>
        <box flexGrow={1} flexBasis={0} minHeight={0} position="relative">
          <scrollbox
            ref={(box: ScrollBoxRenderable) => {
              transcript = box
              const update = () => syncAway()
              box.verticalScrollBar.on("change", update)
              removeScrollListener = () => box.verticalScrollBar.off("change", update)
              queueMicrotask(() => {
                if (!away()) jumpToLatest()
              })
            }}
            flexGrow={1}
            minHeight={0}
            stickyScroll={!away()}
            stickyStart="bottom"
            viewportCulling
            scrollAcceleration={scrollAcceleration}
            verticalScrollbarOptions={{
              visible: scrollConfig.scrollbar,
              trackOptions: {
                foregroundColor: theme.scrollbar.base,
                backgroundColor: "transparent",
              },
            }}
            onMouseDown={(event: MouseEvent) => {
              if (event.button !== MouseButton.LEFT) return
              props.input.focus()
              event.stopPropagation()
              if (!context.renderer.hasSelection) {
                transcript?.focus()
              }
            }}
            onMouseScroll={(event) => {
              if (event.scroll?.direction === "up") {
                setAway(true)
                if (transcript) transcript.stickyScroll = false
              }
              queueMicrotask(syncAway)
            }}
          >
            <box flexDirection="column" width="100%" minHeight={0} paddingBottom={1}>
              <Show
                when={!creation() && selectedID()}
                fallback={
                  <Show when={!creation()}>
                    <AsideEmptyState
                      context={context}
                      itemsCount={items().length}
                      hiddenCount={hidden().length}
                      onOpenTree={openTree}
                      onNewBtw={() => openInlineComposer(context, props.updateMemory, rootSessionID(), "btw")}
                      onNewSub={() =>
                        openInlineComposer(
                          context,
                          props.updateMemory,
                          rootSessionID(),
                          "sub",
                          agents()[0]?.id ?? "explore",
                        )
                      }
                      onActivateHost={props.input.focus}
                    />
                  </Show>
                }
              >
                <Show
                  when={rows().length > 0}
                  fallback={
                    <Show when={running()}>
                      <box padding={2}>
                        <text fg={theme.text.muted} selectable={false}>
                          {`${spinner()} 正在思考中…`}
                        </text>
                      </box>
                    </Show>
                  }
                >
                  <For each={rows()}>
                    {(row) => (
                      <TranscriptRow
                        context={context}
                        row={row}
                        theme={theme}
                        newDesigns={scrollConfig.newDesigns}
                        accent={currentAccent()}
                        syntaxStyle={syntaxStyle()}
                        expanded={expandedRows().has(row.id)}
                        copied={copiedID() === row.id}
                        onActivateHost={props.input.focus}
                        onToggle={() =>
                          setExpandedRows((current) => {
                            const next = new Set(current)
                            if (next.has(row.id)) next.delete(row.id)
                            else next.add(row.id)
                            return next
                          })
                        }
                        onCopy={copy}
                      />
                    )}
                  </For>
                </Show>
              </Show>
              <Show when={hubError()}>
                <box paddingLeft={2} paddingRight={2}>
                  <text fg={theme.text.feedback.warning.base} wrapMode="word">{`目录同步失败：${hubError()}`}</text>
                </box>
              </Show>
            </box>
          </scrollbox>

          <Show when={away()}>
            <box position="absolute" right={2} bottom={1} zIndex={2}>
              <GuiButton
                context={context}
                icon="↓"
                label="跳至最新"
                variant="primary"
                onActivateHost={props.input.focus}
                onClick={jumpToLatest}
              />
            </box>
          </Show>
        </box>
      </Show>
      <Show when={nativeTranscript}>
        {(native) => (
          <box flexGrow={1} flexBasis={0} minHeight={0} paddingLeft={1} paddingRight={1}>
            <Show
              when={!creation() && selectedID()}
              keyed
              fallback={
                <Show when={!creation()}>
                  <box flexGrow={1}>
                    <AsideEmptyState
                      context={context}
                      itemsCount={items().length}
                      hiddenCount={hidden().length}
                      onOpenTree={openTree}
                      onNewBtw={() => openInlineComposer(context, props.updateMemory, rootSessionID(), "btw")}
                      onNewSub={() =>
                        openInlineComposer(
                          context,
                          props.updateMemory,
                          rootSessionID(),
                          "sub",
                          agents()[0]?.id ?? "explore",
                        )
                      }
                      onActivateHost={props.input.focus}
                    />
                  </box>
                </Show>
              }
            >
              {(id) =>
                native().transcript({
                  sessionID: id,
                  get width() {
                    return Math.max(24, props.input.width - 2)
                  },
                  onOpenSession: (targetID) => {
                    selectSession(targetID)
                    // A link can arrive before a newly created descendant is listed in the hub.
                    if (!items().some((item) => item.sessionID === targetID)) void refresh()
                  },
                  onActivate: props.input.focus,
                })
              }
            </Show>
            <Show when={hubError()}>
              <box paddingLeft={1} paddingRight={1} flexShrink={0}>
                <text fg={theme.text.feedback.warning.base} wrapMode="word">{`目录同步失败：${hubError()}`}</text>
              </box>
            </Show>
          </box>
        )}
      </Show>

      {/* Layer 4: Clean Graphical Prompt Card */}
      <Show
        when={composerKey() !== "none"}
        fallback={
          <box height={2} flexDirection="row" alignItems="center" justifyContent="center" gap={2} paddingBottom={1}>
            <GuiButton
              context={context}
              icon="+"
              label="新建 /btw"
              variant="primary"
              onActivateHost={props.input.focus}
              onClick={() => openInlineComposer(context, props.updateMemory, rootSessionID(), "btw")}
            />
            <GuiButton
              context={context}
              label="派遣 /sub"
              variant="secondary"
              onActivateHost={props.input.focus}
              onClick={() =>
                openInlineComposer(
                  context,
                  props.updateMemory,
                  rootSessionID(),
                  "sub",
                  agents()[0]?.id ?? "explore",
                )
              }
            />
          </box>
        }
      >
        <box paddingLeft={1} paddingRight={1} flexShrink={0}>
          <GraphicalPromptCard
            context={context}
            syntaxStyle={syntaxStyle()}
            valueKey={composerKey()}
            initialValue={readDraft(props.memory.drafts, composerKey())}
            placeholder={
              creation()?.kind === "sub"
                ? "输入独立子代理任务…"
                : creation()?.kind === "btw"
                  ? "问一个旁路问题…"
                  : running()
                    ? "实时插队纠偏…"
                    : "追问…"
            }
            agentLabel={titlecaseAgent(currentAgentID())}
            agentAccent={currentAccent()}
            modelLabel={currentModelDisplay().modelName}
            providerLabel={currentModelDisplay().providerName}
            variantLabel={currentModelDisplay().variant}
            statusLabel={running() ? "运行中" : undefined}
            running={running()}
            onActivateHost={props.input.focus}
            inputRef={(area) => {
              composer = area
              if (area && (creation() || props.input.focused)) {
                queueMicrotask(() => {
                  if (!area.isDestroyed) area.focus()
                })
              }
            }}
            topSlot={
              creation()?.kind === "sub" && agents().length > 0 ? (
                <tab_select
                  ref={(tabs: TabSelectRenderable) => {
                    const idx = Math.max(
                      0,
                      agents().findIndex((a) => a.id === creation()?.agentID),
                    )
                    tabs.setSelectedIndex(idx)
                    const onChanged = (_i: number, opt: TabSelectOption) => {
                      const val = typeof opt.value === "string" ? opt.value : opt.name.replace(/^@/, "")
                      props.updateMemory((draft) => {
                        if (draft.composer) draft.composer.agentID = val
                      })
                    }
                    tabs.on(TabSelectRenderableEvents.SELECTION_CHANGED, onChanged)
                    onCleanup(() => tabs.off(TabSelectRenderableEvents.SELECTION_CHANGED, onChanged))
                  }}
                  width={Math.max(24, props.input.width - 8)}
                  height={1}
                  tabWidth={14}
                  showDescription={false}
                  showUnderline={false}
                  showScrollArrows
                  wrapSelection
                  backgroundColor="transparent"
                  focusedBackgroundColor="transparent"
                  textColor={theme.text.muted}
                  focusedTextColor={theme.text.base}
                  selectedBackgroundColor={theme.hue.interactive[700]}
                  selectedTextColor={theme.text.base}
                  options={agents().map((agent) => ({
                    name: `@${agent.id}`,
                    description: "",
                    value: agent.id,
                  }))}
                  onMouseDown={(event: MouseEvent) => {
                    if (event.button !== MouseButton.LEFT) return
                    props.input.focus()
                    event.stopPropagation()
                    event.currentTarget?.focus()
                  }}
                />
              ) : undefined
            }
            actions={
              <>
                <Show when={running()}>
                  <GuiButton
                    context={context}
                    label="中断"
                    variant="warning"
                    onActivateHost={props.input.focus}
                    onClick={() => void interrupt()}
                  />
                </Show>
                <GuiButton
                  context={context}
                  label={running() ? "纠偏" : creation() ? "创建" : "发送"}
                  variant="primary"
                  onActivateHost={props.input.focus}
                  onClick={(shift) => void submitComposer(shift)}
                />
              </>
            }
            onDraftChange={(value) => {
              const key = composerKey()
              props.updateMemory((draft) => {
                draft.drafts = writeDraft(draft.drafts, key, value)
              })
            }}
            onSubmit={(queue) => void submitComposer(queue)}
            onInterrupt={() => void interrupt()}
            onEscape={escape}
          />
        </box>
      </Show>

      <Show when={contextMenu()}>
        {(menu) => (
          <PopupContextMenu
            context={context}
            x={menu().x}
            y={menu().y}
            items={buildContextMenuItems(menu())}
            onClose={() => setContextMenu(undefined)}
          />
        )}
      </Show>
    </box>
  )
}
