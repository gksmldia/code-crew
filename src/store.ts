import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  Event,
  Message,
  PendingPermission,
  Session,
  Subagent,
} from "./types";
import { messageFromTool } from "./lib/messages";
import { petForAgent, petForSession, shortNameOf } from "./lib/pets";

interface Store {
  sessions: Record<string, Session>;
  sessionOrder: string[];
  applyEvent: (ev: Event) => void;
  setIdle: (sessionId: string) => void;
  acknowledgePermission: (sessionId: string, requestId: string) => void;
  addRestoredMessages: (sessionId: string, msgs: Message[]) => void;
  setProjectKey: (sessionId: string, key: string) => void;
  setDisplayName: (sessionId: string, name: string) => void;
  removeSession: (sessionId: string) => void;
  reorderSessions: (fromId: string, toId: string) => void;
  setBreed: (sessionId: string, breed: string) => void;
}

const IDLE_DELAY_MS = 5 * 60 * 1000;

async function persistMessage(sess: Session, msg: Message) {
  if (!sess.projectKey) return;
  try {
    await invoke("append_project_message", {
      projectKey: sess.projectKey,
      displayName: sess.displayName,
      msg: {
        id: msg.id,
        agent_name: msg.agentName,
        pet: msg.pet,
        tool_emoji: msg.toolEmoji ?? null,
        tool_name: msg.toolName ?? null,
        text: msg.text,
        kind: msg.kind,
        timestamp: msg.timestamp,
      },
    });
  } catch {
    /* swallow — disk failure shouldn't break UI */
  }
}

function ensureSession(s: Record<string, Session>, order: string[], sid: string, defaults?: Partial<Session>): Session {
  if (!s[sid]) {
    s[sid] = {
      sessionId: sid,
      agentType: defaults?.agentType ?? "claude",
      cwd: defaults?.cwd ?? "",
      projectKey: defaults?.projectKey ?? "",
      displayName: defaults?.displayName || sid.slice(0, 8),
      state: "idle",
      messages: [],
      subagents: [],
      pendingPermissions: [],
      lastSeen: Date.now(),
      pet: petForSession(sid),
      subagentByPath: {},
      pendingSubagentTypes: [],
    };
    order.push(sid);
  } else {
    if (defaults?.cwd && !s[sid].cwd) s[sid].cwd = defaults.cwd;
    if (defaults?.displayName && (!s[sid].displayName || s[sid].displayName === sid.slice(0, 8))) {
      s[sid].displayName = defaults.displayName;
    }
    // Authoritative agentType arrives via SessionStart, which can land AFTER
    // a session was lazily created by PreToolUse / SubagentStart. When a
    // caller passes a definite agentType, let it overwrite the placeholder.
    if (defaults?.agentType && s[sid].agentType !== defaults.agentType) {
      s[sid].agentType = defaults.agentType;
    }
  }
  return s[sid];
}

function withCwd(cwd?: string | null): Partial<Session> | undefined {
  if (!cwd) return undefined;
  return { cwd, displayName: lastSegment(cwd) };
}

function pushMessage(session: Session, msg: Message) {
  session.messages.push(msg);
  if (session.messages.length > 200) session.messages.splice(0, session.messages.length - 200);
}

function disambiguateShortName(session: Session, name: string): string {
  const base = shortNameOf(name);
  const existing = session.subagents.filter((sa) => sa.shortName.startsWith(base)).length;
  if (existing === 0) return base;
  return `${base}${toSubscript(existing + 1)}`;
}

function toSubscript(n: number): string {
  const map: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉" };
  return String(n).split("").map((c) => map[c] ?? c).join("");
}

function isCodexTranscriptPath(path?: string): boolean {
  return Boolean(path && path.includes("/.codex/sessions/"));
}

function markCodex(sess: Session) {
  if (sess.agentType !== "codex") sess.agentType = "codex";
}

function isAskUserQuestion(permission: PendingPermission): boolean {
  return permission.toolName === "AskUserQuestion";
}

function removeResolvedPermission(session: Session, toolName: string, agentName: string) {
  const idx = session.pendingPermissions.findIndex((p) => {
    const pendingAgent = p.agentName && p.agentName.length > 0 ? p.agentName : "main";
    return p.toolName === toolName && pendingAgent === agentName;
  });
  if (idx >= 0) session.pendingPermissions.splice(idx, 1);
}

// AskUserQuestion has no "answered" hook: Claude Code never fires a PostToolUse
// we can match when the user picks an option in the TUI, and the turn's Stop
// can be many tool calls away. But the asking agent is *blocked* until it's
// answered — so the moment that same agent does any other work, the question
// is provably answered. Drop its stale banner then instead of leaving it up
// until Stop (which is what made the prompt linger while Claude kept working).
function clearAnsweredQuestions(session: Session, agentName: string) {
  session.pendingPermissions = session.pendingPermissions.filter((p) => {
    const pendingAgent = p.agentName && p.agentName.length > 0 ? p.agentName : "main";
    return !(isAskUserQuestion(p) && pendingAgent === agentName);
  });
}

export const useStore = create<Store>((set) => ({
  sessions: {},
  sessionOrder: [],

  applyEvent: (ev) =>
    set((state) => {
      const s = { ...state.sessions };
      const order = [...state.sessionOrder];
      switch (ev.kind) {
        case "SessionStart": {
          const existed = Boolean(s[ev.session_id]);
          const sess = ensureSession(s, order, ev.session_id, {
            agentType: ev.agent_type,
            cwd: ev.cwd,
            displayName: lastSegment(ev.cwd),
          });
          if (!existed) sess.state = "idle";
          sess.lastSeen = Date.now();
          if (ev.source_pid != null) sess.sourcePid = ev.source_pid;
          if (ev.pid_chain && ev.pid_chain.length > 0) sess.pidChain = ev.pid_chain;
          break;
        }
        case "UserPromptSubmit": {
          // User just sent a message and Claude is about to think/respond.
          // Without this, pure-text responses (no tool calls) leave the pet
          // stuck in "idle" for the entire turn — the only working signal we
          // had previously was PreToolUse.
          //
          // We deliberately do NOT clear sess.pendingPermissions here:
          // subagents fire permission requests concurrently with the main
          // agent's prompt loop, and dropping them silently parks each
          // request's hook process on /permission until it times out
          // (see hook.rs::permission long-poll). Pending requests must
          // only leave the queue via acknowledgePermission or
          // PermissionCancel.
          const sess = ensureSession(s, order, ev.session_id, withCwd(ev.cwd));
          sess.state = sess.pendingPermissions.length > 0 ? "permission" : "working";
          sess.lastSeen = Date.now();
          break;
        }
        case "PreToolUse": {
          const sess = ensureSession(s, order, ev.session_id, withCwd(ev.cwd));
          sess.currentTool = ev.tool_name;
          if (ev.source_pid != null && sess.sourcePid == null) sess.sourcePid = ev.source_pid;
          if (ev.pid_chain && ev.pid_chain.length > 0) sess.pidChain = ev.pid_chain;

          const tp = ev.transcript_path ?? undefined;
          if (isCodexTranscriptPath(tp)) markCodex(sess);
          if (tp) {
            if (!sess.mainTranscriptPath) {
              sess.mainTranscriptPath = tp;
            } else if (tp !== sess.mainTranscriptPath && !sess.subagentByPath[tp]) {
              const pending = sess.pendingSubagentTypes.shift();
              if (pending) {
                const short = disambiguateShortName(sess, pending);
                sess.subagentByPath[tp] = { name: pending, shortName: short };
                if (!sess.subagents.some((sa) => sa.transcriptPath === tp)) {
                  sess.subagents.push({
                    id: `sub-${tp.split("/").pop() ?? tp}`,
                    name: pending,
                    shortName: short,
                    state: "working",
                    transcriptPath: tp,
                  });
                }
              }
            }
          }

          if (ev.tool_name === "Task") {
            const subType = (ev.tool_input as Record<string, unknown> | null)?.["subagent_type"];
            if (typeof subType === "string" && subType.length > 0) {
              sess.pendingSubagentTypes.push(subType);
              if (sess.pendingSubagentTypes.length > 16) {
                sess.pendingSubagentTypes.splice(0, sess.pendingSubagentTypes.length - 16);
              }
            }
          }

          // Claude Code stamps `agent_name` directly on hook payloads when the
          // event originates from a subagent. Prefer that; fall back to
          // transcript_path mapping (used by Codex subagents).
          const agentLabel = ev.agent_name && ev.agent_name.length > 0
            ? shortNameOf(ev.agent_name)
            : tp && sess.subagentByPath[tp]
              ? sess.subagentByPath[tp].shortName
              : "main";
          removeResolvedPermission(sess, ev.tool_name, agentLabel);
          // Any *other* tool from this agent means a question it had pending was
          // already answered (it couldn't have proceeded otherwise).
          if (ev.tool_name !== "AskUserQuestion") clearAnsweredQuestions(sess, agentLabel);
          sess.state = sess.pendingPermissions.length > 0 ? "permission" : "working";

          const tm = messageFromTool(ev.tool_name, (ev.tool_input as Record<string, unknown>) ?? {});
          const msg: Message = {
            id: crypto.randomUUID(),
            agentName: agentLabel,
            pet: petForAgent(agentLabel),
            toolEmoji: tm.toolEmoji,
            toolName: tm.toolName,
            text: tm.text,
            kind: "tool",
            timestamp: Date.now(),
          };
          pushMessage(sess, msg);
          void persistMessage(sess, msg);
          sess.lastSeen = Date.now();
          break;
        }
        case "PostToolUse": {
          const sess = ensureSession(s, order, ev.session_id, withCwd(ev.cwd));
          // Same rationale as UserPromptSubmit/PreToolUse: don't blow away
          // sibling subagents' pending permissions just because *this*
          // tool finished. Each request leaves the queue only when its
          // own request_id is acknowledged or cancelled.
          sess.currentTool = undefined;
          const tp = ev.transcript_path ?? undefined;
          if (isCodexTranscriptPath(tp)) markCodex(sess);
          const agentLabel = ev.agent_name && ev.agent_name.length > 0
            ? shortNameOf(ev.agent_name)
            : tp && sess.subagentByPath[tp]
              ? sess.subagentByPath[tp].shortName
              : "main";
          removeResolvedPermission(sess, ev.tool_name, agentLabel);
          if (ev.tool_name !== "AskUserQuestion") clearAnsweredQuestions(sess, agentLabel);
          if (!ev.success) {
            sess.state = sess.pendingPermissions.length > 0 ? "permission" : "error";
            const msg: Message = {
              id: crypto.randomUUID(),
              agentName: agentLabel,
              pet: petForAgent(agentLabel),
              toolEmoji: "❌",
              toolName: ev.tool_name,
              text: `${ev.tool_name} 실패`,
              kind: "error",
              timestamp: Date.now(),
            };
            pushMessage(sess, msg);
            void persistMessage(sess, msg);
          } else {
            sess.state = sess.pendingPermissions.length > 0 ? "permission" : "working";
          }
          sess.lastSeen = Date.now();
          break;
        }
        case "SubagentStart": {
          const sess = ensureSession(s, order, ev.session_id, withCwd(ev.cwd));
          const tp = ev.transcript_path ?? undefined;
          if (ev.subagent_id.startsWith("codex-") || isCodexTranscriptPath(tp)) markCodex(sess);
          // If we already mapped this transcript_path, reuse the same shortName
          const existingByPath = tp ? sess.subagentByPath[tp] : undefined;
          const short = existingByPath
            ? existingByPath.shortName
            : disambiguateShortName(sess, ev.subagent_type);
          if (tp && !existingByPath) {
            sess.subagentByPath[tp] = { name: ev.subagent_type, shortName: short };
          }
          if (!sess.subagents.some((x) => x.id === ev.subagent_id)) {
            const sa: Subagent = {
              id: ev.subagent_id,
              name: ev.subagent_type,
              shortName: short,
              state: "working",
              transcriptPath: tp,
            };
            sess.subagents.push(sa);
          }
          sess.state = "working";
          break;
        }
        case "SubagentStop": {
          const sess = ensureSession(s, order, ev.session_id, withCwd(ev.cwd));
          if (ev.subagent_id.startsWith("codex-")) markCodex(sess);
          sess.subagents = sess.subagents.filter((sa) => sa.id !== ev.subagent_id);
          break;
        }
        case "PermissionRequest": {
          const sess = ensureSession(s, order, ev.session_id, withCwd(ev.cwd));
          if (ev.request_id.startsWith("codex-")) markCodex(sess);
          sess.state = "permission";
          const agentLabel = ev.agent_name && ev.agent_name.length > 0
            ? shortNameOf(ev.agent_name)
            : "main";
          const pp: PendingPermission = {
            requestId: ev.request_id,
            toolName: ev.tool_name,
            toolInput: ev.tool_input,
            suggestions: ev.suggestions,
            agentName: agentLabel,
          };
          // Append rather than overwrite — multiple subagents can have
          // open requests at once and the widget renders one PermissionInline
          // per entry. Dedup by request_id so a retry doesn't double-add.
          if (!sess.pendingPermissions.some((p) => p.requestId === pp.requestId)) {
            sess.pendingPermissions.push(pp);
          }
          const msg: Message = {
            id: crypto.randomUUID(),
            agentName: agentLabel,
            pet: petForAgent(agentLabel),
            toolEmoji: "⚠️",
            toolName: ev.tool_name,
            text: `${ev.tool_name} 실행 허용?`,
            kind: "permission",
            timestamp: Date.now(),
          };
          pushMessage(sess, msg);
          void persistMessage(sess, msg);
          break;
        }
        case "PermissionCancel": {
          for (const sess of Object.values(s)) {
            const before = sess.pendingPermissions.length;
            sess.pendingPermissions = sess.pendingPermissions.filter(
              (p) => p.requestId !== ev.request_id,
            );
            if (
              before !== sess.pendingPermissions.length &&
              sess.pendingPermissions.length === 0 &&
              sess.state === "permission"
            ) {
              sess.state = "idle";
            }
          }
          break;
        }
        case "Stop": {
          const sess = ensureSession(s, order, ev.session_id, withCwd(ev.cwd));
          if (sess.state === "working" || sess.state === "error") {
            sess.justFinishedAt = Date.now();
          }
          sess.pendingPermissions = sess.pendingPermissions.filter((p) => !isAskUserQuestion(p));
          // Pending permissions outlive a Stop — their hook processes are
          // still parked on /permission and need a widget answer or a
          // PermissionCancel to unblock. Reflect that in the state so the
          // card keeps showing the inline UI. AskUserQuestion is different:
          // once Stop arrives, the terminal-side question has been answered
          // and there is no permission hook left for the widget to resolve.
          sess.state = sess.pendingPermissions.length > 0 ? "permission" : "idle";
          sess.currentTool = undefined;
          sess.lastSeen = Date.now();
          break;
        }
        case "SessionEnd": {
          if (s[ev.session_id]) {
            delete s[ev.session_id];
            const idx = order.indexOf(ev.session_id);
            if (idx >= 0) order.splice(idx, 1);
          }
          break;
        }
        case "Notification": {
          const sess = ensureSession(s, order, ev.session_id, withCwd(ev.cwd));
          const msg: Message = {
            id: crypto.randomUUID(),
            agentName: "main",
            pet: petForAgent("main"),
            text: ev.message,
            kind: "info",
            timestamp: Date.now(),
          };
          pushMessage(sess, msg);
          void persistMessage(sess, msg);
          break;
        }
      }
      return { sessions: s, sessionOrder: order };
    }),

  setIdle: (sessionId) =>
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      const since = Date.now() - sess.lastSeen;
      if (since < IDLE_DELAY_MS) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...sess, state: "idle", currentTool: undefined } },
      };
    }),

  acknowledgePermission: (sessionId, requestId) =>
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      const remaining = sess.pendingPermissions.filter((p) => p.requestId !== requestId);
      // If other subagent requests are still waiting, keep the session in
      // "permission" so the card keeps the amber ring and the inline
      // widgets stay visible. Only drop back to idle once the queue is
      // empty.
      const nextState: Session["state"] = remaining.length > 0 ? "permission" : "idle";
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...sess, state: nextState, pendingPermissions: remaining },
        },
      };
    }),

  addRestoredMessages: (sessionId, msgs) =>
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...sess, messages: [...msgs, ...sess.messages] } },
      };
    }),

  setProjectKey: (sessionId, key) =>
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...sess, projectKey: key } },
      };
    }),

  setDisplayName: (sessionId, name) =>
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...sess, displayName: name } },
      };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const s = { ...state.sessions };
      delete s[sessionId];
      return {
        sessions: s,
        sessionOrder: state.sessionOrder.filter((id) => id !== sessionId),
      };
    }),

  reorderSessions: (fromId, toId) =>
    set((state) => {
      if (fromId === toId) return state;
      const order = state.sessionOrder.filter((id) => id !== fromId);
      const idx = order.indexOf(toId);
      if (idx < 0) return state;
      order.splice(idx, 0, fromId);
      return { sessionOrder: order };
    }),

  setBreed: (sessionId, breed) =>
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...sess, pet: breed } },
      };
    }),
}));

function lastSegment(p: string): string {
  if (!p) return "(unknown)";
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return i >= 0 ? trimmed.slice(i + 1) : trimmed;
}
