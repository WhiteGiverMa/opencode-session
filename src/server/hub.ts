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
  type ModelRefInfo,
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

export interface StagedSessionSpec {
  readonly sessionID: string
  readonly parentID: string | null
  readonly agent: string | null
  readonly model: ModelRefInfo | null
  readonly title: string | null
  readonly readonly: boolean
  readonly createdAt: number
}

export interface StageSessionInput {
  readonly parentID: string | null
  readonly agent?: string | null
  readonly model?: ModelRefInfo | null
  readonly title?: string | null
  readonly readonly?: boolean
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
  stageSession(input: StageSessionInput): StagedSessionSpec
  getStagedSession(sessionID: string): StagedSessionSpec | undefined
  materializeStagedSession(sessionID: string, fallbackTitle?: string): Promise<SessionInfo | null>
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

/**
 * A hub listing is read on the same keystroke by the footer badge and the
 * aside panel, and again after every hide/unhide write. Keep one short-lived
 * snapshot per root so the second reader reuses the first reader's work.
 */
const HUB_CACHE_TTL_MS = 1500

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

const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
let lastMintTimestamp = 0
let mintCounter = 0

/** Mints a canonical descending `ses_...` ID matching `@opencode/schema/identifier`. */
export function mintSessionID(timestamp = Date.now()): string {
  if (timestamp !== lastMintTimestamp) {
    lastMintTimestamp = timestamp
    mintCounter = 0
  }
  mintCounter += 1
  const current = BigInt(timestamp) * 0x1000n + BigInt(mintCounter)
  const inverted = ~current
  const timeHex = Array.from({ length: 6 }, (_, index) =>
    Number((inverted >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const randomBytes = crypto.getRandomValues(new Uint8Array(14))
  return `ses_${timeHex}${Array.from(randomBytes, (b) => ID_CHARS[b % 62]).join("")}`
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
  const stagedSessions = new Map<string, StagedSessionSpec>()
  const materializingSessions = new Map<string, Promise<SessionInfo>>()
  const watchesByTarget = new Map<string, Map<string, WatchRecord>>()
  const hubCache = new Map<string, { readonly at: number; readonly items: readonly HubItem[] }>()
  const hubInflight = new Map<string, Promise<HubItem[]>>()
  let hydrated = false

  const invalidateHubCache = (rootSessionID?: string): void => {
    if (rootSessionID === undefined) hubCache.clear()
    else hubCache.delete(rootSessionID)
  }

  const stageSession = (input: StageSessionInput): StagedSessionSpec => {
    const spec: StagedSessionSpec = {
      sessionID: mintSessionID(),
      parentID: input.parentID,
      agent: input.agent ?? null,
      model: input.model ?? null,
      title: input.title ?? null,
      readonly: input.readonly === true,
      createdAt: Date.now(),
    }
    stagedSessions.set(spec.sessionID, spec)
    return spec
  }

  const materializeStagedSession = async (sessionID: string, fallbackTitle?: string): Promise<SessionInfo | null> => {
    const inflight = materializingSessions.get(sessionID)
    if (inflight) return inflight
    const spec = stagedSessions.get(sessionID)
    if (!spec) return null

    const run = (async () => {
      stagedSessions.delete(sessionID)
      try {
        const derivedTitle =
          spec.title ??
          (fallbackTitle ? fallbackTitle.replace(/\s+/g, " ").trim().slice(0, 60) || null : null)
        const created = await host.session.create({
          id: spec.sessionID,
          parentID: spec.parentID,
          agent: spec.agent,
          model: spec.model,
          title: derivedTitle,
        })
        newlyCreatedEmptySessions.add(created.id)
        invalidateHubCache()
        if (spec.readonly) {
          await setReadonly({ sessionID: created.id, readonly: true })
        }
        return created
      } catch (err) {
        stagedSessions.set(sessionID, spec)
        throw err
      } finally {
        materializingSessions.delete(sessionID)
      }
    })()

    materializingSessions.set(sessionID, run)
    return run
  }

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
    invalidateHubCache(input.rootSessionID)

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
    invalidateHubCache(nextMeta.rootSessionID)

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
    invalidateHubCache(nextMeta.rootSessionID)

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

  /**
   * Builds the complete root-scoped session tree with parentID queries only.
   * The previous implementation called `session.list` with no project or
   * parent filter, so every reader scanned every session in every project in
   * the database. Archived asides are fetched by ID because `archived: false`
   * would omit them.
   */
  const buildHubItems = async (rootSessionID: string): Promise<HubItem[]> => {
    const { hub: rootHub } = await loadHubMeta(rootSessionID)

    const collected = new Map<string, { session: SessionInfo; depth: number; meta: O3pSessionMeta | null }>()
    const seen = new Set<string>([rootSessionID])
    const asides: Array<{ id: string; depth: number }> = []

    const asideSessions = await Promise.all(
      rootHub.asideIDs.map((asideID) =>
        seen.has(asideID) ? Promise.resolve(null) : host.session.get({ sessionID: asideID }).catch(() => null),
      ),
    )
    for (const aside of asideSessions) {
      if (!aside || seen.has(aside.id)) continue
      seen.add(aside.id)
      cacheSessionSnapshot(aside)
      collected.set(aside.id, { session: aside, depth: 1, meta: parseSessionMeta(aside.metadata) })
      asides.push({ id: aside.id, depth: 1 })
    }

    let frontier: Array<{ id: string; depth: number }> = [{ id: rootSessionID, depth: 0 }, ...asides]
    while (frontier.length > 0) {
      const batches = await Promise.all(
        frontier.map(async (current) => ({
          current,
          children: await listAllNonArchivedSessions(undefined, current.id),
        })),
      )
      const next: Array<{ id: string; depth: number }> = []
      for (const { current, children } of batches) {
        for (const child of children) {
          if (seen.has(child.id)) continue
          seen.add(child.id)
          const depth = current.depth + 1
          collected.set(child.id, { session: child, depth, meta: parseSessionMeta(child.metadata) })
          next.push({ id: child.id, depth })
        }
      }
      frontier = next
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

  const listHub = async (rootSessionID: string): Promise<HubItem[]> => {
    const cached = hubCache.get(rootSessionID)
    if (cached && Date.now() - cached.at < HUB_CACHE_TTL_MS) {
      return [...cached.items]
    }

    const inflight = hubInflight.get(rootSessionID)
    if (inflight) return inflight

    const run = buildHubItems(rootSessionID)
      .then((items) => {
        hubCache.set(rootSessionID, { at: Date.now(), items })
        return items
      })
      .finally(() => {
        hubInflight.delete(rootSessionID)
      })
    hubInflight.set(rootSessionID, run)
    return run
  }

  const resolveTargetSessionID = async (callerSessionID: string, target: string): Promise<string> => {
    const trimmed = target.trim()
    if (trimmed === "self") return callerSessionID

    const caller = await host.session.get({ sessionID: callerSessionID }).catch(() => null)
    const rootSessionID = caller ? await resolveRootSessionID(caller) : callerSessionID
    if (trimmed === "root") return rootSessionID

    if (stagedSessions.has(trimmed) || materializingSessions.has(trimmed)) {
      return trimmed
    }

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
    if (session?.parentID) {
      // A native subagent can appear without registerAside; never serve a
      // listing that was built before its first prompt.
      invalidateHubCache()
    }
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
          "- Discover nodes with `tools.session.peers({})`; `tools.session.create(...)` stages an ID in memory (materialized only on first `send`), or pass `create: { agent, title }` directly to `send`.",
          "- `tools.session.send({ to, create, message, delivery })`: `wake` triggers/steers a turn immediately (auto-downgrades to `park` past hop limit); `park` queues silently for next turn.",
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
    stageSession,
    getStagedSession: (sessionID: string) => stagedSessions.get(sessionID),
    materializeStagedSession,
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
      stagedSessions.clear()
      materializingSessions.clear()
      watchesByTarget.clear()
      invalidateHubCache()
      hydrated = false
    },
  }
}
