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

/**
 * Agent tool: ani_send_workspace_file
 *
 * Send an existing file from the workspace (or any local path) to an ANI conversation.
 * Supports binary files: images (PNG, JPG), PDFs, archives, audio, video, etc.
 * Use this after generating a screenshot, chart, or any file that exists on disk.
 */
export function createSendWorkspaceFileTool(): ChannelAgentTool {
  return {
    label: "Send Workspace File to ANI",
    name: "ani_send_workspace_file",
    description: [
      "Send an existing file from the local filesystem to an ANI conversation.",
      "Use this for binary files like screenshots (PNG/JPG), PDFs, audio, video, or any file on disk.",
      "The file is read from the given path, uploaded to ANI, and sent as a message attachment.",
      "You MUST provide conversation_id and the absolute file_path.",
    ].join(" "),
    parameters: Type.Object({
      conversation_id: Type.Number({
        description: "The ANI conversation ID to send the file to",
      }),
      file_path: Type.String({
        description: "Absolute path to the file on disk, e.g. '/Users/x/.openclaw/workspace/screenshot.png'",
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
        file_path?: string;
        caption?: string;
      };

      const conversationId = params.conversation_id;
      const filePath = params.file_path?.trim();
      const caption = params.caption?.trim() ?? "";

      if (!conversationId) {
        return { content: [{ type: "text" as const, text: "Error: conversation_id is required" }] };
      }
      if (!filePath) {
        return { content: [{ type: "text" as const, text: "Error: file_path is required" }] };
      }

      try {
        // Verify file exists and read it
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) {
          return { content: [{ type: "text" as const, text: `Error: ${filePath} is not a file` }] };
        }
        if (stat.size > 32 * 1024 * 1024) {
          return { content: [{ type: "text" as const, text: `Error: file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 32MB)` }] };
        }

        const buffer = await fs.readFile(filePath);
        const filename = path.basename(filePath);
        const mimeType = getMimeType(filename);

        const { serverUrl, apiKey } = resolveAniCredentials();

        // Upload file to ANI backend
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
          size: stat.size,
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
            text: `File "${filename}" (${(stat.size / 1024).toFixed(1)}KB, ${mimeType}) sent to conversation ${conversationId}. Message ID: ${result.messageId}`,
          }],
          details: { messageId: result.messageId, filename, url: uploaded.url, size: stat.size, mimeType },
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
