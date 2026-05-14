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
      if (isCodex) {
        ack(session.sessionId);
        return;
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

  return (
    <div className="text-[11px] bg-amber-500/20 px-2 py-1.5 rounded space-y-1">
      <div className="font-semibold">⚠️ {pp.toolName} 허용?</div>
      {isCodex ? (
        <button
          onClick={() => respond("deny")}
          className="w-full px-1.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 font-semibold"
          disabled={busy}
          title="Codex 앱에서 승인 또는 거부한 뒤 닫기"
        >
          Codex에서 처리
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
        </div>
      )}
    </div>
  );
}
