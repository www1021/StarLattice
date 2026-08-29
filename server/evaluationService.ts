import { randomUUID } from "node:crypto";
import type {
  EvaluationDimension,
  StoredChatMessage,
  StoredCitation,
  TrainingEvaluation,
  TrainingType
} from "./storage/chatRepository.js";

type EvaluationInput = {
  conversationId: string;
  trainingType: TrainingType;
  messages: StoredChatMessage[];
  citations: StoredCitation[];
};

const dimensionRules: Array<{
  name: string;
  signals: string[];
  strongComment: string;
  weakComment: string;
}> = [
  {
    name: "教学目标",
    signals: ["教学目标", "核心素养", "知识与技能", "过程与方法", "情感态度", "达成", "目标"],
    strongComment: "目标表达较清晰，能够支撑后续教学活动设计。",
    weakComment: "目标还需要更具体，建议补充可观察、可评价的学习结果。"
  },
  {
    name: "学情分析",
    signals: ["学情", "学生", "已有经验", "认知", "困难", "差异", "基础"],
    strongComment: "能关注学生基础和学习困难，具备学生中心意识。",
    weakComment: "对学生起点和可能困难描述不足，后续设计容易泛化。"
  },
  {
    name: "教学活动",
    signals: ["导入", "活动", "探究", "讨论", "练习", "任务", "板书", "评价"],
    strongComment: "活动链条较完整，能够形成课堂推进节奏。",
    weakComment: "活动设计还偏笼统，应明确任务、材料、时间和产出。"
  },
  {
    name: "课堂互动",
    signals: ["提问", "追问", "互动", "回答", "小组", "反馈", "生成", "评委"],
    strongComment: "具备互动意识，能通过追问推动学生表达和思考。",
    weakComment: "互动预案不足，建议增加学生可能回答及教师追问路径。"
  },
  {
    name: "反思改进",
    signals: ["反思", "问题", "改进", "优化", "证据", "不足", "下一步", "复盘"],
    strongComment: "能把问题转化为改进动作，形成持续迭代意识。",
    weakComment: "反思还停留在感受层面，需要补充证据和下一次行动。"
  },
  {
    name: "师德育人",
    signals: ["师德", "育人", "价值", "情感", "责任", "教育家精神", "关怀", "公平"],
    strongComment: "能够把学科教学与价值引导、教师示范自然结合。",
    weakComment: "育人目标呈现不足，可补充价值引导和课堂关怀细节。"
  }
];

export function createTrainingEvaluation({
  conversationId,
  trainingType,
  messages,
  citations
}: EvaluationInput): TrainingEvaluation {
  const text = messages.map((message) => message.content).join("\n");
  const dimensions = dimensionRules.map((rule) => scoreDimension(rule, text, citations));
  const overallScore = Math.round(
    dimensions.reduce((total, dimension) => total + dimension.score, 0) /
      dimensions.length
  );
  const weakDimensions = dimensions.filter((dimension) => dimension.score < 80);
  const diagnosis = buildDiagnosis(trainingType, weakDimensions, citations);

  return {
    id: `eval_${randomUUID()}`,
    conversationId,
    trainingType,
    overallScore,
    dimensions,
    diagnosis,
    suggestions: buildSuggestions(trainingType, weakDimensions, citations),
    nextTask: buildNextTask(trainingType, weakDimensions),
    citations: citations.slice(0, 3),
    createdAt: new Date().toISOString()
  };
}

export function inferTrainingType(text: string): TrainingType {
  if (/说课|评委|说课稿/.test(text)) {
    return "说课陪练";
  }

  if (/模拟课堂|课堂提问|追问|学生回答/.test(text)) {
    return "模拟课堂";
  }

  if (/实习|反思|日志|课堂观察/.test(text)) {
    return "实习反思";
  }

  return "教案诊断";
}

function scoreDimension(
  rule: (typeof dimensionRules)[number],
  text: string,
  citations: StoredCitation[]
): EvaluationDimension {
  const matchedSignals = rule.signals.filter((signal) => text.includes(signal));
  const lengthBonus = Math.min(8, Math.floor(text.length / 900));
  const citationBonus = citations.length > 0 ? 4 : 0;
  const score = clampScore(66 + matchedSignals.length * 5 + lengthBonus + citationBonus);

  return {
    name: rule.name,
    score,
    comment: score >= 80 ? rule.strongComment : rule.weakComment
  };
}

function buildDiagnosis(
  trainingType: TrainingType,
  weakDimensions: EvaluationDimension[],
  citations: StoredCitation[]
) {
  const diagnosis = weakDimensions.length
    ? weakDimensions.map(
        (dimension) => `${dimension.name}仍是本轮${trainingType}的主要短板：${dimension.comment}`
      )
    : [`本轮${trainingType}已经形成较完整的设计、演练与反馈链条。`];

  if (citations.length === 0) {
    diagnosis.push("本次训练没有引用知识库资料，比赛演示时建议选择课程标准或课例资料增强依据。");
  } else {
    diagnosis.push(`本次评价已结合 ${citations.length} 条知识库片段，具备资料依据。`);
  }

  return diagnosis.slice(0, 4);
}

function buildSuggestions(
  trainingType: TrainingType,
  weakDimensions: EvaluationDimension[],
  citations: StoredCitation[]
) {
  const suggestions = weakDimensions.slice(0, 3).map((dimension) => {
    if (dimension.name === "课堂互动") {
      return "补充“学生可能回答—教师追问—评价反馈”三列表，让模拟课堂更像真实课堂。";
    }

    if (dimension.name === "反思改进") {
      return "把反思改写成“现象证据、原因分析、下次行动”三段式，避免空泛总结。";
    }

    if (dimension.name === "学情分析") {
      return "增加学生已有知识、常见误区和差异化支持，体现学生中心。";
    }

    if (dimension.name === "师德育人") {
      return "在教学环节中嵌入价值引导、课堂关怀或教师示范语言。";
    }

    return `围绕「${dimension.name}」补充更具体的描述，并在下一轮训练中重点复核。`;
  });

  if (citations.length > 0) {
    suggestions.push("保留知识库引用来源，并在修改稿中标注哪些建议来自课程标准或优秀课例。");
  }

  if (suggestions.length === 0) {
    suggestions.push(`将本轮${trainingType}整理为可复用模板，并用另一节课进行迁移训练。`);
  }

  return suggestions.slice(0, 4);
}

function buildNextTask(
  trainingType: TrainingType,
  weakDimensions: EvaluationDimension[]
) {
  const weakest = weakDimensions[0]?.name;

  if (weakest === "课堂互动") {
    return "下一轮做 8 分钟模拟课堂追问训练，至少准备 3 种学生回答分支。";
  }

  if (weakest === "教学目标") {
    return "下一轮先重写教学目标，再让平台检查目标、活动和评价是否一致。";
  }

  if (weakest === "反思改进") {
    return "下一轮提交一篇实习反思，重点写清证据、原因和改进动作。";
  }

  if (trainingType === "说课陪练") {
    return "继续进行一轮说课追问，重点回答教学目标、重难点和学情依据。";
  }

  return "基于本轮反馈修改一次作品，再发起复评，完成“反馈—修改—再实践”闭环。";
}

function clampScore(score: number) {
  return Math.max(58, Math.min(96, score));
}
