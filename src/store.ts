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
  setIdle: (sessionId: string, force?: boolean) => void;
  clearBackgroundTasks: (sessionId: string, ids: string[]) => void;
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
      backgroundTasks: [],
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

function withEventDefaults(cwd?: string | null, agentType?: Session["agentType"] | null): Partial<Session> | undefined {
  const defaults: Partial<Session> = {};
  if (cwd) {
    defaults.cwd = cwd;
    defaults.displayName = lastSegment(cwd);
  }
  if (agentType) defaults.agentType = agentType;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
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

function isTerminalApiError(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("session limit") || lower.includes("rate limit");
}

function normalizeCwd(cwd: string): string {
  const slashed = cwd.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!slashed) return "";
  if (/^[a-z]:\/$/i.test(slashed)) return slashed.toLowerCase();
  const normalized = slashed === "/" ? slashed : slashed.replace(/\/+$/, "");
  // Windows paths are case-insensitive; preserve POSIX case sensitivity.
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function isReplaceableIdleCodexSession(session: Session, incomingCwd: string): boolean {
  return session.agentType === "codex"
    && normalizeCwd(session.cwd) === incomingCwd
    && session.state === "idle"
    && session.pendingPermissions.length === 0
    && session.subagents.length === 0
    && !session.currentTool;
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
          // /clear는 SessionEnd hook을 발화하지 않는다(claude-code#6428).
          // 한 claude 프로세스는 동시에 한 세션만 호스팅하므로, 같은 프로세스
          // (pidChain[0])에서 새 SessionStart가 오면 그 프로세스의 이전 세션은
          // 종료된 것으로 간주하고 카드를 제거한다. (/clear·/resume 커버)
          const newHead = ev.pid_chain?.[0];
          if (ev.agent_type === "claude" && newHead != null) {
            for (const sid of Object.keys(s)) {
              if (sid !== ev.session_id && s[sid].pidChain?.[0] === newHead) {
                delete s[sid];
                const oi = order.indexOf(sid);
                if (oi >= 0) order.splice(oi, 1);
              }
            }
          }
          // Codex는 새 rollout마다 새 session_id를 보내므로 PID가 아니라 cwd와
          // 안전한 idle 상태를 기준으로 바로 전 카드를 대체한다. 작업·권한·도구·
          // 서브에이전트가 남아 있는 카드는 독립 세션으로 유지한다.
          let replacementIndex: number | undefined;
          if (!existed && ev.agent_type === "codex") {
            const incomingCwd = normalizeCwd(ev.cwd);
            const replacementIds = incomingCwd
              ? order.filter((sid) => sid !== ev.session_id && isReplaceableIdleCodexSession(s[sid], incomingCwd))
              : [];
            if (replacementIds.length > 0) {
              replacementIndex = order.indexOf(replacementIds[0]);
              for (const sid of replacementIds) delete s[sid];
              for (let index = order.length - 1; index >= 0; index -= 1) {
                if (replacementIds.includes(order[index])) order.splice(index, 1);
              }
            }
          }
          const sess = ensureSession(s, order, ev.session_id, {
            agentType: ev.agent_type,
            cwd: ev.cwd,
            displayName: lastSegment(ev.cwd),
          });
          if (replacementIndex !== undefined) {
            const appendedIndex = order.indexOf(ev.session_id);
            order.splice(appendedIndex, 1);
            order.splice(replacementIndex, 0, ev.session_id);
          }
          if (!existed) sess.state = "idle";
          sess.mainStopped = false;
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
          const sess = ensureSession(s, order, ev.session_id, withEventDefaults(ev.cwd, ev.agent_type));
          if (ev.source_pid != null && sess.sourcePid == null) sess.sourcePid = ev.source_pid;
          if (ev.pid_chain && ev.pid_chain.length > 0) sess.pidChain = ev.pid_chain;
          // UserPromptSubmit은 항상 main 에이전트 소속 — 도구 호출 전에도
          // idle sweep이 transcript 활동을 확인할 수 있게 경로를 확보한다.
          if (ev.transcript_path && !sess.mainTranscriptPath) {
            sess.mainTranscriptPath = ev.transcript_path;
          }
          sess.state = sess.pendingPermissions.length > 0 ? "permission" : "working";
          // 새 턴 시작 — 직전 Stop은 무효가 된다.
          sess.mainStopped = false;
          sess.lastSeen = Date.now();
          break;
        }
        case "PreToolUse": {
          const sess = ensureSession(s, order, ev.session_id, withEventDefaults(ev.cwd, ev.agent_type));
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
            : tp && tp !== sess.mainTranscriptPath && sess.subagentByPath[tp]
              ? sess.subagentByPath[tp].shortName
              : "main";
          removeResolvedPermission(sess, ev.tool_name, agentLabel);
          // Any *other* tool from this agent means a question it had pending was
          // already answered (it couldn't have proceeded otherwise).
          if (ev.tool_name !== "AskUserQuestion") {
            clearAnsweredQuestions(sess, agentLabel);
          } else {
            // 뒤따르는 PermissionRequest는 agent 정보 없이 오므로 실제 질문 주체를 저장
            sess.lastAskAgent = agentLabel;
          }
          // 메인이 도구를 쓰면 새 턴이 진행 중이라는 뜻 — 직전 Stop을 무효화한다.
          // 서브에이전트의 도구 호출은 메인 상태를 말해주지 않으므로 제외한다.
          if (agentLabel === "main") sess.mainStopped = false;
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
          const sess = ensureSession(s, order, ev.session_id, withEventDefaults(ev.cwd, ev.agent_type));
          if (ev.source_pid != null && sess.sourcePid == null) sess.sourcePid = ev.source_pid;
          if (ev.pid_chain && ev.pid_chain.length > 0) sess.pidChain = ev.pid_chain;
          // Same rationale as UserPromptSubmit/PreToolUse: don't blow away
          // sibling subagents' pending permissions just because *this*
          // tool finished. Each request leaves the queue only when its
          // own request_id is acknowledged or cancelled.
          sess.currentTool = undefined;
          const tp = ev.transcript_path ?? undefined;
          if (isCodexTranscriptPath(tp)) markCodex(sess);
          const agentLabel = ev.agent_name && ev.agent_name.length > 0
            ? shortNameOf(ev.agent_name)
            : tp && tp !== sess.mainTranscriptPath && sess.subagentByPath[tp]
              ? sess.subagentByPath[tp].shortName
              : "main";
          removeResolvedPermission(sess, ev.tool_name, agentLabel);
          if (ev.tool_name !== "AskUserQuestion") clearAnsweredQuestions(sess, agentLabel);
          // run_in_background로 띄운 쉘은 Stop 뒤에도 계속 돈다. 종료는 hook을
          // 발화하지 않고 transcript의 <task-notification>으로만 오므로(실측
          // 2026-08-19), 여기서 ID를 잡아두고 idle sweep이 지운다.
          const bgId = ev.background_task_id;
          if (bgId && !sess.backgroundTasks.some((t) => t.id === bgId)) {
            sess.backgroundTasks.push({ id: bgId, startedAt: Date.now() });
          }
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
          const sess = ensureSession(s, order, ev.session_id, withEventDefaults(ev.cwd, undefined));
          const tp = ev.transcript_path ?? undefined;
          if (ev.subagent_id.startsWith("codex-") || isCodexTranscriptPath(tp)) markCodex(sess);
          // If we already mapped this transcript_path, reuse the same shortName
          const existingByPath = tp ? sess.subagentByPath[tp] : undefined;
          const short = existingByPath
            ? existingByPath.shortName
            : disambiguateShortName(sess, ev.subagent_type);
          // Claude Code의 팀/백그라운드 Agent는 부모와 transcript 파일을 공유한다.
          // 부모 경로를 서브에이전트로 등록하면 agent_name 없는 메인 이벤트가
          // 전부 서브에이전트로 오분류된다(실측 2026-08-12). PreToolUse와 같은 가드.
          if (tp && tp !== sess.mainTranscriptPath && !existingByPath) {
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
          const sess = ensureSession(s, order, ev.session_id, withEventDefaults(ev.cwd, undefined));
          if (ev.subagent_id.startsWith("codex-")) markCodex(sess);
          sess.subagents = sess.subagents.filter((sa) => sa.id !== ev.subagent_id);
          // 마지막 서브에이전트가 끝나도 메인은 대개 턴을 계속한다 — Claude Code의
          // 팀/백그라운드 Agent는 메인 작업과 병행되기 때문이다(실측 2026-08-12).
          // 도구 없이 사고만 하는 동안엔 hook 이벤트가 없어, 여기서 재우면 펫이
          // 몇 분씩 자는 것처럼 보인다. 메인이 이미 Stop을 보냈을 때만 종료로 본다.
          // Codex는 부모 rollout의 Stop이 늦거나 누락될 수 있어 기존 판정을 유지한다.
          const mainDone = sess.agentType === "codex" || sess.mainStopped === true;
          if (mainDone && sess.subagents.length === 0 && sess.state === "working" && !sess.currentTool) {
            sess.justFinishedAt = Date.now();
            sess.state = sess.pendingPermissions.length > 0 ? "permission" : "idle";
            sess.currentTool = undefined;
            sess.lastSeen = Date.now();
          }
          break;
        }
        case "PermissionRequest": {
          const sess = ensureSession(s, order, ev.session_id, withEventDefaults(ev.cwd, ev.agent_type));
          if (ev.source_pid != null && sess.sourcePid == null) sess.sourcePid = ev.source_pid;
          if (ev.pid_chain && ev.pid_chain.length > 0) sess.pidChain = ev.pid_chain;
          if (ev.request_id.startsWith("codex-")) markCodex(sess);
          sess.state = "permission";
          const agentLabel = ev.agent_name && ev.agent_name.length > 0
            ? shortNameOf(ev.agent_name)
            : ev.tool_name === "AskUserQuestion" && sess.lastAskAgent
              ? sess.lastAskAgent
              : "main";
          if (ev.tool_name === "AskUserQuestion") sess.lastAskAgent = undefined; // 재사용 방지
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
          const isNewRequest = !sess.pendingPermissions.some((p) => p.requestId === pp.requestId);
          if (isNewRequest) {
            sess.pendingPermissions.push(pp);
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
          }
          // 다른 이벤트 핸들러와 동일하게 활동 시각을 갱신한다. 이게 없으면
          // 권한 요청이 뜬 순간 이미 idle 카운트가 진행 중인 상태가 된다.
          sess.lastSeen = Date.now();
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
          const sess = ensureSession(s, order, ev.session_id, withEventDefaults(ev.cwd, ev.agent_type));
          if (ev.source_pid != null && sess.sourcePid == null) sess.sourcePid = ev.source_pid;
          if (ev.pid_chain && ev.pid_chain.length > 0) sess.pidChain = ev.pid_chain;
          sess.mainStopped = true;
          // 백그라운드 서브에이전트가 남아 있으면 메인 Stop만으로는 세션이 끝난
          // 게 아니다 — 카드는 계속 working으로 두고, 마지막 서브에이전트가
          // SubagentStop을 보낼 때 재운다. Codex는 부모/자식 rollout 순서가
          // 뒤섞일 수 있어 기존 판정을 유지한다.
          const subagentsBusy = sess.agentType !== "codex" && sess.subagents.length > 0;
          if (!subagentsBusy && (sess.state === "working" || sess.state === "error")) {
            sess.justFinishedAt = Date.now();
          }
          // Stop은 턴 전체가 끝났다는 뜻 — main 에이전트의 권한 요청이
          // 미응답이면 턴이 여기까지 올 수 없으므로, 남아있는 main 요청은
          // 네이티브 UI(VSCode 확장 등)에서 이미 응답된 좀비다. 배너를
          // 걷어낸다. 좀비 hook은 서버 600초 타임아웃으로 자연 정리된다.
          // 서브에이전트 요청은 main Stop과 동시에 살아있을 수 있으므로
          // 유지하고(hook이 여전히 위젯 응답 대기 중), Codex는 JSONL 폴링
          // 순서상 Stop이 승인 요청과 뒤섞일 수 있어 제외한다.
          sess.pendingPermissions = sess.pendingPermissions.filter((p) => {
            if (isAskUserQuestion(p)) return false;
            if (sess.agentType !== "codex" && p.agentName === "main") return false;
            return true;
          });
          sess.state = sess.pendingPermissions.length > 0
            ? "permission"
            : subagentsBusy
              ? "working"
              : "idle";
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
          const sess = ensureSession(s, order, ev.session_id, withEventDefaults(ev.cwd, ev.agent_type));
          if (ev.source_pid != null && sess.sourcePid == null) sess.sourcePid = ev.source_pid;
          if (ev.pid_chain && ev.pid_chain.length > 0) sess.pidChain = ev.pid_chain;
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
          if (isTerminalApiError(ev.message)) {
            if (sess.state === "working" || sess.state === "error") {
              sess.justFinishedAt = Date.now();
            }
            sess.state = sess.pendingPermissions.length > 0 ? "permission" : "idle";
            sess.currentTool = undefined;
            sess.lastSeen = Date.now();
          } else if (sess.agentType === "codex" && sess.pendingPermissions.length === 0) {
            sess.state = "working";
            sess.lastSeen = Date.now();
          }
          break;
        }
      }
      return { sessions: s, sessionOrder: order };
    }),

  setIdle: (sessionId, force = false) =>
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess) return state;
      // 답변 대기 중인 요청이 남아 있으면 재우지 않는다. hook은 살아서 사용자
      // 응답을 기다리는 중이고, 그동안 이벤트가 하나도 오지 않아 lastSeen만으로는
      // "대기"와 "방치"를 구분할 수 없다.
      if (sess.pendingPermissions.length > 0) return state;
      const since = Date.now() - sess.lastSeen;
      if (!force && since < IDLE_DELAY_MS) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...sess, state: "idle", currentTool: undefined } },
      };
    }),

  clearBackgroundTasks: (sessionId, ids) =>
    set((state) => {
      const sess = state.sessions[sessionId];
      if (!sess || ids.length === 0) return state;
      const remaining = sess.backgroundTasks.filter((t) => !ids.includes(t.id));
      // 5초마다 도는 sweep이 매번 새 객체를 만들어 리렌더를 유발하지 않도록
      // 실제로 지워진 게 있을 때만 갱신한다.
      if (remaining.length === sess.backgroundTasks.length) return state;
      return {
        sessions: { ...state.sessions, [sessionId]: { ...sess, backgroundTasks: remaining } },
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
