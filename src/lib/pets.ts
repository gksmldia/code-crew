import type { PetType } from "../types";
import { BREEDS } from "../assets/breeds";

const POOL: string[] = BREEDS.map((b) => b.id);

export function petForSession(sessionId: string): PetType {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) {
    h = (h * 31 + sessionId.charCodeAt(i)) | 0;
  }
  return POOL[Math.abs(h) % POOL.length];
}

export function petForAgent(name: string): PetType {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 33 + name.charCodeAt(i)) | 0;
  }
  return POOL[Math.abs(h) % POOL.length];
}

export function shortNameOf(fullName: string): string {
  const trimmed = fullName.trim();
  const parts = trimmed.split(" - ");
  return parts[0].trim();
}

const SESSION_NAMES = [
  "Alice", "Brian", "Charles", "Daniel", "Emma",
  "Felix", "Grace", "Henry", "Ivy", "Jack",
  "Kate", "Leo", "Maya", "Noah", "Olivia",
  "Paul", "Quinn", "Rose", "Sam", "Tara",
  "Uma", "Victor", "Wendy", "Xavier", "Yuki",
  "Zoe", "Aria", "Blake", "Cora", "Drew",
];

export function nameForSession(sessionId: string): string {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) {
    h = (h * 33 + sessionId.charCodeAt(i)) | 0;
  }
  return SESSION_NAMES[Math.abs(h) % SESSION_NAMES.length];
}
