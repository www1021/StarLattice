import { randomUUID } from "node:crypto";
import type {
  EvaluationDimension,
  StoredCitation,
  TrainingEvaluation
} from "./storage/chatRepository.js";
import { currentOwnerId } from "./auth/context.js";

export type SpeakStageId =
  | "textbook"
  | "student"
  | "objective"
  | "keyPoint"
  | "method"
  | "process"
  | "activity"
  | "assessment"
  | "reflection";

export type SpeakRoleId = "researcher" | "teacher" | "expert";

export type SpeakRhythmState =
  | "LISTENING"
  | "ANALYZING"
  | "INTERRUPTING"
  | "WAITING_RESPONSE";

export type SpeakAnnotationType =
  | "filler"
  | "term_error"
  | "logic_gap"
  | "missing_point"
  | "stage_mismatch"
  | "risk";

export type SpeakAnnotation = {
  id: string;
  type: SpeakAnnotationType;
  severity: "info" | "warning" | "error";
  message: string;
  suggestion: string;
  matchedText?: string;
  stageId?: SpeakStageId;
};

export type SpeakStageProgress = {
  id: SpeakStageId;
  name: string;
  progress: number;
  status: "pending" | "active" | "complete" | "warning" | "missing";
  evidence: string[];
  durationSec: number;
  suggestedMinSec: number;
  suggestedMaxSec: number;
  completenessScore: number;
  warnings: string[];
  missingSignals: string[];
};

export type SpeakTrainingSegment = {
  id: string;
  text: string;
  stageId: SpeakStageId;
  source: "text" | "browser_asr" | "audio_upload" | "realtime";
  createdAt: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  wordCount: number;
  wpm: number;
  annotations: SpeakAnnotation[];
  reRecordOfSegmentId?: string;
};

export type RoleAgentComment = {
  role: SpeakRoleId;
  name: string;
  voiceStyle: string;
  tone: string;
  focus: string;
  comment: string;
  suggestion: string;
  question?: string;
};

export type InterruptionDecision = {
  shouldInterrupt: boolean;
  triggerType?:
    | "logic_conflict"
    | "missing_information"
    | "theory_unexplained"
    | "classroom_risk"
    | "structure_node"
    | "hesitation"
    | "stage_mismatch"
    | "defense_followup";
  role?: SpeakRoleId;
  reason?: string;
  question?: string;
  cooldownRemainingMs?: number;
};

export type SpeakTrainingQuestion = {
  id: string;
  role: SpeakRoleId;
  roleName: string;
  triggerType: NonNullable<InterruptionDecision["triggerType"]>;
  question: string;
  reason: string;
  status: "pending" | "answered";
  createdAt: string;
  answeredAt?: string;
  answer?: string;
  score?: number;
  feedback?: string;
  followupQuestionId?: string;
};

export type DefenseQuestion = {
  id: string;
  role: SpeakRoleId;
  roleName: string;
  level: "basic" | "applied" | "advanced";
  question: string;
  targetDimension: string;
  source: "truth_bank" | "weakness" | "followup" | "ai";
  sourceEvidence?: string;
  status: "pending" | "answered";
  answer?: string;
  score?: number;
  feedback?: string;
};

export type DefenseAnswer = {
  questionId: string;
  answer: string;
  score: number;
  feedback: string;
  createdAt: string;
};

export type DefenseOptimizationItem = {
  questionId: string;
  question: string;
  target: string;
  originalEvidence: string;
  answerDiagnosis: string;
  revisionPlan: string;
  replacementScript: string;
  preparationActions: string[];
};

export type DefenseOptimizationPlan = {
  title: string;
  summary: string;
  items: DefenseOptimizationItem[];
  generatedAt: string;
};

export type SpeakAiFocusHint = {
  label: string;
  detail: string;
  sourceEvidence: string;
};

export type ExaminerScore = {
  role: SpeakRoleId;
  roleName: string;
  score: number;
  focus: string;
  deductions: string[];
  comment: string;
};

export type SpeakStageCoverageItem = {
  id: SpeakStageId;
  name: string;
  status: SpeakStageProgress["status"];
  progress: number;
  evidence: string[];
  missingSignals: string[];
  action: string;
};

export type SpeakEvidenceChain = {
  stageName: string;
  evidence: string;
  diagnosis: string;
  suggestion: string;
};

export type SpeakTrainingReport = {
  overallScore: number;
  passLine: number;
  pass: boolean;
  stageCoverage: SpeakStageCoverageItem[];
  missingStages: string[];
  timeIssues: string[];
  termIssues: string[];
  logicBreakpoints: string[];
  defenseRisks: string[];
  evidenceChains: SpeakEvidenceChain[];
  lostPoints: string[];
  weakDimensions: string[];
  recommendedDrills: string[];
  optimizedPhrases: Array<{
    original: string;
    optimized: string;
  }>;
  examinerScores: ExaminerScore[];
  generatedAt: string;
};

export type SpeakRetrainComparison = {
  id: string;
  title: string;
  stageId: SpeakStageId;
  stageName: string;
  originalSegmentId?: string;
  replacementSegmentId: string;
  originalText?: string;
  revisedText: string;
  beforeOverallScore: number;
  afterOverallScore: number;
  beforeStageProgress?: number;
  afterStageProgress?: number;
  createdAt: string;
};

export type SpeakTrainingSessionState = {
  conversationId: string;
  rhythmState: SpeakRhythmState;
  currentStageId: SpeakStageId;
  stageProgress: SpeakStageProgress[];
  segments: SpeakTrainingSegment[];
  questions: SpeakTrainingQuestion[];
  defenseQuestions: DefenseQuestion[];
  defenseAnswers: DefenseAnswer[];
  defenseOptimization?: DefenseOptimizationPlan;
  aiFocusHints?: SpeakAiFocusHint[];
  report?: SpeakTrainingReport;
  retrainComparisons?: SpeakRetrainComparison[];
  lastInterruptAt?: number;
  createdAt: string;
  updatedAt: string;
};

export type SpeakTrainingTurnRequest = {
  conversationId?: string;
  transcript?: string;
  source?: SpeakTrainingSegment["source"];
  currentStageId?: SpeakStageId;
  knowledgeBaseIds?: string[];
  pauseDurationMs?: number;
  durationSec?: number;
  segmentStartedAt?: string;
  reRecordOfSegmentId?: string;
  retrainTargetStageId?: SpeakStageId;
  retrainTitle?: string;
};

export type SpeakTrainingTurnResult = {
  conversationId: string;
  asrText: string;
  asrNotice?: string;
  currentStage: SpeakStageProgress;
  stageProgress: SpeakStageProgress[];
  roleComments: RoleAgentComment[];
  interruption: InterruptionDecision;
  questions: SpeakTrainingQuestion[];
  defenseQuestions: DefenseQuestion[];
  evaluation: TrainingEvaluation;
  report: SpeakTrainingReport;
  summary: {
    teachingLogic: string;
    objectiveRationality: string;
    improvementAdvice: string[];
  };
  tts: Array<{
    role: SpeakRoleId | "system";
    voiceStyle: string;
    text: string;
  }>;
  session: SpeakTrainingSessionState;
};

export type SpeakRealtimeClientEvent =
  | {
      type: "start";
      conversationId?: string;
      currentStageId?: SpeakStageId;
      knowledgeBaseIds?: unknown;
    }
  | {
      type: "transcript_delta";
      text: string;
      final?: boolean;
      pauseDurationMs?: number;
      durationSec?: number;
    }
  | {
      type: "pause";
      durationMs: number;
    }
  | {
      type: "user_response";
      questionId?: string;
      text: string;
    }
  | {
      type: "audio_frame";
      audio: string;
      sampleRate: 16000;
    }
  | {
      type: "audio_end";
    }
  | {
      type: "finish";
    };

export type SpeakRealtimeServerEvent =
  | { type: "session"; session: SpeakTrainingSessionState }
  | { type: "transcript_delta"; text: string }
  | { type: "asr_delta"; text: string; final: boolean; provider: "iflytek" }
  | {
      type: "stage_update";
      currentStage: SpeakStageProgress;
      stageProgress: SpeakStageProgress[];
      report?: SpeakTrainingReport;
    }
  | { type: "interruption_candidate"; interruption: InterruptionDecision }
  | { type: "interrupt"; interruption: InterruptionDecision }
  | { type: "role_question"; question: SpeakTrainingQuestion }
  | {
      type: "tts_instruction";
      role: SpeakRoleId | "system";
      voiceStyle: string;
      text: string;
    }
  | { type: "final_evaluation"; evaluation: TrainingEvaluation; report?: SpeakTrainingReport }
  | { type: "error"; message: string };

type StageDefinition = {
  id: SpeakStageId;
  name: string;
  keywords: string[];
  completionSignals: string[];
  requiredSignals: string[];
  suggestedMinSec: number;
  suggestedMaxSec: number;
};

type RoleDefinition = {
  id: SpeakRoleId;
  name: string;
  voiceStyle: string;
  tone: string;
  focus: string;
};

const INTERRUPT_COOLDOWN_MS = 15000;
const PASS_LINE = 70;

const stageDefinitions: StageDefinition[] = [
  {
    id: "textbook",
    name: "说教材",
    keywords: ["说教材", "教材", "单元", "课文", "内容", "课标", "新课标", "知识点"],
    completionSignals: ["教材分析", "文本特点", "课程标准", "单元目标", "编排意图"],
    requiredSignals: ["教材", "课标", "单元"],
    suggestedMinSec: 35,
    suggestedMaxSec: 70
  },
  {
    id: "student",
    name: "说学情",
    keywords: ["说学情", "学情", "学生", "基础", "经验", "困难", "认知", "差异"],
    completionSignals: ["已有经验", "学习困难", "学生基础", "差异化"],
    requiredSignals: ["学生", "基础", "困难"],
    suggestedMinSec: 35,
    suggestedMaxSec: 70
  },
  {
    id: "objective",
    name: "说目标",
    keywords: ["说目标", "目标", "育人目标", "核心素养", "知识与技能", "过程与方法", "情感", "达成"],
    completionSignals: ["能够", "理解", "掌握", "形成", "达成", "评价", "育人"],
    requiredSignals: ["目标", "能够", "达成", "育人"],
    suggestedMinSec: 45,
    suggestedMaxSec: 90
  },
  {
    id: "keyPoint",
    name: "说重难点",
    keywords: ["说重难点", "重点", "难点", "重难点", "关键", "突破", "易错"],
    completionSignals: ["教学重点", "教学难点", "突破难点", "关键问题"],
    requiredSignals: ["重点", "难点", "突破"],
    suggestedMinSec: 35,
    suggestedMaxSec: 70
  },
  {
    id: "method",
    name: "说方法",
    keywords: ["说方法", "教法", "学法", "讲授", "启发", "探究", "合作", "自主学习"],
    completionSignals: ["教师采用", "学生通过", "教法", "学法", "合作探究"],
    requiredSignals: ["教法", "学法", "学生"],
    suggestedMinSec: 35,
    suggestedMaxSec: 80
  },
  {
    id: "process",
    name: "说过程",
    keywords: ["说过程", "过程", "导入", "新授", "讲解", "练习", "总结", "环节"],
    completionSignals: ["导入", "展开", "新授", "小结", "练习"],
    requiredSignals: ["导入", "新授", "小结"],
    suggestedMinSec: 150,
    suggestedMaxSec: 260
  },
  {
    id: "activity",
    name: "说活动",
    keywords: ["说活动", "活动", "合作", "探究", "讨论", "小组", "任务", "展示"],
    completionSignals: ["任务", "分组", "产出", "展示", "合作"],
    requiredSignals: ["任务", "分组", "产出"],
    suggestedMinSec: 55,
    suggestedMaxSec: 110
  },
  {
    id: "assessment",
    name: "说评价",
    keywords: ["说评价", "评价", "标准", "反馈", "检测", "作业", "量规", "表现"],
    completionSignals: ["评价标准", "反馈", "检测", "量规", "作业"],
    requiredSignals: ["评价", "标准", "反馈"],
    suggestedMinSec: 45,
    suggestedMaxSec: 90
  },
  {
    id: "reflection",
    name: "说反思",
    keywords: ["说反思", "反思", "改进", "生成", "不足", "调整", "课后"],
    completionSignals: ["教学反思", "课后反思", "改进方向", "二次备课"],
    requiredSignals: ["反思", "改进"],
    suggestedMinSec: 25,
    suggestedMaxSec: 60
  }
];

const roleDefinitions: Record<SpeakRoleId, RoleDefinition> = {
  researcher: {
    id: "researcher",
    name: "研究员",
    voiceStyle: "低沉、慢速",
    tone: "严谨、逻辑驱动",
    focus: "课标依据、教材结构、目标与评价一致性"
  },
  teacher: {
    id: "teacher",
    name: "教研员",
    voiceStyle: "自然语速",
    tone: "现实、经验型",
    focus: "课堂执行、活动组织、学生反应和突发处理"
  },
  expert: {
    id: "expert",
    name: "专家",
    voiceStyle: "稳重清晰",
    tone: "理论型",
    focus: "教育理论、新课改、核心素养、育人逻辑与德育融入"
  }
};

/**
 * 内存键带上账号前缀：落库那层虽然有 owner 条件，但这里命中缓存就直接返回，
 * 根本走不到 SQL。同一个 conversationId 在不同账号下是两条互不相干的会话，
 * 拿别人的 id 只会得到一个空会话，不会读到内容，也不会把原会话覆盖掉。
 * 无身份的后台任务与单元测试统一落在 ":id" 上，保持旧行为。
 */
export class SpeakTrainingSession {
  private readonly sessions = new Map<string, SpeakTrainingSessionState>();

  private key(conversationId: string): string {
    return `${currentOwnerId() ?? ""}:${conversationId}`;
  }

  getOrCreate(conversationId?: string, currentStageId?: SpeakStageId) {
    const id = conversationId || `speak_${randomUUID()}`;
    const key = this.key(id);
    const existing = this.sessions.get(key);

    if (existing) {
      return ensureSessionShape(existing);
    }

    const now = new Date().toISOString();
    const session: SpeakTrainingSessionState = {
      conversationId: id,
      rhythmState: "LISTENING",
      currentStageId: currentStageId || "textbook",
      stageProgress: createInitialStageProgress(currentStageId || "textbook"),
      segments: [],
      questions: [],
      defenseQuestions: [],
      defenseAnswers: [],
      createdAt: now,
      updatedAt: now
    };
    this.sessions.set(key, session);
    return session;
  }

  update(session: SpeakTrainingSessionState) {
    session.updatedAt = new Date().toISOString();
    this.sessions.set(this.key(session.conversationId), ensureSessionShape(session));
    return session;
  }

  forget(conversationId: string) {
    this.sessions.delete(this.key(conversationId));
  }
}

export class SpeakStageTracker {
  update(
    session: SpeakTrainingSessionState,
    segmentText: string,
    requestedStageId?: SpeakStageId
  ) {
    const inferredStageId = inferStage(segmentText);
    const nextStageId = requestedStageId || inferredStageId || session.currentStageId;
    const allText = session.segments.length
      ? session.segments.map((segment) => segment.text).join("\n").trim()
      : segmentText.trim();
    const totalTextLength = normalizeText(allText).length;
    const stageProgress = stageDefinitions.map((stage) => {
      const matched = getMatchedSignals(allText, [
        ...stage.keywords,
        ...stage.completionSignals
      ]);
      const missingSignals = stage.requiredSignals.filter(
        (signal) => !normalizeText(allText).includes(signal)
      );
      // 完整说课模式按整段内容识别结构，不再把总时长误归到某一个细分阶段。
      const durationSec = requestedStageId
        ? session.segments
            .filter((segment) => segment.stageId === stage.id)
            .reduce((total, segment) => total + segment.durationSec, 0)
        : 0;
      const completenessScore = Math.min(
        100,
        Math.round((matched.length / Math.max(3, stage.requiredSignals.length + 2)) * 100)
      );
      const warnings = buildStageWarnings(stage, durationSec, missingSignals, totalTextLength);
      const progress = Math.min(100, Math.max(completenessScore, matched.length * 18));

      return {
        id: stage.id,
        name: stage.name,
        progress,
        status: getStageStatus(stage.id, nextStageId, progress, warnings, totalTextLength),
        evidence: matched.slice(0, 5),
        durationSec,
        suggestedMinSec: stage.suggestedMinSec,
        suggestedMaxSec: stage.suggestedMaxSec,
        completenessScore,
        warnings,
        missingSignals
      } satisfies SpeakStageProgress;
    });

    session.currentStageId = nextStageId;
    session.stageProgress = stageProgress;
    return {
      currentStage: stageProgress.find((stage) => stage.id === nextStageId)!,
      stageProgress,
      inferredStageId
    };
  }
}

export class InterruptionRuleEngine {
  evaluate(input: {
    session: SpeakTrainingSessionState;
    segmentText: string;
    requestedStageId?: SpeakStageId;
    inferredStageId?: SpeakStageId;
    annotations?: SpeakAnnotation[];
    pauseDurationMs?: number;
    now?: number;
  }): InterruptionDecision {
    const now = input.now || Date.now();
    const openQuestion = input.session.questions.find(
      (question) => question.status === "pending"
    );

    if (openQuestion) {
      return {
        shouldInterrupt: false,
        reason: "上一条追问仍在等待回应。"
      };
    }

    if (input.session.lastInterruptAt) {
      const elapsed = now - input.session.lastInterruptAt;

      if (elapsed < INTERRUPT_COOLDOWN_MS) {
        return {
          shouldInterrupt: false,
          reason: "追问节奏冷却中。",
          cooldownRemainingMs: INTERRUPT_COOLDOWN_MS - elapsed
        };
      }
    }

    const stageMismatch = input.annotations?.find(
      (annotation) => annotation.type === "stage_mismatch"
    );

    if (stageMismatch) {
      return this.makeDecision(
        "stage_mismatch",
        "researcher",
        stageMismatch.message,
        "你当前口述内容和所选说课阶段不一致。请先用一句话收束本阶段，再切换到对应模块继续。"
      );
    }

    const text = normalizeText(input.segmentText);
    const allText = normalizeText(
      [...input.session.segments.map((segment) => segment.text), input.segmentText].join(
        "\n"
      )
    );
    const currentStage =
      input.session.stageProgress.find(
        (stage) =>
          stage.id ===
          (input.requestedStageId || input.inferredStageId || input.session.currentStageId)
      ) || input.session.stageProgress.find((stage) => stage.id === input.session.currentStageId);

    if (mentionsKeyPoint(text) && !/突破|依据|为什么|易错|难在/.test(text)) {
      return this.makeDecision(
        "missing_information",
        "researcher",
        "重难点只被点名，没有说明确立依据和突破策略。",
        "请补充本课重点和难点分别是什么，为什么这样确定，以及准备如何突破难点。"
      );
    }

    if (mentionsMethod(text) && !/教师|学生|教法|学法/.test(text)) {
      return this.makeDecision(
        "missing_information",
        "expert",
        "教法学法没有区分教师行为和学生学习方式。",
        "请把教法和学法分开说：教师如何支架，学生如何自主、合作或探究。"
      );
    }

    if (
      mentionsCooperativeLearning(text) &&
      mentionsQuestioningActivity(text) &&
      (!hasGroupingDetails(text) || !hasQuestioningDetails(text))
    ) {
      return this.makeDecision(
        "missing_information",
        "teacher",
        "提到分组学习后的提问，但缺少分组组织、问题设计或反馈方式。",
        "你说分组学习后会进行提问。请具体说明怎么分组、讨论几分钟、你准备问什么问题，以及学生回答后你如何追问或反馈。"
      );
    }

    if (mentionsCooperativeLearning(text) && !hasGroupingDetails(text)) {
      return this.makeDecision(
        "missing_information",
        "teacher",
        "提到合作学习，但没有说明分组、角色或产出。",
        "你刚才提到合作学习，这个活动在真实课堂中如何分组、每组产出什么、预计用几分钟？"
      );
    }

    if (mentionsQuestioningActivity(text) && !hasQuestioningDetails(text)) {
      return this.makeDecision(
        "missing_information",
        "teacher",
        "提到课堂提问或学生回答，但缺少问题设计、预设回答或反馈方式。",
        "你说课堂提问会推进学习。请具体说明你准备问什么、预设学生怎样回答，以及如何追问或反馈。"
      );
    }

    if (mentionsDiscussionActivity(text) && !hasActivityExecutionDetails(text)) {
      return this.makeDecision(
        "missing_information",
        "teacher",
        "提到讨论或展示活动，但缺少时间、产出或组织方式。",
        "你安排了学生讨论和展示。这个活动准备讨论几分钟、展示什么成果、教师如何收束反馈？"
      );
    }

    if (mentionsTheory(text) && !explainsTheory(text)) {
      return this.makeDecision(
        "theory_unexplained",
        "expert",
        "使用教育理论术语，但没有解释如何转化为学习过程。",
        "你用了相关教育理论术语，请具体说明它在学生学习过程中的体现，而不只是作为理念标签。"
      );
    }

    if (mentionsMoralEducation(text) && !hasMoralEducationLogic(text)) {
      return this.makeDecision(
        "theory_unexplained",
        "expert",
        "提到育人或德育，但还没有说明育人目标、课堂行为和评价证据之间的关系。",
        "请补充本课育人目标是什么，它通过哪个课堂活动自然发生，并用什么学生表现作为证据。"
      );
    }

    if (mentionsObjective(text) && !hasObservableVerb(text)) {
      return this.makeDecision(
        "logic_conflict",
        "researcher",
        "教学目标表述偏抽象，缺少可观察行为动词。",
        "你的目标表述还比较抽象，请把它改成学生可观察、可评价的行为结果。"
      );
    }

    if (mentionsAssessment(text) && !hasAssessmentStandard(text)) {
      return this.makeDecision(
        "missing_information",
        "researcher",
        "提到评价，但缺少评价标准或证据来源。",
        "你提到了评价设计，请补充评价标准是什么，以及教师依据哪些证据判断目标达成。"
      );
    }

    if (mentionsClassroomRisk(text)) {
      return this.makeDecision(
        "classroom_risk",
        "teacher",
        "活动流程可能超时或课堂执行成本过高。",
        "这个活动在真实课堂中可能会超时，你准备压缩哪个环节，保留哪个核心任务？"
      );
    }

    if (currentStage && text.length > 80 && currentStage.missingSignals.length) {
      return this.makeDecision(
        "missing_information",
        getStageQuestionRole(currentStage.id),
        `${currentStage.name}仍缺少 ${currentStage.missingSignals.slice(0, 3).join("、")} 等关键得分点。`,
        buildStageFollowupQuestion(currentStage)
      );
    }

    if (input.pauseDurationMs && input.pauseDurationMs > 2500 && isSemanticallyOpen(text)) {
      return this.makeDecision(
        "hesitation",
        "teacher",
        "出现较长停顿，且当前语义没有收束。",
        "你可以先停在这里。刚才这一段你最想强调的是目标依据、活动安排，还是评价方式？"
      );
    }

    if (isStructureNode(text, allText)) {
      return this.makeDecision(
        "structure_node",
        "researcher",
        "完成了一个说课结构节点，适合进行节点追问。",
        "这一模块先到这里。请用一句话说明它如何支撑后续教学活动，而不是孤立存在。"
      );
    }

    return {
      shouldInterrupt: false,
      reason: "暂未满足打断条件。"
    };
  }

  private makeDecision(
    triggerType: NonNullable<InterruptionDecision["triggerType"]>,
    role: SpeakRoleId,
    reason: string,
    question: string
  ): InterruptionDecision {
    return {
      shouldInterrupt: true,
      triggerType,
      role,
      reason,
      question
    };
  }
}

export class RoleAgentOrchestrator {
  buildComments(input: {
    segmentText: string;
    currentStage: SpeakStageProgress;
    interruption: InterruptionDecision;
    annotations: SpeakAnnotation[];
  }) {
    const text = normalizeText(input.segmentText);
    const missingCount = input.currentStage.missingSignals.length;

    return (Object.values(roleDefinitions) as RoleDefinition[]).map((role) => {
      const question =
        input.interruption.shouldInterrupt && input.interruption.role === role.id
          ? input.interruption.question
          : undefined;

      if (role.id === "researcher") {
        return buildRoleComment(role, {
          comment:
            missingCount === 0
              ? "当前模块已经有较清楚的说课依据，结构完整度在提升。"
              : `当前模块还缺 ${input.currentStage.missingSignals.join("、")} 等关键依据。`,
          suggestion: "把课标依据、目标、活动、评价之间的对应关系说成一条闭环链。",
          question
        });
      }

      if (role.id === "teacher") {
        return buildRoleComment(role, {
          comment: hasTimeOrGrouping(text)
            ? "活动安排已经开始考虑课堂执行条件。"
            : "真实课堂中的时间、分组、材料和学生产出还需要更清楚。",
          suggestion: "把活动拆成任务、材料、时间、产出、教师反馈五项。",
          question
        });
      }

      return buildRoleComment(role, {
        comment: explainsTheory(text) || hasMoralEducationLogic(text)
          ? "理论依据、育人价值和学习过程之间已经有初步连接。"
          : "教育理念或育人表达暂时更像标签，还需要落到学生如何建构理解的过程。",
        suggestion:
          input.annotations.some((annotation) => annotation.type === "term_error")
            ? "先修正术语，再说明学生经历了哪些观察、表达、协商或迁移。"
            : "说明学生经历了哪些观察、表达、协商或迁移，并指出育人价值如何自然生成。",
        question
      });
    });
  }
}

export function processSpeakTrainingTurn(input: {
  session: SpeakTrainingSessionState;
  transcript?: string;
  source?: SpeakTrainingSegment["source"];
  currentStageId?: SpeakStageId;
  pauseDurationMs?: number;
  durationSec?: number;
  segmentStartedAt?: string;
  reRecordOfSegmentId?: string;
  retrainTargetStageId?: SpeakStageId;
  retrainTitle?: string;
  citations?: StoredCitation[];
  audioUploaded?: boolean;
}) {
  const session = ensureSessionShape(input.session);
  const previousReport = session.report;
  const originalSegment = input.reRecordOfSegmentId
    ? session.segments.find((item) => item.id === input.reRecordOfSegmentId)
    : undefined;
  const existingAiDefenseQuestions = session.defenseQuestions.filter(
    (question) => question.source === "ai"
  );
  const asrText = (input.transcript || "").trim();
  const now = new Date();
  const nowIso = now.toISOString();
  const asrNotice =
    !asrText && input.audioUploaded
      ? buildAsrUnavailableNotice()
      : undefined;
  const segmentText = asrText || "本段已收到音频，但当前未配置服务端 ASR。";
  const inferredBeforePush = inferStage(segmentText);
  const durationSec =
    input.durationSec || estimateDurationSec(segmentText, input.pauseDurationMs);
  const endedAt = nowIso;
  const startedAt =
    input.segmentStartedAt ||
    new Date(now.getTime() - Math.max(1, durationSec) * 1000).toISOString();
  const wordCount = countSpeakWords(segmentText);
  const segment: SpeakTrainingSegment = {
    id: `seg_${randomUUID()}`,
    text: segmentText,
    stageId: input.currentStageId || session.currentStageId,
    source: input.source || (input.audioUploaded ? "audio_upload" : "text"),
    createdAt: nowIso,
    startedAt,
    endedAt,
    durationSec,
    wordCount,
    wpm: durationSec > 0 ? Math.round((wordCount / durationSec) * 60) : 0,
    annotations: buildTranscriptAnnotations({
      text: segmentText,
      requestedStageId: input.currentStageId || session.currentStageId,
      inferredStageId: inferredBeforePush,
      wpm: durationSec > 0 ? Math.round((wordCount / durationSec) * 60) : 0
    }),
    reRecordOfSegmentId: input.reRecordOfSegmentId
  };
  const stageTracker = new SpeakStageTracker();
  const ruleEngine = new InterruptionRuleEngine();
  const orchestrator = new RoleAgentOrchestrator();

  session.rhythmState = "ANALYZING";

  if (input.reRecordOfSegmentId) {
    session.segments = session.segments.filter(
      (item) => item.id !== input.reRecordOfSegmentId
    );
  }

  session.segments.push(segment);
  const { currentStage, stageProgress, inferredStageId } = stageTracker.update(
    session,
    segmentText,
    input.currentStageId
  );
  segment.stageId = currentStage.id;
  segment.annotations = buildTranscriptAnnotations({
    text: segmentText,
    requestedStageId: input.currentStageId || session.currentStageId,
    inferredStageId,
    wpm: segment.wpm
  });

  const interruption = ruleEngine.evaluate({
    session,
    segmentText,
    requestedStageId: input.currentStageId,
    inferredStageId,
    annotations: segment.annotations,
    pauseDurationMs: input.pauseDurationMs
  });
  const roleComments = orchestrator.buildComments({
    segmentText,
    currentStage,
    interruption,
    annotations: segment.annotations
  });

  if (interruption.shouldInterrupt && interruption.role && interruption.triggerType) {
    const role = roleDefinitions[interruption.role];
    session.rhythmState = "INTERRUPTING";
    session.lastInterruptAt = Date.now();
    session.questions.push({
      id: `question_${randomUUID()}`,
      role: interruption.role,
      roleName: role.name,
      triggerType: interruption.triggerType,
      question: interruption.question || "",
      reason: interruption.reason || "",
      status: "pending",
      createdAt: nowIso
    });
    session.rhythmState = "WAITING_RESPONSE";
  } else {
    session.rhythmState = "LISTENING";
  }

  session.updatedAt = nowIso;
  session.stageProgress = stageProgress;
  session.currentStageId = currentStage.id;
  session.defenseQuestions = [
    ...existingAiDefenseQuestions,
    ...buildDefenseQuestions(session).filter(
      (question) => !existingAiDefenseQuestions.some((item) => item.question === question.question)
    )
  ];

  const evaluation = createSpeakTrainingEvaluation({
    conversationId: session.conversationId,
    session,
    citations: input.citations || []
  });
  const report = buildSpeakTrainingReport(session, evaluation);
  session.report = report;
  if (input.retrainTargetStageId && previousReport) {
    const beforeStage = previousReport.stageCoverage.find(
      (stage) => stage.id === input.retrainTargetStageId
    );
    const afterStage = report.stageCoverage.find(
      (stage) => stage.id === input.retrainTargetStageId
    );
    session.retrainComparisons = [
      ...(session.retrainComparisons || []),
      {
        id: `retrain_${randomUUID()}`,
        title: input.retrainTitle || `${afterStage?.name || currentStage.name}专项重练`,
        stageId: input.retrainTargetStageId,
        stageName: afterStage?.name || beforeStage?.name || currentStage.name,
        originalSegmentId: originalSegment?.id,
        replacementSegmentId: segment.id,
        originalText: originalSegment?.text,
        revisedText: segment.text,
        beforeOverallScore: previousReport.overallScore,
        afterOverallScore: report.overallScore,
        beforeStageProgress: beforeStage?.progress,
        afterStageProgress: afterStage?.progress,
        createdAt: nowIso
      }
    ].slice(-8);
  }
  const summary = buildTurnSummary(session, segmentText, report);

  return {
    conversationId: session.conversationId,
    asrText,
    asrNotice,
    currentStage,
    stageProgress,
    roleComments,
    interruption,
    questions: session.questions,
    defenseQuestions: session.defenseQuestions,
    evaluation,
    report,
    summary,
    tts: buildTtsInstructions(roleComments, interruption),
    session
  } satisfies SpeakTrainingTurnResult;
}

export function answerPendingSpeakQuestion(
  session: SpeakTrainingSessionState,
  answer: string,
  questionId?: string
) {
  const normalizedSession = ensureSessionShape(session);
  const question =
    (questionId
      ? normalizedSession.questions.find((item) => item.id === questionId)
      : normalizedSession.questions.find((item) => item.status === "pending")) ||
    undefined;
  const defenseQuestion =
    questionId && !question
      ? normalizedSession.defenseQuestions.find((item) => item.id === questionId)
      : undefined;

  if (!question && !defenseQuestion) {
    return normalizedSession;
  }

  const trimmedAnswer = answer.trim();
  const answerScore = scoreDefenseAnswer(trimmedAnswer);
  const feedback = buildDefenseAnswerFeedback(trimmedAnswer, answerScore);

  if (question) {
    question.status = "answered";
    question.answer = trimmedAnswer;
    question.answeredAt = new Date().toISOString();
    question.score = answerScore;
    question.feedback = feedback;

    if (answerScore < 70) {
      const followup = buildFollowupQuestion(question);
      normalizedSession.questions.push(followup);
      question.followupQuestionId = followup.id;
      normalizedSession.rhythmState = "WAITING_RESPONSE";
    } else {
      normalizedSession.rhythmState = "LISTENING";
    }
  }

  if (defenseQuestion) {
    defenseQuestion.status = "answered";
    defenseQuestion.answer = trimmedAnswer;
    defenseQuestion.score = answerScore;
    defenseQuestion.feedback = feedback;
    normalizedSession.defenseAnswers.push({
      questionId: defenseQuestion.id,
      answer: trimmedAnswer,
      score: answerScore,
      feedback,
      createdAt: new Date().toISOString()
    });

    if (answerScore < 70) {
      const followup = buildDefenseFollowup(defenseQuestion);
      normalizedSession.defenseQuestions.push(followup);
    }

    normalizedSession.rhythmState = "LISTENING";
  }

  const evaluation = createSpeakTrainingEvaluation({
    conversationId: normalizedSession.conversationId,
    session: normalizedSession,
    citations: []
  });
  normalizedSession.report = buildSpeakTrainingReport(normalizedSession, evaluation);
  normalizedSession.defenseOptimization = buildDefenseOptimizationPlan(normalizedSession);
  normalizedSession.updatedAt = new Date().toISOString();
  return normalizedSession;
}

function buildDefenseOptimizationPlan(session: SpeakTrainingSessionState) {
  const answered = [
    ...session.questions
      .filter((question) => question.status === "answered" && question.answer)
      .map((question) => ({
        id: question.id,
        question: question.question,
        answer: question.answer || "",
        score: question.score || 0,
        feedback: question.feedback || "",
        target: question.reason || "本轮说课逻辑"
      })),
    ...session.defenseQuestions
      .filter((question) => question.status === "answered" && question.answer)
      .map((question) => ({
        id: question.id,
        question: question.question,
        answer: question.answer || "",
        score: question.score || 0,
        feedback: question.feedback || "",
        target: question.targetDimension
      }))
  ];

  const originalText = session.segments.map((segment) => segment.text).join("\n");
  const items = answered.map((item) => buildDefenseOptimizationItem(item, originalText));
  const lowScoreCount = answered.filter((item) => item.score < 70).length;

  return {
    title: "本组追问对话优化方案",
    summary: lowScoreCount
      ? `已结合说课原文与 ${answered.length} 组问答定位 ${lowScoreCount} 个需要重写的答辩点，请按下列方案回填说课稿并完成二次备课。`
      : `已结合说课原文与 ${answered.length} 组问答生成可直接回填的优化方案，用于把答辩中的依据和做法落实到说课稿。`,
    items,
    generatedAt: new Date().toISOString()
  } satisfies DefenseOptimizationPlan;
}

function buildDefenseOptimizationItem(
  item: {
    id: string;
    question: string;
    answer: string;
    score: number;
    feedback: string;
    target: string;
  },
  originalText: string
) {
  const focus = inferDefenseOptimizationFocus(item.question, item.target);
  const originalEvidence = findOriginalEvidence(originalText, focus.keywords, focus.missingLabel);
  const answerDiagnosis = item.score < 70
    ? `本次回应得分 ${item.score} 分：${item.feedback} 原因是没有把“结论、依据、做法”说完整。`
    : `本次回应得分 ${item.score} 分：${item.feedback} 仍需把答辩中的做法回填到说课原文。`;

  return {
    questionId: item.id,
    question: item.question,
    target: focus.target,
    originalEvidence,
    answerDiagnosis,
    revisionPlan: focus.revisionPlan,
    replacementScript: focus.replacementScript,
    preparationActions: focus.preparationActions
  } satisfies DefenseOptimizationItem;
}

function inferDefenseOptimizationFocus(question: string, target: string) {
  const source = `${question} ${target}`;

  if (/目标|课标|核心素养|达成/.test(source)) {
    return {
      target: "教学目标—活动—评价闭环",
      keywords: ["目标", "课标", "核心素养", "评价", "达成"],
      missingLabel: "教学目标、课标依据或达成证据",
      revisionPlan: "在“教学目标”之后补一条闭环：先写学生可观察行为，再紧接着写对应活动，最后写教师采集的达成证据；不要只保留“培养能力、提升素养”一类抽象表述。",
      replacementScript: "可补入：‘学生能通过【具体任务】完成【可观察行为】；我将依据【学生作品、口头解释或操作记录】判断目标达成，并据此安排追问或再示范。’",
      preparationActions: ["为每个教学目标补一项课堂证据", "在教案活动栏标注该证据出现的环节"]
    };
  }

  if (/小组|讨论|冷场|活动|组织/.test(source)) {
    return {
      target: "活动任务与冷场预案",
      keywords: ["活动", "讨论", "小组", "合作", "任务", "交流"],
      missingLabel: "活动任务、分组方式或学生产出",
      revisionPlan: "把原稿中的“组织讨论/小组合作”改成可执行脚本，必须交代任务、分工、时长、产出和冷场时的支架；并把你的答辩做法写回教学过程，而不是只停留在口头承诺。",
      replacementScript: "可替换为：‘两人一组用 2 分钟完成【任务单】；一人记录、一人说明，产出为【图示/结论句】。若 30 秒无回应，我先提供一个对比例子和句式支架，再请基础不同的学生补充。’",
      preparationActions: ["补一张活动任务单和 1 个示例", "预写“冷场时的提示句、追问句和评价句"]
    };
  }

  if (/教法|学法|理论|主体|建构/.test(source)) {
    return {
      target: "理论依据与学生学习行为",
      keywords: ["教法", "学法", "学生", "探究", "建构", "主体"],
      missingLabel: "教法学法依据或学生学习行为",
      revisionPlan: "删除只罗列理论名词的句子，把每个教法、学法对应到学生实际做什么、教师如何支架、最后如何验证；这样答辩中的理论依据才会在原稿中有落点。",
      replacementScript: "可替换为：‘我采用【具体教法】不是为了展示方法名称，而是让学生经历“观察—表达—比较—修正”的学习过程；教师在【关键节点】用【提问/材料】提供支架。’",
      preparationActions: ["逐项检查教法后是否写出学生行为", "为每个理论术语补一条课堂证据"]
    };
  }

  if (/德育|育人|易班|社群|网络/.test(source)) {
    return {
      target: "育人目标与课堂证据",
      keywords: ["育人", "德育", "价值", "责任", "社群", "网络"],
      missingLabel: "育人目标、学生行为或评价证据",
      revisionPlan: "把“渗透德育/核心素养”改写为具体的课堂行为和可观察证据，并说明它发生在哪个任务中；避免在结尾额外加一段口号。",
      replacementScript: "可补入：‘在【活动任务】中，学生需要完成【合作/表达/互评行为】；我通过【互评记录、发言依据或任务产出】观察这一育人目标是否自然发生。’",
      preparationActions: ["补充一项可观察的育人行为", "为互评或线上延展写清规范与评价标准"]
    };
  }

  return {
    target: "重难点与教学过程落地",
    keywords: ["重点", "难点", "过程", "学情", "问题", "例子"],
    missingLabel: "重难点、学情依据或具体教学过程",
    revisionPlan: "回到原稿中与本题相关的段落，把“是什么、为什么、怎么做、如何判断有效”写成连续链条；答辩中提到的调整办法必须能在教学过程找到对应环节。",
    replacementScript: "可补入：‘针对学生可能出现的【典型困难】，我先用【具体材料/问题】暴露原有想法，再通过【追问或操作】引导修正，最后让学生用【可观察产出】证明理解。’",
    preparationActions: ["为该难点补一个典型错误答案", "预写“暴露误区—追问—纠偏—评价”的四步话术"]
  };
}

function findOriginalEvidence(text: string, keywords: string[], missingLabel: string) {
  const sentences = text
    .split(/(?<=[。！？；])/)
    .map((item) => item.trim())
    .filter(Boolean);
  const evidence = sentences.find((sentence) => keywords.some((keyword) => sentence.includes(keyword)));

  return evidence
    ? `说课原文：“${evidence.slice(0, 120)}”`
    : `说课原文未明确说明${missingLabel}，这是本次追问暴露出的直接缺口。`;
}

export function createSpeakTrainingEvaluation(input: {
  conversationId: string;
  session: SpeakTrainingSessionState;
  citations: StoredCitation[];
}): TrainingEvaluation {
  const session = ensureSessionShape(input.session);
  const text = session.segments.map((segment) => segment.text).join("\n");
  const questionsText = [
    ...session.questions.map(renderQuestion),
    ...session.defenseQuestions.map(renderDefenseQuestion)
  ].join("\n");
  const dimensions: EvaluationDimension[] = [
    scoreSpeakDimension("说课完整度", text, [
      "教材",
      "学情",
      "目标",
      "重点",
      "难点",
      "教法",
      "学法",
      "过程",
      "评价",
      "反思"
    ], stageCoverageBonus(session)),
    scoreSpeakDimension("语言表达", text, ["首先", "其次", "因此", "围绕", "我将", "过渡"], -annotationPenalty(session, ["filler"])),
    scoreSpeakDimension("逻辑框架", text, ["依据", "目标", "活动", "评价", "对应", "支撑"], -annotationPenalty(session, ["logic_gap", "stage_mismatch"])),
    scoreSpeakDimension("理论结合", text, ["核心素养", "新课标", "建构主义", "最近发展区", "德育", "素养"], -annotationPenalty(session, ["term_error"])),
    scoreSpeakDimension("育人逻辑", text, ["育人", "德育", "师德", "公平", "关怀", "价值", "责任", "网络育人", "易班", "证据"], 0),
    scoreSpeakDimension("答辩应答", questionsText, ["回答", "回应", "调整", "补充", "处理", "依据"], defenseAnswerBonus(session))
  ];
  const average = Math.round(
    dimensions.reduce((total, dimension) => total + dimension.score, 0) /
      dimensions.length
  );
  const weak = dimensions.filter((dimension) => dimension.score < 80);

  return {
    id: `eval_${randomUUID()}`,
    conversationId: input.conversationId,
    trainingType: "说课陪练",
    overallScore: average,
    dimensions,
    diagnosis: buildSpeakDiagnosis(session, weak, input.citations),
    suggestions: buildSpeakSuggestions(weak, session),
    nextTask: buildNextTask(weak, session),
    citations: input.citations.slice(0, 3),
    createdAt: new Date().toISOString()
  };
}

export function renderSpeakTrainingAssistantMessage(result: SpeakTrainingTurnResult) {
  const roleLines = result.roleComments
    .map(
      (comment) =>
        `【${comment.name}】${comment.comment}\n建议：${comment.suggestion}${
          comment.question ? `\n追问：${comment.question}` : ""
        }`
    )
    .join("\n\n");
  const question = result.questions.find((item) => item.status === "pending");
  const defenseLines = result.defenseQuestions
    .slice(0, 5)
    .map((item) => `【${item.roleName}】${item.question}`)
    .join("\n");

  return [
    `当前阶段：${result.currentStage.name}`,
    result.asrNotice ? `识别提示：${result.asrNotice}` : undefined,
    "",
    "教学逻辑分析：",
    result.summary.teachingLogic,
    "",
    "教学目标合理性：",
    result.summary.objectiveRationality,
    "",
    "三角色反馈：",
    roleLines,
    "",
    "答辩题：",
    defenseLines || "继续完成说课后将生成答辩题。",
    "",
    "阶段覆盖：",
    result.report.stageCoverage
      .map(
        (stage) =>
          `${stage.name} ${stage.progress}%：${
            stage.evidence.length
              ? `证据 ${stage.evidence.join("、")}`
              : `待补 ${stage.missingSignals.join("、") || "阶段证据"}`
          }`
      )
      .join("\n"),
    "",
    "证据链：",
    result.report.evidenceChains
      .slice(0, 5)
      .map(
        (chain) =>
          `${chain.stageName}：${chain.evidence} -> ${chain.diagnosis} -> ${chain.suggestion}`
      )
      .join("\n"),
    "",
    "逻辑断点与答辩风险：",
    [
      ...result.report.logicBreakpoints.slice(0, 3),
      ...result.report.defenseRisks.slice(0, 3)
    ].join("\n") || "暂无明显逻辑断点或答辩风险。",
    "",
    "复盘摘要：",
    `综合分：${result.report.overallScore}，${result.report.pass ? "达到模拟合格线" : "暂未达到模拟合格线"}。`,
    ...result.report.lostPoints.slice(0, 3).map((item) => `- ${item}`),
    "",
    "改进建议：",
    ...result.summary.improvementAdvice.map((item) => `- ${item}`),
    question ? `\n待回应追问：${question.roleName}：${question.question}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSpeakConversationMessages(session: SpeakTrainingSessionState) {
  const normalizedSession = ensureSessionShape(session);
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const sortedQuestions = [...normalizedSession.questions].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  let questionIndex = 0;

  normalizedSession.segments.forEach((segment, index) => {
    messages.push({
      role: "user",
      content: `说课第 ${index + 1} 段（${getStageName(segment.stageId)}，${segment.durationSec} 秒，${segment.wpm} 字/分）：${segment.text}`
    });

    const nextSegment = normalizedSession.segments[index + 1];

    while (
      sortedQuestions[questionIndex] &&
      sortedQuestions[questionIndex].createdAt >= segment.createdAt &&
      (!nextSegment || sortedQuestions[questionIndex].createdAt < nextSegment.createdAt)
    ) {
      const question = sortedQuestions[questionIndex];
      messages.push({
        role: "assistant",
        content: `${question.roleName}追问：${question.question}${
          question.answer
            ? `\n用户回应：${question.answer}\n点评：${question.feedback || ""}`
            : ""
        }`
      });
      questionIndex += 1;
    }
  });

  if (normalizedSession.defenseQuestions.length) {
    messages.push({
      role: "assistant",
      content: normalizedSession.defenseQuestions
        .map(
          (item) =>
            `${item.roleName}答辩：${item.question}${
              item.answer ? `\n用户回应：${item.answer}\n点评：${item.feedback || ""}` : ""
            }`
        )
        .join("\n\n")
    });
  }

  return messages.length
    ? messages
    : [
        {
          role: "user" as const,
          content: "开始说课训练。"
        }
      ];
}

export function buildSpeakSessionSnapshot(session: SpeakTrainingSessionState) {
  const normalizedSession = ensureSessionShape(session);
  return JSON.stringify(
    {
      type: "speak_training_session",
      rhythmState: normalizedSession.rhythmState,
      currentStageId: normalizedSession.currentStageId,
      stageProgress: normalizedSession.stageProgress,
      segments: normalizedSession.segments,
      questions: normalizedSession.questions,
      defenseQuestions: normalizedSession.defenseQuestions,
      defenseAnswers: normalizedSession.defenseAnswers,
      defenseOptimization: normalizedSession.defenseOptimization,
      aiFocusHints: normalizedSession.aiFocusHints,
      report: normalizedSession.report
    },
    null,
    2
  );
}

export function getSpeakTrainingConfig() {
  const asrProvider = process.env.SPEAK_ASR_PROVIDER || "browser";
  const ttsProvider = process.env.SPEAK_TTS_PROVIDER || "browser";
  const iflytekConfigured = Boolean(
    process.env.SPEAK_IFLYTEK_APP_ID &&
      process.env.SPEAK_IFLYTEK_API_KEY &&
      process.env.SPEAK_IFLYTEK_API_SECRET
  );

  return {
    asrProvider,
    ttsProvider,
    realtimeMode: process.env.SPEAK_REALTIME_MODE || "mvp",
    productionReady:
      asrProvider === "iflytek" && ttsProvider === "iflytek" && iflytekConfigured
  };
}

function ensureSessionShape(session: SpeakTrainingSessionState) {
  session.defenseQuestions ||= [];
  session.defenseAnswers ||= [];
  session.retrainComparisons ||= [];
  session.stageProgress = normalizeStageProgress(session.stageProgress, session.currentStageId);
  session.segments = session.segments.map((segment) => normalizeSegment(segment));
  return session;
}

function normalizeStageProgress(
  stageProgress: SpeakStageProgress[] | undefined,
  activeStageId: SpeakStageId
) {
  if (!stageProgress?.length || stageProgress.length < stageDefinitions.length) {
    return createInitialStageProgress(activeStageId);
  }

  return stageDefinitions.map((definition) => {
    const current = stageProgress.find((stage) => stage.id === definition.id);
    return {
      id: definition.id,
      name: definition.name,
      progress: current?.progress || 0,
      status:
        current?.status === "complete" ||
        current?.status === "warning" ||
        current?.status === "missing" ||
        current?.status === "active"
          ? current.status
          : definition.id === activeStageId
            ? "active"
            : "pending",
      evidence: current?.evidence || [],
      durationSec: current?.durationSec || 0,
      suggestedMinSec: definition.suggestedMinSec,
      suggestedMaxSec: definition.suggestedMaxSec,
      completenessScore: current?.completenessScore || current?.progress || 0,
      warnings: current?.warnings || [],
      missingSignals: current?.missingSignals || definition.requiredSignals
    } satisfies SpeakStageProgress;
  });
}

function normalizeSegment(segment: SpeakTrainingSegment) {
  const durationSec = segment.durationSec || estimateDurationSec(segment.text);
  const wordCount = segment.wordCount || countSpeakWords(segment.text);
  return {
    ...segment,
    startedAt: segment.startedAt || segment.createdAt,
    endedAt: segment.endedAt || segment.createdAt,
    durationSec,
    wordCount,
    wpm: segment.wpm || Math.round((wordCount / Math.max(1, durationSec)) * 60),
    annotations: segment.annotations || []
  } satisfies SpeakTrainingSegment;
}

function createInitialStageProgress(activeStageId: SpeakStageId) {
  return stageDefinitions.map((stage) => ({
    id: stage.id,
    name: stage.name,
    progress: 0,
    status: stage.id === activeStageId ? "active" : "pending",
    evidence: [],
    durationSec: 0,
    suggestedMinSec: stage.suggestedMinSec,
    suggestedMaxSec: stage.suggestedMaxSec,
    completenessScore: 0,
    warnings: [],
    missingSignals: stage.requiredSignals
  })) satisfies SpeakStageProgress[];
}

function buildStageWarnings(
  stage: StageDefinition,
  durationSec: number,
  missingSignals: string[],
  totalTextLength: number
) {
  const warnings: string[] = [];

  if (durationSec > 0 && durationSec < stage.suggestedMinSec) {
    warnings.push(`时长不足，建议至少 ${formatDuration(stage.suggestedMinSec)}。`);
  }

  if (durationSec > stage.suggestedMaxSec) {
    warnings.push(`本环节超时，建议控制在 ${formatDuration(stage.suggestedMaxSec)} 内。`);
  }

  if (totalTextLength > 180 && missingSignals.length) {
    warnings.push(`缺少得分点：${missingSignals.slice(0, 3).join("、")}。`);
  }

  return warnings;
}

function getStageStatus(
  stageId: SpeakStageId,
  activeStageId: SpeakStageId,
  progress: number,
  warnings: string[],
  totalTextLength: number
): SpeakStageProgress["status"] {
  if (stageId === activeStageId) {
    return warnings.length ? "warning" : "active";
  }

  if (progress >= 80) {
    return warnings.length ? "warning" : "complete";
  }

  if (totalTextLength > 320 && progress < 35) {
    return "missing";
  }

  return "pending";
}

function inferStage(text: string) {
  const normalized = normalizeText(text);
  const ranked = stageDefinitions
    .map((stage) => ({
      id: stage.id,
      score:
        stage.keywords.filter((keyword) => normalized.includes(keyword)).length * 2 +
        stage.completionSignals.filter((signal) => normalized.includes(signal)).length
    }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.score ? ranked[0].id : undefined;
}

function getMatchedSignals(text: string, signals: string[]) {
  const normalized = normalizeText(text);
  return [...new Set(signals.filter((signal) => normalized.includes(signal)))];
}

function buildTranscriptAnnotations(input: {
  text: string;
  requestedStageId?: SpeakStageId;
  inferredStageId?: SpeakStageId;
  wpm: number;
}) {
  const annotations: SpeakAnnotation[] = [];
  const text = normalizeText(input.text);

  for (const filler of ["嗯", "呃", "然后然后", "就是说", "这个这个", "然后呢"]) {
    if (text.includes(filler)) {
      annotations.push(makeAnnotation("filler", "warning", `出现口语化停顿词“${filler}”。`, "改成短停顿或直接进入下一句，保持考场表达利落。", filler));
    }
  }

  if (/三维目标|知识与技能|过程与方法|情感态度/.test(text) && !/核心素养|新课标|素养/.test(text)) {
    annotations.push(
      makeAnnotation(
        "term_error",
        "warning",
        "目标表述停留在旧三维目标话术。",
        "建议转化为核心素养或可观察学习表现。"
      )
    );
  }

  if (/学生都能完全掌握|所有学生都会|一定能/.test(text)) {
    annotations.push(
      makeAnnotation(
        "term_error",
        "warning",
        "表述过满，容易被追问差异化依据。",
        "改成“多数学生能够……，基础薄弱学生在支架下能够……”。"
      )
    );
  }

  if (/首先/.test(text) && !/其次|再次|最后|然后/.test(text)) {
    annotations.push(
      makeAnnotation(
        "logic_gap",
        "info",
        "使用了顺序连接词，但后续层次没有展开。",
        "补齐“其次/最后”或改成单句说明，避免逻辑断层。"
      )
    );
  }

  if (!/学生|学情|已有|困难|差异/.test(text) && text.length > 80) {
    annotations.push(
      makeAnnotation(
        "risk",
        "warning",
        "当前表述较少谈到学生。",
        "说课高频扣分点是只讲教材和知识，不说明学生如何学。"
      )
    );
  }

  if (/活动|讨论|探究/.test(text) && !/分钟|时间|任务|产出|反馈/.test(text)) {
    annotations.push(
      makeAnnotation(
        "missing_point",
        "warning",
        "活动缺少可执行要素。",
        "补充任务、时间、分组、产出和教师反馈。"
      )
    );
  }

  if (input.wpm > 260) {
    annotations.push(
      makeAnnotation("risk", "warning", "语速偏快。", "建议控制在每分钟 180-240 字，关键处留出停顿。")
    );
  } else if (input.wpm > 0 && input.wpm < 130) {
    annotations.push(
      makeAnnotation("risk", "info", "语速偏慢。", "适当压缩赘述，把完整说课控制在 10 分钟内。")
    );
  }

  if (
    input.requestedStageId &&
    input.inferredStageId &&
    input.requestedStageId !== input.inferredStageId &&
    text.length > 35
  ) {
    annotations.push({
      ...makeAnnotation(
        "stage_mismatch",
        "error",
        `当前内容更像“${getStageName(input.inferredStageId)}”，与所选“${getStageName(input.requestedStageId)}”不一致。`,
        "先收束当前模块，再切换阶段继续。"
      ),
      stageId: input.inferredStageId
    });
  }

  return annotations.slice(0, 8);
}

function makeAnnotation(
  type: SpeakAnnotationType,
  severity: SpeakAnnotation["severity"],
  message: string,
  suggestion: string,
  matchedText?: string
) {
  return {
    id: `annotation_${randomUUID()}`,
    type,
    severity,
    message,
    suggestion,
    matchedText
  } satisfies SpeakAnnotation;
}

function buildRoleComment(
  role: RoleDefinition,
  input: { comment: string; suggestion: string; question?: string }
): RoleAgentComment {
  return {
    role: role.id,
    name: role.name,
    voiceStyle: role.voiceStyle,
    tone: role.tone,
    focus: role.focus,
    comment: input.comment,
    suggestion: input.suggestion,
    question: input.question
  };
}

function buildTurnSummary(
  session: SpeakTrainingSessionState,
  segmentText: string,
  report: SpeakTrainingReport
) {
  const stageNames = session.stageProgress
    .filter((stage) => stage.progress > 0)
    .map((stage) => stage.name);

  return {
    teachingLogic: stageNames.length
      ? `本轮已覆盖 ${stageNames.join("、")}。${report.missingStages.length ? `仍缺 ${report.missingStages.join("、")}。` : "完整说课框架已基本成型。"}`
      : "当前说课信息仍较少，建议先按教材分析、学情分析、教学目标展开。",
    objectiveRationality: hasObservableVerb(segmentText)
      ? "目标表达出现了可观察行为，后续要补充评价证据。"
      : "目标仍偏抽象，建议改写为学生能够完成的具体表现。",
    improvementAdvice: report.recommendedDrills.slice(0, 4)
  };
}

function buildTtsInstructions(
  comments: RoleAgentComment[],
  interruption: InterruptionDecision
) {
  const selected = interruption.shouldInterrupt
    ? comments.filter((comment) => comment.role === interruption.role)
    : comments;

  return selected.slice(0, interruption.shouldInterrupt ? 1 : 3).map((comment) => ({
    role: comment.role,
    voiceStyle: comment.voiceStyle,
    text: comment.question || `${comment.comment} ${comment.suggestion}`
  }));
}

function buildDefenseQuestions(session: SpeakTrainingSessionState) {
  const existing = session.defenseQuestions || [];
  const answeredByQuestion = new Map(existing.map((item) => [item.question, item]));
  const weakStages = session.stageProgress
    .filter(
      (stage) =>
        stage.status === "missing" ||
        stage.warnings.length ||
        stage.progress < 55
    )
    .map((stage) => stage.id);
  const weaknessQuestions: DefenseQuestion[] = [];

  if (weakStages.includes("keyPoint")) {
    weaknessQuestions.push(
      makeDefenseQuestion(
        "researcher",
        "basic",
        "本课难点为什么难？你准备用哪个教学活动突破？",
        "说课完整度",
        "weakness"
      )
    );
  }

  if (weakStages.includes("method")) {
    weaknessQuestions.push(
      makeDefenseQuestion(
        "expert",
        "advanced",
        "请区分本课教法和学法，并说明它们如何服务核心素养。",
        "理论结合",
        "weakness"
      )
    );
  }

  const truthBankQuestions: DefenseQuestion[] = [
    makeDefenseQuestion(
      "researcher",
      "basic",
      "请说明本课教学目标和新课标核心素养之间的对应关系。",
      "理论结合",
      "truth_bank"
    ),
    makeDefenseQuestion(
      "teacher",
      "applied",
      "如果小组讨论出现冷场，你会怎样调整提问和组织方式？",
      "答辩应答",
      "truth_bank"
    ),
    makeDefenseQuestion(
      "expert",
      "advanced",
      "你如何体现以学生为主体，而不是只完成教师讲授流程？",
      "逻辑框架",
      "truth_bank"
    ),
    makeDefenseQuestion(
      "researcher",
      "basic",
      "你准备用哪些课堂证据判断教学目标已经达成？",
      "评价闭环",
      "truth_bank"
    ),
    makeDefenseQuestion(
      "expert",
      "advanced",
      "本课的德育或核心素养融入点如何自然发生，而不是外加口号？",
      "育人逻辑",
      "truth_bank"
    ),
    makeDefenseQuestion(
      "expert",
      "advanced",
      "如果把本课成果延展到班级空间或易班社群，你会怎样保证网络育人导向、规范表达和理性互评？",
      "育人逻辑",
      "truth_bank"
    )
  ];

  return [...weaknessQuestions, ...truthBankQuestions].slice(0, 6).map((item) => {
    const existingItem = answeredByQuestion.get(item.question);
    return existingItem || item;
  });
}

function getStageQuestionRole(stageId: SpeakStageId): SpeakRoleId {
  if (stageId === "activity" || stageId === "process") {
    return "teacher";
  }

  if (stageId === "method" || stageId === "reflection") {
    return "expert";
  }

  return "researcher";
}

function buildStageFollowupQuestion(stage: SpeakStageProgress) {
  if (stage.id === "textbook") {
    return "请补充本课在教材单元中的位置，以及它对应的新课标依据。";
  }

  if (stage.id === "student") {
    return "请具体说明学生已有基础、典型困难和你准备提供的学习支架。";
  }

  if (stage.id === "objective") {
    return "请把本课目标改成学生可观察、可评价的行为结果，并说明达成证据。";
  }

  if (stage.id === "keyPoint") {
    return "请说明教学重点、难点分别是什么，难点为什么难，以及你准备用什么活动突破。";
  }

  if (stage.id === "method") {
    return "请区分教师的教法和学生的学法，并说明它们如何服务核心素养。";
  }

  if (stage.id === "process") {
    return "请用导入、新授、练习、小结串成一条流程线，并说明每一步如何推进目标。";
  }

  if (stage.id === "activity") {
    return "请补充活动任务、分组方式、时间、学生产出和教师反馈方式。";
  }

  if (stage.id === "assessment") {
    return "请说明评价标准是什么，教师依据哪些课堂证据判断目标达成。";
  }

  return "请说明课后反思会如何转化为下一次二次备课的具体改进。";
}

function makeDefenseQuestion(
  role: SpeakRoleId,
  level: DefenseQuestion["level"],
  question: string,
  targetDimension: string,
  source: DefenseQuestion["source"]
) {
  const roleDefinition = roleDefinitions[role];
  return {
    id: `defense_${randomUUID()}`,
    role,
    roleName: roleDefinition.name,
    level,
    question,
    targetDimension,
    source,
    status: "pending"
  } satisfies DefenseQuestion;
}

function buildFollowupQuestion(question: SpeakTrainingQuestion) {
  const role = roleDefinitions[question.role];
  return {
    id: `question_${randomUUID()}`,
    role: question.role,
    roleName: role.name,
    triggerType: "defense_followup",
    question: buildFollowupText(question.question),
    reason: "上一轮回应偏空泛，模拟考官继续深挖。",
    status: "pending",
    createdAt: new Date().toISOString()
  } satisfies SpeakTrainingQuestion;
}

function buildDefenseFollowup(question: DefenseQuestion) {
  return makeDefenseQuestion(
    question.role,
    "advanced",
    buildFollowupText(question.question),
    question.targetDimension,
    "followup"
  );
}

function buildFollowupText(question: string) {
  if (/小组|讨论|冷场/.test(question)) {
    return "如果你追问后仍然冷场，现场你会给学生怎样的支架或示例？";
  }

  if (/目标|课标|核心素养/.test(question)) {
    return "请举一个课堂证据，说明你如何判断这个目标已经达成。";
  }

  return "请把刚才的回答压缩成“结论、依据、做法”三句话。";
}

function scoreDefenseAnswer(answer: string) {
  const text = normalizeText(answer);
  let score = 52;

  if (text.length > 30) {
    score += 10;
  }

  if (/首先|其次|最后|第一|第二|第三|结论|依据|做法/.test(text)) {
    score += 12;
  }

  if (/学生|学情|差异|基础|冷场|反馈|追问|调整/.test(text)) {
    score += 12;
  }

  if (/课标|核心素养|建构|德育|新课改|最近发展区/.test(text)) {
    score += 10;
  }

  if (/具体|例如|比如|我会|可以/.test(text)) {
    score += 8;
  }

  return Math.min(96, score);
}

function buildDefenseAnswerFeedback(answer: string, score: number) {
  if (!answer.trim()) {
    return "未作答，答辩维度不得分。";
  }

  if (score >= 82) {
    return "回答有结论、有依据，也能落到课堂处理，适合保留为答辩话术。";
  }

  if (score >= 70) {
    return "回答基本成立，但还需要补充具体课堂证据或学生反应。";
  }

  return "回答偏空泛。建议按“先给结论，再说依据，最后给现场做法”的结构重答。";
}

function buildSpeakTrainingReport(
  session: SpeakTrainingSessionState,
  evaluation: TrainingEvaluation
) {
  const missingStages = session.stageProgress
    .filter((stage) => stage.status === "missing" || stage.progress < 35)
    .map((stage) => stage.name);
  const timeIssues = session.stageProgress.flatMap((stage) =>
    stage.warnings.filter((warning) => /时长|超时/.test(warning)).map((warning) => `${stage.name}：${warning}`)
  );
  const annotations = session.segments.flatMap((segment) => segment.annotations);
  const termIssues = annotations
    .filter((annotation) => annotation.type === "term_error")
    .map((annotation) => annotation.message);
  const logicBreakpoints = [
    ...annotations
      .filter((annotation) => annotation.type === "logic_gap" || annotation.type === "stage_mismatch")
      .map((annotation) => annotation.message),
    ...session.stageProgress
      .filter((stage) => stage.progress > 0 && stage.missingSignals.length)
      .map(
        (stage) =>
          `${stage.name}证据不足：还缺 ${stage.missingSignals.slice(0, 3).join("、")}。`
      )
  ];
  const defenseRisks = buildDefenseRisks(session, evaluation);
  const lostPoints = [
    ...session.stageProgress.flatMap((stage) =>
      stage.warnings.map((warning) => `${stage.name}：${warning}`)
    ),
    ...annotations
      .filter((annotation) => annotation.severity !== "info")
      .map((annotation) => annotation.message),
    ...session.questions
      .filter((question) => question.status === "pending")
      .map((question) => `${question.roleName}追问待回答：${question.question}`)
  ];
  const weakDimensions = evaluation.dimensions
    .filter((dimension) => dimension.score < 80)
    .map((dimension) => dimension.name);
  const report = {
    overallScore: evaluation.overallScore,
    passLine: PASS_LINE,
    pass: evaluation.overallScore >= PASS_LINE,
    stageCoverage: buildStageCoverage(session),
    missingStages,
    timeIssues,
    termIssues,
    logicBreakpoints: [...new Set(logicBreakpoints)].slice(0, 6),
    defenseRisks,
    evidenceChains: buildSpeakEvidenceChains(session),
    lostPoints: lostPoints.length ? [...new Set(lostPoints)].slice(0, 8) : ["本轮暂无明显扣分点，建议换课题迁移练习。"],
    weakDimensions,
    recommendedDrills: buildRecommendedDrills(weakDimensions, missingStages),
    optimizedPhrases: buildOptimizedPhrases(session),
    examinerScores: buildExaminerScores(session, evaluation),
    generatedAt: new Date().toISOString()
  } satisfies SpeakTrainingReport;

  return report;
}

function buildRecommendedDrills(weakDimensions: string[], missingStages: string[]) {
  const drills = new Set<string>();

  if (missingStages.includes("说重难点") || weakDimensions.includes("说课完整度")) {
    drills.add("重难点专项：按“是什么、为什么、怎么突破”复述 3 次。");
  }

  if (weakDimensions.includes("理论结合")) {
    drills.add("理论结合专项：每个理论术语必须对应一个学生学习行为。");
  }

  if (weakDimensions.includes("育人逻辑")) {
    drills.add("育人逻辑专项：用“育人目标、课堂行为、学生证据、网络延展”四句式复述。");
  }

  if (weakDimensions.includes("答辩应答")) {
    drills.add("答辩 30 秒专项：使用“结论、依据、做法”三句式。");
  }

  if (weakDimensions.includes("语言表达")) {
    drills.add("表达压缩专项：删除口头禅，把每段控制在 3-4 个短句。");
  }

  drills.add("全真模拟：随机课题 10 分钟说课 + 3 道答辩题。");
  return [...drills].slice(0, 5);
}

function buildStageCoverage(session: SpeakTrainingSessionState) {
  return session.stageProgress.map((stage) => ({
    id: stage.id,
    name: stage.name,
    status: stage.status,
    progress: stage.progress,
    evidence: stage.evidence.slice(0, 4),
    missingSignals: stage.missingSignals.slice(0, 4),
    action: buildStageAction(stage)
  })) satisfies SpeakStageCoverageItem[];
}

function buildStageAction(stage: SpeakStageProgress) {
  if (stage.status === "complete" && !stage.missingSignals.length) {
    return "已形成可用于报告的阶段证据，下一轮可压缩表达时间。";
  }

  if (stage.id === "textbook") {
    return "补一句教材位置、课标依据和本课育人价值。";
  }

  if (stage.id === "student") {
    return "补充学生已有基础、典型困难和差异化支架。";
  }

  if (stage.id === "objective") {
    return "把目标改成学生能够完成的可观察行为，并说明达成证据。";
  }

  if (stage.id === "keyPoint") {
    return "按“重点是什么、难点为什么难、如何突破”补齐。";
  }

  if (stage.id === "method") {
    return "区分教师怎么教、学生怎么学，避免只列方法名。";
  }

  if (stage.id === "process") {
    return "用导入、新授、练习、小结串成一条目标推进线。";
  }

  if (stage.id === "activity") {
    return "补充任务、分组、时间、产出和教师反馈。";
  }

  if (stage.id === "assessment") {
    return "说明评价标准、证据来源和目标达成判断。";
  }

  return "把课后反思落到可验证的二次备课改进动作。";
}

function buildSpeakEvidenceChains(session: SpeakTrainingSessionState) {
  const chains = session.stageProgress
    .filter((stage) => stage.progress > 0 || stage.status === "missing")
    .map((stage) => {
      const segment = [...session.segments]
        .reverse()
        .find((item) => item.stageId === stage.id);
      const annotation = segment?.annotations.find(
        (item) => item.severity !== "info"
      );

      return {
        stageName: stage.name,
        evidence:
          stage.evidence.length
            ? stage.evidence.slice(0, 3).join("、")
            : segment
              ? summarizeSpeakText(segment.text, 70)
              : "暂无有效说课证据",
        diagnosis:
          annotation?.message ||
          (stage.missingSignals.length
            ? `缺少 ${stage.missingSignals.slice(0, 3).join("、")} 等得分点。`
            : "阶段要点基本出现。"),
        suggestion: annotation?.suggestion || buildStageAction(stage)
      };
    });

  return chains.length
    ? chains.slice(0, 10)
    : [
        {
          stageName: "说教材",
          evidence: "暂无有效说课证据",
          diagnosis: "还没有提交说课片段。",
          suggestion: "先按“说教材、说学情、说目标”提交一段完整开头。"
        }
      ];
}

function buildDefenseRisks(
  session: SpeakTrainingSessionState,
  evaluation: TrainingEvaluation
) {
  const risks = new Set<string>();
  const weakDimensions = evaluation.dimensions
    .filter((dimension) => dimension.score < 80)
    .map((dimension) => dimension.name);

  if (weakDimensions.includes("理论结合")) {
    risks.add("理论依据风险：只说核心素养或新课标，未说明学生学习行为，容易被专家追问。");
  }

  if (weakDimensions.includes("育人逻辑")) {
    risks.add("育人逻辑风险：只出现德育或价值词，没有说明育人目标、课堂活动、评价证据和网络育人延展。");
  }

  if (weakDimensions.includes("逻辑框架")) {
    risks.add("逻辑严谨性风险：目标、活动、评价没有形成一一对应，答辩时需先补闭环。");
  }

  if (weakDimensions.includes("答辩应答")) {
    risks.add("答辩表达风险：追问回应偏空泛，建议使用“结论、依据、做法”三句式。");
  }

  if (session.stageProgress.some((stage) => stage.id === "activity" && stage.progress < 60)) {
    risks.add("课堂执行风险：活动缺少任务、分组、时间或产出，可能被追问真实课堂如何落地。");
  }

  if (session.questions.some((question) => question.status === "pending")) {
    risks.add("追问未闭环：当前仍有专家追问待回答，报告分数会持续受影响。");
  }

  return [...risks].slice(0, 5);
}

function buildOptimizedPhrases(session: SpeakTrainingSessionState) {
  const phrases: SpeakTrainingReport["optimizedPhrases"] = [];
  const text = session.segments.map((segment) => segment.text).join("\n");

  if (/学生都能完全掌握|所有学生都会/.test(text)) {
    phrases.push({
      original: "学生都能完全掌握本课内容。",
      optimized: "多数学生能够在活动中概括关键概念，基础薄弱学生可在学习支架下完成核心任务。"
    });
  }

  if (/进行讨论/.test(text) && !/任务|产出/.test(text)) {
    phrases.push({
      original: "让学生进行讨论。",
      optimized: "组织学生围绕主问题进行 3 分钟小组讨论，形成一条观点和一条依据后展示。"
    });
  }

  if (/培养学生兴趣/.test(text)) {
    phrases.push({
      original: "培养学生兴趣。",
      optimized: "通过情境问题激活已有经验，引导学生在解决真实任务中形成持续探究意愿。"
    });
  }

  if (/德育|育人|价值/.test(text) && !/证据|活动|评价|表现|网络育人|易班/.test(text)) {
    phrases.push({
      original: "本课体现德育和育人价值。",
      optimized: "本课把育人目标落在合作探究、尊重证据和理性表达中，并通过学生展示、同伴互评和班级空间/易班社群正向分享形成证据。"
    });
  }

  return phrases.slice(0, 4);
}

function buildExaminerScores(
  session: SpeakTrainingSessionState,
  evaluation: TrainingEvaluation
) {
  const dimensionMap = new Map(evaluation.dimensions.map((item) => [item.name, item]));
  const researcherWeak = [
    dimensionMap.get("说课完整度"),
    dimensionMap.get("逻辑框架")
  ].filter((item): item is EvaluationDimension => Boolean(item));
  const teacherWeak = [
    dimensionMap.get("语言表达"),
  ].filter((item): item is EvaluationDimension => Boolean(item));
  const expertWeak = [
    dimensionMap.get("理论结合"),
    dimensionMap.get("育人逻辑"),
    dimensionMap.get("答辩应答")
  ].filter((item): item is EvaluationDimension => Boolean(item));

  return [
    buildExaminerScore("researcher", researcherWeak, session),
    buildExaminerScore("teacher", teacherWeak, session),
    buildExaminerScore("expert", expertWeak, session)
  ];
}

function buildExaminerScore(
  role: SpeakRoleId,
  dimensions: EvaluationDimension[],
  session: SpeakTrainingSessionState
) {
  const definition = roleDefinitions[role];
  const score = Math.round(
    dimensions.reduce((total, dimension) => total + dimension.score, 0) /
      Math.max(1, dimensions.length)
  );
  const deductions = dimensions
    .filter((dimension) => dimension.score < 80)
    .map((dimension) => `${dimension.name}：${dimension.comment}`);

  return {
    role,
    roleName: definition.name,
    score,
    focus: definition.focus,
    deductions: deductions.slice(0, 3),
    comment:
      score >= 80
        ? "该考官视角下表现较稳，可以继续提高表达压缩度。"
        : "该考官视角下仍有明显扣分点，需要专项补齐。"
  } satisfies ExaminerScore;
}

function scoreSpeakDimension(
  name: string,
  text: string,
  signals: string[],
  adjustment = 0
) {
  const matched = getMatchedSignals(text, signals);
  const lengthBonus = Math.min(8, Math.floor(text.length / 500));
  const score = Math.max(
    45,
    Math.min(96, 58 + matched.length * 5 + lengthBonus + adjustment)
  );

  return {
    name,
    score,
    comment:
      score >= 80
        ? `${name}表现较清晰，可以继续细化证据。`
        : `${name}仍需补充更具体的说课依据和课堂证据。`
  } satisfies EvaluationDimension;
}

function stageCoverageBonus(session: SpeakTrainingSessionState) {
  const covered = session.stageProgress.filter((stage) => stage.progress >= 45).length;
  return Math.min(20, covered * 2);
}

function annotationPenalty(session: SpeakTrainingSessionState, types: SpeakAnnotationType[]) {
  return session.segments
    .flatMap((segment) => segment.annotations)
    .filter((annotation) => types.includes(annotation.type)).length * 5;
}

function defenseAnswerBonus(session: SpeakTrainingSessionState) {
  const answered = [
    ...session.questions.filter((question) => question.status === "answered"),
    ...session.defenseQuestions.filter((question) => question.status === "answered")
  ];

  if (!answered.length) {
    return -12;
  }

  const average = Math.round(
    answered.reduce((total, question) => total + (question.score || 0), 0) /
      answered.length
  );
  return Math.round((average - 70) / 2);
}

function buildSpeakDiagnosis(
  session: SpeakTrainingSessionState,
  weak: EvaluationDimension[],
  citations: StoredCitation[]
) {
  const pending = [
    ...session.questions.filter((question) => question.status === "pending"),
    ...session.defenseQuestions.filter((question) => question.status === "pending")
  ];
  const missing = session.stageProgress.filter((stage) => stage.status === "missing");
  const diagnosis = weak.length
    ? weak.slice(0, 3).map((dimension) => `${dimension.name}偏弱：${dimension.comment}`)
    : ["本轮说课已经形成较完整的教研答辩链条。"];

  if (missing.length) {
    diagnosis.push(`说课框架缺漏：${missing.map((stage) => stage.name).join("、")}。`);
  }

  if (pending.length) {
    diagnosis.push(`当前还有 ${pending.length} 个专家追问或答辩题等待回应。`);
  }

  diagnosis.push(
    citations.length
      ? `本次反馈结合 ${citations.length} 条知识库资料。`
      : "本次暂未引用知识库资料，建议补充课标或优秀课例作为依据。"
  );

  return diagnosis.slice(0, 5);
}

function buildSpeakSuggestions(
  weak: EvaluationDimension[],
  session: SpeakTrainingSessionState
) {
  const suggestions = weak.slice(0, 4).map((dimension) => {
    if (dimension.name === "说课完整度") {
      return "按九模块框架补齐：教材、学情、目标、重难点、教法学法、过程、活动、评价、反思。";
    }

    if (dimension.name === "答辩应答") {
      return "答辩先说结论，再给理论或课堂依据，最后落到具体做法。";
    }

    if (dimension.name === "理论结合") {
      return "不要只说核心素养或建构主义，要说明学生经历了哪些学习行为。";
    }

    if (dimension.name === "育人逻辑") {
      return "补充育人目标、课堂活动、学生表现证据和网络育人延展，避免把德育写成口号。";
    }

    return `围绕「${dimension.name}」补充可观察证据。`;
  });

  if (session.questions.some((question) => question.status === "pending")) {
    suggestions.unshift("先回答当前专家追问，再继续下一段说课。");
  }

  return suggestions.length
    ? suggestions.slice(0, 5)
    : ["保留本轮结构，用另一课题迁移练习一次。"];
}

function buildNextTask(weak: EvaluationDimension[], session: SpeakTrainingSessionState) {
  if (weak[0]?.name === "答辩应答") {
    return "下一轮重点练习专家追问后的 30 秒回应，先回答结论再补依据。";
  }

  const weakestStage = session.stageProgress.find(
    (stage) => stage.status === "missing" || stage.warnings.length
  );

  if (weakestStage) {
    return `下一轮先做「${weakestStage.name}」专项训练，再进入 10 分钟全真说课。`;
  }

  return "下一轮开启全真模拟套卷：随机课题、10 分钟说课、3 道结构化答辩。";
}

function renderQuestion(question: SpeakTrainingQuestion) {
  return `${question.question}\n${question.answer || ""}`;
}

function renderDefenseQuestion(question: DefenseQuestion) {
  return `${question.question}\n${question.answer || ""}`;
}

function getStageName(stageId: SpeakStageId) {
  return stageDefinitions.find((stage) => stage.id === stageId)?.name || "说课阶段";
}

function summarizeSpeakText(text: string, maxLength: number) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function buildAsrUnavailableNotice() {
  const config = getSpeakTrainingConfig();

  if (config.asrProvider === "browser") {
    return "当前为浏览器 ASR MVP 模式，请由前端传入转写文本；服务端已保留生产 ASR 接入点。";
  }

  return `已选择 ${config.asrProvider} ASR，但服务商密钥或实现尚未完成配置。`;
}

function estimateDurationSec(text: string, pauseDurationMs = 0) {
  const wordCount = countSpeakWords(text);
  const estimatedBySpeed = Math.max(6, Math.round((wordCount / 190) * 60));
  const pauseSec = Math.round(pauseDurationMs / 1000);
  return Math.max(estimatedBySpeed, pauseSec);
}

function countSpeakWords(text: string) {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = text
    .replace(/[\u4e00-\u9fa5]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return chineseChars + words;
}

function formatDuration(seconds: number) {
  if (seconds < 60) {
    return `${seconds} 秒`;
  }

  const minute = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minute} 分 ${rest} 秒` : `${minute} 分钟`;
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, "");
}

function mentionsKeyPoint(text: string) {
  return /重点|难点|重难点|突破/.test(text);
}

function mentionsMethod(text: string) {
  return /教法|学法|讲授|启发|探究|合作/.test(text);
}

function mentionsCooperativeLearning(text: string) {
  return /合作学习|小组合作|合作探究|分组学习|小组学习|分组讨论|讨论后展示|讨论.*展示|小组.*展示/.test(
    text
  );
}

function hasGroupingDetails(text: string) {
  return /每组|[0-9一二三四五六七八九十]+人|角色|组长|记录员|汇报员|人数|同伴互助|异质|同质|分层|时间|分钟|产出/.test(
    text
  );
}

function mentionsDiscussionActivity(text: string) {
  return /讨论|展示|交流|汇报/.test(text);
}

function hasActivityExecutionDetails(text: string) {
  return /分钟|时间|产出|成果|记录单|学习单|汇报员|评价标准|反馈|收束/.test(text);
}

function mentionsQuestioningActivity(text: string) {
  return /提问|发问|追问|问题|学生.*回答|回答/.test(text);
}

function hasQuestioningDetails(text: string) {
  return /问什么|问题链|主问题|预设|预计|可能.*答|回答.*可能|追问|反馈|评价|标准|依据|纠错|生成/.test(
    text
  );
}

function mentionsTheory(text: string) {
  return /核心素养|建构主义|最近发展区|支架|学习共同体|深度学习|新课改|德育/.test(text);
}

function explainsTheory(text: string) {
  return /通过|经历|探究|协商|迁移|反思|生成|观察|表达|操作|讨论|体验|建构/.test(text);
}

function mentionsMoralEducation(text: string) {
  return /育人|德育|师德|价值引导|网络育人|易班|责任意识|公平|关怀/.test(text);
}

function hasMoralEducationLogic(text: string) {
  return /目标|活动|评价|证据|表现|生成|自然|课堂|学生|社群|互评/.test(text);
}

function mentionsObjective(text: string) {
  return /教学目标|目标|核心素养|达成/.test(text);
}

function hasObservableVerb(text: string) {
  return /能够|能|说出|概括|比较|解释|完成|设计|分析|评价|迁移|运用/.test(text);
}

function mentionsAssessment(text: string) {
  return /评价|检测|反馈|作业|量规/.test(text);
}

function hasAssessmentStandard(text: string) {
  return /标准|依据|证据|量规|等级|表现|达成/.test(text);
}

function mentionsClassroomRisk(text: string) {
  return /整节课|大量|全部展示|逐一|每个学生都|二十分钟讨论|30分钟讨论|时间不够|来不及/.test(
    text
  );
}

function hasTimeOrGrouping(text: string) {
  return /分钟|时间|分组|小组|任务|产出|展示|反馈/.test(text);
}

function isSemanticallyOpen(text: string) {
  return /然后|接下来|因为|所以|但是|同时|首先|其次|比如|例如|这个/.test(text);
}

function isStructureNode(text: string, allText: string) {
  const nodeSignal = /以上是|接下来|下面我|最后|然后进入|完成/.test(text);
  const coveredStages = stageDefinitions.filter((stage) =>
    stage.keywords.some((keyword) => allText.includes(keyword))
  );

  return nodeSignal && coveredStages.length >= 2;
}
