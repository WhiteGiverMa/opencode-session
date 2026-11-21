import type { Plugin } from "@opencode/plugin/tui"
import {
  InputRenderable,
  MouseButton,
  ScrollBoxRenderable,
  TextAttributes,
  type MouseEvent,
} from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { PANEL_NAME, SessionRpc, type HubItem } from "../contract.ts"
import {
  errorMessage,
  filterSessionTree,
  formatSessionTreeMeta,
  liveFamilyItems,
  mergeHubItems,
  rpcOptions,
  sessionTreeKindBadge,
  sessionTreeTitle,
  type SessionTreeRow,
  type UpdateTuiMemory,
} from "./state.ts"
import { setPointer } from "./ui-primitives.tsx"

export interface SessionTreeManagerOptions {
  /** Live panel items; omit to fetch the hub when the dialog opens. */
  readonly items?: () => readonly HubItem[]
  readonly selectedID?: () => string | undefined
  /** Overrides how a selected session is opened (the aside panel uses its own tab selection). */
  readonly onOpen?: (sessionID: string) => void
  /** Called after hide/unhide/open so the owner can refresh its own listing. */
  readonly onChanged?: () => void
}

interface SessionTreeManagerProps extends SessionTreeManagerOptions {
  readonly context: Plugin.Context
  readonly rootSessionID: string
  readonly updateMemory: UpdateTuiMemory
}

const KIND_COLORS = {
  btw: "warning",
  sub: "info",
  subagent: "success",
} as const

function SessionTreeManager(props: SessionTreeManagerProps) {
  const context = props.context
  const theme = context.theme
  const rpc = context.client.rpc(SessionRpc)
  const dimensions = useTerminalDimensions()
  const [fetched, setFetched] = createSignal<readonly HubItem[]>([])
  const [loading, setLoading] = createSignal(!props.items)
  const [error, setError] = createSignal("")
  const [patches, setPatches] = createSignal<ReadonlyMap<string, boolean>>(new Map())
  const [query, setQuery] = createSignal("")
  const [cursor, setCursor] = createSignal(0)
  const [hovered, setHovered] = createSignal<number>()
  let scroll: ScrollBoxRenderable | undefined
  let input: InputRenderable | undefined
  let loadRevision = 0

  const load = async (): Promise<void> => {
    const revision = ++loadRevision
    const showLoading = fetched().length === 0
    if (showLoading) setLoading(true)
    try {
      const result = await rpc.listHub({ rootSessionID: props.rootSessionID }, rpcOptions(context))
      if (revision !== loadRevision) return
      setFetched(mergeHubItems(result.items, liveFamilyItems(context, props.rootSessionID)))
      setError("")
    } catch (failure: unknown) {
      if (revision === loadRevision) setError(errorMessage(failure))
    } finally {
      if (revision === loadRevision && showLoading) setLoading(false)
    }
  }

  onMount(() => {
    context.ui.dialog.set({ size: "large" })
    if (props.items) {
      setLoading(false)
    } else {
      void load()
      const off = rpc.events.on("updated", (event) => {
        if (event.data.rootSessionID === props.rootSessionID) void load()
      })
      onCleanup(off)
    }
    setTimeout(() => {
      if (input && !input.isDestroyed) input.focus()
    }, 1)
  })

  onCleanup(() => setPointer(context, "default"))

  const items = createMemo(() => {
    const base = props.items ? props.items() : fetched()
    const changed = patches()
    if (changed.size === 0) return base
    return base.map((item) => {
      const hidden = changed.get(item.sessionID)
      return hidden === undefined || hidden === item.hidden ? item : { ...item, hidden }
    })
  })
  const hiddenCount = createMemo(() => items().filter((item) => item.hidden).length)
  const result = createMemo(() => filterSessionTree(items(), query()))
  const rows = () => result().rows

  const running = (sessionID: string): boolean => context.data.session.status(sessionID) === "running"

  const patchHidden = (sessionID: string, hidden: boolean): void => {
    setPatches((current) => {
      const next = new Map(current)
      next.set(sessionID, hidden)
      return next
    })
  }

  const move = (delta: number): void => {
    const count = rows().length
    if (count === 0) return
    setCursor((current) => ((current + delta) % count + count) % count)
  }

  createEffect(() => {
    const count = rows().length
    setCursor((current) => (count === 0 ? 0 : Math.max(0, Math.min(current, count - 1))))
  })

  let seeded = false
  createEffect(() => {
    if (seeded) return
    const list = rows()
    if (list.length === 0) return
    seeded = true
    const preferred = props.selectedID?.()
    const preferredIndex = preferred ? list.findIndex((row) => row.item.sessionID === preferred) : -1
    const hiddenIndex = list.findIndex((row) => row.item.hidden)
    setCursor(preferredIndex >= 0 ? preferredIndex : hiddenIndex >= 0 ? hiddenIndex : 0)
  })

  createEffect(() => {
    const index = cursor()
    void rows().length
    const view = scroll
    if (!view || view.isDestroyed) return
    const height = Math.max(1, view.viewport.height)
    const top = view.scrollTop
    if (index < top) view.scrollTo(index)
    else if (index >= top + height) view.scrollTo(index - height + 1)
  })

  const close = (): void => context.ui.dialog.clear()

  const activate = async (row: SessionTreeRow): Promise<void> => {
    const sessionID = row.item.sessionID
    if (row.item.hidden) {
      try {
        await rpc.setHidden({ sessionID, hidden: false }, rpcOptions(context))
        patchHidden(sessionID, false)
      } catch (failure: unknown) {
        context.ui.toast.show({ message: errorMessage(failure), variant: "error" })
        return
      }
    }
    close()
    if (props.onOpen) {
      props.onOpen(sessionID)
    } else {
      props.updateMemory((draft) => {
        draft.selectedByRoot[props.rootSessionID] = sessionID
        draft.composer = null
      })
      context.ui.panel.open(PANEL_NAME)
    }
    props.onChanged?.()
  }

  const hide = async (row: SessionTreeRow): Promise<void> => {
    if (row.item.hidden) return
    const sessionID = row.item.sessionID
    patchHidden(sessionID, true)
    try {
      await rpc.setHidden({ sessionID, hidden: true }, rpcOptions(context))
      props.onChanged?.()
    } catch (failure: unknown) {
      patchHidden(sessionID, false)
      context.ui.toast.show({ message: errorMessage(failure), variant: "error" })
    }
  }

  const unhide = async (row: SessionTreeRow): Promise<void> => {
    if (!row.item.hidden) return
    const sessionID = row.item.sessionID
    patchHidden(sessionID, false)
    try {
      await rpc.setHidden({ sessionID, hidden: false }, rpcOptions(context))
      props.onChanged?.()
    } catch (failure: unknown) {
      patchHidden(sessionID, true)
      context.ui.toast.show({ message: errorMessage(failure), variant: "error" })
    }
  }

  const interrupt = async (row: SessionTreeRow): Promise<void> => {
    const sessionID = row.item.sessionID
    if (!running(sessionID)) {
      context.ui.toast.show({ message: "该会话当前未在运行", variant: "info" })
      return
    }
    try {
      await context.client.session.interrupt({ sessionID })
    } catch (failure: unknown) {
      context.ui.toast.show({ message: errorMessage(failure), variant: "error" })
    }
  }

  const currentRow = (): SessionTreeRow | undefined => rows()[cursor()]

  context.keymap.layer(() => ({
    mode: "modal",
    // Above the aside panel's global layer so Escape closes this dialog
    // instead of moving pane focus behind it.
    priority: 30,
    commands: [
      { bind: "escape", title: "Close session tree", group: "Session tree", run: close },
      { bind: "down,ctrl+n", title: "Next session", group: "Session tree", run: () => move(1) },
      { bind: "up,ctrl+p", title: "Previous session", group: "Session tree", run: () => move(-1) },
      { bind: "pagedown", title: "Page down", group: "Session tree", run: () => move(10) },
      { bind: "pageup", title: "Page up", group: "Session tree", run: () => move(-10) },
      { bind: "home", title: "First session", group: "Session tree", run: () => setCursor(0) },
      {
        bind: "end",
        title: "Last session",
        group: "Session tree",
        run: () => setCursor(Math.max(0, rows().length - 1)),
      },
      {
        bind: "return",
        title: "Unhide and open session",
        group: "Session tree",
        run: () => {
          const row = currentRow()
          if (row) void activate(row)
        },
      },
      {
        bind: "alt+h",
        title: "Hide selected session",
        group: "Session tree",
        run: () => {
          const row = currentRow()
          if (row) void hide(row)
        },
      },
      {
        bind: "alt+u",
        title: "Unhide selected session",
        group: "Session tree",
        run: () => {
          const row = currentRow()
          if (row) void unhide(row)
        },
      },
      {
        bind: "alt+i",
        title: "Interrupt selected session",
        group: "Session tree",
        run: () => {
          const row = currentRow()
          if (row) void interrupt(row)
        },
      },
    ],
  }))

  const listHeight = createMemo(() => {
    const available = Math.floor(dimensions().height / 2) - 5
    return Math.max(3, Math.min(Math.max(rows().length, 1), available))
  })

  const kindColor = (row: SessionTreeRow) => theme.text.feedback[KIND_COLORS[row.item.kind]].base
  const rowColor = (row: SessionTreeRow) => {
    if (result().context.has(row.item.sessionID)) return theme.text.faint
    if (row.item.hidden) return theme.text.muted
    return theme.text.base
  }

  return (
    <box flexDirection="column" paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <box flexDirection="row" gap={1}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD} selectable={false}>
            Session tree
          </text>
          <text fg={theme.text.muted} selectable={false}>
            {`${items().length} 个会话 · ${hiddenCount()} 已收起`}
          </text>
        </box>
        <text fg={theme.text.muted} selectable={false} onMouseUp={close}>
          esc
        </text>
      </box>

      <input
        width="100%"
        ref={(area: InputRenderable) => {
          input = area
        }}
        onInput={(value) => {
          setQuery(value)
          setCursor(0)
        }}
        placeholder="筛选会话：标题、代理、别名、已收起…"
        focusedBackgroundColor={theme.background.raised.high}
        cursorColor={theme.text.base}
        focusedTextColor={theme.text.base}
        textColor={theme.text.base}
        placeholderColor={theme.text.muted}
      />

      <Show when={loading()}>
        <text fg={theme.text.muted} selectable={false}>
          正在读取会话树…
        </text>
      </Show>
      <Show when={error()}>
        <text fg={theme.text.feedback.error.base} wrapMode="word">
          {`读取会话树失败：${error()}`}
        </text>
      </Show>

      <Show when={!loading() && !error()}>
        <Show
          when={rows().length > 0}
          fallback={
            <box height={3} paddingLeft={1}>
              <text fg={theme.text.muted} selectable={false}>
                {query().trim() ? "没有匹配的会话" : "本会话还没有子会话"}
              </text>
            </box>
          }
        >
          <scrollbox
            ref={(box: ScrollBoxRenderable) => {
              scroll = box
            }}
            height={listHeight()}
            scrollbarOptions={{ visible: false }}
            onMouseUp={(event: MouseEvent) => {
              if (event.button !== MouseButton.LEFT) return
              event.stopPropagation()
            }}
          >
            <For each={rows()}>
              {(row, index) => {
                const selected = () => index() === cursor()
                const contextOnly = () => result().context.has(row.item.sessionID)
                const active = () => running(row.item.sessionID)
                return (
                  <box
                    height={1}
                    flexShrink={0}
                    flexDirection="row"
                    alignItems="center"
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={
                      selected()
                        ? theme.background.raised.high
                        : hovered() === index()
                          ? theme.background.raised.base
                          : undefined
                    }
                    onMouseMove={() => {
                      setHovered(index())
                      setPointer(context, "pointer")
                      if (!selected()) setCursor(index())
                    }}
                    onMouseOut={() => {
                      setHovered(undefined)
                      setPointer(context, "default")
                    }}
                    onMouseUp={(event: MouseEvent) => {
                      if (event.button !== MouseButton.LEFT) return
                      event.stopPropagation()
                      setCursor(index())
                      void activate(row)
                    }}
                  >
                    <text
                      fg={theme.text.faint}
                      attributes={selected() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      flexShrink={0}
                      selectable={false}
                    >
                      {row.prefix}
                    </text>
                    <text fg={kindColor(row)} wrapMode="none" flexShrink={0} selectable={false}>
                      {sessionTreeKindBadge(row.item)}
                    </text>
                    <text
                      fg={rowColor(row)}
                      attributes={selected() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      truncate
                      flexGrow={1}
                      flexShrink={1}
                      minWidth={0}
                      selectable={false}
                    >
                      {` ${sessionTreeTitle(row.item)}`}
                    </text>
                    <Show when={active()}>
                      <text fg={theme.text.feedback.info.base} wrapMode="none" flexShrink={0} selectable={false}>
                        {" ●"}
                      </text>
                    </Show>
                    <Show when={row.item.hidden}>
                      <text fg={theme.text.feedback.warning.base} wrapMode="none" flexShrink={0} selectable={false}>
                        {" 已收起"}
                      </text>
                    </Show>
                    <text
                      fg={contextOnly() ? theme.text.faint : theme.text.muted}
                      wrapMode="none"
                      truncate
                      maxWidth={28}
                      flexShrink={0}
                      selectable={false}
                    >
                      {`  ${formatSessionTreeMeta(row, active())}`}
                    </text>
                  </box>
                )
              }}
            </For>
          </scrollbox>
        </Show>
      </Show>

      <box flexDirection="row" justifyContent="space-between" alignItems="center">
        <text fg={theme.text.muted} wrapMode="none" selectable={false}>
          ↑↓ 选择 · enter 打开 · alt+h 收起 · alt+u 恢复 · alt+i 中断
        </text>
        <text fg={theme.text.faint} wrapMode="none" flexShrink={0} selectable={false}>
          单击也可打开
        </text>
      </box>
    </box>
  )
}

/** Opens the unified root-scoped session tree manager in a native TUI dialog. */
export function openSessionTreeManager(
  context: Plugin.Context,
  rootSessionID: string,
  updateMemory: UpdateTuiMemory,
  options: SessionTreeManagerOptions = {},
): void {
  context.ui.dialog.show(() => (
    <SessionTreeManager
      context={context}
      rootSessionID={rootSessionID}
      updateMemory={updateMemory}
      items={options.items}
      selectedID={options.selectedID}
      onOpen={options.onOpen}
      onChanged={options.onChanged}
    />
  ))
}
