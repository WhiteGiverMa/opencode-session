import type { Location } from "@opencode/plugin"
import type { JsonValue, SessionInfo } from "@opencode/client/promise"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext, SessionIdle, SessionPrompt } from "@opencode/plugin/promise/session"
import { Option, Schema } from "effect"
import {
  type DeliveryMode,
  type HubItem,
  type HubItemKind,
  META_KEY_HUB,
  META_KEY_SESSION,
  type O3pSessionHubMeta,
  O3pSessionHubMetaSchema,
  type O3pSessionMeta,
  O3pSessionMetaSchema,
  type PluginConfig,
  type SqliteSessionReader,
  type WatchEntry,
} from "../contract.ts"

export interface WatchRecord extends WatchEntry {
  readonly watcherID: string
}

export interface SessionHubHost {
  readonly session: Plugin.Context["session"]
  readonly location: Location.Info
  readonly config: PluginConfig
  readonly getReader?: () => Promise<SqliteSessionReader>
  readonly emitUpdated?: (rootSessionID: string, sessionID: string) => Promise<void>
}

export interface RegisterAsideInput {
  readonly sessionID: string
  readonly rootSessionID: string
  readonly kind: "btw" | "sub"
  readonly readonly?: boolean
  readonly label: string
}

export interface AddWatchInput {
  readonly watcherID: string
  readonly targetID: string
  readonly delivery: DeliveryMode
  readonly once: boolean
}

export interface RemoveWatchInput {
  readonly watcherID: string
  readonly targetID: string
}

export interface SessionHub {
  registerAside(input: RegisterAsideInput): Promise<{ meta: O3pSessionMeta }>
  setReadonly(input: { sessionID: string; readonly: boolean }): Promise<{ readonly: boolean }>
  setHidden(input: { sessionID: string; hidden: boolean }): Promise<{ hidden: boolean }>
  listHub(rootSessionID: string): Promise<HubItem[]>
  resolveRootSessionID(session: SessionInfo): Promise<string>
  resolveRootSessionIDByID(sessionID: string): Promise<string>
  resolveTargetSessionID(callerSessionID: string, target: string): Promise<string>
  listAllNonArchivedSessions(projectID?: string, parentID?: string | null): Promise<SessionInfo[]>
  getSessionMeta(sessionID: string): Promise<O3pSessionMeta | null>
  getCachedMeta(sessionID: string): O3pSessionMeta | null | undefined
  getWakeHop(sessionID: string): number
  setWakeHop(sessionID: string, hop: number): void
  markNewlyCreatedEmptySession(sessionID: string): void
  clearNewlyCreatedEmptySession(sessionID: string): void
  isNewlyCreatedEmptySession(sessionID: string): boolean
  addWatch(input: AddWatchInput): Promise<WatchRecord>
  removeWatch(input: RemoveWatchInput): Promise<number>
  hydrateWatches(): Promise<void>
  extractLatestAssistantText(sessionID: string): Promise<string>
  onPrompt(event: SessionPrompt): Promise<void>
  onContext(event: SessionContext): Promise<void>
  onIdle(event: SessionIdle): Promise<void>
  dispose(): void
}

const decodeSessionMeta = Schema.decodeUnknownOption(O3pSessionMetaSchema)
const decodeHubMeta = Schema.decodeUnknownOption(O3pSessionHubMetaSchema)

export function parseSessionMeta(metadata: Record<string, unknown> | undefined): O3pSessionMeta | null {
  if (!metadata || !(META_KEY_SESSION in metadata)) return null
  return Option.getOrNull(decodeSessionMeta(metadata[META_KEY_SESSION]))
}

export function parseHubMeta(metadata: Record<string, unknown> | undefined): O3pSessionHubMeta {
  if (metadata && META_KEY_HUB in metadata) {
    const parsed = Option.getOrNull(decodeHubMeta(metadata[META_KEY_HUB]))
    if (parsed) return parsed
  }
  return {
    version: 1,
    asideIDs: [],
    watches: [],
  }
}

function sessionMetaToJson(meta: O3pSessionMeta): { [x: string]: JsonValue } {
  return {
    version: meta.version,
    rootSessionID: meta.rootSessionID,
    kind: meta.kind,
    readonly: meta.readonly,
    hidden: meta.hidden,
    label: meta.label,
    createdAt: meta.createdAt,
  }
}

function hubMetaToJson(meta: O3pSessionHubMeta): { [x: string]: JsonValue } {
  return {
    version: meta.version,
    asideIDs: [...meta.asideIDs],
    watches: meta.watches.map((entry) => ({
      targetID: entry.targetID,
      delivery: entry.delivery,
      once: entry.once,
      createdAt: entry.createdAt,
    })),
  }
}

function existingMetadataRecord(metadata: Record<string, JsonValue> | undefined): { [x: string]: JsonValue } {
  if (!metadata) return {}
  return { ...metadata }
}

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function sanitizeAliasPrefix(raw: string): string {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
  return cleaned.length > 0 ? cleaned : "subagent"
}

export function isSessionIdle(session: SessionInfo): boolean {
  if (session.time.busy === undefined) return true
  return session.time.idle !== undefined && session.time.idle >= session.time.busy
}

export function isSessionRunning(session: SessionInfo): boolean {
  return !isSessionIdle(session)
}

export function createSessionHub(host: SessionHubHost): SessionHub {
  const sessionMetaCache = new Map<string, O3pSessionMeta | null>()
  const hubMetaCache = new Map<string, O3pSessionHubMeta>()
  const wakeHops = new Map<string, number>()
  const humanTouchedIdleSubagents = new Set<string>()
  const newlyCreatedEmptySessions = new Set<string>()
  const watchesByTarget = new Map<string, Map<string, WatchRecord>>()
  let hydrated = false

  const indexHubWatches = (watcherID: string, hubMeta: O3pSessionHubMeta): void => {
    for (const [targetID, watchers] of watchesByTarget) {
      if (watchers.has(watcherID)) {
        watchers.delete(watcherID)
        if (watchers.size === 0) watchesByTarget.delete(targetID)
      }
    }
    for (const entry of hubMeta.watches) {
      let watchers = watchesByTarget.get(entry.targetID)
      if (!watchers) {
        watchers = new Map()
        watchesByTarget.set(entry.targetID, watchers)
      }
      watchers.set(watcherID, {
        ...entry,
        watcherID,
      })
    }
  }

  const cacheSessionSnapshot = (session: SessionInfo): { meta: O3pSessionMeta | null; hub: O3pSessionHubMeta | null } => {
    const meta = parseSessionMeta(session.metadata)
    sessionMetaCache.set(session.id, meta)
    if (session.metadata && META_KEY_HUB in session.metadata) {
      const hub = parseHubMeta(session.metadata)
      hubMetaCache.set(session.id, hub)
      indexHubWatches(session.id, hub)
      return { meta, hub }
    }
    return { meta, hub: null }
  }

  const listAllNonArchivedSessions = async (projectID?: string, parentID?: string | null): Promise<SessionInfo[]> => {
    const items: SessionInfo[] = []
    let cursor: string | undefined
    while (true) {
      const response = await host.session.list({
        archived: false,
        limit: 100,
        ...(projectID !== undefined ? { project: projectID } : {}),
        ...(parentID !== undefined ? { parentID } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      })
      for (const session of response.data) {
        items.push(session)
        cacheSessionSnapshot(session)
      }
      const next = response.cursor?.next ?? undefined
      if (!next) break
      cursor = next
    }
    return items
  }

  const hydrateWatches = async (): Promise<void> => {
    hydrated = true
    await listAllNonArchivedSessions().catch(() => [])
  }

  const ensureHydrated = async (): Promise<void> => {
    if (!hydrated) {
      await hydrateWatches()
    }
  }

  const getSessionMeta = async (sessionID: string): Promise<O3pSessionMeta | null> => {
    if (sessionMetaCache.has(sessionID)) {
      return sessionMetaCache.get(sessionID) ?? null
    }
    const session = await host.session.get({ sessionID }).catch(() => null)
    if (!session) return null
    return cacheSessionSnapshot(session).meta
  }

  const persistHubMeta = async (watcherID: string, nextHub: O3pSessionHubMeta): Promise<void> => {
    const session = await host.session.get({ sessionID: watcherID }).catch(() => null)
    const existing = existingMetadataRecord(session?.metadata)
    await host.session.update({
      sessionID: watcherID,
      metadata: {
        ...existing,
        [META_KEY_HUB]: hubMetaToJson(nextHub),
      },
    })
    hubMetaCache.set(watcherID, nextHub)
    indexHubWatches(watcherID, nextHub)
  }

  const loadHubMeta = async (sessionID: string): Promise<{ session: SessionInfo | null; hub: O3pSessionHubMeta }> => {
    const session = await host.session.get({ sessionID }).catch(() => null)
    if (session) {
      cacheSessionSnapshot(session)
      return { session, hub: parseHubMeta(session.metadata) }
    }
    return {
      session: null,
      hub: hubMetaCache.get(sessionID) ?? { version: 1, asideIDs: [], watches: [] },
    }
  }

  const registerAside = async (input: RegisterAsideInput): Promise<{ meta: O3pSessionMeta }> => {
    const resolvedReadonly = input.readonly ?? (input.kind === "btw" ? host.config.btwReadonlyByDefault : false)
    const meta: O3pSessionMeta = {
      version: 1,
      rootSessionID: input.rootSessionID,
      kind: input.kind,
      readonly: resolvedReadonly,
      hidden: false,
      label: input.label,
      createdAt: Date.now(),
    }

    const targetSession = await host.session.get({ sessionID: input.sessionID }).catch(() => null)
    const targetExisting = existingMetadataRecord(targetSession?.metadata)
    await host.session.update({
      sessionID: input.sessionID,
      metadata: {
        ...targetExisting,
        [META_KEY_SESSION]: sessionMetaToJson(meta),
      },
      archived: true,
    })
    sessionMetaCache.set(input.sessionID, meta)

    const { session: rootSession, hub: existingHub } = await loadHubMeta(input.rootSessionID)
    const asideIDs = existingHub.asideIDs.includes(input.sessionID)
      ? existingHub.asideIDs
      : [...existingHub.asideIDs, input.sessionID]
    const nextHub: O3pSessionHubMeta = {
      version: 1,
      asideIDs,
      watches: existingHub.watches,
    }
    const rootExisting = existingMetadataRecord(rootSession?.metadata)
    await host.session.update({
      sessionID: input.rootSessionID,
      metadata: {
        ...rootExisting,
        [META_KEY_HUB]: hubMetaToJson(nextHub),
      },
    })
    hubMetaCache.set(input.rootSessionID, nextHub)
    indexHubWatches(input.rootSessionID, nextHub)

    if (host.emitUpdated) {
      await host.emitUpdated(input.rootSessionID, input.sessionID)
    }

    return { meta }
  }

  const setReadonly = async (input: { sessionID: string; readonly: boolean }): Promise<{ readonly: boolean }> => {
    const session = await host.session.get({ sessionID: input.sessionID })
    const current = parseSessionMeta(session.metadata)
    const rootSessionID = current?.rootSessionID ?? (session.parentID ? await resolveRootSessionID(session) : session.id)
    const nextMeta: O3pSessionMeta = current
      ? {
          ...current,
          readonly: input.readonly,
        }
      : {
          version: 1,
          rootSessionID,
          kind: "sub",
          readonly: input.readonly,
          hidden: false,
          label: session.title ?? session.id,
          createdAt: session.time.created,
        }

    const existing = existingMetadataRecord(session.metadata)
    await host.session.update({
      sessionID: input.sessionID,
      metadata: {
        ...existing,
        [META_KEY_SESSION]: sessionMetaToJson(nextMeta),
      },
    })
    sessionMetaCache.set(input.sessionID, nextMeta)

    if (host.emitUpdated) {
      await host.emitUpdated(nextMeta.rootSessionID, input.sessionID)
    }

    return { readonly: nextMeta.readonly }
  }

  const setHidden = async (input: { sessionID: string; hidden: boolean }): Promise<{ hidden: boolean }> => {
    const session = await host.session.get({ sessionID: input.sessionID })
    const current = parseSessionMeta(session.metadata)
    const rootSessionID = current?.rootSessionID ?? (session.parentID ? await resolveRootSessionID(session) : session.id)
    const nextMeta: O3pSessionMeta = current
      ? {
          ...current,
          hidden: input.hidden,
        }
      : {
          version: 1,
          rootSessionID,
          kind: "sub",
          readonly: false,
          hidden: input.hidden,
          label: session.title ?? session.id,
          createdAt: session.time.created,
        }

    const existing = existingMetadataRecord(session.metadata)
    await host.session.update({
      sessionID: input.sessionID,
      metadata: {
        ...existing,
        [META_KEY_SESSION]: sessionMetaToJson(nextMeta),
      },
    })
    sessionMetaCache.set(input.sessionID, nextMeta)

    if (host.emitUpdated) {
      await host.emitUpdated(nextMeta.rootSessionID, input.sessionID)
    }

    return { hidden: nextMeta.hidden }
  }

  const resolveRootSessionID = async (session: SessionInfo): Promise<string> => {
    const meta = parseSessionMeta(session.metadata)
    if (meta) return meta.rootSessionID

    const visited = new Set<string>([session.id])
    let current: SessionInfo = session
    while (current.parentID && !visited.has(current.parentID)) {
      visited.add(current.parentID)
      const parent = await host.session.get({ sessionID: current.parentID }).catch(() => null)
      if (!parent) return current.parentID
      const parentMeta = parseSessionMeta(parent.metadata)
      if (parentMeta) return parentMeta.rootSessionID
      current = parent
    }
    return current.id
  }

  const resolveRootSessionIDByID = async (sessionID: string): Promise<string> => {
    const session = await host.session.get({ sessionID }).catch(() => null)
    if (!session) return sessionID
    return resolveRootSessionID(session)
  }

  const listHub = async (rootSessionID: string): Promise<HubItem[]> => {
    const { hub: rootHub } = await loadHubMeta(rootSessionID)
    const nonArchived = await listAllNonArchivedSessions()

    const sessionsByID = new Map<string, SessionInfo>()
    for (const s of nonArchived) {
      sessionsByID.set(s.id, s)
    }

    const asideSessions = await Promise.all(
      rootHub.asideIDs.map((asideID) =>
        sessionsByID.has(asideID)
          ? Promise.resolve(sessionsByID.get(asideID) ?? null)
          : host.session.get({ sessionID: asideID }).catch(() => null),
      ),
    )

    for (const s of asideSessions) {
      if (s) {
        sessionsByID.set(s.id, s)
        cacheSessionSnapshot(s)
      }
    }

    const childrenByParent = new Map<string, SessionInfo[]>()
    for (const s of sessionsByID.values()) {
      if (!s.parentID) continue
      let list = childrenByParent.get(s.parentID)
      if (!list) {
        list = []
        childrenByParent.set(s.parentID, list)
      }
      list.push(s)
    }

    const collected = new Map<string, { session: SessionInfo; depth: number; meta: O3pSessionMeta | null }>()

    const queue: Array<{ id: string; depth: number }> = []
    const seen = new Set<string>([rootSessionID])

    for (const child of childrenByParent.get(rootSessionID) ?? []) {
      if (!seen.has(child.id)) {
        seen.add(child.id)
        const meta = parseSessionMeta(child.metadata)
        collected.set(child.id, { session: child, depth: 1, meta })
        queue.push({ id: child.id, depth: 1 })
      }
    }

    for (const asideID of rootHub.asideIDs) {
      const aside = sessionsByID.get(asideID)
      if (aside && !seen.has(aside.id)) {
        seen.add(aside.id)
        const meta = parseSessionMeta(aside.metadata)
        collected.set(aside.id, { session: aside, depth: 1, meta })
        queue.push({ id: aside.id, depth: 1 })
      }
    }

    for (const s of sessionsByID.values()) {
      const meta = parseSessionMeta(s.metadata)
      if (meta && meta.rootSessionID === rootSessionID && !seen.has(s.id)) {
        seen.add(s.id)
        collected.set(s.id, { session: s, depth: 1, meta })
        queue.push({ id: s.id, depth: 1 })
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) break
      for (const child of childrenByParent.get(current.id) ?? []) {
        if (!seen.has(child.id)) {
          seen.add(child.id)
          const meta = parseSessionMeta(child.metadata)
          const depth = current.depth + 1
          collected.set(child.id, { session: child, depth, meta })
          queue.push({ id: child.id, depth })
        }
      }
    }

    const sorted = Array.from(collected.values()).sort((a, b) => {
      if (a.session.time.created !== b.session.time.created) {
        return a.session.time.created - b.session.time.created
      }
      return a.session.id.localeCompare(b.session.id)
    })

    const prefixCounts = new Map<string, number>()

    return sorted.map((entry, idx) => {
      const { session: s, depth, meta } = entry
      const kind: HubItemKind = meta ? meta.kind : "subagent"
      const prefix = kind === "btw" ? "btw" : kind === "sub" ? "sub" : sanitizeAliasPrefix(s.agent ?? "subagent")
      const nextNum = (prefixCounts.get(prefix) ?? 0) + 1
      prefixCounts.set(prefix, nextNum)

      return {
        sessionID: s.id,
        rootSessionID,
        parentID: s.parentID ?? null,
        kind,
        depth,
        index: idx + 1,
        alias: `${prefix}-${nextNum}`,
        title: s.title ?? meta?.label ?? s.id,
        label: meta?.label ?? s.title ?? s.id,
        agent: s.agent ?? null,
        model: s.model
          ? {
              providerID: s.model.providerID,
              id: s.model.id,
              ...(s.model.variant !== undefined ? { variant: s.model.variant } : {}),
            }
          : null,
        readonly: meta?.readonly ?? false,
        hidden: meta?.hidden ?? false,
        archived: s.time.archived !== undefined,
        createdAt: s.time.created,
        updatedAt: s.time.updated,
      }
    })
  }

  const resolveTargetSessionID = async (callerSessionID: string, target: string): Promise<string> => {
    const trimmed = target.trim()
    if (trimmed === "self") return callerSessionID

    const caller = await host.session.get({ sessionID: callerSessionID }).catch(() => null)
    const rootSessionID = caller ? await resolveRootSessionID(caller) : callerSessionID
    if (trimmed === "root") return rootSessionID

    const direct = await host.session.get({ sessionID: trimmed }).catch(() => null)
    if (direct) return direct.id

    const hubItems = await listHub(rootSessionID)
    const byAlias = hubItems.find((item) => item.alias === trimmed)
    if (byAlias) return byAlias.sessionID

    if (trimmed.startsWith("peer-") && caller) {
      const topSessions = await listAllNonArchivedSessions(caller.projectID, null)
      const peers = topSessions.filter((s) => s.id !== rootSessionID && !parseSessionMeta(s.metadata))
      peers.sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
      const idx = Number.parseInt(trimmed.slice("peer-".length), 10)
      if (Number.isSafeInteger(idx) && idx >= 1 && idx <= peers.length) {
        const match = peers[idx - 1]
        if (match) return match.id
      }
    }

    throw new Error(`Target session or alias not found: ${target}`)
  }

  const addWatch = async (input: AddWatchInput): Promise<WatchRecord> => {
    await ensureHydrated()
    const { hub } = await loadHubMeta(input.watcherID)
    const entry: WatchEntry = {
      targetID: input.targetID,
      delivery: input.delivery,
      once: input.once,
      createdAt: Date.now(),
    }
    const nextWatches = [...hub.watches.filter((w) => w.targetID !== input.targetID), entry]
    await persistHubMeta(input.watcherID, {
      version: 1,
      asideIDs: hub.asideIDs,
      watches: nextWatches,
    })
    return {
      ...entry,
      watcherID: input.watcherID,
    }
  }

  const removeWatch = async (input: RemoveWatchInput): Promise<number> => {
    await ensureHydrated()
    const { hub } = await loadHubMeta(input.watcherID)
    const nextWatches =
      input.targetID === "*" ? [] : hub.watches.filter((entry) => entry.targetID !== input.targetID)
    const removed = hub.watches.length - nextWatches.length
    if (removed > 0) {
      await persistHubMeta(input.watcherID, {
        version: 1,
        asideIDs: hub.asideIDs,
        watches: nextWatches,
      })
    } else {
      indexHubWatches(input.watcherID, hub)
    }
    return removed
  }

  const extractLatestAssistantText = async (sessionID: string): Promise<string> => {
    if (host.getReader) {
      try {
        const reader = await host.getReader()
        const view = reader.read({ sessionID, offset: -1, limit: -10 })
        for (const msg of view.messages) {
          if (msg.role === "assistant" || msg.type === "assistant") {
            const text = msg.blocks
              .filter((b) => b.kind === "text")
              .map((b) => b.text)
              .join("\n")
              .trim()
            if (text.length > 0) return text
          }
        }
      } catch {
        // Fall through to ctx.session.context fallback
      }
    }

    const messages = await host.session.context({ sessionID }).catch(() => [])
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      if (msg && msg.type === "assistant") {
        const text = msg.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (text.length > 0) return text
      }
    }

    return ""
  }

  const onPrompt = async (event: SessionPrompt): Promise<void> => {
    newlyCreatedEmptySessions.delete(event.sessionID)
    if (event.metadata?.source === "o3p.session.send") {
      return
    }

    wakeHops.set(event.sessionID, 0)

    const session = await host.session.get({ sessionID: event.sessionID }).catch(() => null)
    if (session && session.parentID && isSessionIdle(session)) {
      humanTouchedIdleSubagents.add(event.sessionID)
    }
  }

  const onContext = async (event: SessionContext): Promise<void> => {
    const meta = await getSessionMeta(event.sessionID)
    if (meta?.readonly === true) {
      for (const toolName of host.config.readonlyBlockedTools) {
        delete event.tools[toolName]
      }
      event.system.push({
        type: "text",
        text: [
          "<o3p-aside-readonly>",
          "You are in a forked /btw aside session with workspace read-only lock active. Direct write/edit tools are disabled; `shell` remains available strictly for read-only inspection (e.g. git status/diff/log, rg). Do NOT modify workspace files unless the user unlocks this aside.",
          "</o3p-aside-readonly>",
        ].join("\n"),
      })
    }

    if (host.config.enableSessionTools && "execute" in event.tools) {
      event.system.push({
        type: "text",
        text: [
          "<o3p-session-os>",
          "Code Mode `tools.session.*` manages child, aside, and peer sessions in one JS `execute` call.",
          "- Discover nodes with `tools.session.peers({})`, create children via `tools.session.create(...)`, and fan out with `Promise.all`.",
          "- `tools.session.send({ to, message, delivery })`: `wake` triggers/steers a turn immediately (auto-downgrades to `park` past hop limit); `park` queues silently for next turn.",
          "- Zero implicit context leakage: `send` transmits ONLY your explicit `message` string; recipients pull transcripts on demand via `tools.session.read`.",
          "- Subscribe to completion via `tools.session.watch({ target, once, delivery })` or block synchronously via `tools.session.wait({ sessionID })`.",
          "</o3p-session-os>",
        ].join("\n"),
      })
    }
  }

  const onIdle = async (event: SessionIdle): Promise<void> => {
    if (humanTouchedIdleSubagents.delete(event.sessionID)) {
      return
    }

    await ensureHydrated()
    const watchers = watchesByTarget.get(event.sessionID)
    if (!watchers || watchers.size === 0) return

    const snapshot = Array.from(watchers.values())
    const targetSession = await host.session.get({ sessionID: event.sessionID }).catch(() => null)
    const targetMeta = targetSession ? parseSessionMeta(targetSession.metadata) : await getSessionMeta(event.sessionID)
    const title = targetSession?.title ?? targetMeta?.label ?? event.sessionID
    const agent = targetSession?.agent ?? "assistant"
    const latestText = await extractLatestAssistantText(event.sessionID)
    const body = latestText.length > 0 ? latestText : "(no assistant text output)"

    const noticeText = [
      `<session_watch_notice from="${escapeXmlAttr(event.sessionID)}" title="${escapeXmlAttr(title)}" agent="${escapeXmlAttr(agent)}" state="completed">`,
      body,
      `</session_watch_notice>`,
    ].join("\n")

    for (const watch of snapshot) {
      await host.session.synthetic({
        sessionID: watch.watcherID,
        text: noticeText,
        resume: watch.delivery === "wake",
        description: `Watched session finished · ${title}`,
        metadata: {
          source: "o3p.session.watch",
          childID: event.sessionID,
          agent,
          state: "completed",
        },
      })

      if (watch.once) {
        await removeWatch({
          watcherID: watch.watcherID,
          targetID: event.sessionID,
        }).catch(() => 0)
      }
    }
  }

  return {
    registerAside,
    setReadonly,
    setHidden,
    listHub,
    resolveRootSessionID,
    resolveRootSessionIDByID,
    resolveTargetSessionID,
    listAllNonArchivedSessions,
    getSessionMeta,
    getCachedMeta: (sessionID: string) => sessionMetaCache.get(sessionID),
    getWakeHop: (sessionID: string) => wakeHops.get(sessionID) ?? 0,
    setWakeHop: (sessionID: string, hop: number) => {
      wakeHops.set(sessionID, hop)
    },
    markNewlyCreatedEmptySession: (sessionID: string) => {
      newlyCreatedEmptySessions.add(sessionID)
    },
    clearNewlyCreatedEmptySession: (sessionID: string) => {
      newlyCreatedEmptySessions.delete(sessionID)
    },
    isNewlyCreatedEmptySession: (sessionID: string) => newlyCreatedEmptySessions.has(sessionID),
    addWatch,
    removeWatch,
    hydrateWatches,
    extractLatestAssistantText,
    onPrompt,
    onContext,
    onIdle,
    dispose: () => {
      sessionMetaCache.clear()
      hubMetaCache.clear()
      wakeHops.clear()
      humanTouchedIdleSubagents.clear()
      newlyCreatedEmptySessions.clear()
      watchesByTarget.clear()
      hydrated = false
    },
  }
}
