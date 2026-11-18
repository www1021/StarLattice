import type { CounselingCase } from "../../shared/counseling.js";
import { completeQwenChat, getPlatformLiveModel, streamQwenChat, type ChatMessage } from "../qwenOpenAiClient.js";
import { counselingCases } from "./cases.js";

/**
 * 谈心聊天室：一个轻量的双人对话，不落库、不评分。
 * 和 counseling-session 工作流的区别是「谁扮演谁」可以反过来：
 * - counselor：用户当开导者，AI 扮演学生，用来练怎么开口；
 * - seeker：用户当被开导者，AI 扮演老师，用来先被接住情绪。
 */
export type RoomMode = "counselor" | "seeker";

export type RoomMessage = { role: "user" | "assistant"; content: string };

export type RoomRequest = {
  mode: RoomMode;
  caseId?: string;
  topic?: string;
  messages: RoomMessage[];
};

const maxTurns = 60;
const maxChars = 2000;

const caseKeywords: Array<[string, RegExp]> = [
  ["safety", /自杀|自伤|轻生|不想活|活着没意思|消失就好/],
  ["academic", /成绩|考试|挂科|补考|绩点|学不进去|保研|排名/],
  ["dormitory", /宿舍|室友|寝室|作息|打游戏/],
  ["relationship", /分手|失恋|感情|对象|男朋友|女朋友|喜欢的人/],
  ["financial", /生活费|经济|兼职|交不起|没钱|家里困难/],
  ["conflict", /处分|冲突|顶撞|批评|冤枉|不公平/]
];

/** 名字后面常粘着这些词：截断时按最早的边界切，避免把「林小满因为成绩」当成姓名。 */
const NAME_STOPS = [
  "因为", "由于", "最近", "现在", "平时", "总是", "最近", "这学期", "这段时间",
  "情绪", "成绩", "考试", "同学", "老师", "宿舍", "家里", "他", "她", "的", "是",
  "在", "跟", "和", "说", "想", "最", "总", "老", "上", "被", "有", "又"
];

function cutAtStopWord(raw: string): string | undefined {
  let name = raw;
  for (let index = 2; index < name.length; index += 1) {
    const rest = name.slice(index);
    const stop = NAME_STOPS.find((word) => rest.startsWith(word));
    if (stop) {
      name = name.slice(0, index);
      break;
    }
  }
  return name.length >= 2 && name.length <= 4 ? name : undefined;
}

/**
 * 从用户的话里取学生姓名：「我们班有个学生叫林小满」→ 林小满。
 * 取不到就返回 undefined，由调用方用个案自带的姓名兜底，不编一个假的。
 */
export function extractStudentName(topic?: string): string | undefined {
  const text = (topic ?? "").replace(/\s+/g, "");
  if (!text) return undefined;
  const patterns = [
    /(?:名字叫|名字是|名叫|叫做|叫)([\u4e00-\u9fa5]{2,6})/,
    /(?:同学|学生)([\u4e00-\u9fa5]{2,3})(?:最近|因为|说|的|，|。|$)/,
    /(?:有位|有个|有一个)([\u4e00-\u9fa5]{2,4})(?:同学|学生)/
  ];
  for (const pattern of patterns) {
    const matched = pattern.exec(text);
    const name = matched?.[1] ? cutAtStopWord(matched[1]) : undefined;
    if (name) return name;
  }
  return undefined;
}

/** 先按显式 caseId，再按话题里的关键词挑个案；都没有就用成绩压力这个最通用的。 */
export function resolveRoomCase(topic: string | undefined, caseId?: string): CounselingCase {
  const explicit = counselingCases.find((item) => item.id === caseId);
  if (explicit) return withTopicName(explicit, topic);
  const text = topic ?? "";
  for (const [id, pattern] of caseKeywords) {
    if (pattern.test(text)) {
      const matched = counselingCases.find((item) => item.id === id);
      if (matched) return withTopicName(matched, topic);
    }
  }
  return withTopicName(counselingCases[0]!, topic);
}

/** 用户已经点名学生是谁，就按他的说法来，别让 AI 换个名字出戏。 */
function withTopicName(student: CounselingCase, topic?: string): CounselingCase {
  const name = extractStudentName(topic);
  return name ? { ...student, name } : student;
}

export function openRoomTurn(mode: RoomMode, student: CounselingCase) {
  if (mode === "counselor") return student.opening;
  return "我在，不用急着说清楚。最近是哪件事最压着你？";
}

function counselorPrompt(student: CounselingCase, topic?: string) {
  return [
    "你在扮演一位正在被班主任谈心的大学生，只以这个学生的身份说话。",
    "【人物】",
    `姓名：${student.name}；年级专业：${student.year}；这件事：${student.title}。`,
    `背景：${student.background}`,
    `心里最在意的：${student.concern}`,
    topic ? `这次谈话的起因：${topic}` : "",
    "【怎么说话】",
    "每次只说 1 到 3 句口语，可以停顿、犹豫、反问、嘴硬，不用把话说完整。",
    "不要主动给建议，不要反过来开导对方，不要跳出角色解释自己在扮演。",
    "态度跟着对方变：被认真听、被理解，就多讲一点真实想法；被说教、被贴标签、被追问隐私，就更短、更封闭，甚至顶一句。",
    "不用括号写动作旁白，不用 markdown，不分点，不加引号。",
    "绝不承认自己是 AI、模型或程序。",
    "如果对方说出明显伤害你的话，用这个学生的方式表达难过或沉默，不要变成客服。"
  ]
    .filter(Boolean)
    .join("\n");
}

function seekerPrompt(student: CounselingCase, topic?: string) {
  return [
    "你在扮演一位有经验的班主任兼心理老师，正在陪一个主动来倾诉的学生说话。",
    "【对方情况】",
    `话题：${topic || student.title}。`,
    `他可能卡住的地方：${student.concern}`,
    "【怎么说话】",
    "每次 2 到 4 句口语。先具体接住他的感受（把他说的东西复述回去），再问一个具体的问题，或者给一个现在就能做的小动作。",
    "一次只推进一步：不连发建议，不分点，不用 markdown，不讲大道理，不写小标题。",
    "不诊断、不贴标签、不说「你应该」「你必须」。",
    "如果他提到自伤、自杀、被伤害：直接、平静地确认当下是否安全，建议立刻联系学校心理中心，或拨打全国心理援助热线 12356，并陪他联系一个可信任的人。这时候不要继续讲方法。",
    "绝不承认自己是 AI、模型或程序，也不要提「作为AI」。"
  ].join("\n");
}

export function roomSystemPrompt(request: RoomRequest, student: CounselingCase) {
  return request.mode === "counselor"
    ? counselorPrompt(student, request.topic)
    : seekerPrompt(student, request.topic);
}

/** 只保留最近若干轮，且压掉超长内容，避免把整段历史塞给模型拖慢首字。 */
export function normalizeRoomMessages(messages: RoomMessage[]) {
  return messages
    .filter((item) => (item.role === "user" || item.role === "assistant") && typeof item.content === "string")
    .map((item) => ({ role: item.role, content: item.content.slice(0, maxChars) }))
    .slice(-maxTurns);
}

export async function streamRoomTurn(input: {
  request: RoomRequest;
  signal?: AbortSignal;
  onDelta: (delta: string) => void;
}) {
  const student = resolveRoomCase(input.request.topic, input.request.caseId);
  const messages: ChatMessage[] = normalizeRoomMessages(input.request.messages);
  return streamQwenChat({
    system: roomSystemPrompt(input.request, student),
    messages,
    // 聊天室里一句话要等两三秒就没人愿意聊了，默认走快模型。
    model: process.env.COUNSELING_ROOM_MODEL || "qwen-flash",
    temperature: 0.85,
    maxTokens: 320,
    signal: input.signal,
    onDelta: input.onDelta,
    onThinkingDelta: () => undefined
  });
}

const summaryPrompt = [
  "你是带教老师，看完一场模拟谈心，给学生一段简短的复盘。",
  "只输出三段纯文本，每段一到两句，段间换行：",
  "第一段说这次做得好的两处（要具体到他说过的话）；",
  "第二段说可以再往前一步的两处；",
  "第三段给一句下次可以直接用的开场话。",
  "不要 markdown 符号，不要小标题，不要分点编号，不要总分总。"
].join("\n");

export async function summarizeRoom(input: {
  request: RoomRequest;
  signal?: AbortSignal;
}) {
  const student = resolveRoomCase(input.request.topic, input.request.caseId);
  const history = normalizeRoomMessages(input.request.messages)
    .map((item) => `${item.role === "user" ? "我" : "对方"}：${item.content}`)
    .join("\n");
  const roleHint =
    input.request.mode === "counselor"
      ? `我这轮扮演的是开导者，AI 扮演学生（${student.name}，${student.title}）。`
      : "我这轮扮演的是被开导的学生，AI 扮演老师。请从「我该怎么继续」的角度点评。";
  const result = await completeQwenChat({
    system: summaryPrompt,
    messages: [
      {
        role: "user",
        content: `${roleHint}\n\n整段对话：\n${history || "（还没开始说话）"}`
      }
    ],
    model: getPlatformLiveModel(),
    temperature: 0.5,
    maxTokens: 420,
    signal: input.signal
  });
  return String(result ?? "").trim();
}
