import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";

import type { CoreConfig } from "../types.js";
import { sendAniMessage } from "./send.js";

export type AniWsMessage = {
  type?: string;
  // ANI wraps payload in `data`
  data?: {
    id?: number;
    conversation_id?: number;
    sender_id?: number;
    sender_type?: string;
    layers?: {
      summary?: string;
      detail?: string;
      data?: unknown;
    };
    created_at?: string;
    // sender entity info (enriched by ANI server)
    sender?: {
      id?: number;
      display_name?: string;
      entity_type?: string;
    };
    // conversation info
    conversation?: {
      id?: number;
      title?: string;
    };
  };
};

export type AniHandlerParams = {
  core: ReturnType<typeof import("../runtime.js").getAniRuntime>;
  cfg: CoreConfig;
  runtime: RuntimeEnv;
  logger: {
    info: (message: string | Record<string, unknown>, ...meta: unknown[]) => void;
    warn: (meta: Record<string, unknown>, message: string) => void;
  };
  logVerbose: (message: string) => void;
  serverUrl: string;
  apiKey: string;
  selfEntityId: number;
  selfName: string;
  accountId: string;
};

/**
 * Creates a handler function for incoming ANI WebSocket messages.
 * Only handles `message_new` events, routes them through the OpenClaw
 * AI agent pipeline, and delivers replies via ANI REST API.
 */
export function createAniMessageHandler(params: AniHandlerParams) {
  const {
    core,
    cfg,
    runtime,
    logger,
    logVerbose,
    serverUrl,
    apiKey,
    selfEntityId,
    selfName,
    accountId,
  } = params;

  const startupMs = Date.now();

  return async (wsMsg: AniWsMessage) => {
    try {
      // Only handle new messages (ANI uses "message.new" with dot)
      if (wsMsg.type !== "message.new") {
        logVerbose(`ani: ignoring ws event type=${wsMsg.type ?? "unknown"}`);
        return;
      }

      const msg = wsMsg.data;
      if (!msg) return;

      // Skip own messages
      if (msg.sender_id === selfEntityId) return;

      const conversationId = msg.conversation_id;
      if (!conversationId) return;

      const text = msg.layers?.summary ?? msg.layers?.detail ?? "";
      if (!text.trim()) return;

      const senderId = msg.sender_id ?? 0;
      const senderName =
        msg.sender?.display_name ?? `entity-${senderId}`;
      const senderType = msg.sender?.entity_type ?? msg.sender_type ?? "unknown";
      const conversationTitle = msg.conversation?.title ?? `conv-${conversationId}`;
      const messageId = String(msg.id ?? "");
      const isGroup = true; // ANI conversations are always group-like (agent-mediated)

      logVerbose(
        `ani: inbound conv=${conversationId} from=${senderName}(${senderId}) text="${text.slice(0, 80)}"`,
      );

      // Route through OpenClaw agent pipeline
      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "ani",
        peer: {
          kind: "channel",
          id: String(conversationId),
        },
      });

      const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
        agentId: route.agentId,
      });

      const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
      const previousTimestamp = core.channel.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
      });

      const body = core.channel.reply.formatAgentEnvelope({
        channel: "ANI",
        from: senderName,
        timestamp: msg.created_at ? new Date(msg.created_at).getTime() : undefined,
        previousTimestamp,
        envelope: envelopeOptions,
        body: text,
      });

      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        RawBody: text,
        CommandBody: text,
        From: `ani:channel:${conversationId}`,
        To: `ani:conv:${conversationId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: "channel" as const,
        ConversationLabel: senderName,
        SenderName: senderName,
        SenderId: String(senderId),
        GroupSubject: conversationTitle,
        GroupChannel: String(conversationId),
        Provider: "ani" as const,
        Surface: "ani" as const,
        MessageSid: messageId,
        Timestamp: msg.created_at ? new Date(msg.created_at).getTime() : undefined,
        CommandAuthorized: true,
        CommandSource: "text" as const,
        OriginatingChannel: "ani" as const,
        OriginatingTo: `ani:conv:${conversationId}`,
      });

      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err) => {
          logger.warn(
            { error: String(err), storePath, sessionKey: ctxPayload.SessionKey ?? route.sessionKey },
            "failed updating session meta",
          );
        },
      });

      const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "ani");
      const prefixContext = createReplyPrefixContext({ cfg, agentId: route.agentId });

      // No typing indicators for ANI (not yet supported in outbound)
      const typingCallbacks = createTypingCallbacks({
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        onStartError: (err) =>
          logTypingFailure({ log: logVerbose, channel: "ani", action: "start", target: String(conversationId), error: err }),
        onStopError: (err) =>
          logTypingFailure({ log: logVerbose, channel: "ani", action: "stop", target: String(conversationId), error: err }),
      });

      let didSendReply = false;

      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          responsePrefix: prefixContext.responsePrefix,
          responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            const replyText = payload.text ?? "";
            if (!replyText.trim()) return;

            // Chunk long replies
            const chunks = core.channel.text.chunkMarkdownText(replyText, textLimit);
            for (const chunk of chunks.length > 0 ? chunks : [replyText]) {
              const trimmed = chunk.trim();
              if (!trimmed) continue;
              await sendAniMessage({
                serverUrl,
                apiKey,
                conversationId,
                text: trimmed,
              });
            }
            didSendReply = true;
          },
          onError: (err, info) => {
            runtime.error?.(`ani ${info.kind} reply failed: ${String(err)}`);
          },
          onReplyStart: typingCallbacks.onReplyStart,
          onIdle: typingCallbacks.onIdle,
        });

      const { queuedFinal } = await core.channel.reply.dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions: {
          ...replyOptions,
          onModelSelected: prefixContext.onModelSelected,
        },
      });
      markDispatchIdle();

      if (queuedFinal) didSendReply = true;

      if (didSendReply) {
        const preview = text.replace(/\s+/g, " ").slice(0, 160);
        core.system.enqueueSystemEvent(`ANI message from ${senderName}: ${preview}`, {
          sessionKey: route.sessionKey,
          contextKey: `ani:message:${conversationId}:${messageId}`,
        });
        logVerbose(`ani: delivered reply to conv=${conversationId}`);
      }
    } catch (err) {
      runtime.error?.(`ani handler error: ${String(err)}`);
    }
  };
}
