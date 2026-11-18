import type { Plugin } from "@opencode/plugin/tui"
import { PANEL_NAME, SessionRpc, type DeliveryMode } from "../contract.ts"
import {
  defaultSubagent,
  errorMessage,
  parseBtwArguments,
  parseSubArguments,
  rootSessionIDFor,
  type SessionRoute,
  type UpdateTuiMemory,
} from "./state.ts"

type KeymapLayer = ReturnType<Parameters<Plugin.Context["keymap"]["layer"]>[0]>
export type PanelKeymapCommand = NonNullable<KeymapLayer["commands"]>[number]

export function rpcOptions(context: Plugin.Context): { readonly location?: { readonly directory: string } } {
  const directory = context.location?.directory
  return directory ? { location: { directory } } : {}
}

function showError(context: Plugin.Context, error: unknown): void {
  context.ui.toast.show({ message: errorMessage(error), variant: "error" })
}

function currentSession(context: Plugin.Context): SessionRoute | undefined {
  const route = context.ui.router.current()
  if (route.type === "session") return route
  context.ui.toast.show({ message: "Open a session first", variant: "warning" })
  return undefined
}

export function resolveRootSessionID(context: Plugin.Context, sessionID: string): string {
  return rootSessionIDFor(context.data.session.get(sessionID), () => context.data.session.root(sessionID))
}

function selectAndOpen(
  context: Plugin.Context,
  updateMemory: UpdateTuiMemory,
  rootSessionID: string,
  selectedID: string,
): void {
  updateMemory((draft) => {
    draft.selectedByRoot[rootSessionID] = selectedID
    draft.composer = null
  })
  context.ui.panel.open(PANEL_NAME)
}

export function forceSyncSession(context: Plugin.Context, sessionID: string): void {
  context.data.session.invalidate(sessionID)
  context.data.session.message.invalidate(sessionID)
  context.data.session.pending.invalidate(sessionID)
  void Promise.all([
    context.data.session.sync(sessionID),
    context.data.session.message.sync(sessionID),
    context.data.session.pending.sync(sessionID),
  ]).catch((error: unknown) => showError(context, error))
}

/** The 2.3.0 promise client takes `text`, not the legacy `prompt`/`parts` payload. */
export async function sendSessionPrompt(
  context: Plugin.Context,
  sessionID: string,
  text: string,
  delivery?: "steer" | "queue",
  syncMessages = true,
): Promise<void> {
  await context.client.session.prompt({
    sessionID,
    text,
    ...(delivery ? { delivery } : {}),
  })
  // Native transcripts already follow the event stream. A snapshot taken at admission can
  // replace an in-flight turn before its remaining steps have been projected.
  if (!syncMessages) return
  context.data.session.message.invalidate(sessionID)
  await context.data.session.message.sync(sessionID)
}

function dispatchInitialPrompt(context: Plugin.Context, sessionID: string, text: string): void {
  void sendSessionPrompt(context, sessionID, text).catch((error: unknown) => showError(context, error))
}

export interface CreateBtwInput {
  readonly sourceSessionID: string
  readonly rootSessionID: string
  readonly question: string
}

export async function createBtwAside(
  context: Plugin.Context,
  updateMemory: UpdateTuiMemory,
  input: CreateBtwInput,
): Promise<string> {
  const forked = await context.client.session.fork({ sessionID: input.sourceSessionID })
  const source = context.data.session.get(input.sourceSessionID)
  if (source?.agent && forked.agent !== source.agent) {
    await context.client.session.switchAgent({ sessionID: forked.id, agent: source.agent })
  }
  const uiModel = context.ui.model.current()
  if (uiModel) {
    await context.client.session.switchModel({
      sessionID: forked.id,
      model: {
        providerID: uiModel.providerID,
        id: uiModel.modelID,
        ...(uiModel.variant ? { variant: uiModel.variant } : {}),
      },
    })
  }

  await context.client.rpc(SessionRpc).registerAside(
    {
      sessionID: forked.id,
      rootSessionID: input.rootSessionID,
      kind: "btw",
      label: input.question.slice(0, 60),
    },
    rpcOptions(context),
  )
  // Upstream core plugin/host.ts `ctx.session.update` omits `archived`, whereas
  // the HTTP client `PATCH /api/session/:id` invokes `session.archive` directly.
  await context.client.session.update({ sessionID: forked.id, archived: true })
  forceSyncSession(context, forked.id)
  selectAndOpen(context, updateMemory, input.rootSessionID, forked.id)
  dispatchInitialPrompt(context, forked.id, input.question)
  return forked.id
}

export interface CreateSubInput {
  readonly rootSessionID: string
  readonly agentID: string
  readonly task: string
}

export async function createSubAside(
  context: Plugin.Context,
  updateMemory: UpdateTuiMemory,
  input: CreateSubInput,
): Promise<string> {
  const created = await context.client.session.create({
    parentID: input.rootSessionID,
    agent: input.agentID,
    title: input.task.slice(0, 60),
  })
  await context.client.rpc(SessionRpc).registerAside(
    {
      sessionID: created.id,
      rootSessionID: input.rootSessionID,
      kind: "sub",
      readonly: false,
      label: input.task.slice(0, 60),
    },
    rpcOptions(context),
  )
  await context.client.session.update({ sessionID: created.id, archived: true })
  forceSyncSession(context, created.id)
  selectAndOpen(context, updateMemory, input.rootSessionID, created.id)
  dispatchInitialPrompt(context, created.id, input.task)
  return created.id
}

export function openInlineComposer(
  context: Plugin.Context,
  updateMemory: UpdateTuiMemory,
  rootSessionID: string,
  kind: "btw" | "sub",
  agentID?: string,
): void {
  updateMemory((draft) => {
    const existing = draft.composer
    if (existing?.rootSessionID === rootSessionID && existing.kind === kind) {
      if (agentID) existing.agentID = agentID
      return
    }
    draft.composer = {
      rootSessionID,
      kind,
      ...(agentID ? { agentID } : {}),
      nonce: Math.max(Date.now(), (existing?.nonce ?? 0) + 1),
    }
  })
  context.ui.panel.open(PANEL_NAME)
}

export interface PanelKeyActions {
  readonly cycleTab: (delta: -1 | 1) => void
  readonly handoff: (delivery: DeliveryMode) => void
  readonly interrupt: () => void
  readonly escape: () => void
  readonly toggleFullscreen: () => void
  readonly jumpToLatest?: () => void
}

/** Non-text keys are safe while the mini composer is focused. */
export function panelKeybindingCommands(actions: PanelKeyActions): readonly PanelKeymapCommand[] {
  return [
    { bind: "alt+[", title: "Previous aside", group: "Session", run: () => actions.cycleTab(-1) },
    { bind: "alt+]", title: "Next aside", group: "Session", run: () => actions.cycleTab(1) },
    { bind: "ctrl+h", title: "Park latest answer in root inbox", group: "Session", run: () => actions.handoff("park") },
    { bind: "ctrl+shift+h", title: "Wake root with latest answer", group: "Session", run: () => actions.handoff("wake") },
    { bind: "ctrl+x", title: "Interrupt aside", group: "Session", run: actions.interrupt },
    { bind: "ctrl+shift+f", title: "Toggle aside fullscreen", group: "Session", run: actions.toggleFullscreen },
    ...(actions.jumpToLatest
      ? [{ bind: "ctrl+end", title: "Jump to latest aside output", group: "Session", run: actions.jumpToLatest }]
      : []),
    { bind: "escape", title: "Return focus without closing the aside", group: "Session", run: actions.escape },
  ]
}

export function registerSessionCommands(context: Plugin.Context, updateMemory: UpdateTuiMemory): void {
  context.keymap.layer(() => ({
    mode: "global",
    // Win over the built-in opencode.btw layer even before users disable it.
    priority: 10,
    commands: [
      {
        id: "o3p.session.btw",
        title: "Fork a persistent side conversation",
        description: "Open a streaming /btw aside in the session split pane",
        group: "Session",
        palette: true,
        suggested: true,
        slash: { name: "btw", arguments: true },
        async run(input) {
          const route = currentSession(context)
          if (!route) return
          const rootSessionID = resolveRootSessionID(context, route.sessionID)
          const question = parseBtwArguments(input)
          if (!question) {
            openInlineComposer(context, updateMemory, rootSessionID, "btw")
            return
          }
          try {
            await createBtwAside(context, updateMemory, {
              sourceSessionID: route.sessionID,
              rootSessionID,
              question,
            })
          } catch (error: unknown) {
            showError(context, error)
          }
        },
      },
      {
        id: "o3p.session.sub",
        title: "Spawn a human-managed subagent",
        description: "Usage: /sub [@agent] [task]",
        group: "Session",
        palette: true,
        suggested: true,
        slash: { name: "sub", arguments: true },
        async run(input) {
          const route = currentSession(context)
          if (!route) return
          const rootSessionID = resolveRootSessionID(context, route.sessionID)
          const agents = context.data.location.agent.list(context.location) ?? []
          const parsed = parseSubArguments(input, agents)
          if (!parsed.task) {
            openInlineComposer(context, updateMemory, rootSessionID, "sub", parsed.agentID || defaultSubagent(agents))
            return
          }
          try {
            await createSubAside(context, updateMemory, {
              rootSessionID,
              agentID: parsed.agentID,
              task: parsed.task,
            })
          } catch (error: unknown) {
            showError(context, error)
          }
        },
      },
      {
        id: "o3p.session.aside",
        title: "Toggle the session aside console",
        group: "Session",
        palette: true,
        slash: { name: "aside", aliases: ["pager"] },
        run() {
          const route = currentSession(context)
          if (!route) return
          if (context.ui.panel.current()?.name === PANEL_NAME) context.ui.panel.close()
          else context.ui.panel.open(PANEL_NAME)
        },
      },
    ],
  }))
}
