import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";
import { useStore } from "../store";

const SWEEP_MS = 5 * 1000;
const DEAD_PROCESS_GRACE_MS = 3 * 1000;
const STALE_REMOVE_MS = 30 * 60 * 1000;
export const CODEX_IDLE_REMOVE_MS = 5 * 60 * 1000;
export const CODEX_STALE_WORKING_IDLE_MS = 90 * 1000;

export function shouldForceIdleStaleWorkingSession(sess: Session, since: number) {
  return (
    sess.agentType === "codex" &&
    sess.state === "working" &&
    sess.pendingPermissions.length === 0 &&
    sess.subagents.length === 0 &&
    since > CODEX_STALE_WORKING_IDLE_MS
  );
}

export function shouldRemoveIdleSession(
  sess: Session,
  since: number,
  hasProbePid: boolean,
) {
  if (
    sess.agentType === "codex" &&
    sess.state === "idle" &&
    sess.pendingPermissions.length === 0 &&
    sess.subagents.length === 0 &&
    !sess.currentTool &&
    since > CODEX_IDLE_REMOVE_MS
  ) {
    return true;
  }

  return !hasProbePid && sess.state === "idle" && since > STALE_REMOVE_MS;
}

export function useIdleSweep() {
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const { sessions, setIdle, removeSession } = useStore.getState();
      for (const [sid, sess] of Object.entries(sessions)) {
        const since = now - sess.lastSeen;
        const probePid = sess.pidChain?.[0] ?? sess.sourcePid;
        if (probePid && since > DEAD_PROCESS_GRACE_MS) {
          void invoke<boolean>("is_process_alive", { pid: probePid })
            .then((alive) => {
              if (!alive) removeSession(sid);
            })
            .catch(() => {});
        }
        // STALE_REMOVE_MS는 PID 추적이 불가능한 세션(복원분/lsof 실패)에만 적용.
        // PID가 있으면 위 is_process_alive가 사망 시 정리하므로, 살아있는 채로
        // 오래 idle한 세션이 카드에서 사라지지 않게 한다.
        if (shouldRemoveIdleSession(sess, since, Boolean(probePid))) {
          removeSession(sid);
        } else {
          setIdle(sid, shouldForceIdleStaleWorkingSession(sess, since));
        }
      }
    }, SWEEP_MS);
    return () => clearInterval(t);
  }, []);
}
