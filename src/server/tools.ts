import type { Location, Plugin } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { Schema } from "effect"
import {
  AsideKind,
  DeliveryMode,
  ModelRefSchema,
  O3pSessionMetaSchema,
  type PluginConfig,
  type SqliteSessionReader,
} from "../contract.ts"
import { isSessionRunning, parseSessionMeta, type SessionHub } from "./hub.ts"
import type { SessionMessenger } from "./messenger.ts"

export interface RegisterSessionToolsOptions {
  readonly tool: Plugin.Context["tool"]
  readonly session: Plugin.Context["session"]
  readonly location: Location.Info
  readonly config: PluginConfig
  readonly hub: SessionHub
  readonly messenger: SessionMessenger
  readonly getReader: () => Promise<SqliteSessionReader>
}

export function createLazySqliteReader(
  config: PluginConfig,
  injectedReader?: SqliteSessionReader,
): () => Promise<SqliteSessionReader> {
  let cachedPromise: Promise<SqliteSessionReader> | undefined
  return async () => {
    if (injectedReader) return injectedReader
    if (!cachedPromise) {
      cachedPromise = import("../store/sqlite-reader.ts").then((mod) =>
        mod.createSqliteReader(config.dbPath ? { dbPath: config.dbPath } : undefined),
      )
    }
    return cachedPromise
  }
}

const PeerItemSchema = Schema.Struct({
  sessionID: Schema.String,
  alias: Schema.String,
  relation: Schema.Literals(["self", "root", "btw", "sub", "subagent", "peer"]),
  title: Schema.String,
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(ModelRefSchema),
  status: Schema.Literals(["idle", "running"]),
  depth: Schema.Number,
  readonly: Schema.Boolean,
  hidden: Schema.Boolean,
  archived: Schema.Boolean,
  parentID: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const PeersInputSchema = Schema.Struct({
  includeOtherProjects: Schema.optional(Schema.Boolean),
})

const PeersOutputSchema = Schema.Struct({
  currentSessionID: Schema.String,
  rootSessionID: Schema.String,
  peers: Schema.Array(PeerItemSchema),
})

const InlineCreateSpecSchema = Schema.Struct({
  agent: Schema.optional(Schema.String),
  model: Schema.optional(ModelRefSchema),
  title: Schema.optional(Schema.String),
  parentID: Schema.optional(Schema.NullOr(Schema.String)),
  readonly: Schema.optional(Schema.Boolean),
})

const SendInputSchema = Schema.Struct({
  to: Schema.optional(Schema.String),
  create: Schema.optional(InlineCreateSpecSchema),
  message: Schema.String,
  delivery: Schema.optional(DeliveryMode),
})

const SendOutputSchema = Schema.Struct({
  messageID: Schema.String,
  fromSessionID: Schema.String,
  toSessionID: Schema.String,
  requestedDelivery: DeliveryMode,
  effectiveDelivery: DeliveryMode,
  hop: Schema.Number,
  maxWakeHops: Schema.Number,
  downgradedToPark: Schema.Boolean,
  reason: Schema.optional(Schema.String),
  method: Schema.Literals(["prompt", "synthetic"]),
})

const ReadInputSchema = Schema.Struct({
  sessionID: Schema.String,
  offset: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  includeTools: Schema.optional(Schema.Boolean),
  includeReasoning: Schema.optional(Schema.Boolean),
  includeInjected: Schema.optional(Schema.Boolean),
  includeSystem: Schema.optional(Schema.Boolean),
  includeCompaction: Schema.optional(Schema.Boolean),
  outFile: Schema.optional(Schema.String),
})

const ReadContentBlockSchema = Schema.Struct({
  kind: Schema.Literals(["text", "reasoning", "tool", "injected", "system", "compaction", "shell"]),
  partIndex: Schema.optional(Schema.Number),
  callID: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  text: Schema.String,
})

const ReadMessageItemSchema = Schema.Struct({
  index: Schema.Number,
  seq: Schema.Number,
  messageID: Schema.String,
  type: Schema.String,
  role: Schema.String,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(ModelRefSchema),
  createdAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
  blocks: Schema.Array(ReadContentBlockSchema),
})

const ReadOutputSchema = Schema.Struct({
  db: Schema.String,
  sessionID: Schema.String,
  title: Schema.String,
  totalMessages: Schema.Number,
  range: Schema.Struct({
    start: Schema.Number,
    end: Schema.Number,
    reverse: Schema.Boolean,
  }),
  hasMoreBefore: Schema.Boolean,
  hasMoreAfter: Schema.Boolean,
  exportedFile: Schema.optional(Schema.String),
  messages: Schema.Array(ReadMessageItemSchema),
})

const CreateInputSchema = Schema.Struct({
  agent: Schema.optional(Schema.String),
  model: Schema.optional(ModelRefSchema),
  title: Schema.optional(Schema.String),
  parentID: Schema.optional(Schema.NullOr(Schema.String)),
  readonly: Schema.optional(Schema.Boolean),
  immediate: Schema.optional(Schema.Boolean),
})

const CreateOutputSchema = Schema.Struct({
  sessionID: Schema.String,
  parentID: Schema.NullOr(Schema.String),
  title: Schema.String,
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(ModelRefSchema),
  readonly: Schema.Boolean,
  staged: Schema.Boolean,
})

const WatchInputSchema = Schema.Struct({
  target: Schema.String,
  delivery: Schema.optional(DeliveryMode),
  once: Schema.optional(Schema.Boolean),
})

const WatchOutputSchema = Schema.Struct({
  watcherID: Schema.String,
  targetID: Schema.String,
  delivery: DeliveryMode,
  once: Schema.Boolean,
})

const ListInputSchema = Schema.Struct({
  project: Schema.optional(Schema.String),
  parentID: Schema.optional(Schema.NullOr(Schema.String)),
  includeArchived: Schema.optional(Schema.Boolean),
  includeAsides: Schema.optional(Schema.Boolean),
  from: Schema.optional(Schema.Number),
  until: Schema.optional(Schema.Number),
  order: Schema.optional(Schema.Literals(["asc", "desc"])),
  limit: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.String),
})

const SessionSummaryRowSchema = Schema.Struct({
  sessionID: Schema.String,
  projectID: Schema.String,
  directory: Schema.String,
  parentID: Schema.NullOr(Schema.String),
  forkSessionID: Schema.NullOr(Schema.String),
  title: Schema.String,
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(ModelRefSchema),
  archived: Schema.Boolean,
  isAside: Schema.Boolean,
  asideKind: Schema.NullOr(AsideKind),
  rootSessionID: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})

const ListOutputSchema = Schema.Struct({
  db: Schema.String,
  items: Schema.Array(SessionSummaryRowSchema),
  nextCursor: Schema.NullOr(Schema.String),
})

const InfoInputSchema = Schema.Struct({
  sessionID: Schema.String,
})

const InfoOutputSchema = Schema.Struct({
  db: Schema.String,
  sessionID: Schema.String,
  projectID: Schema.String,
  directory: Schema.String,
  parentID: Schema.NullOr(Schema.String),
  forkSessionID: Schema.NullOr(Schema.String),
  title: Schema.String,
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(ModelRefSchema),
  archived: Schema.Boolean,
  isAside: Schema.Boolean,
  asideMeta: Schema.NullOr(O3pSessionMetaSchema),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  cost: Schema.Number,
  tokens: Schema.Struct({
    input: Schema.Number,
    output: Schema.Number,
    reasoning: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
  }),
  messageCounts: Schema.Struct({
    total: Schema.Number,
    user: Schema.Number,
    assistant: Schema.Number,
    synthetic: Schema.Number,
    system: Schema.Number,
    skill: Schema.Number,
    shell: Schema.Number,
    compaction: Schema.Number,
  }),
})

const SearchInputSchema = Schema.Struct({
  query: Schema.String,
  sessionID: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  caseSensitive: Schema.optional(Schema.Boolean),
  includeArchived: Schema.optional(Schema.Boolean),
  includeTools: Schema.optional(Schema.Boolean),
  includeReasoning: Schema.optional(Schema.Boolean),
  includeInjected: Schema.optional(Schema.Boolean),
  includeSystem: Schema.optional(Schema.Boolean),
  includeCompaction: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Number),
  cursor: Schema.optional(Schema.String),
})

const SearchHitSchema = Schema.Struct({
  sessionID: Schema.String,
  sessionTitle: Schema.String,
  messageID: Schema.String,
  messageSeq: Schema.Number,
  messageType: Schema.String,
  blockKind: Schema.Literals(["text", "reasoning", "tool", "injected", "system", "compaction", "shell"]),
  partIndex: Schema.optional(Schema.Number),
  callID: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  snippet: Schema.String,
})

const SearchOutputSchema = Schema.Struct({
  db: Schema.String,
  query: Schema.String,
  hits: Schema.Array(SearchHitSchema),
  nextCursor: Schema.NullOr(Schema.String),
})

const UnwatchInputSchema = Schema.Struct({
  target: Schema.String,
})

const UnwatchOutputSchema = Schema.Struct({
  watcherID: Schema.String,
  removed: Schema.Number,
})

const WaitInputSchema = Schema.Struct({
  sessionID: Schema.String,
})

const WaitOutputSchema = Schema.Struct({
  sessionID: Schema.String,
  idle: Schema.Boolean,
})

export async function registerSessionTools(options: RegisterSessionToolsOptions): Promise<Registration> {
  const { tool: toolDomain, session: sessionApi, location, config, hub, messenger, getReader } = options

  return toolDomain.transform((editor) => {
    if (config.replaceNativeSubagentTool) {
      editor.remove("subagent")
    }

    if (!config.enableSessionTools) {
      return
    }

    editor.namespace({
      name: "session",
      description: "Inter-session pager, child/aside lifecycle, and transcript inspection OS",
    })

    // --- Pinned Core Primitives ---

    editor.add({
      name: "peers",
      description:
        "Discover communicable sessions: full current session tree (root, descendants, /btw and /sub asides) plus active top-level sessions in the same project, with stable aliases and live status.",
      input: PeersInputSchema,
      output: PeersOutputSchema,
      options: { namespace: "session", codemode: true, pinned: true },
      execute: async (input, context) => {
        const current = await sessionApi.get({ sessionID: context.sessionID })
        const rootSessionID = await hub.resolveRootSessionID(current)
        const [rootSession, hubItems, topLevel] = await Promise.all([
          rootSessionID === current.id
            ? Promise.resolve(current)
            : sessionApi.get({ sessionID: rootSessionID }).catch(() => null),
          hub.listHub(rootSessionID),
          hub.listAllNonArchivedSessions(input.includeOtherProjects ? undefined : current.projectID, null),
        ])

        const liveByID = new Map<string, Awaited<ReturnType<typeof sessionApi.get>>>()
        liveByID.set(current.id, current)
        if (rootSession) liveByID.set(rootSession.id, rootSession)
        for (const s of topLevel) {
          liveByID.set(s.id, s)
        }

        const getStatus = async (id: string): Promise<"idle" | "running"> => {
          const cached = liveByID.get(id)
          if (cached) return isSessionRunning(cached) ? "running" : "idle"
          const fetched = await sessionApi.get({ sessionID: id }).catch(() => null)
          if (fetched) {
            liveByID.set(id, fetched)
            return isSessionRunning(fetched) ? "running" : "idle"
          }
          return "idle"
        }

        const peers: Array<typeof PeerItemSchema.Type> = []

        if (rootSession) {
          peers.push({
            sessionID: rootSession.id,
            alias: "root",
            relation: rootSession.id === context.sessionID ? "self" : "root",
            title: rootSession.title ?? rootSession.id,
            agent: rootSession.agent ?? null,
            model: rootSession.model
              ? {
                  providerID: rootSession.model.providerID,
                  id: rootSession.model.id,
                  ...(rootSession.model.variant !== undefined ? { variant: rootSession.model.variant } : {}),
                }
              : null,
            status: isSessionRunning(rootSession) ? "running" : "idle",
            depth: 0,
            readonly: false,
            hidden: false,
            archived: rootSession.time.archived !== undefined,
            parentID: rootSession.parentID ?? null,
            createdAt: rootSession.time.created,
            updatedAt: rootSession.time.updated,
          })
        }

        const treeStatuses = await Promise.all(hubItems.map((item) => getStatus(item.sessionID)))
        for (let i = 0; i < hubItems.length; i += 1) {
          const item = hubItems[i]
          if (!item) continue
          peers.push({
            sessionID: item.sessionID,
            alias: item.alias,
            relation: item.sessionID === context.sessionID ? "self" : item.kind,
            title: item.title,
            agent: item.agent,
            model: item.model,
            status: treeStatuses[i] ?? "idle",
            depth: item.depth,
            readonly: item.readonly,
            hidden: item.hidden,
            archived: item.archived,
            parentID: item.parentID,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })
        }

        const externalPeers = topLevel
          .filter((s) => s.id !== rootSessionID && !parseSessionMeta(s.metadata))
          .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))

        externalPeers.forEach((s, idx) => {
          peers.push({
            sessionID: s.id,
            alias: `peer-${idx + 1}`,
            relation: s.id === context.sessionID ? "self" : "peer",
            title: s.title ?? s.id,
            agent: s.agent ?? null,
            model: s.model
              ? {
                  providerID: s.model.providerID,
                  id: s.model.id,
                  ...(s.model.variant !== undefined ? { variant: s.model.variant } : {}),
                }
              : null,
            status: isSessionRunning(s) ? "running" : "idle",
            depth: 0,
            readonly: false,
            hidden: false,
            archived: s.time.archived !== undefined,
            parentID: s.parentID ?? null,
            createdAt: s.time.created,
            updatedAt: s.time.updated,
          })
        })

        return {
          output: {
            currentSessionID: context.sessionID,
            rootSessionID,
            peers,
          },
          content: `Found ${peers.length} peer(s) in tree/project (root=${rootSessionID}).`,
        }
      },
    })

    editor.add({
      name: "send",
      description:
        "Send a one-way message envelope to an existing/staged session (`to`: sessionID or alias) or spawn on the fly (`create`: { agent, title, ... }), with delivery 'wake' (default) or 'park'. Transmits ONLY the explicit message string.",
      input: SendInputSchema,
      output: SendOutputSchema,
      options: { namespace: "session", codemode: true, pinned: true },
      execute: async (input, context) => {
        let toSessionID: string
        if (input.to !== undefined && input.to.trim().length > 0) {
          toSessionID = await hub.resolveTargetSessionID(context.sessionID, input.to)
        } else if (input.create !== undefined) {
          const parentID = input.create.parentID === undefined ? context.sessionID : input.create.parentID
          const staged = hub.stageSession({
            parentID,
            agent: input.create.agent ?? null,
            model: input.create.model ?? null,
            title: input.create.title ?? null,
            readonly: input.create.readonly === true,
          })
          toSessionID = staged.sessionID
        } else {
          throw new Error("tools.session.send requires either `to` (target sessionID/alias) or `create` (new session spec)")
        }
        const result = await messenger.deliverSessionMessage({
          fromSessionID: context.sessionID,
          toSessionID,
          message: input.message,
          delivery: input.delivery ?? "wake",
        })
        return {
          output: result,
          content: result.downgradedToPark
            ? `Delivered to ${result.toSessionID} via ${result.method} (downgraded to park: ${result.reason}).`
            : `Delivered to ${result.toSessionID} (${result.effectiveDelivery} via ${result.method}, hop ${result.hop}/${result.maxWakeHops}).`,
        }
      },
    })

    editor.add({
      name: "read",
      description:
        "Read messages from a session transcript by 1-based positive or negative message index slice (like file read). Defaults to offset=-20, limit=20. Tool calls and reasoning blocks are omitted unless includeTools/includeReasoning are true.",
      input: ReadInputSchema,
      output: ReadOutputSchema,
      options: { namespace: "session", codemode: true, pinned: true },
      execute: async (input, context) => {
        const sessionID = await hub.resolveTargetSessionID(context.sessionID, input.sessionID)
        const reader = await getReader()
        const output = reader.read({
          ...input,
          sessionID,
        })
        return {
          output,
          content: `Read ${output.messages.length} of ${output.totalMessages} message(s) from ${sessionID} (${output.range.start}..${output.range.end}).`,
        }
      },
    })

    editor.add({
      name: "create",
      description:
        "Stage a new session ID in memory (materialized into the session store only upon its first tools.session.send, matching TUI new-session behavior; pass immediate=true to persist empty immediately).",
      input: CreateInputSchema,
      output: CreateOutputSchema,
      options: { namespace: "session", codemode: true, pinned: true },
      execute: async (input, context) => {
        const parentID = input.parentID === undefined ? context.sessionID : input.parentID
        if (input.immediate !== true) {
          const staged = hub.stageSession({
            parentID,
            agent: input.agent ?? null,
            model: input.model ?? null,
            title: input.title ?? null,
            readonly: input.readonly === true,
          })
          return {
            output: {
              sessionID: staged.sessionID,
              parentID: staged.parentID,
              title: staged.title ?? staged.sessionID,
              agent: staged.agent,
              model: staged.model,
              readonly: staged.readonly,
              staged: true,
            },
            content: `Staged session ${staged.sessionID}${staged.agent ? ` (agent=${staged.agent})` : ""}; will materialize on first send.`,
          }
        }

        const created = await sessionApi.create({
          parentID,
          agent: input.agent ?? null,
          model: input.model ?? null,
          title: input.title ?? null,
        })
        hub.markNewlyCreatedEmptySession(created.id)

        let readonly = false
        if (input.readonly === true) {
          const res = await hub.setReadonly({ sessionID: created.id, readonly: true })
          readonly = res.readonly
        }

        return {
          output: {
            sessionID: created.id,
            parentID: created.parentID ?? null,
            title: created.title ?? created.id,
            agent: created.agent ?? null,
            model: created.model
              ? {
                  providerID: created.model.providerID,
                  id: created.model.id,
                  ...(created.model.variant !== undefined ? { variant: created.model.variant } : {}),
                }
              : null,
            readonly,
            staged: false,
          },
          content: `Created session ${created.id}${created.agent ? ` (agent=${created.agent})` : ""}.`,
        }
      },
    })

    editor.add({
      name: "watch",
      description:
        "Subscribe to completion (experimental.idle) of a target session. When it finishes a turn, its latest assistant reply is delivered to the current session via 'wake' or 'park'. Use once=true for one-shot background delegation.",
      input: WatchInputSchema,
      output: WatchOutputSchema,
      options: { namespace: "session", codemode: true, pinned: true },
      execute: async (input, context) => {
        const targetID = await hub.resolveTargetSessionID(context.sessionID, input.target)
        const record = await hub.addWatch({
          watcherID: context.sessionID,
          targetID,
          delivery: input.delivery ?? "wake",
          once: input.once ?? false,
        })
        return {
          output: {
            watcherID: record.watcherID,
            targetID: record.targetID,
            delivery: record.delivery,
            once: record.once,
          },
          content: `Watching ${record.targetID} (delivery=${record.delivery}, once=${record.once}).`,
        }
      },
    })

    // --- Standard Code Mode Tools ---

    editor.add({
      name: "list",
      description:
        "List sessions from the SQLite store with filtering by project (defaults to current project; pass '*' for all projects), parentID, archive/aside visibility, time bounds, and cursor pagination.",
      input: ListInputSchema,
      output: ListOutputSchema,
      options: { namespace: "session", codemode: true },
      execute: async (input) => {
        const reader = await getReader()
        const project = input.project === "*" ? undefined : (input.project ?? location.directory)
        const output = reader.list({
          ...(project !== undefined ? { project } : {}),
          ...(input.parentID !== undefined ? { parentID: input.parentID } : {}),
          ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
          ...(input.includeAsides !== undefined ? { includeAsides: input.includeAsides } : {}),
          ...(input.from !== undefined ? { from: input.from } : {}),
          ...(input.until !== undefined ? { until: input.until } : {}),
          ...(input.order !== undefined ? { order: input.order } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        })
        return {
          output,
          content: `Listed ${output.items.length} session(s).`,
        }
      },
    })

    editor.add({
      name: "info",
      description:
        "Get quantitative overview of a session (metadata, lineage, aside info, message counts by type, token usage, and cost) without dumping transcript body.",
      input: InfoInputSchema,
      output: InfoOutputSchema,
      options: { namespace: "session", codemode: true },
      execute: async (input, context) => {
        const sessionID = await hub.resolveTargetSessionID(context.sessionID, input.sessionID)
        const reader = await getReader()
        const output = reader.info(sessionID)
        return {
          output,
          content: `Session ${output.sessionID} (${output.title}): ${output.messageCounts.total} message(s).`,
        }
      },
    })

    editor.add({
      name: "search",
      description:
        "Literal substring search across session transcripts with view filters (includeTools, includeReasoning, includeInjected, includeSystem, includeCompaction) and cursor pagination.",
      input: SearchInputSchema,
      output: SearchOutputSchema,
      options: { namespace: "session", codemode: true },
      execute: async (input, context) => {
        const reader = await getReader()
        const resolvedSessionID =
          input.sessionID !== undefined
            ? await hub.resolveTargetSessionID(context.sessionID, input.sessionID)
            : undefined
        const resolvedProject =
          input.project === "*"
            ? undefined
            : input.project !== undefined
              ? input.project
              : resolvedSessionID === undefined
                ? location.directory
                : undefined

        const output = reader.search({
          query: input.query,
          ...(resolvedSessionID !== undefined ? { sessionID: resolvedSessionID } : {}),
          ...(resolvedProject !== undefined ? { project: resolvedProject } : {}),
          ...(input.caseSensitive !== undefined ? { caseSensitive: input.caseSensitive } : {}),
          ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
          ...(input.includeTools !== undefined ? { includeTools: input.includeTools } : {}),
          ...(input.includeReasoning !== undefined ? { includeReasoning: input.includeReasoning } : {}),
          ...(input.includeInjected !== undefined ? { includeInjected: input.includeInjected } : {}),
          ...(input.includeSystem !== undefined ? { includeSystem: input.includeSystem } : {}),
          ...(input.includeCompaction !== undefined ? { includeCompaction: input.includeCompaction } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        })
        return {
          output,
          content: `Found ${output.hits.length} hit(s) for "${input.query}".`,
        }
      },
    })

    editor.add({
      name: "unwatch",
      description:
        "Remove completion watches registered by the current session for a target sessionID (or '*' to remove all watches for the current session).",
      input: UnwatchInputSchema,
      output: UnwatchOutputSchema,
      options: { namespace: "session", codemode: true },
      execute: async (input, context) => {
        const targetID =
          input.target === "*"
            ? "*"
            : await hub.resolveTargetSessionID(context.sessionID, input.target).catch(() => input.target)
        const removed = await hub.removeWatch({
          watcherID: context.sessionID,
          targetID,
        })
        return {
          output: {
            watcherID: context.sessionID,
            removed,
          },
          content: `Removed ${removed} watch(es) for ${targetID}.`,
        }
      },
    })

    editor.add({
      name: "wait",
      description:
        "Synchronously wait until a target session becomes idle. Useful in Code Mode when a script needs downstream results before continuing.",
      input: WaitInputSchema,
      output: WaitOutputSchema,
      options: { namespace: "session", codemode: true },
      execute: async (input, context) => {
        const sessionID = await hub.resolveTargetSessionID(context.sessionID, input.sessionID)
        await sessionApi.wait({ sessionID })
        return {
          output: {
            sessionID,
            idle: true,
          },
          content: `Session ${sessionID} is now idle.`,
        }
      },
    })
  })
}
