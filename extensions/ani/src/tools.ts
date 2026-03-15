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
