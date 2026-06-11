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

  it("keeps real permission prompts open when the turn stops", () => {
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
      tool_input: { command: "npm test" },
      request_id: "perm-1",
    });

    applyEvent({
      kind: "Stop",
      session_id: "s1",
      cwd: "/tmp/proj",
    });

    const sess = useStore.getState().sessions.s1;
    expect(pendingIds(sess)).toContain("perm-1");
    expect(sess.state).toBe("permission");
  });

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
