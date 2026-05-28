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
