#!/usr/bin/env node
/**
 * qa/e2e.mjs — Isolated end-to-end QA driver for opencode-session (o3p.session)
 * against the official OpenCode v2 binary with a loopback mock provider.
 *
 * Uses isolated HOME/XDG/DB/port in /tmp/opencode; never touches running services or user config.
 */
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import http from "node:http"
import net from "node:net"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as pause } from "node:timers/promises"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const binary = process.env.OPENCODE_V2_BINARY ?? "opencode"

async function waitFor(label, check, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check().catch(() => false)
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`)
    await pause(intervalMs)
  }
}

const captures = []
const plans = new Map()

const mock = http.createServer(async (req, res) => {
  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    const messages = body.messages ?? []
    const textOf = (content) =>
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => part?.text ?? "").join("\n")
          : JSON.stringify(content)
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => textOf(m.content))
      .join("\n")
    const tools = (body.tools ?? []).map((t) => t?.function?.name).filter(Boolean)
    const kind = system.includes("You are a title generator.") ? "title" : "primary"
    const allUserText = messages
      .filter((m) => m.role === "user" || m.role === "tool")
      .map((m) => textOf(m.content))
      .join("\n")
    const caseMatches = [...allUserText.matchAll(/QA_CASE=([a-z0-9_-]+)/g)]
    const caseName = caseMatches.at(-1)?.[1] ?? null

    const capture = { seq: captures.length, kind, caseName, tools, system, messages, stream: Boolean(body.stream) }
    captures.push(capture)

    if (kind === "title") {
      return respond(res, body, { text: "QA Session Title" })
    }
    const queue = caseName ? plans.get(caseName) : undefined
    const step = queue?.shift()
    if (!step) {
      return respond(res, body, { text: `DEFAULT_REPLY_FOR_${caseName ?? "UNKNOWN"}` })
    }
    const resolved = typeof step === "function" ? step(capture) : step
    return respond(res, body, resolved)
  } catch (err) {
    res.writeHead(500, { "content-type": "text/plain" })
    res.end(String(err))
  }
})

function respond(res, body, answer) {
  const calls = answer.calls?.map((call, index) => ({
    index,
    id: `call_${randomUUID().replaceAll("-", "")}`,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
  }))
  const usage = { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: `chatcmpl_${randomUUID()}`,
        object: "chat.completion",
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: answer.text ?? null, ...(calls ? { tool_calls: calls } : {}) },
            finish_reason: calls ? "tool_calls" : "stop",
          },
        ],
        usage,
      }),
    )
    return
  }
  res.writeHead(200, { "content-type": "text/event-stream" })
  const emit = (delta, finish = null) =>
    res.write(
      `data: ${JSON.stringify({
        id: "qa-chunk",
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish ? { usage } : {}),
      })}\n\n`,
    )
  emit({ role: "assistant" })
  emit(calls ? { tool_calls: calls } : { content: answer.text ?? "" })
  emit({}, calls ? "tool_calls" : "stop")
  res.end("data: [DONE]\n\n")
}

async function main() {
  mkdirSync("/tmp/opencode", { recursive: true })
  const sandbox = mkdtempSync("/tmp/opencode/qa-o3p-session-")
  let serverProc
  try {
    const dirs = Object.fromEntries(
      ["home", "config", "data", "state", "cache", "tmp", "project"].map((n) => [n, join(sandbox, n)]),
    )
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })
    execFileSync("git", ["init", "-q"], { cwd: dirs.project })

    mock.listen(0, "127.0.0.1")
    await once(mock, "listening")
    const mockPort = mock.address().port

    const dbPath = join(dirs.data, "qa.db")
    const config = {
      $schema: "https://opencode.ai/config.json",
      model: "mock/qa-model",
      permission: "allow",
      update: "disable",
      snapshots: false,
      plugins: [
        {
          package: repo,
          options: {
            maxWakeHops: 3,
            btwReadonlyByDefault: true,
            enableSessionTools: true,
            dbPath,
          },
        },
      ],
      provider: {
        mock: {
          name: "Mock",
          id: "mock",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "qa-model": {
              id: "qa-model",
              name: "qa-model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2026-01-01",
              limit: { context: 128000, output: 16000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: {
            apiKey: "qa-key",
            baseURL: `http://127.0.0.1:${mockPort}/v1`,
          },
        },
      },
    }
    writeFileSync(join(dirs.config, "opencode.json"), JSON.stringify(config, null, 2))

    const freeSrv = net.createServer().listen(0, "127.0.0.1")
    await once(freeSrv, "listening")
    const port = freeSrv.address().port
    await new Promise((r) => freeSrv.close(r))

    const password = randomUUID()
    const env = {
      PATH: process.env.PATH,
      HOME: dirs.home,
      USERPROFILE: dirs.home,
      OPENCODE_TEST_HOME: dirs.home,
      XDG_CONFIG_HOME: dirs.config,
      XDG_DATA_HOME: dirs.data,
      XDG_STATE_HOME: dirs.state,
      XDG_CACHE_HOME: dirs.cache,
      TMPDIR: dirs.tmp,
      OPENCODE_CONFIG_DIR: dirs.config,
      OPENCODE_DB: dbPath,
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_AUTH_CONTENT: "{}",
      NO_COLOR: "1",
    }

    const version = execFileSync(binary, ["--version"], { env, encoding: "utf8" }).trim()
    console.log(`[qa] host version: ${version}`)

    let hostLogs = ""
    serverProc = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      env,
      cwd: dirs.project,
      stdio: ["ignore", "pipe", "pipe"],
    })
    serverProc.stdout.on("data", (c) => (hostLogs += c.toString()))
    serverProc.stderr.on("data", (c) => (hostLogs += c.toString()))

    const api = async (endpoint, method = "GET", body, allowError = false) => {
      const url = new URL(endpoint, `http://127.0.0.1:${port}`)
      url.searchParams.set("location[directory]", dirs.project)
      const res = await fetch(url, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await res.text()
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {
        json = text
      }
      if (!allowError && !res.ok) {
        throw new Error(`${method} ${endpoint} failed (${res.status}): ${text.slice(0, 300)}\nHost logs:\n${hostLogs.slice(-800)}`)
      }
      return { status: res.status, ok: res.ok, json }
    }

    await waitFor("server up", async () => (await api("/api/plugin", "GET", undefined, true)).ok)
    const plugins = await waitFor("o3p.session active", async () => {
      const list = (await api("/api/plugin")).json.data
      const hit = list.find((p) => p.id === "o3p.session" && p.state?.status === "active")
      return hit ? list : false
    })
    const ourPlugin = plugins.find((p) => p.id === "o3p.session")
    assert.equal(ourPlugin.features.server, true, "server feature should be true")
    assert.equal(ourPlugin.features.tui, true, "tui feature should be true")
    console.log("[pass] 1. plugin activated with server=true & tui=true")

    // Case 2: Main session sees pinned Code Mode tools.session.* inline + <o3p-session-os>
    // AND executes Code Mode script calling create -> send -> watch -> peers -> read!
    const rootSession = (await api("/api/session", "POST", { location: { directory: dirs.project }, title: "Root Main" })).json.data

    plans.set("child_worker", [{ text: "CHILD_DELEGATED_RESULT_42" }])
    plans.set("codemode_e2e", [
      {
        calls: [
          {
            name: "execute",
            args: {
              code: `
                const created = await tools.session.create({ agent: "explore", title: "QA Child" });
                await tools.session.watch({ target: created.sessionID, once: true, delivery: "park" });
                const sent = await tools.session.send({
                  to: created.sessionID,
                  message: "QA_CASE=child_worker Compute 6*7",
                  delivery: "wake"
                });
                await tools.session.wait({ sessionID: created.sessionID });
                const peerInfo = await tools.session.peers({});
                const sliced = await tools.session.read({ sessionID: created.sessionID, offset: -5, limit: 5 });
                const listOut = await tools.session.list({});
                return { createdID: created.sessionID, sentMethod: sent.method, peersCount: peerInfo.peers.length, slicedCount: sliced.totalMessages, listedCount: listOut.items.length };
              `,
            },
          },
        ],
      },
      { text: "MAIN_CODEMODE_COMPLETED" },
    ])

    await api(`/api/session/${rootSession.id}/prompt`, "POST", { text: "QA_CASE=codemode_e2e Run orchestration" })
    await api(`/api/experimental/session/${rootSession.id}/wait`, "POST")

    const mainCap = captures.find((c) => c.caseName === "codemode_e2e")
    assert(mainCap, "captured main session request")
    for (const pinnedName of [
      "tools.session.peers",
      "tools.session.send",
      "tools.session.read",
      "tools.session.create",
      "tools.session.watch",
    ]) {
      assert(mainCap.system.includes(pinnedName), `Code Mode catalog should inline pinned signature ${pinnedName}`)
    }
    assert(mainCap.system.includes("<o3p-session-os>"), "system prompt should include <o3p-session-os> guidance")
    console.log("[pass] 2. pinned tools.session.* signatures & <o3p-session-os> exposed inline in Code Mode")

    const mainSecondCap = captures.filter((c) => c.caseName === "codemode_e2e").at(-1)
    const toolResultMsg = mainSecondCap.messages.find((m) => m.role === "tool")
    const toolText = typeof toolResultMsg?.content === "string" ? toolResultMsg.content : JSON.stringify(toolResultMsg?.content)
    assert(toolText.includes("sentMethod"), `Code Mode result should succeed, got: ${toolText}`)
    assert(toolText.includes('"sentMethod":"prompt"') || toolText.includes('"sentMethod": "prompt"'), "Empty child first message should route via prompt")
    console.log("[pass] 3. Code Mode execute ran create + watch + send + wait + peers + read + list end-to-end")

    // During `codemode_e2e`, rootSession was actively running its turn when child finished,
    // so OpenCode's runner consumed the parked notice right into step 2 ("along-with-turn"!)
    assert(
      JSON.stringify(mainSecondCap.messages).includes("CHILD_DELEGATED_RESULT_42"),
      "along-with-turn parked watch notice was delivered right into the next active step of rootSession",
    )
    console.log("[pass] 4a. watch(delivery='park') delivered notice along-with-turn during active execution")

    // Case 3: Forked /btw aside + RPC registerAside + Readonly Lock + Unlock + Handoff
    const forked = (await api(`/api/session/${rootSession.id}/fork`, "POST", {})).json.data
    const callPluginRpc = async (method, input) => {
      const r1 = await api(`/api/rpc/o3p.session/${method}`, "POST", { input }, true)
      if (r1.ok) return r1
      const r2 = await api(`/api/rpc/o3p.session/${method}`, "POST", input, true)
      assert(r2.ok, `RPC ${method} failed: ${JSON.stringify(r2.json)}`)
      return r2
    }

    await callPluginRpc("registerAside", {
      sessionID: forked.id,
      rootSessionID: rootSession.id,
      kind: "btw",
      label: "Check auth middleware",
    })
    // Mirror TUI's `client.session.update({ archived: true })` (upstream server plugin host.ts ignores `archived`)
    await api(`/api/session/${forked.id}`, "PATCH", { archived: true })
    console.log("[pass] 5a. Plugin RPC registerAside + HTTP archive succeeded")

    // Verify forked session is archived (hidden from top-level archived=false list)
    const activeTopSessions = (await api("/api/session?archived=false&parentID=null")).json.data
    assert(!activeTopSessions.some((s) => s.id === forked.id), "forked /btw aside must be hidden from top-level session list")
    console.log("[pass] 5b. forked /btw aside hidden from top-level /sessions list via archived=true")

    // Prompt the forked aside while readonly=true: verify write/edit stripped, shell/read kept!
    plans.set("btw_readonly", [{ text: "BTW_READONLY_CONCLUSION" }])
    await api(`/api/session/${forked.id}/prompt`, "POST", { text: "QA_CASE=btw_readonly Inspect git status" })
    await api(`/api/experimental/session/${forked.id}/wait`, "POST")

    const btwCap = captures.find((c) => c.caseName === "btw_readonly")
    assert(btwCap, "captured /btw aside model request")
    assert(!btwCap.tools.includes("write"), "write tool must be blocked in readonly /btw aside")
    assert(!btwCap.tools.includes("edit"), "edit tool must be blocked in readonly /btw aside")
    assert(btwCap.tools.includes("shell") || btwCap.tools.includes("bash"), "shell tool must remain available in readonly /btw aside")
    assert(btwCap.tools.includes("read"), "read tool must remain available in readonly /btw aside")
    assert(btwCap.system.includes("<o3p-aside-readonly>"), "readonly system notice must be injected")
    console.log("[pass] 6. /btw aside readonly lock blocks write/edit while keeping shell & read")

    // Case 4: Unlock readonly -> verify write & edit tools return!
    await callPluginRpc("setReadonly", { sessionID: forked.id, readonly: false })
    plans.set("btw_unlocked", [{ text: "BTW_UNLOCKED_DONE" }])
    await api(`/api/session/${forked.id}/prompt`, "POST", { text: "QA_CASE=btw_unlocked Now fix typo" })
    await api(`/api/experimental/session/${forked.id}/wait`, "POST")
    const unlockedCap = captures.find((c) => c.caseName === "btw_unlocked")
    assert(unlockedCap.tools.includes("write") && unlockedCap.tools.includes("edit"), "unlocked aside restores write & edit")
    console.log("[pass] 7. unlocking /btw aside restores write & edit tools immediately")

    // Case 5: While rootSession is IDLE, call handoff(delivery='park') -> sits quietly in inbox with 0 model calls!
    const modelCallsBeforeHandoff = captures.length
    await callPluginRpc("handoff", {
      fromSessionID: forked.id,
      toSessionID: rootSession.id,
      delivery: "park",
    })
    await pause(400)
    assert.equal(captures.length, modelCallsBeforeHandoff, "park handoff on idle root must NOT wake model")
    const idleInbox = (await api(`/api/session/${rootSession.id}/inbox`)).json.data
    assert(
      idleInbox.some((item) => JSON.stringify(item).includes("BTW_UNLOCKED_DONE")),
      "park handoff must sit in idle rootSession's inbox waiting for next user turn",
    )
    console.log("[pass] 8. handoff(delivery='park') queues into idle root inbox with 0 extra model turns")

    console.log("\nALL E2E SERVER & CODEMODE CHECKS PASSED!")
  } finally {
    if (serverProc) {
      serverProc.kill("SIGTERM")
      await once(serverProc, "exit").catch(() => undefined)
    }
    mock.close()
    rmSync(sandbox, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error("[FAIL]", err)
  process.exit(1)
})
