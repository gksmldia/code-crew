import { describe, expect, it } from "vitest";
import { mapSessionToPetState, RELIEVED_WINDOW_MS } from "./petState";

describe("mapSessionToPetState", () => {
  const now = 1_000_000;

  it("working → typing", () => {
    expect(mapSessionToPetState("working", undefined, now)).toBe("typing");
  });

  it("permission → surprised", () => {
    expect(mapSessionToPetState("permission", undefined, now)).toBe("surprised");
  });

  it("error → disappointed", () => {
    expect(mapSessionToPetState("error", undefined, now)).toBe("disappointed");
  });

  it("idle with no justFinishedAt → sleeping", () => {
    expect(mapSessionToPetState("idle", undefined, now)).toBe("sleeping");
  });

  it("idle with recent justFinishedAt → relieved", () => {
    expect(mapSessionToPetState("idle", now - 1000, now)).toBe("relieved");
  });

  it("idle with stale justFinishedAt (> window) → sleeping", () => {
    expect(
      mapSessionToPetState("idle", now - RELIEVED_WINDOW_MS - 1, now),
    ).toBe("sleeping");
  });

  it("idle at exact window boundary → still relieved (inclusive)", () => {
    expect(
      mapSessionToPetState("idle", now - RELIEVED_WINDOW_MS, now),
    ).toBe("relieved");
  });
});
