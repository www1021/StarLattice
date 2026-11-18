/**
 * 学科小游戏的数据结构。
 *
 * 工具（game.play）生成一份带 kind 标记的载荷，聊天层据此把它推成一张可玩的卡片；
 * 前端按 type 分派到对应组件。这里只管「游戏长什么样、怎么判分」，
 * 不碰 SSE、不碰 DOM，方便单测。
 */

export type GameType = "math_sprint" | "twenty_four" | "sudoku" | "flying_flower";

export type GameQuestion = {
  /** 题面，公式用 $...$ 包，前端按 KaTeX 排。 */
  stem: string;
  options: string[];
  /** 正确项下标。 */
  answer: number;
  /** 答错时给的一句话解析。 */
  explain: string;
};

type GameBase = {
  kind: "game";
  gameId: string;
  type: GameType;
  title: string;
  /** 一句话说明怎么玩，卡片顶部直接显示。 */
  rules: string;
};

export type MathSprintGame = GameBase & {
  type: "math_sprint";
  topic: string;
  /** 每题倒计时秒数；0 表示不限时。 */
  secondsPerQuestion: number;
  questions: GameQuestion[];
};

export type TwentyFourGame = GameBase & {
  type: "twenty_four";
  /** 每轮一组数字，hint 是一条参考解法（学生卡住时点提示看）。 */
  rounds: Array<{ numbers: number[]; hint: string }>;
  secondsPerRound: number;
};

export type SudokuGame = GameBase & {
  type: "sudoku";
  level: "easy" | "normal" | "hard";
  /** 81 个格子，行优先，0 表示空。 */
  puzzle: number[];
  /** 参考答案，只用于「看答案」，判分按规则合法性。 */
  solution: number[];
};

export type FlyingFlowerGame = GameBase & {
  type: "flying_flower";
  char: string;
  /** 计划接几轮。 */
  rounds: number;
  /** AI 先出的第一句，学生要接下一句。 */
  opener: { line: string; title: string; author: string };
};

export type GamePayload = MathSprintGame | TwentyFourGame | SudokuGame | FlyingFlowerGame;

export function isGamePayload(value: unknown): value is GamePayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<GamePayload>;
  return (
    candidate.kind === "game" &&
    typeof candidate.gameId === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.title === "string"
  );
}
