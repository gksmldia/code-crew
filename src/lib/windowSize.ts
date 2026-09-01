export const MIN_WINDOW_WIDTH = 240;

export function cardRowWindowWidth(
  cardWidths: number[],
  gap: number,
  paddingLeft: number,
  paddingRight: number,
): number {
  const cardsWidth = cardWidths.reduce((sum, width) => sum + width, 0);
  const gapsWidth = Math.max(0, cardWidths.length - 1) * gap;
  return Math.max(MIN_WINDOW_WIDTH, cardsWidth + gapsWidth + paddingLeft + paddingRight);
}
