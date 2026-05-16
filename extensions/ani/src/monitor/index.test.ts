import { describe, expect, it } from "vitest";
import { ANI_EXTENSION_NAME, ANI_EXTENSION_VERSION } from "../version.js";
import { buildAniWebSocketUrl } from "./index.js";

describe("buildAniWebSocketUrl", () => {
  it("adds device_info to the ANI WebSocket URL", () => {
    const wsUrl = buildAniWebSocketUrl({
      serverUrl: "https://ani.example.test",
      clientVersion: "2026.3.24",
    });

    const parsed = new URL(wsUrl);
    expect(parsed.protocol).toBe("wss:");
    expect(parsed.host).toBe("ani.example.test");
    expect(parsed.pathname).toBe("/api/v1/ws");

    const deviceInfo = JSON.parse(parsed.searchParams.get("device_info") ?? "null");
    expect(deviceInfo).toEqual({
      client: "openclaw",
      client_version: "2026.3.24",
      runtime: "node",
      runtime_version: process.versions.node,
      extension: ANI_EXTENSION_NAME,
      extension_version: ANI_EXTENSION_VERSION,
    });
  });
});
