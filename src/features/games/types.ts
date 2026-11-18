/**
 * 前端侧的游戏数据结构，跟 server/games/types.ts 对应。
 * 这里单独写一份而不是 import 服务端代码：两端编译目标不同，
 * 而且前端只需要「怎么渲染」，不需要任何出题逻辑。
 */

export type GameQuestion = {
  stem: string;
  options: string[];
  answer: number;
  explain: string;
};

type GameBase = {
  kind: "game";
  gameId: string;
  title: string;
  rules: string;
};

export type MathSprintGame = GameBase & {
  type: "math_sprint";
  topic: string;
  secondsPerQuestion: number;
  questions: GameQuestion[];
};

export type TwentyFourGame = GameBase & {
  type: "twenty_four";
  rounds: Array<{ numbers: number[]; hint: string }>;
  secondsPerRound: number;
};

export type SudokuGame = GameBase & {
  type: "sudoku";
  level: "easy" | "normal" | "hard";
  puzzle: number[];
  solution: number[];
};

export type FlyingFlowerGame = GameBase & {
  type: "flying_flower";
  char: string;
  rounds: number;
  opener: { line: string; title: string; author: string };
};

export type GameCardData = MathSprintGame | TwentyFourGame | SudokuGame | FlyingFlowerGame;

export function isGameCardData(value: unknown): value is GameCardData {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<GameCardData>;
  return (
    candidate.kind === "game" &&
    typeof candidate.gameId === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.title === "string"
  );
}
