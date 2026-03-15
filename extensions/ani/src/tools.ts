import { Type } from "@sinclair/typebox";
import type { ChannelAgentTool } from "openclaw/plugin-sdk";

import { getAniRuntime } from "./runtime.js";
import { sendAniMessage, uploadAniFile } from "./monitor/send.js";

/**
 * Agent tool: send_file
 *
 * Lets the LLM create a file (text, markdown, CSV, JSON, etc.) and send it
 * directly to an ANI conversation as an attachment.
 *
 * The LLM provides the file content, filename, and target conversation.
 * The tool writes the content to a buffer, uploads it to the ANI backend,
 * and sends a message with the attachment.
 */
export function createSendFileTool(): ChannelAgentTool {
  return {
    label: "Send File to ANI",
    name: "ani_send_file",
    description: [
      "Create and send a file (document, code, data) to the current ANI conversation.",
      "Use this when the user asks you to generate a file, export data, or create a downloadable document.",
      "Supported formats: .md, .txt, .csv, .json, .py, .js, .html, .xml, .yaml, .sql, and more.",
      "The file will be uploaded and sent as a message attachment the user can download.",
    ].join(" "),
    parameters: Type.Object({
      filename: Type.String({
        description: "Filename with extension, e.g. 'summary.md', 'data.csv', 'report.json'",
      }),
      content: Type.String({
        description: "The full text content of the file to create",
      }),
      caption: Type.Optional(
        Type.String({
          description: "Optional message text to accompany the file (default: empty)",
        }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const params = args as { filename?: string; content?: string; caption?: string };
      const filename = params.filename?.trim();
      const content = params.content ?? "";
      const caption = params.caption?.trim() ?? "";

      if (!filename) {
        return {
          content: [{ type: "text", text: "Error: filename is required" }],
        };
      }

      if (!content) {
        return {
          content: [{ type: "text", text: "Error: file content cannot be empty" }],
        };
      }

      try {
        const core = getAniRuntime();
        const cfg = core.config.loadConfig() as {
          channels?: { ani?: { serverUrl?: string; apiKey?: string } };
        };
        const serverUrl = (cfg.channels?.ani?.serverUrl ?? "").replace(/\/+$/, "");
        const apiKey = cfg.channels?.ani?.apiKey ?? "";

        if (!serverUrl || !apiKey) {
          return {
            content: [{ type: "text", text: "Error: ANI channel not configured (missing serverUrl or apiKey)" }],
          };
        }

        // Determine MIME type from extension
        const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
        const mimeMap: Record<string, string> = {
          ".md": "text/markdown",
          ".txt": "text/plain",
          ".csv": "text/csv",
          ".json": "application/json",
          ".xml": "application/xml",
          ".yaml": "text/yaml",
          ".yml": "text/yaml",
          ".html": "text/html",
          ".css": "text/css",
          ".js": "text/javascript",
          ".ts": "text/typescript",
          ".py": "text/x-python",
          ".go": "text/x-go",
          ".sql": "text/x-sql",
          ".sh": "text/x-shellscript",
          ".log": "text/plain",
          ".toml": "text/toml",
          ".ini": "text/plain",
        };
        const mimeType = mimeMap[ext] ?? "text/plain";

        // Upload file to ANI backend
        const buffer = Buffer.from(content, "utf-8");
        const uploaded = await uploadAniFile({
          serverUrl,
          apiKey,
          buffer,
          filename,
        });

        return {
          content: [
            {
              type: "text",
              text: `File "${filename}" created and uploaded successfully (${buffer.length} bytes). ` +
                `The file is now available at ${uploaded.url}. ` +
                `To send it to the user, include this in your reply:\n` +
                `MEDIA:${serverUrl}${uploaded.url}`,
            },
          ],
          details: {
            filename,
            url: uploaded.url,
            fullUrl: `${serverUrl}${uploaded.url}`,
            size: buffer.length,
            mimeType,
          },
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error sending file: ${err instanceof Error ? err.message : String(err)}` },
          ],
        };
      }
    },
  };
}
