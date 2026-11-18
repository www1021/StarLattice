/**
 * 诗句拼句：把一句诗的字打乱，让学生点成原句。
 *
 * 为什么另做一个而不是加强飞花令：飞花令要求学生自己从脑子里掏出一句含字诗，
 * 对小学生来说门槛太高，掏不出来就冷场。拼句只要求「认得出这一句怎么排」，
 * 认字、记句、辨顺序都能练到，还不用怕开口。
 *
 * 字块里故意混几个干扰字，学生不能靠数格子蒙——多点了就不成句。
 * 题库全部来自本地名句表，不联网也能出一整局。
 */

import { gameId } from "./ids.js";
import { FALLBACK, normalizeLine } from "./poetry.js";
import type { PoetryOrderGame } from "./types.js";

type Level = "easy" | "normal" | "hard";

type Clause = {
  /** 这一句本身（已去标点）。 */
  text: string;
  /** 同一首诗里的上一句，给「接下句」用。 */
  prev?: string;
  title: string;
  author: string;
};

/** 干扰字池：都是小学阶段认得的字，混进去不显得突兀，也不会带出生僻字。 */
const COMMON_CHARS =
  "日月山水云风雨雪花草树木天地人心手足口耳目牛马羊鸟鱼虫米田禾苗春夏秋冬红绿青白黑黄大小多少高低长短前后左右东南西北中江河湖海光明清静远近听看走来去回归还";

const PUNCT = /[，。！？、；：,.!?;:"'“”「」『』《》()（）—…·\s]/g;

function splitClauses(line: string): string[] {
  return line
    .split(/[，,。！？；]/)
    .map((part) => part.replace(PUNCT, ""))
    .filter((part) => part.length > 0);
}

/** 把名句表摊平成一句一条，同句只留一份（同一个句子会在多个令字下重复出现）。 */
function buildPool(): Clause[] {
  const pool: Clause[] = [];
  const seen = new Set<string>();
  for (const verses of Object.values(FALLBACK)) {
    for (const verse of verses) {
      const parts = splitClauses(verse.line);
      parts.forEach((text, index) => {
        const key = `${text}|${verse.title}`;
        if (seen.has(key)) {
          return;
        }
        seen.add(key);
        pool.push({
          text,
          prev: index > 0 ? parts[index - 1] : undefined,
          title: verse.title,
          author: verse.author
        });
      });
    }
  }
  return pool;
}

/** 导出给测试：五言、七言各有多少句，决定每档能不能撑满一局。 */
export const CLAUSE_POOL = buildPool();

export function poolSize(level: Level): number {
  if (level === "easy") {
    return CLAUSE_POOL.filter((clause) => clause.text.length === 5).length;
  }
  if (level === "hard") {
    return CLAUSE_POOL.filter((clause) => clause.text.length === 7 && clause.prev).length;
  }
  return CLAUSE_POOL.filter((clause) => clause.text.length === 7).length;
}

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}

/**
 * 造字块：先放这一句的字，再掺干扰字。
 * 干扰字既不能是这句里已有的字（否则多出一个同字块，学生分不清该点哪个），
 * 也不能让打乱后跟原句一模一样（那样一眼就看出来了）。
 */
function buildTiles(answer: string, prefilled: number, distractors: number): string[] {
  const rest = [...answer].slice(prefilled);
  const used = new Set([...answer]);
  const extras = shuffle([...COMMON_CHARS].filter((char) => !used.has(char))).slice(0, distractors);
  const tiles = [...rest, ...extras];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    shuffle(tiles);
    if (tiles.join("") !== rest.join("")) {
      break;
    }
  }
  return tiles;
}

export type PoetryOrderOptions = {
  level?: Level;
  rounds?: number;
};

export function createPoetryOrder(options: PoetryOrderOptions = {}): PoetryOrderGame {
  const level: Level = options.level ?? "normal";
  const prefilled = level === "easy" ? 1 : 0;
  const distractors = level === "hard" ? 3 : 2;
  const wantRounds = Math.min(8, Math.max(3, Math.round(options.rounds ?? 5)));

  const candidates =
    level === "easy"
      ? CLAUSE_POOL.filter((clause) => clause.text.length === 5)
      : level === "hard"
        ? CLAUSE_POOL.filter((clause) => clause.text.length === 7 && clause.prev)
        : CLAUSE_POOL.filter((clause) => clause.text.length === 7);

  // 题库理论上够用；万一被筛空（改词库改坏了），退回全部七言，别抛错。
  const pool = candidates.length >= wantRounds ? candidates : CLAUSE_POOL.filter((c) => c.text.length >= 5);
  const picked = shuffle([...pool]).slice(0, wantRounds);

  const rounds = picked.map((clause) => ({
    answer: clause.text,
    // 只有「接下句」这一档给上句，其余档直接拼，题目更干净。
    ...(level === "hard" && clause.prev ? { prompt: clause.prev } : {}),
    tiles: buildTiles(clause.text, prefilled, distractors),
    source: { title: clause.title, author: clause.author }
  }));

  const title =
    level === "easy" ? "诗句拼句 · 五言" : level === "hard" ? "诗句接句 · 看上半句拼下半句" : "诗句拼句 · 七言";
  const rules =
    level === "hard"
      ? "上半句给你，把下半句用下面的字按顺序点出来。字块里多余的字别点。"
      : prefilled > 0
        ? "第一个字已经填好，把剩下的字按顺序点进去。字块里多出来的字别点。"
        : "把下面的字按诗句顺序点进去。字块里多出来的字别点。";

  return {
    kind: "game",
    gameId: gameId("po"),
    type: "poetry_order",
    title,
    rules,
    level,
    prefilled,
    rounds,
    secondsPerRound: level === "hard" ? 50 : 40
  };
}

/** 前端判分用得到：比对时忽略标点与空白。导出给测试核对题库。 */
export function answerOf(clause: string): string {
  return normalizeLine(clause);
}
