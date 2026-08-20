import type { PetState, SessionState } from "../types";

export const RELIEVED_WINDOW_MS = 3000;

export function mapSessionToPetState(
  state: SessionState,
  justFinishedAt: number | undefined,
  now: number,
  hasBackgroundWork = false,
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
      // 메인은 턴을 끝냈지만 백그라운드로 넘긴 일(백그라운드 에이전트·코덱스
      // 호출 등)이 남아 있으면 자는 게 아니라 결과를 기다리는 중이다.
      if (hasBackgroundWork) return "waiting";
      return "sleeping";
  }
}
