import { motion } from "framer-motion";
import clsx from "clsx";
import type { Message } from "../types";
import { Pet } from "./Pet";

interface ChatMessageProps {
  message: Message;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const bg = {
    tool: "bg-black/[0.06] dark:bg-white/[0.08]",
    error: "bg-red-500/15",
    permission: "bg-amber-500/20",
    info: "bg-transparent",
  }[message.kind];
  return (
    <motion.div
      initial={{ opacity: 0, x: -4 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex gap-1.5 items-start"
    >
      <div className="w-7 flex-shrink-0">
        <Pet animal={message.pet} state="typing" size="sm" />
      </div>
      <div className={clsx("flex-1 min-w-0 rounded-lg px-2 py-1", bg)}>
        <span
          className="inline-block text-[9px] font-semibold mb-0.5 px-1 rounded opacity-70"
          title={message.agentName}
        >
          {message.agentName}
        </span>
        <div className="text-[11px] leading-snug">
          {message.toolEmoji && <span className="mr-1">{message.toolEmoji}</span>}
          {message.toolName && <strong className="mr-1">{message.toolName}</strong>}
          <span>{message.text}</span>
        </div>
      </div>
    </motion.div>
  );
}
