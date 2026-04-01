import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "./sdk-compat.js";
import {
  normalizeAniTarget,
  parseConversationId,
  resolveAniOutboundSessionRoute,
} from "./outbound.js";

describe("parseConversationId", () => {
  it("parses a plain numeric string", () => {
    expect(parseConversationId("123")).toBe(123);
  });

  it("parses ani:conv:123 format", () => {
    expect(parseConversationId("ani:conv:123")).toBe(123);
  });

  it("parses ANI:conv:456 (case-insensitive prefix)", () => {
    expect(parseConversationId("ANI:conv:456")).toBe(456);
  });

  it("parses ani:channel:789 format", () => {
    expect(parseConversationId("ani:channel:789")).toBe(789);
  });

  it("parses ani:conversation:321 format", () => {
    expect(parseConversationId("ani:conversation:321")).toBe(321);
  });

  it("strips whitespace around the number", () => {
    expect(parseConversationId("  42  ")).toBe(42);
  });

  it("throws on empty string", () => {
    expect(() => parseConversationId("")).toThrow("invalid conversation target");
  });

  it("throws on non-numeric string", () => {
    expect(() => parseConversationId("abc")).toThrow("invalid conversation target");
  });

  it("throws on zero", () => {
    expect(() => parseConversationId("0")).toThrow("invalid conversation target");
  });

  it("throws on negative numbers", () => {
    expect(() => parseConversationId("-5")).toThrow("invalid conversation target");
  });

  it("throws on floating point", () => {
    expect(() => parseConversationId("3.14")).toThrow("invalid conversation target");
  });
});

describe("normalizeAniTarget", () => {
  it("normalizes shorthand conversation targets", () => {
    expect(normalizeAniTarget("ani:conv:123")).toBe("ani:conversation:123");
    expect(normalizeAniTarget("123")).toBe("ani:conversation:123");
  });

  it("returns null for invalid targets", () => {
    expect(normalizeAniTarget("")).toBeNull();
    expect(normalizeAniTarget("abc")).toBeNull();
  });
});

describe("resolveAniOutboundSessionRoute", () => {
  const cfg: OpenClawConfig = {
    session: {
      dmScope: "main",
    },
  };

  it("builds a stable outbound route for ANI conversation ids", () => {
    const route = resolveAniOutboundSessionRoute({
      cfg,
      agentId: "ani-agent",
      accountId: "default",
      target: "ani:conv:8829587447915732",
    });

    expect(route).toMatchObject({
      chatType: "channel",
      from: "ani:conversation:8829587447915732",
      to: "ani:conversation:8829587447915732",
      peer: { kind: "channel", id: "8829587447915732" },
    });
    expect(route?.sessionKey).toContain(":ani:channel:8829587447915732");
  });

  it("preserves direct routes when target resolution says the target is a user", () => {
    const route = resolveAniOutboundSessionRoute({
      cfg,
      agentId: "ani-agent",
      accountId: "default",
      target: "ani:conversation:42",
      resolvedTarget: {
        to: "ani:conversation:42",
        kind: "user",
        source: "normalized",
      },
    });

    expect(route).toMatchObject({
      chatType: "direct",
      peer: { kind: "direct", id: "42" },
    });
    expect(route?.sessionKey).toBe("agent:ani-agent:main");
    expect(route?.baseSessionKey).toBe("agent:ani-agent:main");
  });

  it("uses scoped direct session keys when dmScope requires per-peer routing", () => {
    const route = resolveAniOutboundSessionRoute({
      cfg: {
        session: {
          dmScope: "per-channel-peer",
        },
      } as OpenClawConfig,
      agentId: "ani-agent",
      accountId: "default",
      target: "ani:conversation:42",
      resolvedTarget: {
        to: "ani:conversation:42",
        kind: "user",
        source: "normalized",
      },
    });

    expect(route).toMatchObject({
      chatType: "direct",
      peer: { kind: "direct", id: "42" },
    });
    expect(route?.sessionKey).toContain(":ani:direct:42");
  });
});
