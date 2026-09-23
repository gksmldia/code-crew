import { describe, expect, it } from "vitest";
import { formatSessionInfo } from "./sessionInfo";

describe("formatSessionInfo", () => {
  it("matches Claude Code /status layout", () => {
    expect(formatSessionInfo("27792811-9f15-4564-b244-54eec66d06e5", "Gut-621 pristinevalleygc site code")).toBe(
      "Session name:   Gut-621 pristinevalleygc site code\nSession ID:     27792811-9f15-4564-b244-54eec66d06e5",
    );
  });

  it("copies only the ID when there is no title", () => {
    expect(formatSessionInfo("01a0ccf2-2759-74d3-9baf-84e58085fa79")).toBe(
      "Session ID:     01a0ccf2-2759-74d3-9baf-84e58085fa79",
    );
    expect(formatSessionInfo("abc", "  ")).toBe("Session ID:     abc");
  });
});
