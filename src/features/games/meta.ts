import { Blocks, Dices, Feather, Grid3x3, ScrollText, Zap } from "lucide-react";
import type { GameCardData } from "./types";

/** 六种玩法的图标与徽标，卡片头和聊天里的入口共用一份，避免两处写得不一样。 */
export const GAME_ICONS: Record<GameCardData["type"], typeof Zap> = {
  math_sprint: Zap,
  twenty_four: Dices,
  sudoku: Grid3x3,
  flying_flower: Feather,
  poetry_order: ScrollText,
  word_spell: Blocks
};

export const GAME_BADGES: Record<GameCardData["type"], string> = {
  math_sprint: "速算",
  twenty_four: "24 点",
  sudoku: "数独",
  flying_flower: "飞花令",
  poetry_order: "拼诗句",
  word_spell: "拼单词"
};

/** 智能体挂了这把工具才能开一局。 */
export const GAME_TOOL_ID = "game.play";

export type GameEntry = {
  type: GameCardData["type"];
  label: string;
  /** 点进去发给智能体的那句话：直接说清玩法，模型不必再猜。 */
  prompt: string;
};

/** 入口按学科排：数学三个、语文两个（拼句在前，飞花令在后）、英语一个。 */
export const GAME_ENTRIES: GameEntry[] = [
  { type: "math_sprint", label: "速算挑战", prompt: "来一局速算，五年级分数，4 道题" },
  { type: "twenty_four", label: "24 点", prompt: "来一局 24 点，普通难度，3 组" },
  { type: "sudoku", label: "数独", prompt: "来一局数独，简单档" },
  { type: "poetry_order", label: "拼诗句", prompt: "来一局诗句拼句，五年级，简单一点" },
  { type: "flying_flower", label: "飞花令", prompt: "来一局飞花令，令字用「月」" },
  { type: "word_spell", label: "拼单词", prompt: "来一局单词拼写，小学单词，简单档" }
];

/** 智能体工具表里有没有游戏。 */
export function supportsGames(tools: string[] | undefined): boolean {
  return Array.isArray(tools) && tools.includes(GAME_TOOL_ID);
}
