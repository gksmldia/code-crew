import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";

const SWEEP_MS = 5 * 1000;
const DEAD_PROCESS_GRACE_MS = 3 * 1000;
const STALE_REMOVE_MS = 30 * 60 * 1000;

export function useIdleSweep() {
  const setIdle = useStore((s) => s.setIdle);
  const removeSession = useStore((s) => s.removeSession);
  const sessions = useStore((s) => s.sessions);
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
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
        if (!probePid && sess.state === "idle" && since > STALE_REMOVE_MS) {
          removeSession(sid);
        } else {
          setIdle(sid);
        }
      }
    }, SWEEP_MS);
    return () => clearInterval(t);
  }, [sessions, setIdle, removeSession]);
}
