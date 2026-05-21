import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "../types";
import { useStore } from "../store";

interface PermissionInlineProps {
  session: Session;
}

function pickAddRulesSuggestion(suggestions: unknown): unknown | undefined {
  if (!Array.isArray(suggestions)) return undefined;
  return suggestions.find(
    (s) => s && typeof s === "object" && (s as { type?: unknown }).type === "addRules",
  );
}

function synthesizeRule(toolName: string): unknown {
  return {
    type: "addRules",
    rules: [{ toolName, ruleContent: "*" }],
    destination: "localSettings",
    behavior: "allow",
  };
}

interface AskQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

// AskUserQuestion은 권한 요청이 아니라 실제 사용자 질문이다. PermissionRequest hook이
// 발화될 때 tool_input.questions에 전체 질문 페이로드가 실려온다. allow/deny를 묻는 건
// 의미가 없으므로 (실제 답은 TUI에서 옵션 선택) 검출되면 다른 UI로 분기한다.
function tryParseAskUserQuestion(toolName: string, toolInput: unknown): AskQuestion[] | null {
  if (toolName !== "AskUserQuestion") return null;
  if (!toolInput || typeof toolInput !== "object") return null;
  const raw = (toolInput as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return null;
  const parsed = raw.filter(
    (q): q is AskQuestion =>
      !!q &&
      typeof q === "object" &&
      typeof (q as AskQuestion).question === "string" &&
      Array.isArray((q as AskQuestion).options),
  );
  return parsed.length > 0 ? parsed : null;
}

export function PermissionInline({ session }: PermissionInlineProps) {
  const [busy, setBusy] = useState(false);
  const ack = useStore((s) => s.acknowledgePermission);
  const pp = session.pendingPermission;
  if (!pp) return null;
  const isCodex = session.agentType === "codex";

  const respond = async (behavior: "allow" | "deny", remember = false) => {
    if (busy) return;
    setBusy(true);
    try {
      let updatePermissions: unknown[] | undefined;
      if (remember) {
        const suggested = pickAddRulesSuggestion(pp.suggestions);
        updatePermissions = [suggested ?? synthesizeRule(pp.toolName)];
      }
      await invoke("respond_permission", {
        requestId: pp.requestId,
        behavior,
        remember,
        updatePermissions,
      });
      ack(session.sessionId);
    } finally {
      setBusy(false);
    }
  };

  // Codex 세션의 권한 요청은 우리가 직접 응답할 수 없다 — Codex 자체가
  // 자기 터미널에서 키 입력을 기다린다. 위젯 버튼은 그 터미널/IDE를 포커스
  // 시켜주는 역할만 한다.
  // autoAllow=true: AskUserQuestion처럼 y/n/a가 의미 없는 경우 hook을 allow로
  // 즉시 풀어줘서 TUI가 곧장 진짜 질문 UI를 띄우게 한다.
  const dismissAndFocus = async (autoAllow = false) => {
    if (busy) return;
    setBusy(true);
    try {
      // Focus는 respond_permission보다 먼저 — Claude가 AskUserQuestion 같은
      // 후속 UI를 렌더할 때 호스트 IDE/터미널이 이미 frontmost여야 입력이 그쪽으로
      // 그대로 흐른다. 반대 순서면 respond 직후 Claude가 IDE에 UI를 띄우는 도중
      // 우리가 osascript activate를 던지며 포커스가 한 번 흔들려서 답변이 사라진다.
      let focused = false;
      if (session.pidChain && session.pidChain.length > 0) {
        try {
          await invoke("focus_pid", { pidChain: session.pidChain });
          focused = true;
        } catch {
          /* fall through to app focus */
        }
      }
      if (!focused && isCodex) {
        try {
          await invoke("focus_app", { appName: "Codex" });
        } catch {
          /* best effort */
        }
      }
      if (autoAllow && !isCodex) {
        try {
          await invoke("respond_permission", {
            requestId: pp.requestId,
            behavior: "allow",
            remember: false,
            updatePermissions: undefined,
          });
        } catch {
          /* hook may have already timed out */
        }
      }
      ack(session.sessionId);
    } finally {
      setBusy(false);
    }
  };

  const askQuestions = tryParseAskUserQuestion(pp.toolName, pp.toolInput);
  if (askQuestions) {
    return (
      <div className="text-[11px] bg-amber-500/20 px-2 py-1.5 rounded space-y-1.5">
        <div className="font-semibold">❔ 질문 (응답은 터미널)</div>
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {askQuestions.map((q, qi) => (
            <div key={qi}>
              <div className="font-medium text-[10.5px] leading-tight">{q.question}</div>
              <ul className="mt-0.5 pl-2 space-y-0.5 text-[10px] opacity-90">
                {q.options.map((o, oi) => (
                  <li key={oi}>• {o.label}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <button
          onClick={() => dismissAndFocus(true)}
          className="w-full px-1.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 font-semibold"
          disabled={busy}
          title="해당 세션의 터미널/IDE 창으로 전환하여 답변"
        >
          ↗ 터미널에서 답변
        </button>
      </div>
    );
  }

  return (
    <div className="text-[11px] bg-amber-500/20 px-2 py-1.5 rounded space-y-1">
      <div className="font-semibold">⚠️ {pp.toolName} 허용?</div>
      {isCodex ? (
        <button
          onClick={() => dismissAndFocus()}
          className="w-full px-1.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 font-semibold"
          disabled={busy}
          title="해당 세션의 터미널/IDE 창으로 전환"
        >
          터미널에서 진행
        </button>
      ) : (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => respond("allow", true)}
            className="px-1.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 font-semibold"
            disabled={busy}
            title="이 도구를 항상 허용"
          >
            ✓✓ 항상 허용
          </button>
          <div className="flex gap-1">
            <button
              onClick={() => respond("allow")}
              className="flex-1 px-1.5 py-0.5 rounded bg-green-600 hover:bg-green-700 text-white disabled:opacity-50 font-semibold"
              disabled={busy}
            >
              한번만 허용
            </button>
            <button
              onClick={() => respond("deny")}
              className="flex-1 px-1.5 py-0.5 rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 font-semibold"
              disabled={busy}
            >
              거부
            </button>
          </div>
          <button
            onClick={() => dismissAndFocus()}
            className="px-1.5 py-0.5 rounded bg-slate-600 hover:bg-slate-500 text-white disabled:opacity-50 text-[10px]"
            disabled={busy}
            title="해당 세션의 터미널/IDE 창으로 전환 (단순 yes/no가 아닌 질문일 때)"
          >
            ↗ 터미널에서 진행
          </button>
        </div>
      )}
    </div>
  );
}
