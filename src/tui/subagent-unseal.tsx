import type { Plugin } from "@opencode/plugin/tui"
import type { TextareaRenderable } from "@opentui/core"
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
  resolveAgentAccent,
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
 * Restores full graphical OpenCode-style human input above the host's sealed
 * native child footer, isolating keymap mode while focused so the Subagents
 * picker underneath never steals arrow/enter/escape keys.
 */
export function SubagentUnseal(props: SubagentUnsealProps) {
  const context = props.context
  const theme = context.theme
  const syntaxStyle = useHostSyntaxStyle(context)
  const current = createMemo(() => context.data.session.get(props.input.sessionID))
  const meta = createMemo(() => readO3pSessionMeta(current()?.metadata))
  const active = createMemo(() => Boolean(current()?.parentID) || meta() !== undefined)
  const rootSessionID = createMemo(() =>
    rootSessionIDFor(current(), () => context.data.session.root(props.input.sessionID)),
  )
  const running = createMemo(() => context.data.session.status(props.input.sessionID) === "running")
  const [editorFocused, setEditorFocused] = createSignal(false)
  let textarea: TextareaRenderable | undefined

  // While the user is typing in this unsealed prompt card, push a dedicated
  // keymap mode over the native "composer" mode so SubagentsTab arrow/enter
  // bindings yield cleanly to the textarea.
  createEffect(() => {
    if (!active() || !editorFocused()) return
    const release = context.keymap.mode.push("o3p-unseal")
    onCleanup(release)
  })

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
  const accent = createMemo(() => resolveAgentAccent(theme, agentID()))
  const modelMeta = createMemo(() => resolveModelDisplay(context, current()?.model))

  return (
    <Show when={active()}>
      <box flexDirection="column" flexShrink={0} marginBottom={1}>
        <GraphicalPromptCard
          context={context}
          syntaxStyle={syntaxStyle()}
          valueKey={props.input.sessionID}
          initialValue={readDraft(props.memory.drafts, props.input.sessionID)}
          placeholder={
            running()
              ? "点击此处直接插队纠偏这个正在运行的子会话…"
              : "点击此处直接向这个子会话追问或续接任务…"
          }
          agentLabel={titlecaseAgent(agentID())}
          agentAccent={accent()}
          modelLabel={modelMeta().modelName}
          providerLabel={modelMeta().providerName}
          variantLabel={modelMeta().variant}
          statusLabel={running() ? "运行中 ●" : "已解封 · 空闲"}
          running={running()}
          minHeight={1}
          maxHeight={5}
          footerHint={
            editorFocused()
              ? running()
                ? "Enter 插队纠偏  ·  Alt+Enter 排队  ·  Ctrl+X 中断  ·  Esc 释放输入框焦点"
                : "Enter 发送追问  ·  Shift+Enter 换行  ·  Esc 释放输入框焦点"
              : "鼠标点击输入框即可直接对话  ·  右侧按钮一键返回主会话分屏"
          }
          inputRef={(area) => {
            textarea = area
          }}
          onFocusChange={setEditorFocused}
          actions={
            <>
              <GuiButton
                context={context}
                icon="←"
                label="返回主会话分屏"
                variant="secondary"
                onClick={() => returnToSplit()}
              />
              <Show when={running()}>
                <GuiButton
                  context={context}
                  label="中断"
                  shortcut="ctrl+x"
                  variant="warning"
                  onClick={() => void interrupt()}
                />
              </Show>
              <GuiButton
                context={context}
                label={running() ? "纠偏" : "发送"}
                shortcut="↵"
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
          onEscape={() => textarea?.blur()}
        />
      </box>
    </Show>
  )
}
