/**
 * 数独：先生成一张完整合法盘面，再按难度挖空，挖的过程中保证「仍然只有唯一解」。
 *
 * 唯一解这点值得多花几十毫秒：多解盘面学生填出一个合法解却被告知不对，
 * 比题目难一点更伤人。判分在前端按规则校验（行列宫不重复且填满），
 * 所以即使学生填出的是另一条路径，只要合法就算过。
 */

import type { SudokuGame } from "./types.js";
import { gameId } from "./ids.js";

const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = randInt(0, index);
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

/** 这一格放 value 会不会和同行、同列、同宫的已有数字撞。 */
function fits(board: number[], index: number, value: number): boolean {
  const row = Math.floor(index / 9);
  const column = index % 9;
  for (let step = 0; step < 9; step += 1) {
    if (board[row * 9 + step] === value) return false;
    if (board[step * 9 + column] === value) return false;
  }
  const boxRow = Math.floor(row / 3) * 3;
  const boxColumn = Math.floor(column / 3) * 3;
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      if (board[(boxRow + r) * 9 + boxColumn + c] === value) return false;
    }
  }
  return true;
}

function candidates(board: number[], index: number): number[] {
  const result: number[] = [];
  for (let value = 1; value <= 9; value += 1) {
    if (fits(board, index, value)) {
      result.push(value);
    }
  }
  return result;
}

/** 挑候选最少的空格先填（MRV），回溯规模小很多。 */
function nextCell(board: number[]): { index: number; values: number[] } | null {
  let best: { index: number; values: number[] } | null = null;
  for (let index = 0; index < 81; index += 1) {
    if (board[index] !== 0) {
      continue;
    }
    const values = candidates(board, index);
    if (values.length === 0) {
      return { index, values };
    }
    if (!best || values.length < best.values.length) {
      best = { index, values };
      if (values.length === 1) {
        break;
      }
    }
  }
  return best;
}

function fill(board: number[]): boolean {
  const cell = nextCell(board);
  if (!cell) {
    return true;
  }
  for (const value of shuffle(cell.values)) {
    board[cell.index] = value;
    if (fill(board)) {
      return true;
    }
    board[cell.index] = 0;
  }
  return false;
}

/** 数一数这个盘面有几个解，数到 limit 就停——挖洞时只需要知道「是不是唯一」。 */
function countSolutions(board: number[], limit = 2): number {
  const cell = nextCell(board);
  if (!cell) {
    return 1;
  }
  let total = 0;
  for (const value of cell.values) {
    board[cell.index] = value;
    total += countSolutions(board, limit - total);
    board[cell.index] = 0;
    if (total >= limit) {
      return total;
    }
  }
  return total;
}

function generateSolved(): number[] {
  const board = new Array(81).fill(0);
  fill(board);
  return board;
}

function carve(solution: number[], holes: number): number[] {
  const puzzle = [...solution];
  let removed = 0;
  for (const index of shuffle([...Array(81).keys()])) {
    if (removed >= holes) {
      break;
    }
    const backup = puzzle[index];
    puzzle[index] = 0;
    if (countSolutions([...puzzle], 2) === 1) {
      removed += 1;
    } else {
      puzzle[index] = backup;
    }
  }
  return puzzle;
}

export type SudokuOptions = {
  level?: "easy" | "normal" | "hard";
};

const HOLES: Record<"easy" | "normal" | "hard", number> = {
  easy: 38,
  normal: 48,
  hard: 54
};

export function createSudoku(options: SudokuOptions = {}): SudokuGame {
  const level = options.level ?? "normal";
  const solution = generateSolved();
  const puzzle = carve(solution, HOLES[level]);
  const blanks = puzzle.filter((value) => value === 0).length;
  return {
    kind: "game",
    gameId: gameId("sudoku"),
    type: "sudoku",
    title: "数独",
    rules: `每行、每列、每个 3×3 宫内 1-9 不重复。这盘有 ${blanks} 个空格。`,
    level,
    puzzle,
    solution
  };
}
