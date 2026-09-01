// 한 줄로 늘어선 요소들이 넘치지 않는 최소 폭(요소 폭 + 갭 + 좌우 패딩).
export function rowContentWidth(
  widths: number[],
  gap: number,
  paddingLeft: number,
  paddingRight: number,
): number {
  const contentWidth = widths.reduce((sum, width) => sum + width, 0);
  const gapsWidth = Math.max(0, widths.length - 1) * gap;
  return Math.ceil(contentWidth + gapsWidth + paddingLeft + paddingRight);
}
