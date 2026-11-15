import type { Plugin } from "@opencode/plugin"
import type { DeliveryMode, PluginConfig, SqliteSessionReader } from "../contract.ts"
import { escapeXmlAttr, parseSessionMeta, type SessionHub } from "./hub.ts"

export interface SessionMessengerHost {
  readonly session: Plugin.Context["session"]
  readonly hub: SessionHub
  readonly config: PluginConfig
  readonly getReader?: () => Promise<SqliteSessionReader>
}

export interface DeliverSessionMessageInput {
  readonly fromSessionID: string
  readonly toSessionID: string
  readonly message: string
  readonly delivery: DeliveryMode
  readonly relation?: string
}

export interface DeliverSessionMessageResult {
  readonly messageID: string
  readonly fromSessionID: string
  readonly toSessionID: string
  readonly requestedDelivery: DeliveryMode
  readonly effectiveDelivery: DeliveryMode
  readonly hop: number
  readonly maxWakeHops: number
  readonly downgradedToPark: boolean
  readonly reason?: "max_wake_hops_reached"
  readonly method: "prompt" | "synthetic"
}

export interface HandoffInput {
  readonly fromSessionID: string
  readonly toSessionID: string
  readonly delivery: DeliveryMode
  readonly customText?: string
}

export interface HandoffResult {
  readonly messageID: string
  readonly preview: string
  readonly delivery: DeliveryMode
}

export interface SessionMessenger {
  deliverSessionMessage(input: DeliverSessionMessageInput): Promise<DeliverSessionMessageResult>
  handoff(input: HandoffInput): Promise<HandoffResult>
}

export function createSessionMessenger(host: SessionMessengerHost): SessionMessenger {
  const isTargetEmpty = async (sessionID: string): Promise<boolean> => {
    if (host.hub.isNewlyCreatedEmptySession(sessionID)) {
      return true
    }

    if (host.getReader) {
      try {
        const reader = await host.getReader()
        const info = reader.info(sessionID)
        return info.messageCounts.total === 0
      } catch {
        // Fall through to ctx.session.context check if SQLite row isn't present or reader is unavailable
      }
    }

    const contextMessages = await host.session.context({ sessionID }).catch(() => null)
    if (Array.isArray(contextMessages)) {
      return contextMessages.length === 0
    }
    return false
  }

  const inferRelation = async (
    fromSessionID: string,
    toSessionID: string,
    sender: Awaited<ReturnType<Plugin.Context["session"]["get"]>> | null,
    target: Awaited<ReturnType<Plugin.Context["session"]["get"]>> | null,
  ): Promise<string> => {
    if (fromSessionID === toSessionID) return "self"
    if (target?.parentID === fromSessionID) return "child"
    if (sender?.parentID === toSessionID) return "parent"

    const senderMeta = sender ? parseSessionMeta(sender.metadata) : await host.hub.getSessionMeta(fromSessionID)
    const targetMeta = target ? parseSessionMeta(target.metadata) : await host.hub.getSessionMeta(toSessionID)

    if (senderMeta?.rootSessionID === toSessionID || targetMeta?.rootSessionID === fromSessionID) {
      return "aside"
    }
    if (senderMeta && targetMeta && senderMeta.rootSessionID === targetMeta.rootSessionID) {
      return "sibling"
    }
    if (sender?.parentID && target?.parentID && sender.parentID === target.parentID) {
      return "sibling"
    }
    return "peer"
  }

  const deliverSessionMessage = async (
    input: DeliverSessionMessageInput,
  ): Promise<DeliverSessionMessageResult> => {
    const materializedTarget = await host.hub.materializeStagedSession(input.toSessionID, input.message)
    const [sender, target] = await Promise.all([
      host.session.get({ sessionID: input.fromSessionID }).catch(() => null),
      materializedTarget
        ? Promise.resolve(materializedTarget)
        : host.session.get({ sessionID: input.toSessionID }).catch(() => null),
    ])

    const senderMeta = sender ? parseSessionMeta(sender.metadata) : await host.hub.getSessionMeta(input.fromSessionID)
    const senderTitle = sender?.title ?? senderMeta?.label ?? input.fromSessionID
    const senderAgent = sender?.agent ?? "unknown"
    const relation = input.relation ?? (await inferRelation(input.fromSessionID, input.toSessionID, sender, target))

    const senderHop = host.hub.getWakeHop(input.fromSessionID)
    let nextHop = senderHop
    let effectiveDelivery: DeliveryMode = input.delivery
    let downgradedToPark = false
    let reason: "max_wake_hops_reached" | undefined

    if (input.delivery === "wake") {
      nextHop = senderHop + 1
      if (nextHop > host.config.maxWakeHops) {
        effectiveDelivery = "park"
        downgradedToPark = true
        reason = "max_wake_hops_reached"
      } else {
        effectiveDelivery = "wake"
        host.hub.setWakeHop(input.toSessionID, nextHop)
      }
    }

    const envelope = [
      `<session_message from="${escapeXmlAttr(input.fromSessionID)}" title="${escapeXmlAttr(senderTitle)}" agent="${escapeXmlAttr(senderAgent)}" relation="${escapeXmlAttr(relation)}" delivery="${effectiveDelivery}" hop="${nextHop}/${host.config.maxWakeHops}">`,
      input.message,
      `</session_message>`,
      `<session_message_notice>`,
      `Inter-session message from another agent session (not direct human input). Normal assistant replies stay in your own session and are NOT sent back automatically. Call tools.session.send via Code Mode ONLY if a reply or follow-up delivery is genuinely required; never send polite acknowledgements.`,
      `</session_message_notice>`,
    ].join("\n")

    const empty = effectiveDelivery === "wake" ? await isTargetEmpty(input.toSessionID) : false

    if (empty && effectiveDelivery === "wake") {
      host.hub.clearNewlyCreatedEmptySession(input.toSessionID)
      const res = await host.session.prompt({
        sessionID: input.toSessionID,
        text: envelope,
        metadata: {
          source: "o3p.session.send",
          fromSessionID: input.fromSessionID,
          delivery: effectiveDelivery,
          hop: nextHop,
        },
      })
      return {
        messageID: res.id,
        fromSessionID: input.fromSessionID,
        toSessionID: input.toSessionID,
        requestedDelivery: input.delivery,
        effectiveDelivery,
        hop: nextHop,
        maxWakeHops: host.config.maxWakeHops,
        downgradedToPark,
        ...(reason ? { reason } : {}),
        method: "prompt",
      }
    }

    if (effectiveDelivery === "wake") {
      host.hub.clearNewlyCreatedEmptySession(input.toSessionID)
    }

    const res = await host.session.synthetic({
      sessionID: input.toSessionID,
      text: envelope,
      description: `Message from ${senderTitle}`,
      resume: effectiveDelivery === "wake",
      metadata: {
        source: "o3p.session.send",
        fromSessionID: input.fromSessionID,
        delivery: effectiveDelivery,
        hop: nextHop,
      },
    })

    return {
      messageID: res.id,
      fromSessionID: input.fromSessionID,
      toSessionID: input.toSessionID,
      requestedDelivery: input.delivery,
      effectiveDelivery,
      hop: nextHop,
      maxWakeHops: host.config.maxWakeHops,
      downgradedToPark,
      ...(reason ? { reason } : {}),
      method: "synthetic",
    }
  }

  const handoff = async (input: HandoffInput): Promise<HandoffResult> => {
    const fromSession = await host.session.get({ sessionID: input.fromSessionID }).catch(() => null)
    const fromMeta = fromSession
      ? parseSessionMeta(fromSession.metadata)
      : await host.hub.getSessionMeta(input.fromSessionID)
    const fromTitle = fromSession?.title ?? fromMeta?.label ?? input.fromSessionID

    const customBody = input.customText?.trim()
    const body =
      customBody && customBody.length > 0
        ? customBody
        : await host.hub.extractLatestAssistantText(input.fromSessionID)

    if (body.length === 0) {
      throw new Error(`No completed assistant reply found in session ${input.fromSessionID} for handoff`)
    }

    const text = [
      `<session_handoff from="${escapeXmlAttr(input.fromSessionID)}" title="${escapeXmlAttr(fromTitle)}">`,
      body,
      `</session_handoff>`,
    ].join("\n")

    const res = await host.session.synthetic({
      sessionID: input.toSessionID,
      text,
      description: `Handoff from ${fromTitle}`,
      resume: input.delivery === "wake",
      metadata: {
        source: "o3p.session.handoff",
        fromSessionID: input.fromSessionID,
      },
    })

    const collapsed = body.replace(/\s+/g, " ").trim()
    const preview = collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed

    return {
      messageID: res.id,
      preview,
      delivery: input.delivery,
    }
  }

  return {
    deliverSessionMessage,
    handoff,
  }
}
