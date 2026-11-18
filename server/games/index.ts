/**
 * 小游戏的统一入口：模型只说「玩什么、什么学段」，这里决定出哪种题、怎么出。
 *
 * 返回的 text 是给模型看的说明书，重点是最后那句——卡片已经把题目发到界面上了，
 * 模型再复述一遍题目，学生就会看到两遍题，还会以为要打字作答。
 */

import { createMathSprint } from "./mathSprint.js";
import { createTwentyFour } from "./twentyFour.js";
import { createSudoku } from "./sudoku.js";
import { createFlyingFlower, FLYING_CHARS } from "./poetry.js";
import { createPoetryOrder } from "./poetryOrder.js";
import { createWordSpell } from "./words.js";
import type { GamePayload, GameType } from "./types.js";

export type PlayGameArgs = {
  game?: string;
  /** schema 里是 number，但模型也会把「五年级」原样塞进来，这里两种都收。 */
  grade?: number | string;
  topic?: string;
  difficulty?: string;
  count?: number;
  char?: string;
};

export type PlayGameResult = { payload: GamePayload; text: string };

/** 导出给测试：模型照抄 schema 里的 id（twenty_four）时也必须认出来。 */
export function resolveType(input: string | undefined): GameType {
  const text = (input ?? "").trim().toLowerCase();
  if (!text) return "math_sprint";
  // 先认工具 schema 里的规范 id：模型百分之百会照抄 "twenty_four" 这种写法，
  // 只按中文关键词匹配会把 24 点和飞花令都漏成速算。
  if (/flying[_\- ]?flower/.test(text)) return "flying_flower";
  if (/poetry[_\- ]?order/.test(text)) return "poetry_order";
  if (/word[_\- ]?spell/.test(text)) return "word_spell";
  if (/twenty[_\- ]?four/.test(text)) return "twenty_four";
  if (/math[_\- ]?sprint/.test(text)) return "math_sprint";
  // 其次认中文说法：模型自己改口时也要接得住。
  if (/24|二十四|凑二十四/.test(text)) return "twenty_four";
  if (/数独|sudoku/.test(text)) return "sudoku";
  if (/拼单词|拼写|单词|英语|english|spell|vocab/.test(text)) return "word_spell";
  // 拼句比飞花令简单，所以「语文 / 古诗 / 诗词」这些笼统说法先落到拼句上；
  // 学生真想接诗，会自己说「飞花令」或「接诗」。
  if (/拼句|拼诗|诗句|连句|排句|字块|古诗|诗词|诗歌|语文|poetry|order/.test(text)) return "poetry_order";
  if (/飞花|接诗|令字/.test(text)) return "flying_flower";
  if (/速算|口算|刷题|练习|计算|math|数学/.test(text)) return "math_sprint";
  return "math_sprint";
}

function resolveDifficulty(input: string | undefined): "easy" | "normal" | "hard" {
  const text = (input ?? "").trim().toLowerCase();
  if (/easy|简单|入门|基础/.test(text)) return "easy";
  if (/hard|困难|挑战|难/.test(text)) return "hard";
  return "normal";
}

const CHINESE_NUMBERS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9
};

/** 年级可能写成「初一」「七年级」「5」，统一折算成 1-9。 */
export function resolveGrade(input: PlayGameArgs): number | undefined {
  if (typeof input.grade === "number" && Number.isFinite(input.grade)) {
    return Math.min(9, Math.max(1, Math.round(input.grade)));
  }
  const text = `${input.grade ?? ""} ${input.topic ?? ""}`;
  // 只认「X年级」这种明确写法；散落的单个数字（比如「24 点」里的 24）不是年级。
  // 学生多半说「五年级」而不是「5年级」，中文数字也得认，否则会静默退回六年级。
  const digit = /([1-9一二三四五六七八九])\s*年级/.exec(text);
  if (digit) {
    const value = CHINESE_NUMBERS[digit[1]] ?? Number(digit[1]);
    if (Number.isFinite(value) && value >= 1 && value <= 9) {
      return value;
    }
  }
  const junior = /初([一二三])/.exec(text);
  if (junior) {
    return 6 + (CHINESE_NUMBERS[junior[1]] ?? 1);
  }
  if (/高[一二三]/.test(text)) {
    return 9;
  }
  return undefined;
}

function summaryOf(payload: GamePayload): string {
  switch (payload.type) {
    case "math_sprint":
      return `「${payload.title}」，${payload.questions.length} 道题，每题 ${payload.secondsPerQuestion} 秒`;
    case "twenty_four":
      return `「${payload.title}」，${payload.rounds.length} 组数字`;
    case "sudoku": {
      const blanks = payload.puzzle.filter((value) => value === 0).length;
      return `「${payload.title}」，${blanks} 个空格`;
    }
    case "flying_flower":
      return `飞花令，令字是「${payload.char}」，计划接 ${payload.rounds} 轮`;
    case "poetry_order":
      return `「${payload.title}」，${payload.rounds.length} 句诗`;
    case "word_spell":
      return `「${payload.title}」，${payload.rounds.length} 个单词`;
  }
}

export async function playGame(args: PlayGameArgs): Promise<PlayGameResult> {
  const type = resolveType(args.game);
  const difficulty = resolveDifficulty(args.difficulty);

  if (type === "flying_flower") {
    const char = args.char && FLYING_CHARS.includes(args.char) ? args.char : undefined;
    const payload = await createFlyingFlower({ char, rounds: args.count });
    return {
      payload,
      text: [
        `已经开了一局${summaryOf(payload)}。`,
        `AI 先出的是「${payload.opener.line}」（${payload.opener.author}《${payload.opener.title}》）。`,
        "题目已经作为可玩的卡片发到学生界面上了。",
        "你只要说一句鼓励或引导的话（比如提示可以想哪一类诗），**不要复述题目、不要替学生答题、也不要要求他用文字把答案发给你**——直接在卡片里填就有反馈。"
      ].join("")
    };
  }

  if (type === "poetry_order") {
    // 语文这两档默认往简单走：没明说难度就出五言拼句，小学生上手不至于卡住。
    const level = args.difficulty ? difficulty : "easy";
    const payload = createPoetryOrder({ level, rounds: args.count });
    return {
      payload,
      text: [
        `已经开了一局${summaryOf(payload)}。`,
        "题目已经作为可玩的卡片发到学生界面上了：字块打乱，按诗句顺序点。",
        "你只要说一句开场话（可以提一句「先看哪个字该在最前面」），**不要把整句念出来、不要说第几个字是什么、也不要让他把答案打字发给你**——学生在卡片里点，程序会判。",
        "答完之后如果学生问这句诗的意思或者出处，正常讲，卡片里也留了出处。"
      ].join("")
    };
  }

  if (type === "word_spell") {
    const level = args.difficulty ? difficulty : "easy";
    const payload = createWordSpell({ level, rounds: args.count });
    return {
      payload,
      text: [
        `已经开了一局${summaryOf(payload)}。`,
        "题目已经作为可玩的卡片发到学生界面上了：给中文意思和打乱的字母牌，按顺序点出单词。",
        "你只要说一句开场话（可以提醒「先想第一个音是什么字母」），**不要把单词拼出来、不要逐个字母念、也不要让他把答案打字发给你**。",
        "学生拼错时可以提示词性或者用它造一个短句，但别直接给拼写。"
      ].join("")
    };
  }

  if (type === "sudoku") {
    const payload = createSudoku({ level: difficulty });
    return {
      payload,
      text: [
        `已经开了一盘${summaryOf(payload)}。`,
        "题目已经作为可玩的卡片发到学生界面上了。",
        "你只要说一句开场话（可以提醒先找候选最少的格子），**不要复述盘面、不要给出答案**——学生在卡片里填，程序会判。"
      ].join("")
    };
  }

  if (type === "twenty_four") {
    const payload = createTwentyFour({ rounds: args.count, level: difficulty });
    return {
      payload,
      text: [
        `已经开了一局${summaryOf(payload)}。`,
        "题目已经作为可玩的卡片发到学生界面上了。",
        "你只要说一句开场话（可以提醒「先想乘法、再看能不能凑出 24 的因数」），**不要替学生算、也不要把四张牌念一遍**。"
      ].join("")
    };
  }

  const payload = createMathSprint({
    grade: resolveGrade(args),
    topic: args.topic,
    count: args.count,
    difficulty
  });
  return {
    payload,
    text: [
      `已经开了一局${summaryOf(payload)}。`,
      "题目已经作为可玩的卡片发到学生界面上了。",
      "你只要说一句开场话（可以点一句这类题的易错点），**不要复述题目、不要报答案、也不要要求学生把答案打字发给你**——卡片里点选项就有即时反馈。"
    ].join("")
  };
}
