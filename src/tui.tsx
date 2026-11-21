import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js"
import { PANEL_NAME, PLUGIN_ID, SessionRpc, type HubItem } from "./contract.ts"
import { registerSessionCommands, resolveRootSessionID, rpcOptions } from "./tui/commands.ts"
import { SessionPanel } from "./tui/panel.tsx"
import { createTuiMemory, formatFooterBadge, liveFamilyItems, mergeHubItems, stabilizeHubItems } from "./tui/state.ts"
import { SubagentUnseal } from "./tui/subagent-unseal.tsx"
import { GuiButton } from "./tui/ui-primitives.tsx"

function FooterBadge(props: {
  readonly context: Plugin.Context
  readonly sessionID?: string
}) {
  const context = props.context
  const rpc = context.client.rpc(SessionRpc)
  const [remote, setRemote] = createSignal<readonly HubItem[]>([])
  let revision = 0
  let inFlight: Promise<void> | undefined
  let queued = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const routeSessionID = () => {
    if (props.sessionID) return props.sessionID
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  const rootSessionID = createMemo(() => {
    const id = routeSessionID()
    return id ? resolveRootSessionID(context, id) : undefined
  })
  const runRefresh = async (): Promise<void> => {
    const root = rootSessionID()
    if (!root) {
      setRemote([])
      return
    }
    const current = ++revision
    try {
      const result = await rpc.listHub({ rootSessionID: root }, rpcOptions(context))
      if (current === revision && root === rootSessionID()) {
        setRemote((previous) => stabilizeHubItems(previous, result.items))
      }
    } catch {
      // Native descendants remain available even if the optional RPC backend is offline.
    }
  }
  const refresh = (): Promise<void> => {
    if (inFlight) {
      queued = true
      return inFlight
    }
    const run = runRefresh().finally(() => {
      if (inFlight === run) inFlight = undefined
      if (queued) {
        queued = false
        void refresh()
      }
    })
    inFlight = run
    return run
  }
  const scheduleRefresh = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, 60)
  }
  createEffect(
    on(rootSessionID, () => {
      setRemote([])
      void refresh()
    }),
  )
  onMount(() => {
    const off = rpc.events.on("updated", (event) => {
      if (event.data.rootSessionID === rootSessionID()) scheduleRefresh()
    })
    onCleanup(off)
    onCleanup(() => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    })
  })

  let previousItems: readonly HubItem[] = []
  const items = createMemo(() => {
    const root = rootSessionID()
    if (!root) return []
    const stable = stabilizeHubItems(previousItems, mergeHubItems(remote(), liveFamilyItems(context, root)))
    previousItems = stable
    return stable
  })
  const running = createMemo(
    () =>
      new Set(
        items()
          .filter((item) => context.data.session.status(item.sessionID) === "running")
          .map((item) => item.sessionID),
      ),
  )
  const panelClosed = createMemo(() => {
    const panel = context.ui.panel.current()
    return panel?.name !== PANEL_NAME || panel.sessionID !== rootSessionID()
  })
  const label = createMemo(() => formatFooterBadge(items(), running()))

  return (
    <Show when={label() && (panelClosed() || running().size > 0)}>
      <GuiButton
        context={context}
        label={label()}
        variant="ghost"
        bold={running().size > 0}
        idleTextColor={running().size > 0 ? context.theme.text.feedback.info.base : undefined}
        onClick={() => {
          if (!rootSessionID()) return
          context.ui.panel.open(PANEL_NAME)
        }}
      />
    </Show>
  )
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    if (context.options.enabled === false) return

    const [memory, updateMemory] = createTuiMemory(context)
    registerSessionCommands(context, updateMemory)

    const removePanel = context.ui.slot({
      append: "session.panel",
      render: (input) => {
        if (input.name !== PANEL_NAME) return null
        return <SessionPanel context={context} input={input} memory={memory} updateMemory={updateMemory} />
      },
    })
    const removeUnseal = context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <SubagentUnseal context={context} input={input} memory={memory} updateMemory={updateMemory} />
      ),
    })
    const removeStatus = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <FooterBadge context={context} sessionID={input.sessionID} />,
    })

    return () => {
      removePanel()
      removeUnseal()
      removeStatus()
    }
  },
})
