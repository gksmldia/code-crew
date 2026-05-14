import { shortNameOf } from "./pets";

const MAX_TEXT = 64;

export interface ToolMessage {
  toolName: string;
  toolEmoji: string;
  text: string;
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function truncate(s: string): string {
  return s.length <= MAX_TEXT ? s : s.slice(0, MAX_TEXT - 1) + "…";
}

export function messageFromTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): ToolMessage {
  const get = (k: string) => (typeof toolInput[k] === "string" ? (toolInput[k] as string) : "");
  switch (toolName) {
    case "Read":
      return { toolName, toolEmoji: "📖", text: truncate(`${basename(get("file_path"))} 읽는 중`) };
    case "Edit":
    case "MultiEdit":
      return { toolName, toolEmoji: "✍️", text: truncate(`${basename(get("file_path"))} 수정`) };
    case "Write":
      return { toolName, toolEmoji: "💾", text: truncate(`${basename(get("file_path"))} 작성`) };
    case "Bash":
      return { toolName, toolEmoji: "⚡", text: truncate(get("command") || "shell") };
    case "Grep":
      return { toolName, toolEmoji: "🔍", text: truncate(`"${get("pattern")}" 검색`) };
    case "Glob":
      return { toolName, toolEmoji: "🔎", text: truncate(`${get("pattern")} 매치`) };
    case "WebSearch":
      return { toolName, toolEmoji: "🌐", text: truncate(`"${get("query")}" 검색`) };
    case "WebFetch": {
      const url = get("url");
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch {}
      return { toolName, toolEmoji: "🌐", text: truncate(`${host} 가져오기`) };
    }
    case "Task": {
      const sub = get("subagent_type");
      const who = sub ? shortNameOf(sub) : "팀원";
      const prompt = get("prompt").slice(0, 30);
      return { toolName, toolEmoji: "🤝", text: truncate(`${who}한테 "${prompt}" 시킴`) };
    }
    case "NotebookEdit":
      return { toolName, toolEmoji: "📓", text: truncate(`셀 수정`) };
    default:
      return { toolName, toolEmoji: "⚙️", text: truncate(`${toolName} 실행`) };
  }
}
