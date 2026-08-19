import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";
import { useStore } from "../store";

const SWEEP_MS = 5 * 1000;
const DEAD_PROCESS_GRACE_MS = 3 * 1000;
const STALE_REMOVE_MS = 30 * 60 * 1000;
export const CODEX_IDLE_REMOVE_MS = 5 * 60 * 1000;
export const CODEX_STALE_WORKING_IDLE_MS = 90 * 1000;
// 사고(Musing) 중엔 hook 이벤트가 없어 lastSeen이 멈춘다. transcript가
// 이만큼 최근에 갱신됐으면 아직 생성 중으로 보고 working을 유지한다.
export const WORKING_TRANSCRIPT_FRESH_MS = 5 * 60 * 1000;
// transcript마저 조용할 때의 안전망 — 이 시간이 지나면 재운다.
export const WORKING_STALE_IDLE_MS = 30 * 60 * 1000;
// 이벤트가 방금 온 세션은 transcript를 볼 필요가 없다(경합 방지 겸 IO 절약).
const WORKING_CHECK_MIN_SILENCE_MS = 15 * 1000;
// 백그라운드 쉘 추적의 안전망 — 완료 알림을 놓쳐도(tail 밖으로 밀려남 등)
// 뱃지가 영원히 남지 않게 한다. 오래 도는 개발 서버까지 감안해 넉넉히 잡는다.
export const BACKGROUND_TASK_MAX_MS = 60 * 60 * 1000;

/// src-tauri transcript_status 커맨드의 응답 형태.
export type TranscriptStatus = {
  mtime_ms: number | null;
  interrupted: boolean;
  finished_background_tasks: string[];
};

/// 상한을 넘긴 백그라운드 쉘 ID. transcript 신호를 놓쳤을 때의 정리용.
export function expiredBackgroundTaskIds(sess: Session, now: number): string[] {
  return sess.backgroundTasks
    .filter((t) => now - t.startedAt > BACKGROUND_TASK_MAX_MS)
    .map((t) => t.id);
}

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

// working 세션의 transcript 기반 판정.
// "sleep" = 강제 idle, "keep" = working 유지, "fallback" = 기존 5분 규칙 적용
export function workingVerdict(
  now: number,
  since: number,
  st: Pick<TranscriptStatus, "mtime_ms" | "interrupted">,
): "sleep" | "keep" | "fallback" {
  // Esc 중단은 Stop hook이 발화되지 않는 CC 스펙 — transcript의 중단
  // 마커가 유일한 신호다. 감지 즉시 재운다.
  if (st.interrupted) return "sleep";
  if (st.mtime_ms == null) return "fallback";
  if (now - st.mtime_ms < WORKING_TRANSCRIPT_FRESH_MS) return "keep";
  return since > WORKING_STALE_IDLE_MS ? "sleep" : "keep";
}

export function useIdleSweep() {
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const { sessions, setIdle, removeSession, clearBackgroundTasks } = useStore.getState();
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
          continue;
        }
        // Claude가 도구 없이 사고만 하는 동안엔 hook 이벤트가 전혀 없어
        // lastSeen만으로는 "일하는 중"과 "Esc 중단/방치"를 구분할 수 없다.
        // working 세션은 transcript(mtime·중단 마커)로 판정한다.
        const tpath = sess.mainTranscriptPath;
        const wantsWorkingVerdict =
          sess.agentType !== "codex" &&
          sess.state === "working" &&
          Boolean(tpath) &&
          since > WORKING_CHECK_MIN_SILENCE_MS;
        // 백그라운드 쉘은 턴이 끝난 뒤에도 돌기 때문에 상태와 무관하게 확인한다.
        const wantsBackgroundSweep = sess.backgroundTasks.length > 0;
        if (wantsBackgroundSweep) {
          clearBackgroundTasks(sid, expiredBackgroundTaskIds(sess, now));
        }
        if (!wantsWorkingVerdict) {
          setIdle(sid, shouldForceIdleStaleWorkingSession(sess, since));
        }
        if (!tpath || (!wantsWorkingVerdict && !wantsBackgroundSweep)) continue;

        const seenAtProbe = sess.lastSeen;
        void invoke<TranscriptStatus>("transcript_status", { path: tpath })
          .then((st) => {
            if (wantsBackgroundSweep) {
              clearBackgroundTasks(sid, st.finished_background_tasks);
            }
            if (!wantsWorkingVerdict) return;
            // 판정하는 사이 새 이벤트가 도착했으면 결과를 버린다.
            const cur = useStore.getState().sessions[sid];
            if (!cur || cur.state !== "working" || cur.lastSeen !== seenAtProbe) return;
            const v = workingVerdict(Date.now(), Date.now() - seenAtProbe, st);
            if (v === "sleep") setIdle(sid, true);
            else if (v === "fallback") setIdle(sid, false);
          })
          .catch(() => {
            if (wantsWorkingVerdict) setIdle(sid, false);
          });
      }
    }, SWEEP_MS);
    return () => clearInterval(t);
  }, []);
}
