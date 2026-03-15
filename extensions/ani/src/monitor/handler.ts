import {
  createReplyPrefixContext,
  createTypingCallbacks,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";

import { randomBytes } from "node:crypto";

import type { CoreConfig } from "../types.js";
import {
  sendAniMessage,
  sendAniProgress,
  sendAniTyping,
  fetchConversation,
  fetchConversationMemories,
  toggleAniReaction,
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
    // Mentions: entity IDs mentioned in this message
    mentions?: number[];
    // Interaction layer (approval/selection cards)
    // conversation info
    conversation?: {
      id?: number;
      title?: string;
      conv_type?: string;
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
export function parseArtifacts(text: string): Array<{
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

export function isTextFile(mimeType?: string, filename?: string): boolean {
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

/** Classify a MIME type into a human-readable category. */
function classifyMime(mimeType?: string): { category: string; label: string } {
  if (!mimeType) return { category: "file", label: "unknown type" };
  if (mimeType.startsWith("image/")) {
    const fmt = mimeType.replace("image/", "").toUpperCase();
    return { category: "image", label: `${fmt} image` };
  }
  if (mimeType.startsWith("audio/")) {
    const fmt = mimeType.replace("audio/", "").toUpperCase();
    return { category: "audio", label: `${fmt} audio` };
  }
  if (mimeType.startsWith("video/")) {
    const fmt = mimeType.replace("video/", "").toUpperCase();
    return { category: "video", label: `${fmt} video` };
  }
  if (mimeType === "application/pdf") return { category: "document", label: "PDF document" };
  if (mimeType.includes("word") || mimeType.includes("document")) return { category: "document", label: "Word document" };
  if (mimeType.includes("excel") || mimeType.includes("spreadsheet")) return { category: "document", label: "Excel spreadsheet" };
  if (mimeType.includes("powerpoint") || mimeType.includes("presentation")) return { category: "document", label: "PowerPoint presentation" };
  if (mimeType === "application/zip") return { category: "archive", label: "ZIP archive" };
  if (mimeType.includes("tar") || mimeType.includes("gzip")) return { category: "archive", label: "compressed archive" };
  return { category: "file", label: mimeType };
}

/** Format an attachment description with category-specific prefix and download URL. */
function formatAttachmentDescription(
  filename: string,
  mimeType: string | undefined,
  size: number | undefined,
  downloadUrl: string | undefined,
  duration?: number,
): string {
  const { category, label } = classifyMime(mimeType);
  const sizeStr = formatFileSize(size);
  const durationStr = duration ? `, ${duration}s` : "";
  const urlStr = downloadUrl ? ` — download: ${downloadUrl}` : "";

  switch (category) {
    case "image":
      return `[Image attached: ${filename} (${label}, ${sizeStr})${urlStr}]`;
    case "document":
      return `[Document attached: ${filename} (${label}, ${sizeStr})${urlStr}]`;
    case "audio":
      return `[Audio attached: ${filename} (${label}${durationStr}, ${sizeStr})${urlStr}]`;
    case "video":
      return `[Video attached: ${filename} (${label}${durationStr}, ${sizeStr})${urlStr}]`;
    case "archive":
      return `[Archive attached: ${filename} (${label}, ${sizeStr})${urlStr}]`;
    default:
      return `[File attached: ${filename} (${label}, ${sizeStr})${urlStr}]`;
  }
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
      parts.push(formatAttachmentDescription(filename, att.mime_type, att.size, undefined, att.duration));
      continue;
    }

    // Build full URL (ANI uses relative paths like /files/...)
    const fullUrl = url.startsWith('http') ? url : `${serverUrl}${url}`;

    // For text files small enough, download and inline the content
    if (isTextFile(att.mime_type, att.filename) && (att.size ?? 0) <= MAX_TEXT_FILE_SIZE) {
      try {
        const res = await fetch(fullUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) {
          // Validate actual response size before reading body to prevent DoS
          const contentLength = Number(res.headers.get("content-length") ?? "0");
          if (contentLength > MAX_TEXT_FILE_SIZE) {
            parts.push(formatAttachmentDescription(filename, att.mime_type, contentLength, fullUrl, att.duration));
          } else {
            const content = await res.text();
            if (content.length > MAX_TEXT_FILE_SIZE) {
              // Actual body exceeded limit despite header; fall back to description
              parts.push(formatAttachmentDescription(filename, att.mime_type, content.length, fullUrl, att.duration));
            } else {
              parts.push(`--- Attached file: ${filename} ---\n${content}\n--- End of file ---`);
            }
          }
        } else {
          parts.push(formatAttachmentDescription(filename, att.mime_type, att.size, fullUrl, att.duration));
        }
      } catch {
        parts.push(formatAttachmentDescription(filename, att.mime_type, att.size, fullUrl, att.duration));
      }
    } else {
      // Non-text or large files: provide a rich description with download URL
      parts.push(formatAttachmentDescription(filename, att.mime_type, att.size, fullUrl, att.duration));
    }
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Media download: save attachments to disk for OpenClaw media pipeline
// ---------------------------------------------------------------------------

type SavedAttachment = { path: string; contentType?: string };

/**
 * Download ANI attachments and save them to OpenClaw's media directory.
 * This enables the media-understanding pipeline (vision, audio transcription, etc.)
 * which requires local file paths via MediaPath/MediaPaths context fields.
 */
async function downloadAndSaveAttachments(
  attachments: NonNullable<NonNullable<AniWsMessage['data']>['attachments']>,
  serverUrl: string,
  apiKey: string,
  saveFn: (buffer: Buffer, contentType?: string, subdir?: string, maxBytes?: number, originalFilename?: string) => Promise<{ path: string; contentType?: string }>,
  logVerbose: (msg: string) => void,
): Promise<SavedAttachment[]> {
  const saved: SavedAttachment[] = [];

  for (const att of attachments) {
    const url = att.url;
    if (!url) continue;

    const fullUrl = url.startsWith('http') ? url : `${serverUrl}${url}`;
    try {
      const res = await fetch(fullUrl, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        logVerbose(`ani: media download failed (${res.status}) for ${att.filename ?? url}`);
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = att.mime_type ?? res.headers.get("content-type") ?? undefined;

      const result = await saveFn(
        buffer,
        contentType,
        "inbound",
        10 * 1024 * 1024, // 10MB limit for save
        att.filename ?? undefined,
      );

      saved.push({ path: result.path, contentType: result.contentType });
      logVerbose(`ani: saved media ${att.filename ?? "file"} → ${result.path} (${result.contentType})`);
    } catch (err) {
      logVerbose(`ani: media save failed for ${att.filename ?? url}: ${String(err)}`);
    }
  }

  return saved;
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------

/** Generate a short random stream ID. */
function generateStreamId(): string {
  return `stream-${randomBytes(6).toString("hex")}`;
}

/**
 * Creates a handler function for incoming ANI WebSocket messages.
 * Only handles `message_new` events, routes them through the OpenClaw
 * AI agent pipeline, and delivers replies via ANI REST API.
 *
 * Phase 2: Replies are streamed incrementally. On the first chunk a
 * stream_start message is sent with a generated stream_id. Subsequent
 * chunks become stream_delta messages with progress status layers.
 * The final flush sends a stream_end message (persisted by the backend).
 * Artifacts are still buffered and sent only in the final flush.
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
    conversationId: number,
  ): string {
    const parts: string[] = [];

    // Identity
    parts.push(`You are ${selfName}.`);

    // Current conversation context
    const convType = conv?.conv_type ?? "group";
    parts.push(`## Current Conversation\n\nConversation ID: ${conversationId}\nType: ${convType}`);

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

  /**
   * Build a lighter system prompt for direct (1:1) conversations.
   * Skips participant list and group description since there are only two entities.
   */
  function buildDirectSystemPrompt(
    conv: AniConversation | null,
    memories: AniMemory[],
    conversationId: number,
  ): string {
    const parts: string[] = [];

    parts.push(`You are ${selfName}.`);

    // Current conversation context
    parts.push(`## Current Conversation\n\nConversation ID: ${conversationId}\nType: direct`);

    if (conv?.prompt?.trim()) {
      parts.push(`## Instructions\n\n${conv.prompt.trim()}`);
    }

    if (memories.length > 0) {
      const memLines = memories.map((m) => `- **${m.key}**: ${m.content}`);
      parts.push(`## Conversation Memory\n\n${memLines.join("\n")}`);
    }

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

      // Process attachments:
      // 1. Download and save to disk for OpenClaw media pipeline (MediaPath/MediaType)
      // 2. Also produce text descriptions for context (attachmentText)
      const attachments = msg.attachments ?? [];
      logVerbose(`ani: attachments count=${attachments.length} raw=${JSON.stringify(attachments).slice(0, 500)}`);
      let attachmentText = '';
      let savedMedia: SavedAttachment[] = [];
      if (attachments.length > 0) {
        // Save files to disk for media-understanding pipeline (vision, audio, etc.)
        savedMedia = await downloadAndSaveAttachments(attachments, serverUrl, apiKey, core.media.saveMediaBuffer, logVerbose);
        // Also generate text descriptions as supplementary context
        attachmentText = await processAttachments(attachments, serverUrl, apiKey);
        logVerbose(`ani: attachmentText (${attachmentText.length} chars) savedMedia=${savedMedia.length}: ${attachmentText.slice(0, 300)}`);
      }

      if (!text.trim() && attachments.length === 0) return;

      const senderId = msg.sender_id ?? 0;
      const senderName =
        msg.sender?.display_name ?? `entity-${senderId}`;
      const senderType = msg.sender?.entity_type ?? msg.sender_type ?? "unknown";
      const messageId = String(msg.id ?? "");

      // Fetch conversation context (cached, refreshed every 5 min)
      const { conv: convContext, memories } = await getConversationContext(conversationId);
      const conversationTitle = convContext?.title ?? msg.conversation?.title ?? `conv-${conversationId}`;

      // Determine if this is a direct (1:1) or group conversation.
      // ANI backend supports conv_type: "direct", "group", "channel".
      const convType = convContext?.conv_type ?? msg.conversation?.conv_type ?? "group";
      const isDirect = convType === "direct";

      // For direct conversations, skip the full group system prompt (no participants list,
      // no group description injection) -- just use identity + instructions + memories.
      const groupSystemPrompt = isDirect
        ? buildDirectSystemPrompt(convContext, memories, conversationId)
        : buildConversationSystemPrompt(convContext, memories, conversationId);

      logger.info(
        `ani: inbound conv=${conversationId} type=${convType} from=${senderName}(${senderId}) attachments=${attachments.length} hasText=${Boolean(text.trim())}`,
      );

      // Send ack-reaction if configured (confirms message receipt).
      // Uses the OpenClaw ackReaction config pattern from messages.ackReaction.
      const ackEmoji = cfg.messages?.ackReaction?.trim();
      if (ackEmoji && msg.id) {
        toggleAniReaction({ serverUrl, apiKey, messageId: msg.id, emoji: ackEmoji }).catch((err) => {
          logVerbose(`ani: ack-reaction failed for msg=${msg.id}: ${String(err)}`);
        });
      }

      // Send typing indicator (best-effort, fire-and-forget)
      sendAniTyping({ serverUrl, apiKey, conversationId, isProcessing: true, phase: "thinking" }).catch((err) => {
        logVerbose(`ani: typing indicator failed for conv=${conversationId}: ${String(err)}`);
      });

      // Route through OpenClaw agent pipeline
      const peerKind = isDirect ? "dm" : "channel";
      const route = core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "ani",
        peer: {
          kind: peerKind,
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

      // Build media context fields from saved attachments (for OpenClaw media pipeline)
      const mediaPaths = savedMedia.map((m) => m.path);
      const mediaTypes = savedMedia.map((m) => m.contentType ?? "application/octet-stream");

      // Build context payload: direct conversations use "direct" ChatType, skip group fields.
      const chatType = isDirect ? "direct" as const : "channel" as const;
      const ctxPayload = core.channel.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: rawBody, // Pass the full body with inlined attachments directly to the agent
        RawBody: text,
        CommandBody: text,
        From: isDirect ? `ani:dm:${senderId}` : `ani:channel:${conversationId}`,
        To: `ani:conv:${conversationId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: chatType,
        ConversationLabel: senderName,
        SenderName: senderName,
        SenderId: String(senderId),
        // Media fields: enable OpenClaw's media-understanding pipeline
        ...(mediaPaths.length > 0 ? {
          MediaPath: mediaPaths[0],
          MediaPaths: mediaPaths,
          MediaType: mediaTypes[0],
          MediaTypes: mediaTypes,
        } : {}),
        ...(isDirect
          ? {}
          : {
              GroupSubject: conversationTitle,
              GroupChannel: String(conversationId),
            }),
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

      // Typing callbacks are no-ops — we manage typing state manually:
      // start typing at message receive, stop typing after reply flush.
      // Using callbacks here would cause extra "typing" events mid-reply.
      const typingCallbacks = createTypingCallbacks({
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        onStartError: () => {},
        onStopError: () => {},
      });

      let didSendReply = false;

      // Buffer all reply text for artifact detection (artifacts need full text to parse).
      // Progress is sent via the non-persisted POST /conversations/:id/progress endpoint
      // (broadcast via WebSocket, NOT stored in DB — no empty bubbles).
      const streamId = generateStreamId();
      const replyBuffer: string[] = [];
      let totalChars = 0;

      const { dispatcher, replyOptions, markDispatchIdle } =
        core.channel.reply.createReplyDispatcherWithTyping({
          responsePrefix: prefixContext.responsePrefix,
          responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
          humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
          deliver: async (payload) => {
            const replyText = payload.text ?? "";
            if (!replyText.trim()) return;

            replyBuffer.push(replyText);
            totalChars += replyText.length;
            logVerbose(`ani: buffered chunk (${replyText.length} chars, total ${replyBuffer.length} chunks)`);

            // Send non-persisted progress event (best-effort, fire-and-forget)
            try {
              const progress = Math.min(0.9, 0.1 + (replyBuffer.length * 0.05));
              await sendAniProgress({
                serverUrl,
                apiKey,
                conversationId,
                streamId,
                status: {
                  phase: "generating",
                  progress,
                  text: `Writing... (${totalChars} chars)`,
                },
              });
            } catch {
              // Non-fatal: progress display is best-effort
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

      // Flush buffered reply: reassemble full text, then parse artifacts.
      // The final message is sent with stream_id so the ANI frontend can
      // associate it with the stream and replace progress indicators.
      if (replyBuffer.length > 0) {
        const fullReply = replyBuffer.join("\n");
        const segments = parseArtifacts(fullReply);
        const hasArtifacts = segments.some((s) => s.artifact);

        if (hasArtifacts) {
          for (const seg of segments) {
            try {
              const plainText = seg.textBefore.trim();
              if (plainText) {
                const chunks = core.channel.text.chunkMarkdownText(plainText, textLimit);
                for (const chunk of chunks.length > 0 ? chunks : [plainText]) {
                  const trimmed = chunk.trim();
                  if (!trimmed) continue;
                  await sendAniMessage({ serverUrl, apiKey, conversationId, text: trimmed, streamId });
                }
              }
              if (seg.artifact) {
                await sendAniMessage({
                  serverUrl,
                  apiKey,
                  conversationId,
                  text: seg.artifact.title ?? "Artifact",
                  artifact: seg.artifact,
                  streamId,
                });
              }
            } catch (flushErr) {
              logger.warn(
                { error: String(flushErr), conversationId },
                "ani: artifact flush segment failed, continuing with remaining segments",
              );
            }
          }
        } else {
          const chunks = core.channel.text.chunkMarkdownText(fullReply, textLimit);
          for (const chunk of chunks.length > 0 ? chunks : [fullReply]) {
            const trimmed = chunk.trim();
            if (!trimmed) continue;
            await sendAniMessage({ serverUrl, apiKey, conversationId, text: trimmed, streamId });
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
        logVerbose(`ani: delivered reply to conv=${conversationId} streamId=${streamId} chunks=${replyBuffer.length}`);
      }

      // Always clear typing indicator when done (whether reply was sent or not)
      sendAniTyping({ serverUrl, apiKey, conversationId, isProcessing: false }).catch(() => {});
    } catch (err) {
      // Clear typing on error too
      sendAniTyping({ serverUrl, apiKey, conversationId, isProcessing: false }).catch(() => {});
      runtime.error?.(`ani handler error: ${String(err)}`);
    }
  };
}
