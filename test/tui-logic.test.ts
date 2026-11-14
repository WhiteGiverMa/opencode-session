import { describe, expect, it } from "bun:test"
import type { HubItem } from "../src/contract.ts"
import {
  clampScrollOffset,
  defaultSubagent,
  formatFooterBadge,
  formatMessageRows,
  hiddenHubItems,
  isAwayFromBottom,
  maximumScrollTop,
  mergeHubItems,
  nextTabID,
  parseBtwArguments,
  parseSubArguments,
  readDraft,
  readO3pSessionMeta,
  resolveSelectedID,
  rootSessionIDFor,
  shouldFollowStreaming,
  visibleHubItems,
  writeDraft,
  type SessionInfo,
  type SessionMessage,
  type SubagentChoice,
} from "../src/tui/state.ts"

const agents: readonly SubagentChoice[] = [
  { id: "build", mode: "primary" },
  { id: "secret", mode: "subagent", hidden: true },
  { id: "explore", mode: "subagent" },
  { id: "general", mode: "all" },
]

function hub(sessionID: string, overrides: Partial<HubItem> = {}): HubItem {
  return {
    sessionID,
    rootSessionID: "root",
    parentID: null,
    kind: "btw",
    depth: 0,
    index: 1,
    alias: "#1",
    title: sessionID,
    label: sessionID,
    agent: "explore",
    model: null,
    readonly: true,
    hidden: false,
    archived: true,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe("slash command argument parsing", () => {
  it("normalizes /btw without inventing a modal prompt", () => {
    expect(parseBtwArguments(undefined)).toBe("")
    expect(parseBtwArguments("  \n ")).toBe("")
    expect(parseBtwArguments("  why did the test fail?  ")).toBe("why did the test fail?")
  })

  it("accepts @agent and bare available agent prefixes", () => {
    expect(parseSubArguments("@general inspect src", agents)).toEqual({
      agentID: "general",
      task: "inspect src",
      explicitAgent: true,
    })
    expect(parseSubArguments("explore inspect src", agents)).toEqual({
      agentID: "explore",
      task: "inspect src",
      explicitAgent: true,
    })
  })

  it("uses an available default without consuming an unmatched task token", () => {
    expect(parseSubArguments("inspect src", agents)).toEqual({
      agentID: "explore",
      task: "inspect src",
      explicitAgent: false,
    })
    expect(parseSubArguments("@missing inspect src", agents).task).toBe("@missing inspect src")
    expect(parseSubArguments("", agents)).toEqual({ agentID: "explore", task: "", explicitAgent: false })
  })

  it("excludes primary and hidden agents from defaults", () => {
    expect(defaultSubagent([{ id: "build", mode: "primary" }, { id: "general", mode: "all" }])).toBe("general")
    expect(defaultSubagent([{ id: "secret", mode: "subagent", hidden: true }])).toBe("explore")
  })
})

describe("stable tabs and non-destructive history", () => {
  const first = hub("a", { index: 1, alias: "#1", createdAt: 10 })
  const second = hub("b", { index: 2, alias: "#2", createdAt: 20, kind: "sub" })
  const third = hub("c", { index: 3, createdAt: 30, kind: "subagent" })

  it("deduplicates live family entries with authoritative remote metadata", () => {
    const stale = hub("b", { label: "stale", createdAt: 20, kind: "subagent" })
    const merged = mergeHubItems([first, second], [stale, third])
    expect(merged.map((item) => item.sessionID)).toEqual(["a", "b", "c"])
    expect(merged[1]?.label).toBe("b")
    expect(merged[1]?.kind).toBe("sub")
  })

  it("sorts by creation order and never by running status", () => {
    const merged = mergeHubItems([third, first], [second])
    expect(merged.map((item) => item.sessionID)).toEqual(["a", "b", "c"])
  })

  it("filters hidden tabs and cycles only through visible tabs", () => {
    const items = [first, { ...second, hidden: true }, third]
    expect(visibleHubItems(items).map((item) => item.sessionID)).toEqual(["a", "c"])
    expect(hiddenHubItems(items).map((item) => item.sessionID)).toEqual(["b"])
    expect(nextTabID(items, "a", 1)).toBe("c")
    expect(nextTabID(items, "c", 1)).toBe("a")
    expect(nextTabID(items, "a", -1)).toBe("c")
    expect(resolveSelectedID(items, "b")).toBe("a")
    expect(resolveSelectedID(items, "c")).toBe("c")
  })
})

describe("draft and smart-scroll state", () => {
  it("keeps drafts independent and removes only the cleared key", () => {
    const drafts = { a: "first", b: "second" }
    const changed = writeDraft(drafts, "a", "changed")
    expect(changed).toEqual({ a: "changed", b: "second" })
    expect(drafts.a).toBe("first")
    expect(readDraft(changed, "a")).toBe("changed")
    expect(writeDraft(changed, "a", "")).toEqual({ b: "second" })
  })

  it("sticks at the bottom but releases as soon as the reader scrolls up", () => {
    const bottom = { scrollTop: 80, viewportHeight: 20, scrollHeight: 100 }
    expect(maximumScrollTop(bottom)).toBe(80)
    expect(isAwayFromBottom(bottom)).toBe(false)
    expect(shouldFollowStreaming(isAwayFromBottom(bottom))).toBe(true)
    expect(isAwayFromBottom({ ...bottom, scrollTop: 79 })).toBe(false)
    expect(isAwayFromBottom({ ...bottom, scrollTop: 70 })).toBe(true)
    expect(shouldFollowStreaming(true)).toBe(false)
  })

  it("handles short transcripts and clamps restored offsets", () => {
    const short = { scrollTop: 0, viewportHeight: 20, scrollHeight: 10 }
    expect(isAwayFromBottom(short)).toBe(false)
    expect(clampScrollOffset({ ...short, scrollTop: 50 })).toBe(0)
    expect(clampScrollOffset({ scrollTop: 500, viewportHeight: 20, scrollHeight: 100 })).toBe(80)
    expect(clampScrollOffset({ scrollTop: -4, viewportHeight: 20, scrollHeight: 100 })).toBe(0)
  })
})

describe("safe metadata resolution", () => {
  it("uses a validated o3p root before the native root fallback", () => {
    const metadata = {
      o3pSession: {
        version: 1,
        rootSessionID: "actual-root",
        kind: "btw",
        readonly: true,
        hidden: false,
        label: "question",
        createdAt: 1,
      },
    }
    const session = { id: "aside", metadata } as Pick<SessionInfo, "id" | "metadata">
    expect(readO3pSessionMeta(metadata)?.rootSessionID).toBe("actual-root")
    expect(rootSessionIDFor(session, "native-root")).toBe("actual-root")
    let fallbackCalls = 0
    expect(rootSessionIDFor(session, () => {
      fallbackCalls += 1
      return "native-root"
    })).toBe("actual-root")
    expect(fallbackCalls).toBe(0)
    expect(rootSessionIDFor({ id: "child", metadata: { o3pSession: { version: 2 } } }, "native-root")).toBe("native-root")
  })
})

describe("transcript formatting", () => {
  it("formats users, reasoning, tools, assistant text, and a reply copy payload", () => {
    const user: SessionMessage = {
      id: "u1",
      type: "user",
      text: "please inspect",
      time: { created: 1 },
    }
    const assistant: SessionMessage = {
      id: "a1",
      type: "assistant",
      agent: "explore",
      model: { providerID: "p", id: "m" },
      time: { created: 2 },
      content: [
        {
          type: "reasoning",
          text: "first line\nfinal thought",
          time: { created: 2, completed: 1202 },
        },
        {
          type: "tool",
          id: "call1",
          name: "read",
          state: {
            status: "completed",
            input: { path: "src/index.ts" },
            content: [{ type: "text", text: "ok" }],
          },
          time: { created: 3, ran: 4, completed: 204 },
        },
        { type: "text", text: "Here is the answer." },
      ],
    }
    const rows = formatMessageRows([user, assistant])
    expect(rows.map((row) => row.kind)).toEqual(["user", "reasoning", "tool", "assistant", "copy"])
    expect(rows[1]).toMatchObject({ preview: "final thought", elapsedMs: 1200 })
    expect(rows[2]).toMatchObject({ text: "✓ read · src/index.ts (0.2s)", status: "completed" })
    expect(rows[4]).toMatchObject({ text: "Here is the answer." })
  })

  it("shows compact tool errors with their expanded error payload available", () => {
    const assistant: SessionMessage = {
      id: "a2",
      type: "assistant",
      agent: "general",
      model: { providerID: "p", id: "m" },
      time: { created: 1 },
      content: [{
        type: "tool",
        id: "call2",
        name: "shell",
        state: {
          status: "error",
          input: { command: "git status" },
          error: { type: "command_failed", message: "exit 1" },
        },
        time: { created: 1 },
      }],
    }
    expect(formatMessageRows([assistant])[0]).toMatchObject({
      kind: "tool",
      text: "✗ shell · git status · exit 1",
      error: "exit 1",
    })
  })
})

describe("footer status", () => {
  it("summarizes aside count and exposes running activity", () => {
    const items = [hub("a"), hub("b", { index: 2 })]
    expect(formatFooterBadge(items, new Set())).toBe("◈ 2 btw")
    expect(formatFooterBadge(items, new Set(["b"]))).toBe("◈ 2 btw ●")
    expect(formatFooterBadge([], new Set())).toBe("")
  })
})
