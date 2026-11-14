import { Rpc } from "@opencode/plugin"
import { Schema } from "effect"

export const PLUGIN_ID = "o3p.session"
export const PANEL_NAME = "o3p-session"

export const DEFAULT_READONLY_BLOCKED_TOOLS = [
  "write",
  "edit",
  "lsp_rename",
  "openviking_write",
  "openviking_edit",
  "openviking_forget",
] as const

export interface PluginConfig {
  readonly enabled: boolean
  readonly maxWakeHops: number
  readonly btwReadonlyByDefault: boolean
  readonly readonlyBlockedTools: readonly string[]
  readonly enableSessionTools: boolean
  readonly replaceNativeSubagentTool: boolean
  readonly dbPath?: string
}

const KNOWN_OPTION_KEYS = new Set([
  "enabled",
  "maxWakeHops",
  "btwReadonlyByDefault",
  "readonlyBlockedTools",
  "enableSessionTools",
  "replaceNativeSubagentTool",
  "dbPath",
])

export function parsePluginConfig(options: Record<string, unknown> = {}): PluginConfig {
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTION_KEYS.has(key)) {
      throw new Error(`[${PLUGIN_ID}] Unknown plugin option: ${key}`)
    }
  }
  const bool = (key: string, fallback: boolean): boolean => {
    const val = options[key]
    if (val === undefined) return fallback
    if (typeof val !== "boolean") throw new Error(`[${PLUGIN_ID}] Option "${key}" must be a boolean`)
    return val
  }
  const hops = options.maxWakeHops ?? 3
  if (typeof hops !== "number" || !Number.isSafeInteger(hops) || hops < 0 || hops > 20) {
    throw new Error(`[${PLUGIN_ID}] Option "maxWakeHops" must be an integer between 0 and 20`)
  }
  let blocked: readonly string[] = DEFAULT_READONLY_BLOCKED_TOOLS
  if (options.readonlyBlockedTools !== undefined) {
    if (
      !Array.isArray(options.readonlyBlockedTools) ||
      !options.readonlyBlockedTools.every((item) => typeof item === "string" && item.length > 0)
    ) {
      throw new Error(`[${PLUGIN_ID}] Option "readonlyBlockedTools" must be an array of non-empty strings`)
    }
    blocked = options.readonlyBlockedTools
  }
  let dbPath: string | undefined
  if (options.dbPath !== undefined) {
    if (typeof options.dbPath !== "string" || options.dbPath.trim().length === 0) {
      throw new Error(`[${PLUGIN_ID}] Option "dbPath" must be a non-empty string`)
    }
    dbPath = options.dbPath
  }
  return {
    enabled: bool("enabled", true),
    maxWakeHops: hops,
    btwReadonlyByDefault: bool("btwReadonlyByDefault", true),
    readonlyBlockedTools: blocked,
    enableSessionTools: bool("enableSessionTools", true),
    replaceNativeSubagentTool: bool("replaceNativeSubagentTool", false),
    ...(dbPath ? { dbPath } : {}),
  }
}

export const META_KEY_SESSION = "o3pSession"
export const META_KEY_HUB = "o3pSessionHub"

export const DeliveryMode = Schema.Literals(["wake", "park"])
export type DeliveryMode = typeof DeliveryMode.Type

export const AsideKind = Schema.Literals(["btw", "sub"])
export type AsideKind = typeof AsideKind.Type

export const HubItemKind = Schema.Literals(["btw", "sub", "subagent"])
export type HubItemKind = typeof HubItemKind.Type

export const ModelRefSchema = Schema.Struct({
  providerID: Schema.String,
  id: Schema.String,
  variant: Schema.optional(Schema.String),
})
export type ModelRefInfo = typeof ModelRefSchema.Type

export const O3pSessionMetaSchema = Schema.Struct({
  version: Schema.Literal(1),
  rootSessionID: Schema.String,
  kind: AsideKind,
  readonly: Schema.Boolean,
  hidden: Schema.Boolean,
  label: Schema.String,
  createdAt: Schema.Number,
})
export type O3pSessionMeta = typeof O3pSessionMetaSchema.Type

export const WatchEntrySchema = Schema.Struct({
  targetID: Schema.String,
  delivery: DeliveryMode,
  once: Schema.Boolean,
  createdAt: Schema.Number,
})
export type WatchEntry = typeof WatchEntrySchema.Type

export const O3pSessionHubMetaSchema = Schema.Struct({
  version: Schema.Literal(1),
  asideIDs: Schema.Array(Schema.String),
  watches: Schema.Array(WatchEntrySchema),
})
export type O3pSessionHubMeta = typeof O3pSessionHubMetaSchema.Type

export const HubItemSchema = Schema.Struct({
  sessionID: Schema.String,
  rootSessionID: Schema.String,
  parentID: Schema.NullOr(Schema.String),
  kind: HubItemKind,
  depth: Schema.Number,
  index: Schema.Number,
  alias: Schema.String,
  title: Schema.String,
  label: Schema.String,
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(ModelRefSchema),
  readonly: Schema.Boolean,
  hidden: Schema.Boolean,
  archived: Schema.Boolean,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type HubItem = typeof HubItemSchema.Type

// --- SQLite Reader Shared Types ---

export interface ViewOptions {
  readonly includeTools?: boolean
  readonly includeReasoning?: boolean
  readonly includeInjected?: boolean
  readonly includeSystem?: boolean
  readonly includeCompaction?: boolean
}

export interface SessionListQuery {
  readonly project?: string
  readonly parentID?: string | null
  readonly includeArchived?: boolean
  readonly includeAsides?: boolean
  readonly from?: number
  readonly until?: number
  readonly order?: "asc" | "desc"
  readonly limit?: number
  readonly cursor?: string
}

export interface SessionSummaryRow {
  readonly sessionID: string
  readonly projectID: string
  readonly directory: string
  readonly parentID: string | null
  readonly forkSessionID: string | null
  readonly title: string
  readonly agent: string | null
  readonly model: ModelRefInfo | null
  readonly archived: boolean
  readonly isAside: boolean
  readonly asideKind: AsideKind | null
  readonly rootSessionID: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface SessionListOutput {
  readonly db: string
  readonly items: readonly SessionSummaryRow[]
  readonly nextCursor: string | null
}

export interface SessionInfoOutput {
  readonly db: string
  readonly sessionID: string
  readonly projectID: string
  readonly directory: string
  readonly parentID: string | null
  readonly forkSessionID: string | null
  readonly title: string
  readonly agent: string | null
  readonly model: ModelRefInfo | null
  readonly archived: boolean
  readonly isAside: boolean
  readonly asideMeta: O3pSessionMeta | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly cost: number
  readonly tokens: {
    readonly input: number
    readonly output: number
    readonly reasoning: number
    readonly cacheRead: number
    readonly cacheWrite: number
  }
  readonly messageCounts: {
    readonly total: number
    readonly user: number
    readonly assistant: number
    readonly synthetic: number
    readonly system: number
    readonly skill: number
    readonly shell: number
    readonly compaction: number
  }
}

export interface ReadContentBlock {
  readonly kind: "text" | "reasoning" | "tool" | "injected" | "system" | "compaction" | "shell"
  readonly partIndex?: number
  readonly callID?: string
  readonly toolName?: string
  readonly status?: string
  readonly text: string
}

export interface ReadMessageItem {
  /** 1-based ordinal in the filtered session view */
  readonly index: number
  readonly seq: number
  readonly messageID: string
  readonly type: string
  readonly role: string
  readonly agent?: string
  readonly model?: ModelRefInfo
  readonly createdAt: number
  readonly completedAt?: number
  readonly blocks: readonly ReadContentBlock[]
}

export interface SessionReadQuery extends ViewOptions {
  readonly sessionID: string
  /**
   * 1-based positive index from the start (1..N), or negative index from the end (-N..-1, e.g. -20 starts 20 from the end).
   * Defaults to -20.
   */
  readonly offset?: number
  /**
   * Positive reads chronologically forward `limit` messages from `offset`;
   * negative reads backward `|limit|` messages in reverse chronological order starting at `offset` (e.g. offset: -1, limit: -10).
   * Defaults to 20.
   */
  readonly limit?: number
  /** Optional exclusive path to export full rendered Markdown transcript */
  readonly outFile?: string
}

export interface SessionReadOutput {
  readonly db: string
  readonly sessionID: string
  readonly title: string
  readonly totalMessages: number
  readonly range: {
    readonly start: number
    readonly end: number
    readonly reverse: boolean
  }
  readonly hasMoreBefore: boolean
  readonly hasMoreAfter: boolean
  readonly exportedFile?: string
  readonly messages: readonly ReadMessageItem[]
}

export interface SessionSearchQuery extends ViewOptions {
  readonly query: string
  readonly sessionID?: string
  readonly project?: string
  readonly caseSensitive?: boolean
  readonly includeArchived?: boolean
  readonly limit?: number
  readonly cursor?: string
}

export interface SessionSearchHit {
  readonly sessionID: string
  readonly sessionTitle: string
  readonly messageID: string
  readonly messageSeq: number
  readonly messageType: string
  readonly blockKind: ReadContentBlock["kind"]
  readonly partIndex?: number
  readonly callID?: string
  readonly createdAt: number
  readonly snippet: string
}

export interface SessionSearchOutput {
  readonly db: string
  readonly query: string
  readonly hits: readonly SessionSearchHit[]
  readonly nextCursor: string | null
}

export interface SqliteSessionReader {
  list(query?: SessionListQuery): SessionListOutput
  info(sessionID: string): SessionInfoOutput
  read(query: SessionReadQuery): SessionReadOutput
  search(query: SessionSearchQuery): SessionSearchOutput
}

// --- Server <-> TUI RPC Contract ---

export const SessionRpc = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    registerAside: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          rootSessionID: Schema.String,
          kind: AsideKind,
          readonly: Schema.optional(Schema.Boolean),
          label: Schema.String,
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          meta: O3pSessionMetaSchema,
        }),
      ),
    },
    setReadonly: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          readonly: Schema.Boolean,
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          readonly: Schema.Boolean,
        }),
      ),
    },
    setHidden: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          sessionID: Schema.String,
          hidden: Schema.Boolean,
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          hidden: Schema.Boolean,
        }),
      ),
    },
    listHub: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          rootSessionID: Schema.String,
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          items: Schema.Array(HubItemSchema),
        }),
      ),
    },
    handoff: {
      input: Schema.toStandardSchemaV1(
        Schema.Struct({
          fromSessionID: Schema.String,
          toSessionID: Schema.String,
          delivery: DeliveryMode,
          customText: Schema.optional(Schema.String),
        }),
      ),
      output: Schema.toStandardSchemaV1(
        Schema.Struct({
          messageID: Schema.String,
          preview: Schema.String,
          delivery: DeliveryMode,
        }),
      ),
    },
  },
  events: {
    updated: {
      schema: Schema.toStandardSchemaV1(
        Schema.Struct({
          rootSessionID: Schema.String,
          sessionID: Schema.String,
        }),
      ),
    },
  },
})
