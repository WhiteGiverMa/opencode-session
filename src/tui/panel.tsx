import type { Plugin } from "@opencode/plugin/tui"
import {
  MouseButton,
  TabSelectRenderableEvents,
  TextAttributes,
  type KeyEvent,
  type MouseEvent,
  type ScrollBoxRenderable,
  type TabSelectOption,
  type TabSelectRenderable,
  type TextareaRenderable,
} from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack } from "solid-js"
import type { Store } from "solid-js/store"
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
  availableSubagents,
  errorMessage,
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
  visibleHubItems,
  writeDraft,
  type MessageRow,
  type TuiMemoryState,
  type UpdateTuiMemory,
} from "./state.ts"
import {
  createHostScrollAcceleration,
  EmptyBorder,
  GraphicalPromptCard,
  GuiButton,
  readHostCliScrollConfig,
  resolveAgentAccent,
  setPointer,
  titlecaseAgent,
  useHostSyntaxStyle,
} from "./ui-primitives.tsx"

type Theme = Plugin.Context["theme"]

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

function tabLabel(item: HubItem): string {
  const shortText = (item.label || item.title).slice(0, 22)
  if (item.kind === "btw") {
    const alias = item.alias.startsWith("#") ? item.alias : `#${item.index}`
    return `◈ ${alias} ${shortText}`
  }
  if (item.kind === "sub") return `✦ @${item.agent ?? "agent"} ${shortText}`
  return `${"›".repeat(Math.max(0, item.depth - 1))}@${item.agent ?? "agent"} ${shortText}`
}

function SessionTabPill(props: {
  readonly context: Plugin.Context
  readonly item: HubItem
  readonly selected: boolean
  readonly running: boolean
  readonly unread: boolean
  readonly onActivateHost: () => void
  readonly onSelect: () => void
  readonly onHide?: () => void
}) {
  const theme = props.context.theme
  const [hovered, setHovered] = createSignal(false)
  const [closeHovered, setCloseHovered] = createSignal(false)
  const accent = createMemo(() => resolveAgentAccent(theme, props.item.agent))

  onCleanup(() => {
    if (hovered() || closeHovered()) setPointer(props.context, "default")
  })

  const bg = createMemo(() => {
    if (props.selected) return theme.background.raised.max
    if (hovered()) return theme.background.raised.high
    return theme.background.raised.base
  })

  return (
    <box
      height={1}
      flexShrink={0}
      flexDirection="row"
      backgroundColor={bg()}
      border={["left"]}
      borderColor={props.selected ? accent() : bg()}
      customBorderChars={{
        ...EmptyBorder,
        vertical: props.selected ? "┃" : " ",
      }}
    >
      <box
        height={1}
        paddingLeft={1}
        paddingRight={props.onHide ? 0 : 1}
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
          event.stopPropagation()
          props.onSelect()
        }}
      >
        <text
          fg={props.selected || hovered() ? theme.text.base : theme.text.muted}
          attributes={props.selected ? TextAttributes.BOLD : undefined}
          wrapMode="none"
          selectable={false}
        >
          {tabLabel(props.item)}
          <Show when={props.running}>
            <span style={{ fg: theme.text.feedback.info.base }}>{" ●"}</span>
          </Show>
          <Show when={!props.running && props.unread}>
            <span style={{ fg: theme.text.feedback.warning.base }}>{" •"}</span>
          </Show>
        </text>
      </box>
      <Show when={props.onHide}>
        {(onHide) => (
          <box
            height={1}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={closeHovered() ? theme.background.raised.max : undefined}
            onMouseOver={() => {
              setCloseHovered(true)
              setPointer(props.context, "pointer")
            }}
            onMouseOut={() => {
              setCloseHovered(false)
              setPointer(props.context, "default")
            }}
            onMouseDown={(event: MouseEvent) => {
              if (event.button !== MouseButton.LEFT) return
              props.onActivateHost()
              event.stopPropagation()
            }}
            onMouseUp={(event: MouseEvent) => {
              if (event.button !== MouseButton.LEFT) return
              event.stopPropagation()
              onHide()()
            }}
          >
            <text
              fg={closeHovered() ? theme.text.feedback.error.base : theme.text.faint}
              wrapMode="none"
              selectable={false}
            >
              ×
            </text>
          </box>
        )}
      </Show>
    </box>
  )
}

function TranscriptRow(props: {
  readonly context: Plugin.Context
  readonly row: MessageRow
  readonly theme: Theme
  readonly accent: ReturnType<typeof resolveAgentAccent>
  readonly syntaxStyle: ReturnType<ReturnType<typeof useHostSyntaxStyle>>
  readonly expanded: boolean
  readonly copied: boolean
  readonly onActivateHost: () => void
  readonly onToggle: () => void
  readonly onCopy: (text: string, id: string) => void
}) {
  const row = props.row
  const [reasonHover, setReasonHover] = createSignal(false)

  if (row.kind === "reasoning") {
    const seconds = row.elapsedMs === undefined ? "" : ` ${(row.elapsedMs / 1000).toFixed(1)}s`
    return (
      <box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={2}
        paddingRight={1}
        marginBottom={1}
      >
        <box
          height={1}
          flexShrink={0}
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={reasonHover() ? props.theme.background.raised.high : undefined}
          onMouseOver={() => {
            setReasonHover(true)
            setPointer(props.context, "pointer")
          }}
          onMouseOut={() => {
            setReasonHover(false)
            setPointer(props.context, "default")
          }}
          onMouseDown={(event: MouseEvent) => {
            if (event.button !== MouseButton.LEFT) return
            props.onActivateHost()
            event.stopPropagation()
          }}
          onMouseUp={(event: MouseEvent) => {
            if (event.button !== MouseButton.LEFT) return
            event.stopPropagation()
            props.onToggle()
          }}
          onKeyDown={(event: KeyEvent) => {
            if (event.name !== "space") return
            event.preventDefault()
            props.onToggle()
          }}
        >
          <text fg={reasonHover() ? props.theme.text.base : props.theme.text.muted} wrapMode="none" selectable={false}>
            {`${props.expanded ? "▾" : "▸"} 思考过程${seconds}`}
            <Show when={!props.expanded}>
              <span style={{ fg: props.theme.text.faint }}>{` · ${row.preview}`}</span>
            </Show>
          </text>
        </box>
        <Show when={props.expanded}>
          <box
            border={["left"]}
            borderColor={props.theme.border.base}
            customBorderChars={{ ...EmptyBorder, vertical: "│" }}
            paddingLeft={2}
            marginLeft={1}
          >
            <text fg={props.theme.text.muted} wrapMode="word">
              {row.text}
            </text>
          </box>
        </Show>
      </box>
    )
  }

  if (row.kind === "tool") {
    return (
      <box flexDirection="column" flexShrink={0} paddingLeft={3} paddingRight={2} marginBottom={row.status === "error" ? 1 : 0}>
        <text
          fg={row.status === "error" ? props.theme.text.feedback.error.base : props.theme.text.muted}
          wrapMode="none"
          truncate={row.status !== "error"}
        >
          {row.text}
        </text>
        <Show when={row.status === "error" && row.error}>
          {(error) => <text fg={props.theme.text.feedback.error.muted} wrapMode="word">{`  ${error()}`}</text>}
        </Show>
      </box>
    )
  }

  if (row.kind === "copy") {
    return (
      <box height={1} flexShrink={0} flexDirection="row" justifyContent="flex-end" paddingRight={2} marginBottom={1}>
        <GuiButton
          context={props.context}
          label={props.copied ? "已复制" : "复制"}
          icon={props.copied ? "✓" : "⧉"}
          shortcut={props.copied ? undefined : "c"}
          variant={props.copied ? "success" : "ghost"}
          onActivateHost={props.onActivateHost}
          onClick={() => props.onCopy(row.text, row.id)}
        />
      </box>
    )
  }

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
      customBorderChars={{ ...EmptyBorder, vertical: "┃" }}
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
            {row.kind === "synthetic" ? "◈ 跨会话投递" : "系统提示"}
          </text>
        </Show>
        <text fg={props.theme.text.base} wrapMode="word">
          {row.text}
        </text>
      </box>
    </box>
  )
}

export function SessionPanel(props: SessionPanelProps) {
  const context = props.context
  const theme = context.theme
  const rpc = context.client.rpc(SessionRpc)
  const syntaxStyle = useHostSyntaxStyle(context)
  const scrollConfig = readHostCliScrollConfig()
  const scrollAcceleration = createHostScrollAcceleration(scrollConfig)
  const keyboardScrollStep = Math.max(1, Math.round(scrollConfig.speed))

  const rootSessionID = createMemo(() => resolveRootSessionID(context, props.input.sessionID))
  const [remoteItems, setRemoteItems] = createSignal<readonly HubItem[]>([])
  const [hubError, setHubError] = createSignal("")
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [expandedReasoning, setExpandedReasoning] = createSignal<ReadonlySet<string>>(new Set())
  const [away, setAway] = createSignal(false)
  const [unread, setUnread] = createSignal<ReadonlySet<string>>(new Set())
  const [copiedID, setCopiedID] = createSignal("")
  let refreshRevision = 0
  let transcript: ScrollBoxRenderable | undefined
  let composer: TextareaRenderable | undefined
  let removeScrollListener: (() => void) | undefined

  const refresh = async (): Promise<void> => {
    const root = rootSessionID()
    const revision = ++refreshRevision
    try {
      const result = await rpc.listHub({ rootSessionID: root }, rpcOptions(context))
      if (revision !== refreshRevision || root !== rootSessionID()) return
      setRemoteItems(result.items)
      setHubError("")
    } catch (error: unknown) {
      if (revision === refreshRevision) setHubError(errorMessage(error))
    }
  }

  onMount(() => {
    const off = rpc.events.on("updated", (event) => {
      if (event.data.rootSessionID === rootSessionID()) void refresh()
    })
    const offEvents = context.data.listen(({ details }) => {
      const id = selectedID()
      if (!id) return
      if (
        (details.type === "session.idle" ||
          details.type === "session.step.ended" ||
          details.type === "session.inbox.enqueued") &&
        "sessionID" in details.data &&
        details.data.sessionID === id
      ) {
        context.data.session.message.invalidate(id)
        void context.data.session.message.sync(id).catch(() => undefined)
      }
    })
    onCleanup(() => {
      off()
      offEvents()
    })
  })

  createEffect(
    on(rootSessionID, () => {
      setRemoteItems([])
      setHistoryOpen(false)
      void refresh()
    }),
  )

  const items = createMemo(() => mergeHubItems(remoteItems(), liveFamilyItems(context, rootSessionID())))
  const visible = createMemo(() => visibleHubItems(items()))
  const hidden = createMemo(() => hiddenHubItems(items()))
  const selectedID = createMemo(() => resolveSelectedID(items(), props.memory.selectedByRoot[rootSessionID()]))
  const selected = createMemo(() => items().find((item) => item.sessionID === selectedID()))
  const creation = createMemo(() => {
    const request = props.memory.composer
    return request?.rootSessionID === rootSessionID() ? request : undefined
  })
  const running = createMemo(() => {
    const id = selectedID()
    return id !== undefined && context.data.session.status(id) === "running"
  })
  const messages = createMemo(() => {
    const id = selectedID()
    return id ? context.data.session.message.list(id) : []
  })
  const rows = createMemo(() => formatMessageRows(messages()))
  const composerKey = createMemo(() => {
    const request = creation()
    if (request) return `new:${request.kind}:${request.nonce}`
    return selectedID() ?? "none"
  })
  const agents = createMemo(() => availableSubagents(context.data.location.agent.list(context.location) ?? []))

  // Ensure keyboard focus lands inside composer whenever the host focuses the panel shell
  createEffect(() => {
    if (!props.input.focused) return
    queueMicrotask(() => {
      const current = context.renderer.currentFocusedRenderable
      if (current === transcript || current === composer) return
      if (composer && !composer.isDestroyed) composer.focus()
    })
  })

  const select = (sessionID: string): void => {
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
      if (previous && previous !== sessionID) saveScroll(previous)
      setHistoryOpen(false)
      setExpandedReasoning(new Set<string>())
      if (!sessionID) return
      forceSyncSession(context, sessionID)
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
    if (selectedID() === item.sessionID) {
      const next = nextTabID(items(), item.sessionID, 1)
      if (next && next !== item.sessionID) select(next)
      else props.updateMemory((draft) => delete draft.selectedByRoot[rootSessionID()])
    }
    try {
      await rpc.setHidden({ sessionID: item.sessionID, hidden: true }, rpcOptions(context))
      await refresh()
    } catch (error: unknown) {
      context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    }
  }
  const restore = async (item: HubItem): Promise<void> => {
    try {
      await rpc.setHidden({ sessionID: item.sessionID, hidden: false }, rpcOptions(context))
      await refresh()
      select(item.sessionID)
      if (hidden().length === 0) setHistoryOpen(false)
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
        message: delivery === "park" ? "已挂入主线收件箱（随轮生效）" : "已唤醒主线并送回最新结论",
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
  const openNative = (): void => {
    const id = selectedID()
    if (!id) return
    saveScroll(id)
    props.updateMemory((draft) => {
      draft.nativeReturn = { rootSessionID: rootSessionID(), selectedID: id }
    })
    props.input.close()
    context.ui.router.navigate({ type: "session", sessionID: id })
  }
  const escape = (): void => {
    if (historyOpen()) {
      setHistoryOpen(false)
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
      message: ok ? "已复制助手回复" : "剪贴板不可用（OSC52 写入失败）",
      variant: ok ? "success" : "error",
    })
  }
  const copyLatest = (): void => {
    const row = rows().findLast((item) => item.kind === "copy")
    if (row) copy(row.text, row.id)
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
      await sendSessionPrompt(context, selectedAtSubmit, text, isRunning ? (queue ? "queue" : "steer") : undefined)
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
        if (next) select(next)
      },
      handoff: (delivery) => void handoff(delivery),
      interrupt: () => void interrupt(),
      escape,
      toggleFullscreen: props.input.toggleFullscreen,
      jumpToLatest,
    }),
  }))

  context.keymap.layer(() => ({
    mode: "global",
    target: () => transcript,
    enabled: () => props.input.focused,
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
    if (req?.kind === "btw") return context.data.session.get(rootSessionID())?.agent ?? "btw"
    return selected()?.agent ?? context.data.session.get(selectedID() ?? "")?.agent ?? "aside"
  })
  const currentAccent = createMemo(() => resolveAgentAccent(theme, currentAgentID()))
  const currentModelDisplay = createMemo(() => {
    const item = selected()
    if (creation()) return resolveModelDisplay(context, undefined)
    return resolveModelDisplay(context, item?.model)
  })
  const footerHint = () => {
    if (creation()) return "Enter 创建并发送  ·  Shift+Enter 换行  ·  Esc 回主会话"
    return running()
      ? "Enter 插队纠偏(Steer)  ·  Alt+Enter 排队  ·  Ctrl+X 中断  ·  Esc 回主会话"
      : "Enter 追问  ·  Alt+[ / ] 切标签  ·  Ctrl+H 送回主线  ·  Esc 回主会话"
  }

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      minWidth={0}
      minHeight={0}
      backgroundColor={theme.background.raised.base}
    >
      {/* Layer 1: GUI Tab Strip with hoverable pills and non-destructive history drawer */}
      <box
        height={1}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
        backgroundColor={theme.background.base}
        paddingLeft={1}
        paddingRight={1}
        gap={1}
      >
        <scrollbox
          height={1}
          flexGrow={1}
          flexBasis={0}
          minWidth={0}
          scrollX
          scrollY={false}
          scrollbarOptions={{ visible: false }}
        >
          <box flexDirection="row" flexShrink={0} gap={1}>
            <For each={visible()}>
              {(item) => (
                <SessionTabPill
                  context={context}
                  item={item}
                  selected={selectedID() === item.sessionID && !creation()}
                  running={context.data.session.status(item.sessionID) === "running"}
                  unread={unread().has(item.sessionID)}
                  onActivateHost={props.input.focus}
                  onSelect={() => select(item.sessionID)}
                  onHide={item.kind !== "subagent" ? () => void hide(item) : undefined}
                />
              )}
            </For>
          </box>
        </scrollbox>

        <box flexDirection="row" flexShrink={0} gap={1}>
          <GuiButton
            context={context}
            icon="+"
            label="btw"
            variant="secondary"
            active={creation()?.kind === "btw"}
            onActivateHost={props.input.focus}
            onClick={() => openInlineComposer(context, props.updateMemory, rootSessionID(), "btw")}
          />
          <GuiButton
            context={context}
            icon="✦"
            label="sub"
            variant="secondary"
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
          <Show when={hidden().length > 0 || historyOpen()}>
            <GuiButton
              context={context}
              icon={historyOpen() ? "▴" : "▾"}
              label={`历史 ${hidden().length}`}
              variant="ghost"
              active={historyOpen()}
              onActivateHost={props.input.focus}
              onClick={() => setHistoryOpen((value) => !value)}
            />
          </Show>
        </box>
      </box>

      <Show when={historyOpen()}>
        <box
          flexDirection="column"
          flexShrink={0}
          backgroundColor={theme.background.raised.high}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
          border={["bottom"]}
          borderColor={theme.border.base}
        >
          <Show when={hidden().length > 0} fallback={<text fg={theme.text.muted}>暂无已收起的旁路标签</text>}>
            <For each={hidden()}>
              {(item) => (
                <box flexDirection="row" height={1} flexShrink={0} justifyContent="space-between" alignItems="center">
                  <text fg={theme.text.base} wrapMode="none" truncate selectable={false}>
                    {tabLabel(item)}
                  </text>
                  <GuiButton
                    context={context}
                    label="恢复标签"
                    icon="↺"
                    variant="secondary"
                    onActivateHost={props.input.focus}
                    onClick={() => void restore(item)}
                  />
                </box>
              )}
            </For>
          </Show>
        </box>
      </Show>

      {/* Layer 2: Highlighted GUI Toolbar (no ASCII brackets) */}
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
          <Show when={!creation() && selected() && selected()?.kind !== "subagent"}>
            <GuiButton
              context={context}
              icon={selected()?.readonly ? "●" : "◆"}
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
              shortcut="↵"
              variant="secondary"
              onActivateHost={props.input.focus}
              onClick={(shift) => void handoff(shift ? "wake" : "park")}
            />
            <GuiButton
              context={context}
              icon="⚡"
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
              shortcut="↗"
              variant="ghost"
              onActivateHost={props.input.focus}
              onClick={openNative}
            />
          </Show>
          <GuiButton
            context={context}
            label={props.input.presentation === "fullscreen" ? "退出全屏" : "全屏"}
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

      {/* Layer 3: Streaming Markdown Transcript with host-matched ScrollAcceleration & click-to-focus */}
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
                <box padding={2}>
                  <text fg={theme.text.muted} selectable={false}>
                    {creation()
                      ? `在下方输入框输入内容，立即开启新的 /${creation()?.kind} 旁路对话。`
                      : "使用 /btw、/sub 或点击右上角 +btw / ✦sub 创建旁路会话。"}
                  </text>
                </box>
              }
            >
              <Show
                when={rows().length > 0}
                fallback={
                  <box padding={2}>
                    <text fg={theme.text.muted} selectable={false}>
                      {running() ? "● 正在流式生成中…" : "暂无消息，点击下方输入框直接追问。"}
                    </text>
                  </box>
                }
              >
                <For each={rows()}>
                  {(row) => (
                    <TranscriptRow
                      context={context}
                      row={row}
                      theme={theme}
                      accent={currentAccent()}
                      syntaxStyle={syntaxStyle()}
                      expanded={expandedReasoning().has(row.id)}
                      copied={copiedID() === row.id}
                      onActivateHost={props.input.focus}
                      onToggle={() =>
                        setExpandedReasoning((current) => {
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

      {/* Layer 4: Graphical OpenCode-native Prompt Card with focus indicator & GUI buttons */}
      <Show
        when={composerKey() !== "none"}
        fallback={
          <box height={3} flexDirection="row" alignItems="center" justifyContent="center" gap={2} paddingBottom={1}>
            <GuiButton
              context={context}
              icon="+"
              label="新建 /btw 平行分身"
              variant="primary"
              onActivateHost={props.input.focus}
              onClick={() => openInlineComposer(context, props.updateMemory, rootSessionID(), "btw")}
            />
            <GuiButton
              context={context}
              icon="✦"
              label="直派 /sub 专家"
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
        <box paddingLeft={1} paddingRight={1} paddingBottom={1} flexShrink={0}>
          <GraphicalPromptCard
            context={context}
            syntaxStyle={syntaxStyle()}
            valueKey={composerKey()}
            initialValue={readDraft(props.memory.drafts, composerKey())}
            placeholder={
              creation()?.kind === "sub"
                ? "给专家派遣一个独立调查或审查任务…"
                : creation()?.kind === "btw"
                  ? "问一个继承当前上下文但不污染主线的问题…"
                  : running()
                    ? "输入内容实时插队纠偏（Steer）…"
                    : "继续追问当前会话…"
            }
            agentLabel={titlecaseAgent(currentAgentID())}
            agentAccent={currentAccent()}
            modelLabel={currentModelDisplay().modelName}
            providerLabel={currentModelDisplay().providerName}
            variantLabel={currentModelDisplay().variant}
            statusLabel={running() ? "运行中 ●" : undefined}
            running={running()}
            footerHint={footerHint()}
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
                  selectedBackgroundColor={theme.background.action.primary.selected}
                  selectedTextColor={theme.text.action.primary.selected}
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
                    shortcut="ctrl+x"
                    variant="warning"
                    onActivateHost={props.input.focus}
                    onClick={() => void interrupt()}
                  />
                </Show>
                <GuiButton
                  context={context}
                  label={running() ? "纠偏" : creation() ? "创建" : "发送"}
                  shortcut="↵"
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
    </box>
  )
}
