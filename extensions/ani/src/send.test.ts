import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPendingAniMessages, sendAniMessage } from "./monitor/send.js";

const originalHome = process.env.HOME;
const pendingFile = (home: string) =>
  path.join(home, ".openclaw", "channels", "ani", "pending-outbound.json");

function mockResponse(params: {
  status: number;
  text?: string;
  json?: unknown;
  headers?: Record<string, string>;
}): Response {
  const body = { cancel: vi.fn(async () => {}) };
  const headers = new Headers(params.headers);
  return {
    ok: params.status >= 200 && params.status < 300,
    status: params.status,
    statusText: "",
    headers,
    body,
    text: vi.fn(async () => params.text ?? ""),
    json: vi.fn(async () => params.json ?? {}),
  } as unknown as Response;
}

describe("ANI outbound reliability", () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ani-send-test-"));
    process.env.HOME = homeDir;
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("queues retryable send failures to disk", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse({ status: 502, text: "bad gateway" })),
    );

    const result = await sendAniMessage({
      serverUrl: "https://agent-native.im",
      apiKey: "aim_test",
      conversationId: 42,
      text: "hello world",
      accountId: "default",
    });

    expect(result.queued).toBe(true);
    const queued = JSON.parse(await fs.readFile(pendingFile(homeDir), "utf-8")) as Array<
      Record<string, unknown>
    >;
    expect(queued).toHaveLength(1);
    expect(queued[0].conversationId).toBe(42);
    expect(queued[0].text).toBe("hello world");
  });

  it("does not queue non-retryable client errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse({ status: 400, text: "bad request" })),
    );

    await expect(
      sendAniMessage({
        serverUrl: "https://agent-native.im",
        apiKey: "aim_test",
        conversationId: 42,
        text: "hello world",
        accountId: "default",
      }),
    ).rejects.toThrow("ANI send failed (400)");

    await expect(fs.readFile(pendingFile(homeDir), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("flushes queued messages after connectivity recovers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse({ status: 502, text: "bad gateway" })),
    );

    await sendAniMessage({
      serverUrl: "https://agent-native.im",
      apiKey: "aim_test",
      conversationId: 88,
      text: "replay me",
      accountId: "default",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => mockResponse({ status: 200, json: { data: { id: 1234 } } })),
    );

    await flushPendingAniMessages({
      serverUrl: "https://agent-native.im",
      apiKey: "aim_test",
      accountId: "default",
    });

    await expect(fs.readFile(pendingFile(homeDir), "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
