import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { createSqliteReader, resolveDatabasePath } from "../src/store/sqlite-reader.ts"

// ---------------------------------------------------------------------------
// Fixture infrastructure
// ---------------------------------------------------------------------------

const TMP_ROOT = "/tmp/opencode"
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const SCHEMA = `
CREATE TABLE session_v2 (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  workspace_id text,
  parent_id text,
  fork_session_id text,
  fork_boundary text,
  slug text NOT NULL,
  directory text NOT NULL,
  path text,
  title text,
  version text NOT NULL,
  share_url text,
  summary_additions integer,
  summary_deletions integer,
  summary_files integer,
  summary_diffs text,
  metadata text,
  cost real DEFAULT 0 NOT NULL,
  tokens_input integer DEFAULT 0 NOT NULL,
  tokens_output integer DEFAULT 0 NOT NULL,
  tokens_reasoning integer DEFAULT 0 NOT NULL,
  tokens_cache_read integer DEFAULT 0 NOT NULL,
  tokens_cache_write integer DEFAULT 0 NOT NULL,
  revert text,
  permission text,
  agent text,
  model text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  time_busy integer,
  time_idle integer,
  time_viewed integer,
  idle_outcome text,
  time_compacting integer,
  time_archived integer,
  time_suspended integer,
  resume_attempts integer DEFAULT 0 NOT NULL
);
CREATE TABLE session_message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  type text NOT NULL,
  seq integer NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
CREATE TABLE session_part (
  message_id text NOT NULL,
  session_id text NOT NULL,
  ordinal integer NOT NULL,
  type text NOT NULL,
  call_id text,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL,
  PRIMARY KEY (message_id, ordinal)
);
`

interface Fixture {
  readonly dbPath: string
  readonly dir: string
}

function newTempDirectory(): string {
  mkdirSync(TMP_ROOT, { recursive: true })
  const directory = mkdtempSync(path.join(TMP_ROOT, "sqlite-reader-test-"))
  temporaryDirectories.push(directory)
  return directory
}

function createFixture(seed: (db: Database) => void): Fixture {
  const dir = newTempDirectory()
  const dbPath = path.join(dir, "opencode.db")
  const db = new Database(dbPath)
  db.exec("PRAGMA journal_mode = OFF")
  db.exec("PRAGMA synchronous = OFF")
  db.exec(SCHEMA)
  db.exec("BEGIN")
  try {
    seed(db)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  } finally {
    db.close()
  }
  return { dir, dbPath }
}

interface SessionSeed {
  readonly id: string
  readonly projectID?: string
  readonly directory?: string
  readonly parentID?: string | null
  readonly forkSessionID?: string | null
  readonly title?: string | null
  readonly agent?: string | null
  readonly model?: string | null
  readonly metadata?: string | null
  readonly cost?: number
  readonly tokens?: {
    readonly input?: number
    readonly output?: number
    readonly reasoning?: number
    readonly cacheRead?: number
    readonly cacheWrite?: number
  }
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly archived?: number | null
}

function insertSession(db: Database, seed: SessionSeed): void {
  db.prepare(
    `INSERT INTO session_v2 (
       id, project_id, workspace_id, parent_id, fork_session_id, fork_boundary, slug, directory, path, title, version,
       share_url, summary_additions, summary_deletions, summary_files, summary_diffs, metadata, cost,
       tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, revert, permission,
       agent, model, time_created, time_updated, time_busy, time_idle, time_viewed, idle_outcome, time_compacting,
       time_archived, time_suspended, resume_attempts
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    seed.id,
    seed.projectID ?? "/work/default",
    null,
    seed.parentID ?? null,
    seed.forkSessionID ?? null,
    null,
    seed.id,
    seed.directory ?? seed.projectID ?? "/work/default",
    null,
    seed.title ?? seed.id,
    "2.3.0",
    null,
    null,
    null,
    null,
    null,
    seed.metadata ?? null,
    seed.cost ?? 0,
    seed.tokens?.input ?? 0,
    seed.tokens?.output ?? 0,
    seed.tokens?.reasoning ?? 0,
    seed.tokens?.cacheRead ?? 0,
    seed.tokens?.cacheWrite ?? 0,
    null,
    null,
    seed.agent ?? null,
    seed.model ?? null,
    seed.createdAt ?? 0,
    seed.updatedAt ?? seed.createdAt ?? 0,
    null,
    null,
    null,
    null,
    null,
    seed.archived ?? null,
    null,
    0,
  )
}

interface MessageSeed {
  readonly id: string
  readonly sessionID: string
  readonly type: string
  readonly seq: number
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly data: Record<string, unknown>
}

function insertMessage(db: Database, seed: MessageSeed): void {
  const created = seed.createdAt ?? 1000 + seed.seq
  db.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)",
  ).run(seed.id, seed.sessionID, seed.type, seed.seq, created, seed.updatedAt ?? created, JSON.stringify(seed.data))
}

function insertPart(
  db: Database,
  messageID: string,
  sessionID: string,
  ordinal: number,
  type: string,
  data: Record<string, unknown>,
  callID?: string,
): void {
  db.prepare(
    "INSERT INTO session_part (message_id, session_id, ordinal, type, call_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?,?)",
  ).run(messageID, sessionID, ordinal, type, callID ?? null, 5000 + ordinal, 5000 + ordinal, JSON.stringify(data))
}

function userMessage(id: string, sessionID: string, seq: number, text: string, createdAt?: number): MessageSeed {
  return { id, sessionID, type: "user", seq, createdAt, data: { time: { created: createdAt ?? 1000 + seq }, text } }
}

const ASIDE_META = {
  version: 1,
  rootSessionID: "ses_root",
  kind: "btw",
  readonly: true,
  hidden: false,
  label: "quick question",
  createdAt: 42,
} as const

// ---------------------------------------------------------------------------
// resolveDatabasePath
// ---------------------------------------------------------------------------

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const saved = new Map<string, string | undefined>()
  for (const key of Object.keys(values)) saved.set(key, process.env[key])
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    run()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe("resolveDatabasePath", () => {
  test("an explicit path wins over every environment variable", () => {
    withEnv(
      {
        OPENCODE_SESSION_DB: "/tmp/opencode/env-session.db",
        OPENCODE_DB: "env-native.db",
        XDG_DATA_HOME: "/tmp/opencode/xdg",
      },
      () => {
        expect(resolveDatabasePath("/tmp/opencode/explicit.db")).toBe(path.resolve("/tmp/opencode/explicit.db"))
      },
    )
  })

  test("OPENCODE_SESSION_DB is used before OPENCODE_DB and resolved to an absolute path", () => {
    withEnv(
      {
        OPENCODE_SESSION_DB: "relative/session.db",
        OPENCODE_DB: "env-native.db",
        XDG_DATA_HOME: "/tmp/opencode/xdg",
      },
      () => {
        expect(resolveDatabasePath()).toBe(path.resolve("relative/session.db"))
      },
    )
  })

  test("a relative OPENCODE_DB lives under the OpenCode data directory", () => {
    const xdg = "/tmp/opencode/custom-xdg"
    withEnv({ OPENCODE_SESSION_DB: undefined, OPENCODE_DB: "native.db", XDG_DATA_HOME: xdg }, () => {
      expect(resolveDatabasePath()).toBe(path.join(xdg, "opencode", "native.db"))
    })
  })

  test("an absolute OPENCODE_DB is respected", () => {
    withEnv({ OPENCODE_SESSION_DB: undefined, OPENCODE_DB: "/tmp/opencode/absolute.db", XDG_DATA_HOME: "/tmp/xdg" }, () => {
      expect(resolveDatabasePath()).toBe(path.resolve("/tmp/opencode/absolute.db"))
    })
  })

  test("falls back to XDG_DATA_HOME/opencode/opencode.db", () => {
    const xdg = "/tmp/opencode/default-xdg"
    withEnv({ OPENCODE_SESSION_DB: undefined, OPENCODE_DB: undefined, XDG_DATA_HOME: xdg }, () => {
      expect(resolveDatabasePath()).toBe(path.join(xdg, "opencode", "opencode.db"))
    })
  })

  test("falls back to ~/.local/share when XDG_DATA_HOME is unset or empty", () => {
    withEnv({ OPENCODE_SESSION_DB: undefined, OPENCODE_DB: undefined, XDG_DATA_HOME: undefined }, () => {
      expect(resolveDatabasePath()).toBe(path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"))
    })
    withEnv({ OPENCODE_SESSION_DB: undefined, OPENCODE_DB: undefined, XDG_DATA_HOME: "" }, () => {
      expect(resolveDatabasePath()).toBe(path.join(os.homedir(), ".local", "share", "opencode", "opencode.db"))
    })
  })

  test("empty explicit and env paths fall through to the default", () => {
    const xdg = "/tmp/opencode/empty-xdg"
    withEnv({ OPENCODE_SESSION_DB: "", OPENCODE_DB: "", XDG_DATA_HOME: xdg }, () => {
      expect(resolveDatabasePath("")).toBe(path.join(xdg, "opencode", "opencode.db"))
    })
  })

  test("rejects in-memory databases and SQLite file: URIs", () => {
    withEnv({ OPENCODE_SESSION_DB: undefined, OPENCODE_DB: undefined, XDG_DATA_HOME: "/tmp/opencode/xdg" }, () => {
      expect(() => resolveDatabasePath(":memory:")).toThrow(/must not be ":memory:"/)
      expect(() => resolveDatabasePath("file:/tmp/opencode/live.db?mode=ro")).toThrow(/plain filesystem path/)
    })
    withEnv({ OPENCODE_SESSION_DB: ":memory:" }, () => {
      expect(() => resolveDatabasePath()).toThrow(/must not be ":memory:"/)
    })
    withEnv({ OPENCODE_SESSION_DB: undefined, OPENCODE_DB: "file:opencode.db" }, () => {
      expect(() => resolveDatabasePath()).toThrow(/plain filesystem path/)
    })
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function seedListFixture(db: Database): void {
  insertSession(db, {
    id: "ses_newest",
    projectID: "/work/alpha",
    title: "Newest",
    updatedAt: 1100,
  })
  insertSession(db, {
    id: "ses_root",
    projectID: "/work/alpha",
    title: "Root",
    parentID: null,
    forkSessionID: "ses_fork",
    agent: "meidocho",
    model: JSON.stringify({ id: "model-a", providerID: "prov", variant: "fast" }),
    updatedAt: 1000,
  })
  insertSession(db, {
    id: "ses_archived",
    projectID: "/work/alpha",
    title: "Archived",
    updatedAt: 900,
    archived: 950,
  })
  insertSession(db, {
    id: "ses_aside",
    projectID: "/work/alpha",
    title: "Aside",
    parentID: null,
    metadata: JSON.stringify({ o3pSession: ASIDE_META }),
    updatedAt: 800,
  })
  insertSession(db, {
    id: "ses_child",
    projectID: "/work/alpha",
    title: "Child",
    parentID: "ses_root",
    updatedAt: 700,
  })
  insertSession(db, {
    id: "ses_beta",
    projectID: "C:\\work\\beta",
    directory: "C:\\work\\beta",
    title: "Beta",
    updatedAt: 600,
  })
  insertSession(db, {
    id: "ses_broken_meta",
    projectID: "/work/alpha",
    title: "Broken",
    metadata: "{not valid json",
    updatedAt: 500,
  })
}

describe("list", () => {
  test("returns the database path and excludes archived sessions and asides by default", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.list()
    expect(output.db).toBe(fixture.dbPath)
    expect(output.items.map((item) => item.sessionID)).toEqual([
      "ses_newest",
      "ses_root",
      "ses_child",
      "ses_beta",
      "ses_broken_meta",
    ])
    expect(output.nextCursor).toBeNull()
  })

  test("includeArchived reveals archived sessions but still hides asides", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.list({ includeArchived: true })
    expect(output.items.map((item) => item.sessionID)).toEqual([
      "ses_newest",
      "ses_root",
      "ses_archived",
      "ses_child",
      "ses_beta",
      "ses_broken_meta",
    ])
    expect(output.items.find((item) => item.sessionID === "ses_archived")?.archived).toBe(true)
  })

  test("includeAsides reveals aside sessions and decodes their metadata", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.list({ includeAsides: true })
    expect(output.items.map((item) => item.sessionID)).toContain("ses_aside")
    const aside = output.items.find((item) => item.sessionID === "ses_aside")
    expect(aside).toMatchObject({
      isAside: true,
      asideKind: "btw",
      rootSessionID: "ses_root",
      parentID: null,
      archived: false,
      title: "Aside",
    })
  })

  test("decodes model, agent, fork and malformed metadata safely", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.list()
    const root = output.items.find((item) => item.sessionID === "ses_root")
    expect(root?.agent).toBe("meidocho")
    expect(root?.model).toEqual({ providerID: "prov", id: "model-a", variant: "fast" })
    expect(root?.forkSessionID).toBe("ses_fork")
    const broken = output.items.find((item) => item.sessionID === "ses_broken_meta")
    expect(broken?.isAside).toBe(false)
    expect(broken?.asideKind).toBeNull()
    expect(broken?.rootSessionID).toBeNull()
  })

  test("filters by normalized project directory and supports the wildcard", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    expect(reader.list({ project: "/work/alpha/" }).items.map((item) => item.sessionID)).toEqual([
      "ses_newest",
      "ses_root",
      "ses_child",
      "ses_broken_meta",
    ])
    expect(reader.list({ project: "C:\\work\\beta" }).items.map((item) => item.sessionID)).toEqual(["ses_beta"])
    expect(reader.list({ project: "*" }).items.map((item) => item.sessionID)).toEqual([
      "ses_newest",
      "ses_root",
      "ses_child",
      "ses_beta",
      "ses_broken_meta",
    ])
    expect(() => reader.list({ project: "" })).toThrow(/project must be a non-empty/)
  })

  test("filters by parentID string and null", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    expect(reader.list({ parentID: "ses_root" }).items.map((item) => item.sessionID)).toEqual(["ses_child"])
    expect(reader.list({ parentID: null }).items.map((item) => item.sessionID)).toEqual([
      "ses_newest",
      "ses_root",
      "ses_beta",
      "ses_broken_meta",
    ])
  })

  test("applies from/until to time_updated with an exclusive upper bound", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.list({ from: 700, until: 1000, includeArchived: true, includeAsides: true })
    expect(output.items.map((item) => item.sessionID)).toEqual(["ses_archived", "ses_aside", "ses_child"])
  })

  test("orders ascending and descending", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    expect(reader.list({ order: "asc" }).items.map((item) => item.sessionID)).toEqual([
      "ses_broken_meta",
      "ses_beta",
      "ses_child",
      "ses_root",
      "ses_newest",
    ])
  })

  test("paginates with an opaque keyset cursor without duplicates", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const first = reader.list({ limit: 2 })
    expect(first.items.map((item) => item.sessionID)).toEqual(["ses_newest", "ses_root"])
    expect(first.nextCursor).not.toBeNull()

    const second = reader.list({ limit: 2, cursor: first.nextCursor ?? undefined })
    expect(second.items.map((item) => item.sessionID)).toEqual(["ses_child", "ses_beta"])
    expect(second.nextCursor).not.toBeNull()

    const third = reader.list({ limit: 2, cursor: second.nextCursor ?? undefined })
    expect(third.items.map((item) => item.sessionID)).toEqual(["ses_broken_meta"])
    expect(third.nextCursor).toBeNull()
  })

  test("paginates ascending as well", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const first = reader.list({ order: "asc", limit: 2 })
    const second = reader.list({ order: "asc", limit: 2, cursor: first.nextCursor ?? undefined })
    expect(first.items.map((item) => item.sessionID)).toEqual(["ses_broken_meta", "ses_beta"])
    expect(second.items.map((item) => item.sessionID)).toEqual(["ses_child", "ses_root"])
  })

  test("rejects invalid limits, cursors and cursor/order mismatches", () => {
    const fixture = createFixture(seedListFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    expect(() => reader.list({ limit: 0 })).toThrow(/limit must be an integer/)
    expect(() => reader.list({ limit: 501 })).toThrow(/limit must be an integer/)
    expect(() => reader.list({ limit: 1.5 })).toThrow(/limit must be an integer/)
    expect(() => reader.list({ cursor: "not-base64url-json" })).toThrow(/Invalid list cursor/)
    const cursor = reader.list({ limit: 1 }).nextCursor ?? ""
    expect(() => reader.list({ order: "asc", cursor })).toThrow(/does not match the requested order/)
  })
})

// ---------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------

function seedInfoFixture(db: Database): void {
  insertSession(db, {
    id: "ses_info",
    projectID: "/work/info",
    directory: "/work/info",
    parentID: "ses_parent",
    forkSessionID: "ses_fork",
    title: "Info Session",
    agent: "oracle",
    model: JSON.stringify({ id: "model-b", providerID: "prov-b" }),
    metadata: JSON.stringify({
      o3pSession: {
        version: 1,
        rootSessionID: "ses_root_info",
        kind: "sub",
        readonly: false,
        hidden: true,
        label: "audit",
        createdAt: 1234,
      },
    }),
    cost: 1.25,
    tokens: { input: 11, output: 22, reasoning: 33, cacheRead: 44, cacheWrite: 55 },
    createdAt: 100,
    updatedAt: 200,
    archived: 300,
  })
  const types = [
    "user",
    "user",
    "assistant",
    "synthetic",
    "system",
    "skill",
    "shell",
    "compaction",
    "idle",
    "model-switched",
    "agent-switched",
  ]
  for (let index = 0; index < types.length; index++) {
    insertMessage(db, {
      id: `msg_info_${index}`,
      sessionID: "ses_info",
      type: types[index] ?? "user",
      seq: index + 1,
      data: { time: { created: 500 + index } },
    })
  }
}

describe("info", () => {
  test("returns metadata, tokens, cost, aside state and per-type message counts", () => {
    const fixture = createFixture(seedInfoFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const info = reader.info("ses_info")
    expect(info).toMatchObject({
      db: fixture.dbPath,
      sessionID: "ses_info",
      projectID: "/work/info",
      directory: "/work/info",
      parentID: "ses_parent",
      forkSessionID: "ses_fork",
      title: "Info Session",
      agent: "oracle",
      archived: true,
      isAside: true,
      createdAt: 100,
      updatedAt: 200,
      cost: 1.25,
    })
    expect(info.model).toEqual({ providerID: "prov-b", id: "model-b" })
    expect(info.tokens).toEqual({ input: 11, output: 22, reasoning: 33, cacheRead: 44, cacheWrite: 55 })
    expect(info.asideMeta).toEqual({
      version: 1,
      rootSessionID: "ses_root_info",
      kind: "sub",
      readonly: false,
      hidden: true,
      label: "audit",
      createdAt: 1234,
    })
    expect(info.messageCounts).toEqual({
      total: 11,
      user: 2,
      assistant: 1,
      synthetic: 1,
      system: 1,
      skill: 1,
      shell: 1,
      compaction: 1,
    })
  })

  test("reports a normal session as non-aside", () => {
    const fixture = createFixture((db) => {
      insertSession(db, { id: "ses_plain", title: "Plain", updatedAt: 10 })
    })
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const info = reader.info("ses_plain")
    expect(info.isAside).toBe(false)
    expect(info.asideMeta).toBeNull()
    expect(info.messageCounts.total).toBe(0)
  })

  test("throws for an unknown session", () => {
    const fixture = createFixture(() => {})
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    expect(() => reader.info("ses_missing")).toThrow(/Session not found: ses_missing/)
  })
})

// ---------------------------------------------------------------------------
// read: view flags and part hydration
// ---------------------------------------------------------------------------

function seedReadViewFixture(db: Database): void {
  insertSession(db, { id: "ses_view", title: "View Session", updatedAt: 9000 })

  insertMessage(db, userMessage("msg_1", "ses_view", 1, "hello 1", 1001))
  insertMessage(db, {
    id: "msg_2",
    sessionID: "ses_view",
    type: "assistant",
    seq: 2,
    createdAt: 1002,
    data: {
      time: { created: 1002, completed: 1003 },
      agent: "meidocho",
      model: { id: "model-v", providerID: "prov-v" },
      content: [
        { type: "text", text: "answer 1" },
        { type: "reasoning", text: "think 1" },
        {
          type: "tool",
          id: "call_1",
          name: "bash",
          state: {
            status: "completed",
            input: { cmd: "echo hi" },
            content: [{ type: "text", text: "tool output" }],
          },
        },
      ],
    },
  })
  insertMessage(db, {
    id: "msg_3",
    sessionID: "ses_view",
    type: "synthetic",
    seq: 3,
    createdAt: 1003,
    data: { time: { created: 1003 }, text: "injected note" },
  })
  insertMessage(db, {
    id: "msg_4",
    sessionID: "ses_view",
    type: "skill",
    seq: 4,
    createdAt: 1004,
    data: { time: { created: 1004 }, text: "skill note" },
  })
  insertMessage(db, {
    id: "msg_5",
    sessionID: "ses_view",
    type: "system",
    seq: 5,
    createdAt: 1005,
    data: { time: { created: 1005 }, text: "system note" },
  })
  insertMessage(db, {
    id: "msg_6",
    sessionID: "ses_view",
    type: "shell",
    seq: 6,
    createdAt: 1006,
    data: {
      time: { created: 1006, completed: 1007 },
      shellID: "sh_1",
      command: "echo hi",
      status: "exited",
      exit: 0,
      output: { output: "hi\n", cursor: 3, size: 3, truncated: false },
    },
  })
  insertMessage(db, {
    id: "msg_7",
    sessionID: "ses_view",
    type: "compaction",
    seq: 7,
    createdAt: 1007,
    data: { time: { created: 1007 }, status: "completed", reason: "manual", summary: "compaction summary" },
  })
  insertMessage(db, {
    id: "msg_8",
    sessionID: "ses_view",
    type: "idle",
    seq: 8,
    createdAt: 1008,
    data: { time: { created: 1008 }, outcome: "succeeded" },
  })
  insertMessage(db, {
    id: "msg_9",
    sessionID: "ses_view",
    type: "assistant",
    seq: 9,
    createdAt: 1009,
    data: {
      time: { created: 1009, completed: 1010 },
      agent: "meidocho",
      model: { id: "model-v", providerID: "prov-v" },
      content: [{ type: "text", text: "inline loser" }],
    },
  })
  insertPart(db, "msg_9", "ses_view", 0, "text", { type: "text", text: "part text" })
  insertPart(db, "msg_9", "ses_view", 1, "reasoning", { type: "reasoning", text: "part think" })
  insertMessage(db, {
    id: "msg_10",
    sessionID: "ses_view",
    type: "assistant",
    seq: 10,
    createdAt: 1010,
    data: { time: { created: 1010, completed: 1011 }, content: [{ type: "text", text: "inline kept" }] },
  })
  insertMessage(db, {
    id: "msg_11",
    sessionID: "ses_view",
    type: "user",
    seq: 11,
    createdAt: 1011,
    data: { time: { created: 1011 }, parts: [{ type: "text", text: "legacy user part" }] },
  })
  insertMessage(db, {
    id: "msg_12",
    sessionID: "ses_view",
    type: "assistant",
    seq: 12,
    createdAt: 1012,
    data: { time: { created: 1012 }, content: [{ type: "reasoning", text: "hidden think" }] },
  })
  insertMessage(db, {
    id: "msg_13",
    sessionID: "ses_view",
    type: "assistant",
    seq: 13,
    createdAt: 1013,
    data: {
      time: { created: 1013 },
      content: [
        {
          type: "tool",
          id: "call_2",
          name: "read",
          state: { status: "error", input: { path: "x" }, error: { message: "boom" } },
        },
      ],
    },
  })
}

describe("read view flags", () => {
  test("default view keeps user text and assistant text only, with contiguous 1-based indices", () => {
    const fixture = createFixture(seedReadViewFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_view" })
    expect(output.db).toBe(fixture.dbPath)
    expect(output.sessionID).toBe("ses_view")
    expect(output.title).toBe("View Session")
    expect(output.totalMessages).toBe(5)
    expect(output.messages.map((message) => message.messageID)).toEqual(["msg_1", "msg_2", "msg_9", "msg_10", "msg_11"])
    expect(output.messages.map((message) => message.index)).toEqual([1, 2, 3, 4, 5])
    expect(output.messages.every((message) => message.blocks.every((block) => block.kind === "text"))).toBe(true)
    expect(output.messages[1]?.blocks).toEqual([{ kind: "text", partIndex: 0, text: "answer 1" }])
    expect(output.messages[2]?.blocks).toEqual([{ kind: "text", partIndex: 0, text: "part text" }])
    expect(output.messages[3]?.blocks).toEqual([{ kind: "text", partIndex: 0, text: "inline kept" }])
    expect(output.messages[4]?.blocks).toEqual([{ kind: "text", partIndex: 0, text: "legacy user part" }])
    expect(output.messages[1]).toMatchObject({
      seq: 2,
      type: "assistant",
      role: "assistant",
      agent: "meidocho",
      model: { id: "model-v", providerID: "prov-v" },
      createdAt: 1002,
      completedAt: 1003,
    })
  })

  test("preserves the original part index after filtering earlier blocks", () => {
    const fixture = createFixture((db) => {
      insertSession(db, { id: "ses_part_index", title: "Part Index", updatedAt: 10 })
      insertMessage(db, {
        id: "msg_part_index",
        sessionID: "ses_part_index",
        type: "assistant",
        seq: 1,
        createdAt: 1,
        data: {
          time: { created: 1 },
          content: [
            { type: "reasoning", text: "first think" },
            { type: "text", text: "after think" },
            { type: "thinking", text: "legacy thinking" },
          ],
        },
      })
    })
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const plain = reader.read({ sessionID: "ses_part_index" })
    expect(plain.messages[0]?.blocks).toEqual([{ kind: "text", partIndex: 1, text: "after think" }])
    const withReasoning = reader.read({ sessionID: "ses_part_index", includeReasoning: true })
    expect(withReasoning.messages[0]?.blocks).toEqual([
      { kind: "reasoning", partIndex: 0, text: "first think" },
      { kind: "text", partIndex: 1, text: "after think" },
      { kind: "reasoning", partIndex: 2, text: "legacy thinking" },
    ])
  })

  test("includeReasoning adds reasoning blocks and messages that only contain reasoning", () => {
    const fixture = createFixture(seedReadViewFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_view", includeReasoning: true })
    expect(output.totalMessages).toBe(6)
    expect(output.messages.map((message) => message.messageID)).toEqual([
      "msg_1",
      "msg_2",
      "msg_9",
      "msg_10",
      "msg_11",
      "msg_12",
    ])
    expect(output.messages[1]?.blocks).toEqual([
      { kind: "text", partIndex: 0, text: "answer 1" },
      { kind: "reasoning", partIndex: 1, text: "think 1" },
    ])
    expect(output.messages[2]?.blocks).toEqual([
      { kind: "text", partIndex: 0, text: "part text" },
      { kind: "reasoning", partIndex: 1, text: "part think" },
    ])
    expect(output.messages[5]?.blocks).toEqual([{ kind: "reasoning", partIndex: 0, text: "hidden think" }])
  })

  test("includeTools adds tool blocks for assistant parts and shell messages", () => {
    const fixture = createFixture(seedReadViewFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_view", includeTools: true })
    expect(output.totalMessages).toBe(7)
    expect(output.messages.map((message) => message.messageID)).toEqual([
      "msg_1",
      "msg_2",
      "msg_6",
      "msg_9",
      "msg_10",
      "msg_11",
      "msg_13",
    ])

    const assistant = output.messages.find((message) => message.messageID === "msg_2")
    const tool = assistant?.blocks.find((block) => block.kind === "tool")
    expect(tool).toMatchObject({ kind: "tool", partIndex: 2, callID: "call_1", toolName: "bash", status: "completed" })
    expect(tool?.text).toContain("echo hi")
    expect(tool?.text).toContain("tool output")

    const shell = output.messages.find((message) => message.messageID === "msg_6")
    expect(shell?.blocks[0]).toMatchObject({ kind: "shell", status: "exited" })
    expect(shell?.blocks[0]?.text).toContain("echo hi")
    expect(shell?.blocks[0]?.text).toContain("hi\n")

    const failed = output.messages.find((message) => message.messageID === "msg_13")
    expect(failed?.blocks[0]).toMatchObject({ kind: "tool", callID: "call_2", toolName: "read", status: "error" })
    expect(failed?.blocks[0]?.text).toContain("boom")
  })

  test("includeInjected adds synthetic and skill messages", () => {
    const fixture = createFixture(seedReadViewFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_view", includeInjected: true })
    expect(output.totalMessages).toBe(7)
    expect(output.messages.find((message) => message.messageID === "msg_3")?.blocks).toEqual([
      { kind: "injected", text: "injected note" },
    ])
    expect(output.messages.find((message) => message.messageID === "msg_4")?.blocks).toEqual([
      { kind: "injected", text: "skill note" },
    ])
  })

  test("includeSystem adds system messages", () => {
    const fixture = createFixture(seedReadViewFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_view", includeSystem: true })
    expect(output.totalMessages).toBe(6)
    expect(output.messages.find((message) => message.messageID === "msg_5")?.blocks).toEqual([
      { kind: "system", text: "system note" },
    ])
  })

  test("includeCompaction adds compaction summaries", () => {
    const fixture = createFixture(seedReadViewFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_view", includeCompaction: true })
    expect(output.totalMessages).toBe(6)
    expect(output.messages.find((message) => message.messageID === "msg_7")?.blocks).toEqual([
      { kind: "compaction", status: "completed", text: "compaction summary" },
    ])
  })

  test("all five view flags together keep every renderable message but still drop idle markers", () => {
    const fixture = createFixture(seedReadViewFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({
      sessionID: "ses_view",
      includeReasoning: true,
      includeTools: true,
      includeInjected: true,
      includeSystem: true,
      includeCompaction: true,
    })
    expect(output.totalMessages).toBe(12)
    expect(output.messages.map((message) => message.messageID)).not.toContain("msg_8")
    expect(output.messages.map((message) => message.index)).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))
  })

  test("throws for an unknown session", () => {
    const fixture = createFixture(() => {})
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    expect(() => reader.read({ sessionID: "ses_missing" })).toThrow(/Session not found: ses_missing/)
  })
})

// ---------------------------------------------------------------------------
// read: offset / limit slicing
// ---------------------------------------------------------------------------

function seedSlicingFixture(db: Database): void {
  insertSession(db, { id: "ses_slice", title: "Slice Session", updatedAt: 10_000 })
  for (let seq = 1; seq <= 30; seq++) {
    const label = seq.toString().padStart(2, "0")
    insertMessage(db, userMessage(`msg_${label}`, "ses_slice", seq, `msg ${label}`, 1000 + seq))
  }
}

describe("read offset and limit slicing", () => {
  test("defaults to the newest 20 messages in chronological order", () => {
    const fixture = createFixture(seedSlicingFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_slice" })
    expect(output.totalMessages).toBe(30)
    expect(output.messages.length).toBe(20)
    expect(output.messages[0]?.index).toBe(11)
    expect(output.messages[0]?.blocks[0]?.text).toBe("msg 11")
    expect(output.messages[19]?.index).toBe(30)
    expect(output.messages[19]?.blocks[0]?.text).toBe("msg 30")
    expect(output.range).toEqual({ start: 11, end: 30, reverse: false })
    expect(output.hasMoreBefore).toBe(true)
    expect(output.hasMoreAfter).toBe(false)
  })

  test("a positive offset reads forward from that 1-based index", () => {
    const fixture = createFixture(seedSlicingFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_slice", offset: 1, limit: 5 })
    expect(output.messages.map((message) => message.index)).toEqual([1, 2, 3, 4, 5])
    expect(output.range).toEqual({ start: 1, end: 5, reverse: false })
    expect(output.hasMoreBefore).toBe(false)
    expect(output.hasMoreAfter).toBe(true)

    const last = reader.read({ sessionID: "ses_slice", offset: 30, limit: 5 })
    expect(last.messages.map((message) => message.index)).toEqual([30])
  })

  test("a negative offset counts from the end", () => {
    const fixture = createFixture(seedSlicingFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_slice", offset: -5, limit: 5 })
    expect(output.messages.map((message) => message.index)).toEqual([26, 27, 28, 29, 30])
    expect(output.range).toEqual({ start: 26, end: 30, reverse: false })
    expect(output.hasMoreBefore).toBe(true)
    expect(output.hasMoreAfter).toBe(false)

    const clamped = reader.read({ sessionID: "ses_slice", offset: -100, limit: 5 })
    expect(clamped.messages.map((message) => message.index)).toEqual([1, 2, 3, 4, 5])
  })

  test("a negative limit reads backward from offset and reverses the page", () => {
    const fixture = createFixture(seedSlicingFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_slice", offset: -1, limit: -10 })
    expect(output.messages.map((message) => message.index)).toEqual([30, 29, 28, 27, 26, 25, 24, 23, 22, 21])
    expect(output.range).toEqual({ start: 21, end: 30, reverse: true })
    expect(output.hasMoreBefore).toBe(true)
    expect(output.hasMoreAfter).toBe(false)
  })

  test("negative limit pages centered on a positive offset", () => {
    const fixture = createFixture(seedSlicingFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_slice", offset: 5, limit: -3 })
    expect(output.messages.map((message) => message.index)).toEqual([5, 4, 3])
    expect(output.range).toEqual({ start: 3, end: 5, reverse: true })
    expect(output.hasMoreBefore).toBe(true)
    expect(output.hasMoreAfter).toBe(true)

    const latest = reader.read({ sessionID: "ses_slice", offset: 30, limit: -3 })
    expect(latest.messages.map((message) => message.index)).toEqual([30, 29, 28])
    expect(latest.range).toEqual({ start: 28, end: 30, reverse: true })
    expect(latest.hasMoreAfter).toBe(false)
  })

  test("offset zero behaves like the first message", () => {
    const fixture = createFixture(seedSlicingFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.read({ sessionID: "ses_slice", offset: 0, limit: 3 })
    expect(output.messages.map((message) => message.index)).toEqual([1, 2, 3])
  })

  test("limit zero and out-of-range offsets return a clean empty page", () => {
    const fixture = createFixture(seedSlicingFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const zero = reader.read({ sessionID: "ses_slice", limit: 0 })
    expect(zero.totalMessages).toBe(30)
    expect(zero.messages).toEqual([])
    expect(zero.range).toEqual({ start: 0, end: 0, reverse: false })
    expect(zero.hasMoreBefore).toBe(false)
    expect(zero.hasMoreAfter).toBe(false)

    const beyond = reader.read({ sessionID: "ses_slice", offset: 31, limit: 5 })
    expect(beyond.totalMessages).toBe(30)
    expect(beyond.messages).toEqual([])

    const reversedBeyond = reader.read({ sessionID: "ses_slice", offset: 500, limit: -5 })
    expect(reversedBeyond.messages.map((message) => message.index)).toEqual([30, 29, 28, 27, 26])
  })

  test("rejects fractional offsets and limits", () => {
    const fixture = createFixture(seedSlicingFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    expect(() => reader.read({ sessionID: "ses_slice", offset: 1.5 })).toThrow(/offset must be a safe integer/)
    expect(() => reader.read({ sessionID: "ses_slice", limit: 2.5 })).toThrow(/limit must be a safe integer/)
  })
})

// ---------------------------------------------------------------------------
// read: exclusive Markdown export
// ---------------------------------------------------------------------------

function seedExportFixture(db: Database): void {
  insertSession(db, { id: "ses_export", title: "Export Session", updatedAt: 2000 })
  insertMessage(db, userMessage("msg_e1", "ses_export", 1, "export one", 1001))
  insertMessage(db, userMessage("msg_e2", "ses_export", 2, "export two", 1002))
  insertMessage(db, userMessage("msg_e3", "ses_export", 3, "export three", 1003))
}

describe("read outFile export", () => {
  test("writes the entire filtered transcript, not just the sliced page", () => {
    const fixture = createFixture(seedExportFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const outFile = path.join(fixture.dir, "transcript.md")
    const output = reader.read({ sessionID: "ses_export", offset: 1, limit: 1, outFile })
    expect(output.messages.length).toBe(1)
    expect(output.messages[0]?.blocks[0]?.text).toBe("export one")
    expect(output.exportedFile).toBe(path.resolve(outFile))
    const markdown = readFileSync(outFile, "utf8")
    expect(markdown).toContain("# Export Session")
    expect(markdown).toContain("export one")
    expect(markdown).toContain("export two")
    expect(markdown).toContain("export three")
    expect(markdown).toContain("- Messages: 3")
  })

  test("exports only the blocks selected by the view flags", () => {
    const fixture = createFixture((db) => {
      insertSession(db, { id: "ses_export_tools", title: "Export Tools", updatedAt: 10 })
      insertMessage(db, userMessage("msg_et1", "ses_export_tools", 1, "question", 1))
      insertMessage(db, {
        id: "msg_et2",
        sessionID: "ses_export_tools",
        type: "assistant",
        seq: 2,
        createdAt: 2,
        data: {
          time: { created: 2 },
          content: [
            { type: "text", text: "answer" },
            {
              type: "tool",
              id: "call_export",
              name: "bash",
              state: { status: "completed", input: { cmd: "echo exported" }, content: [] },
            },
          ],
        },
      })
    })
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const plainFile = path.join(fixture.dir, "plain.md")
    reader.read({ sessionID: "ses_export_tools", outFile: plainFile })
    const plain = readFileSync(plainFile, "utf8")
    expect(plain).toContain("answer")
    expect(plain).not.toContain("echo exported")

    const toolsFile = path.join(fixture.dir, "tools.md")
    reader.read({ sessionID: "ses_export_tools", includeTools: true, outFile: toolsFile })
    const tools = readFileSync(toolsFile, "utf8")
    expect(tools).toContain("Tool `bash`")
    expect(tools).toContain("echo exported")
  })

  test("never overwrites an existing file", () => {
    const fixture = createFixture(seedExportFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const outFile = path.join(fixture.dir, "existing.md")
    writeFileSync(outFile, "KEEP")
    expect(() => reader.read({ sessionID: "ses_export", outFile })).toThrow()
    expect(readFileSync(outFile, "utf8")).toBe("KEEP")
  })

  test("never follows an existing symlink", () => {
    const fixture = createFixture(seedExportFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const target = path.join(fixture.dir, "target.md")
    const link = path.join(fixture.dir, "link.md")
    writeFileSync(target, "SAFE")
    symlinkSync(target, link)
    expect(() => reader.read({ sessionID: "ses_export", outFile: link })).toThrow()
    expect(readFileSync(target, "utf8")).toBe("SAFE")
  })

  test("rejects an empty outFile", () => {
    const fixture = createFixture(seedExportFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    expect(() => reader.read({ sessionID: "ses_export", outFile: "" })).toThrow(/outFile must be a non-empty/)
  })
})

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

function seedSearchFixture(db: Database): void {
  insertSession(db, { id: "ses_a", projectID: "/work/a", title: "Alpha Session", updatedAt: 3000 })
  insertSession(db, { id: "ses_b", projectID: "/work/b", title: "Beta Session", updatedAt: 2000 })
  insertSession(db, {
    id: "ses_arch",
    projectID: "/work/a",
    title: "Archived Session",
    updatedAt: 2500,
    archived: 2600,
  })
  insertSession(db, { id: "ses_hits", projectID: "/work/a", title: "Hit Session", updatedAt: 1000 })

  insertMessage(db, userMessage("msg_a1", "ses_a", 1, "Alpha 100% done_now", 100))
  insertMessage(db, {
    id: "msg_a2",
    sessionID: "ses_a",
    type: "assistant",
    seq: 2,
    createdAt: 110,
    data: {
      time: { created: 110 },
      content: [
        { type: "text", text: "alpha appears again" },
        { type: "reasoning", text: "needle reasoning" },
        {
          type: "tool",
          id: "call_needle",
          name: "bash",
          state: {
            status: "completed",
            input: { cmd: "grep needle" },
            content: [{ type: "text", text: "needle result" }],
          },
        },
      ],
    },
  })
  insertMessage(db, {
    id: "msg_a3",
    sessionID: "ses_a",
    type: "synthetic",
    seq: 3,
    createdAt: 120,
    data: { time: { created: 120 }, text: "injected needle" },
  })
  insertMessage(db, {
    id: "msg_a4",
    sessionID: "ses_a",
    type: "system",
    seq: 4,
    createdAt: 130,
    data: { time: { created: 130 }, text: "system needle" },
  })
  insertMessage(db, {
    id: "msg_a5",
    sessionID: "ses_a",
    type: "compaction",
    seq: 5,
    createdAt: 140,
    data: { time: { created: 140 }, status: "completed", reason: "manual", summary: "compaction needle" },
  })
  insertMessage(
    db,
    userMessage(
      "msg_a6",
      "ses_a",
      6,
      `${"prefix ".repeat(80)}needle${" suffix".repeat(80)}`,
      150,
    ),
  )
  insertMessage(db, userMessage("msg_a7", "ses_a", 7, "duplicate hit hit hit", 160))
  insertMessage(db, {
    id: "msg_a8",
    sessionID: "ses_a",
    type: "shell",
    seq: 8,
    createdAt: 170,
    data: {
      time: { created: 170, completed: 171 },
      shellID: "sh_search",
      command: "echo needle",
      status: "exited",
      exit: 0,
      output: { output: "needle shell result\n", cursor: 20, size: 20, truncated: false },
    },
  })
  insertMessage(db, userMessage("msg_b1", "ses_b", 1, "alphabet soup", 200))
  insertMessage(db, userMessage("msg_arch1", "ses_arch", 1, "alpha archived", 250))
  for (let seq = 1; seq <= 5; seq++) {
    insertMessage(db, userMessage(`msg_h${seq}`, "ses_hits", seq, `hit number ${seq}`, 300 + seq))
  }
}

describe("search", () => {
  test("matches literal % and _ instead of SQL LIKE wildcards", () => {
    const fixture = createFixture(seedSearchFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const percent = reader.search({ query: "%" })
    expect(percent.hits.length).toBe(1)
    expect(percent.hits[0]?.snippet).toContain("100%")
    const underscore = reader.search({ query: "_" })
    expect(underscore.hits.length).toBe(1)
    expect(underscore.hits[0]?.snippet).toContain("done_now")
  })

  test("searches case-insensitively by default and case-sensitively on request", () => {
    const fixture = createFixture(seedSearchFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const insensitive = reader.search({ query: "alpha" })
    expect(new Set(insensitive.hits.map((hit) => hit.sessionID))).toEqual(new Set(["ses_a", "ses_b"]))
    expect(insensitive.hits.length).toBe(3)

    const sensitive = reader.search({ query: "alpha", caseSensitive: true })
    expect(sensitive.hits.map((hit) => hit.snippet).sort()).toEqual(["alpha appears again", "alphabet soup"])
  })

  test("applies the view flags when searching blocks", () => {
    const fixture = createFixture(seedSearchFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })

    const base = reader.search({ query: "needle", sessionID: "ses_a" })
    expect(base.hits.length).toBe(1)
    expect(base.hits[0]?.messageID).toBe("msg_a6")

    const reasoning = reader.search({ query: "needle", sessionID: "ses_a", includeReasoning: true })
    expect(reasoning.hits.map((hit) => hit.blockKind).sort()).toEqual(["reasoning", "text"])

    const tools = reader.search({ query: "needle", sessionID: "ses_a", includeTools: true })
    const tool = tools.hits.find((hit) => hit.blockKind === "tool")
    expect(tool).toMatchObject({
      messageID: "msg_a2",
      messageSeq: 2,
      messageType: "assistant",
      blockKind: "tool",
      callID: "call_needle",
      partIndex: 2,
    })
    expect(tool?.snippet).toContain("needle")
    const shell = tools.hits.find((hit) => hit.blockKind === "shell")
    expect(shell).toMatchObject({ messageID: "msg_a8", messageType: "shell", blockKind: "shell" })
    expect(shell?.snippet).toContain("needle")

    const injected = reader.search({ query: "needle", sessionID: "ses_a", includeInjected: true })
    expect(injected.hits.some((hit) => hit.messageID === "msg_a3" && hit.blockKind === "injected")).toBe(true)

    const system = reader.search({ query: "needle", sessionID: "ses_a", includeSystem: true })
    expect(system.hits.some((hit) => hit.messageID === "msg_a4" && hit.blockKind === "system")).toBe(true)

    const compaction = reader.search({ query: "needle", sessionID: "ses_a", includeCompaction: true })
    expect(compaction.hits.some((hit) => hit.messageID === "msg_a5" && hit.blockKind === "compaction")).toBe(true)
  })

  test("filters by session, project and archive state", () => {
    const fixture = createFixture(seedSearchFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    expect(reader.search({ query: "alpha", sessionID: "ses_b" }).hits.length).toBe(1)
    expect(reader.search({ query: "alpha", project: "/work/a" }).hits.length).toBe(2)
    expect(reader.search({ query: "alpha", includeArchived: true }).hits.length).toBe(4)
    expect(reader.search({ query: "alpha", project: "C:\\work\\a" }).hits.length).toBe(0)
  })

  test("returns 200-character bounded snippets around long matches", () => {
    const fixture = createFixture(seedSearchFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const hit = reader.search({ query: "needle", sessionID: "ses_a" }).hits[0]
    expect(hit).toBeDefined()
    expect(hit?.snippet.length).toBeLessThanOrEqual(200)
    expect(hit?.snippet).toContain("needle")
    expect(hit?.snippet.startsWith("…")).toBe(true)
    expect(hit?.snippet.endsWith("…")).toBe(true)
  })

  test("emits one hit per block even when the substring appears repeatedly", () => {
    const fixture = createFixture(seedSearchFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const hits = reader.search({ query: "hit", sessionID: "ses_a" }).hits
    expect(hits.length).toBe(1)
    expect(hits[0]?.messageID).toBe("msg_a7")
  })

  test("paginates with a keyset cursor and no duplicates", () => {
    const fixture = createFixture(seedSearchFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const first = reader.search({ query: "hit", sessionID: "ses_hits", limit: 2 })
    expect(first.hits.map((hit) => hit.messageSeq)).toEqual([5, 4])
    expect(first.hits.every((hit) => hit.sessionID === "ses_hits")).toBe(true)
    expect(first.nextCursor).not.toBeNull()

    const second = reader.search({ query: "hit", sessionID: "ses_hits", limit: 2, cursor: first.nextCursor ?? undefined })
    expect(second.hits.map((hit) => hit.messageSeq)).toEqual([3, 2])
    expect(second.nextCursor).not.toBeNull()

    const third = reader.search({ query: "hit", sessionID: "ses_hits", limit: 2, cursor: second.nextCursor ?? undefined })
    expect(third.hits.map((hit) => hit.messageSeq)).toEqual([1])
    expect(third.nextCursor).toBeNull()
  })

  test("paginates across multiple blocks of the same message", () => {
    const fixture = createFixture((db) => {
      insertSession(db, { id: "ses_blocks", title: "Blocks", updatedAt: 10 })
      insertMessage(db, {
        id: "msg_blocks",
        sessionID: "ses_blocks",
        type: "assistant",
        seq: 1,
        createdAt: 5,
        data: {
          time: { created: 5 },
          content: ["a", "b", "c"].map((name) => ({
            type: "tool",
            id: `call_${name}`,
            name: "bash",
            state: { status: "completed", input: { cmd: `echo needle-${name}` }, content: [] },
          })),
        },
      })
    })
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const first = reader.search({ query: "needle", sessionID: "ses_blocks", includeTools: true, limit: 1 })
    expect(first.hits.map((hit) => hit.callID)).toEqual(["call_c"])
    expect(first.nextCursor).not.toBeNull()
    const second = reader.search({
      query: "needle",
      sessionID: "ses_blocks",
      includeTools: true,
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    })
    expect(second.hits.map((hit) => hit.callID)).toEqual(["call_b"])
    const third = reader.search({
      query: "needle",
      sessionID: "ses_blocks",
      includeTools: true,
      limit: 1,
      cursor: second.nextCursor ?? undefined,
    })
    expect(third.hits.map((hit) => hit.callID)).toEqual(["call_a"])
    expect(third.nextCursor).toBeNull()
  })

  test("returns a null cursor when the page already covers every hit", () => {
    const fixture = createFixture(seedSearchFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.search({ query: "hit", sessionID: "ses_hits", limit: 50 })
    expect(output.hits.length).toBe(5)
    expect(output.nextCursor).toBeNull()
  })

  test("returns the public hit shape and echoes the database and query", () => {
    const fixture = createFixture(seedSearchFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    const output = reader.search({ query: "alpha", sessionID: "ses_b" })
    expect(output.db).toBe(fixture.dbPath)
    expect(output.query).toBe("alpha")
    expect(output.hits[0]).toMatchObject({
      sessionID: "ses_b",
      sessionTitle: "Beta Session",
      messageID: "msg_b1",
      messageSeq: 1,
      messageType: "user",
      blockKind: "text",
      createdAt: 200,
    })
    expect(output.hits[0]?.snippet).toBe("alphabet soup")
  })

  test("rejects an empty query and invalid cursors", () => {
    const fixture = createFixture(seedSearchFixture)
    const reader = createSqliteReader({ dbPath: fixture.dbPath })
    expect(() => reader.search({ query: "" })).toThrow(/search query must be non-empty/)
    expect(() => reader.search({ query: "alpha", cursor: "!!!not-a-cursor!!!" })).toThrow(/Invalid search cursor/)
    expect(() => reader.search({ query: "alpha", limit: 0 })).toThrow(/limit must be an integer/)
  })
})

// ---------------------------------------------------------------------------
// Reader-level failure behaviour
// ---------------------------------------------------------------------------

describe("reader lifecycle and schema validation", () => {
  test("throws a clear error when the database file is missing", () => {
    const dir = newTempDirectory()
    const reader = createSqliteReader({ dbPath: path.join(dir, "missing.db") })
    expect(() => reader.list()).toThrow(/SQLite database not found/)
  })

  test("throws a clear error for an unsupported SQLite layout", () => {
    const dir = newTempDirectory()
    const dbPath = path.join(dir, "empty.db")
    const db = new Database(dbPath)
    db.exec("PRAGMA journal_mode = OFF")
    db.exec("PRAGMA synchronous = OFF")
    db.exec("CREATE TABLE unrelated (id text primary key)")
    db.close()
    const reader = createSqliteReader({ dbPath })
    expect(() => reader.list()).toThrow(/Unsupported SQLite layout/)
    expect(() => reader.info("ses_x")).toThrow(/Unsupported SQLite layout/)
  })

  test("works without a session_part table (pre-2.2.7 layout)", () => {
    const dir = newTempDirectory()
    const dbPath = path.join(dir, "legacy-parts.db")
    const db = new Database(dbPath)
    db.exec("PRAGMA journal_mode = OFF")
    db.exec("PRAGMA synchronous = OFF")
    db.exec(`
      CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, directory text NOT NULL, parent_id text,
        fork_session_id text, title text, agent text, model text, metadata text, cost real, tokens_input integer,
        tokens_output integer, tokens_reasoning integer, tokens_cache_read integer, tokens_cache_write integer,
        time_created integer, time_updated integer, time_archived integer);
      CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
        time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    `)
    db.prepare(
      "INSERT INTO session_v2 (id, project_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)",
    ).run("ses_legacy", "/work/legacy", "/work/legacy", "Legacy", 1, 2)
    db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?,?,?,?,?,?,?)",
    ).run(
      "msg_legacy",
      "ses_legacy",
      "assistant",
      1,
      1,
      2,
      JSON.stringify({ time: { created: 1 }, content: [{ type: "text", text: "inline legacy" }] }),
    )
    db.close()

    const reader = createSqliteReader({ dbPath })
    const output = reader.read({ sessionID: "ses_legacy" })
    expect(output.messages[0]?.blocks).toEqual([{ kind: "text", partIndex: 0, text: "inline legacy" }])
  })
})
