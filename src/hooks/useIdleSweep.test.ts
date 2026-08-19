import { describe, expect, it } from "vitest";
import type { Session } from "../types";
import {
  BACKGROUND_TASK_MAX_MS,
  CODEX_IDLE_REMOVE_MS,
  CODEX_STALE_WORKING_IDLE_MS,
  WORKING_STALE_IDLE_MS,
  WORKING_TRANSCRIPT_FRESH_MS,
  expiredBackgroundTaskIds,
  shouldForceIdleStaleWorkingSession,
  shouldRemoveIdleSession,
  workingVerdict,
} from "./useIdleSweep";

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "s1",
    agentType: "codex",
    cwd: "/tmp/project",
    projectKey: "/tmp/project",
    displayName: "project",
    state: "idle",
    messages: [],
    subagents: [],
    pendingPermissions: [],
    lastSeen: Date.now(),
    backgroundTasks: [],
    pet: "calico",
    subagentByPath: {},
    pendingSubagentTypes: [],
    ...overrides,
  };
}

describe("shouldRemoveIdleSession", () => {
  it("removes completed codex sessions after the codex idle TTL even with a probe PID", () => {
    expect(
      shouldRemoveIdleSession(
        session(),
        CODEX_IDLE_REMOVE_MS + 1,
        true,
      ),
    ).toBe(true);
  });

  it("keeps codex sessions that still need user or subagent attention", () => {
    const since = CODEX_IDLE_REMOVE_MS + 1;

    expect(
      shouldRemoveIdleSession(
        session({
          pendingPermissions: [{
            requestId: "r1",
            toolName: "shell_command",
            toolInput: {},
            agentName: "main",
          }],
        }),
        since,
        true,
      ),
    ).toBe(false);
    expect(
      shouldRemoveIdleSession(
        session({
          subagents: [{
            id: "codex-child",
            name: "reviewer",
            shortName: "rev",
            state: "working",
          }],
        }),
        since,
        true,
      ),
    ).toBe(false);
    expect(
      shouldRemoveIdleSession(
        session({ state: "working", currentTool: "exec_command" }),
        since,
        true,
      ),
    ).toBe(false);
  });

  it("keeps claude sessions with a live probe PID on the longer stale window", () => {
    expect(
      shouldRemoveIdleSession(
        session({ agentType: "claude" }),
        31 * 60 * 1000,
        true,
      ),
    ).toBe(false);
  });
});

describe("shouldForceIdleStaleWorkingSession", () => {
  it("settles stale codex working sessions without a completion event", () => {
    expect(
      shouldForceIdleStaleWorkingSession(
        session({ state: "working", currentTool: "exec_command" }),
        CODEX_STALE_WORKING_IDLE_MS + 1,
      ),
    ).toBe(true);
  });

  it("keeps active attention states working", () => {
    const since = CODEX_STALE_WORKING_IDLE_MS + 1;

    expect(
      shouldForceIdleStaleWorkingSession(
        session({
          state: "working",
          pendingPermissions: [{
            requestId: "r1",
            toolName: "shell_command",
            toolInput: {},
            agentName: "main",
          }],
        }),
        since,
      ),
    ).toBe(false);
    expect(
      shouldForceIdleStaleWorkingSession(
        session({
          state: "working",
          subagents: [{
            id: "codex-child",
            name: "reviewer",
            shortName: "rev",
            state: "working",
          }],
        }),
        since,
      ),
    ).toBe(false);
    expect(
      shouldForceIdleStaleWorkingSession(
        session({ agentType: "claude", state: "working" }),
        since,
      ),
    ).toBe(false);
  });
});

// 사고(Musing) 중엔 hook 이벤트가 없다 — transcript(mtime·중단 마커)로
// "일하는 중"과 "Esc 중단/방치"를 구분한다.
describe("workingVerdict", () => {
  const now = 1_000_000_000;

  it("sleeps immediately when the transcript ends with an interrupt marker", () => {
    expect(
      workingVerdict(now, 60_000, { mtime_ms: now - 1_000, interrupted: true }),
    ).toBe("sleep");
  });

  it("keeps working while the transcript is fresh, even long after the last hook event", () => {
    expect(
      workingVerdict(now, 20 * 60 * 1000, {
        mtime_ms: now - (WORKING_TRANSCRIPT_FRESH_MS - 1_000),
        interrupted: false,
      }),
    ).toBe("keep");
  });

  it("keeps working within the safety window when the transcript is quiet", () => {
    expect(
      workingVerdict(now, WORKING_STALE_IDLE_MS - 1_000, {
        mtime_ms: now - 10 * 60 * 1000,
        interrupted: false,
      }),
    ).toBe("keep");
  });

  it("sleeps past the safety window when nothing moves at all", () => {
    expect(
      workingVerdict(now, WORKING_STALE_IDLE_MS + 1_000, {
        mtime_ms: now - 10 * 60 * 1000,
        interrupted: false,
      }),
    ).toBe("sleep");
  });

  it("falls back to the legacy rule when the transcript is unreadable", () => {
    expect(
      workingVerdict(now, 60_000, { mtime_ms: null, interrupted: false }),
    ).toBe("fallback");
  });
});

// 백그라운드 쉘 완료는 transcript에만 남는다 — tail 밖으로 밀려 알림을
// 놓쳐도 뱃지가 영원히 남지 않게 시간 상한을 둔다.
describe("expiredBackgroundTaskIds", () => {
  const now = 1_000_000_000;

  it("expires only the shells past the safety cap", () => {
    const sess = session({
      backgroundTasks: [
        { id: "old", startedAt: now - (BACKGROUND_TASK_MAX_MS + 1_000) },
        { id: "fresh", startedAt: now - 60_000 },
      ],
    });

    expect(expiredBackgroundTaskIds(sess, now)).toEqual(["old"]);
  });

  it("returns nothing when no shell is tracked", () => {
    expect(expiredBackgroundTaskIds(session(), now)).toEqual([]);
  });
});
