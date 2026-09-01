import { describe, expect, it } from "vitest";
import { cardRowWindowWidth } from "./windowSize";

describe("cardRowWindowWidth", () => {
  it("fits two cards with one gap and horizontal padding", () => {
    expect(cardRowWindowWidth([200, 200], 12, 12, 12)).toBe(436);
  });

  it("keeps the minimum window width for zero or one card", () => {
    expect(cardRowWindowWidth([], 12, 12, 12)).toBe(240);
    expect(cardRowWindowWidth([200], 12, 12, 12)).toBe(240);
  });
});
