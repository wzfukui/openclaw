import {
  createReplyPrefixContext,
  createTypingCallbacks,
  logTypingFailure,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";

import type { CoreConfig } from "../types.js";
import {
  sendAniMessage,
  fetchConversation,
  fetchConversationMemories,
  type AniArtifact,
  type AniConversation,
  type AniMemory,
} from "./send.js";

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
    attachments?: Array<{
      type?: string;
      url?: string;
      filename?: string;
      mime_type?: string;
      size?: number;
      duration?: number;
      content?: string;
    }>;
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

// ---------------------------------------------------------------------------
// Artifact support: system prompt injection + outbound parsing
// ---------------------------------------------------------------------------

const ANI_ARTIFACT_SYSTEM_PROMPT = `
## Artifact Output

When you need to produce rich visual or structured content (SVG graphics, HTML pages, diagrams, or substantial code blocks), wrap the output in an <artifact> tag so it can be rendered interactively in the chat UI.

Format:
<artifact type="TYPE" title="TITLE" language="LANG">
CONTENT
</artifact>

Supported types:
- html  — HTML/SVG content (including inline CSS/JS). Use this for charts, diagrams drawn as SVG, interactive widgets.
- code  — Source code. Set language="python" (or js, go, sql, etc.) for syntax highlighting.
- mermaid — Mermaid diagram markup (flowchart, sequence, gantt, etc.).

Rules:
- Only use <artifact> for content that benefits from rendering (SVG, HTML, mermaid, long code). Short inline code snippets should stay as normal markdown.
- Always provide a descriptive title.
- For SVG, output the full <svg> element inside type="html". Use viewBox (not fixed width/height) so it scales responsively. Ensure all text labels and data values are fully visible with no overlap — add enough vertical spacing between rows (min 40px per row for bar charts).
- You may include a brief text explanation before or after the artifact tag.
- Do NOT nest artifact tags.
`.trim();

/**
 * Parse <artifact> tags from model reply text.
 * Returns an array of { before, artifact, after } segments.
 */
function parseArtifacts(text: string): Array<{
  textBefore: string;
  artifact?: AniArtifact;
  raw?: string;
}> {
  const TAG_RE = /<artifact\s+type="(?<type>[^"]+)"(?:\s+title="(?<title>[^"]*)")?(?:\s+language="(?<lang>[^"]*)")?\s*>\n?(?<source>[\s\S]*?)\n?<\/artifact>/g;

  const segments: Array<{ textBefore: string; artifact?: AniArtifact; raw?: string }> = [];
  let lastIndex = 0;

  for (const match of text.matchAll(TAG_RE)) {
    const before = text.slice(lastIndex, match.index);
    const artType = match.groups?.type ?? "html";
    const mappedType: AniArtifact["artifact_type"] =
      artType === "mermaid" ? "mermaid" :
      artType === "code" ? "code" :
      artType === "image" ? "image" : "html";

    segments.push({
      textBefore: before,
      artifact: {
        artifact_type: mappedType,
        source: match.groups?.source ?? "",
        title: match.groups?.title || undefined,
        language: match.groups?.lang || undefined,
      },
      raw: match[0],
    });
    lastIndex = (match.index ?? 0) + match[0].length;
  }

  // Remaining text after last artifact (or entire text if no artifacts found)
  const trailing = text.slice(lastIndex);
  if (trailing.trim() || segments.length === 0) {
    segments.push({ textBefore: trailing });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Attachment processing: download text files inline, describe others
// ---------------------------------------------------------------------------

const TEXT_MIME_PREFIXES = ['text/', 'application/json', 'application/xml', 'application/yaml'];
const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.xml', '.yaml', '.yml', '.log', '.toml', '.ini', '.cfg', '.conf', '.sh', '.py', '.js', '.ts', '.go', '.rs', '.sql'];
const MAX_TEXT_FILE_SIZE = 102400; // 100KB

function isTextFile(mimeType?: string, filename?: string): boolean {
  if (mimeType && TEXT_MIME_PREFIXES.some(p => mimeType.startsWith(p))) return true;
  if (filename) {
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    return TEXT_EXTENSIONS.includes(ext);
  }
  return false;
}

function formatFileSize(bytes?: number): string {
  if (bytes == null) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function processAttachments(
  attachments: NonNullable<NonNullable<AniWsMessage['data']>['attachments']>,
  serverUrl: string,
  apiKey: string,
): Promise<string> {
  const parts: string[] = [];

  for (const att of attachments) {
    const filename = att.filename || 'unknown';
    const url = att.url;

    if (!url) {
      parts.push(`[Attachment: ${filename} (${att.mime_type || 'unknown type'}, ${formatFileSize(att.size)})]`);
      continue;
    }

    // Build full URL (ANI uses relative paths like /files/...)
    const fullUrl = url.startsWith('http') ? url : `${serverUrl}${url}`;

    if (isTextFile(att.mime_type, att.filename) && (att.size ?? 0) <= MAX_TEXT_FILE_SIZE) {
      try {
        const res = await fetch(fullUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (res.ok) {
          const content = await res.text();
          parts.push(`--- Attached file: ${filename} ---\n${content}\n--- End of file ---`);
        } else {
          parts.push(`[Attachment: ${filename} (${att.mime_type || 'unknown'}, ${formatFileSize(att.size)}) — could not download]`);
        }
      } catch {
        parts.push(`[Attachment: ${filename} (${att.mime_type || 'unknown'}, ${formatFileSize(att.size)}) — download failed]`);
      }
    } else {
      parts.push(`[Attachment: ${filename} (${att.mime_type || 'unknown type'}, ${formatFileSize(att.size)})]`);
    }
  }

  return parts.join('\n\n');
}

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

  // Cache conversation metadata (refreshed every 5 minutes)
  const convCache = new Map<number, { conv: AniConversation; memories: AniMemory[]; fetchedAt: number }>();
  const CACHE_TTL = 5 * 60 * 1000;
  const CACHE_MAX_SIZE = 100;

  async function getConversationContext(conversationId: number): Promise<{
    conv: AniConversation | null;
    memories: AniMemory[];
  }> {
    const cached = convCache.get(conversationId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return { conv: cached.conv, memories: cached.memories };
    }
    const [conv, memories] = await Promise.all([
      fetchConversation({ serverUrl, apiKey, conversationId }),
      fetchConversationMemories({ serverUrl, apiKey, conversationId }),
    ]);
    if (conv) {
      // Evict oldest entry if cache is at capacity
      if (convCache.size >= CACHE_MAX_SIZE && !convCache.has(conversationId)) {
        let oldestKey: number | undefined;
        let oldestTime = Infinity;
        for (const [key, entry] of convCache) {
          if (entry.fetchedAt < oldestTime) {
            oldestTime = entry.fetchedAt;
            oldestKey = key;
          }
        }
        if (oldestKey !== undefined) convCache.delete(oldestKey);
      }
      convCache.set(conversationId, { conv, memories, fetchedAt: Date.now() });
    }
    return { conv, memories };
  }

  function buildConversationSystemPrompt(
    conv: AniConversation | null,
    memories: AniMemory[],
  ): string {
    const parts: string[] = [];

    // Identity
    parts.push(`You are ${selfName}.`);

    // Conversation instructions (set by owner)
    if (conv?.prompt?.trim()) {
      parts.push(`## Instructions\n\n${conv.prompt.trim()}`);
    }

    // Conversation description
    if (conv?.description?.trim()) {
      parts.push(`## Conversation Description\n\n${conv.description.trim()}`);
    }

    // Participants
    if (conv?.participants && conv.participants.length > 0) {
      const memberLines = conv.participants.map((p) => {
        const name = p.entity?.display_name ?? `entity-${p.entity_id}`;
        const type = p.entity?.entity_type ?? "unknown";
        const role = p.role ?? "member";
        return `- ${name} (${type}, ${role})`;
      });
      parts.push(`## Participants\n\n${memberLines.join("\n")}`);
    }

    // Memories
    if (memories.length > 0) {
      const memLines = memories.map((m) => `- **${m.key}**: ${m.content}`);
      parts.push(`## Conversation Memory\n\n${memLines.join("\n")}`);
    }

    // Artifact support instructions
    parts.push(ANI_ARTIFACT_SYSTEM_PROMPT);

    return parts.join("\n\n");
  }

  return async (wsMsg: AniWsMessage) => {
    try {
      // Only handle new messages (ANI uses "message.new" with dot)
      if (wsMsg.type !== "message.new") {
        logVerbose(`ani: ignoring ws event type=${wsMsg.type ?? "unknown"}`);
        return;
      }

      let msg = wsMsg.data;
      if (!msg) return;

      // Handle enriched WS format (mention_with_context): { message, context_messages }
      if (!msg.layers && (msg as any).message) {
        msg = (msg as any).message;
      }

      // Skip own messages
      if (msg.sender_id === selfEntityId) return;

      const conversationId = msg.conversation_id;
      if (!conversationId) return;

      const text = msg.layers?.summary ?? msg.layers?.detail ?? "";

      // Process attachments (download text files, describe others)
      const attachments = msg.attachments ?? [];
      logVerbose(`ani: attachments count=${attachments.length} raw=${JSON.stringify(attachments).slice(0, 500)}`);
      let attachmentText = '';
      if (attachments.length > 0) {
        attachmentText = await processAttachments(attachments, serverUrl, apiKey);
        logVerbose(`ani: attachmentText (${attachmentText.length} chars): ${attachmentText.slice(0, 300)}`);
      }

      if (!text.trim() && attachments.length === 0) return;

      const senderId = msg.sender_id ?? 0;
      const senderName =
        msg.sender?.display_name ?? `entity-${senderId}`;
      const senderType = msg.sender?.entity_type ?? msg.sender_type ?? "unknown";
      const messageId = String(msg.id ?? "");
      const isGroup = true; // ANI conversations are always group-like (agent-mediated)

      // Fetch conversation context (cached, refreshed every 5 min)
      const { conv: convContext, memories } = await getConversationContext(conversationId);
      const conversationTitle = convContext?.title ?? msg.conversation?.title ?? `conv-${conversationId}`;
      const groupSystemPrompt = buildConversationSystemPrompt(convContext, memories);

      logger.info(
        `ani: inbound conv=${conversationId} from=${senderName}(${senderId}) text="${text.slice(0, 80)}" attachments=${attachments.length} attachmentTextLen=${attachmentText.length}`,
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

      const rawBody = attachmentText ? `${text}\n\n${attachmentText}` : text;
      logVerbose(`ani: rawBody for envelope (${rawBody.length} chars): ${rawBody.slice(0, 500)}`);

      const body = core.channel.reply.formatAgentEnvelope({
        channel: "ANI",
        from: senderName,
        timestamp: msg.created_at ? new Date(msg.created_at).getTime() : undefined,
        previousTimestamp,
        envelope: envelopeOptions,
        body: rawBody,
      });
      logVerbose(`ani: formatted body (${body.length} chars): ${body.slice(0, 500)}`);

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
        GroupSystemPrompt: groupSystemPrompt,
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

      // Buffer all deliver chunks, then flush after dispatch completes.
      // This is necessary because the dispatcher may call deliver multiple
      // times with partial text, splitting an <artifact> tag across calls.
      const replyBuffer: string[] = [];

      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          responsePrefix: prefixContext.responsePrefix,
          responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            const replyText = payload.text ?? "";
            if (replyText.trim()) {
              replyBuffer.push(replyText);
            }
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

      // Flush buffered reply: reassemble full text, then parse artifacts
      if (replyBuffer.length > 0) {
        const fullReply = replyBuffer.join("\n");
        const segments = parseArtifacts(fullReply);
        const hasArtifacts = segments.some((s) => s.artifact);

        if (hasArtifacts) {
          for (const seg of segments) {
            const plainText = seg.textBefore.trim();
            if (plainText) {
              const chunks = core.channel.text.chunkMarkdownText(plainText, textLimit);
              for (const chunk of chunks.length > 0 ? chunks : [plainText]) {
                const trimmed = chunk.trim();
                if (!trimmed) continue;
                await sendAniMessage({ serverUrl, apiKey, conversationId, text: trimmed });
              }
            }
            if (seg.artifact) {
              await sendAniMessage({
                serverUrl,
                apiKey,
                conversationId,
                text: seg.artifact.title ?? "Artifact",
                artifact: seg.artifact,
              });
            }
          }
        } else {
          const chunks = core.channel.text.chunkMarkdownText(fullReply, textLimit);
          for (const chunk of chunks.length > 0 ? chunks : [fullReply]) {
            const trimmed = chunk.trim();
            if (!trimmed) continue;
            await sendAniMessage({ serverUrl, apiKey, conversationId, text: trimmed });
          }
        }
        didSendReply = true;
      }

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
