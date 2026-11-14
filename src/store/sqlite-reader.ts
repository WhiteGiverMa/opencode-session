import { closeSync, existsSync, openSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

import {
  META_KEY_SESSION,
  type AsideKind,
  type ModelRefInfo,
  type O3pSessionMeta,
  type ReadContentBlock,
  type ReadMessageItem,
  type SessionInfoOutput,
  type SessionListOutput,
  type SessionListQuery,
  type SessionReadOutput,
  type SessionReadQuery,
  type SessionSearchHit,
  type SessionSearchOutput,
  type SessionSearchQuery,
  type SessionSummaryRow,
  type SqliteSessionReader,
  type ViewOptions,
} from "../contract.ts"

// ---------------------------------------------------------------------------
// SQLite adapter (Bun first, Node fallback)
// ---------------------------------------------------------------------------

/** Values we bind to SQLite. Everything the reader stores is text, integer or null. */
type SqlValue = string | number | null

interface StatementLike {
  all(...params: SqlValue[]): unknown[]
  get(...params: SqlValue[]): unknown
}

interface ConnectionLike {
  prepare(sql: string): StatementLike
  exec(sql: string): void
  close(): void
}

interface BunSqliteModule {
  Database: new (filename: string, options?: { readonly?: boolean }) => unknown
}

interface NodeSqliteModule {
  DatabaseSync: new (filename: string, options?: { readOnly?: boolean }) => unknown
}

type OpenConnection = (file: string) => ConnectionLike

const runtimeRequire = createRequire(import.meta.url)

let openConnection: OpenConnection | null = null

function connectionOpener(): OpenConnection {
  if (openConnection !== null) return openConnection
  const versions = process.versions as Record<string, string | undefined>
  const isBun = typeof versions.bun === "string" && versions.bun.length > 0
  if (isBun) {
    const sqlite = runtimeRequire("bun:sqlite") as unknown as BunSqliteModule
    openConnection = (file) => new sqlite.Database(file, { readonly: true }) as unknown as ConnectionLike
  } else {
    const sqlite = runtimeRequire("node:sqlite") as unknown as NodeSqliteModule
    openConnection = (file) => new sqlite.DatabaseSync(file, { readOnly: true }) as unknown as ConnectionLike
  }
  return openConnection
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeClose(db: ConnectionLike): void {
  try {
    db.close()
  } catch {
    // Closing must never mask the query result. The process exit still releases
    // the descriptor, and every caller gets a fresh connection anyway.
  }
}

function openReadOnly(file: string): ConnectionLike {
  if (!existsSync(file)) throw new Error(`[o3p.session] SQLite database not found: ${file}`)
  let db: ConnectionLike
  try {
    db = connectionOpener()(file)
  } catch (error) {
    throw new Error(`[o3p.session] Cannot open SQLite database read-only at ${file}: ${messageOf(error)}`)
  }
  try {
    // Wait briefly for a concurrent WAL checkpoint, then make the connection
    // incapable of writing even if a future query is accidentally malformed.
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("PRAGMA query_only = ON")
  } catch (error) {
    safeClose(db)
    throw new Error(`[o3p.session] Cannot initialize read-only SQLite connection at ${file}: ${messageOf(error)}`)
  }
  return db
}

/**
 * Runs one logical query on its own read-only connection and always closes it,
 * so the live OpenCode server's WAL checkpoints are never held up by a reader.
 */
function withDatabase<T>(file: string, run: (db: ConnectionLike) => T): T {
  const db = openReadOnly(file)
  try {
    return run(db)
  } finally {
    safeClose(db)
  }
}

// ---------------------------------------------------------------------------
// Small decoding helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function recordOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("[o3p.session] Malformed SQLite row: expected an object")
  return value
}

function asText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (value instanceof Uint8Array) return new TextDecoder("utf-8").decode(value)
  return null
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "bigint") return Number(value)
  return null
}

function parseJson(value: unknown): unknown {
  const text = asText(value)
  if (text === null || text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  const parsed = parseJson(value)
  return isRecord(parsed) ? parsed : null
}

function parseModelRef(value: unknown): ModelRefInfo | null {
  const record = parseJsonRecord(value)
  if (record === null) return null
  const id = asText(record.id)
  const providerID = asText(record.providerID)
  if (id === null || id.length === 0 || providerID === null || providerID.length === 0) return null
  const variant = asText(record.variant)
  return variant !== null && variant.length > 0 ? { providerID, id, variant } : { providerID, id }
}

function parseAsideMeta(value: unknown): O3pSessionMeta | null {
  if (!isRecord(value)) return null
  const rootSessionID = asText(value.rootSessionID)
  const kind = value.kind
  const label = asText(value.label)
  const createdAt = asNumber(value.createdAt)
  if (value.version !== 1) return null
  if (rootSessionID === null || rootSessionID.length === 0) return null
  if (kind !== "btw" && kind !== "sub") return null
  if (typeof value.readonly !== "boolean" || typeof value.hidden !== "boolean") return null
  if (label === null) return null
  if (createdAt === null) return null
  return {
    version: 1,
    rootSessionID,
    kind,
    readonly: value.readonly,
    hidden: value.hidden,
    label,
    createdAt,
  }
}

function tableExists(db: ConnectionLike, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return isRecord(row) && row.name === name
}

function assertReadableSchema(db: ConnectionLike): void {
  if (!tableExists(db, "session_v2") || !tableExists(db, "session_message")) {
    throw new Error("[o3p.session] Unsupported SQLite layout: expected the OpenCode v2 session_v2 and session_message tables")
  }
}

// ---------------------------------------------------------------------------
// Database path resolution
// ---------------------------------------------------------------------------

function openCodeDataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg !== undefined && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode")
}

function envValue(name: string): string | undefined {
  const value = process.env[name]
  if (value === undefined || value.length === 0) return undefined
  return value
}

function assertPlainPath(value: string, source: string): string {
  if (value === ":memory:") {
    throw new Error(`[o3p.session] ${source} must not be ":memory:"; the session reader only inspects existing database files`)
  }
  if (/^file:/i.test(value)) {
    throw new Error(`[o3p.session] ${source} must be a plain filesystem path, not a SQLite file: URI`)
  }
  return value
}

/**
 * Resolves the OpenCode SQLite database in the same order the host uses:
 * explicit option, OPENCODE_SESSION_DB, OPENCODE_DB (relative values live in
 * the OpenCode data directory), then the standard data directory database.
 */
export function resolveDatabasePath(explicitPath?: string): string {
  if (explicitPath !== undefined && explicitPath.length > 0) {
    return path.resolve(assertPlainPath(explicitPath, "dbPath"))
  }
  const sessionDb = envValue("OPENCODE_SESSION_DB")
  if (sessionDb !== undefined) {
    return path.resolve(assertPlainPath(sessionDb, "OPENCODE_SESSION_DB"))
  }
  const nativeDb = envValue("OPENCODE_DB")
  if (nativeDb !== undefined) {
    return path.resolve(openCodeDataRoot(), assertPlainPath(nativeDb, "OPENCODE_DB"))
  }
  return path.join(openCodeDataRoot(), "opencode.db")
}

// ---------------------------------------------------------------------------
// Session rows
// ---------------------------------------------------------------------------

const SESSION_COLUMNS = [
  "id",
  "project_id",
  "directory",
  "parent_id",
  "fork_session_id",
  "title",
  "agent",
  "model",
  "metadata",
  "cost",
  "tokens_input",
  "tokens_output",
  "tokens_reasoning",
  "tokens_cache_read",
  "tokens_cache_write",
  "time_created",
  "time_updated",
  "time_archived",
] as const

const SESSION_SELECT = SESSION_COLUMNS.join(", ")

// The aside marker is JSON in metadata. json_type() distinguishes a present
// key with a null value from a missing key; malformed legacy metadata falls
// back to a conservative textual probe instead of making json_extract throw.
const EXCLUDE_ASIDES_SQL = `CASE
  WHEN metadata IS NULL THEN 0
  WHEN json_valid(metadata) THEN json_type(metadata, ?) IS NOT NULL
  ELSE instr(metadata, ?) > 0
END = 0`

interface SessionTokens {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

interface DecodedSession {
  readonly sessionID: string
  readonly projectID: string
  readonly directory: string
  readonly parentID: string | null
  readonly forkSessionID: string | null
  readonly title: string
  readonly agent: string | null
  readonly model: ModelRefInfo | null
  readonly metadata: Record<string, unknown> | null
  readonly archived: boolean
  readonly isAside: boolean
  readonly asideKind: AsideKind | null
  readonly rootSessionID: string | null
  readonly asideMeta: O3pSessionMeta | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly cost: number
  readonly tokens: SessionTokens
}

function decodeSession(row: Record<string, unknown>): DecodedSession {
  const sessionID = asText(row.id)
  if (sessionID === null || sessionID.length === 0) {
    throw new Error("[o3p.session] Malformed session_v2 row: missing id")
  }
  const rawMetadata = asText(row.metadata)
  const metadata = parseJsonRecord(row.metadata)
  const hasAsideKey =
    metadata !== null
      ? Object.prototype.hasOwnProperty.call(metadata, META_KEY_SESSION)
      : rawMetadata !== null && rawMetadata.includes(`"${META_KEY_SESSION}"`)
  const asideMeta = parseAsideMeta(metadata?.[META_KEY_SESSION])
  const createdAt = asNumber(row.time_created) ?? 0
  const updatedAt = asNumber(row.time_updated) ?? createdAt
  return {
    sessionID,
    projectID: asText(row.project_id) ?? "",
    directory: asText(row.directory) ?? "",
    parentID: asText(row.parent_id),
    forkSessionID: asText(row.fork_session_id),
    title: asText(row.title) ?? "",
    agent: asText(row.agent),
    model: parseModelRef(row.model),
    metadata,
    archived: asNumber(row.time_archived) !== null,
    isAside: hasAsideKey,
    asideKind: asideMeta?.kind ?? null,
    rootSessionID: asideMeta?.rootSessionID ?? null,
    asideMeta,
    createdAt,
    updatedAt,
    cost: asNumber(row.cost) ?? 0,
    tokens: {
      input: asNumber(row.tokens_input) ?? 0,
      output: asNumber(row.tokens_output) ?? 0,
      reasoning: asNumber(row.tokens_reasoning) ?? 0,
      cacheRead: asNumber(row.tokens_cache_read) ?? 0,
      cacheWrite: asNumber(row.tokens_cache_write) ?? 0,
    },
  }
}

function summaryOf(session: DecodedSession): SessionSummaryRow {
  return {
    sessionID: session.sessionID,
    projectID: session.projectID,
    directory: session.directory,
    parentID: session.parentID,
    forkSessionID: session.forkSessionID,
    title: session.title,
    agent: session.agent,
    model: session.model,
    archived: session.archived,
    isAside: session.isAside,
    asideKind: session.asideKind,
    rootSessionID: session.rootSessionID,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}

// ---------------------------------------------------------------------------
// Cursors and limits
// ---------------------------------------------------------------------------

interface ListCursor {
  readonly order: "asc" | "desc"
  readonly time: number
  readonly id: string
}

interface SearchCursor {
  readonly time: number
  readonly sessionID: string
  readonly messageSeq: number
  readonly blockIndex: number
}

function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
}

function decodeCursor(token: string, what: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"))
  } catch {
    throw new Error(`[o3p.session] Invalid ${what} cursor: not base64url JSON`)
  }
  if (!isRecord(parsed)) throw new Error(`[o3p.session] Invalid ${what} cursor: malformed envelope`)
  return parsed
}

function encodeListCursor(cursor: ListCursor): string {
  return encodeCursor({ v: 1, o: cursor.order, t: cursor.time, i: cursor.id })
}

function decodeListCursor(token: string): ListCursor {
  const envelope = decodeCursor(token, "list")
  const time = asNumber(envelope.t)
  const id = asText(envelope.i)
  const order = envelope.o
  if (envelope.v !== 1 || (order !== "asc" && order !== "desc") || time === null || id === null || id.length === 0) {
    throw new Error("[o3p.session] Invalid list cursor")
  }
  return { order, time, id }
}

function encodeSearchCursor(cursor: SearchCursor): string {
  return encodeCursor({
    v: 1,
    t: cursor.time,
    s: cursor.sessionID,
    q: cursor.messageSeq,
    b: cursor.blockIndex,
  })
}

function decodeSearchCursor(token: string): SearchCursor {
  const envelope = decodeCursor(token, "search")
  const time = asNumber(envelope.t)
  const sessionID = asText(envelope.s)
  const messageSeq = asNumber(envelope.q)
  const blockIndex = asNumber(envelope.b)
  if (
    envelope.v !== 1 ||
    time === null ||
    sessionID === null ||
    sessionID.length === 0 ||
    messageSeq === null ||
    !Number.isSafeInteger(messageSeq) ||
    blockIndex === null ||
    !Number.isSafeInteger(blockIndex)
  ) {
    throw new Error("[o3p.session] Invalid search cursor")
  }
  return { time, sessionID, messageSeq, blockIndex }
}

function normalizeLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`[o3p.session] limit must be an integer between 1 and ${maximum}`)
  }
  return value
}

function normalizeProject(input: string): string {
  if (input.length === 0) throw new Error("[o3p.session] project must be a non-empty directory path")
  let normalized = input.replace(/\\/g, "/")
  while (normalized.length > 1 && normalized.endsWith("/") && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }
  return normalized
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function listSessions(db: ConnectionLike, dbFile: string, query: SessionListQuery): SessionListOutput {
  assertReadableSchema(db)
  const order = query.order ?? "desc"
  if (order !== "asc" && order !== "desc") throw new Error('[o3p.session] order must be "asc" or "desc"')
  const limit = normalizeLimit(query.limit, 50, 500)

  const where: string[] = []
  const params: SqlValue[] = []

  if (query.includeArchived !== true) where.push("time_archived IS NULL")
  if (query.includeAsides !== true) {
    where.push(EXCLUDE_ASIDES_SQL)
    params.push(`$.${META_KEY_SESSION}`, `"${META_KEY_SESSION}"`)
  }
  if (query.project !== undefined && query.project !== "*") {
    const normalized = normalizeProject(query.project)
    where.push("(project_id = ? OR REPLACE(directory, '\\', '/') = ?)")
    params.push(query.project, normalized)
  }
  if (query.parentID !== undefined) {
    if (query.parentID === null) {
      where.push("parent_id IS NULL")
    } else {
      where.push("parent_id = ?")
      params.push(query.parentID)
    }
  }
  if (query.from !== undefined) {
    const from = asNumber(query.from)
    if (from === null) throw new Error("[o3p.session] from must be a finite number")
    where.push("time_updated >= ?")
    params.push(from)
  }
  if (query.until !== undefined) {
    const until = asNumber(query.until)
    if (until === null) throw new Error("[o3p.session] until must be a finite number")
    where.push("time_updated < ?")
    params.push(until)
  }
  if (query.cursor !== undefined) {
    const anchor = decodeListCursor(query.cursor)
    if (anchor.order !== order) throw new Error("[o3p.session] List cursor does not match the requested order")
    const operator = order === "asc" ? ">" : "<"
    where.push(`(time_updated ${operator} ? OR (time_updated = ? AND id ${operator} ?))`)
    params.push(anchor.time, anchor.time, anchor.id)
  }

  const direction = order === "asc" ? "ASC" : "DESC"
  const sql =
    `SELECT ${SESSION_SELECT} FROM session_v2` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY time_updated ${direction}, id ${direction} LIMIT ?`
  params.push(limit + 1)

  const rows = db
    .prepare(sql)
    .all(...params)
    .map((row) => decodeSession(recordOf(row)))
  const hasMore = rows.length > limit
  const decoded = hasMore ? rows.slice(0, limit) : rows
  const items = decoded.map(summaryOf)
  const last = decoded.length > 0 ? decoded[decoded.length - 1] : undefined
  return {
    db: dbFile,
    items,
    nextCursor: hasMore && last !== undefined ? encodeListCursor({ order, time: last.updatedAt, id: last.sessionID }) : null,
  }
}

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

function sessionInfo(db: ConnectionLike, dbFile: string, sessionID: string): SessionInfoOutput {
  assertReadableSchema(db)
  if (sessionID.length === 0) throw new Error("[o3p.session] sessionID must be non-empty")
  const row = db.prepare(`SELECT ${SESSION_SELECT} FROM session_v2 WHERE id = ?`).get(sessionID)
  if (!isRecord(row)) throw new Error(`[o3p.session] Session not found: ${sessionID}`)
  const session = decodeSession(row)

  const counts = {
    total: 0,
    user: 0,
    assistant: 0,
    synthetic: 0,
    system: 0,
    skill: 0,
    shell: 0,
    compaction: 0,
  }
  const countRows = db
    .prepare("SELECT type, COUNT(*) AS count FROM session_message WHERE session_id = ? GROUP BY type")
    .all(sessionID)
  for (const raw of countRows) {
    const counted = recordOf(raw)
    const type = asText(counted.type)
    const count = asNumber(counted.count) ?? 0
    counts.total += count
    switch (type) {
      case "user":
        counts.user += count
        break
      case "assistant":
        counts.assistant += count
        break
      case "synthetic":
        counts.synthetic += count
        break
      case "system":
        counts.system += count
        break
      case "skill":
        counts.skill += count
        break
      case "shell":
        counts.shell += count
        break
      case "compaction":
        counts.compaction += count
        break
    }
  }

  return {
    db: dbFile,
    sessionID: session.sessionID,
    projectID: session.projectID,
    directory: session.directory,
    parentID: session.parentID,
    forkSessionID: session.forkSessionID,
    title: session.title,
    agent: session.agent,
    model: session.model,
    archived: session.archived,
    isAside: session.isAside,
    asideMeta: session.asideMeta,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cost: session.cost,
    tokens: session.tokens,
    messageCounts: counts,
  }
}

// ---------------------------------------------------------------------------
// Message decoding and view projection
// ---------------------------------------------------------------------------

interface MessageRow {
  readonly id: string
  readonly type: string
  readonly seq: number
  readonly timeCreated: number
  readonly timeUpdated: number
  readonly data: Record<string, unknown>
}

function loadMessageRows(db: ConnectionLike, sessionID: string): MessageRow[] {
  const rows = db
    .prepare(
      "SELECT id, type, seq, time_created, time_updated, data FROM session_message WHERE session_id = ? ORDER BY seq ASC",
    )
    .all(sessionID)
  return rows.map((raw) => {
    const row = recordOf(raw)
    const id = asText(row.id)
    const type = asText(row.type)
    if (id === null || id.length === 0 || type === null) {
      throw new Error("[o3p.session] Malformed session_message row: missing id or type")
    }
    return {
      id,
      type,
      seq: asNumber(row.seq) ?? 0,
      timeCreated: asNumber(row.time_created) ?? 0,
      timeUpdated: asNumber(row.time_updated) ?? 0,
      data: parseJsonRecord(row.data) ?? {},
    }
  })
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

/**
 * OpenCode v2.2.7+ may keep assistant blocks in `session_part` instead of
 * inline `data.content`. A message with zero part rows keeps its inline
 * content, which is what forked and legacy rows rely on.
 */
function hydrateParts(db: ConnectionLike, messages: readonly MessageRow[]): Map<string, unknown[]> {
  const parts = new Map<string, unknown[]>()
  if (!tableExists(db, "session_part")) return parts
  const assistantIDs = messages.filter((message) => message.type === "assistant").map((message) => message.id)
  if (assistantIDs.length === 0) return parts
  for (const ids of chunked(assistantIDs, 400)) {
    const placeholders = ids.map(() => "?").join(", ")
    const rows = db
      .prepare(
        `SELECT message_id, ordinal, data FROM session_part WHERE message_id IN (${placeholders}) ORDER BY message_id ASC, ordinal ASC`,
      )
      .all(...ids)
    for (const raw of rows) {
      const row = recordOf(raw)
      const messageID = asText(row.message_id)
      const parsed = parseJson(row.data)
      if (messageID === null || parsed === undefined) continue
      const list = parts.get(messageID)
      if (list === undefined) parts.set(messageID, [parsed])
      else list.push(parsed)
    }
  }
  return parts
}

const MAX_TOOL_FIELD_CHARS = 8000

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n…`
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return truncate(value, MAX_TOOL_FIELD_CHARS)
  try {
    const encoded = JSON.stringify(value, null, 2)
    return encoded === undefined ? String(value) : truncate(encoded, MAX_TOOL_FIELD_CHARS)
  } catch {
    return truncate(String(value), MAX_TOOL_FIELD_CHARS)
  }
}

function summarizeTool(state: Record<string, unknown> | null): string {
  const lines: string[] = []
  if (state !== null) {
    if (state.input !== undefined) lines.push(`input: ${formatValue(state.input)}`)
    if (state.content !== undefined) lines.push(`content: ${formatValue(state.content)}`)
    if (state.error !== undefined) lines.push(`error: ${formatValue(state.error)}`)
  }
  return lines.length > 0 ? lines.join("\n") : "[tool call]"
}

function toolBlock(part: Record<string, unknown>, partIndex: number): ReadContentBlock {
  const state = parseJsonRecord(part.state)
  const callID = asText(part.id)
  const toolName = asText(part.name)
  const status = state !== null ? asText(state.status) : null
  return {
    kind: "tool",
    partIndex,
    ...(callID !== null ? { callID } : {}),
    ...(toolName !== null ? { toolName } : {}),
    ...(status !== null ? { status } : {}),
    text: summarizeTool(state),
  }
}

function shellOutput(value: unknown): string | null {
  if (typeof value === "string") return value
  const record = parseJsonRecord(value)
  if (record === null) return null
  const output = asText(record.output)
  return output !== null ? output : formatValue(record)
}

function shellBlock(data: Record<string, unknown>): ReadContentBlock {
  const status = asText(data.status)
  const command = asText(data.command)
  const output = shellOutput(data.output)
  const body: string[] = []
  if (command !== null && command.length > 0) body.push(command)
  if (output !== null && output.length > 0) body.push(output)
  if (body.length === 0) body.push(`[shell${status !== null ? ` ${status}` : ""}]`)
  return {
    kind: "shell",
    ...(status !== null ? { status } : {}),
    text: body.join("\n"),
  }
}

function injectedBlock(data: Record<string, unknown>): ReadContentBlock | null {
  const text = asText(data.text) ?? asText(data.description)
  if (text === null) return null
  return { kind: "injected", text }
}

function systemBlock(data: Record<string, unknown>): ReadContentBlock | null {
  const text = asText(data.text) ?? asText(data.description)
  if (text === null) return null
  return { kind: "system", text }
}

function compactionBlock(data: Record<string, unknown>): ReadContentBlock {
  const status = asText(data.status)
  const summary = asText(data.summary)
  const text = summary !== null ? summary : formatValue(data.error ?? `[compaction ${status ?? "unknown"}]`)
  return {
    kind: "compaction",
    ...(status !== null ? { status } : {}),
    text,
  }
}

function userBlocks(data: Record<string, unknown>): ReadContentBlock[] {
  const blocks: ReadContentBlock[] = []
  const text = asText(data.text)
  if (text !== null) {
    blocks.push({ kind: "text", text })
    return blocks
  }
  if (!Array.isArray(data.parts)) return blocks
  for (let index = 0; index < data.parts.length; index++) {
    const part = data.parts[index]
    if (typeof part === "string") {
      blocks.push({ kind: "text", partIndex: index, text: part })
      continue
    }
    const record = parseJsonRecord(part)
    if (record === null) continue
    const partText = asText(record.text)
    if (partText !== null) blocks.push({ kind: "text", partIndex: index, text: partText })
  }
  return blocks
}

function assistantBlocks(data: Record<string, unknown>, view: ViewOptions): ReadContentBlock[] {
  const blocks: ReadContentBlock[] = []
  if (!Array.isArray(data.content)) return blocks
  for (let index = 0; index < data.content.length; index++) {
    const part = parseJsonRecord(data.content[index])
    if (part === null) continue
    const type = asText(part.type)
    if (type === "text") {
      const text = asText(part.text)
      if (text !== null) blocks.push({ kind: "text", partIndex: index, text })
      continue
    }
    if (view.includeReasoning === true && (type === "reasoning" || type === "thinking")) {
      const text = asText(part.text)
      if (text !== null) blocks.push({ kind: "reasoning", partIndex: index, text })
      continue
    }
    if (view.includeTools === true && type === "tool") blocks.push(toolBlock(part, index))
  }
  return blocks
}

function projectMessage(row: MessageRow, view: ViewOptions): ReadMessageItem | null {
  let blocks: ReadContentBlock[] = []
  switch (row.type) {
    case "user":
      blocks = userBlocks(row.data)
      break
    case "assistant":
      blocks = assistantBlocks(row.data, view)
      break
    case "shell":
      if (view.includeTools === true) blocks = [shellBlock(row.data)]
      break
    case "synthetic":
    case "skill":
      if (view.includeInjected === true) {
        const block = injectedBlock(row.data)
        if (block !== null) blocks = [block]
      }
      break
    case "system":
      if (view.includeSystem === true) {
        const block = systemBlock(row.data)
        if (block !== null) blocks = [block]
      }
      break
    case "compaction":
      if (view.includeCompaction === true) blocks = [compactionBlock(row.data)]
      break
    default:
      break
  }
  if (blocks.length === 0) return null

  const time = parseJsonRecord(row.data.time)
  const createdAt = time !== null ? asNumber(time.created) ?? row.timeCreated : row.timeCreated
  const completedAt = time !== null ? asNumber(time.completed) : null
  const agent = asText(row.data.agent)
  const model = parseModelRef(row.data.model)
  return {
    index: 0,
    seq: row.seq,
    messageID: row.id,
    type: row.type,
    role: row.type,
    ...(agent !== null ? { agent } : {}),
    ...(model !== null ? { model } : {}),
    createdAt,
    ...(completedAt !== null ? { completedAt } : {}),
    blocks,
  }
}

// ---------------------------------------------------------------------------
// read slicing and Markdown export
// ---------------------------------------------------------------------------

interface SliceResult<T> {
  readonly items: T[]
  readonly range: { readonly start: number; readonly end: number; readonly reverse: boolean }
  readonly hasMoreBefore: boolean
  readonly hasMoreAfter: boolean
}

function emptySlice<T>(): SliceResult<T> {
  return { items: [], range: { start: 0, end: 0, reverse: false }, hasMoreBefore: false, hasMoreAfter: false }
}

/**
 * Positive offset/limit read forward from a 1-based anchor; negative values
 * read backward from the end. The returned `range` is always an ascending
 * 1-based window even when `reverse` puts the newest message first.
 */
function sliceMessages<T>(messages: readonly T[], offsetInput: number | undefined, limitInput: number | undefined): SliceResult<T> {
  const offset = offsetInput ?? -20
  const limit = limitInput ?? 20
  if (!Number.isSafeInteger(offset)) throw new Error("[o3p.session] offset must be a safe integer")
  if (!Number.isSafeInteger(limit)) throw new Error("[o3p.session] limit must be a safe integer")
  const count = messages.length
  if (count === 0 || limit === 0) return emptySlice()

  let startIndex: number
  if (offset >= 1) startIndex = offset - 1
  else if (offset <= -1) startIndex = Math.max(0, count + offset)
  else startIndex = 0

  if (limit > 0) {
    if (startIndex < 0 || startIndex >= count) return emptySlice()
    const endExclusive = Math.min(count, startIndex + limit)
    const items = messages.slice(startIndex, endExclusive)
    return {
      items,
      range: { start: startIndex + 1, end: startIndex + items.length, reverse: false },
      hasMoreBefore: startIndex > 0,
      hasMoreAfter: startIndex + items.length < count,
    }
  }

  if (startIndex < 0) return emptySlice()
  const endIndex = Math.min(count - 1, startIndex)
  if (endIndex < 0) return emptySlice()
  const lowIndex = Math.max(0, endIndex - Math.abs(limit) + 1)
  const items = messages.slice(lowIndex, endIndex + 1).reverse()
  return {
    items,
    range: { start: lowIndex + 1, end: endIndex + 1, reverse: true },
    hasMoreBefore: lowIndex > 0,
    hasMoreAfter: endIndex < count - 1,
  }
}

function blockLabel(block: ReadContentBlock): string {
  switch (block.kind) {
    case "reasoning":
      return "Reasoning"
    case "tool": {
      const name = block.toolName ?? "unknown"
      const status = block.status !== undefined ? ` (${block.status})` : ""
      return `Tool \`${name}\`${status}`
    }
    case "shell": {
      const status = block.status !== undefined ? ` (${block.status})` : ""
      return `Shell${status}`
    }
    case "injected":
      return "Injected"
    case "system":
      return "System"
    case "compaction":
      return "Compaction"
    case "text":
      return "Text"
  }
}

function renderMarkdown(dbFile: string, session: DecodedSession, messages: readonly ReadMessageItem[]): string {
  const title = session.title.length > 0 ? session.title : session.sessionID
  const lines: string[] = [
    `# ${title}`,
    "",
    `- Session: \`${session.sessionID}\``,
    `- Database: \`${dbFile}\``,
    `- Messages: ${messages.length}`,
    "",
  ]
  for (const message of messages) {
    lines.push(`## ${message.index}. ${message.type}`, "")
    const details: string[] = []
    if (message.agent !== undefined) details.push(`agent=\`${message.agent}\``)
    if (message.model !== undefined) details.push(`model=\`${message.model.providerID}/${message.model.id}\``)
    if (details.length > 0) lines.push(`_${details.join(" · ")}_`, "")
    for (const block of message.blocks) {
      if (block.kind === "text") {
        lines.push(block.text, "")
        continue
      }
      lines.push(`**${blockLabel(block)}**`, "")
      if (block.text.length > 0) lines.push(block.text, "")
    }
  }
  return `${lines.join("\n").replace(/\n+$/, "")}\n`
}

function writeExclusive(file: string, content: string): void {
  const descriptor = openSync(file, "wx")
  try {
    writeFileSync(descriptor, content, "utf8")
  } finally {
    closeSync(descriptor)
  }
}

interface ReadResult {
  readonly output: SessionReadOutput
  readonly markdown: string | null
}

function readSession(db: ConnectionLike, dbFile: string, query: SessionReadQuery): ReadResult {
  assertReadableSchema(db)
  if (query.sessionID.length === 0) throw new Error("[o3p.session] sessionID must be non-empty")
  const sessionRow = db.prepare(`SELECT ${SESSION_SELECT} FROM session_v2 WHERE id = ?`).get(query.sessionID)
  if (!isRecord(sessionRow)) throw new Error(`[o3p.session] Session not found: ${query.sessionID}`)
  const session = decodeSession(sessionRow)

  const messages = loadMessageRows(db, query.sessionID)
  const parts = hydrateParts(db, messages)
  const filtered: ReadMessageItem[] = []
  for (const message of messages) {
    const messageParts = parts.get(message.id)
    const data =
      messageParts !== undefined && messageParts.length > 0 ? { ...message.data, content: messageParts } : message.data
    const projected = projectMessage({ ...message, data }, query)
    if (projected !== null) filtered.push({ ...projected, index: filtered.length + 1 })
  }

  const sliced = sliceMessages(filtered, query.offset, query.limit)
  const markdown = query.outFile !== undefined ? renderMarkdown(dbFile, session, filtered) : null
  return {
    output: {
      db: dbFile,
      sessionID: query.sessionID,
      title: session.title,
      totalMessages: filtered.length,
      range: sliced.range,
      hasMoreBefore: sliced.hasMoreBefore,
      hasMoreAfter: sliced.hasMoreAfter,
      messages: sliced.items,
    },
    markdown,
  }
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

interface SearchHitInternal extends SessionSearchHit {
  readonly blockIndex: number
}

function matchIndex(text: string, needle: string, needleLower: string, caseSensitive: boolean): number {
  if (caseSensitive) return text.indexOf(needle)
  return text.toLowerCase().indexOf(needleLower)
}

const SNIPPET_LIMIT = 200

function snippetAround(text: string, index: number, queryLength: number): string {
  if (text.length <= SNIPPET_LIMIT) return text
  // Keep the whole snippet inside SNIPPET_LIMIT characters including the
  // ellipsis markers, and never clip the first character of the match itself.
  const markerBefore = index > 0
  const markerAfter = index + queryLength < text.length
  const budget = SNIPPET_LIMIT - (markerBefore ? 1 : 0) - (markerAfter ? 1 : 0)
  const visibleQuery = Math.min(queryLength, budget)
  const room = Math.max(0, budget - visibleQuery)
  let start = Math.max(0, index - Math.floor(room / 2))
  let end = Math.min(text.length, start + budget)
  if (end - start < budget) start = Math.max(0, end - budget)
  let snippet = text.slice(start, end)
  if (start > 0) snippet = `…${snippet}`
  if (end < text.length) snippet = `${snippet}…`
  return snippet
}

function publicHit(hit: SearchHitInternal): SessionSearchHit {
  return {
    sessionID: hit.sessionID,
    sessionTitle: hit.sessionTitle,
    messageID: hit.messageID,
    messageSeq: hit.messageSeq,
    messageType: hit.messageType,
    blockKind: hit.blockKind,
    ...(hit.partIndex !== undefined ? { partIndex: hit.partIndex } : {}),
    ...(hit.callID !== undefined ? { callID: hit.callID } : {}),
    createdAt: hit.createdAt,
    snippet: hit.snippet,
  }
}

function isAfterSearchAnchor(hit: SearchHitInternal, anchor: SearchCursor): boolean {
  if (hit.createdAt !== anchor.time) return hit.createdAt < anchor.time
  if (hit.sessionID !== anchor.sessionID) return hit.sessionID < anchor.sessionID
  if (hit.messageSeq !== anchor.messageSeq) return hit.messageSeq < anchor.messageSeq
  return hit.blockIndex < anchor.blockIndex
}

function searchSessions(db: ConnectionLike, dbFile: string, query: SessionSearchQuery): SessionSearchOutput {
  assertReadableSchema(db)
  if (query.query.length === 0) throw new Error("[o3p.session] search query must be non-empty")
  const limit = normalizeLimit(query.limit, 50, 500)
  const needle = query.query
  const needleLower = needle.toLowerCase()
  const caseSensitive = query.caseSensitive === true

  const where: string[] = []
  const params: SqlValue[] = []
  if (query.includeArchived !== true) where.push("time_archived IS NULL")
  if (query.sessionID !== undefined) {
    where.push("id = ?")
    params.push(query.sessionID)
  }
  if (query.project !== undefined && query.project !== "*") {
    const normalized = normalizeProject(query.project)
    where.push("(project_id = ? OR REPLACE(directory, '\\', '/') = ?)")
    params.push(query.project, normalized)
  }

  const sessionSQL =
    `SELECT ${SESSION_SELECT} FROM session_v2` +
    (where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY time_updated DESC, id DESC"
  const sessions = db
    .prepare(sessionSQL)
    .all(...params)
    .map((row) => decodeSession(recordOf(row)))

  const hits: SearchHitInternal[] = []
  for (const session of sessions) {
    const messages = loadMessageRows(db, session.sessionID)
    const parts = hydrateParts(db, messages)
    for (const message of messages) {
      const messageParts = parts.get(message.id)
      const data =
        messageParts !== undefined && messageParts.length > 0 ? { ...message.data, content: messageParts } : message.data
      const projected = projectMessage({ ...message, data }, query)
      if (projected === null) continue
      for (let blockIndex = 0; blockIndex < projected.blocks.length; blockIndex++) {
        const block = projected.blocks[blockIndex]
        const found = matchIndex(block.text, needle, needleLower, caseSensitive)
        if (found < 0) continue
        hits.push({
          sessionID: session.sessionID,
          sessionTitle: session.title,
          messageID: message.id,
          messageSeq: message.seq,
          messageType: message.type,
          blockKind: block.kind,
          ...(block.partIndex !== undefined ? { partIndex: block.partIndex } : {}),
          ...(block.callID !== undefined ? { callID: block.callID } : {}),
          createdAt: projected.createdAt,
          snippet: snippetAround(block.text, found, needle.length),
          blockIndex,
        })
      }
    }
  }

  hits.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
    if (left.sessionID !== right.sessionID) return left.sessionID < right.sessionID ? 1 : -1
    if (left.messageSeq !== right.messageSeq) return right.messageSeq - left.messageSeq
    return right.blockIndex - left.blockIndex
  })

  let start = 0
  if (query.cursor !== undefined) {
    const anchor = decodeSearchCursor(query.cursor)
    const found = hits.findIndex((hit) => isAfterSearchAnchor(hit, anchor))
    start = found === -1 ? hits.length : found
  }

  const page = hits.slice(start, start + limit)
  const last = page.length > 0 ? page[page.length - 1] : undefined
  const hasMore = start + page.length < hits.length
  return {
    db: dbFile,
    query: needle,
    hits: page.map(publicHit),
    nextCursor:
      hasMore && last !== undefined
        ? encodeSearchCursor({
            time: last.createdAt,
            sessionID: last.sessionID,
            messageSeq: last.messageSeq,
            blockIndex: last.blockIndex,
          })
        : null,
  }
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface SqliteReaderOptions {
  readonly dbPath?: string
}

export function createSqliteReader(options?: SqliteReaderOptions): SqliteSessionReader {
  const dbFile = resolveDatabasePath(options?.dbPath)
  return {
    list(query: SessionListQuery = {}): SessionListOutput {
      return withDatabase(dbFile, (db) => listSessions(db, dbFile, query))
    },
    info(sessionID: string): SessionInfoOutput {
      return withDatabase(dbFile, (db) => sessionInfo(db, dbFile, sessionID))
    },
    read(query: SessionReadQuery): SessionReadOutput {
      const result = withDatabase(dbFile, (db) => readSession(db, dbFile, query))
      if (query.outFile === undefined) return result.output
      if (query.outFile.length === 0) throw new Error("[o3p.session] outFile must be a non-empty path")
      const markdown = result.markdown
      if (markdown === null) throw new Error("[o3p.session] Internal error: transcript was not rendered")
      writeExclusive(query.outFile, markdown)
      return { ...result.output, exportedFile: path.resolve(query.outFile) }
    },
    search(query: SessionSearchQuery): SessionSearchOutput {
      return withDatabase(dbFile, (db) => searchSessions(db, dbFile, query))
    },
  }
}
