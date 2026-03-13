import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";

import { getAniRuntime } from "./runtime.js";
import { sendAniMessage } from "./monitor/send.js";

/** Resolve ANI serverUrl and apiKey from config. */
function resolveAniCredentials(): { serverUrl: string; apiKey: string } {
  const core = getAniRuntime();
  const cfg = core.config.loadConfig() as { channels?: { ani?: { serverUrl?: string; apiKey?: string } } };
  const serverUrl = (cfg.channels?.ani?.serverUrl ?? "").replace(/\/+$/, "");
  const apiKey = cfg.channels?.ani?.apiKey ?? "";
  if (!serverUrl || !apiKey) {
    throw new Error("ANI outbound: serverUrl and apiKey required");
  }
  return { serverUrl, apiKey };
}

/** Parse conversation ID from target string like "ani:conv:123" or "123". */
function parseConversationId(to: string): number {
  const cleaned = to
    .replace(/^ani:/i, "")
    .replace(/^conv:/i, "")
    .replace(/^channel:/i, "")
    .trim();
  const num = Number.parseInt(cleaned, 10);
  if (Number.isNaN(num) || num <= 0) {
    throw new Error(`ANI outbound: invalid conversation target "${to}"`);
  }
  return num;
}

export const aniOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getAniRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,

  sendText: async ({ to, text }) => {
    const { serverUrl, apiKey } = resolveAniCredentials();
    const conversationId = parseConversationId(to);
    const result = await sendAniMessage({ serverUrl, apiKey, conversationId, text });
    return {
      channel: "ani",
      messageId: String(result.messageId),
      roomId: String(conversationId),
    };
  },

  sendMedia: async ({ to, text }) => {
    // MVP: send text portion only; media upload not yet supported
    const { serverUrl, apiKey } = resolveAniCredentials();
    const conversationId = parseConversationId(to);
    const result = await sendAniMessage({ serverUrl, apiKey, conversationId, text: text ?? "" });
    return {
      channel: "ani",
      messageId: String(result.messageId),
      roomId: String(conversationId),
    };
  },
};
