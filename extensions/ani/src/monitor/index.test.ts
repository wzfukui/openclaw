import { describe, expect, it } from "vitest";
import { ANI_STALE_SOCKET_TIMEOUT_MS, isAniSocketStale } from "./index.js";

describe("isAniSocketStale", () => {
  it("stays healthy when a pong was received recently", () => {
    expect(
      isAniSocketStale({
        now: ANI_STALE_SOCKET_TIMEOUT_MS - 1,
        lastPongAt: 0,
        lastMessageAt: 0,
      }),
    ).toBe(false);
  });

  it("stays healthy when inbound messages are still flowing", () => {
    expect(
      isAniSocketStale({
        now: ANI_STALE_SOCKET_TIMEOUT_MS + 5000,
        lastPongAt: 0,
        lastMessageAt: ANI_STALE_SOCKET_TIMEOUT_MS,
      }),
    ).toBe(false);
  });

  it("turns stale when both pong and inbound activity are too old", () => {
    expect(
      isAniSocketStale({
        now: ANI_STALE_SOCKET_TIMEOUT_MS + 1,
        lastPongAt: 0,
        lastMessageAt: 0,
      }),
    ).toBe(true);
  });
});
