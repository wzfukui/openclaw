import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "openclaw/plugin-sdk";

import { sendAniMessage, uploadAniFile } from "./monitor/send.js";
import type { AniAttachment } from "./monitor/send.js";
import { resolveAniCredentials, getMimeType } from "./utils.js";

/**
 * Agent tool: ani_send_file
 *
 * Lets the LLM create a file and send it directly to the current ANI conversation.
 * The tool handles the complete flow: create buffer → upload → send message with attachment.
 * No MEDIA: prefix needed — the file is delivered immediately.
 */
export function createSendFileTool(): ChannelAgentTool {
  return {
    label: "Send File to ANI",
    name: "ani_send_file",
    description: [
      "Create and send a file to the current ANI conversation as a downloadable attachment.",
      "Use this when the user asks you to generate, export, or create a file.",
      "Supported: .md, .txt, .csv, .json, .py, .js, .html, .xml, .yaml, .sql, etc.",
      "You MUST provide the conversation_id of the current conversation.",
      "The file is uploaded and delivered immediately — no further action needed.",
    ].join(" "),
    parameters: Type.Object({
      conversation_id: Type.Number({
        description: "The ANI conversation ID to send the file to (from the current conversation context)",
      }),
      filename: Type.String({
        description: "Filename with extension, e.g. 'summary.md', 'data.csv', 'report.json'",
      }),
      content: Type.String({
        description: "The full text content of the file",
      }),
      caption: Type.Optional(
        Type.String({
          description: "Optional message text to accompany the file",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as {
        conversation_id?: number;
        filename?: string;
        content?: string;
        caption?: string;
      };

      const conversationId = params.conversation_id;
      const filename = params.filename?.trim();
      const content = params.content ?? "";
      const caption = params.caption?.trim() ?? "";

      if (!conversationId) {
        return {
          content: [{ type: "text" as const, text: "Error: conversation_id is required" }],
        };
      }
      if (!filename) {
        return {
          content: [{ type: "text" as const, text: "Error: filename is required" }],
        };
      }
      if (!content) {
        return {
          content: [{ type: "text" as const, text: "Error: file content cannot be empty" }],
        };
      }

      try {
        const { serverUrl, apiKey } = resolveAniCredentials();
        const mimeType = getMimeType(filename);

        // Step 1: Upload file
        const buffer = Buffer.from(content, "utf-8");
        const uploaded = await uploadAniFile({ serverUrl, apiKey, buffer, filename });

        // Step 2: Send message with attachment directly to the conversation
        const attachments: AniAttachment[] = [{
          type: "file",
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
          contentType: "file",
        });

        return {
          content: [{
            type: "text" as const,
            text: `File "${filename}" (${buffer.length} bytes) sent successfully to conversation ${conversationId}. Message ID: ${result.messageId}`,
          }],
          details: {
            messageId: result.messageId,
            filename,
            url: uploaded.url,
            size: buffer.length,
            mimeType,
          },
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
