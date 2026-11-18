/** 一局游戏的标识：前端用它区分「同一张卡片被重复推送」和「新开一局」。 */
export function gameId(prefix: string): string {
  const stamp = Date.now().toString(36);
  const noise = Math.random().toString(36).slice(2, 6);
  return `g_${prefix}_${stamp}${noise}`;
}
