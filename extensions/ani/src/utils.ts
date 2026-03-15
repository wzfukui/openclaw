import { getAniRuntime } from "./runtime.js";

/** Normalize an ANI server URL: trim, remove trailing slashes. */
export function normalizeAniServerUrl(url: string | undefined | null): string {
  return (url ?? "").replace(/\/+$/, "").trim();
}

/**
 * Shared MIME type mapping for common text file extensions.
 * Used by tools.ts (ani_send_file) and handler.ts (attachment processing).
 */
const MIME_MAP: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv",
  ".json": "application/json", ".xml": "application/xml",
  ".yaml": "text/yaml", ".yml": "text/yaml",
  ".html": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".ts": "text/typescript",
  ".py": "text/x-python", ".go": "text/x-go",
  ".sql": "text/x-sql", ".sh": "text/x-shellscript",
  ".log": "text/plain", ".toml": "text/toml", ".ini": "text/plain",
};

/** Get MIME type for a filename based on its extension. Returns "text/plain" as default. */
export function getMimeType(filename: string): string {
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".")).toLowerCase()
    : "";
  return MIME_MAP[ext] ?? "text/plain";
}

/** Resolve ANI serverUrl and apiKey from config. Throws if not configured. */
export function resolveAniCredentials(): { serverUrl: string; apiKey: string } {
  const core = getAniRuntime();
  const cfg = core.config.loadConfig() as { channels?: { ani?: { serverUrl?: string; apiKey?: string } } };
  const serverUrl = normalizeAniServerUrl(cfg.channels?.ani?.serverUrl);
  const apiKey = cfg.channels?.ani?.apiKey ?? "";
  if (!serverUrl || !apiKey) {
    throw new Error("ANI: serverUrl and apiKey required");
  }
  return { serverUrl, apiKey };
}
