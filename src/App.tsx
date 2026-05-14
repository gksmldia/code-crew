import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore } from "./store";
import { PetCard } from "./components/PetCard";
import { useIdleSweep } from "./hooks/useIdleSweep";
import type { Event, Message } from "./types";
import "./App.css";

interface ProjectFile {
  project_key: string;
  display_name: string;
  messages: Array<{
    id: string;
    agent_name: string;
    pet: Message["pet"];
    tool_emoji?: string;
    tool_name?: string;
    text: string;
    kind: Message["kind"];
    timestamp: number;
  }>;
}

async function deriveProjectKey(cwd: string): Promise<string> {
  try {
    return await invoke<string>("derive_project_key", { cwd });
  } catch {
    return cwd;
  }
}

async function deriveDisplayName(cwd: string): Promise<string | null> {
  try {
    return await invoke<string>("derive_display_name", { cwd });
  } catch {
    return null;
  }
}

function App() {
  useIdleSweep();
  const sessions = useStore((s) => s.sessions);
  const sessionOrder = useStore((s) => s.sessionOrder);
  const applyEvent = useStore((s) => s.applyEvent);
  const addRestored = useStore((s) => s.addRestoredMessages);
  const restoredRef = useRef<Set<string>>(new Set());
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      if (e.deltaX !== 0) return;
      // If the cursor sits inside a child that can scroll vertically, leave the
      // event alone — converting deltaY into scrollLeft would otherwise
      // cannibalize the inner message lists' wheel scroll.
      let node = e.target as HTMLElement | null;
      while (node && node !== el) {
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY;
        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          node.scrollHeight > node.clientHeight
        ) {
          return;
        }
        node = node.parentElement;
      }
      // No inner vertical scroll consumer — translate vertical wheel into
      // horizontal pan over the card row. Half-speed so a single flick doesn't
      // overshoot; native horizontal wheel (deltaX) is left alone.
      e.preventDefault();
      el.scrollLeft += e.deltaY * 0.5;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const un = listen<Event>("event", async (e) => {
      const ev = e.payload;
      applyEvent(ev);
      if (ev.kind === "SessionStart" && !restoredRef.current.has(ev.session_id)) {
        restoredRef.current.add(ev.session_id);
        const [projectKey, displayName] = await Promise.all([
          deriveProjectKey(ev.cwd),
          deriveDisplayName(ev.cwd),
        ]);
        useStore.getState().setProjectKey(ev.session_id, projectKey);
        if (displayName) useStore.getState().setDisplayName(ev.session_id, displayName);
        const file = await invoke<ProjectFile | null>("load_project_history", { projectKey });
        if (file) {
          const msgs: Message[] = file.messages.map((m) => ({
            id: m.id,
            agentName: m.agent_name,
            pet: m.pet,
            toolEmoji: m.tool_emoji,
            toolName: m.tool_name,
            text: m.text,
            kind: m.kind,
            timestamp: m.timestamp,
          }));
          addRestored(ev.session_id, msgs);
        }
      }
    });
    return () => {
      un.then((u) => u());
    };
  }, [applyEvent, addRestored]);

  const list = sessionOrder
    .map((id) => sessions[id])
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  const startDrag = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    if (target.closest("[data-card]")) return;
    void getCurrentWindow().startDragging();
  };

  return (
    <div className="h-full flex flex-col bg-white/55 dark:bg-gray-900/55 backdrop-blur">
      <header
        className="h-10 px-3 flex items-center gap-2 text-xs border-b border-black/10 dark:border-white/10 select-none"
        onMouseDown={startDrag}
      >
        <span>🐾</span>
        <span className="font-semibold">code-crew</span>
        <span className="opacity-60">{list.length} sessions</span>
        <span className="flex-1" />
        <button
          onClick={() => getCurrentWindow().hide()}
          className="px-2 py-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10"
          title="Hide"
        >
          —
        </button>
        <button
          onClick={() => getCurrentWindow().hide()}
          className="px-2 py-0.5 rounded hover:bg-red-500/30"
          title="Close"
        >
          ×
        </button>
      </header>
      <div ref={scrollerRef} className="flex-1 overflow-x-auto overflow-y-hidden flex gap-3 p-3" onMouseDown={startDrag}>
        {list.length === 0 ? (
          <div className="flex items-center justify-center flex-1 text-sm opacity-50">
            세션이 시작되면 여기에 펫이 나타나요
          </div>
        ) : (
          list.map((s) => <PetCard key={s.sessionId} session={s} />)
        )}
      </div>
    </div>
  );
}

export default App;
