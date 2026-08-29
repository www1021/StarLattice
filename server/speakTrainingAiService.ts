import { randomUUID } from "node:crypto";
import { isQwenConfigured, streamQwenChat } from "./qwenOpenAiClient.js";
import type {
  DefenseOptimizationPlan,
  DefenseQuestion,
  SpeakAiFocusHint,
  SpeakRoleId,
  SpeakTrainingReport,
  SpeakTrainingSessionState
} from "./speakTrainingService.js";

type AiQuestionDraft = {
  role: SpeakRoleId;
  question: string;
  targetDimension: string;
  sourceEvidence: string;
  reason: string;
};

type AiOptimizationDraft = Pick<
  NonNullable<DefenseOptimizationPlan>["items"][number],
  "questionId" | "answerDiagnosis" | "revisionPlan" | "replacementScript" | "preparationActions"
>;

export async function generateSpeakAiEnhancement({
  session,
  report,
  citations
}: {
  session: SpeakTrainingSessionState;
  report: SpeakTrainingReport;
  citations: Array<{ documentName: string; snippet: string }>;
}) {
  if (!isQwenConfigured()) {
    return undefined;
  }

  const originalText = session.segments.map((segment) => segment.text).join("\n").slice(0, 7000);
  const existingQuestions = session.defenseQuestions.map((question) => question.question).join("\n");
  const result = await streamQwenChat({
    system: [
      "你是说课训练中的教研追问 Agent。只输出 JSON，不要 Markdown。",
      "你的任务是针对教师的说课原文提出 2-3 道不重复的专业追问，并生成右侧专业关注点。",
      "每个问题必须直接引用原文中的一小段，或明确写‘原文未说明…’；不能给泛化题。",
      "优先关注教学目标、学情、重难点、活动、评价、板书和课堂风险。",
      "questions 字段为 [{role,question,targetDimension,sourceEvidence,reason}]；role 只能是 researcher、teacher、expert。",
      "focusHints 字段为 [{label,detail,sourceEvidence}]，最多 3 条，术语需专业但可理解。"
    ].join("\n"),
    messages: [{
      role: "user",
      content: [
        `说课原文：\n${originalText || "暂无原文"}`,
        `当前缺漏：${report.missingStages.join("、") || "无"}`,
        `当前逻辑风险：${[...report.logicBreakpoints, ...report.defenseRisks].slice(0, 6).join("；") || "无"}`,
        `已存在问题（不得重复）：${existingQuestions || "无"}`,
        `可参考资料：${citations.slice(0, 3).map((item) => `${item.documentName}：${item.snippet}`).join("；") || "无"}`
      ].join("\n\n")
    }],
    maxTokens: 1500,
    onDelta() {},
    onThinkingDelta() {}
  });
  const parsed = parseJson(result.visibleAssistantContent) as {
    questions?: AiQuestionDraft[];
    focusHints?: SpeakAiFocusHint[];
  } | undefined;
  const questions = (parsed?.questions || [])
    .filter((item) => isValidQuestionDraft(item, originalText, existingQuestions))
    .slice(0, 3)
    .map((item) => toDefenseQuestion(item));
  const focusHints = (parsed?.focusHints || [])
    .filter((item) => item.label && item.detail && item.sourceEvidence)
    .slice(0, 3);

  return questions.length ? { questions, focusHints } : undefined;
}

export async function enhanceDefenseOptimizationWithAi({
  session,
  plan
}: {
  session: SpeakTrainingSessionState;
  plan: DefenseOptimizationPlan | undefined;
}) {
  if (!isQwenConfigured() || !plan?.items.length) {
    return undefined;
  }

  const answeredDialogue = [
    ...session.questions,
    ...session.defenseQuestions
  ]
    .filter((question) => question.status === "answered" && question.answer)
    .map((question) => `问题：${question.question}\n回答：${question.answer}\n点评：${question.feedback || "无"}`)
    .join("\n\n");
  const result = await streamQwenChat({
    system: [
      "你是口语化的说课教研伙伴。只输出 JSON，不要 Markdown。",
      "请润色已有优化方案，不得脱离原说课和本次问答。",
      "items 为 [{questionId,answerDiagnosis,revisionPlan,replacementScript,preparationActions}]。",
      "语气自然，像‘你这里可以这样改’；每项必须给具体课堂例子、教师追问句或学生产出，不能使用空泛套话。",
      "preparationActions 必须恰好 2 条。"
    ].join("\n"),
    messages: [{
      role: "user",
      content: [
        `说课原文：${session.segments.map((segment) => segment.text).join("\n").slice(0, 7000)}`,
        `本次问答：${answeredDialogue}`,
        `本地方案：${JSON.stringify(plan.items)}`
      ].join("\n\n")
    }],
    maxTokens: 1800,
    onDelta() {},
    onThinkingDelta() {}
  });
  const parsed = parseJson(result.visibleAssistantContent) as { items?: AiOptimizationDraft[] } | undefined;
  const drafts = (parsed?.items || []).filter(
    (item) =>
      plan.items.some((base) => base.questionId === item.questionId) &&
      item.answerDiagnosis &&
      item.revisionPlan &&
      item.replacementScript &&
      Array.isArray(item.preparationActions) &&
      item.preparationActions.length === 2
  );

  if (!drafts.length) {
    return undefined;
  }

  return {
    ...plan,
    items: plan.items.map((item) => {
      const draft = drafts.find((entry) => entry.questionId === item.questionId);
      return draft ? { ...item, ...draft } : item;
    }),
    generatedAt: new Date().toISOString()
  } satisfies DefenseOptimizationPlan;
}

function toDefenseQuestion(item: AiQuestionDraft): DefenseQuestion {
  const roleNames: Record<SpeakRoleId, string> = {
    researcher: "研究员",
    teacher: "教研员",
    expert: "专家"
  };
  return {
    id: `defense_ai_${randomUUID()}`,
    role: item.role,
    roleName: roleNames[item.role],
    level: "applied",
    question: item.question.trim(),
    targetDimension: item.targetDimension.trim(),
    source: "ai",
    sourceEvidence: item.sourceEvidence.trim(),
    status: "pending"
  };
}

function isValidQuestionDraft(item: AiQuestionDraft, originalText: string, existingQuestions: string) {
  if (!item?.question || !item.targetDimension || !item.sourceEvidence || !item.reason) {
    return false;
  }
  if (!['researcher', 'teacher', 'expert'].includes(item.role)) {
    return false;
  }
  if (item.question.length < 12 || item.question.length > 180 || existingQuestions.includes(item.question)) {
    return false;
  }
  return item.sourceEvidence.includes("原文未说明") || originalText.includes(item.sourceEvidence.replace(/[“”]/g, ""));
}

function parseJson(content: string) {
  const source = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || content;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
