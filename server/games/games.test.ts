import assert from "node:assert/strict";
import test from "node:test";
import { createMathSprint } from "./mathSprint.js";
import { createTwentyFour, solveTwentyFour } from "./twentyFour.js";
import { createSudoku } from "./sudoku.js";
import { FALLBACK, FLYING_CHARS, normalizeLine, toClauses } from "./poetry.js";
import { resolveType } from "./index.js";
import { ensureMathDelimiters } from "../../src/features/games/mathSource.js";
import { renderInlineMarkdown, setMathRenderer } from "../../src/features/chat/markdown.js";
import { isGamePayload } from "./types.js";
import { evaluateExpression, verifyTwentyFour } from "../../src/features/games/expr.js";

/** 选项可能是 \frac{a}{b}，按数值比较才能判断「两个选项其实是同一个答案」。 */
function optionValue(text: string): number {
  const fraction = /^\\frac\{(-?\d+)\}\{(-?\d+)\}$/.exec(text);
  if (fraction) {
    return Number(fraction[1]) / Number(fraction[2]);
  }
  return Number(text);
}

test("速算：每题四选一、选项互不相同、答案下标有效", () => {
  for (const grade of [1, 3, 5, 6, 8]) {
    const game = createMathSprint({ grade, count: 8 });
    assert.equal(game.type, "math_sprint");
    assert.equal(game.questions.length, 8);
    for (const question of game.questions) {
      assert.equal(question.options.length, 4, `选项数不对：${question.stem}`);
      assert.ok(question.answer >= 0 && question.answer < 4, `答案下标越界：${question.stem}`);
      assert.ok(question.stem.includes("$"), `题面没走公式：${question.stem}`);
      assert.ok(question.explain.length > 4, `缺解析：${question.stem}`);
      const values = question.options.map(optionValue);
      assert.equal(new Set(values.map((value) => value.toFixed(6))).size, 4, `选项重复：${question.stem}`);
    }
  }
});

test("速算：指定知识点时确实出那类题", () => {
  const fractions = createMathSprint({ grade: 5, topic: "分数", count: 6 });
  assert.ok(fractions.questions.every((item) => item.stem.includes("\\frac")));

  const decimals = createMathSprint({ grade: 5, topic: "小数", count: 6 });
  assert.ok(decimals.questions.every((item) => /\d+\.\d/.test(item.stem)));

  const equations = createMathSprint({ grade: 8, topic: "一元一次方程", count: 4 });
  assert.ok(equations.questions.every((item) => item.stem.includes("解方程")));
});

test("24 点：求解器认得经典牌组，也能识别无解", () => {
  assert.ok(solveTwentyFour([3, 3, 8, 8]), "3 3 8 8 应该有解");
  assert.ok(solveTwentyFour([1, 2, 3, 4]), "1 2 3 4 应该有解");
  assert.equal(solveTwentyFour([1, 1, 1, 1]), null, "1 1 1 1 凑不出 24");
});

test("24 点：出的每一组都真的有解，提示能算回 24", () => {
  const game = createTwentyFour({ rounds: 4 });
  assert.equal(game.rounds.length, 4);
  for (const round of game.rounds) {
    assert.equal(round.numbers.length, 4);
    assert.ok(round.hint.length > 0);
    const check = evaluateExpression(round.hint);
    assert.equal(check.ok, true, `提示式子解析失败：${round.hint}`);
    if (check.ok) {
      assert.ok(Math.abs(check.value - 24) < 1e-6, `提示没到 24：${round.hint}`);
    }
  }
});

test("数独：解合法、题干与解在非空格处一致、空格足够多", () => {
  const game = createSudoku({ level: "normal" });
  assert.equal(game.puzzle.length, 81);
  assert.equal(game.solution.length, 81);

  const rowsValid = (values: number[]) => {
    for (let row = 0; row < 9; row += 1) {
      const slice = values.slice(row * 9, row * 9 + 9);
      if (new Set(slice).size !== 9 || slice.some((value) => value < 1 || value > 9)) return false;
    }
    return true;
  };
  const columnsValid = (values: number[]) => {
    for (let column = 0; column < 9; column += 1) {
      const slice = Array.from({ length: 9 }, (_, row) => values[row * 9 + column]);
      if (new Set(slice).size !== 9) return false;
    }
    return true;
  };
  const boxesValid = (values: number[]) => {
    for (let box = 0; box < 9; box += 1) {
      const baseRow = Math.floor(box / 3) * 3;
      const baseColumn = (box % 3) * 3;
      const slice: number[] = [];
      for (let r = 0; r < 3; r += 1) {
        for (let c = 0; c < 3; c += 1) {
          slice.push(values[(baseRow + r) * 9 + baseColumn + c]);
        }
      }
      if (new Set(slice).size !== 9) return false;
    }
    return true;
  };

  assert.ok(rowsValid(game.solution));
  assert.ok(columnsValid(game.solution));
  assert.ok(boxesValid(game.solution));

  const blanks = game.puzzle.filter((value) => value === 0).length;
  assert.ok(blanks >= 30, `空格太少：${blanks}`);
  game.puzzle.forEach((value, index) => {
    if (value !== 0) {
      assert.equal(value, game.solution[index], `第 ${index} 格与解不一致`);
    }
  });
});

test("飞花令：内置名句每一句都含对应的令字", () => {
  for (const char of FLYING_CHARS) {
    const verses = FALLBACK[char];
    assert.ok(verses && verses.length >= 4, `「${char}」的兜底名句不够`);
    for (const verse of verses) {
      assert.ok(verse.line.includes(char), `「${char}」这句不含字：${verse.line}`);
      assert.ok(verse.author.length > 0 && verse.title.length > 0, `缺出处：${verse.line}`);
    }
  }
});

test("飞花令：比对时忽略标点，避免同一句因逗号被判重复", () => {
  assert.equal(normalizeLine("春眠不觉晓，处处闻啼鸟"), normalizeLine("春眠不觉晓 处处闻啼鸟"));
  assert.notEqual(normalizeLine("春眠不觉晓"), normalizeLine("夜来风雨声"));
});

test("飞花令：一口气念两句时要切成小句，整段拿去搜一定搜不到", () => {
  const clauses = toClauses("举头望明月，低头思故乡");
  assert.deepEqual(clauses, ["举头望明月", "低头思故乡"]);
  assert.deepEqual(toClauses("寻寻觅觅，冷冷清清，凄凄惨惨戚戚").length, 3);
  assert.deepEqual(toClauses("举头望明月低头思故乡").length, 1);
});

test("游戏的类型参数写得再随意也要落到对的那一种", () => {
  // schema 里的规范 id 模型会照抄，这几个是最容易漏成速算的。
  assert.equal(resolveType("twenty_four"), "twenty_four");
  assert.equal(resolveType("flying_flower"), "flying_flower");
  assert.equal(resolveType("math_sprint"), "math_sprint");
  assert.equal(resolveType("sudoku"), "sudoku");
  assert.equal(resolveType("24 点"), "twenty_four");
  assert.equal(resolveType("飞花令"), "flying_flower");
  assert.equal(resolveType("数独"), "sudoku");
  assert.equal(resolveType("练几道分数题"), "math_sprint");
  assert.equal(resolveType(undefined), "math_sprint");
});

test("游戏载荷有统一标记，别的工具结果不会被误当成游戏", () => {
  const game = createMathSprint({ grade: 4, count: 4 });
  assert.equal(isGamePayload(game), true);
  assert.equal(isGamePayload({ kind: "report", gameId: "x", title: "t" }), false);
  assert.equal(isGamePayload({ query: "分数" }), false);
  assert.equal(isGamePayload(null), false);
});

test("24 点算式：只认四则运算，用错数字或算出别的数都要说清楚", () => {
  const ok = verifyTwentyFour("(3+3)*(8-4)", [3, 3, 8, 4]);
  assert.equal(ok.ok, true);

  const wrongValue = verifyTwentyFour("3*8+4-3", [3, 3, 8, 4]);
  assert.equal(wrongValue.ok, false);
  assert.match(wrongValue.error ?? "", /不是 24/);

  const missingNumber = verifyTwentyFour("3*8", [3, 3, 8, 4]);
  assert.equal(missingNumber.ok, false);
  assert.match(missingNumber.error ?? "", /每个都要用一次/);

  const wrongNumbers = verifyTwentyFour("(8-4)*(3+3)*1", [3, 3, 8, 4]);
  assert.equal(wrongNumbers.ok, false);

  const illegal = verifyTwentyFour("24", [3, 3, 8, 4]);
  assert.equal(illegal.ok, false);

  const divideByZero = verifyTwentyFour("8/(3-3)", [3, 3, 8, 4]);
  assert.equal(divideByZero.ok, false);
  assert.match(divideByZero.error ?? "", /除以 0/);
});

test("选项是裸 LaTeX 时要补上 $，纯数字选项不补", () => {
  // 出题器给的是 \frac{4}{2}，不带 $ 就原样显示成一串反斜杠（截图里那个 bug）。
  assert.equal(ensureMathDelimiters("\\frac{4}{2}"), "$\\frac{4}{2}$");
  assert.equal(ensureMathDelimiters("\\sqrt{9}"), "$\\sqrt{9}$");
  assert.equal(ensureMathDelimiters("2"), "2");
  assert.equal(ensureMathDelimiters("3.5"), "3.5");
  // 已经带 $ 或题干里夹中文的不重复包。
  assert.equal(ensureMathDelimiters("$\\frac{1}{3}$"), "$\\frac{1}{3}$");

  // 补完之后要真能走到公式渲染器（这里用假的渲染器替 KaTeX）。
  setMathRenderer((tex, displayMode) => `<x-math data-display="${displayMode}">${tex}</x-math>`);
  const html = renderInlineMarkdown(ensureMathDelimiters("\\frac{4}{2}"));
  assert.match(html, /<x-math data-display="false">\\frac\{4\}\{2\}<\/x-math>/);
});
