import { describe, expect, it } from "vitest";
import { rowContentWidth } from "./windowSize";

describe("rowContentWidth", () => {
  it("sums widths, gaps and horizontal padding", () => {
    expect(rowContentWidth([200, 200], 12, 12, 12)).toBe(436);
  });

  it("has no gap for zero or one element", () => {
    expect(rowContentWidth([], 12, 12, 12)).toBe(24);
    expect(rowContentWidth([200], 12, 12, 12)).toBe(224);
  });

  it("rounds subpixel widths up so content never overflows", () => {
    expect(rowContentWidth([200.4], 0, 0, 0)).toBe(201);
  });
});
