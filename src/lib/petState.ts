import type { PetState, SessionState } from "../types";

export const RELIEVED_WINDOW_MS = 3000;

export function mapSessionToPetState(
  state: SessionState,
  justFinishedAt: number | undefined,
  now: number,
): PetState {
  switch (state) {
    case "working":
      return "typing";
    case "permission":
      return "surprised";
    case "error":
      return "disappointed";
    case "idle":
      if (justFinishedAt != null && now - justFinishedAt <= RELIEVED_WINDOW_MS) {
        return "relieved";
      }
      return "sleeping";
  }
}
