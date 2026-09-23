import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface SessionMenuProps {
  open: boolean;
  anchor: { top: number; left: number };
  /** Codex는 세션 명이 없어 ID만 복사한다 — 메뉴 문구도 그에 맞춘다. */
  hasTitle: boolean;
  onRename: () => void;
  onCopy: () => void;
  onClose: () => void;
}

// BreedPicker와 같은 방식의 카드 헤더 우클릭 메뉴.
export function SessionMenu({ open, anchor, hasTitle, onRename, onCopy, onClose }: SessionMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(anchor);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const MARGIN = 4;
    const maxLeft = Math.max(MARGIN, window.innerWidth - rect.width - MARGIN);
    const maxTop = Math.max(MARGIN, window.innerHeight - rect.height - MARGIN);
    setPos({
      top: Math.min(Math.max(MARGIN, anchor.top), maxTop),
      left: Math.min(Math.max(MARGIN, anchor.left), maxLeft),
    });
  }, [open, anchor.top, anchor.left]);

  if (!open) return null;

  // 전역 button 스타일(다크 모드 흰 글자·어두운 배경, 파란 hover 테두리, 그림자)을 덮어쓴다
  const item =
    "w-full px-2 py-1.5 text-left text-gray-900 bg-transparent hover:bg-black/5 active:bg-black/10 rounded-none border-0 shadow-none";
  return (
    <div
      ref={ref}
      role="menu"
      aria-label="세션 메뉴"
      className="fixed z-50 w-44 rounded-lg shadow-lg border border-black/15 bg-[#fdf7ea] text-gray-900 text-xs overflow-hidden py-1"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button type="button" role="menuitem" className={item} onClick={() => { onRename(); onClose(); }}>
        카드 이름 변경
      </button>
      <button type="button" role="menuitem" className={item} onClick={() => { onCopy(); onClose(); }}>
        {hasTitle ? "세션 명 & 아이디 복사" : "세션 아이디 복사"}
      </button>
    </div>
  );
}
