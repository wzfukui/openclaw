/** Send a message to an ANI conversation via REST API. */
export async function sendAniMessage(opts: {
  serverUrl: string;
  apiKey: string;
  conversationId: number;
  text: string;
}): Promise<{ messageId: number }> {
  const url = `${opts.serverUrl}/api/v1/messages/send`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      conversation_id: opts.conversationId,
      layers: { summary: opts.text },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ANI send failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { data?: { id?: number }; id?: number };
  const msg = json.data ?? json;
  return { messageId: msg.id ?? 0 };
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
