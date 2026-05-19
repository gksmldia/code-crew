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
  pendingPermission?: PendingPermission;
  lastSeen: number;
  /** Timestamp set when the session transitioned working → idle via a Stop
   *  event. Drives the transient "relieved" PetState for ~3 s. */
  justFinishedAt?: number;
  pet: PetType;
  mainTranscriptPath?: string;
  subagentByPath: Record<string, { name: string; shortName: string }>;
  pendingSubagentTypes: string[];
  /** GUI host PID captured by `code-crew-hook` walking up its PPID chain. */
  sourcePid?: number;
  /** Full ancestor PID list (innermost first). Tried in order on focus so
   *  a non-window-owning Helper PID falls back to the outer GUI app. */
  pidChain?: number[];
}

export type Event =
  | { kind: "SessionStart"; session_id: string; cwd: string; agent_type: AgentType; source_pid?: number | null; pid_chain?: number[] | null }
  | { kind: "SessionEnd"; session_id: string }
  | { kind: "UserPromptSubmit"; session_id: string; cwd?: string | null }
  | { kind: "PreToolUse"; session_id: string; cwd?: string | null; tool_name: string; tool_input: unknown; transcript_path?: string | null; agent_name?: string | null; source_pid?: number | null; pid_chain?: number[] | null }
  | { kind: "PostToolUse"; session_id: string; cwd?: string | null; tool_name: string; success: boolean; transcript_path?: string | null; agent_name?: string | null }
  | { kind: "SubagentStart"; session_id: string; cwd?: string | null; subagent_id: string; subagent_type: string; transcript_path?: string | null }
  | { kind: "SubagentStop"; session_id: string; cwd?: string | null; subagent_id: string }
  | { kind: "PermissionRequest"; session_id: string; cwd?: string | null; tool_name: string; tool_input: unknown; request_id: string; suggestions?: unknown }
  | { kind: "PermissionCancel"; request_id: string }
  | { kind: "Stop"; session_id: string; cwd?: string | null }
  | { kind: "Notification"; session_id: string; cwd?: string | null; message: string };
