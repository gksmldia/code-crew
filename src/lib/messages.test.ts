import { describe, expect, it } from "vitest";
import { messageFromTool } from "./messages";

describe("messageFromTool", () => {
  it("Read with file_path", () => {
    const m = messageFromTool("Read", { file_path: "/x/player.rs" });
    expect(m.toolEmoji).toBe("📖");
    expect(m.text).toContain("player.rs");
  });

  it("Bash with command", () => {
    const m = messageFromTool("Bash", { command: "npm test" });
    expect(m.toolEmoji).toBe("⚡");
    expect(m.text).toContain("npm test");
  });

  it("Edit with file_path", () => {
    const m = messageFromTool("Edit", { file_path: "/x/foo.ts" });
    expect(m.toolEmoji).toBe("✍️");
    expect(m.text).toContain("foo.ts");
  });

  it("Grep with pattern", () => {
    const m = messageFromTool("Grep", { pattern: "velocity" });
    expect(m.toolEmoji).toBe("🔍");
    expect(m.text).toContain("velocity");
  });

  it("WebFetch with url", () => {
    const m = messageFromTool("WebFetch", { url: "https://example.com/foo" });
    expect(m.toolEmoji).toBe("🌐");
    expect(m.text).toContain("example.com");
  });

  it("Task with subagent_type and prompt", () => {
    const m = messageFromTool("Task", {
      subagent_type: "Charles - Team Leader",
      prompt: "design login flow",
    });
    expect(m.toolEmoji).toBe("🤝");
    expect(m.text).toContain("Charles");
  });

  it("unknown tool returns generic", () => {
    const m = messageFromTool("FrobnicateXYZ", {});
    expect(m.toolEmoji).toBe("⚙️");
    expect(m.text).toContain("FrobnicateXYZ");
  });

  it("truncates long text", () => {
    const m = messageFromTool("Bash", { command: "x".repeat(500) });
    expect(m.text.length).toBeLessThanOrEqual(80);
  });
});
