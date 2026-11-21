import { Plugin } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { parsePluginConfig, PLUGIN_ID, SessionRpc, type SqliteSessionReader } from "./contract.ts"
import { createSessionHub } from "./server/hub.ts"
import { createSessionMessenger, HandoffNoReplyError } from "./server/messenger.ts"
import { createLazySqliteReader, registerSessionTools } from "./server/tools.ts"

export interface SessionServerDeps {
  readonly reader?: SqliteSessionReader
}

export type SessionServerContext = Pick<Plugin.Context, "options" | "location" | "session" | "tool" | "rpc">

export async function createSessionServer(
  ctx: SessionServerContext,
  deps?: SessionServerDeps,
): Promise<Plugin.Cleanup | void> {
  const config = parsePluginConfig(ctx.options)
  if (!config.enabled) return

  const registrations: Registration[] = []
  let rpcRegistration: RpcRegistration<typeof SessionRpc> | undefined
  let active = true

  const getReader = createLazySqliteReader(config, deps?.reader)

  const hub = createSessionHub({
    session: ctx.session,
    location: ctx.location,
    config,
    getReader,
    emitUpdated: async (rootSessionID, sessionID) => {
      if (!active || !rpcRegistration) return
      await rpcRegistration.events.emit("updated", { rootSessionID, sessionID })
    },
  })

  const messenger = createSessionMessenger({
    session: ctx.session,
    hub,
    config,
    getReader,
  })

  try {
    rpcRegistration = await ctx.rpc.register(SessionRpc, {
      registerAside: async (input) => hub.registerAside(input),
      setReadonly: async (input) => hub.setReadonly(input),
      setHidden: async (input) => hub.setHidden(input),
      listHub: async (input) => ({
        items: await hub.listHub(input.rootSessionID),
      }),
      handoff: async (input, callContext) => {
        try {
          return await messenger.handoff(input)
        } catch (error) {
          // Translate "nothing to hand off" into a declared RPC error so the
          // TUI shows the real reason instead of a generic `rpc.internal`.
          if (error instanceof HandoffNoReplyError) {
            return callContext.error("handoffNoReply", error.message, { sessionID: error.sessionID })
          }
          throw error
        }
      },
    })
    registrations.push(rpcRegistration)

    registrations.push(await ctx.session.hook("prompt", (event) => hub.onPrompt(event)))
    registrations.push(await ctx.session.hook("context", (event) => hub.onContext(event)))
    registrations.push(await ctx.session.hook("experimental.idle", (event) => hub.onIdle(event)))

    if (config.enableSessionTools || config.replaceNativeSubagentTool) {
      registrations.push(
        await registerSessionTools({
          tool: ctx.tool,
          session: ctx.session,
          location: ctx.location,
          config,
          hub,
          messenger,
          getReader,
        }),
      )
    }

    await hub.hydrateWatches().catch(() => undefined)
  } catch (error) {
    active = false
    for (const registration of registrations.reverse()) {
      await registration.dispose().catch(() => undefined)
    }
    hub.dispose()
    throw error
  }

  return async () => {
    active = false
    for (const registration of registrations.reverse()) {
      await registration.dispose()
    }
    hub.dispose()
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup: (ctx) => createSessionServer(ctx),
})
