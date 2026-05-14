import { useEffect } from "react";
import { useStore } from "../store";

const SWEEP_MS = 30 * 1000;
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
        if (sess.state === "idle" && since > STALE_REMOVE_MS) {
          removeSession(sid);
        } else {
          setIdle(sid);
        }
      }
    }, SWEEP_MS);
    return () => clearInterval(t);
  }, [sessions, setIdle, removeSession]);
}
