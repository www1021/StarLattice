/**
 * 24 点：给四个数，用 + − × ÷ 和括号凑出 24，每个数只能用一次。
 *
 * 出题靠回溯验证「这组数真的有解」，顺便记下一条参考解法当提示，
 * 避免给学生一组无解的数。求解器同时导出给测试用。
 */

import type { TwentyFourGame } from "./types.js";
import { gameId } from "./ids.js";

const TARGET = 24;
const EPSILON = 1e-6;

type Item = { value: number; expr: string };

function combine(left: Item, right: Item): Item[] {
  const result: Item[] = [
    { value: left.value + right.value, expr: `(${left.expr} + ${right.expr})` },
    { value: left.value - right.value, expr: `(${left.expr} - ${right.expr})` },
    { value: right.value - left.value, expr: `(${right.expr} - ${left.expr})` },
    { value: left.value * right.value, expr: `(${left.expr} × ${right.expr})` }
  ];
  if (Math.abs(right.value) > EPSILON) {
    result.push({ value: left.value / right.value, expr: `(${left.expr} ÷ ${right.expr})` });
  }
  if (Math.abs(left.value) > EPSILON) {
    result.push({ value: right.value / left.value, expr: `(${right.expr} ÷ ${left.expr})` });
  }
  return result;
}

function search(items: Item[]): string | null {
  if (items.length === 1) {
    return Math.abs(items[0].value - TARGET) < EPSILON ? items[0].expr : null;
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const rest = items.filter((_, index) => index !== i && index !== j);
      for (const merged of combine(items[i], items[j])) {
        const found = search([...rest, merged]);
        if (found) {
          return found;
        }
      }
    }
  }
  return null;
}

/** 返回一条能凑出 24 的解法（去掉最外层括号）；无解返回 null。 */
export function solveTwentyFour(numbers: number[]): string | null {
  if (numbers.length !== 4) {
    return null;
  }
  const found = search(numbers.map((value) => ({ value, expr: String(value) })));
  if (!found) {
    return null;
  }
  return found.startsWith("(") && found.endsWith(")") ? found.slice(1, -1) : found;
}

const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

export type TwentyFourOptions = {
  rounds?: number;
  level?: "easy" | "normal" | "hard";
};

export function createTwentyFour(options: TwentyFourOptions = {}): TwentyFourGame {
  const rounds = Math.min(6, Math.max(1, Math.round(options.rounds ?? 3)));
  const level = options.level ?? "normal";
  const max = level === "easy" ? 9 : level === "hard" ? 13 : 10;

  const prepared: Array<{ numbers: number[]; hint: string }> = [];
  const seen = new Set<string>();
  for (let attempt = 0; prepared.length < rounds && attempt < rounds * 400; attempt += 1) {
    const numbers = Array.from({ length: 4 }, () => randInt(1, max));
    const key = [...numbers].sort((left, right) => left - right).join(",");
    if (seen.has(key)) {
      continue;
    }
    const hint = solveTwentyFour(numbers);
    if (!hint) {
      continue;
    }
    seen.add(key);
    prepared.push({ numbers, hint });
  }

  // 极端情况下（连续几百组无解）兜底给一组经典题，保证卡片不空。
  if (prepared.length === 0) {
    prepared.push({ numbers: [3, 3, 8, 8], hint: solveTwentyFour([3, 3, 8, 8]) ?? "8 ÷ (3 - 8 ÷ 3)" });
  }

  return {
    kind: "game",
    gameId: gameId("24"),
    type: "twenty_four",
    title: "24 点",
    rules: "四个数各用一次，用 + − × ÷ 和括号凑出 24。",
    secondsPerRound: level === "hard" ? 90 : 60,
    rounds: prepared
  };
}
