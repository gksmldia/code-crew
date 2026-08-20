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

  // 백그라운드로 넘긴 일을 기다리는 구간 — 자는 게 아니라 대기.
  it("idle with background work → waiting", () => {
    expect(mapSessionToPetState("idle", undefined, now, true)).toBe("waiting");
  });

  it("idle with background work but still in relieved window → relieved", () => {
    expect(mapSessionToPetState("idle", now - 1000, now, true)).toBe("relieved");
  });

  it("idle with background work after relieved window → waiting", () => {
    expect(
      mapSessionToPetState("idle", now - RELIEVED_WINDOW_MS - 1, now, true),
    ).toBe("waiting");
  });

  it("working with background work → typing (메인이 일하면 대기가 아니다)", () => {
    expect(mapSessionToPetState("working", undefined, now, true)).toBe("typing");
  });

  it("permission with background work → surprised (물어보는 게 우선)", () => {
    expect(mapSessionToPetState("permission", undefined, now, true)).toBe("surprised");
  });
});
