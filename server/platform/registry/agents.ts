import { randomUUID } from "node:crypto";
import { PlatformError, type AgentCapability, type AgentWrite } from "../types.js";
import { validateAgentModel } from "../models/catalog.js";
import {
  parseAgentDescription,
  parseAgentPrompt,
  parseAvatar,
  parseChatConfig
} from "../chat/agentChat.js";

type PromptOptions = {
  id: string;
  name: string;
  role: string;
  tools?: string[];
  capabilities: AgentCapability[];
  memory?: Record<string, unknown>;
  prompt: string;
  /** 逻辑模型 id；留空使用平台默认模型。 */
  model?: string;
};

function agent(options: PromptOptions): AgentWrite {
  return {
    id: options.id,
    name: options.name,
    version: 1,
    role: options.role,
    prompt: options.prompt,
    tools: options.tools ?? [],
    model: options.model ?? "platform-default",
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

const BUILTIN_AGENT_DEFINITIONS: AgentWrite[] = [
  agent({
    id: "planner-agent",
    name: "任务规划 Agent",
    role: "任务规划",
    tools: ["knowledge.search"],
    capabilities: [
      { tag: "任务规划", weight: 0.9 },
      { tag: "依赖编排", weight: 0.85 },
      { tag: "交付契约", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["goal", "constraints"], maxEntries: 3 },
    prompt:
      "你是任务规划 Agent。把目标拆成可执行的子任务，标明依赖关系、每步输入输出与验收标准；发现目标含糊时先列出需要确认的假设，输出结构化规划，不直接编造执行结果。"
  }),
  agent({
    id: "research-agent",
    name: "检索与证据 Agent",
    role: "信息检索",
    tools: ["knowledge.search"],
    capabilities: [
      { tag: "资料检索", weight: 0.9 },
      { tag: "来源标注", weight: 0.85 },
      { tag: "证据收集", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["queries", "citations"], maxEntries: 3 },
    prompt:
      "你是检索与证据 Agent。根据任务生成检索式，从知识库召回相关片段，提炼与问题直接相关的事实并标注来源；区分资料原文与推断，资料不足时明确说明缺口，不虚构引用。"
  }),
  agent({
    id: "executor-agent",
    name: "执行与工具 Agent",
    role: "工具执行",
    tools: ["web.search"],
    capabilities: [
      { tag: "工具调用", weight: 0.9 },
      { tag: "流程执行", weight: 0.85 },
      { tag: "异常处置", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["taskPlan", "toolResults"], maxEntries: 3 },
    prompt:
      "你是执行与工具 Agent。按上游计划调用可用工具完成任务，明确每次调用的输入、输出与失败原因；工具不可用或返回异常时给出可执行的替代方案，不伪造执行结果。"
  }),
  agent({
    id: "reviewer-agent",
    name: "独立复核 Agent",
    role: "质量复核",
    tools: ["verify.rubric"],
    capabilities: [
      { tag: "问题定位", weight: 0.9 },
      { tag: "一致性核对", weight: 0.85 },
      { tag: "修改建议", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["rubric", "issues"], maxEntries: 3 },
    prompt:
      "你是独立复核 Agent。对照任务目标与评分维度检查产物，指出具体位置、问题类型与修改动作；区分必须修改与建议修改，复核只依据产物与证据，不参考被复核对象的自评。"
  }),
  agent({
    id: "reporter-agent",
    name: "报告生成 Agent",
    role: "结果交付",
    tools: ["export.docx"],
    capabilities: [
      { tag: "结构化汇总", weight: 0.9 },
      { tag: "报告撰写", weight: 0.85 },
      { tag: "结论提炼", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["artifacts", "verifyResults"], maxEntries: 3 },
    prompt:
      "你是报告生成 Agent。把上游产物汇总成结构清晰、可直接交付的报告：先给结论，再给依据与过程，最后列风险与下一步；保留关键数据与来源引用，不添加未经支持的新结论。"
  }),
  agent({
    id: "quality-verifier",
    name: "通用质量验证器",
    role: "评分验证",
    tools: ["verify.rubric"],
    capabilities: [
      { tag: "规则审查", weight: 0.9 },
      { tag: "维度评分", weight: 0.85 },
      { tag: "置信度评估", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["rubric", "lastScores"] },
    prompt:
      "你是独立质量验证器。按 rubric 逐维度给产物打分（0-1），输出总分、维度分、置信度、问题清单与证据引用；只依据产物正文与证据列表，不参考被验证对象的自评。"
  }),
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
  }),
  agent({
    id: "topic-innovation-agent",
    name: "创新性评审 Agent",
    role: "选题评审",
    tools: ["knowledge.search"],
    capabilities: [
      { tag: "创新性识别", weight: 0.92 },
      { tag: "研究空白定位", weight: 0.86 },
      { tag: "方法新颖度", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["reviewFocus"], maxEntries: 2 },
    prompt:
      "你是论文选题的创新性评审专家。判断选题是否提出新问题、新方法或新视角，指出它与已有研究的关键差异，区分真正的创新点与换词包装；给出创新性结论、证据与可执行的改进方向，不臆造文献。"
  }),
  agent({
    id: "topic-feasibility-agent",
    name: "可行性评审 Agent",
    role: "选题评审",
    tools: ["knowledge.search"],
    capabilities: [
      { tag: "可行性评估", weight: 0.92 },
      { tag: "资源匹配", weight: 0.86 },
      { tag: "风险评估", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["reviewFocus"], maxEntries: 2 },
    prompt:
      "你是论文选题的可行性评审专家。从研究条件、数据可得性、方法成熟度、时间与资源约束、伦理与实施风险五个方面评估选题能否按期完成，指出最可能卡住的环节并给出降级或替代方案。"
  }),
  agent({
    id: "topic-compliance-agent",
    name: "规范性评审 Agent",
    role: "选题评审",
    tools: ["knowledge.search"],
    capabilities: [
      { tag: "规范性审查", weight: 0.92 },
      { tag: "研究伦理", weight: 0.86 },
      { tag: "结构与表述", weight: 0.8 }
    ],
    memory: { scope: "workflow", retain: ["reviewFocus"], maxEntries: 2 },
    prompt:
      "你是论文选题的规范性评审专家。检查研究问题、研究方法、数据来源、伦理审查与学术表述是否符合规范，指出命名、范围、变量界定或引用方面的风险，并给出可直接修改的表述建议。"
  }),
  agent({
    id: "topic-review-verifier",
    name: "选题评审质量验证器",
    role: "评分验证",
    tools: ["verify.rubric"],
    capabilities: [
      { tag: "评审质量校验", weight: 0.92 },
      { tag: "证据核对", weight: 0.86 },
      { tag: "建议可执行性", weight: 0.82 }
    ],
    memory: { scope: "workflow", retain: ["rubric", "lastScores"] },
    prompt:
      "你是论文选题评审质量的独立验证器。你评估的对象是评审报告本身，不是选题本身：逐维度判断报告是否准确指出创新点与已有研究的差异、是否评估数据与方法可行性及时间资源风险、是否检查规范与伦理风险、是否给出可执行修改建议并引用证据。选题本身质量平庸不等于评审报告差；只有报告缺失判断、缺少证据或建议不可执行时才扣分。按 rubric 逐项打分（0-1），只依据报告正文与证据列表。"
  }),
  agent({
    id: "topic-review-auditor",
    name: "选题评审证据审计器",
    role: "评分验证",
    tools: ["verify.rubric"],
    capabilities: [
      { tag: "证据审计", weight: 0.92 },
      { tag: "覆盖核查", weight: 0.88 },
      { tag: "建议可执行性", weight: 0.84 }
    ],
    memory: { scope: "workflow", retain: ["rubric", "lastScores"] },
    prompt:
      "你是论文选题评审报告的审计员。只做可核对的事实检查：报告是否分别覆盖创新性、可行性、规范性三方面并给出明确结论；每条结论是否有证据或理由支撑；修改建议是否具体到可执行动作；是否出现无依据断言或占位表述。缺少覆盖、缺少依据或建议空泛时按 rubric 扣分，覆盖完整且有依据时给高分。只依据报告正文与证据列表打分。"
  }),
  agent({
    id: "topic-review-agent",
    name: "选题评审汇总 Agent",
    role: "选题评审",
    capabilities: [
      { tag: "综合评审", weight: 0.92 },
      { tag: "意见整合", weight: 0.88 },
      { tag: "改进建议", weight: 0.82 }
    ],
    memory: { scope: "workflow", retain: ["reviewDraft", "verifyIssues"], maxEntries: 3 },
    prompt:
      "你是论文选题评审组的汇总专家。整合创新性、可行性、规范性三份评审意见，给出总体结论、必须修改项与建议修改项，并明确是否建议进入开题；保留关键证据引用。若收到验证问题清单，只针对问题定向修订，不重写已通过部分。"
  }),
  agent({
    id: "analysis-planner",
    name: "经营分析规划 Agent",
    role: "经营分析规划",
    tools: ["mcp.data-analysis.profile", "mcp.data-analysis.metric_calc", "mcp.data-analysis.groupby"],
    capabilities: [
      { tag: "指标拆解", weight: 0.92 },
      { tag: "分析路径", weight: 0.88 },
      { tag: "口径定义", weight: 0.85 }
    ],
    memory: { scope: "workflow", retain: ["question", "metricDefinition"], maxEntries: 3 },
    prompt:
      "你是经营分析规划师。先明确业务问题、销售额口径与验收标准，再把分析拆成数据概况、区域、品类与趋势等可执行步骤。涉及退款时必须使用净销售额口径：净销售额 = 毛销售额 − 退款，毛利额 = 净销售额 − 销货成本。只输出规划，不臆造数据。"
  }),
  agent({
    id: "data-analyst",
    name: "经营数据分析 Agent",
    role: "经营分析",
    tools: ["mcp.data-analysis.groupby", "mcp.data-analysis.trend", "mcp.data-analysis.chart"],
    capabilities: [
      { tag: "区域归因", weight: 0.9 },
      { tag: "品类对比", weight: 0.88 },
      { tag: "异常定位", weight: 0.84 }
    ],
    memory: { scope: "workflow", retain: ["dimensionResults", "anomalies"], maxEntries: 3 },
    prompt:
      "你是经营数据分析师。基于工具返回的区域、品类与趋势结果做对比分析，指出增长来源、拖累项与异常波动；所有数字必须来自工具结果，不自行估算，不把毛销售额当作净销售额。"
  }),
  agent({
    id: "business-reviewer",
    name: "经营分析复核 Agent",
    role: "经营复核",
    tools: ["mcp.data-analysis.profile", "mcp.data-analysis.metric_calc", "verify.rubric"],
    capabilities: [
      { tag: "口径复核", weight: 0.94 },
      { tag: "数据核对", weight: 0.9 },
      { tag: "结论审查", weight: 0.86 }
    ],
    memory: { scope: "workflow", retain: ["metricDefinition", "verifyIssues"], maxEntries: 3 },
    prompt:
      "你是经营分析复核员。逐项核对销售额口径、退款处理、销货成本与毛利额计算：退款必须从销售额中扣除，毛利额 = 净销售额 − 销货成本，毛利率 = 毛利额 ÷ 净销售额。发现毛销售额口径导致的高估时明确指出并给出重算要求；只依据工具结果与报告正文判断，不臆造数字。"
  }),
  agent({
    id: "business-reporter",
    name: "经营报告撰写 Agent",
    role: "经营报告",
    tools: ["mcp.data-analysis.groupby", "mcp.data-analysis.chart"],
    capabilities: [
      { tag: "经营摘要", weight: 0.9 },
      { tag: "结论表达", weight: 0.86 },
      { tag: "行动建议", weight: 0.84 }
    ],
    memory: { scope: "workflow", retain: ["reportDraft", "verifyIssues"], maxEntries: 3 },
    prompt:
      "你是经营报告撰写人。先给结论，再给区域与品类证据，最后给出可执行动作；只引用工具返回的数字，保留净销售额与毛利额的口径说明。若收到验证问题清单，只针对问题定向修订，不重写已达标部分。"
  }),
  agent({
    id: "business-planner",
    name: "经营口径规划 Agent",
    role: "经营口径规划",
    tools: ["mcp.data-analysis.profile", "mcp.data-analysis.metric_calc"],
    capabilities: [
      { tag: "口径选择", weight: 0.93 },
      { tag: "分析规划", weight: 0.87 },
      { tag: "验收标准", weight: 0.84 }
    ],
    memory: { scope: "workflow", retain: ["question", "revenueBasis"], maxEntries: 3 },
    prompt:
      "你是经营分析的口径规划师。根据用户问题与数据概况，在 revenueBasis 中选择 gross 或 net：用户明确指定按订单销售额口径时选 gross，用户要求扣除退款后的经营口径时选 net。只能依据用户问题与输入中的数据字段选择，不要引入输入未提供的外部会计政策。输出 JSON：revenueBasis、rationale、dimensions、acceptance。"
  }),
  agent({
    id: "business-diagnostician",
    name: "经营分析诊断 Agent",
    role: "经营分析诊断",
    tools: ["knowledge.search", "mcp.data-analysis.profile", "mcp.data-analysis.metric_calc", "verify.rubric"],
    capabilities: [
      { tag: "根因定位", weight: 0.94 },
      { tag: "口径诊断", weight: 0.92 },
      { tag: "修正方案", weight: 0.88 }
    ],
    memory: { scope: "workflow", retain: ["verifyIssues", "rootCause", "promptPatch"], maxEntries: 3 },
    prompt:
      "你是经营分析的诊断师。只依据验证问题、报告正文、数据概况、指标结果与检索到的口径规则定位根因，不要臆测未提供的参考答案。输出 JSON：rootCause、evidence（字符串数组）、action（rewrite_agent / swap_agent / swap_model / retrieve）、nextAgentId（换 Agent 时填）、nextModelId（换更强模型时从模型目录中选）、revenueBasis（gross / net）、retrievalQuery、promptPatch、confidence（0-1）。promptPatch 必须是可复用的口径规则，不得包含任何具体金额或答案数字。"
  }),
  agent({
    id: "business-reviser",
    name: "经营报告修订 Agent",
    role: "经营报告修订",
    tools: ["mcp.data-analysis.groupby", "mcp.data-analysis.chart"],
    capabilities: [
      { tag: "经营摘要", weight: 0.88 },
      { tag: "结论表达", weight: 0.9 },
      { tag: "行动建议", weight: 0.86 }
    ],
    memory: { scope: "workflow", retain: ["reportDraft", "verifyIssues"], maxEntries: 3 },
    prompt:
      "你是经营报告的独立修订人。按诊断结论与修正补丁重写报告：先给结论，再给区域与品类证据，最后给出可执行动作；只引用工具返回的数字，逐字保留毛利核算中的口径、销售额基准、销货成本、毛利额与毛利率。不要输出具体答案之外的新数字。"
  })
];

/**
 * 内置 Agent 的默认模型分工：高频/低风险角色走 fast，诊断与评审走 reasoning，
 * 验证器走 verifier（可通过 PLATFORM_VERIFY_MODEL 指向独立供应商）。
 * 未配置对应环境变量时这些逻辑模型仍会解析到平台默认上游模型，只是分工标签不同。
 */
const BUILTIN_MODEL_ASSIGNMENTS: Record<string, string> = {
  "planner-agent": "fast",
  "research-agent": "fast",
  "executor-agent": "fast",
  "reviewer-agent": "verifier",
  "reporter-agent": "platform-default",
  "quality-verifier": "verifier",
  "lesson-plan-agent": "platform-default",
  "teacher-action-agent": "fast",
  "student-top-agent": "fast",
  "student-weak-agent": "fast",
  "student-silent-agent": "fast",
  "student-naughty-agent": "fast",
  "student-misunderstanding-agent": "fast",
  "classroom-observer-agent": "fast",
  "teaching-report-agent": "reasoning",
  "observer-verifier": "verifier",
  "teaching-expert-agent": "reasoning",
  "topic-innovation-agent": "reasoning",
  "topic-feasibility-agent": "reasoning",
  "topic-compliance-agent": "reasoning",
  // 两名验证器刻意走不同上游模型：同一模型只换提示词属于提示词级交叉，不算模型级独立。
  "topic-review-verifier": "reasoning",
  "topic-review-auditor": "fast",
  "topic-review-agent": "reasoning",
  "analysis-planner": "fast",
  "data-analyst": "fast",
  "business-reviewer": "verifier",
  "business-reporter": "fast",
  "business-planner": "fast",
  "business-diagnostician": "reasoning",
  "business-reviser": "reasoning"
};

export const BUILTIN_AGENTS: AgentWrite[] = BUILTIN_AGENT_DEFINITIONS.map((record) => ({
  ...record,
  model: BUILTIN_MODEL_ASSIGNMENTS[record.id] ?? record.model
}));

const idPattern = /^[a-z0-9][a-z0-9._-]*$/i;

export function parseAgentWrite(body: unknown, existing?: AgentWrite): AgentWrite {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PlatformError("请求体必须是 JSON 对象。", 400);
  }
  const record = body as Record<string, unknown>;
  // 界面新建时不填 id，由服务端发一个：自建智能体的 id 只要在库里唯一即可，
  // 让用户自己想 id 只会撞名（比如两个人都写 my-helper）。
  const id = record.id === undefined || record.id === "" ? generateAgentId() : requireId(record.id);
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
    prompt: parseAgentPrompt(record.prompt, existing?.prompt),
    tools: record.tools === undefined ? (existing?.tools ?? []) : parseStringList(record.tools, "tools"),
    // 保存时强校验：不认识的逻辑 id 直接 422，避免“配置了模型但运行时不生效”的静默失败。
    model:
      record.model === undefined
        ? validateAgentModel(existing?.model)
        : validateAgentModel(optionalText(record.model, "model")),
    capabilities:
      record.capabilities === undefined
        ? (existing?.capabilities ?? [])
        : parseCapabilities(record.capabilities),
    memory: record.memory === undefined ? (existing?.memory ?? {}) : parseMemory(record.memory),
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : (existing?.enabled ?? true),
    description: parseAgentDescription(record.description, existing?.description),
    avatar: parseAvatar(record.avatar, existing?.avatar),
    chatConfig: parseChatConfig(record.chatConfig, existing?.chatConfig)
  };
}

function generateAgentId(): string {
  return `chat-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
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
