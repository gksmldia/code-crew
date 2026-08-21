import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "./store";

function resetStore() {
  useStore.setState({ sessions: {}, sessionOrder: [] });
}

describe("store event ordering", () => {
  beforeEach(() => {
    resetStore();
  });

  it("does not downgrade a working session when SessionStart arrives late", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({
      kind: "UserPromptSubmit",
      session_id: "s1",
      cwd: "C:\\work\\code-crew",
    });
    expect(useStore.getState().sessions.s1.state).toBe("working");

    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "C:\\work\\code-crew",
      agent_type: "claude",
      source_pid: 123,
      pid_chain: [123, 456],
    });

    const session = useStore.getState().sessions.s1;
    expect(session.state).toBe("working");
    expect(session.sourcePid).toBe(123);
    expect(session.pidChain).toEqual([123, 456]);
  });
});

// Reproduction tests for the bug "subagent 모드에서 질문/권한 카드 내용이
//안 뜬다." Each test asserts the *intended* behaviour and is expected to
// FAIL against the current code — that's how we pin the root cause down.
describe("concurrent permission requests in subagent mode", () => {
  beforeEach(() => {
    resetStore();
  });

  function bootTeam() {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    applyEvent({
      kind: "SubagentStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "sub-A",
      subagent_type: "alpha",
      transcript_path: "/tmp/sub-A.jsonl",
    });
    applyEvent({
      kind: "SubagentStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "sub-B",
      subagent_type: "bravo",
      transcript_path: "/tmp/sub-B.jsonl",
    });
  }

  it("keeps both permission requests reachable when two subagents fire concurrently", () => {
    const { applyEvent } = useStore.getState();
    bootTeam();

    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "echo A" },
      request_id: "req-A",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "echo B" },
      request_id: "req-B",
    });

    const sess = useStore.getState().sessions.s1;
    // The widget can only answer requests it can find in the store. Today
    // sess.pendingPermission is a single slot, so req-A is dropped — the
    // hook process for req-A then blocks for 600s with no widget UI, and
    // the user reports "카드에 내용이 안 뜬다." Once we move to a queue,
    // both ids must be present.
    const ids = pendingIds(sess);
    expect(ids).toContain("req-A");
    expect(ids).toContain("req-B");
  });

  it("does not drop a pending permission when an unrelated PreToolUse arrives", () => {
    const { applyEvent } = useStore.getState();
    bootTeam();

    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "echo A" },
      request_id: "req-A",
    });

    // Subagent B fires a safe-tool PreToolUse (e.g. Read) while A is still
    // blocked on permission. Today this nukes sess.pendingPermission and A
    // disappears from the card even though its hook is still parked on the
    // server's long-poll.
    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
      transcript_path: "/tmp/sub-B.jsonl",
      agent_name: "bravo",
    });

    const sess = useStore.getState().sessions.s1;
    expect(pendingIds(sess)).toContain("req-A");
  });

  it("labels the permission with the subagent that asked for it", () => {
    const { applyEvent } = useStore.getState();
    bootTeam();

    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "echo A" },
      request_id: "req-A",
      agent_name: "alpha",
    });

    const sess = useStore.getState().sessions.s1;
    const msg = sess.messages.find((m) => m.kind === "permission");
    expect(msg?.agentName).toBe("alpha");
  });
});

describe("terminal-answered questions", () => {
  beforeEach(() => {
    resetStore();
  });

  it("clears AskUserQuestion prompts when the turn stops", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Proceed?",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
      request_id: "question-1",
    });

    expect(pendingIds(useStore.getState().sessions.s1)).toContain("question-1");

    applyEvent({
      kind: "Stop",
      session_id: "s1",
      cwd: "/tmp/proj",
    });

    const sess = useStore.getState().sessions.s1;
    expect(pendingIds(sess)).not.toContain("question-1");
    expect(sess.state).toBe("idle");
  });

  // NOTE: "main 권한 배너는 Stop을 넘겨 유지" 스펙은 폐기됨 — main 요청이
  // 미응답이면 턴이 끝날 수 없으므로, Stop 시 정리한다. 새 스펙 테스트는
  // "Stop clears zombie main permissions answered in the native UI" 참고.

  it("clears a stale AskUserQuestion banner when the agent runs the next tool", () => {
    // The user answers in the TUI and Claude keeps working mid-turn. There is
    // no "answered" hook to listen for and Stop is many tool calls away — so
    // the next tool call from the same agent (which can only happen once the
    // blocking question was answered) must drop the now-answered banner.
    const { applyEvent } = useStore.getState();

    applyEvent({ kind: "SessionStart", session_id: "s1", cwd: "/tmp/proj", agent_type: "claude" });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] }] },
      request_id: "question-1",
    });
    expect(pendingIds(useStore.getState().sessions.s1)).toContain("question-1");

    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
    });

    const sess = useStore.getState().sessions.s1;
    expect(pendingIds(sess)).not.toContain("question-1");
    expect(sess.state).toBe("working");
  });

  it("clears a stale AskUserQuestion banner when the next tool completes", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({ kind: "SessionStart", session_id: "s1", cwd: "/tmp/proj", agent_type: "claude" });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
      request_id: "question-1",
    });

    applyEvent({
      kind: "PostToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      success: true,
    });

    expect(pendingIds(useStore.getState().sessions.s1)).not.toContain("question-1");
  });

  it("keeps the main agent's question pending when a subagent runs a tool", () => {
    // A concurrent subagent's tool call is NOT proof the main agent's question
    // was answered — the main agent is still blocked on it. Clearing must be
    // scoped to the agent that owns the question.
    const { applyEvent } = useStore.getState();

    applyEvent({ kind: "SessionStart", session_id: "s1", cwd: "/tmp/proj", agent_type: "claude" });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
      request_id: "question-1",
    });

    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      agent_name: "Charles - Team Leader",
    });

    expect(pendingIds(useStore.getState().sessions.s1)).toContain("question-1");
  });

  it("clears a subagent's AskUserQuestion banner when that subagent runs the next tool", () => {
    // 서브에이전트가 물어본 질문: PreToolUse엔 서브에이전트 라벨이 있지만
    // 뒤따르는 PermissionRequest엔 agent 정보가 없다(Claude Code가 permission
    // hook엔 agent_type를 안 실어줌). 배너가 "main"으로 오분류되면 그 서브에이전트가
    // 작업을 이어가도 clearAnsweredQuestions가 매칭되지 않아 배너가 안 지워진다.
    const { applyEvent } = useStore.getState();

    applyEvent({ kind: "SessionStart", session_id: "s1", cwd: "/tmp/proj", agent_type: "claude" });
    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
      agent_name: "Brian",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] },
      request_id: "question-1",
    });
    expect(pendingIds(useStore.getState().sessions.s1)).toContain("question-1");

    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      agent_name: "Brian",
    });

    expect(pendingIds(useStore.getState().sessions.s1)).not.toContain("question-1");
  });
});

describe("terminal-answered tool permissions", () => {
  beforeEach(() => {
    resetStore();
  });

  it("clears a matching permission when the tool starts after terminal approval", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/a.ts" },
      request_id: "edit-1",
    });

    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/a.ts" },
    });

    const sess = useStore.getState().sessions.s1;
    expect(pendingIds(sess)).not.toContain("edit-1");
    expect(sess.state).toBe("working");
  });

  it("keeps a synthesized Codex permission working after resolution until Stop", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "codex",
    });
    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "exec",
      tool_input: "const r = await tools.exec_command({...});",
      agent_type: "codex",
    });

    const permission = {
      kind: "PermissionRequest" as const,
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "exec_command",
      tool_input: {
        cmd: "mkdir -p /tmp/x",
        sandbox_permissions: "require_escalated",
      },
      request_id: "codex-call-1",
      agent_type: "codex" as const,
    };
    applyEvent(permission);
    applyEvent(permission);

    const sess = useStore.getState().sessions.s1;
    expect(sess.currentTool).toBe("exec");
    expect(pendingIds(sess)).toEqual(["codex-call-1"]);
    expect(sess.messages.filter((m) => m.kind === "permission")).toHaveLength(1);
    expect(sess.state).toBe("permission");

    applyEvent({
      kind: "PostToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "custom_tool_call",
      success: true,
      agent_type: "codex",
    });
    applyEvent({
      kind: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "codex",
    });
    applyEvent({ kind: "PermissionCancel", request_id: "codex-call-1" });

    const resolved = useStore.getState().sessions.s1;
    expect(resolved.currentTool).toBeUndefined();
    expect(pendingIds(resolved)).toEqual([]);
    expect(resolved.state).toBe("working");

    applyEvent({ kind: "Stop", session_id: "s1", cwd: "/tmp/proj", agent_type: "codex" });
    expect(useStore.getState().sessions.s1.state).toBe("idle");
  });

  it("keeps Codex working when the widget acknowledges the last permission", () => {
    const { applyEvent, acknowledgePermission } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "codex",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "exec_command",
      tool_input: { cmd: "git status" },
      request_id: "codex-call-1",
      agent_type: "codex",
    });

    acknowledgePermission("s1", "codex-call-1");

    const resolved = useStore.getState().sessions.s1;
    expect(pendingIds(resolved)).toEqual([]);
    expect(resolved.state).toBe("working");
  });

  it("keeps unrelated permissions when a different tool starts", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/a.ts" },
      request_id: "edit-1",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      request_id: "bash-1",
    });

    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/a.ts" },
    });

    const sess = useStore.getState().sessions.s1;
    expect(pendingIds(sess)).not.toContain("edit-1");
    expect(pendingIds(sess)).toContain("bash-1");
    expect(sess.state).toBe("permission");
  });

  it("clears a matching permission when only the tool completion is observed", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/a.ts" },
      request_id: "edit-1",
    });

    applyEvent({
      kind: "PostToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Edit",
      success: true,
    });

    const sess = useStore.getState().sessions.s1;
    expect(pendingIds(sess)).not.toContain("edit-1");
    expect(sess.state).toBe("working");
  });
});

describe("codex subagent lifecycle", () => {
  beforeEach(() => {
    resetStore();
  });

  it("returns to idle when the last codex subagent stops", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({
      kind: "SessionStart",
      session_id: "parent-id",
      cwd: "/tmp/proj",
      agent_type: "codex",
    });
    applyEvent({
      kind: "SubagentStart",
      session_id: "parent-id",
      cwd: "/tmp/proj",
      subagent_id: "codex-child-id",
      subagent_type: "debugger",
      transcript_path: "/tmp/rollout-child.jsonl",
    });

    expect(useStore.getState().sessions["parent-id"].state).toBe("working");

    applyEvent({
      kind: "SubagentStop",
      session_id: "parent-id",
      cwd: "/tmp/proj",
      subagent_id: "codex-child-id",
    });

    const sess = useStore.getState().sessions["parent-id"];
    expect(sess.subagents).toHaveLength(0);
    expect(sess.state).toBe("idle");
    expect(sess.currentTool).toBeUndefined();
    expect(sess.justFinishedAt).toBeTypeOf("number");
  });
});

// Claude Code의 팀/백그라운드 Agent는 메인 에이전트와 *동시에* 돈다.
// 실측(2026-08-12, /tmp/code-crew-hook-evidence.log): SubagentStart/Stop이
// 발화하고 그 사이에 메인의 PreToolUse가 섞여 들어온다. 따라서
// "마지막 서브에이전트 종료 == 세션 종료"도, "메인 Stop == 세션 종료"도
// 각각 단독으로는 성립하지 않는다. 둘 다 끝나야 카드를 재운다.
describe("claude background subagent lifecycle", () => {
  beforeEach(() => {
    resetStore();
  });

  function startTurnWithSubagent(sid: string) {
    const { applyEvent } = useStore.getState();
    applyEvent({ kind: "SessionStart", session_id: sid, cwd: "/tmp/proj", agent_type: "claude" });
    applyEvent({ kind: "UserPromptSubmit", session_id: sid, cwd: "/tmp/proj" });
    applyEvent({
      kind: "PreToolUse",
      session_id: sid,
      cwd: "/tmp/proj",
      tool_name: "Agent",
      tool_input: { subagent_type: "T14-impl" },
    });
    applyEvent({
      kind: "PostToolUse",
      session_id: sid,
      cwd: "/tmp/proj",
      tool_name: "Agent",
      success: true,
    });
    applyEvent({
      kind: "SubagentStart",
      session_id: sid,
      cwd: "/tmp/proj",
      subagent_id: "aT14-impl-7e63",
      subagent_type: "T14-impl",
      transcript_path: "/tmp/proj/sub.jsonl",
    });
  }

  it("keeps working when a subagent stops while the main agent is mid-turn", () => {
    const { applyEvent } = useStore.getState();
    startTurnWithSubagent("s1");

    applyEvent({
      kind: "SubagentStop",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-impl-7e63",
    });

    const sess = useStore.getState().sessions.s1;
    expect(sess.subagents).toHaveLength(0);
    // 메인은 Stop을 보낸 적이 없다 — 도구 없이 사고만 하는 중일 수 있으므로
    // 서브에이전트 종료만으로 펫을 재우면 안 된다.
    expect(sess.state).toBe("working");
  });

  it("keeps working when the main agent stops while a subagent is still running", () => {
    const { applyEvent } = useStore.getState();
    startTurnWithSubagent("s1");

    applyEvent({ kind: "Stop", session_id: "s1", cwd: "/tmp/proj" });

    const sess = useStore.getState().sessions.s1;
    expect(sess.subagents).toHaveLength(1);
    expect(sess.state).toBe("working");
  });

  it("goes idle once the last subagent stops after the main agent stopped", () => {
    const { applyEvent } = useStore.getState();
    startTurnWithSubagent("s1");

    applyEvent({ kind: "Stop", session_id: "s1", cwd: "/tmp/proj" });
    applyEvent({
      kind: "SubagentStop",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-impl-7e63",
    });

    const sess = useStore.getState().sessions.s1;
    expect(sess.state).toBe("idle");
    expect(sess.currentTool).toBeUndefined();
    expect(sess.justFinishedAt).toBeTypeOf("number");
  });

  it("re-arms the main-stopped flag when the next turn starts", () => {
    const { applyEvent } = useStore.getState();
    startTurnWithSubagent("s1");
    applyEvent({ kind: "Stop", session_id: "s1", cwd: "/tmp/proj" });
    applyEvent({
      kind: "SubagentStop",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-impl-7e63",
    });
    expect(useStore.getState().sessions.s1.state).toBe("idle");

    // 다음 턴: 메인이 다시 일하기 시작하면 직전 Stop은 무효가 된다.
    applyEvent({ kind: "UserPromptSubmit", session_id: "s1", cwd: "/tmp/proj" });
    applyEvent({
      kind: "SubagentStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-review-9f21",
      subagent_type: "T14-review",
      transcript_path: "/tmp/proj/sub2.jsonl",
    });
    applyEvent({
      kind: "SubagentStop",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-review-9f21",
    });

    expect(useStore.getState().sessions.s1.state).toBe("working");
  });

  it("clears the main-stopped flag on a main-agent tool call", () => {
    const { applyEvent } = useStore.getState();
    startTurnWithSubagent("s1");
    applyEvent({ kind: "Stop", session_id: "s1", cwd: "/tmp/proj" });

    // 메인이 도구를 다시 쓰면(= 새 턴 진행 중) 서브에이전트 종료로 재우면 안 된다.
    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/a.ts" },
    });
    applyEvent({
      kind: "PostToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Read",
      success: true,
    });
    applyEvent({
      kind: "SubagentStop",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-impl-7e63",
    });

    expect(useStore.getState().sessions.s1.state).toBe("working");
  });

  it("does not clear the main-stopped flag on a subagent tool call", () => {
    const { applyEvent } = useStore.getState();
    startTurnWithSubagent("s1");
    applyEvent({ kind: "Stop", session_id: "s1", cwd: "/tmp/proj" });

    // 서브에이전트의 도구 호출은 메인이 다시 일한다는 뜻이 아니다.
    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/b.ts" },
      agent_name: "T14-impl",
      transcript_path: "/tmp/proj/sub.jsonl",
    });
    applyEvent({
      kind: "PostToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Read",
      success: true,
      agent_name: "T14-impl",
      transcript_path: "/tmp/proj/sub.jsonl",
    });
    applyEvent({
      kind: "SubagentStop",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-impl-7e63",
    });

    expect(useStore.getState().sessions.s1.state).toBe("idle");
  });
});

// Claude Code의 팀/백그라운드 Agent는 부모와 transcript 파일을 공유한다.
// 실측(2026-08-12, /tmp/code-crew-hook-evidence.log): 메인 이벤트 33건,
// SubagentStart/Stop 4건, 서브에이전트 도구 26건이 모두 같은 경로였다.
// 부모 경로가 subagentByPath에 등록되면 agent_name 없는 메인 이벤트가
// 경로 폴백에 걸려 전부 서브에이전트로 오분류된다.
describe("claude team agent shares the parent transcript path", () => {
  const MAIN_TP = "/tmp/proj/4478c585.jsonl";

  beforeEach(() => {
    resetStore();
  });

  function startTeamTurn(sid: string) {
    const { applyEvent } = useStore.getState();
    applyEvent({ kind: "SessionStart", session_id: sid, cwd: "/tmp/proj", agent_type: "claude" });
    applyEvent({ kind: "UserPromptSubmit", session_id: sid, cwd: "/tmp/proj", transcript_path: MAIN_TP });
    applyEvent({
      kind: "SubagentStart",
      session_id: sid,
      cwd: "/tmp/proj",
      subagent_id: "aT14-spec-review-7e63",
      subagent_type: "T14-spec-review",
      transcript_path: MAIN_TP,
    });
  }

  function mainTool(sid: string, tool: string) {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "PreToolUse",
      session_id: sid,
      cwd: "/tmp/proj",
      tool_name: tool,
      tool_input: { file_path: "/tmp/a.ts" },
      transcript_path: MAIN_TP,
    });
    applyEvent({
      kind: "PostToolUse",
      session_id: sid,
      cwd: "/tmp/proj",
      tool_name: tool,
      success: true,
      transcript_path: MAIN_TP,
    });
  }

  function lastAgentName(sid: string) {
    const msgs = useStore.getState().sessions[sid].messages;
    return msgs[msgs.length - 1].agentName;
  }

  it("labels main-agent tool calls as main after a team subagent started", () => {
    startTeamTurn("s1");
    mainTool("s1", "Edit");

    expect(lastAgentName("s1")).toBe("main");
  });

  it("still labels the subagent's own tool calls by agent_name", () => {
    const { applyEvent } = useStore.getState();
    startTeamTurn("s1");

    applyEvent({
      kind: "PreToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/b.ts" },
      agent_name: "T14-spec-review",
      transcript_path: MAIN_TP,
    });

    expect(lastAgentName("s1")).toBe("T14-spec-review");
  });

  it("keeps working when a subagent stops after the main agent resumed post-Stop", () => {
    const { applyEvent } = useStore.getState();
    startTeamTurn("s1");
    applyEvent({
      kind: "SubagentStop",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-spec-review-7e63",
    });
    applyEvent({ kind: "Stop", session_id: "s1", cwd: "/tmp/proj" });
    expect(useStore.getState().sessions.s1.state).toBe("idle");

    // 팀 메시지를 받고 메인이 다시 일하기 시작한다(UserPromptSubmit 없이 도구부터).
    mainTool("s1", "SendMessage");
    applyEvent({
      kind: "SubagentStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-spec-review-9f21",
      subagent_type: "T14-spec-review",
      transcript_path: MAIN_TP,
    });
    applyEvent({
      kind: "SubagentStop",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-spec-review-9f21",
    });

    // 메인은 이번 턴에 Stop을 보낸 적이 없다 — 재우면 안 된다.
    expect(useStore.getState().sessions.s1.state).toBe("working");
  });

  it("ignores a stale parent-path mapping when SubagentStart arrives first", () => {
    const { applyEvent } = useStore.getState();
    // 턴 도중 code-crew를 재시작하면 첫 수신 이벤트가 SubagentStart일 수 있다.
    applyEvent({
      kind: "SubagentStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      subagent_id: "aT14-spec-review-7e63",
      subagent_type: "T14-spec-review",
      transcript_path: MAIN_TP,
    });
    mainTool("s1", "Edit");

    expect(lastAgentName("s1")).toBe("main");
  });
});

describe("terminal api failures", () => {
  beforeEach(() => {
    resetStore();
  });

  it("keeps codex agent messages in working state until task complete", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "codex",
    });

    expect(useStore.getState().sessions.s1.state).toBe("idle");

    applyEvent({
      kind: "Notification",
      session_id: "s1",
      cwd: "/tmp/proj",
      message: "정리 중입니다.",
    });

    expect(useStore.getState().sessions.s1.state).toBe("working");

    applyEvent({
      kind: "Stop",
      session_id: "s1",
      cwd: "/tmp/proj",
    });

    const sess = useStore.getState().sessions.s1;
    expect(sess.state).toBe("idle");
    expect(sess.justFinishedAt).toBeTypeOf("number");
  });

  it("recreates a removed codex session as codex from progress events", () => {
    const { applyEvent, removeSession } = useStore.getState();

    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "codex",
    });
    removeSession("s1");

    useStore.getState().applyEvent({
      kind: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "codex",
    });

    const sess = useStore.getState().sessions.s1;
    expect(sess.agentType).toBe("codex");
    expect(sess.displayName).toBe("proj");
  });

  it("returns to idle when a session-limit notification arrives without Stop", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    applyEvent({
      kind: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/tmp/proj",
    });
    expect(useStore.getState().sessions.s1.state).toBe("working");

    applyEvent({
      kind: "Notification",
      session_id: "s1",
      cwd: "/tmp/proj",
      message: "You've hit your session limit · resets 2:20pm (Asia/Seoul)",
    });

    const sess = useStore.getState().sessions.s1;
    expect(sess.state).toBe("idle");
    expect(sess.currentTool).toBeUndefined();
    expect(sess.justFinishedAt).toBeTypeOf("number");
    expect(sess.messages[sess.messages.length - 1]?.text).toContain("session limit");
  });

  it("captures source pid and pid chain from notification events", () => {
    const { applyEvent } = useStore.getState();

    applyEvent({
      kind: "Notification",
      session_id: "s1",
      cwd: "/tmp/proj",
      message: "done",
      source_pid: 123,
      pid_chain: [123, 456],
    });

    const sess = useStore.getState().sessions.s1;
    expect(sess.sourcePid).toBe(123);
    expect(sess.pidChain).toEqual([123, 456]);
  });
});

function pendingIds(sess: unknown): string[] {
  // Works against either the historical single-slot shape or the current
  // queue shape — keeps the test useful as documentation even after the
  // schema migration.
  const pp = sess as {
    pendingPermissions?: Array<{ requestId: string }>;
    pendingPermission?: { requestId: string };
  };
  if (Array.isArray(pp.pendingPermissions)) {
    return pp.pendingPermissions.map((p) => p.requestId);
  }
  return pp.pendingPermission ? [pp.pendingPermission.requestId] : [];
}

// /clear는 SessionEnd를 발화하지 않으므로(claude-code#6428) 같은 claude
// 프로세스(pidChain[0])의 새 SessionStart가 이전 세션 카드를 대체해야 한다.
describe("SessionStart supersedes stale sessions from the same process", () => {
  beforeEach(() => {
    resetStore();
  });

  it("removes the previous session sharing pidChain[0]", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "old",
      cwd: "/tmp/proj",
      agent_type: "claude",
      pid_chain: [111, 222],
    });
    applyEvent({
      kind: "SessionStart",
      session_id: "new",
      cwd: "/tmp/proj",
      agent_type: "claude",
      pid_chain: [111, 222],
    });

    const st = useStore.getState();
    expect(st.sessions.old).toBeUndefined();
    expect(st.sessions.new).toBeDefined();
    expect(st.sessionOrder).toEqual(["new"]);
  });

  it("removes a late stale card when SessionStart repeats for an existing Claude session", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "current",
      cwd: "/tmp/proj",
      agent_type: "claude",
      pid_chain: [111, 222],
    });
    applyEvent({
      kind: "UserPromptSubmit",
      session_id: "late-stale",
      cwd: "/tmp/proj",
      agent_type: "claude",
      pid_chain: [111, 222],
    });

    applyEvent({
      kind: "SessionStart",
      session_id: "current",
      cwd: "/tmp/proj",
      agent_type: "claude",
      pid_chain: [111, 222],
    });

    const st = useStore.getState();
    expect(st.sessions.current).toBeDefined();
    expect(st.sessions["late-stale"]).toBeUndefined();
    expect(st.sessionOrder).toEqual(["current"]);
  });

  it("keeps sessions from other processes or without pid info", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "other",
      cwd: "/tmp/proj",
      agent_type: "claude",
      pid_chain: [999, 222],
    });
    applyEvent({
      kind: "SessionStart",
      session_id: "nopid",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    applyEvent({
      kind: "SessionStart",
      session_id: "new",
      cwd: "/tmp/proj",
      agent_type: "claude",
      pid_chain: [111, 222],
    });

    const st = useStore.getState();
    expect(st.sessions.other).toBeDefined();
    expect(st.sessions.nopid).toBeDefined();
    expect(st.sessions.new).toBeDefined();
    expect(st.sessionOrder).toHaveLength(3);
  });
});

describe("Codex SessionStart replaces only a safe idle card in the same cwd", () => {
  beforeEach(() => {
    resetStore();
  });

  it("replaces an idle Codex card at its existing order position after cwd normalization", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "old",
      cwd: "C:\\Work\\Code-Crew\\",
      agent_type: "codex",
    });
    applyEvent({ kind: "UserPromptSubmit", session_id: "old", cwd: "C:\\Work\\Code-Crew\\", agent_type: "codex" });
    applyEvent({
      kind: "SessionStart",
      session_id: "other-project",
      cwd: "/tmp/other",
      agent_type: "codex",
    });
    applyEvent({
      kind: "SessionStart",
      session_id: "old-later",
      cwd: "c:/work/code-crew",
      agent_type: "codex",
    });
    applyEvent({ kind: "Stop", session_id: "old", cwd: "C:\\Work\\Code-Crew\\", agent_type: "codex" });

    applyEvent({
      kind: "SessionStart",
      session_id: "new",
      cwd: "c:/work/code-crew",
      agent_type: "codex",
    });

    const st = useStore.getState();
    expect(st.sessions.old).toBeUndefined();
    expect(st.sessions["old-later"]).toBeUndefined();
    expect(st.sessions.new).toBeDefined();
    expect(st.sessionOrder).toEqual(["new", "other-project"]);
  });

  it("keeps POSIX and Windows root cwd values comparable and non-empty", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({ kind: "SessionStart", session_id: "windows-old", cwd: "C:\\", agent_type: "codex" });
    applyEvent({ kind: "SessionStart", session_id: "windows-new", cwd: "c:/", agent_type: "codex" });
    expect(useStore.getState().sessions["windows-old"]).toBeUndefined();

    resetStore();
    applyEvent({ kind: "SessionStart", session_id: "posix-old", cwd: "/", agent_type: "codex" });
    applyEvent({ kind: "SessionStart", session_id: "posix-new", cwd: "/", agent_type: "codex" });
    expect(useStore.getState().sessions["posix-old"]).toBeUndefined();
  });

  it("keeps same-cwd Codex sessions unless every idle-safety condition is met", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({ kind: "SessionStart", session_id: "working", cwd: "/tmp/proj", agent_type: "codex" });
    applyEvent({ kind: "UserPromptSubmit", session_id: "working", cwd: "/tmp/proj", agent_type: "codex" });
    applyEvent({ kind: "SessionStart", session_id: "permission", cwd: "/tmp/proj", agent_type: "codex" });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "permission",
      cwd: "/tmp/proj",
      request_id: "codex-permission",
      tool_name: "Bash",
      tool_input: {},
      agent_type: "codex",
    });
    applyEvent({ kind: "SessionStart", session_id: "subagent", cwd: "/tmp/proj", agent_type: "codex" });
    applyEvent({
      kind: "SubagentStart",
      session_id: "subagent",
      cwd: "/tmp/proj",
      subagent_id: "codex-subagent",
      subagent_type: "worker",
    });
    applyEvent({ kind: "SessionStart", session_id: "tool", cwd: "/tmp/proj", agent_type: "codex" });
    applyEvent({
      kind: "PreToolUse",
      session_id: "tool",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: {},
      agent_type: "codex",
    });

    // 상태 필드만 idle로 보일 수 있는 순서 문제에도 권한·서브에이전트·도구가
    // 남아 있으면 대체하지 않아야 한다.
    useStore.setState((state) => ({
      sessions: Object.fromEntries(
        Object.entries(state.sessions).map(([id, session]) => [id, {
          ...session,
          state: id === "working" ? session.state : "idle",
        }]),
      ),
    }));

    applyEvent({ kind: "SessionStart", session_id: "new", cwd: "/tmp/proj", agent_type: "codex" });

    const st = useStore.getState();
    expect(st.sessions.working).toBeDefined();
    expect(st.sessions.permission).toBeDefined();
    expect(st.sessions.subagent).toBeDefined();
    expect(st.sessions.tool).toBeDefined();
    expect(st.sessions.new).toBeDefined();
  });

  it("does not remove another card when SessionStart repeats for an existing session_id", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({ kind: "SessionStart", session_id: "first", cwd: "/tmp/proj", agent_type: "codex" });
    applyEvent({ kind: "UserPromptSubmit", session_id: "first", cwd: "/tmp/proj", agent_type: "codex" });
    applyEvent({ kind: "SessionStart", session_id: "second", cwd: "/tmp/proj", agent_type: "codex" });
    applyEvent({ kind: "Stop", session_id: "first", cwd: "/tmp/proj", agent_type: "codex" });

    applyEvent({ kind: "SessionStart", session_id: "first", cwd: "/tmp/proj", agent_type: "codex" });

    const st = useStore.getState();
    expect(st.sessions.first).toBeDefined();
    expect(st.sessions.second).toBeDefined();
    expect(st.sessionOrder).toEqual(["first", "second"]);
  });
});

// 네이티브 UI(VSCode 확장 등)에서 응답된 권한은 code-crew에 신호가 오지
// 않는다. main 에이전트는 권한이 미응답이면 턴이 끝날 수 없으므로, Stop
// 도착 시 남아있는 main 요청은 좀비로 보고 걷어낸다.
describe("Stop clears zombie main permissions answered in the native UI", () => {
  beforeEach(() => {
    resetStore();
  });

  it("drops main pending permissions on Stop for claude sessions", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "WebSearch",
      tool_input: {},
      request_id: "r1",
    });
    expect(pendingIds(useStore.getState().sessions.s1)).toEqual(["r1"]);

    applyEvent({ kind: "Stop", session_id: "s1", cwd: "/tmp/proj" });

    const sess = useStore.getState().sessions.s1;
    expect(sess.pendingPermissions).toHaveLength(0);
    expect(sess.state).toBe("idle");
  });

  it("keeps subagent pending permissions across a main Stop", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      request_id: "r-sub",
      agent_name: "alpha",
    });

    applyEvent({ kind: "Stop", session_id: "s1", cwd: "/tmp/proj" });

    const sess = useStore.getState().sessions.s1;
    expect(pendingIds(sess)).toEqual(["r-sub"]);
    expect(sess.state).toBe("permission");
  });

  it("keeps codex main pending permissions on Stop", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "c1",
      cwd: "/tmp/proj",
      agent_type: "codex",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "c1",
      cwd: "/tmp/proj",
      tool_name: "shell_command",
      tool_input: {},
      request_id: "codex-r1",
    });

    applyEvent({ kind: "Stop", session_id: "c1", cwd: "/tmp/proj", agent_type: "codex" });

    const stopped = useStore.getState().sessions.c1;
    expect(pendingIds(stopped)).toEqual(["codex-r1"]);
    expect(stopped.state).toBe("permission");

    applyEvent({ kind: "PermissionCancel", request_id: "codex-r1" });
    const resolved = useStore.getState().sessions.c1;
    expect(pendingIds(resolved)).toEqual([]);
    expect(resolved.state).toBe("idle");
  });
});

describe("UserPromptSubmit transcript path capture", () => {
  beforeEach(() => {
    resetStore();
  });

  it("stores mainTranscriptPath from the first prompt, before any tool use", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/tmp/proj",
      transcript_path: "/tmp/t.jsonl",
    });
    expect(useStore.getState().sessions.s1.mainTranscriptPath).toBe("/tmp/t.jsonl");
  });

  it("does not overwrite an already-known main transcript path", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/tmp/proj",
      transcript_path: "/tmp/first.jsonl",
    });
    applyEvent({
      kind: "UserPromptSubmit",
      session_id: "s1",
      cwd: "/tmp/proj",
      transcript_path: "/tmp/second.jsonl",
    });
    expect(useStore.getState().sessions.s1.mainTranscriptPath).toBe("/tmp/first.jsonl");
  });
});

// 답변 대기 중인 세션은 hook 이벤트가 한 건도 오지 않는다 — idle sweep이
// lastSeen만 보고 재우면 "답변 기다리는 중"인 카드가 자는 펫으로 바뀐다.
describe("pending permissions keep the session awake", () => {
  beforeEach(() => {
    resetStore();
  });

  function askAndGoSilent(sinceMs: number) {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "어디까지?", options: [{ label: "전부" }] }] },
      request_id: "r1",
    });
    // 사용자가 답할 때까지 이벤트가 끊긴 상태를 만든다.
    useStore.setState((st) => ({
      sessions: {
        ...st.sessions,
        s1: { ...st.sessions.s1, lastSeen: Date.now() - sinceMs },
      },
    }));
  }

  it("does not sleep after the idle delay while a request is unanswered", () => {
    askAndGoSilent(10 * 60 * 1000);

    useStore.getState().setIdle("s1");

    const sess = useStore.getState().sessions.s1;
    expect(sess.state).toBe("permission");
    expect(pendingIds(sess)).toEqual(["r1"]);
  });

  it("does not sleep even when the sweep forces idle", () => {
    askAndGoSilent(10 * 60 * 1000);

    useStore.getState().setIdle("s1", true);

    expect(useStore.getState().sessions.s1.state).toBe("permission");
  });

  it("still sleeps once the queue is empty", () => {
    askAndGoSilent(10 * 60 * 1000);

    useStore.getState().applyEvent({ kind: "PermissionCancel", request_id: "r1" });
    useStore.getState().setIdle("s1");

    expect(useStore.getState().sessions.s1.state).toBe("idle");
  });

  it("refreshes lastSeen so the idle countdown starts at the request", () => {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "SessionStart",
      session_id: "s1",
      cwd: "/tmp/proj",
      agent_type: "claude",
    });
    const stale = Date.now() - 4 * 60 * 1000;
    useStore.setState((st) => ({
      sessions: { ...st.sessions, s1: { ...st.sessions.s1, lastSeen: stale } },
    }));

    applyEvent({
      kind: "PermissionRequest",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      request_id: "r2",
    });

    expect(useStore.getState().sessions.s1.lastSeen).toBeGreaterThan(stale);
  });
});

// 실측(2026-08-19, /tmp/code-crew-hook.log): run_in_background Bash는
// PostToolUse의 tool_response.backgroundTaskId로 쉘 ID를 준다. 그 쉘은
// Stop 뒤에도 계속 돌고, 종료는 hook이 아니라 transcript에만 남는다.
describe("background shell tracking", () => {
  beforeEach(() => {
    resetStore();
  });

  function launchBackgroundShell(sid: string, taskId: string) {
    const { applyEvent } = useStore.getState();
    applyEvent({
      kind: "PreToolUse",
      session_id: sid,
      cwd: "/tmp/proj",
      tool_name: "Bash",
      tool_input: { command: "npm run build", run_in_background: true },
    });
    applyEvent({
      kind: "PostToolUse",
      session_id: sid,
      cwd: "/tmp/proj",
      tool_name: "Bash",
      success: true,
      background_task_id: taskId,
    });
  }

  it("keeps the background shell tracked after the turn stops", () => {
    launchBackgroundShell("s1", "bb7w8134l");
    useStore.getState().applyEvent({ kind: "Stop", session_id: "s1", cwd: "/tmp/proj" });

    const sess = useStore.getState().sessions.s1;
    expect(sess.state).toBe("idle");
    expect(sess.backgroundTasks.map((t) => t.id)).toEqual(["bb7w8134l"]);
  });

  it("ignores a foreground tool call and never double-tracks one shell", () => {
    const { applyEvent } = useStore.getState();
    launchBackgroundShell("s1", "bb7w8134l");
    applyEvent({
      kind: "PostToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Read",
      success: true,
    });
    applyEvent({
      kind: "PostToolUse",
      session_id: "s1",
      cwd: "/tmp/proj",
      tool_name: "Bash",
      success: true,
      background_task_id: "bb7w8134l",
    });

    expect(useStore.getState().sessions.s1.backgroundTasks).toHaveLength(1);
  });

  it("drops only the shells reported finished by the transcript", () => {
    launchBackgroundShell("s1", "bb7w8134l");
    launchBackgroundShell("s1", "bmq4x9gef");

    useStore.getState().clearBackgroundTasks("s1", ["bmq4x9gef"]);

    expect(useStore.getState().sessions.s1.backgroundTasks.map((t) => t.id)).toEqual(["bb7w8134l"]);
  });

  it("keeps the same session object when nothing was finished", () => {
    launchBackgroundShell("s1", "bb7w8134l");
    const before = useStore.getState().sessions.s1;

    useStore.getState().clearBackgroundTasks("s1", []);
    useStore.getState().clearBackgroundTasks("s1", ["other"]);

    expect(useStore.getState().sessions.s1).toBe(before);
  });
});
