/** Artifact payload for ANI structured content. */
export interface AniArtifact {
  artifact_type: "html" | "code" | "mermaid" | "image";
  source: string;
  title?: string;
  language?: string;
}

/** Send a message to an ANI conversation via REST API. */
export async function sendAniMessage(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
  text: string;
  /** If provided, sends as content_type "artifact" instead of plain text. */
  artifact?: AniArtifact;
}): Promise<{ messageId: number }> {
  const url = `${opts.serverUrl}/api/v1/messages/send`;

  const payload = opts.artifact
    ? {
        conversation_id: opts.conversationId,
        content_type: "artifact",
        layers: {
          summary: opts.text,
          data: opts.artifact,
        },
      }
    : {
        conversation_id: opts.conversationId,
        layers: { summary: opts.text },
      };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(payload),
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
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
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
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.apiKey}` },
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
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
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
  return {
    entityId: entity.id ?? 0,
    name: entity.display_name ?? "unknown",
    entityType: entity.entity_type ?? "bot",
  };
}
