/**
 * Fetch wrapper with exponential backoff retry for transient failures.
 * Retries on network errors and 502/503/504 server errors.
 */
async function fetchWithRetry(
  url: string,
  opts: RequestInit,
  maxAttempts = 3,
  baseDelayMs = 1000,
): Promise<Response> {
  let lastErr: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, opts);
      // Retry on server errors (502, 503, 504) but NOT on client errors (4xx)
      if (res.status >= 502 && res.status <= 504 && attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr ?? new Error("fetchWithRetry: all attempts failed");
}

/** Interaction option for interactive cards. */
export interface AniInteractionOption {
  label: string;
  value: string;
}

/** Interaction layer payload for approval/selection UI. */
export interface AniInteraction {
  type: "approval" | "selection";
  prompt?: string;
  options?: AniInteractionOption[];
}

/** Artifact payload for ANI structured content. */
export interface AniArtifact {
  artifact_type: "html" | "code" | "mermaid" | "image";
  source: string;
  title?: string;
  language?: string;
}

/** Result from uploading a file to the ANI backend. */
export interface AniFileUploadResult {
  url: string;
  filename: string;
  size: number;
}

/**
 * Upload a file to the ANI backend via multipart form data.
 * Endpoint: POST /api/v1/files/upload (max 32MB).
 */
export async function uploadAniFile(opts: {
  serverUrl: string;
  apiKey: string;
  buffer: Buffer | Uint8Array;
  filename: string;
}): Promise<AniFileUploadResult> {
  const url = `${opts.serverUrl}/api/v1/files/upload`;
  const form = new FormData();
  const blob = new Blob([opts.buffer]);
  form.append("file", blob, opts.filename);

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI file upload failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as {
    data?: { url?: string; filename?: string; size?: number };
  };
  const data = json.data ?? {};
  return {
    url: data.url ?? "",
    filename: data.filename ?? opts.filename,
    size: data.size ?? 0,
  };
}

/** ANI attachment matching backend model.Attachment. */
export interface AniAttachment {
  type: string;
  url?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
  content?: string;
}

/** Send a message to an ANI conversation via REST API. */
export async function sendAniMessage(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
  text: string;
  /** If provided, sends as content_type "artifact" instead of plain text. */
  artifact?: AniArtifact;
  /** Entity IDs to @mention (must be conversation participants). */
  mentions?: number[];
  /** Interaction layer for interactive cards (approval/selection UI). */
  interaction?: AniInteraction;
  /** File/media attachments to include with the message. */
  attachments?: AniAttachment[];
  /** Content type override (e.g. "image", "audio", "file", "video"). */
  contentType?: string;
  /** Message ID to reply to. */
  replyTo?: number;
  /** Stream identifier for streaming responses. */
  streamId?: string;
  /** Status layer for progress updates during streaming. */
  statusLayer?: { phase: string; progress: number; text: string };
}): Promise<{ messageId: number }> {
  const url = `${opts.serverUrl}/api/v1/messages/send`;

  const layers: Record<string, unknown> = opts.artifact
    ? { summary: opts.text, data: opts.artifact }
    : { summary: opts.text };

  if (opts.interaction) {
    layers.interaction = opts.interaction;
  }
  if (opts.statusLayer) {
    layers.status = opts.statusLayer;
  }

  // Determine content_type: artifact > explicit contentType > default (omit for text)
  let contentType: string | undefined;
  if (opts.artifact) {
    contentType = "artifact";
  } else if (opts.contentType) {
    contentType = opts.contentType;
  }

  const payload: Record<string, unknown> = {
    conversation_id: opts.conversationId,
    layers,
    ...(contentType ? { content_type: contentType } : {}),
    ...(opts.mentions && opts.mentions.length > 0 ? { mentions: opts.mentions } : {}),
    ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
    ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    ...(opts.streamId ? { stream_id: opts.streamId } : {}),
  };

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI send failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: { id?: number }; id?: number };
  const msg = json.data ?? json;
  return { messageId: msg.id ?? 0 };
}

/** Fetch conversation details (title, description, prompt, participants). */
export async function fetchConversation(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
}): Promise<AniConversation | null> {
  const url = `${opts.serverUrl}/api/v1/conversations/${opts.conversationId}`;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: AniConversation };
    return json.data ?? null;
  } catch {
    return null;
  }
}

/** Fetch conversation memories. */
export async function fetchConversationMemories(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
}): Promise<AniMemory[]> {
  const url = `${opts.serverUrl}/api/v1/conversations/${opts.conversationId}/memories`;
  try {
    const res = await fetchWithRetry(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: { memories?: AniMemory[] } };
    return json.data?.memories ?? [];
  } catch {
    return [];
  }
}

export interface AniConversation {
  id: number;
  conv_type?: string;
  title?: string;
  description?: string;
  prompt?: string;
  participants?: Array<{
    entity_id: number;
    role?: string;
    entity?: {
      id: number;
      display_name?: string;
      entity_type?: string;
    };
  }>;
}

export interface AniMemory {
  id: number;
  key: string;
  content: string;
}

/** Verify the API key works and return entity info. */
export async function verifyAniConnection(opts: {
  serverUrl: string;
  apiKey: string;
}): Promise<{ entityId: number; name: string; entityType: string }> {
  const url = `${opts.serverUrl}/api/v1/me`;
  const res = await fetchWithRetry(url, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI /me failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as {
    data?: { id?: number; display_name?: string; entity_type?: string };
    id?: number;
    display_name?: string;
    entity_type?: string;
  };
  // ANI wraps response in { data: { ... }, ok: true }
  const entity = json.data ?? json;
  const entityId = entity.id ?? 0;
  if (!entityId) {
    throw new Error("ANI /me returned no entity ID — check API key validity");
  }
  return {
    entityId,
    name: entity.display_name ?? "unknown",
    entityType: entity.entity_type ?? "bot",
  };
}

/**
 * Send a transient progress event via POST /conversations/:id/progress.
 * This is NOT persisted to the database — broadcast to WebSocket clients only.
 */
export async function sendAniProgress(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
  streamId: string;
  status: { phase: string; progress: number; text: string };
}): Promise<void> {
  const url = `${opts.serverUrl}/api/v1/conversations/${opts.conversationId}/progress`;
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        stream_id: opts.streamId,
        status: opts.status,
      }),
      signal: AbortSignal.timeout(10_000),
    },
    2, // fire-and-forget: less aggressive retry
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI progress failed (${res.status}): ${body}`);
  }
}

/**
 * Send a typing indicator via POST /conversations/:id/typing.
 * This is NOT persisted — broadcast to WebSocket clients only.
 * Fire-and-forget: errors are silently ignored.
 */
export async function sendAniTyping(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
  isProcessing?: boolean;
  phase?: string;
}): Promise<void> {
  const url = `${opts.serverUrl}/api/v1/conversations/${opts.conversationId}/typing`;
  const body: Record<string, unknown> = {};
  if (opts.isProcessing) {
    body.is_processing = true;
    if (opts.phase) body.phase = opts.phase;
  }
  const res = await fetchWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    },
    2, // fire-and-forget: less aggressive retry
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ANI typing failed (${res.status}): ${text}`);
  }
}

/** Toggle an emoji reaction on a message. POST /messages/:id/reactions */
export async function toggleAniReaction(opts: {
  serverUrl: string;
  apiKey: string;
  messageId: number;
  emoji: string;
}): Promise<void> {
  const url = `${opts.serverUrl}/api/v1/messages/${opts.messageId}/reactions`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({ emoji: opts.emoji }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI reaction failed (${res.status}): ${body}`);
  }
}
