import { describe, expect, test } from "bun:test"
import { Location, type Plugin } from "@opencode/plugin"
import type {
  SessionContextInput,
  SessionCreateInput,
  SessionGetInput,
  SessionInboxSynthetic,
  SessionInboxUser,
  SessionInfo,
  SessionListInput,
  SessionMessageInfo,
  SessionPromptInput,
  SessionSyntheticInput,
  SessionUpdateInput,
} from "@opencode/client/promise"
import type { RpcCallOptions, RpcClient } from "@opencode/client/promise/api"
import type { RpcDomain, RpcHandlers, RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import type { Info as ToolInfo, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import type { Rpc } from "@opencode/schema/rpc"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { CallID } from "@opencode/schema/tool"
import { Schema } from "effect"
import {
  DEFAULT_READONLY_BLOCKED_TOOLS,
  META_KEY_HUB,
  META_KEY_SESSION,
  type SessionInfoOutput,
  type SessionListOutput,
  type SessionReadOutput,
  SessionRpc,
  type SessionSearchOutput,
  type SqliteSessionReader,
} from "../src/contract.ts"
import { createSessionServer, type SessionServerContext } from "../src/server.ts"

const asSessionID = (id: string) => Schema.decodeUnknownSync(Session.ID)(id)
const asAgentID = (id: string) => Schema.decodeUnknownSync(Agent.ID)(id)
const asMessageID = (id: string) => Schema.decodeUnknownSync(SessionMessage.ID)(id)
const asCallID = (id: string) => Schema.decodeUnknownSync(CallID)(id)
const asModelRef = (providerID: string, id: string) =>
  Schema.decodeUnknownSync(Model.Ref)({ providerID, id })

interface RecordedPrompt {
  readonly kind: "prompt"
  readonly input: SessionPromptInput
}

interface RecordedSynthetic {
  readonly kind: "synthetic"
  readonly input: SessionSyntheticInput
}

type DeliveredCall = RecordedPrompt | RecordedSynthetic

interface MockHarness {
  readonly ctx: SessionServerContext
  readonly sessions: Map<string, SessionInfo>
  readonly contexts: Map<string, SessionMessageInfo[]>
  readonly deliveries: DeliveredCall[]
  readonly emittedEvents: Array<{ rootSessionID: string; sessionID: string }>
  readonly listInputs: SessionListInput[]
  readonly registeredTools: Map<string, ToolInfo & { id: string }>
  readonly removedTools: string[]
  readonly waitCalls: string[]
  readonly rpcHandlers: () => RpcHandlers<typeof SessionRpc>
  readonly fireHook: <K extends keyof SessionHooks>(name: K, payload: SessionHooks[K]) => Promise<void>
  readonly invokeTool: (name: string, input: Record<string, unknown>, sessionID: string) => Promise<unknown>
}

function makeSessionInfo(partial: {
  id: string
  parentID?: string
  projectID?: string
  title?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  created?: number
  updated?: number
  busy?: number
  idle?: number
  archived?: number
  metadata?: SessionInfo["metadata"]
}): SessionInfo {
  const created = partial.created ?? 1000
  return {
    id: partial.id,
    ...(partial.parentID !== undefined ? { parentID: partial.parentID } : {}),
    projectID: partial.projectID ?? "proj_1",
    ...(partial.agent !== undefined ? { agent: partial.agent } : {}),
    ...(partial.model !== undefined ? { model: partial.model } : {}),
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    time: {
      created,
      updated: partial.updated ?? created,
      ...(partial.busy !== undefined ? { busy: partial.busy } : {}),
      ...(partial.idle !== undefined ? { idle: partial.idle } : {}),
      ...(partial.archived !== undefined ? { archived: partial.archived } : {}),
    },
    ...(partial.title !== undefined ? { title: partial.title } : {}),
    ...(partial.metadata !== undefined ? { metadata: partial.metadata } : {}),
    location: { directory: "/tmp/test-project" },
  }
}

function makeToolContext(sessionID: string, agent = "build"): ToolContext {
  return {
    sessionID: asSessionID(sessionID),
    agent: asAgentID(agent),
    messageID: asMessageID("msg_tool"),
    id: asCallID("call_1"),
    signal: new AbortController().signal,
    progress: async () => undefined,
  }
}

function createMockHarness(options: Record<string, unknown> = {}): MockHarness {
  const sessions = new Map<string, SessionInfo>()
  const contexts = new Map<string, SessionMessageInfo[]>()
  const deliveries: DeliveredCall[] = []
  const emittedEvents: Array<{ rootSessionID: string; sessionID: string }> = []
  const listInputs: SessionListInput[] = []
  const registeredTools = new Map<string, ToolInfo & { id: string }>()
  const removedTools: string[] = []
  const waitCalls: string[] = []
  const hookListeners = new Map<string, Array<(input: unknown) => Promise<void> | void>>()
  let registeredRpcHandlers: RpcHandlers<typeof SessionRpc> | undefined
  let seq = 0

  registeredTools.set("subagent", {
    id: "subagent",
    name: "subagent",
    description: "Native subagent",
    input: Schema.Struct({ prompt: Schema.String }),
    execute: async () => ({ output: {}, content: "native" }),
  })

  const location = Schema.decodeUnknownSync(Location.Info)({
    directory: "/tmp/test-project",
    project: {
      id: "proj_1",
      directory: "/tmp/test-project",
      canonical: "/tmp/test-project",
    },
  })

  const sessionDomain: Plugin.Context["session"] = {
    list: async (input?: SessionListInput) => {
      listInputs.push(input ?? {})
      let rows = Array.from(sessions.values())
      if (input?.archived !== undefined) {
        rows = rows.filter((s) => (s.time.archived !== undefined) === input.archived)
      }
      if (input?.project !== undefined) {
        rows = rows.filter((s) => s.projectID === input.project)
      }
      if (input?.parentID !== undefined) {
        rows = rows.filter((s) => (s.parentID ?? null) === input.parentID)
      }
      return {
        data: rows,
        cursor: { previous: null, next: null },
      }
    },
    create: async (input: SessionCreateInput = {}) => {
      seq += 1
      const id = input.id ?? `ses_created_${seq}`
      const created = makeSessionInfo({
        id,
        ...(input.parentID ? { parentID: input.parentID } : {}),
        ...(input.title ? { title: input.title } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        created: 1000 + seq * 10,
      })
      sessions.set(id, created)
      contexts.set(id, [])
      return created
    },
    get: async (input: SessionGetInput) => {
      const found = sessions.get(input.sessionID)
      if (!found) {
        throw new Error(`Session not found: ${input.sessionID}`)
      }
      return found
    },
    remove: async ({ sessionID }) => {
      sessions.delete(sessionID)
    },
    switchAgent: async ({ sessionID, agent }) => {
      const found = sessions.get(sessionID)
      if (found) sessions.set(sessionID, { ...found, agent })
    },
    switchModel: async ({ sessionID, model }) => {
      const found = sessions.get(sessionID)
      if (found) sessions.set(sessionID, { ...found, model })
    },
    prompt: async (input: SessionPromptInput): Promise<SessionInboxUser> => {
      seq += 1
      deliveries.push({ kind: "prompt", input })
      const msgID = `msg_prompt_${seq}`
      const list = contexts.get(input.sessionID) ?? []
      list.push({
        type: "user",
        id: msgID,
        time: { created: Date.now() },
        text: input.text,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      contexts.set(input.sessionID, list)
      return {
        id: msgID,
        sessionID: input.sessionID,
        time: { created: Date.now() },
        type: "user",
        payload: {
          text: input.text,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        delivery: input.delivery ?? "queue",
      }
    },
    generate: async () => ({
      text: "generated",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    }),
    command: async () => undefined,
    compact: async () => ({
      id: "msg_compact",
      sessionID: "ses",
      time: { created: Date.now() },
      type: "compaction",
      payload: {},
      delivery: "queue",
    }),
    synthetic: async (input: SessionSyntheticInput): Promise<SessionInboxSynthetic> => {
      seq += 1
      deliveries.push({ kind: "synthetic", input })
      const msgID = `msg_syn_${seq}`
      const list = contexts.get(input.sessionID) ?? []
      list.push({
        type: "synthetic",
        id: msgID,
        time: { created: Date.now() },
        text: input.text,
        ...(input.description !== undefined && input.description !== null
          ? { description: input.description }
          : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
      })
      contexts.set(input.sessionID, list)
      return {
        id: msgID,
        sessionID: input.sessionID,
        time: { created: Date.now() },
        type: "synthetic",
        payload: {
          text: input.text,
          ...(input.description !== undefined && input.description !== null
            ? { description: input.description }
            : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        delivery: input.delivery ?? "queue",
      }
    },
    interrupt: async () => ({ interrupted: false }),
    update: async (input: SessionUpdateInput) => {
      const existing = sessions.get(input.sessionID)
      if (!existing) throw new Error(`Session not found: ${input.sessionID}`)
      const nextTime = { ...existing.time }
      if (input.archived === true) {
        nextTime.archived = Date.now()
      } else if (input.archived === false) {
        delete nextTime.archived
      }
      sessions.set(input.sessionID, {
        ...existing,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        time: nextTime,
      })
    },
    move: async () => undefined,
    context: async (input: SessionContextInput) => {
      return contexts.get(input.sessionID) ?? []
    },
    wait: async ({ sessionID }) => {
      waitCalls.push(sessionID)
    },
    instructions: {
      entry: {
        list: async () => [],
        put: async () => undefined,
        remove: async () => undefined,
      },
    },
    hook: async (name, callback) => {
      const key = String(name)
      const list = hookListeners.get(key) ?? []
      const fn = (payload: unknown) => callback(payload as never)
      list.push(fn)
      hookListeners.set(key, list)
      return {
        dispose: async () => {
          const current = hookListeners.get(key) ?? []
          hookListeners.set(
            key,
            current.filter((item) => item !== fn),
          )
        },
      }
    },
  }

  const toolDomain: Plugin.Context["tool"] = {
    transform: async (callback) => {
      const editor: ToolEditor = {
        list: () => Array.from(registeredTools.values()),
        get: (id) => registeredTools.get(id),
        namespace: () => undefined,
        add: (tool) => {
          const ns = tool.options?.namespace
          const id = ns ? `${ns}_${tool.name}` : tool.name
          registeredTools.set(id, {
            ...tool,
            id,
            execute: tool.execute as ToolInfo["execute"],
          })
        },
        update: (id, updater) => {
          const existing = registeredTools.get(id)
          if (existing) updater(existing)
        },
        remove: (id) => {
          removedTools.push(id)
          registeredTools.delete(id)
        },
      }
      callback(editor)
      return {
        dispose: async () => undefined,
      }
    },
    reload: async () => undefined,
    list: async () => Array.from(registeredTools.values()),
    hook: async () => ({ dispose: async () => undefined }),
  }

  const rpcDomain: RpcDomain = Object.assign(
    <D extends Rpc.PortableDefinition>(
      _definition: D,
    ): RpcClient<
      D,
      Pick<RpcCallOptions, "signal"> & {
        readonly location?: never
        readonly headers?: never
      }
    > => {
      throw new Error("not implemented in mock")
    },
    {
      register: async <const D extends Rpc.PortableDefinition>(
        definition: D,
        handlers: RpcHandlers<NoInfer<D>>,
      ): Promise<RpcRegistration<D>> => {
        if (definition.id === SessionRpc.id) {
          registeredRpcHandlers = handlers as unknown as RpcHandlers<typeof SessionRpc>
        }
        return {
          events: {
            emit: async (...args: Rpc.EventInput<D>) => {
              const payload = args[1]
              if (
                typeof payload === "object" &&
                payload !== null &&
                "rootSessionID" in payload &&
                "sessionID" in payload &&
                typeof payload.rootSessionID === "string" &&
                typeof payload.sessionID === "string"
              ) {
                emittedEvents.push({
                  rootSessionID: payload.rootSessionID,
                  sessionID: payload.sessionID,
                })
              }
            },
          },
          dispose: async () => {
            registeredRpcHandlers = undefined
          },
        }
      },
    },
  )

  const ctx: SessionServerContext = {
    options,
    location,
    session: sessionDomain,
    tool: toolDomain,
    rpc: rpcDomain,
  }

  return {
    ctx,
    sessions,
    contexts,
    deliveries,
    emittedEvents,
    listInputs,
    registeredTools,
    removedTools,
    waitCalls,
    rpcHandlers: () => {
      if (!registeredRpcHandlers) throw new Error("RPC handlers not registered")
      return registeredRpcHandlers
    },
    fireHook: async (name, payload) => {
      const listeners = hookListeners.get(String(name)) ?? []
      for (const listener of listeners) {
        await listener(payload)
      }
    },
    invokeTool: async (name, input, sessionID) => {
      const tool = registeredTools.get(`session_${name}`)
      if (!tool) throw new Error(`Tool session_${name} not registered`)
      return tool.execute(input, makeToolContext(sessionID))
    },
  }
}

function createMockReader(overrides?: Partial<SqliteSessionReader>): SqliteSessionReader {
  return {
    list: () =>
      ({
        db: "/tmp/mock.db",
        items: [],
        nextCursor: null,
      }) satisfies SessionListOutput,
    info: (sessionID) =>
      ({
        db: "/tmp/mock.db",
        sessionID,
        projectID: "proj_1",
        directory: "/tmp/test-project",
        parentID: null,
        forkSessionID: null,
        title: sessionID,
        agent: null,
        model: null,
        archived: false,
        isAside: false,
        asideMeta: null,
        createdAt: 1000,
        updatedAt: 1000,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        messageCounts: {
          total: 2,
          user: 1,
          assistant: 1,
          synthetic: 0,
          system: 0,
          skill: 0,
          shell: 0,
          compaction: 0,
        },
      }) satisfies SessionInfoOutput,
    read: (query) =>
      ({
        db: "/tmp/mock.db",
        sessionID: query.sessionID,
        title: query.sessionID,
        totalMessages: 0,
        range: { start: 0, end: 0, reverse: false },
        hasMoreBefore: false,
        hasMoreAfter: false,
        messages: [],
      }) satisfies SessionReadOutput,
    search: (query) =>
      ({
        db: "/tmp/mock.db",
        query: query.query,
        hits: [],
        nextCursor: null,
      }) satisfies SessionSearchOutput,
    ...overrides,
  }
}

describe("opencode-session server plugin", () => {
  test("readonly lock strips write/edit tools while keeping shell/read and injects guidance; toggling unlocks", async () => {
    const mock = createMockHarness()
    mock.sessions.set("ses_root", makeSessionInfo({ id: "ses_root", title: "Main" }))
    mock.sessions.set(
      "ses_btw",
      makeSessionInfo({ id: "ses_btw", title: "Aside", metadata: { keepMe: "yes" } }),
    )

    const cleanup = await createSessionServer(mock.ctx, { reader: createMockReader() })
    const rpc = mock.rpcHandlers()

    await rpc.registerAside(
      {
        sessionID: "ses_btw",
        rootSessionID: "ses_root",
        kind: "btw",
        label: "Why test failed",
      },
      { signal: new AbortController().signal, error: (() => new Error("rpc")) as never },
    )

    const toolsMap = (): SessionHooks["context"]["tools"] => ({
      read: { description: "read", input: {} },
      grep: { description: "grep", input: {} },
      glob: { description: "glob", input: {} },
      shell: { description: "shell", input: {} },
      execute: { description: "code mode", input: {} },
      write: { description: "write", input: {} },
      edit: { description: "edit", input: {} },
      lsp_rename: { description: "rename", input: {} },
      openviking_write: { description: "ov write", input: {} },
      openviking_edit: { description: "ov edit", input: {} },
      openviking_forget: { description: "ov forget", input: {} },
    })

    const ctxEvent: SessionHooks["context"] = {
      sessionID: asSessionID("ses_btw"),
      agent: asAgentID("build"),
      model: asModelRef("openai", "gpt-5"),
      system: [],
      messages: [],
      options: {},
      tools: toolsMap(),
    }

    await mock.fireHook("context", ctxEvent)

    for (const blocked of DEFAULT_READONLY_BLOCKED_TOOLS) {
      expect(ctxEvent.tools[blocked]).toBeUndefined()
    }
    expect(ctxEvent.tools.shell).toBeDefined()
    expect(ctxEvent.tools.read).toBeDefined()
    expect(ctxEvent.tools.grep).toBeDefined()
    expect(ctxEvent.tools.glob).toBeDefined()
    expect(ctxEvent.system.some((p) => p.text.includes("<o3p-aside-readonly>"))).toBe(true)
    expect(ctxEvent.system.some((p) => p.text.includes("<o3p-session-os>"))).toBe(true)

    // Unlock via RPC and verify write/edit survive next context hook
    await rpc.setReadonly(
      { sessionID: "ses_btw", readonly: false },
      { signal: new AbortController().signal, error: (() => new Error("rpc")) as never },
    )

    const unlockedEvent: SessionHooks["context"] = {
      sessionID: asSessionID("ses_btw"),
      agent: asAgentID("build"),
      model: asModelRef("openai", "gpt-5"),
      system: [],
      messages: [],
      options: {},
      tools: toolsMap(),
    }

    await mock.fireHook("context", unlockedEvent)
    expect(unlockedEvent.tools.write).toBeDefined()
    expect(unlockedEvent.tools.edit).toBeDefined()
    expect(unlockedEvent.system.some((p) => p.text.includes("<o3p-aside-readonly>"))).toBe(false)

    // Non-execute agent omits <o3p-session-os>
    const noExecEvent: SessionHooks["context"] = {
      sessionID: asSessionID("ses_root"),
      agent: asAgentID("title"),
      model: asModelRef("openai", "gpt-5"),
      system: [],
      messages: [],
      options: {},
      tools: { read: { description: "read", input: {} } },
    }
    await mock.fireHook("context", noExecEvent)
    expect(noExecEvent.system.some((p) => p.text.includes("<o3p-session-os>"))).toBe(false)

    await cleanup?.()
  })

  test("3-hop wake limit downgrades 4th hop to park without dropping message, and real user prompt resets hop", async () => {
    const mock = createMockHarness({ maxWakeHops: 3 })
    for (const id of ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e"]) {
      mock.sessions.set(id, makeSessionInfo({ id, title: `Session ${id}`, agent: "build" }))
      mock.contexts.set(id, [
        {
          type: "user",
          id: `msg_init_${id}`,
          time: { created: 1000 },
          text: "initial",
        },
      ])
    }

    await createSessionServer(mock.ctx, { reader: createMockReader() })

    // Human prompt on A -> hop = 0
    await mock.fireHook("prompt", {
      sessionID: asSessionID("ses_a"),
      messageID: asMessageID("msg_h1"),
      prompt: { text: "start", files: [], agents: [], skills: [] },
      delivery: "steer",
    })

    const r1 = (await mock.invokeTool(
      "send",
      { to: "ses_b", message: "hop 1", delivery: "wake" },
      "ses_a",
    )) as { output: { effectiveDelivery: string; hop: number; downgradedToPark: boolean } }
    expect(r1.output.effectiveDelivery).toBe("wake")
    expect(r1.output.hop).toBe(1)
    expect(r1.output.downgradedToPark).toBe(false)

    const r2 = (await mock.invokeTool(
      "send",
      { to: "ses_c", message: "hop 2", delivery: "wake" },
      "ses_b",
    )) as { output: { effectiveDelivery: string; hop: number; downgradedToPark: boolean } }
    expect(r2.output.effectiveDelivery).toBe("wake")
    expect(r2.output.hop).toBe(2)

    const r3 = (await mock.invokeTool(
      "send",
      { to: "ses_d", message: "hop 3", delivery: "wake" },
      "ses_c",
    )) as { output: { effectiveDelivery: string; hop: number; downgradedToPark: boolean } }
    expect(r3.output.effectiveDelivery).toBe("wake")
    expect(r3.output.hop).toBe(3)

    // 4th hop must downgrade to park (resume: false) and NOT drop the message
    const r4 = (await mock.invokeTool(
      "send",
      { to: "ses_e", message: "hop 4 should park", delivery: "wake" },
      "ses_d",
    )) as {
      output: {
        effectiveDelivery: string
        hop: number
        downgradedToPark: boolean
        reason?: string
        method: string
      }
    }
    expect(r4.output.effectiveDelivery).toBe("park")
    expect(r4.output.hop).toBe(4)
    expect(r4.output.downgradedToPark).toBe(true)
    expect(r4.output.reason).toBe("max_wake_hops_reached")
    expect(r4.output.method).toBe("synthetic")

    const lastDelivery = mock.deliveries.at(-1)
    expect(lastDelivery?.kind).toBe("synthetic")
    if (lastDelivery?.kind === "synthetic") {
      expect(lastDelivery.input.sessionID).toBe("ses_e")
      expect(lastDelivery.input.resume).toBe(false)
      expect(lastDelivery.input.text).toContain("hop 4 should park")
      expect(lastDelivery.input.text).toContain('delivery="park" hop="4/3"')
    }

    // Real user prompt on D resets D's wake hop back to 0
    await mock.fireHook("prompt", {
      sessionID: asSessionID("ses_d"),
      messageID: asMessageID("msg_h2"),
      prompt: { text: "continue", files: [], agents: [], skills: [] },
      delivery: "steer",
    })

    const r5 = (await mock.invokeTool(
      "send",
      { to: "ses_e", message: "after human reset", delivery: "wake" },
      "ses_d",
    )) as { output: { effectiveDelivery: string; hop: number; downgradedToPark: boolean } }
    expect(r5.output.effectiveDelivery).toBe("wake")
    expect(r5.output.hop).toBe(1)
    expect(r5.output.downgradedToPark).toBe(false)
  })

  test("zero implicit context leakage in session.send", async () => {
    const mock = createMockHarness()
    mock.sessions.set("ses_sender", makeSessionInfo({ id: "ses_sender", title: "Sender", agent: "meidocho" }))
    mock.sessions.set("ses_target", makeSessionInfo({ id: "ses_target", title: "Target", agent: "explore" }))

    mock.contexts.set("ses_sender", [
      {
        type: "user",
        id: "msg_secret_u",
        time: { created: 1000 },
        text: "TOP_SECRET_USER_PROMPT_DO_NOT_LEAK",
      },
      {
        type: "assistant",
        id: "msg_secret_a",
        time: { created: 1001, completed: 1002 },
        agent: "meidocho",
        model: { providerID: "openai", id: "gpt-5" },
        content: [
          { type: "reasoning", text: "INTERNAL_COT_SECRET_DO_NOT_LEAK" },
          { type: "text", text: "SENDER_PRIVATE_REPLY_DO_NOT_LEAK" },
        ],
      },
    ])
    mock.contexts.set("ses_target", [
      { type: "user", id: "msg_t0", time: { created: 1000 }, text: "hi" },
    ])

    const reader = createMockReader({
      read: (query) => ({
        db: "/tmp/mock.db",
        sessionID: query.sessionID,
        title: "Sender",
        totalMessages: 2,
        range: { start: 1, end: 2, reverse: false },
        hasMoreBefore: false,
        hasMoreAfter: false,
        messages: [
          {
            index: 1,
            seq: 1,
            messageID: "msg_secret_u",
            type: "user",
            role: "user",
            createdAt: 1000,
            blocks: [{ kind: "text", text: "TOP_SECRET_USER_PROMPT_DO_NOT_LEAK" }],
          },
        ],
      }),
    })

    await createSessionServer(mock.ctx, { reader })

    await mock.invokeTool(
      "send",
      { to: "ses_target", message: "Please inspect src/auth.ts", delivery: "park" },
      "ses_sender",
    )

    expect(mock.deliveries).toHaveLength(1)
    const sent = mock.deliveries[0]
    expect(sent?.kind).toBe("synthetic")
    if (sent?.kind === "synthetic") {
      expect(sent.input.text).toContain("Please inspect src/auth.ts")
      expect(sent.input.text).toContain("<session_message ")
      expect(sent.input.text).toContain("<session_message_notice>")
      expect(sent.input.text).not.toContain("TOP_SECRET_USER_PROMPT_DO_NOT_LEAK")
      expect(sent.input.text).not.toContain("INTERNAL_COT_SECRET_DO_NOT_LEAK")
      expect(sent.input.text).not.toContain("SENDER_PRIVATE_REPLY_DO_NOT_LEAK")
    }
  })

  test("empty-session first message routes via prompt (and preserves hop), while non-empty routes via synthetic", async () => {
    const mock = createMockHarness()
    mock.sessions.set("ses_parent", makeSessionInfo({ id: "ses_parent", title: "Parent", agent: "build" }))
    mock.sessions.set("ses_nonempty", makeSessionInfo({ id: "ses_nonempty", title: "Existing", agent: "explore" }))
    mock.contexts.set("ses_parent", [{ type: "user", id: "m0", time: { created: 1000 }, text: "go" }])
    mock.contexts.set("ses_nonempty", [{ type: "user", id: "m1", time: { created: 1000 }, text: "hi" }])

    const reader = createMockReader({
      info: (sessionID) => ({
        db: "/tmp/mock.db",
        sessionID,
        projectID: "proj_1",
        directory: "/tmp/test-project",
        parentID: null,
        forkSessionID: null,
        title: sessionID,
        agent: null,
        model: null,
        archived: false,
        isAside: false,
        asideMeta: null,
        createdAt: 1000,
        updatedAt: 1000,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        messageCounts: {
          total: sessionID.startsWith("ses_created_") ? 0 : 1,
          user: sessionID.startsWith("ses_created_") ? 0 : 1,
          assistant: 0,
          synthetic: 0,
          system: 0,
          skill: 0,
          shell: 0,
          compaction: 0,
        },
      }),
    })

    await createSessionServer(mock.ctx, { reader })

    // Create empty child session
    const created = (await mock.invokeTool(
      "create",
      { agent: "explore", title: "Inspect auth" },
      "ses_parent",
    )) as { output: { sessionID: string } }

    const childID = created.output.sessionID

    // First wake send -> must use ctx.session.prompt
    const firstSend = (await mock.invokeTool(
      "send",
      { to: childID, message: "Check auth", delivery: "wake" },
      "ses_parent",
    )) as { output: { method: string; hop: number } }
    expect(firstSend.output.method).toBe("prompt")
    expect(firstSend.output.hop).toBe(1)
    expect(mock.deliveries[0]?.kind).toBe("prompt")

    // Simulate opencode's prompt hook firing for that programmatic prompt -> should NOT reset childID's hop to 0
    if (mock.deliveries[0]?.kind === "prompt") {
      await mock.fireHook("prompt", {
        sessionID: asSessionID(childID),
        messageID: asMessageID("msg_prog"),
        prompt: { text: mock.deliveries[0].input.text, files: [], agents: [], skills: [] },
        metadata: mock.deliveries[0].input.metadata,
        delivery: "queue",
      })
    }

    // Second hop from childID to non-empty session -> hop should be 2 and method synthetic
    const secondSend = (await mock.invokeTool(
      "send",
      { to: "ses_nonempty", message: "Follow up", delivery: "wake" },
      childID,
    )) as { output: { method: string; hop: number } }
    expect(secondSend.output.method).toBe("synthetic")
    expect(secondSend.output.hop).toBe(2)
    expect(mock.deliveries[1]?.kind).toBe("synthetic")
    if (mock.deliveries[1]?.kind === "synthetic") {
      expect(mock.deliveries[1].input.resume).toBe(true)
    }
  })

  test("watch notifications on experimental.idle, once removal, persistent unwatch, and private human follow-up silence", async () => {
    const mock = createMockHarness()
    mock.sessions.set("ses_root", makeSessionInfo({ id: "ses_root", title: "Root" }))
    mock.sessions.set(
      "ses_child",
      makeSessionInfo({ id: "ses_child", parentID: "ses_root", title: "Explore Repo", agent: "explore" }),
    )
    mock.sessions.set(
      "ses_sub",
      makeSessionInfo({
        id: "ses_sub",
        parentID: "ses_root",
        title: "Oracle",
        agent: "oracle",
        busy: 1000,
        idle: 2000,
      }),
    )

    mock.contexts.set("ses_child", [
      {
        type: "assistant",
        id: "msg_child_a",
        time: { created: 1000, completed: 1500 },
        agent: "explore",
        model: { providerID: "openai", id: "gpt-5" },
        content: [{ type: "text", text: "Found 3 auth handlers in src/auth.ts." }],
      },
    ])

    mock.contexts.set("ses_sub", [
      {
        type: "assistant",
        id: "msg_sub_a",
        time: { created: 1000, completed: 2000 },
        agent: "oracle",
        model: { providerID: "openai", id: "gpt-5" },
        content: [{ type: "text", text: "Private answer for human." }],
      },
    ])

    await createSessionServer(mock.ctx, { reader: createMockReader() })

    // One-shot watch on ses_child
    await mock.invokeTool("watch", { target: "ses_child", delivery: "wake", once: true }, "ses_root")

    // Check persistence in root metadata
    const rootAfterWatch = mock.sessions.get("ses_root")
    const hubMeta = rootAfterWatch?.metadata?.[META_KEY_HUB] as { watches?: unknown[] } | undefined
    expect(hubMeta?.watches).toHaveLength(1)

    // Idle fires watch notification
    await mock.fireHook("experimental.idle", {
      sessionID: asSessionID("ses_child"),
      background: [],
    })

    expect(mock.deliveries).toHaveLength(1)
    const notice = mock.deliveries[0]
    expect(notice?.kind).toBe("synthetic")
    if (notice?.kind === "synthetic") {
      expect(notice.input.sessionID).toBe("ses_root")
      expect(notice.input.resume).toBe(true)
      expect(notice.input.description).toBe("Watched session finished · Explore Repo")
      expect(notice.input.metadata).toEqual({
        source: "o3p.session.watch",
        childID: "ses_child",
        agent: "explore",
        state: "completed",
      })
      expect(notice.input.text).toContain(
        '<session_watch_notice from="ses_child" title="Explore Repo" agent="explore" state="completed">',
      )
      expect(notice.input.text).toContain("Found 3 auth handlers in src/auth.ts.")
    }

    // once=true removed the watch from both memory and metadata
    const rootAfterIdle = mock.sessions.get("ses_root")
    const hubMetaAfter = rootAfterIdle?.metadata?.[META_KEY_HUB] as { watches?: unknown[] } | undefined
    expect(hubMetaAfter?.watches).toHaveLength(0)

    // Subsequent idle does not fire
    await mock.fireHook("experimental.idle", {
      sessionID: asSessionID("ses_child"),
      background: [],
    })
    expect(mock.deliveries).toHaveLength(1)

    // Persistent watch on ses_sub (once: false, delivery: park)
    await mock.invokeTool("watch", { target: "ses_sub", delivery: "park", once: false }, "ses_root")

    // Human sends a private follow-up prompt while ses_sub is idle -> must suppress watch notice on next idle
    await mock.fireHook("prompt", {
      sessionID: asSessionID("ses_sub"),
      messageID: asMessageID("msg_private_q"),
      prompt: { text: "Give me a smaller lock example", files: [], agents: [], skills: [] },
      delivery: "steer",
    })

    await mock.fireHook("experimental.idle", {
      sessionID: asSessionID("ses_sub"),
      background: [],
    })
    expect(mock.deliveries).toHaveLength(1)

    // Next normal idle (non-human follow-up) DOES fire persistent watch
    await mock.fireHook("experimental.idle", {
      sessionID: asSessionID("ses_sub"),
      background: [],
    })
    expect(mock.deliveries).toHaveLength(2)
    const subNotice = mock.deliveries[1]
    if (subNotice?.kind === "synthetic") {
      expect(subNotice.input.resume).toBe(false)
      expect(subNotice.input.text).toContain("Private answer for human.")
    }

    // Unwatch clears persistent watch
    const unwatchRes = (await mock.invokeTool("unwatch", { target: "ses_sub" }, "ses_root")) as {
      output: { removed: number }
    }
    expect(unwatchRes.output.removed).toBe(1)

    await mock.fireHook("experimental.idle", {
      sessionID: asSessionID("ses_sub"),
      background: [],
    })
    expect(mock.deliveries).toHaveLength(2)
  })

  test("RPC methods: registerAside, setReadonly, setHidden, listHub tree+aliases, and handoff", async () => {
    const mock = createMockHarness()
    mock.sessions.set(
      "ses_root",
      makeSessionInfo({ id: "ses_root", title: "Main Session", created: 1000, metadata: { rootTag: "v1" } }),
    )
    mock.sessions.set(
      "ses_btw_1",
      makeSessionInfo({ id: "ses_btw_1", title: "Forked BTW", created: 1100, metadata: { custom: 42 } }),
    )
    mock.sessions.set("ses_sub_1", makeSessionInfo({ id: "ses_sub_1", title: "Direct Sub", agent: "explore", created: 1200 }))
    mock.sessions.set(
      "ses_sa_1",
      makeSessionInfo({ id: "ses_sa_1", parentID: "ses_root", title: "Explore Tree", agent: "explore", created: 1300 }),
    )
    mock.sessions.set(
      "ses_sa_2",
      makeSessionInfo({ id: "ses_sa_2", parentID: "ses_sa_1", title: "Grandchild General", agent: "general", created: 1400 }),
    )
    mock.sessions.set(
      "ses_sa_3",
      makeSessionInfo({ id: "ses_sa_3", parentID: "ses_root", title: "Second General", agent: "general", created: 1500 }),
    )
    mock.sessions.set(
      "ses_empty",
      makeSessionInfo({ id: "ses_empty", title: "Errored aside without text", created: 1600 }),
    )

    mock.contexts.set("ses_btw_1", [
      {
        type: "assistant",
        id: "msg_btw_a",
        time: { created: 1105, completed: 1110 },
        agent: "build",
        model: { providerID: "openai", id: "gpt-5" },
        content: [{ type: "text", text: "OPTIONS preflight was bypassed in cors.ts." }],
      },
    ])

    await createSessionServer(mock.ctx, { reader: createMockReader() })
    const rpc = mock.rpcHandlers()
    const rpcFailures: Array<{ type: string; message: string; data?: unknown }> = []
    const rpcCtx = {
      signal: new AbortController().signal,
      error: (type: string, message: string, data?: unknown) => {
        const failure = { type, message, ...(data === undefined ? {} : { data }) }
        rpcFailures.push(failure)
        return failure
      },
    } as never

    // registerAside sets metadata + archived: true + appends to root asideIDs + preserves existing keys
    const regBtw = await rpc.registerAside(
      {
        sessionID: "ses_btw_1",
        rootSessionID: "ses_root",
        kind: "btw",
        label: "CORS preflight check",
      },
      rpcCtx,
    )
    expect(regBtw.meta.readonly).toBe(true)
    expect(mock.sessions.get("ses_btw_1")?.time.archived).toBeDefined()
    expect(mock.sessions.get("ses_btw_1")?.metadata?.custom).toBe(42)
    expect(mock.sessions.get("ses_root")?.metadata?.rootTag).toBe("v1")

    const regSub = await rpc.registerAside(
      {
        sessionID: "ses_sub_1",
        rootSessionID: "ses_root",
        kind: "sub",
        label: "Explore sub",
      },
      rpcCtx,
    )
    expect(regSub.meta.readonly).toBe(false)

    // Duplicate registerAside deduplicates asideIDs
    await rpc.registerAside(
      {
        sessionID: "ses_btw_1",
        rootSessionID: "ses_root",
        kind: "btw",
        label: "CORS preflight check",
      },
      rpcCtx,
    )
    const rootHub = mock.sessions.get("ses_root")?.metadata?.[META_KEY_HUB] as { asideIDs: string[] }
    expect(rootHub.asideIDs).toEqual(["ses_btw_1", "ses_sub_1"])

    // setHidden preserves other metadata and emits updated event
    const hiddenRes = await rpc.setHidden({ sessionID: "ses_btw_1", hidden: true }, rpcCtx)
    expect(hiddenRes.hidden).toBe(true)
    expect((mock.sessions.get("ses_btw_1")?.metadata?.[META_KEY_SESSION] as { hidden: boolean }).hidden).toBe(true)
    expect(mock.sessions.get("ses_btw_1")?.metadata?.custom).toBe(42)
    expect(mock.emittedEvents.length).toBeGreaterThanOrEqual(4)

    // listHub returns full recursive tree + archived asides sorted by createdAt ASC with stable aliases
    const hubList = await rpc.listHub({ rootSessionID: "ses_root" }, rpcCtx)
    expect(hubList.items.map((i) => ({ id: i.sessionID, kind: i.kind, depth: i.depth, index: i.index, alias: i.alias }))).toEqual([
      { id: "ses_btw_1", kind: "btw", depth: 1, index: 1, alias: "btw-1" },
      { id: "ses_sub_1", kind: "sub", depth: 1, index: 2, alias: "sub-1" },
      { id: "ses_sa_1", kind: "subagent", depth: 1, index: 3, alias: "explore-1" },
      { id: "ses_sa_2", kind: "subagent", depth: 2, index: 4, alias: "general-1" },
      { id: "ses_sa_3", kind: "subagent", depth: 1, index: 5, alias: "general-2" },
    ])

    // handoff extracts latest assistant reply and injects <session_handoff>
    const handoffRes = await rpc.handoff(
      {
        fromSessionID: "ses_btw_1",
        toSessionID: "ses_root",
        delivery: "park",
      },
      rpcCtx,
    )
    expect(handoffRes).toMatchObject({
      delivery: "park",
      preview: expect.stringContaining("OPTIONS preflight"),
    })
    const syn = mock.deliveries.at(-1)
    expect(syn?.kind).toBe("synthetic")
    if (syn?.kind === "synthetic") {
      expect(syn.input.sessionID).toBe("ses_root")
      expect(syn.input.resume).toBe(false)
      expect(syn.input.text).toBe(
        '<session_handoff from="ses_btw_1" title="Forked BTW">\nOPTIONS preflight was bypassed in cors.ts.\n</session_handoff>',
      )
    }

    // A session whose turn errored before producing assistant text reports a
    // declared, human-readable RPC failure instead of a generic rpc.internal.
    const noReply = await rpc.handoff(
      {
        fromSessionID: "ses_empty",
        toSessionID: "ses_root",
        delivery: "wake",
      },
      rpcCtx,
    )
    expect(noReply).toMatchObject({
      type: "handoffNoReply",
      message: "当前会话还没有已完成的助手回复，无法送回主线",
      data: { sessionID: "ses_empty" },
    })
    expect(rpcFailures.at(-1)).toMatchObject({ type: "handoffNoReply" })
  })

  test("listHub scopes listing to the root session via parentID, caches repeats, and invalidates on writes", async () => {
    const mock = createMockHarness()
    mock.sessions.set("ses_root", makeSessionInfo({ id: "ses_root", projectID: "proj_1", title: "Root", created: 1000 }))
    mock.sessions.set(
      "ses_child",
      makeSessionInfo({
        id: "ses_child",
        parentID: "ses_root",
        projectID: "proj_1",
        title: "Child",
        agent: "explore",
        created: 1100,
      }),
    )
    for (let index = 0; index < 40; index += 1) {
      mock.sessions.set(
        `ses_other_${index}`,
        makeSessionInfo({
          id: `ses_other_${index}`,
          projectID: "proj_2",
          title: `Other ${index}`,
          created: 1200 + index,
        }),
      )
    }

    await createSessionServer(mock.ctx, { reader: createMockReader() })
    const rpc = mock.rpcHandlers()
    const rpcCtx = { signal: new AbortController().signal, error: (() => new Error("rpc")) as never }

    // Ignore the one-time watch hydration scan at startup.
    mock.listInputs.length = 0

    const first = await rpc.listHub({ rootSessionID: "ses_root" }, rpcCtx)
    expect(first.items.map((item) => item.sessionID)).toEqual(["ses_child"])
    expect(mock.listInputs.length).toBeGreaterThan(0)
    expect(mock.listInputs.every((input) => typeof input.parentID === "string")).toBe(true)

    const scans = mock.listInputs.length
    const second = await rpc.listHub({ rootSessionID: "ses_root" }, rpcCtx)
    expect(second.items.map((item) => item.sessionID)).toEqual(["ses_child"])
    expect(mock.listInputs.length).toBe(scans)

    await rpc.setHidden({ sessionID: "ses_child", hidden: true }, rpcCtx)
    const third = await rpc.listHub({ rootSessionID: "ses_root" }, rpcCtx)
    expect(third.items[0]?.hidden).toBe(true)
    expect(mock.listInputs.length).toBeGreaterThan(scans)
  })

  test("registers all 10 Code Mode tools with pinned core primitives and honors replaceNativeSubagentTool", async () => {
    const mock = createMockHarness({ replaceNativeSubagentTool: true })
    mock.sessions.set("ses_root", makeSessionInfo({ id: "ses_root", title: "Main" }))

    const reader = createMockReader()
    await createSessionServer(mock.ctx, { reader })

    expect(mock.removedTools).toContain("subagent")
    expect(mock.registeredTools.has("subagent")).toBe(false)

    const pinnedNames = ["peers", "send", "read", "create", "watch"]
    const standardNames = ["list", "info", "search", "unwatch", "wait"]

    for (const name of pinnedNames) {
      const tool = mock.registeredTools.get(`session_${name}`)
      expect(tool).toBeDefined()
      expect(tool?.options).toEqual({ namespace: "session", codemode: true, pinned: true })
    }

    for (const name of standardNames) {
      const tool = mock.registeredTools.get(`session_${name}`)
      expect(tool).toBeDefined()
      expect(tool?.options).toEqual({ namespace: "session", codemode: true })
    }

    // Exercise wait, list, info, read, search, peers
    await mock.invokeTool("wait", { sessionID: "ses_root" }, "ses_root")
    expect(mock.waitCalls).toEqual(["ses_root"])

    const peersRes = (await mock.invokeTool("peers", {}, "ses_root")) as {
      output: { peers: Array<{ alias: string }> }
    }
    expect(peersRes.output.peers.some((p) => p.alias === "root")).toBe(true)

    const listRes = (await mock.invokeTool("list", {}, "ses_root")) as { output: SessionListOutput }
    expect(listRes.output.db).toBe("/tmp/mock.db")

    const infoRes = (await mock.invokeTool("info", { sessionID: "ses_root" }, "ses_root")) as {
      output: SessionInfoOutput
    }
    expect(infoRes.output.sessionID).toBe("ses_root")

    const readRes = (await mock.invokeTool("read", { sessionID: "ses_root" }, "ses_root")) as {
      output: SessionReadOutput
    }
    expect(readRes.output.sessionID).toBe("ses_root")

    const searchRes = (await mock.invokeTool("search", { query: "auth" }, "ses_root")) as {
      output: SessionSearchOutput
    }
    expect(searchRes.output.query).toBe("auth")
  })

  test("hydrates persisted watches on startup, resolves aliases in send, and respects enabled: false", async () => {
    // 1. Persisted watch hydration across restart
    const mock = createMockHarness()
    mock.sessions.set(
      "ses_root",
      makeSessionInfo({
        id: "ses_root",
        title: "Main",
        metadata: {
          [META_KEY_HUB]: {
            version: 1,
            asideIDs: ["ses_btw"],
            watches: [{ targetID: "ses_worker", delivery: "wake", once: true, createdAt: 1000 }],
          },
        },
      }),
    )
    mock.sessions.set(
      "ses_btw",
      makeSessionInfo({
        id: "ses_btw",
        title: "Check",
        archived: 1100,
        metadata: {
          [META_KEY_SESSION]: {
            version: 1,
            rootSessionID: "ses_root",
            kind: "btw",
            readonly: true,
            hidden: false,
            label: "Check",
            createdAt: 1100,
          },
        },
      }),
    )
    mock.sessions.set(
      "ses_worker",
      makeSessionInfo({ id: "ses_worker", parentID: "ses_root", title: "Worker", agent: "general" }),
    )
    mock.contexts.set("ses_worker", [
      {
        type: "assistant",
        id: "msg_w1",
        time: { created: 1200, completed: 1250 },
        agent: "general",
        model: { providerID: "openai", id: "gpt-5" },
        content: [{ type: "text", text: "Hydrated worker finished." }],
      },
    ])
    mock.contexts.set("ses_btw", [{ type: "user", id: "m_btw", time: { created: 1150 }, text: "hi" }])
    mock.contexts.set("ses_root", [{ type: "user", id: "m_root", time: { created: 1050 }, text: "hi" }])

    await createSessionServer(mock.ctx, { reader: createMockReader() })

    await mock.fireHook("experimental.idle", {
      sessionID: asSessionID("ses_worker"),
      background: [],
    })
    expect(mock.deliveries).toHaveLength(1)
    if (mock.deliveries[0]?.kind === "synthetic") {
      expect(mock.deliveries[0].input.sessionID).toBe("ses_root")
      expect(mock.deliveries[0].input.text).toContain("Hydrated worker finished.")
    }

    // 2. Alias resolution: send from root to "btw-1", and from btw to "root"
    const toBtw = (await mock.invokeTool(
      "send",
      { to: "btw-1", message: "ping btw", delivery: "park" },
      "ses_root",
    )) as { output: { toSessionID: string } }
    expect(toBtw.output.toSessionID).toBe("ses_btw")

    const toRoot = (await mock.invokeTool(
      "send",
      { to: "root", message: "reply to root", delivery: "park" },
      "ses_btw",
    )) as { output: { toSessionID: string } }
    expect(toRoot.output.toSessionID).toBe("ses_root")

    // 3. enabled: false skips setup
    const disabledMock = createMockHarness({ enabled: false })
    const cleanup = await createSessionServer(disabledMock.ctx, { reader: createMockReader() })
    expect(cleanup).toBeUndefined()
    expect(disabledMock.registeredTools.has("session_send")).toBe(false)
  })

  test("tools.session.create stages ID without persisting empty session until first send, and send({ create }) spawns inline", async () => {
    const mock = createMockHarness()
    mock.sessions.set("ses_root", makeSessionInfo({ id: "ses_root", title: "Root", agent: "meidocho" }))
    await createSessionServer(mock.ctx, { reader: createMockReader() })

    // 1. Staged create: returns valid ses_... ID, but mock.sessions does NOT contain it yet!
    const staged = (await mock.invokeTool(
      "create",
      { agent: "explore", title: "Lazy Explore", readonly: true },
      "ses_root",
    )) as { output: { sessionID: string; staged: boolean; readonly: boolean } }

    expect(staged.output.sessionID.startsWith("ses_")).toBe(true)
    expect(staged.output.staged).toBe(true)
    expect(staged.output.readonly).toBe(true)
    expect(mock.sessions.has(staged.output.sessionID)).toBe(false)

    // Watch can already subscribe to the staged ID before it is materialized
    await mock.invokeTool(
      "watch",
      { target: staged.output.sessionID, once: true, delivery: "park" },
      "ses_root",
    )
    expect(mock.sessions.has(staged.output.sessionID)).toBe(false)

    // First send materializes the session with the exact staged ID, sets readonly, and prompts it
    const sent = (await mock.invokeTool(
      "send",
      { to: staged.output.sessionID, message: "Start lazy task", delivery: "wake" },
      "ses_root",
    )) as { output: { toSessionID: string; method: string } }

    expect(sent.output.toSessionID).toBe(staged.output.sessionID)
    expect(sent.output.method).toBe("prompt")
    expect(mock.sessions.has(staged.output.sessionID)).toBe(true)
    expect(mock.sessions.get(staged.output.sessionID)?.agent).toBe("explore")
    expect(
      (mock.sessions.get(staged.output.sessionID)?.metadata?.[META_KEY_SESSION] as { readonly: boolean })?.readonly,
    ).toBe(true)

    // 2. One-step inline send({ create: { ... }, message }) without calling create first
    const inlineSent = (await mock.invokeTool(
      "send",
      { create: { agent: "oracle" }, message: "Review auth design", delivery: "wake" },
      "ses_root",
    )) as { output: { toSessionID: string; method: string } }

    expect(inlineSent.output.toSessionID.startsWith("ses_")).toBe(true)
    expect(inlineSent.output.method).toBe("prompt")
    expect(mock.sessions.get(inlineSent.output.toSessionID)?.agent).toBe("oracle")
    expect(mock.sessions.get(inlineSent.output.toSessionID)?.title).toBe("Review auth design")
  })
})
