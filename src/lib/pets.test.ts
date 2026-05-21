import { describe, expect, it } from "vitest";
import { petForAgent, petForSession, shortNameOf, nameForSession } from "./pets";
import { BREED_BY_ID, BREEDS } from "../assets/breeds";

describe("petForAgent", () => {
  it("is deterministic for the same name", () => {
    expect(petForAgent("Finn")).toBe(petForAgent("Finn"));
    expect(petForAgent("Charles")).toBe(petForAgent("Charles"));
  });

  it("returns a known breed id", () => {
    expect(BREED_BY_ID[petForAgent("main")]).toBeDefined();
  });

  it("treats different names as independent (most pairs differ)", () => {
    const names = ["main", "Finn", "Charles", "Brian", "Alice", "Daniel"];
    const pets = new Set(names.map(petForAgent));
    expect(pets.size).toBeGreaterThan(1);
  });
});

describe("petForSession", () => {
  it("is deterministic for the same session id", () => {
    const id = "abc-123";
    expect(petForSession(id)).toBe(petForSession(id));
  });

  it("returns a known breed id", () => {
    expect(BREED_BY_ID[petForSession("session-1")]).toBeDefined();
  });
});

describe("breed catalog", () => {
  it("has exactly 20 breeds", () => {
    expect(BREEDS.length).toBe(20);
  });

  it("breed ids are unique", () => {
    const ids = BREEDS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has Golden Retriever and French Bulldog", () => {
    const ids = BREEDS.map((b) => b.id);
    expect(ids).toContain("golden_retriever");
    expect(ids).toContain("french_bulldog");
  });
});

describe("shortNameOf", () => {
  it("'Charles - Team Leader' → 'Charles'", () =>
    expect(shortNameOf("Charles - Team Leader")).toBe("Charles"));
  it("'Finn - Frontend Developer' → 'Finn'", () =>
    expect(shortNameOf("Finn - Frontend Developer")).toBe("Finn"));
  it("'explorer' → 'explorer'", () =>
    expect(shortNameOf("explorer")).toBe("explorer"));
  it("'  spaces  ' → 'spaces' (trim)", () =>
    expect(shortNameOf("  spaces  ")).toBe("spaces"));
});

describe("nameForSession", () => {
  it("is deterministic", () => {
    expect(nameForSession("xyz")).toBe(nameForSession("xyz"));
  });
});
