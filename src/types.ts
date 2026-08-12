export type SessionState = "idle" | "working" | "error" | "permission";

/**
 * Identifier of a specific dog illustration in one of the breed sprite
 * sheets, e.g. "a-welsh-corgi" or "c-pembroke-corgi". Defined as `string`
 * rather than a hand-maintained union of all 50 ids so the breed catalog can
 * grow without a type churn — runtime lookup falls back deterministically
 * when an unknown id arrives (see `assets/pets.tsx`).
 */
export type PetType = string;

export type PetState = "sleeping" | "typing" | "surprised" | "disappointed" | "relieved";

export type AgentType = "claude" | "codex";

export type MessageKind = "tool" | "error" | "permission" | "info";

export interface Message {
  id: string;
  agentName: string;
  pet: PetType;
  toolEmoji?: string;
  toolName?: string;
  text: string;
  kind: MessageKind;
  timestamp: number;
}

export interface Subagent {
  id: string;
  name: string;
  shortName: string;
  state: SessionState;
  transcriptPath?: string;
}

export interface PendingPermission {
  requestId: string;
  toolName: string;
  toolInput: unknown;
  suggestions?: unknown;
  /** Subagent display name when the request came from a subagent, else
   *  undefined (i.e. main agent). Used to label which subagent is asking
   *  when several concurrent requests stack up. */
  agentName?: string;
}

export interface Session {
  sessionId: string;
  agentType: AgentType;
  cwd: string;
  gitBranch?: string;
  projectKey: string;
  displayName: string;
  state: SessionState;
  currentTool?: string;
  messages: Message[];
  subagents: Subagent[];
  /** Queue of permission/question requests still waiting on a user
   *  decision. Subagents can fire several concurrently — a single slot
   *  would drop all but the most recent and leave the older hook
   *  processes parked on /permission until they timed out. */
  pendingPermissions: PendingPermission[];
  lastSeen: number;
  /** Timestamp set when the session transitioned working → idle via a Stop
   *  event. Drives the transient "relieved" PetState for ~3 s. */
  justFinishedAt?: number;
  /** 메인 에이전트가 이번 턴을 Stop으로 끝냈는지. Claude Code의 팀/백그라운드
   *  Agent는 메인 Stop 뒤에도 계속 돌기 때문에 "메인 Stop"과 "마지막
   *  서브에이전트 종료" 중 어느 한쪽만으로는 세션 종료를 판정할 수 없다.
   *  다음 턴이 시작되면(UserPromptSubmit·메인 PreToolUse) 다시 false. */
  mainStopped?: boolean;
  pet: PetType;
  mainTranscriptPath?: string;
  subagentByPath: Record<string, { name: string; shortName: string }>;
  pendingSubagentTypes: string[];
  /** 직전 AskUserQuestion PreToolUse의 에이전트 라벨. 뒤따르는
   *  PermissionRequest에는 서브에이전트 정보가 없어 "main"으로 오분류되는데,
   *  이 값으로 실제 질문 주체를 배너에 붙여준다. */
  lastAskAgent?: string;
  /** GUI host PID captured by `code-crew-hook` walking up its PPID chain. */
  sourcePid?: number;
  /** Full ancestor PID list (innermost first). Tried in order on focus so
   *  a non-window-owning Helper PID falls back to the outer GUI app. */
  pidChain?: number[];
}

export type Event =
  | { kind: "SessionStart"; session_id: string; cwd: string; agent_type: AgentType; source_pid?: number | null; pid_chain?: number[] | null }
  | { kind: "SessionEnd"; session_id: string }
  | { kind: "UserPromptSubmit"; session_id: string; cwd?: string | null; agent_type?: AgentType | null; source_pid?: number | null; pid_chain?: number[] | null; transcript_path?: string | null }
  | { kind: "PreToolUse"; session_id: string; cwd?: string | null; tool_name: string; tool_input: unknown; transcript_path?: string | null; agent_name?: string | null; agent_type?: AgentType | null; source_pid?: number | null; pid_chain?: number[] | null }
  | { kind: "PostToolUse"; session_id: string; cwd?: string | null; tool_name: string; success: boolean; transcript_path?: string | null; agent_name?: string | null; agent_type?: AgentType | null; source_pid?: number | null; pid_chain?: number[] | null }
  | { kind: "SubagentStart"; session_id: string; cwd?: string | null; subagent_id: string; subagent_type: string; transcript_path?: string | null }
  | { kind: "SubagentStop"; session_id: string; cwd?: string | null; subagent_id: string }
  | { kind: "PermissionRequest"; session_id: string; cwd?: string | null; tool_name: string; tool_input: unknown; request_id: string; suggestions?: unknown; agent_name?: string | null; agent_type?: AgentType | null; source_pid?: number | null; pid_chain?: number[] | null }
  | { kind: "PermissionCancel"; request_id: string }
  | { kind: "Stop"; session_id: string; cwd?: string | null; agent_type?: AgentType | null; source_pid?: number | null; pid_chain?: number[] | null }
  | { kind: "Notification"; session_id: string; cwd?: string | null; message: string; agent_type?: AgentType | null; source_pid?: number | null; pid_chain?: number[] | null };
