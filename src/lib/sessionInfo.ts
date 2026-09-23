/** 다른 세션에 넘길 `/status` 형식의 세션 정보. 제목을 모르면(Codex 등) ID만 담는다. */
export function formatSessionInfo(sessionId: string, title?: string | null): string {
  const lines = [];
  if (title && title.trim()) lines.push(`Session name:   ${title.trim()}`);
  lines.push(`Session ID:     ${sessionId}`);
  return lines.join("\n");
}
