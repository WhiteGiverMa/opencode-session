import type { Plugin } from "@opencode/plugin/tui"
import { MouseButton, type MouseEvent, type TextareaRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js"
import type { Store } from "solid-js/store"
import { PANEL_NAME } from "../contract.ts"
import { sendSessionPrompt } from "./commands.ts"
import {
  errorMessage,
  readDraft,
  readO3pSessionMeta,
  resolveModelDisplay,
  rootSessionIDFor,
  writeDraft,
  type TuiMemoryState,
  type UpdateTuiMemory,
} from "./state.ts"
import {
  GraphicalPromptCard,
  GuiButton,
  readHostCliScrollConfig,
  resolveHostAgentAccent,
  setPointer,
  SplitBorder,
  titlecaseAgent,
  useHostSyntaxStyle,
} from "./ui-primitives.tsx"

export interface SubagentUnsealProps {
  readonly context: Plugin.Context
  readonly input: { readonly sessionID: string }
  readonly memory: Store<TuiMemoryState>
  readonly updateMemory: UpdateTuiMemory
}

/**
 * Slim collapsible composer bar above the sealed native child footer:
 * - Collapsed by default (1 row) so it never crowds the native Subagents view.
 * - Click to expand into the full graphical prompt card; click `收起` or press
 *   `Escape` (when empty) to fold back into the compact 1-row bar.
 */
export function SubagentUnseal(props: SubagentUnsealProps) {
  const context = props.context
  const theme = context.theme
  const syntaxStyle = useHostSyntaxStyle(context)
  const cliConfig = readHostCliScrollConfig()
  const current = createMemo(() => context.data.session.get(props.input.sessionID))
  const meta = createMemo(() => readO3pSessionMeta(current()?.metadata))
  const active = createMemo(() => Boolean(current()?.parentID) || meta() !== undefined)
  const rootSessionID = createMemo(() =>
    rootSessionIDFor(current(), () => context.data.session.root(props.input.sessionID)),
  )
  const running = createMemo(() => context.data.session.status(props.input.sessionID) === "running")
  const hasDraft = createMemo(() => readDraft(props.memory.drafts, props.input.sessionID).trim().length > 0)
  const [expanded, setExpanded] = createSignal(false)
  const [barHovered, setBarHovered] = createSignal(false)
  const [editorFocused, setEditorFocused] = createSignal(false)
  let textarea: TextareaRenderable | undefined

  onCleanup(() => {
    if (barHovered()) setPointer(context, "default")
  })

  createEffect(() => {
    if (!active() || !expanded() || !editorFocused()) return
    const release = context.keymap.mode.push("o3p-unseal")
    onCleanup(release)
  })

  const expandAndFocus = (): void => {
    setExpanded(true)
    queueMicrotask(() => {
      if (textarea && !textarea.isDestroyed) {
        textarea.focus()
        context.renderer.requestRender()
      }
    })
  }

  const collapseBar = (): void => {
    textarea?.blur()
    setEditorFocused(false)
    setExpanded(false)
  }

  const returnToSplit = (): void => {
    const root = rootSessionID()
    const selectedID = props.input.sessionID
    textarea?.blur()
    props.updateMemory((draft) => {
      draft.nativeReturn = { rootSessionID: root, selectedID }
      draft.selectedByRoot[root] = selectedID
    })
    context.ui.router.navigate({ type: "session", sessionID: root })
    if (!context.ui.panel.open(PANEL_NAME)) {
      queueMicrotask(() => {
        context.ui.panel.open(PANEL_NAME)
      })
    }
  }

  const interrupt = async (): Promise<void> => {
    if (!running()) return
    try {
      await context.client.session.interrupt({ sessionID: props.input.sessionID })
    } catch (error: unknown) {
      context.ui.toast.show({ message: errorMessage(error), variant: "error" })
    }
  }

  const submit = async (queue: boolean): Promise<void> => {
    if (!textarea || textarea.isDestroyed) return
    const sessionID = props.input.sessionID
    const text = textarea.plainText.trim()
    if (!text) return
    textarea.clear()
    props.updateMemory((draft) => {
      draft.drafts = writeDraft(draft.drafts, sessionID, "")
    })
    try {
      const delivery = running() ? (queue ? "queue" : "steer") : undefined
      await sendSessionPrompt(context, sessionID, text, delivery)
    } catch (error: unknown) {
      context.ui.toast.show({ message: errorMessage(error), variant: "error" })
      if (props.input.sessionID === sessionID && textarea && !textarea.isDestroyed && !textarea.plainText) {
        textarea.setText(text)
        textarea.gotoLineEnd()
      }
    }
  }

  const agentID = createMemo(() => current()?.agent ?? "subagent")
  const accent = createMemo(() => resolveHostAgentAccent(context, agentID(), cliConfig.newDesigns))
  const modelMeta = createMemo(() => resolveModelDisplay(context, current()?.model))
  const isOpen = createMemo(() => expanded() || hasDraft())

  return (
    <Show when={active()}>
      <Show
        when={isOpen()}
        fallback={
          <box
            height={1}
            width="100%"
            flexShrink={0}
            flexDirection="row"
            alignItems="center"
            justifyContent="space-between"
            marginBottom={1}
            border={["left"]}
            borderColor={barHovered() ? accent() : theme.border.base}
            customBorderChars={SplitBorder.customBorderChars}
            backgroundColor={
              barHovered() ? theme.background.raised.high : theme.decrease(theme.background.raised.base)
            }
            paddingLeft={2}
            paddingRight={1}
          >
            <box
              height={1}
              flexGrow={1}
              minWidth={0}
              flexDirection="row"
              alignItems="center"
              gap={1}
              onMouseOver={() => {
                setBarHovered(true)
                setPointer(context, "text")
              }}
              onMouseOut={() => {
                setBarHovered(false)
                setPointer(context, "default")
              }}
              onMouseDown={(event: MouseEvent) => {
                if (event.button !== MouseButton.LEFT) return
                event.stopPropagation()
                expandAndFocus()
              }}
            >
              <text fg={accent()} wrapMode="none" flexShrink={0} selectable={false}>
                {titlecaseAgent(agentID())}
              </text>
              <text
                fg={barHovered() ? theme.text.base : theme.text.muted}
                wrapMode="none"
                truncate
                flexGrow={1}
                minWidth={0}
                selectable={false}
              >
                {running() ? "· 点击展开并插队纠偏…" : "· 点击展开向子会话追问…"}
              </text>
            </box>

            <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
              <Show when={running()}>
                <GuiButton
                  context={context}
                  label="中断"
                  variant="warning"
                  onClick={() => void interrupt()}
                />
              </Show>
              <GuiButton
                context={context}
                icon="←"
                label="返回分屏"
                variant="ghost"
                onClick={() => returnToSplit()}
              />
            </box>
          </box>
        }
      >
        <box flexDirection="column" flexShrink={0} marginBottom={1}>
          <GraphicalPromptCard
            context={context}
            syntaxStyle={syntaxStyle()}
            valueKey={props.input.sessionID}
            initialValue={readDraft(props.memory.drafts, props.input.sessionID)}
            placeholder={running() ? "实时插队纠偏…" : "追问…"}
            agentLabel={titlecaseAgent(agentID())}
            agentAccent={accent()}
            modelLabel={modelMeta().modelName}
            providerLabel={modelMeta().providerName}
            variantLabel={modelMeta().variant}
            statusLabel={running() ? "运行中 ●" : undefined}
            running={running()}
            minHeight={1}
            maxHeight={5}
            inputRef={(area) => {
              textarea = area
              if (area && expanded()) {
                queueMicrotask(() => {
                  if (!area.isDestroyed) area.focus()
                })
              }
            }}
            onFocusChange={setEditorFocused}
            actions={
              <>
                <GuiButton
                  context={context}
                  label="收起"
                  icon="▾"
                  variant="ghost"
                  onClick={() => collapseBar()}
                />
                <GuiButton
                  context={context}
                  icon="←"
                  label="返回分屏"
                  variant="ghost"
                  onClick={() => returnToSplit()}
                />
                <Show when={running()}>
                  <GuiButton
                    context={context}
                    label="中断"
                    variant="warning"
                    onClick={() => void interrupt()}
                  />
                </Show>
                <GuiButton
                  context={context}
                  label={running() ? "纠偏" : "发送"}
                  variant="primary"
                  onClick={(shift) => void submit(shift)}
                />
              </>
            }
            onDraftChange={(value) => {
              props.updateMemory((draft) => {
                draft.drafts = writeDraft(draft.drafts, props.input.sessionID, value)
              })
            }}
            onSubmit={(queue) => void submit(queue)}
            onInterrupt={() => void interrupt()}
            onEscape={() => {
              if (!textarea?.plainText.trim()) collapseBar()
              else textarea?.blur()
            }}
          />
        </box>
      </Show>
    </Show>
  )
}
