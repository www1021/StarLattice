/**
 * 数学速算：按学段出题，四选一，答错给一句错因。
 *
 * 出题全在本地算，不走模型——这样一局 8 道题是毫秒级返回，
 * 学生点「再来一局」不用等十几秒；题目也稳定，不会今天对明天错。
 * 模型负责的是「要不要玩、玩哪个」这件事，不负责算题。
 */

import type { GameQuestion, MathSprintGame } from "./types.js";
import { gameId } from "./ids.js";

type Level = "easy" | "normal" | "hard";

export type MathSprintOptions = {
  /** 1-9，按学段决定题型；缺省按 5 年级。 */
  grade?: number;
  /** 指定知识点，命中时优先出这类题。 */
  topic?: string;
  count?: number;
  difficulty?: Level;
};

const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = <T>(items: T[]): T => items[randInt(0, items.length - 1)];

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = randInt(0, index);
    [copy[index], copy[target]] = [copy[target], copy[index]];
  }
  return copy;
}

function gcd(left: number, right: number): number {
  return right === 0 ? Math.abs(left) : gcd(right, left % right);
}

/** 围绕正确答案造三个像样的错项，别出现负数或一眼假的数。 */
function numericWrongs(correct: number, allowNegative = false): string[] {
  const offsets = [1, -1, 2, 10, -10, 3, 5, -2, 20];
  const wrongs: string[] = [];
  for (const offset of offsets) {
    const value = correct + offset;
    if (!allowNegative && value < 0) {
      continue;
    }
    if (value === correct) {
      continue;
    }
    const text = String(value);
    if (!wrongs.includes(text)) {
      wrongs.push(text);
    }
    if (wrongs.length === 3) {
      return wrongs;
    }
  }
  // 兜底：偏移都被过滤掉时补几个能看的数（比如答案是 0）。
  let filler = correct + 4;
  while (wrongs.length < 3) {
    if (filler !== correct) {
      wrongs.push(String(filler));
    }
    filler += 1;
  }
  return wrongs;
}

function frac(numerator: number, denominator: number): string {
  if (denominator === 1) {
    return String(numerator);
  }
  return `\\frac{${numerator}}{${denominator}}`;
}

/** 分数化简到最简；假分数保留假分数形态，跟教材一致。 */
function simplify(numerator: number, denominator: number): { numerator: number; denominator: number } {
  const divisor = gcd(numerator, denominator) || 1;
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

type Draft = { stem: string; correct: string; wrongs: string[]; explain: string };

function draftAddSub(max: number, carry: boolean): Draft {
  const left = randInt(1, max);
  const right = randInt(1, max);
  const plus = Math.random() < 0.5;
  const value = plus ? left + right : Math.max(left, right) - Math.min(left, right);
  const [a, b] = plus ? [left, right] : [Math.max(left, right), Math.min(left, right)];
  const stem = plus ? `$${a} + ${b} = ?$` : `$${a} - ${b} = ?$`;
  const explain = plus
    ? `${a} 加 ${b}，个位相加${carry ? "要进位" : ""}，得 ${value}。`
    : `${a} 减 ${b}，退回正确的位再减，得 ${value}。`;
  return { stem, correct: String(value), wrongs: numericWrongs(value), explain };
}

function draftMulTable(level: Level): Draft {
  const a = randInt(2, level === "hard" ? 12 : 9);
  const b = randInt(2, level === "hard" ? 12 : 9);
  const value = a * b;
  return {
    stem: `$${a} \\times ${b} = ?$`,
    correct: String(value),
    // 乘法最典型的错法是少乘一轮（隔一个数背错）。
    wrongs: [...new Set([String(value + a), String(value - a), String(value + b), String(value - b)])]
      .filter((text) => Number(text) >= 0 && Number(text) !== value)
      .slice(0, 3),
    explain: `${a} 个 ${b} 相加是 ${value}，乘法口诀里对应「${Math.min(a, b)}${Math.max(a, b)}」。`
  };
}

function draftMulBig(): Draft {
  const a = randInt(12, 39);
  const b = randInt(3, 9);
  const value = a * b;
  return {
    stem: `$${a} \\times ${b} = ?$`,
    correct: String(value),
    wrongs: numericWrongs(value),
    explain: `拆成 ${a} × ${b} = ${Math.floor(a / 10) * 10} × ${b} + ${a % 10} × ${b} = ${value}。`
  };
}

function draftMixed(): Draft {
  const a = randInt(2, 12);
  const b = randInt(2, 9);
  const c = randInt(2, 9);
  const useBracket = Math.random() < 0.4;
  const value = useBracket ? a * (b + c) : a + b * c;
  const stem = useBracket ? `$${a} \\times (${b} + ${c}) = ?$` : `$${a} + ${b} \\times ${c} = ?$`;
  const trap = useBracket ? a * b + c : (a + b) * c;
  return {
    stem,
    correct: String(value),
    wrongs: [...new Set([String(trap), String(value + a), String(value - b)])].filter(
      (text) => Number(text) !== value && Number(text) >= 0
    ),
    explain: useBracket
      ? `先算括号里的 ${b} + ${c} = ${b + c}，再乘 ${a}，得 ${value}。`
      : "先算乘法再算加法，顺序反了答案就变了。"
  };
}

function draftFraction(): Draft {
  const denominator = randInt(3, 12);
  // 加数用最简分数，避免出现 $\frac{4}{8}$ 这种教材里不会写的式子。
  const left = coprimeNumerator(denominator);
  const right = coprimeNumerator(denominator, left);
  const raw = { numerator: left + right, denominator };
  const simplified = simplify(raw.numerator, raw.denominator);
  const correct = frac(simplified.numerator, simplified.denominator);
  const wrongs = [
    // 分母也相加，是最常见的错。
    frac(raw.numerator, denominator * 2),
    // 忘了约分。
    frac(raw.numerator, raw.denominator),
    // 只把其中一个分子加错了。
    frac(left + 1, denominator)
  ];
  return {
    stem: `$\\frac{${left}}{${denominator}} + \\frac{${right}}{${denominator}} = ?$`,
    correct,
    wrongs,
    explain: `同分母分数相加，分母不变、分子相加：${left} + ${right} = ${raw.numerator}，结果是 $${correct}$。`
  };
}

/** 取一个与分母互质的分子，让每个加数本身是最简分数。 */
function coprimeNumerator(denominator: number, exclude = 0): number {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = randInt(1, Math.max(1, denominator - 1));
    if (value !== exclude && gcd(value, denominator) === 1) {
      return value;
    }
  }
  return 1;
}

function draftDecimal(): Draft {
  const left = randInt(1, 89) / 10;
  const right = randInt(1, 89) / 10;
  const value = Math.round((left + right) * 10) / 10;
  return {
    stem: `$${left.toFixed(1)} + ${right.toFixed(1)} = ?$`,
    correct: value.toFixed(1),
    wrongs: numericWrongs(value).map((text) => Number(text).toFixed(1)),
    explain: `小数点对齐再相加，${left.toFixed(1)} + ${right.toFixed(1)} = ${value.toFixed(1)}。`
  };
}

function draftNegative(): Draft {
  const a = randInt(-12, -2);
  const b = randInt(2, 12);
  const plus = Math.random() < 0.5;
  const value = plus ? a + b : a - b;
  return {
    stem: plus ? `$${a} + ${b} = ?$` : `$${a} - ${b} = ?$`,
    correct: String(value),
    wrongs: numericWrongs(value, true),
    explain: plus
      ? `负数加正数，先看谁的绝对值大：${Math.abs(a)} 比 ${b} 大，结果是负的 ${Math.abs(value)}。`
      : `减去一个正数等于加上它的相反数：${a} + (${-b}) = ${value}。`
  };
}

function draftLinear(): Draft {
  const a = randInt(2, 9);
  const x = randInt(1, 12);
  const b = randInt(1, 20);
  const c = a * x + b;
  return {
    stem: `解方程 $${a}x + ${b} = ${c}$`,
    correct: String(x),
    wrongs: [...new Set([String(c + b), String(c - b), String(-x), String(x + 1)])].filter(
      (text) => text !== String(x)
    ).slice(0, 3),
    explain: `先把 ${b} 移到右边：$${a}x = ${c} - ${b} = ${c - b}$，再两边除以 ${a}，得 $x = ${x}$。`
  };
}

/** 按学段挑题型；topic 写了关键词就优先出对应的题。 */
function pickDraft(grade: number, topic: string, level: Level): Draft {
  if (/分数/.test(topic)) return draftFraction();
  if (/小数/.test(topic)) return draftDecimal();
  if (/方程/.test(topic)) return draftLinear();
  if (/负数|有理数/.test(topic)) return draftNegative();
  if (/乘/.test(topic)) return grade <= 3 ? draftMulTable(level) : draftMulBig();
  if (/加减|口算|计算/.test(topic)) {
    return grade <= 2 ? draftAddSub(20, true) : draftAddSub(100, true);
  }

  if (grade <= 2) {
    return Math.random() < 0.5 ? draftAddSub(20, true) : draftAddSub(50, true);
  }
  if (grade === 3) {
    return pick([draftMulTable(level), draftAddSub(100, true), draftMixed()]);
  }
  if (grade <= 4) {
    return pick([draftMulBig(), draftMixed(), draftAddSub(100, true)]);
  }
  if (grade <= 6) {
    return pick([draftFraction(), draftDecimal(), draftMixed()]);
  }
  return pick([draftNegative(), draftLinear(), draftFraction()]);
}

/**
 * 把选项解析成数值。用来识别「写法不同、其实是同一个答案」的选项——
 * 比如 1 和 $\frac{8}{8}$，两个都摆上去学生当然会犹豫。
 */
function optionValue(text: string): number | null {
  const fraction = /^\\frac\{(-?\d+)\}\{(-?\d+)\}$/.exec(text);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator === 0 ? null : Number(fraction[1]) / denominator;
  }
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
}

function buildOptions(correct: string, rawWrongs: string[]): { options: string[]; answer: number } {
  const correctValue = optionValue(correct);
  /** 已经用掉的数值：1 与 8/8 与 2/4 是同一个数，摆两个等于送分题变成陷阱题。 */
  const usedValues = new Set<number>();
  const keyOf = (value: number) => Math.round(value * 1e6) / 1e6;
  const same = (value: number | null) =>
    value !== null && correctValue !== null && Math.abs(value - correctValue) < 1e-9;

  const wrongs: string[] = [];
  const push = (candidate: string) => {
    if (!candidate || candidate === correct || wrongs.includes(candidate)) {
      return false;
    }
    const value = optionValue(candidate);
    if (value !== null) {
      if (same(value) || usedValues.has(keyOf(value))) {
        return false;
      }
    }
    if (value !== null) {
      usedValues.add(keyOf(value));
    }
    wrongs.push(candidate);
    return true;
  };

  for (const candidate of rawWrongs) {
    if (wrongs.length === 3) {
      break;
    }
    push(candidate);
  }

  // 干扰项不够三个就按数值往外扩：分数改分子，整数加减，绝不拼出「5/9 加个 0」这种东西。
  const fraction = /^\\frac\{(-?\d+)\}\{(-?\d+)\}$/.exec(correct);
  let step = 1;
  while (wrongs.length < 3 && step < 40) {
    push(
      fraction
        ? `\\frac{${Number(fraction[1]) + step}}{${fraction[2]}}`
        : String((correctValue ?? 0) + step)
    );
    step += 1;
  }

  const options = shuffle([correct, ...wrongs.slice(0, 3)]);
  return { options, answer: options.indexOf(correct) };
}

function toQuestion(draft: Draft): GameQuestion {
  const { options, answer } = buildOptions(draft.correct, draft.wrongs);
  return {
    stem: draft.stem,
    options,
    answer,
    explain: draft.explain
  };
}

export function createMathSprint(options: MathSprintOptions = {}): MathSprintGame {
  const grade = Math.min(9, Math.max(1, Math.round(options.grade ?? 5)));
  const count = Math.min(12, Math.max(4, Math.round(options.count ?? 8)));
  const level: Level = options.difficulty ?? "normal";
  const topic = (options.topic ?? "").trim();

  const questions: GameQuestion[] = [];
  const seen = new Set<string>();
  // 同一局里不出重复题；撞了就重出，最多试 count * 6 次。
  for (let attempt = 0; questions.length < count && attempt < count * 6; attempt += 1) {
    const draft = pickDraft(grade, topic, level);
    if (seen.has(draft.stem)) {
      continue;
    }
    seen.add(draft.stem);
    questions.push(toQuestion(draft));
  }

  const seconds = level === "hard" ? 12 : level === "easy" ? 25 : 18;
  const topicLabel = topic || gradeLabel(grade);
  return {
    kind: "game",
    gameId: gameId("math"),
    type: "math_sprint",
    title: `${topicLabel}速算挑战`,
    rules: `${questions.length} 道题，每题 ${seconds} 秒，连对越多分越高。`,
    topic: topicLabel,
    secondsPerQuestion: seconds,
    questions
  };
}

function gradeLabel(grade: number): string {
  if (grade <= 2) return "低年级口算";
  if (grade <= 4) return "乘除与混合";
  if (grade <= 6) return "分数与小数";
  return "有理数与方程";
}
