/**
 * 飞花令：给定一个「令字」，学生和 AI 轮流说一句含这个字的诗。
 *
 * 诗句来源是诗泉（poetry.palemoky.com，免费、无需 key）：
 * - `/api/poems/random?char=春` 取含令字的诗，挑其中一句当 AI 的回合；
 * - `/api/search?q=...` 判学生说的那句是不是真诗句。
 * 两个接口都可能不可达，所以每个字都备了几句常见名句，断网也能玩完一局。
 */

import type { FlyingFlowerGame } from "./types.js";
import { gameId } from "./ids.js";

const POETRY_BASE = "https://poetry.palemoky.com";
const REQUEST_TIMEOUT_MS = 6000;

export type Verse = { line: string; title: string; author: string };

/** 可选的令字：都是课本里出现频率高的字，学生有得接。 */
export const FLYING_CHARS = ["春", "月", "花", "风", "雪", "山", "水", "云", "雨", "江", "酒", "柳"];

export const FALLBACK: Record<string, Verse[]> = {
  春: [
    { line: "春眠不觉晓，处处闻啼鸟", title: "春晓", author: "孟浩然" },
    { line: "春风又绿江南岸，明月何时照我还", title: "泊船瓜洲", author: "王安石" },
    { line: "春色满园关不住，一枝红杏出墙来", title: "游园不值", author: "叶绍翁" },
    { line: "竹外桃花三两枝，春江水暖鸭先知", title: "惠崇春江晚景", author: "苏轼" },
    { line: "等闲识得东风面，万紫千红总是春", title: "春日", author: "朱熹" },
    { line: "野火烧不尽，春风吹又生", title: "赋得古原草送别", author: "白居易" }
  ],
  月: [
    { line: "床前明月光，疑是地上霜", title: "静夜思", author: "李白" },
    { line: "明月几时有，把酒问青天", title: "水调歌头", author: "苏轼" },
    { line: "月落乌啼霜满天，江枫渔火对愁眠", title: "枫桥夜泊", author: "张继" },
    { line: "露从今夜白，月是故乡明", title: "月夜忆舍弟", author: "杜甫" },
    { line: "海上生明月，天涯共此时", title: "望月怀远", author: "张九龄" },
    { line: "二十四桥明月夜，玉人何处教吹箫", title: "寄扬州韩绰判官", author: "杜牧" }
  ],
  花: [
    { line: "夜来风雨声，花落知多少", title: "春晓", author: "孟浩然" },
    { line: "人闲桂花落，夜静春山空", title: "鸟鸣涧", author: "王维" },
    { line: "桃花潭水深千尺，不及汪伦送我情", title: "赠汪伦", author: "李白" },
    { line: "停车坐爱枫林晚，霜叶红于二月花", title: "山行", author: "杜牧" },
    { line: "忽如一夜春风来，千树万树梨花开", title: "白雪歌送武判官归京", author: "岑参" },
    { line: "待到重阳日，还来就菊花", title: "过故人庄", author: "孟浩然" }
  ],
  风: [
    { line: "夜来风雨声，花落知多少", title: "春晓", author: "孟浩然" },
    { line: "随风潜入夜，润物细无声", title: "春夜喜雨", author: "杜甫" },
    { line: "不知细叶谁裁出，二月春风似剪刀", title: "咏柳", author: "贺知章" },
    { line: "大风起兮云飞扬", title: "大风歌", author: "刘邦" },
    { line: "好风凭借力，送我上青云", title: "临江仙", author: "曹雪芹" },
    { line: "春风又绿江南岸，明月何时照我还", title: "泊船瓜洲", author: "王安石" }
  ],
  雪: [
    { line: "孤舟蓑笠翁，独钓寒江雪", title: "江雪", author: "柳宗元" },
    { line: "窗含西岭千秋雪，门泊东吴万里船", title: "绝句", author: "杜甫" },
    { line: "遥知不是雪，为有暗香来", title: "梅花", author: "王安石" },
    { line: "燕山雪花大如席，片片吹落轩辕台", title: "北风行", author: "李白" },
    { line: "北国风光，千里冰封，万里雪飘", title: "沁园春·雪", author: "毛泽东" },
    { line: "夜深知雪重，时闻折竹声", title: "夜雪", author: "白居易" }
  ],
  山: [
    { line: "白日依山尽，黄河入海流", title: "登鹳雀楼", author: "王之涣" },
    { line: "山重水复疑无路，柳暗花明又一村", title: "游山西村", author: "陆游" },
    { line: "空山新雨后，天气晚来秋", title: "山居秋暝", author: "王维" },
    { line: "两岸青山相对出，孤帆一片日边来", title: "望天门山", author: "李白" },
    { line: "会当凌绝顶，一览众山小", title: "望岳", author: "杜甫" },
    { line: "只在此山中，云深不知处", title: "寻隐者不遇", author: "贾岛" }
  ],
  水: [
    { line: "桃花潭水深千尺，不及汪伦送我情", title: "赠汪伦", author: "李白" },
    { line: "水光潋滟晴方好，山色空蒙雨亦奇", title: "饮湖上初晴后雨", author: "苏轼" },
    { line: "抽刀断水水更流，举杯消愁愁更愁", title: "宣州谢朓楼饯别校书叔云", author: "李白" },
    { line: "问渠那得清如许，为有源头活水来", title: "观书有感", author: "朱熹" },
    { line: "白毛浮绿水，红掌拨清波", title: "咏鹅", author: "骆宾王" },
    { line: "日出江花红胜火，春来江水绿如蓝", title: "忆江南", author: "白居易" }
  ],
  云: [
    { line: "只在此山中，云深不知处", title: "寻隐者不遇", author: "贾岛" },
    { line: "云想衣裳花想容，春风拂槛露华浓", title: "清平调", author: "李白" },
    { line: "黄河远上白云间，一片孤城万仞山", title: "凉州词", author: "王之涣" },
    { line: "远上寒山石径斜，白云生处有人家", title: "山行", author: "杜牧" },
    { line: "不畏浮云遮望眼，自缘身在最高层", title: "登飞来峰", author: "王安石" },
    { line: "大风起兮云飞扬", title: "大风歌", author: "刘邦" }
  ],
  雨: [
    { line: "好雨知时节，当春乃发生", title: "春夜喜雨", author: "杜甫" },
    { line: "清明时节雨纷纷，路上行人欲断魂", title: "清明", author: "杜牧" },
    { line: "夜来风雨声，花落知多少", title: "春晓", author: "孟浩然" },
    { line: "空山新雨后，天气晚来秋", title: "山居秋暝", author: "王维" },
    { line: "水光潋滟晴方好，山色空蒙雨亦奇", title: "饮湖上初晴后雨", author: "苏轼" },
    { line: "天街小雨润如酥，草色遥看近却无", title: "早春呈水部张十八员外", author: "韩愈" }
  ],
  江: [
    { line: "日出江花红胜火，春来江水绿如蓝", title: "忆江南", author: "白居易" },
    { line: "月落乌啼霜满天，江枫渔火对愁眠", title: "枫桥夜泊", author: "张继" },
    { line: "孤帆远影碧空尽，唯见长江天际流", title: "黄鹤楼送孟浩然之广陵", author: "李白" },
    { line: "春风又绿江南岸，明月何时照我还", title: "泊船瓜洲", author: "王安石" },
    { line: "大江东去，浪淘尽，千古风流人物", title: "念奴娇·赤壁怀古", author: "苏轼" },
    { line: "孤舟蓑笠翁，独钓寒江雪", title: "江雪", author: "柳宗元" }
  ],
  酒: [
    { line: "劝君更尽一杯酒，西出阳关无故人", title: "送元二使安西", author: "王维" },
    { line: "借问酒家何处有，牧童遥指杏花村", title: "清明", author: "杜牧" },
    { line: "葡萄美酒夜光杯，欲饮琵琶马上催", title: "凉州词", author: "王翰" },
    { line: "花间一壶酒，独酌无相亲", title: "月下独酌", author: "李白" },
    { line: "明月几时有，把酒问青天", title: "水调歌头", author: "苏轼" },
    { line: "白日放歌须纵酒，青春作伴好还乡", title: "闻官军收河南河北", author: "杜甫" }
  ],
  柳: [
    { line: "杨柳青青江水平，闻郎江上唱歌声", title: "竹枝词", author: "刘禹锡" },
    { line: "月上柳梢头，人约黄昏后", title: "生查子·元夕", author: "欧阳修" },
    { line: "山重水复疑无路，柳暗花明又一村", title: "游山西村", author: "陆游" },
    { line: "羌笛何须怨杨柳，春风不度玉门关", title: "凉州词", author: "王之涣" },
    { line: "昔我往矣，杨柳依依", title: "诗经·采薇", author: "佚名" },
    { line: "两个黄鹂鸣翠柳，一行白鹭上青天", title: "绝句", author: "杜甫" }
  ]
};

/** 比对诗句时先去掉标点与空白，避免「，」的有无把同一句当成两句。 */
export function normalizeLine(line: string): string {
  return line.replace(/[\s，。！？、；：,.!?;:"'「」『』《》()（）—…·]/g, "");
}

async function fetchJson(path: string): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${POETRY_BASE}${path}`, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type PoemPayload = {
  data?: { title?: string; content?: string[]; author?: { name?: string } };
};

/** 从「随机一首」的返回里挑出含令字的句子。 */
function versesFrom(payload: unknown, char: string): Verse[] {
  const poem = (payload as PoemPayload | null)?.data;
  if (!poem || !Array.isArray(poem.content)) {
    return [];
  }
  return poem.content
    .filter((line) => typeof line === "string" && line.includes(char))
    .map((line) => ({
      line: line.replace(/[。！？]$/, ""),
      title: poem.title ?? "",
      author: poem.author?.name ?? ""
    }));
}

/** 内置的兜底名句（接口不通时用）。导出给测试核对「每句都真的含这个字」。 */
export function fallbackVerse(char: string, used: Set<string>): Verse | null {
  const pool = FALLBACK[char] ?? [];
  const fresh = pool.filter((verse) => !used.has(normalizeLine(verse.line)));
  return fresh.length > 0 ? fresh[Math.floor(Math.random() * fresh.length)] : null;
}

/**
 * 取一句含令字、且没在这一局里用过的诗。
 *
 * 先出课本名句：诗库随机取到的多半是冷僻句子（「此外未知谁洞府，试春游骑必停骖」），
 * 学生接不上，飞花令就断了。每个字的兜底名句有六句，一局五轮够用；本地用尽了才联网扩词。
 */
export async function drawVerse(char: string, used: Set<string> = new Set()): Promise<Verse | null> {
  const known = fallbackVerse(char, used);
  if (known) {
    return known;
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const payload = await fetchJson(`/api/poems/random?char=${encodeURIComponent(char)}`);
    const verses = versesFrom(payload, char).filter((verse) => !used.has(normalizeLine(verse.line)));
    if (verses.length > 0) {
      // 库里的长调句子接起来太难，短句优先。
      const short = verses.filter((verse) => normalizeLine(verse.line).length <= 12);
      const pool = short.length > 0 ? short : verses;
      return pool[Math.floor(Math.random() * pool.length)];
    }
  }
  return null;
}

export type FlyingFlowerOptions = {
  char?: string;
  rounds?: number;
};

export async function createFlyingFlower(
  options: FlyingFlowerOptions = {}
): Promise<FlyingFlowerGame> {
  const char = options.char && FLYING_CHARS.includes(options.char)
    ? options.char
    : FLYING_CHARS[Math.floor(Math.random() * FLYING_CHARS.length)];
  const opener =
    (await drawVerse(char, new Set())) ??
    fallbackVerse(char, new Set()) ?? {
      line: `一时想不起含「${char}」的诗`,
      title: "",
      author: ""
    };

  const rounds = Math.min(8, Math.max(3, Math.round(options.rounds ?? 5)));
  return {
    kind: "game",
    gameId: gameId("ff"),
    type: "flying_flower",
    title: `飞花令 · 「${char}」`,
    rules: `轮流说一句含「${char}」的诗，不能重复。接满 ${rounds} 轮就算赢。`,
    char,
    rounds,
    opener
  };
}

/**
 * 诗库（全唐诗 + 宋词）和课本用字不一样的那几句：静夜思的「床前明月光」在库里写作
 * 「床前看月光」，「举头望明月」写作「举头望山月」。这类句子联网也搜不到，
 * 不单独收一份就会把背对了的学生判错。
 */
const TEXTBOOK_LINES = [
  "床前明月光，疑是地上霜",
  "举头望明月，低头思故乡",
  "远上寒山石径斜，白云生处有人家",
  "日照香炉生紫烟，遥看瀑布挂前川",
  "飞流直下三千尺，疑是银河落九天",
  "欲穷千里目，更上一层楼",
  "白日依山尽，黄河入海流",
  "两个黄鹂鸣翠柳，一行白鹭上青天",
  "接天莲叶无穷碧，映日荷花别样红",
  "不知细叶谁裁出，二月春风似剪刀",
  "停车坐爱枫林晚，霜叶红于二月花",
  "莫愁前路无知己，天下谁人不识君",
  "独在异乡为异客，每逢佳节倍思亲",
  "大漠孤烟直，长河落日圆",
  "海上生明月，天涯共此时",
  "但愿人长久，千里共婵娟",
  "人有悲欢离合，月有阴晴圆缺",
  "寻寻觅觅，冷冷清清，凄凄惨惨戚戚",
  "无可奈何花落去，似曾相识燕归来",
  "衣带渐宽终不悔，为伊消得人憔悴"
];

/** 按标点切成小句：学生一口气念两句是常事，整段拿去比对必然搜不到。 */
export function toClauses(text: string): string[] {
  return text
    .split(/[\s，。！？、；：,.!?;:"'“”「」『』《》()（）—…·]+/)
    .map((clause) => normalizeLine(clause))
    .filter((clause) => clause.length >= 2);
}

const KNOWN_LINES: string[] = [];
function rememberLine(line: string): void {
  const clean = normalizeLine(line);
  if (clean.length >= 4) {
    KNOWN_LINES.push(clean);
  }
  for (const clause of toClauses(line)) {
    if (clause.length >= 4) {
      KNOWN_LINES.push(clause);
    }
  }
}
for (const verses of Object.values(FALLBACK)) {
  for (const verse of verses) {
    rememberLine(verse.line);
  }
}
for (const line of TEXTBOOK_LINES) {
  rememberLine(line);
}

/** 本地名句表里认得的句子就不必联网了；半分句、整句都能对上。 */
function looksKnown(clause: string): boolean {
  return KNOWN_LINES.some((line) => line.includes(clause) || clause.includes(line));
}

export type FlyingFlowerResult = {
  ok: boolean;
  /** 没通过时的一句人话。 */
  reason?: string;
  /** 通过了的话，AI 接着说的那句。 */
  reply?: Verse;
  /** 诗库这会儿连不上：判定放行，但前端要提一句。 */
  degraded?: boolean;
};

/** 学生接一句：判含字、判重复、判真伪，通过了给 AI 的下一句。 */
export async function verifyFlyingFlower(input: {
  char: string;
  line: string;
  used?: string[];
}): Promise<FlyingFlowerResult> {
  const char = input.char;
  const raw = input.line.trim();
  const clean = normalizeLine(raw);
  const used = new Set((input.used ?? []).map(normalizeLine));

  if (!char) {
    return { ok: false, reason: "不知道该接哪个字。" };
  }
  if (!clean) {
    return { ok: false, reason: "还没写诗句呢。" };
  }
  if (!clean.includes(char)) {
    return { ok: false, reason: `这句里没有「${char}」字。` };
  }
  if (clean.length < 5) {
    return { ok: false, reason: "太短了，说完整的一句诗。" };
  }
  if (used.has(clean)) {
    return { ok: false, reason: "这句刚才说过了，换一句。" };
  }

  const clauses = toClauses(raw);
  const nextUsed = new Set([...used, clean]);

  // 常见名句在本地就对得上，省一次网络往返。
  if (clauses.length > 0 && clauses.every((clause) => looksKnown(clause))) {
    return { ok: true, reply: (await drawVerse(char, nextUsed)) ?? undefined };
  }

  // 判真伪：拿最长的一句去搜（接口要求至少 3 个字），命中了再核对学生说的每一句。
  const query = [...clauses].sort((left, right) => right.length - left.length)[0] ?? clean;
  if (query.length < 3) {
    return { ok: false, reason: "这句太短了，说完整一点。" };
  }
  // 学生整段不打标点时，整串搜不到；退一步用开头七个字再搜一次。
  const attempts = query.length > 7 ? [query, query.slice(0, 7)] : [query];
  let payload: unknown | null = null;
  let poems: Array<{ content?: string[] }> = [];
  for (const attempt of attempts) {
    payload = await fetchJson(`/api/search?q=${encodeURIComponent(attempt)}`);
    if (payload === null) {
      break;
    }
    const found = (payload as { data?: Array<{ content?: string[] }> }).data ?? [];
    if (found.length > 0) {
      poems = found;
      break;
    }
  }
  // 接口挂了不判错，免得网络问题冤了学生。
  if (payload === null) {
    return { ok: true, degraded: true, reply: (await drawVerse(char, nextUsed)) ?? undefined };
  }
  // 一首诗的内容是一句一条，学生念两句时，两句都要能在同一首里找到。
  const found = poems.some((poem) => {
    const lines = (poem.content ?? []).map((line) => normalizeLine(String(line)));
    return clauses.every((clause) => lines.some((line) => line.includes(clause) || clause.includes(line)));
  });
  if (!found) {
    return { ok: false, reason: "诗库里没查到这一句，看看是不是字记混了？换一句也算数。" };
  }

  return { ok: true, reply: (await drawVerse(char, nextUsed)) ?? undefined };
}
