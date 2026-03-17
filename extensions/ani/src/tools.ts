import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import fs from "node:fs/promises";
import path from "node:path";

import { sendAniMessage, uploadAniFile } from "./monitor/send.js";
import type { AniAttachment } from "./monitor/send.js";
import { resolveAniCredentials, getMimeType } from "./utils.js";

/**
 * Agent tool: ani_send_file
 *
 * Unified file sending tool — handles both generated text content and existing
 * files on disk. The tool auto-detects the mode based on which parameter is provided:
 *
 * - `file_path`: Read binary/text file from disk and send (for screenshots, PDFs, etc.)
 * - `content`: Create a new file from text content and send (for generated .md, .csv, etc.)
 *
 * If both are provided, `file_path` takes precedence.
 */
export function createSendFileTool(): ChannelAgentTool {
  return {
    label: "Send File to ANI",
    name: "ani_send_file",
    description: [
      "Send a file to the current ANI conversation as a downloadable attachment.",
      "Two modes: (1) provide file_path to send an existing file from disk (screenshot, PDF, image, etc.),",
      "or (2) provide content to create and send a new text file (.md, .csv, .json, etc.).",
      "You MUST provide conversation_id. Provide either file_path OR content (not both).",
    ].join(" "),
    parameters: Type.Object({
      conversation_id: Type.Number({
        description: "The ANI conversation ID to send the file to",
      }),
      file_path: Type.Optional(
        Type.String({
          description: "Absolute path to an existing file on disk to send",
        }),
      ),
      filename: Type.Optional(
        Type.String({
          description: "Filename with extension (required when using content mode, optional for file_path mode)",
        }),
      ),
      content: Type.Optional(
        Type.String({
          description: "Text content to create as a new file (for .md, .csv, .json, .txt, etc.)",
        }),
      ),
      caption: Type.Optional(
        Type.String({
          description: "Optional message text to accompany the file",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        conversation_id?: number;
        file_path?: string;
        filename?: string;
        content?: string;
        caption?: string;
      };

      const conversationId = params.conversation_id;
      if (!conversationId) {
        return { content: [{ type: "text" as const, text: "Error: conversation_id is required" }] };
      }

      const filePath = params.file_path?.trim();
      const textContent = params.content;
      const caption = params.caption?.trim() ?? "";

      if (!filePath && !textContent) {
        return { content: [{ type: "text" as const, text: "Error: provide either file_path or content" }] };
      }

      try {
        const { serverUrl, apiKey } = resolveAniCredentials();
        let buffer: Buffer;
        let filename: string;

        if (filePath) {
          // Mode 1: Read existing file from disk
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) {
            return { content: [{ type: "text" as const, text: `Error: ${filePath} is not a file` }] };
          }
          if (stat.size > 32 * 1024 * 1024) {
            return { content: [{ type: "text" as const, text: `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 32MB)` }] };
          }
          buffer = await fs.readFile(filePath);
          filename = params.filename?.trim() || path.basename(filePath);
        } else {
          // Mode 2: Create file from text content
          filename = params.filename?.trim() || "file.txt";
          buffer = Buffer.from(textContent!, "utf-8");
        }

        const mimeType = getMimeType(filename);

        // Upload to ANI backend
        const uploaded = await uploadAniFile({ serverUrl, apiKey, buffer, filename });

        // Determine attachment type from MIME
        let attachType = "file";
        if (mimeType.startsWith("image/")) attachType = "image";
        else if (mimeType.startsWith("audio/")) attachType = "audio";
        else if (mimeType.startsWith("video/")) attachType = "video";

        // Send message with attachment
        const attachments: AniAttachment[] = [{
          type: attachType,
          url: uploaded.url,
          filename: uploaded.filename,
          mime_type: mimeType,
          size: buffer.length,
        }];

        const result = await sendAniMessage({
          serverUrl,
          apiKey,
          conversationId,
          text: caption || `📎 ${filename}`,
          attachments,
          contentType: attachType,
        });

        return {
          content: [{
            type: "text" as const,
            text: `File "${filename}" (${(buffer.length / 1024).toFixed(1)}KB, ${mimeType}) sent to conversation ${conversationId}. Message ID: ${result.messageId}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Error sending file: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  };
}

/**
 * Agent tool: ani_get_history
 *
 * Fetch full conversation history from the ANI backend.
 * Unlike OpenClaw's sessions_history (which only shows messages the bot received),
 * this tool fetches ALL messages in the conversation — including messages between
 * humans, other bots, and messages sent while this bot was offline or not @mentioned.
 */
export function createGetHistoryTool(): ChannelAgentTool {
  return {
    label: "Get ANI Conversation History",
    name: "ani_get_history",
    description: [
      "Fetch recent message history from an ANI conversation.",
      "This returns ALL messages in the conversation, including ones you were not @mentioned in.",
      "Use when a user references earlier messages, files, or context you don't have.",
      "You MUST provide the conversation_id.",
    ].join(" "),
    parameters: Type.Object({
      conversation_id: Type.Number({
        description: "The ANI conversation ID",
      }),
      limit: Type.Optional(
        Type.Number({
          description: "Max messages to return (default 20, max 50)",
        }),
      ),
      since_id: Type.Optional(
        Type.Number({
          description: "Only return messages newer than this message ID",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        conversation_id?: number;
        limit?: number;
        since_id?: number;
      };

      const conversationId = params.conversation_id;
      if (!conversationId) {
        return { content: [{ type: "text" as const, text: "Error: conversation_id is required" }] };
      }

      const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);

      try {
        const { serverUrl, apiKey } = resolveAniCredentials();
        let url = `${serverUrl}/api/v1/conversations/${conversationId}/messages?limit=${limit}`;
        if (params.since_id) {
          url += `&since_id=${params.since_id}`;
        }

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) {
          return { content: [{ type: "text" as const, text: `Error fetching history: HTTP ${res.status}` }] };
        }

        const json = await res.json() as { data?: { messages?: Array<Record<string, unknown>> } };
        const messages = json.data?.messages ?? [];

        // Format messages for LLM readability
        const formatted = messages.map((m: Record<string, unknown>) => {
          const sender = (m.sender as Record<string, unknown>)?.display_name ?? `entity-${m.sender_id}`;
          const text = ((m.layers as Record<string, unknown>)?.summary as string) ?? "";
          const time = m.created_at as string;
          const atts = (m.attachments as Array<Record<string, unknown>>) ?? [];
          const attDesc = atts.length > 0
            ? ` [${atts.length} attachment(s): ${atts.map((a) => a.filename ?? a.type).join(", ")}]`
            : "";
          return `[${time}] ${sender}: ${text}${attDesc}`;
        }).reverse(); // oldest first for readability

        return {
          content: [{
            type: "text" as const,
            text: `Conversation ${conversationId} — last ${messages.length} messages:\n\n${formatted.join("\n")}`,
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          }],
        };
      }
    },
  };
}
