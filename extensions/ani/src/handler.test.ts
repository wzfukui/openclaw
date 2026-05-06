import { describe, it, expect } from "vitest";

import { parseArtifacts, isTextFile } from "./monitor/handler.js";
import { resolveAniMentionsFromText, runWithAniOutboundActivity, sendAniMessage } from "./monitor/send.js";

describe("parseArtifacts", () => {
  it("returns a single text segment when no artifacts present", () => {
    const result = parseArtifacts("Hello, world!");
    expect(result).toHaveLength(1);
    expect(result[0].textBefore).toBe("Hello, world!");
    expect(result[0].artifact).toBeUndefined();
  });

  it("parses a single HTML artifact", () => {
    const input = `Here is a chart:
<artifact type="html" title="My Chart">
<svg viewBox="0 0 100 100"><circle r="50"/></svg>
</artifact>`;
    const result = parseArtifacts(input);
    expect(result).toHaveLength(1);
    expect(result[0].textBefore).toBe("Here is a chart:\n");
    expect(result[0].artifact).toBeDefined();
    expect(result[0].artifact!.artifact_type).toBe("html");
    expect(result[0].artifact!.title).toBe("My Chart");
    expect(result[0].artifact!.source).toContain("<svg");
  });

  it("parses a code artifact with language", () => {
    const input = `<artifact type="code" title="Example" language="python">
print("hello")
</artifact>`;
    const result = parseArtifacts(input);
    expect(result.some((s) => s.artifact?.artifact_type === "code")).toBe(true);
    const codeSeg = result.find((s) => s.artifact);
    expect(codeSeg!.artifact!.language).toBe("python");
    expect(codeSeg!.artifact!.source).toContain('print("hello")');
  });

  it("parses a mermaid artifact", () => {
    const input = `<artifact type="mermaid" title="Flow">
flowchart LR
  A --> B
</artifact>`;
    const result = parseArtifacts(input);
    const seg = result.find((s) => s.artifact);
    expect(seg!.artifact!.artifact_type).toBe("mermaid");
  });

  it("handles text before and after an artifact", () => {
    const input = `Before text.
<artifact type="html" title="Widget">
<div>content</div>
</artifact>
After text.`;
    const result = parseArtifacts(input);
    // Should have: segment with artifact (textBefore = "Before text.\n"), then trailing text segment
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].textBefore).toContain("Before text.");
    expect(result[0].artifact).toBeDefined();
    const last = result[result.length - 1];
    expect(last.textBefore).toContain("After text.");
    expect(last.artifact).toBeUndefined();
  });

  it("handles multiple artifacts", () => {
    const input = `Intro
<artifact type="html" title="A">
<p>first</p>
</artifact>
Middle
<artifact type="code" title="B" language="js">
console.log("hi");
</artifact>
End`;
    const result = parseArtifacts(input);
    const artifacts = result.filter((s) => s.artifact);
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].artifact!.artifact_type).toBe("html");
    expect(artifacts[1].artifact!.artifact_type).toBe("code");
  });

  it("returns empty text segment for empty input", () => {
    const result = parseArtifacts("");
    expect(result).toHaveLength(1);
    expect(result[0].textBefore).toBe("");
    expect(result[0].artifact).toBeUndefined();
  });

  it("maps unknown artifact types to html", () => {
    const input = `<artifact type="custom" title="X">
stuff
</artifact>`;
    const result = parseArtifacts(input);
    const seg = result.find((s) => s.artifact);
    expect(seg!.artifact!.artifact_type).toBe("html");
  });
});

describe("isTextFile", () => {
  it("detects text/* MIME types", () => {
    expect(isTextFile("text/plain")).toBe(true);
    expect(isTextFile("text/html")).toBe(true);
    expect(isTextFile("text/csv")).toBe(true);
  });

  it("detects application/json", () => {
    expect(isTextFile("application/json")).toBe(true);
  });

  it("detects application/xml", () => {
    expect(isTextFile("application/xml")).toBe(true);
  });

  it("detects application/yaml", () => {
    expect(isTextFile("application/yaml")).toBe(true);
  });

  it("rejects binary MIME types", () => {
    expect(isTextFile("application/octet-stream")).toBe(false);
    expect(isTextFile("image/png")).toBe(false);
    expect(isTextFile("audio/mpeg")).toBe(false);
  });

  it("detects text file extensions by filename", () => {
    expect(isTextFile(undefined, "readme.md")).toBe(true);
    expect(isTextFile(undefined, "data.json")).toBe(true);
    expect(isTextFile(undefined, "script.py")).toBe(true);
    expect(isTextFile(undefined, "code.ts")).toBe(true);
    expect(isTextFile(undefined, "main.go")).toBe(true);
    expect(isTextFile(undefined, "query.sql")).toBe(true);
    expect(isTextFile(undefined, "config.yaml")).toBe(true);
    expect(isTextFile(undefined, "config.yml")).toBe(true);
    expect(isTextFile(undefined, "notes.txt")).toBe(true);
    expect(isTextFile(undefined, "run.sh")).toBe(true);
  });

  it("rejects non-text file extensions", () => {
    expect(isTextFile(undefined, "photo.png")).toBe(false);
    expect(isTextFile(undefined, "song.mp3")).toBe(false);
    expect(isTextFile(undefined, "doc.pdf")).toBe(false);
  });

  it("is case-insensitive for extensions", () => {
    // The implementation lowercases the extension
    expect(isTextFile(undefined, "README.MD")).toBe(true);
    expect(isTextFile(undefined, "DATA.JSON")).toBe(true);
  });

  it("returns false when neither mime nor filename given", () => {
    expect(isTextFile()).toBe(false);
    expect(isTextFile(undefined, undefined)).toBe(false);
  });

  it("prefers MIME type when both are provided", () => {
    // text/ MIME should return true even with binary extension
    expect(isTextFile("text/plain", "file.png")).toBe(true);
  });
});

describe("resolveAniMentionsFromText", () => {
  const participants = [
    {
      entity_id: 12,
      role: "member",
      entity: { id: 12, display_name: "Alice", entity_type: "bot" },
    },
    {
      entity_id: 13,
      role: "member",
      entity: { id: 13, display_name: "PotatoWire", name: "bot_potato_wire", entity_type: "bot" },
    },
    {
      entity_id: 3,
      role: "owner",
      entity: { id: 3, display_name: "Kui Fu", entity_type: "user" },
    },
  ];

  it("maps visible ANI group mentions to participant entity ids", () => {
    expect(resolveAniMentionsFromText("@PotatoWire please render this", participants)).toEqual([13]);
  });

  it("uses entity.name as a fallback mention alias", () => {
    expect(resolveAniMentionsFromText("handoff to @bot_potato_wire", participants)).toEqual([13]);
  });

  it("skips the current bot self mention", () => {
    expect(resolveAniMentionsFromText("@Alice ask @PotatoWire", participants, { selfEntityId: 12 })).toEqual([13]);
  });

  it("deduplicates repeated mentions in text", () => {
    expect(resolveAniMentionsFromText("@PotatoWire then @PotatoWire again", participants)).toEqual([13]);
  });
});

describe("runWithAniOutboundActivity", () => {
  it("marks successful non-status ANI sends in the active conversation", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ data: { id: 123 } }), { status: 200 });
    }) as typeof fetch;
    try {
      const { didSend } = await runWithAniOutboundActivity(42, async () => {
        await sendAniMessage({
          serverUrl: "https://agent-native.im",
          apiKey: "aim_test",
          conversationId: 42,
          text: "sent by tool",
        });
      });
      expect(didSend).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not count status-only progress sends as user-visible output", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ data: { id: 123 } }), { status: 200 });
    }) as typeof fetch;
    try {
      const { didSend } = await runWithAniOutboundActivity(42, async () => {
        await sendAniMessage({
          serverUrl: "https://agent-native.im",
          apiKey: "aim_test",
          conversationId: 42,
          text: "",
          statusLayer: { phase: "typing", progress: 0, text: "" },
        });
      });
      expect(didSend).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
