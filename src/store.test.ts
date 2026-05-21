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
