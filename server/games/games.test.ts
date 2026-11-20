import assert from "node:assert/strict";
import test from "node:test";
import { createMathSprint } from "./mathSprint.js";
import { createTwentyFour, solveTwentyFour } from "./twentyFour.js";
import { createSudoku } from "./sudoku.js";
import { FALLBACK, FLYING_CHARS, normalizeLine, toClauses } from "./poetry.js";
import { createPoetryOrder, poolSize as poetryPool } from "./poetryOrder.js";
import { createWordSpell, poolSize as wordPool } from "./words.js";
import { resolveGrade, resolveType } from "./index.js";
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
  // 语文两个玩法：笼统说「语文/古诗」先落到更简单的拼句，真想接诗才会说飞花令。
  assert.equal(resolveType("poetry_order"), "poetry_order");
  assert.equal(resolveType("word_spell"), "word_spell");
  assert.equal(resolveType("拼诗句"), "poetry_order");
  assert.equal(resolveType("古诗排序"), "poetry_order");
  assert.equal(resolveType("语文"), "poetry_order");
  assert.equal(resolveType("飞花令"), "flying_flower");
  assert.equal(resolveType("接诗"), "flying_flower");
  assert.equal(resolveType("拼单词"), "word_spell");
  assert.equal(resolveType("英语背单词"), "word_spell");
});

test("年级认中文写法，散落数字不当年级", () => {
  assert.equal(resolveGrade({ grade: "五年级" }), 5);
  assert.equal(resolveGrade({ topic: "三年级分数" }), 3);
  assert.equal(resolveGrade({ grade: "6年级" }), 6);
  assert.equal(resolveGrade({ grade: 7 }), 7);
  // 「24 点」里那个 24 不是年级，不能被切成 2 或 4。
  assert.equal(resolveGrade({ topic: "24 点" }), undefined);
  assert.equal(resolveGrade({ grade: "初一" }), 7);
  assert.equal(resolveGrade({}), undefined);
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
  // 出题器给的是 \frac{4}{2}，不带 $ 就原样显示成一串反斜杠。
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

test("诗句拼句：字块够用、干扰字不在句子里、三档长度对得上", () => {
  for (const level of ["easy", "normal", "hard"] as const) {
    const game = createPoetryOrder({ level, rounds: 5 });
    assert.equal(game.type, "poetry_order");
    assert.equal(game.rounds.length, 5);
    assert.ok(poetryPool(level) >= 5, `${level} 档题库不够撑一局`);

    const seen = new Set<string>();
    for (const round of game.rounds) {
      // 简单档五言、其余七言；接句档必须给上句。
      assert.equal(round.answer.length, level === "easy" ? 5 : 7, `${level} ${round.answer}`);
      if (level === "hard") {
        assert.ok(round.prompt, "接句档要给上半句");
      }
      assert.ok(round.source.title.length > 0);

      // 要填的字一个都不能少：重复字也要有对应数量的块。
      const rest = [...round.answer].slice(game.prefilled);
      const tiles = [...round.tiles];
      for (const char of rest) {
        const hit = tiles.indexOf(char);
        assert.ok(hit >= 0, `${round.answer} 少了字块「${char}」`);
        tiles.splice(hit, 1);
      }
      // 剩下的都是干扰字，且不能是这句话里的字（否则学生分不清该点哪个）。
      for (const extra of tiles) {
        assert.equal(round.answer.includes(extra), false, `「${extra}」不该出现在 ${round.answer} 里`);
      }
      assert.equal(round.tiles.length, rest.length + (level === "hard" ? 3 : 2));

      seen.add(round.answer);
    }
    assert.equal(seen.size, 5, "一局里不该重复同一句");
  }
});

test("诗句拼句：打乱后不能跟原句一样", () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const game = createPoetryOrder({ level: "normal", rounds: 4 });
    for (const round of game.rounds) {
      assert.notEqual(round.tiles.slice(0, round.answer.length).join(""), round.answer);
    }
  }
});

test("单词拼写：字母正好够用，挑战档多一块干扰", () => {
  for (const level of ["easy", "normal", "hard"] as const) {
    const game = createWordSpell({ level, rounds: 5 });
    assert.equal(game.type, "word_spell");
    assert.equal(game.rounds.length, 5);
    assert.ok(wordPool(level) >= 5, `${level} 档词库不够撑一局`);

    const seen = new Set<string>();
    for (const round of game.rounds) {
      assert.ok(round.meaning.length > 0);
      assert.ok(round.pos.length > 0);

      const letters = [...round.letters];
      for (const char of round.word) {
        const hit = letters.indexOf(char);
        assert.ok(hit >= 0, `${round.word} 少了字母 ${char}`);
        letters.splice(hit, 1);
      }
      // 多余的就是干扰牌：简单与普通档不许有，挑战档正好一块。
      assert.equal(letters.length, level === "hard" ? 1 : 0, `${level} ${round.word} 多出 ${letters.join("")}`);
      // 干扰字母不能是单词里已有的字母，否则学生会以为要拼两次。
      for (const spare of letters) {
        assert.equal(round.word.includes(spare), false);
      }

      seen.add(round.word);
    }
    assert.equal(seen.size, 5, "一局里不该重复同一个词");
  }
});

test("单词拼写：字母是打乱的，不能直接读出来", () => {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const game = createWordSpell({ level: "normal", rounds: 4 });
    for (const round of game.rounds) {
      assert.notEqual(round.letters.join(""), round.word);
    }
  }
});

test("两种新玩法的载荷都能被认成游戏", () => {
  assert.equal(isGamePayload(createPoetryOrder({ rounds: 3 })), true);
  assert.equal(isGamePayload(createWordSpell({ rounds: 3 })), true);
});
