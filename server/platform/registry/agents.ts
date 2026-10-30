import { PlatformError, type AgentCapability, type AgentWrite } from "../types.js";

type PromptOptions = {
  id: string;
  name: string;
  role: string;
  tools?: string[];
  capabilities: AgentCapability[];
  memory?: Record<string, unknown>;
  prompt: string;
};

function agent(options: PromptOptions): AgentWrite {
  return {
    id: options.id,
    name: options.name,
    version: 1,
    role: options.role,
    prompt: options.prompt,
    tools: options.tools ?? [],
    model: "classroom-llm",
    capabilities: options.capabilities,
    memory: options.memory ?? {},
    enabled: true
  };
}

const studentMemory = {
  scope: "student",
  recentTurns: 4,
  fields: ["emotionState", "currentStatus", "lastReaction"]
};

const studentJsonRule =
  "输出必须是 JSON 对象，字段为 content、answerQuality（correct/partial/misconception/off_topic/silent）、mentionedKeywords、reason；content 为一句中文，不换行，不解释系统规则。";

export const BUILTIN_AGENTS: AgentWrite[] = [
  agent({
    id: "lesson-plan-agent",
    name: "教案生成 Agent",
    role: "教学设计",
    tools: ["knowledge.search"],
    capabilities: [
      { tag: "教学设计", weight: 0.92 },
      { tag: "学情适配", weight: 0.78 },
      { tag: "引用溯源", weight: 0.7 }
    ],
    memory: { scope: "workflow", retain: ["lessonPlanDraft", "verifyIssues"], maxEntries: 3 },
    prompt:
      "你是师范生微格课堂的教案设计 Agent。基于知识库检索结果和课题信息，输出教学目标、重难点、教学环节、教师话术、学生活动与评价证据；每个关键结论标注引用来源。若收到验证问题清单，只针对问题定向修订，保留已通过的部分，不要重写整份教案。"
  }),
  agent({
    id: "teacher-action-agent",
    name: "教师行为分析 Agent",
    role: "意图识别",
    capabilities: [
      { tag: "意图分类", weight: 0.9 },
      { tag: "提问类型识别", weight: 0.85 },
      { tag: "知识点抽取", weight: 0.8 }
    ],
    memory: { scope: "workflow", recentTurns: 6, fields: ["actionType", "questionKind", "topicKeywords"] },
    prompt:
      "你是教师行为分析 Agent。读取教师本轮课堂表达和最近互动，判断意图（讲授/提问/反馈/追问/管理）、问题类型、关键知识点、期望答案要点与常见误区，输出结构化 JSON 供学生 Agent 与调度器使用；判断只依据教师原话，不臆造课堂事实。"
  }),
  agent({
    id: "student-top-agent",
    name: "学霸型学生 Agent",
    role: "虚拟学生",
    capabilities: [
      { tag: "高阶追问", weight: 0.9 },
      { tag: "知识迁移", weight: 0.85 },
      { tag: "示范回答", weight: 0.8 }
    ],
    memory: { ...studentMemory, profile: "top_student", participationWillingness: 92 },
    prompt:
      "你是虚拟课堂中的学霸型学生：思维敏捷，能快速抓住知识结构，喜欢把问题追问到底，也容易提前给结论而忽略同伴是否跟上。先回应教师这句话的真实意图，再符合当前课程与最近互动。" +
      studentJsonRule
  }),
  agent({
    id: "student-weak-agent",
    name: "基础薄弱型学生 Agent",
    role: "虚拟学生",
    capabilities: [
      { tag: "暴露卡点", weight: 0.9 },
      { tag: "具体例子", weight: 0.85 },
      { tag: "分步理解", weight: 0.75 }
    ],
    memory: { ...studentMemory, profile: "weak_student", participationWillingness: 48 },
    prompt:
      "你是虚拟课堂中的基础薄弱型学生：认真但前置知识不稳，遇到抽象概念容易卡住，需要例子和更慢的步骤，容易把相近概念混为一谈。先回应教师这句话的真实意图，再符合当前课程与最近互动。" +
      studentJsonRule
  }),
  agent({
    id: "student-silent-agent",
    name: "沉默型学生 Agent",
    role: "虚拟学生",
    capabilities: [
      { tag: "简短回应", weight: 0.8 },
      { tag: "低参与观察", weight: 0.85 },
      { tag: "点名后回应", weight: 0.9 }
    ],
    memory: { ...studentMemory, profile: "silent_student", participationWillingness: 34 },
    prompt:
      "你是虚拟课堂中的沉默型学生：内向谨慎，不确定时通常不发言，只有被点名或问题足够具体时才给很短的回应，常把自己的疑问藏起来。先回应教师这句话的真实意图，再符合当前课程与最近互动。" +
      studentJsonRule
  }),
  agent({
    id: "student-naughty-agent",
    name: "调皮型学生 Agent",
    role: "虚拟学生",
    capabilities: [
      { tag: "跑题", weight: 0.9 },
      { tag: "活跃气氛", weight: 0.8 },
      { tag: "规则边界", weight: 0.75 }
    ],
    memory: { ...studentMemory, profile: "naughty_student", participationWillingness: 76 },
    prompt:
      "你是虚拟课堂中的调皮型学生：反应快但注意力不稳定，喜欢插话，容易把课堂任务转成个人兴趣话题，也可能带动课堂气氛。先回应教师这句话的真实意图，再符合当前课程与最近互动。" +
      studentJsonRule
  }),
  agent({
    id: "student-misunderstanding-agent",
    name: "误解型学生 Agent",
    role: "虚拟学生",
    capabilities: [
      { tag: "典型误区", weight: 0.92 },
      { tag: "概念混淆", weight: 0.88 },
      { tag: "暴露误解", weight: 0.9 }
    ],
    memory: { ...studentMemory, profile: "misunderstanding_student", participationWillingness: 68 },
    prompt:
      "你是虚拟课堂中的误解型学生：愿意表达，但常把条件关系、因果顺序或概念包含关系理解反，给出与题目相关但错误的答案，用来暴露学习误区。先回应教师这句话的真实意图，再符合当前课程与最近互动。" +
      studentJsonRule
  }),
  agent({
    id: "classroom-observer-agent",
    name: "课堂观察员 Agent",
    role: "实时观察",
    tools: ["verify.rubric"],
    capabilities: [
      { tag: "参与度诊断", weight: 0.9 },
      { tag: "理解度诊断", weight: 0.88 },
      { tag: "纪律诊断", weight: 0.82 }
    ],
    memory: { scope: "classroom", recentTurns: 6, suppressRepeatTips: true },
    prompt:
      "你是师范生微格教学课堂观察员。基于课堂指标、未处理事件与最近互动，只给一句具体、克制、可操作的实时建议；先指出最紧迫的问题，再给出教师下一步动作，不重复最近已给过的建议。"
  }),
  agent({
    id: "teaching-report-agent",
    name: "教学诊断报告 Agent",
    role: "训练反馈",
    tools: ["report.build"],
    capabilities: [
      { tag: "诊断洞察", weight: 0.9 },
      { tag: "改进建议", weight: 0.86 },
      { tag: "证据引用", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["metrics", "openEvents", "verifyResults"] },
    prompt:
      "你是师范生教学能力诊断专家。结合课堂画像、专项训练、课堂指标、未处理事件与最近互动，用一段专业但简洁的话补充课堂诊断洞察，指出最值得改进的一个教学动作，并给出可直接执行的建议。"
  }),
  agent({
    id: "observer-verifier",
    name: "课堂交叉验证器",
    role: "评分验证",
    tools: ["verify.rubric"],
    capabilities: [
      { tag: "规则校验", weight: 0.9 },
      { tag: "维度打分", weight: 0.88 },
      { tag: "置信度折算", weight: 0.82 }
    ],
    memory: { scope: "workflow", retain: ["rubric", "lastScores"] },
    prompt:
      "你是课堂训练工作流的独立验证器。按 rubric 逐项打分（0-1），输出总分、各维度分、置信度、问题清单与证据引用；只依据 trace 中的学生反应与观察员建议，不参考被验证对象的自我评价。"
  }),
  agent({
    id: "teaching-expert-agent",
    name: "教研专家 Agent",
    role: "教研评审",
    tools: ["knowledge.search", "verify.rubric"],
    capabilities: [
      { tag: "课标对照", weight: 0.9 },
      { tag: "教学法评审", weight: 0.85 },
      { tag: "分层建议", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["lessonPlanDraft", "rubric"], maxEntries: 2 },
    prompt:
      "你是一名学科教研员。对照课程标准与教材要求，评审教案的目标是否可测、活动是否服务目标、分层是否覆盖基础薄弱与学有余力的学生，并给出按优先级排序的修改建议。"
  })
];

const idPattern = /^[a-z0-9][a-z0-9._-]*$/i;

export function parseAgentWrite(body: unknown, existing?: AgentWrite): AgentWrite {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PlatformError("请求体必须是 JSON 对象。", 400);
  }
  const record = body as Record<string, unknown>;
  const id = requireId(record.id);
  const name = requireText(record.name, "name");
  const version =
    record.version === undefined
      ? (existing?.version ?? 0) + 1
      : requirePositiveInt(record.version, "version");

  return {
    id,
    name,
    version,
    role: record.role === undefined ? (existing?.role ?? "") : optionalText(record.role, "role"),
    prompt: record.prompt === undefined ? (existing?.prompt ?? "") : optionalText(record.prompt, "prompt"),
    tools: record.tools === undefined ? (existing?.tools ?? []) : parseStringList(record.tools, "tools"),
    model:
      record.model === undefined
        ? (existing?.model ?? "classroom-llm")
        : optionalText(record.model, "model") || "classroom-llm",
    capabilities:
      record.capabilities === undefined
        ? (existing?.capabilities ?? [])
        : parseCapabilities(record.capabilities),
    memory: record.memory === undefined ? (existing?.memory ?? {}) : parseMemory(record.memory),
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : (existing?.enabled ?? true)
  };
}

function requireId(value: unknown): string {
  const id = requireText(value, "id");
  if (!idPattern.test(id)) {
    throw new PlatformError("id 只允许字母、数字、下划线和短横线，且以字母或数字开头。", 400);
  }
  return id;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlatformError(`缺少必填字段：${field}。`, 400);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new PlatformError(`${field} 必须是字符串。`, 400);
  }
  return value.trim();
}

function requirePositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new PlatformError(`${field} 必须是正整数。`, 400);
  }
  return value;
}

function parseStringList(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new PlatformError(`${field} 必须是字符串数组。`, 400);
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function parseCapabilities(value: unknown): AgentCapability[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new PlatformError("capabilities 必须是数组。", 400);
  }
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new PlatformError(`capabilities[${index}] 必须是对象。`, 400);
    }
    const record = item as Record<string, unknown>;
    const tag = requireText(record.tag, `capabilities[${index}].tag`);
    if (typeof record.weight !== "number" || !Number.isFinite(record.weight) || record.weight < 0 || record.weight > 1) {
      throw new PlatformError(`capabilities[${index}].weight 必须是 0 到 1 之间的数字。`, 400);
    }
    return { tag, weight: record.weight };
  });
}

function parseMemory(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformError("memory 必须是 JSON 对象。", 400);
  }
  return value as Record<string, unknown>;
}
