/**
 * 单词拼写：给中文意思和一副打乱的字母牌，拼回英文单词。
 *
 * 和速算同一个思路——把「背单词」变成能动手的事。字母块正好够用（挑战档多一块干扰牌），
 * 学生不用愁拼不出，只要想得起顺序；每个词配一个 emoji，卡片上先给画面再给中文，
 * 比干巴巴一行「苹果」更容易记住。
 */

import { gameId } from "./ids.js";
import type { WordSpellGame } from "./types.js";

type Level = "easy" | "normal" | "hard";

export type WordEntry = {
  word: string;
  /** 中文意思，卡片上大字显示。 */
  meaning: string;
  /** 词性缩写：n. / v. / adj. */
  pos: string;
  /** 有就用大图标占位，让卡片先有画面。 */
  emoji?: string;
};

/** 小学高频词，按主题混排。词长就是难度：3-4 字母认读，5-6 拼写，7 以上挑战。 */
export const WORDS: WordEntry[] = [
  // 动物
  { word: "cat", meaning: "猫", pos: "n.", emoji: "🐱" },
  { word: "dog", meaning: "狗", pos: "n.", emoji: "🐶" },
  { word: "pig", meaning: "猪", pos: "n.", emoji: "🐷" },
  { word: "cow", meaning: "奶牛", pos: "n.", emoji: "🐮" },
  { word: "hen", meaning: "母鸡", pos: "n.", emoji: "🐔" },
  { word: "bee", meaning: "蜜蜂", pos: "n.", emoji: "🐝" },
  { word: "fox", meaning: "狐狸", pos: "n.", emoji: "🦊" },
  { word: "ant", meaning: "蚂蚁", pos: "n.", emoji: "🐜" },
  { word: "bear", meaning: "熊", pos: "n.", emoji: "🐻" },
  { word: "duck", meaning: "鸭子", pos: "n.", emoji: "🦆" },
  { word: "lion", meaning: "狮子", pos: "n.", emoji: "🦁" },
  { word: "fish", meaning: "鱼", pos: "n.", emoji: "🐟" },
  { word: "tiger", meaning: "老虎", pos: "n.", emoji: "🐯" },
  { word: "panda", meaning: "熊猫", pos: "n.", emoji: "🐼" },
  { word: "horse", meaning: "马", pos: "n.", emoji: "🐴" },
  { word: "sheep", meaning: "绵羊", pos: "n.", emoji: "🐑" },
  { word: "monkey", meaning: "猴子", pos: "n.", emoji: "🐵" },
  { word: "rabbit", meaning: "兔子", pos: "n.", emoji: "🐰" },
  { word: "elephant", meaning: "大象", pos: "n.", emoji: "🐘" },
  { word: "butterfly", meaning: "蝴蝶", pos: "n.", emoji: "🦋" },

  // 食物
  { word: "egg", meaning: "鸡蛋", pos: "n.", emoji: "🥚" },
  { word: "milk", meaning: "牛奶", pos: "n.", emoji: "🥛" },
  { word: "rice", meaning: "米饭", pos: "n.", emoji: "🍚" },
  { word: "cake", meaning: "蛋糕", pos: "n.", emoji: "🍰" },
  { word: "bread", meaning: "面包", pos: "n.", emoji: "🍞" },
  { word: "apple", meaning: "苹果", pos: "n.", emoji: "🍎" },
  { word: "water", meaning: "水", pos: "n.", emoji: "💧" },
  { word: "juice", meaning: "果汁", pos: "n.", emoji: "🧃" },
  { word: "grape", meaning: "葡萄", pos: "n.", emoji: "🍇" },
  { word: "lemon", meaning: "柠檬", pos: "n.", emoji: "🍋" },
  { word: "peach", meaning: "桃子", pos: "n.", emoji: "🍑" },
  { word: "banana", meaning: "香蕉", pos: "n.", emoji: "🍌" },
  { word: "orange", meaning: "橙子", pos: "n.", emoji: "🍊" },
  { word: "tomato", meaning: "西红柿", pos: "n.", emoji: "🍅" },
  { word: "carrot", meaning: "胡萝卜", pos: "n.", emoji: "🥕" },
  { word: "noodle", meaning: "面条", pos: "n.", emoji: "🍜" },
  { word: "chicken", meaning: "鸡肉", pos: "n.", emoji: "🍗" },

  // 学校与文具
  { word: "book", meaning: "书", pos: "n.", emoji: "📕" },
  { word: "pen", meaning: "钢笔", pos: "n.", emoji: "🖊️" },
  { word: "bag", meaning: "书包", pos: "n.", emoji: "🎒" },
  { word: "ruler", meaning: "尺子", pos: "n.", emoji: "📏" },
  { word: "pencil", meaning: "铅笔", pos: "n.", emoji: "✏️" },
  { word: "school", meaning: "学校", pos: "n.", emoji: "🏫" },
  { word: "paper", meaning: "纸", pos: "n.", emoji: "📄" },
  { word: "crayon", meaning: "蜡笔", pos: "n.", emoji: "🖍️" },
  { word: "teacher", meaning: "老师", pos: "n.", emoji: "🧑‍🏫" },
  { word: "student", meaning: "学生", pos: "n.", emoji: "🧑‍🎓" },
  { word: "library", meaning: "图书馆", pos: "n.", emoji: "🏛️" },
  { word: "classroom", meaning: "教室", pos: "n.", emoji: "🪟" },

  // 自然与天气
  { word: "sun", meaning: "太阳", pos: "n.", emoji: "☀️" },
  { word: "moon", meaning: "月亮", pos: "n.", emoji: "🌙" },
  { word: "star", meaning: "星星", pos: "n.", emoji: "⭐" },
  { word: "rain", meaning: "雨", pos: "n.", emoji: "🌧️" },
  { word: "snow", meaning: "雪", pos: "n.", emoji: "❄️" },
  { word: "wind", meaning: "风", pos: "n.", emoji: "🌬️" },
  { word: "cloud", meaning: "云", pos: "n.", emoji: "☁️" },
  { word: "tree", meaning: "树", pos: "n.", emoji: "🌳" },
  { word: "flower", meaning: "花", pos: "n.", emoji: "🌸" },
  { word: "grass", meaning: "草", pos: "n.", emoji: "🌱" },
  { word: "river", meaning: "河", pos: "n.", emoji: "🏞️" },
  { word: "mountain", meaning: "山", pos: "n.", emoji: "⛰️" },
  { word: "rainy", meaning: "下雨的", pos: "adj.", emoji: "🌧️" },
  { word: "sunny", meaning: "晴朗的", pos: "adj.", emoji: "🌞" },

  // 颜色
  { word: "red", meaning: "红色", pos: "adj.", emoji: "🔴" },
  { word: "blue", meaning: "蓝色", pos: "adj.", emoji: "🔵" },
  { word: "green", meaning: "绿色", pos: "adj.", emoji: "🟢" },
  { word: "black", meaning: "黑色", pos: "adj.", emoji: "⚫" },
  { word: "white", meaning: "白色", pos: "adj.", emoji: "⚪" },
  { word: "yellow", meaning: "黄色", pos: "adj.", emoji: "🟡" },
  { word: "purple", meaning: "紫色", pos: "adj.", emoji: "🟣" },
  { word: "pink", meaning: "粉色", pos: "adj.", emoji: "💗" },

  // 身体与家人
  { word: "hand", meaning: "手", pos: "n.", emoji: "✋" },
  { word: "foot", meaning: "脚", pos: "n.", emoji: "🦶" },
  { word: "head", meaning: "头", pos: "n.", emoji: "👤" },
  { word: "hair", meaning: "头发", pos: "n.", emoji: "💇" },
  { word: "eye", meaning: "眼睛", pos: "n.", emoji: "👁️" },
  { word: "nose", meaning: "鼻子", pos: "n.", emoji: "👃" },
  { word: "mouth", meaning: "嘴", pos: "n.", emoji: "👄" },
  { word: "ear", meaning: "耳朵", pos: "n.", emoji: "👂" },
  { word: "mom", meaning: "妈妈", pos: "n.", emoji: "👩" },
  { word: "dad", meaning: "爸爸", pos: "n.", emoji: "👨" },
  { word: "baby", meaning: "婴儿", pos: "n.", emoji: "👶" },
  { word: "family", meaning: "家庭", pos: "n.", emoji: "👨‍👩‍👧" },

  // 动作与形容词
  { word: "run", meaning: "跑", pos: "v.", emoji: "🏃" },
  { word: "jump", meaning: "跳", pos: "v.", emoji: "🤸" },
  { word: "swim", meaning: "游泳", pos: "v.", emoji: "🏊" },
  { word: "sing", meaning: "唱歌", pos: "v.", emoji: "🎤" },
  { word: "dance", meaning: "跳舞", pos: "v.", emoji: "💃" },
  { word: "read", meaning: "读", pos: "v.", emoji: "📖" },
  { word: "write", meaning: "写", pos: "v.", emoji: "✍️" },
  { word: "draw", meaning: "画", pos: "v.", emoji: "🎨" },
  { word: "happy", meaning: "开心的", pos: "adj.", emoji: "😊" },
  { word: "sad", meaning: "难过的", pos: "adj.", emoji: "😢" },
  { word: "hot", meaning: "热的", pos: "adj.", emoji: "🔥" },
  { word: "cold", meaning: "冷的", pos: "adj.", emoji: "🥶" },
  { word: "fast", meaning: "快的", pos: "adj.", emoji: "⚡" },
  { word: "slow", meaning: "慢的", pos: "adj.", emoji: "🐢" },

  // 家居、交通与时间
  { word: "house", meaning: "房子", pos: "n.", emoji: "🏠" },
  { word: "door", meaning: "门", pos: "n.", emoji: "🚪" },
  { word: "chair", meaning: "椅子", pos: "n.", emoji: "🪑" },
  { word: "bed", meaning: "床", pos: "n.", emoji: "🛏️" },
  { word: "clock", meaning: "钟", pos: "n.", emoji: "⏰" },
  { word: "phone", meaning: "电话", pos: "n.", emoji: "📱" },
  { word: "ball", meaning: "球", pos: "n.", emoji: "⚽" },
  { word: "kite", meaning: "风筝", pos: "n.", emoji: "🪁" },
  { word: "bike", meaning: "自行车", pos: "n.", emoji: "🚲" },
  { word: "car", meaning: "汽车", pos: "n.", emoji: "🚗" },
  { word: "bus", meaning: "公交车", pos: "n.", emoji: "🚌" },
  { word: "train", meaning: "火车", pos: "n.", emoji: "🚂" },
  { word: "plane", meaning: "飞机", pos: "n.", emoji: "✈️" },
  { word: "ship", meaning: "轮船", pos: "n.", emoji: "🚢" },
  { word: "morning", meaning: "早上", pos: "n.", emoji: "🌅" },
  { word: "night", meaning: "夜晚", pos: "n.", emoji: "🌃" },
  { word: "birthday", meaning: "生日", pos: "n.", emoji: "🎂" },

  // 长词，留给挑战档
  { word: "umbrella", meaning: "雨伞", pos: "n.", emoji: "☂️" },
  { word: "hospital", meaning: "医院", pos: "n.", emoji: "🏥" },
  { word: "computer", meaning: "电脑", pos: "n.", emoji: "💻" },
  { word: "football", meaning: "足球", pos: "n.", emoji: "⚽" },
  { word: "afternoon", meaning: "下午", pos: "n.", emoji: "🌇" },
  { word: "breakfast", meaning: "早餐", pos: "n.", emoji: "🍳" },
  { word: "vegetable", meaning: "蔬菜", pos: "n.", emoji: "🥦" },
  { word: "beautiful", meaning: "漂亮的", pos: "adj.", emoji: "🌺" },
  { word: "wonderful", meaning: "精彩的", pos: "adj.", emoji: "✨" },
  { word: "dangerous", meaning: "危险的", pos: "adj.", emoji: "⚠️" }
];

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
  return items;
}

function lengthRange(level: Level): [number, number] {
  if (level === "easy") return [3, 4];
  if (level === "hard") return [7, 12];
  return [5, 6];
}

/** 导出给测试：每档词库够不够撑一局。 */
export function poolSize(level: Level): number {
  const [min, max] = lengthRange(level);
  return WORDS.filter((entry) => entry.word.length >= min && entry.word.length <= max).length;
}

/**
 * 造字母牌。
 * 简单与普通档正好够用——多一块会让学生以为非得用完，反而卡住；
 * 挑战档故意多给一块，要他自己看出哪块是多余的。
 */
function buildLetters(word: string, level: Level): string[] {
  const letters = [...word.toLowerCase()];
  if (level === "hard") {
    const used = new Set(letters);
    const spare = shuffle([...ALPHABET].filter((char) => !used.has(char)))[0];
    if (spare) {
      letters.push(spare);
    }
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    shuffle(letters);
    if (letters.join("") !== word.toLowerCase()) {
      break;
    }
  }
  return letters;
}

export type WordSpellOptions = {
  level?: Level;
  rounds?: number;
};

export function createWordSpell(options: WordSpellOptions = {}): WordSpellGame {
  const level: Level = options.level ?? "normal";
  const wantRounds = Math.min(8, Math.max(3, Math.round(options.rounds ?? 5)));
  const [min, max] = lengthRange(level);
  const candidates = WORDS.filter((entry) => entry.word.length >= min && entry.word.length <= max);
  const pool = candidates.length >= wantRounds ? candidates : WORDS;

  const rounds = shuffle([...pool])
    .slice(0, wantRounds)
    .map((entry) => ({
      word: entry.word,
      meaning: entry.meaning,
      pos: entry.pos,
      ...(entry.emoji ? { emoji: entry.emoji } : {}),
      letters: buildLetters(entry.word, level)
    }));

  const title =
    level === "easy" ? "单词拼拼 · 看图拼词" : level === "hard" ? "单词拼拼 · 挑战" : "单词拼拼 · 看中文拼英文";
  const rules =
    level === "hard"
      ? "按顺序点字母拼出单词。字母牌里有一块是多余的，别被骗。"
      : "看中文意思，按顺序点字母，把英文单词拼出来。";

  return {
    kind: "game",
    gameId: gameId("ws"),
    type: "word_spell",
    title,
    rules,
    level,
    rounds,
    secondsPerRound: level === "hard" ? 55 : 45
  };
}
