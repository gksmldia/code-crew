import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BREEDS } from "../assets/breeds";
import type { BreedId } from "../assets/breeds";

const BREED_ICONS = import.meta.glob<{ default: string }>(
  "../assets/pets/breed_icons/*.png",
  { eager: true },
);

function iconFor(breedId: string): string {
  return BREED_ICONS[`../assets/pets/breed_icons/${breedId}.png`]?.default ?? "";
}

interface BreedPickerProps {
  open: boolean;
  currentBreed: string;
  onSelect: (breed: BreedId) => void;
  onClose: () => void;
  anchor: { top: number; left: number };
}

export function BreedPicker({ open, currentBreed, onSelect, onClose, anchor }: BreedPickerProps) {
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

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="펫 변경"
      className="fixed z-50 w-44 rounded-lg shadow-lg border border-black/15 bg-[#fdf7ea] text-gray-900 text-xs overflow-hidden"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-2 py-1.5 text-[11px] font-semibold border-b border-black/10 bg-black/5">
        펫 변경
      </div>
      <ul className="max-h-64 overflow-y-auto py-1">
        {BREEDS.map((b) => {
          const selected = b.id === currentBreed;
          return (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(b.id);
                  onClose();
                }}
                className={
                  "w-full px-2 py-1 flex items-center gap-2 text-left hover:bg-black/5 " +
                  (selected ? "bg-amber-200/60 font-medium text-black" : "")
                }
              >
                <img
                  src={iconFor(b.id)}
                  alt=""
                  width={24}
                  height={24}
                  draggable={false}
                  style={{ objectFit: "contain" }}
                />
                <span className="flex-1 truncate">{b.label}</span>
                {selected && <span aria-hidden>✓</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
