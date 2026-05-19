import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Session, PetState } from "../types";
import { mapSessionToPetState, RELIEVED_WINDOW_MS } from "../lib/petState";
import { isBreedId } from "../assets/breeds";
import { useStore } from "../store";
import { Pet } from "./Pet";
import { SpeechBubble } from "./SpeechBubble";
import { ChatMessage } from "./ChatMessage";
import { PermissionInline } from "./PermissionInline";
import { BreedPicker } from "./BreedPicker";

const DRAG_MIME = "application/x-code-crew-session-id";

interface PetCardProps {
  session: Session;
}

function statusEmoji(state: Session["state"]): string {
  return { idle: "💤", working: "⌨️", error: "😰", permission: "⚠️" }[state];
}

function agentBadge(agent: Session["agentType"]) {
  return agent === "claude"
    ? <span title="Claude Code" className="px-1.5 py-0.5 rounded text-[10px] bg-orange-500/20 text-orange-900">CC</span>
    : <span title="Codex" className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/20 text-emerald-900">GC</span>;
}

function fallbackText(state: Session["state"]): string {
  if (state === "working") return "working...";
  if (state === "error") return "에러";
  return "zzz...";
}

export function PetCard({ session }: PetCardProps) {
  const isTeam = session.subagents.length > 0;
  const lastRawMsg = session.messages[session.messages.length - 1];
  const lastMsg = (() => {
    if (!lastRawMsg) return undefined;
    if (lastRawMsg.kind === "permission" && !session.pendingPermission) return undefined;
    if ((lastRawMsg.kind === "tool" || lastRawMsg.kind === "error") && session.state === "idle") return undefined;
    if (lastRawMsg.kind === "info" && session.state === "working") return undefined;
    return lastRawMsg;
  })();
  const mainPet = session.pet;

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!session.justFinishedAt) return;
    const elapsed = Date.now() - session.justFinishedAt;
    const remaining = RELIEVED_WINDOW_MS - elapsed;
    if (remaining <= 0) return;
    const id = setTimeout(() => setNowTick(Date.now()), remaining + 50);
    return () => clearTimeout(id);
  }, [session.justFinishedAt]);

  const petState: PetState = mapSessionToPetState(
    session.state,
    session.justFinishedAt,
    nowTick,
  );

  const reorderSessions = useStore((s) => s.reorderSessions);
  const removeSession = useStore((s) => s.removeSession);
  const setBreed = useStore((s) => s.setBreed);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [session.messages.length]);

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_MIME, session.sessionId);
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  };
  const onDragEnd = () => {
    setDragging(false);
    setDropTarget(false);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
  };
  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setDropTarget(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDropTarget(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(false);
    const fromId = e.dataTransfer.getData(DRAG_MIME);
    if (fromId && fromId !== session.sessionId) {
      reorderSessions(fromId, session.sessionId);
    }
  };

  const onDoubleClickCard = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    const chain = session.pidChain && session.pidChain.length > 0
      ? session.pidChain
      : session.sourcePid != null ? [session.sourcePid] : [];
    const focusCodexApp = () => {
      void invoke("focus_app", { appName: "Codex" }).catch(() => undefined);
    };
    if (chain.length > 0) {
      void invoke("focus_pid", { pidChain: chain }).catch(() => {
        if (session.agentType === "codex") focusCodexApp();
      });
      return;
    }
    if (session.agentType === "codex") focusCodexApp();
  };

  return (
    <div
      data-card
      draggable
      onDoubleClick={onDoubleClickCard}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={clsx(
        "flex-shrink-0 w-[200px] h-full min-h-[200px] rounded-xl border p-3 flex flex-col cursor-grab active:cursor-grabbing",
        "bg-[#f5e9d4]/95 border-black/10 text-gray-900",
        session.state === "error" && "ring-2 ring-red-500/30",
        session.state === "permission" && "ring-2 ring-amber-500/40",
        dragging && "opacity-40",
        dropTarget && "ring-2 ring-blue-500/60",
      )}
    >
      <div className="flex items-center justify-between text-xs opacity-80 border-b border-dashed border-black/10 dark:border-white/10 pb-1.5 mb-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono font-semibold truncate">{session.displayName || "(?)"}</span>
          {agentBadge(session.agentType)}
        </div>
        <span className="flex items-center gap-1">
          {isTeam && <span className="text-[10px]">🤹 {session.subagents.length}</span>}
          <span>{statusEmoji(session.state)}</span>
          <button
            onClick={(e) => { e.stopPropagation(); removeSession(session.sessionId); }}
            onMouseDown={(e) => e.stopPropagation()}
            className="ml-0.5 w-4 h-4 flex items-center justify-center rounded hover:bg-black/10 dark:hover:bg-white/10 opacity-50 hover:opacity-100 text-[10px] leading-none"
            title="카드 닫기"
          >
            ×
          </button>
        </span>
      </div>
      <div className="text-[10px] opacity-60 truncate mb-1">
        {session.gitBranch || session.cwd}
      </div>

      {isTeam ? (
        <div ref={scrollRef} className="scrollbar-chunky flex-1 overflow-y-auto flex flex-col gap-1.5 pr-1">
          {session.messages.map((m) => (
            <ChatMessage key={m.id} message={m} />
          ))}
          {session.pendingPermission && (
            <PermissionInline session={session} />
          )}
        </div>
      ) : session.pendingPermission ? (
        <div className="scrollbar-chunky flex-1 overflow-y-auto flex flex-col items-center gap-1 pr-1">
          <Pet animal={mainPet} state={petState} size="md" />
          <PermissionInline session={session} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex flex-col items-center gap-1">
          <div
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setPickerAnchor({ top: rect.bottom + 4, left: rect.left });
              setPickerOpen(true);
            }}
          >
            <Pet animal={mainPet} state={petState} size="lg" />
          </div>
          <div className="flex-1 min-h-0 w-full flex flex-col items-center">
            {lastMsg ? (
              <SpeechBubble
                emoji={lastMsg.toolEmoji}
                toolName={lastMsg.toolName}
                text={lastMsg.text}
                kind={lastMsg.kind}
              />
            ) : (
              <SpeechBubble text={fallbackText(session.state)} kind="info" />
            )}
          </div>
        </div>
      )}
      <BreedPicker
        open={pickerOpen}
        currentBreed={session.pet}
        onSelect={(b) => {
          if (isBreedId(b)) setBreed(session.sessionId, b);
        }}
        onClose={() => setPickerOpen(false)}
        anchor={pickerAnchor}
      />
    </div>
  );
}
