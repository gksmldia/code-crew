import { motion, AnimatePresence } from "framer-motion";

interface SpeechBubbleProps {
  emoji?: string;
  toolName?: string;
  text: string;
  kind?: "tool" | "error" | "permission" | "info";
}

export function SpeechBubble({ emoji, toolName, text, kind = "tool" }: SpeechBubbleProps) {
  const bg = {
    tool: "bg-black/[0.06] dark:bg-white/[0.10]",
    error: "bg-red-500/15",
    permission: "bg-amber-500/20",
    info: "bg-black/[0.04] dark:bg-white/[0.06]",
  }[kind];
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={kind}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        className={`scrollbar-chunky w-full max-h-[80px] overflow-y-auto px-3 py-2 rounded-2xl text-xs leading-relaxed text-center max-w-[180px] border border-black/50 dark:border-white/50 ${bg}`}
      >
        {emoji && <span className="mr-1">{emoji}</span>}
        {toolName && <strong className="mr-1">{toolName}</strong>}
        <span>{text}</span>
      </motion.div>
    </AnimatePresence>
  );
}
