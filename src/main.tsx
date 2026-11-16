import React, { useEffect, useRef, useState } from "react";
import { accountStorage } from "./features/auth/accountStorage";
import { createPortal } from "react-dom";
import ReactDOM from "react-dom/client";
import { AnimatePresence, motion } from "framer-motion";
import {
  AtSign,
  Archive,
  AlertTriangle,
  BarChart3,
  Bot,
  Brain,
  BookOpen,
  Bookmark,
  Check,
  ChevronRight,
  Clock3,
  Code,
  Database,
  Download,
  FilePenLine,
  FileText,
  Gauge,
  GitCompareArrows,
  Layers3,
  Languages,
  MessageCircleQuestion,
  Mic,
  NotebookPen,
  Paperclip,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Split,
  Square,
  Table2,
  Target,
  Trash2,
  TrendingUp,
  UploadCloud,
  Volume2,
  Wrench,
  X
} from "lucide-react";
import { Sidebar } from "./components/Sidebar";
import { WorkbenchPage } from "./features/workbench/WorkbenchPage";
import { ClassroomTrainingPage } from "./features/classroom/ClassroomTrainingPage";
import { CounselingTrainingPage } from "./features/counseling/CounselingTrainingPage";
import { WorkflowCanvasPage } from "./features/platform/WorkflowCanvasPage";
import { ScenarioValidationPage } from "./features/platform/ScenarioValidationPage";
import { RegistryPage } from "./features/platform/RegistryPage";
import { KnowledgePage } from "./features/platform/KnowledgePage";
import { McpPage } from "./features/platform/McpPage";
import { PluginsPage } from "./features/platform/PluginsPage";
import { RunMonitorPage } from "./features/platform/RunMonitorPage";
import { VerifyReportPage } from "./features/platform/VerifyReportPage";
import { EvolutionPage } from "./features/platform/EvolutionPage";
import { platformApi } from "./features/platform/api";
import type { AgentRecord } from "./features/platform/types";
import { AgentAvatar } from "./features/agents/AgentAvatar";
import { MessageMarkdown } from "./features/chat/MessageMarkdown";
import {
  buildWorkflowChatInput,
  readWorkflowOptions,
  readWorkflowVariables,
  type WorkflowChatOption,
  type WorkflowInputVariable
} from "./features/workflowChat/session";
import { VoiceChatStage } from "./features/voice/VoiceChatStage";
import { SettingsDialog, type SettingsTab } from "./features/settings/SettingsDialog";
import { AuthProvider, useAuth } from "./features/auth/AuthProvider";
import { AccountDialog } from "./features/auth/AccountDialog";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ModelPicker } from "./features/settings/ModelPicker";
import {
  applyAppearance,
  persistAppearance,
  readAppearance,
  type Appearance
} from "./features/theme/appearance";
import "./styles.css";
import "./styles/theme-tokens.css";
import "./styles/theme.css";
import "./features/auth/auth.css";
import { PetStage } from "./features/pet/PetStage";
import { castForAgent } from "./features/pet/petCast";
import { pet } from "./features/pet/petStore";

/** 写请求同源标记。服务端 CSRF 屏障要求 JSON 内容类型或这个头二选一，
 *  没有请求体的 POST / DELETE 必须显式带上，否则会被判成跨站表单提交。 */
const SAME_ORIGIN_HEADERS = { "X-Requested-With": "StarLattice" };

type Attachment = {
  id: string;
  file: File;
  name: string;
  size: number;
  previewUrl?: string;
};

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Attachment[];
  status?: "generating" | "done" | "error";
  thinkingEnabled?: boolean;
  thinkingText?: string;
  thinkingSeconds?: number;
  thinkingStartedAt?: number;
  sourcePrompt?: string;
  artifacts?: ChatArtifact[];
  citations?: KnowledgeCitation[];
  knowledgeBaseIds?: string[];
  knowledgeQueryMode?: "search" | "overview";
  evaluation?: TrainingEvaluation;
  lessonPlanState?: LessonPlanState;
  internshipReflectionState?: InternshipReflectionState;
  insightMode?: InsightMode;
  /** 智能体在回答前调用过的工具，用来告诉用户「这条结论是查出来的」。 */
  toolNotes?: ToolNote[];
  /** 工作流会话：这轮真的走了哪些智能体/子流程节点（含耗时），渲染在回复上方的小字标签。 */
  traceAgents?: TraceAgent[];
  /** 这条回复由哪个智能体给出；默认助手留空。 */
  agentName?: string;
  agentAvatar?: string;
  /** 从提问到回复结束的耗时，恢复的历史会话没有这个值。 */
  durationMs?: number;
};

type TraceAgent = {
  name: string;
  kind: "agent" | "subworkflow" | "llm";
  durationMs?: number;
  agentId?: string;
};

/** 后端把问题转交给专项智能体后，告诉前端这轮到底是谁在说话。 */
type DelegatedAnswerInfo = {
  agentId?: string;
  agentName: string;
  agentAvatar?: string;
};

type ToolNote = {
  toolId: string;
  name: string;
  stage: "running" | "done" | "skipped";
  ok?: boolean;
  summary?: string;
  latencyMs?: number;
  /** delegation = 把问题转交给了另一个智能体，界面上用「转交」而不是「调用」。 */
  kind?: "tool" | "delegation";
  /** 工具所属服务器（MCP 连接名 / 插件名），界面显示成「服务器/工具」。 */
  serverName?: string;
  /** 工具的真实函数名。 */
  toolName?: string;
  /** 转交目标：界面直接把署名换成它。 */
  targetAgent?: { id: string; name: string; avatar?: string };
};

/** 工具条上的名字：「MCP 连接名 / 工具函数名」，没有服务器名时退回工具中文名。 */
function toolLabelOf(note: ToolNote): string {
  const tool = note.toolName || note.name;
  return note.serverName ? `${note.serverName}/${tool}` : tool;
}

/** 桌宠气泡里用的短名字：优先显示名，函数名那种 snake_case 转成空格分隔。 */
function toolCaptionName(note: ToolNote): string {
  const raw = note.name || note.toolName || "工具";
  if (/^[a-z0-9_.\-]+$/i.test(raw)) {
    return raw.replace(/[_-]+/g, " ");
  }
  return raw;
}

type GenerationThinkingStep = {
  id: string;
  label: string;
  detail: string;
};

type GenerationThinkingProgress = {
  steps: GenerationThinkingStep[];
  activeStepId: string;
  completedStepIds: string[];
};

type PendingKnowledgeSelection = {
  kind: "lesson-guided";
  messageId: string;
};

type ChatArtifact = {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
};

type KnowledgeBase = {
  id: string;
  name: string;
  source: KnowledgeSource;
  providerStatus?: KnowledgeProviderStatus;
  externalId?: string;
  documentCount: number;
  createdAt: string;
};

type KnowledgeDocument = {
  id: string;
  knowledgeBaseId: string;
  name: string;
  type: string;
  size: number;
  chunkCount: number;
  resourceType: KnowledgeResourceType;
  subject?: string;
  schoolStage?: string;
  tags: string[];
  createdAt: string;
};

type KnowledgeResourceType =
  | "课程标准"
  | "教材/课件"
  | "优秀课例"
  | "课堂证据"
  | "教研资料"
  | "其他";

type KnowledgeDocumentMetadata = {
  resourceType: KnowledgeResourceType;
  subject: string;
  schoolStage: string;
  tags: string[];
};

type KnowledgeSearchState = "idle" | "loading" | "success" | "empty" | "error";

type KnowledgeChunk = {
  id: string;
  documentId: string;
  index: number;
  content: string;
};

type KnowledgeCitation = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  documentName: string;
  snippet: string;
  source: KnowledgeSource;
  score: number;
};

type KnowledgeSource = "local" | "ima" | "external";

type KnowledgeProviderStatus = "connected" | "not_configured" | "error" | "syncing";

type KnowledgeProviderInfo = {
  id: KnowledgeSource;
  name: string;
  status: KnowledgeProviderStatus;
  description: string;
  baseCount?: number;
  message?: string;
};

type StarterKnowledgePack = {
  id: string;
  name: string;
  description: string;
  recommendedFor: string[];
  documentCount: number;
};

type TrainingType = "教案诊断" | "说课陪练" | "模拟课堂" | "实习反思" | "谈心谈话";

type ChatMode = "office" | "education" | "workflow";

type EvaluationDimension = {
  name: string;
  score: number;
  comment: string;
};

type TrainingEvaluation = {
  id: string;
  conversationId: string;
  trainingType: TrainingType;
  overallScore: number;
  dimensions: EvaluationDimension[];
  diagnosis: string[];
  suggestions: string[];
  nextTask: string;
  citations: KnowledgeCitation[];
  createdAt: string;
};

type SpeakStageId =
  | "textbook"
  | "student"
  | "objective"
  | "keyPoint"
  | "method"
  | "process"
  | "activity"
  | "assessment"
  | "reflection";

type SpeakRoleId = "researcher" | "teacher" | "expert";

type SpeakRhythmState =
  | "LISTENING"
  | "ANALYZING"
  | "INTERRUPTING"
  | "WAITING_RESPONSE";

type SpeakStageProgress = {
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

type SpeakAnnotation = {
  id: string;
  type:
    | "filler"
    | "term_error"
    | "logic_gap"
    | "missing_point"
    | "stage_mismatch"
    | "risk";
  severity: "info" | "warning" | "error";
  message: string;
  suggestion: string;
  matchedText?: string;
  stageId?: SpeakStageId;
};

type RoleAgentComment = {
  role: SpeakRoleId;
  name: string;
  voiceStyle: string;
  tone: string;
  focus: string;
  comment: string;
  suggestion: string;
  question?: string;
};

type InterruptionDecision = {
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

type SpeakTrainingQuestion = {
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

type SpeakTrainingSegment = {
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

type DefenseQuestion = {
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

type DefenseAnswer = {
  questionId: string;
  answer: string;
  score: number;
  feedback: string;
  createdAt: string;
};

type DefenseOptimizationItem = {
  questionId: string;
  question: string;
  target: string;
  originalEvidence: string;
  answerDiagnosis: string;
  revisionPlan: string;
  replacementScript: string;
  preparationActions: string[];
};

type DefenseOptimizationPlan = {
  title: string;
  summary: string;
  items: DefenseOptimizationItem[];
  generatedAt: string;
};

type SpeakAiFocusHint = {
  label: string;
  detail: string;
  sourceEvidence: string;
};

type ExaminerScore = {
  role: SpeakRoleId;
  roleName: string;
  score: number;
  focus: string;
  deductions: string[];
  comment: string;
};

type SpeakStageCoverageItem = {
  id: SpeakStageId;
  name: string;
  status: SpeakStageProgress["status"];
  progress: number;
  evidence: string[];
  missingSignals: string[];
  action: string;
};

type SpeakEvidenceChain = {
  stageName: string;
  evidence: string;
  diagnosis: string;
  suggestion: string;
};

type SpeakTrainingReport = {
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

type SpeakRetrainComparison = {
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

type SpeakPriorityFocus = {
  title: string;
  reason: string;
  practicePrompt: string;
  stageId?: SpeakStageId;
  suggestedText?: string;
};

type SpeakRetrainFocus = SpeakPriorityFocus & {
  originalText?: string;
};

function getSpeakPriorityFocus(report: SpeakTrainingReport): SpeakPriorityFocus {
  const prioritizedStage = [...report.stageCoverage]
    .filter((stage) => stage.status === "missing" || stage.status === "warning")
    .sort((left, right) => left.progress - right.progress)[0];
  const suggestedPhrase = report.optimizedPhrases[0];
  const issues = [
    ...report.lostPoints,
    ...report.logicBreakpoints,
    ...report.termIssues,
    ...report.defenseRisks
  ];

  if (prioritizedStage) {
    const reason = prioritizedStage.action || `当前环节覆盖 ${prioritizedStage.progress}%，需要补充关键说课依据。`;
    return {
      title: `${prioritizedStage.name}需要补强`,
      reason,
      practicePrompt: suggestedPhrase
        ? `请用 40 秒重新说明这一环节，并把表达改为：${suggestedPhrase.optimized}`
        : `请用 40 秒重新说明这一环节，重点回应：${prioritizedStage.missingSignals.join("、") || "关键内容"}。`,
      stageId: prioritizedStage.id,
      suggestedText: suggestedPhrase?.optimized
    };
  }

  const firstIssue = issues[0] || report.weakDimensions[0] || "让说课表达更具体、更可评价";
  return {
    title: "让表达更具体、更可评价",
    reason: firstIssue,
    practicePrompt: suggestedPhrase
      ? `请围绕这条问题重练 40 秒，并尝试使用：${suggestedPhrase.optimized}`
      : "请围绕本轮扣分点重练 40 秒，补足具体做法和可观察的学习结果。",
    suggestedText: suggestedPhrase?.optimized
  };
}

type SpeakTrainingSessionState = {
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

type SpeakTrainingTurnResult = {
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

type SpeakRealtimeServerEvent =
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

type SpeakTrainingConfig = {
  asrProvider: "browser" | "iflytek" | "azure" | "whisper" | string;
  ttsProvider: "browser" | "iflytek" | "azure" | "elevenlabs" | string;
  realtimeMode: "mvp" | "production" | string;
  productionReady?: boolean;
  iflytekConfigured?: boolean;
};

type SpeakDraftInputMode = "manual" | "speech" | "mixed";

type ConversationSummary = {
  id: string;
  title: string;
  trainingType: TrainingType | "通用对话";
  assistantMode: "office" | "education";
  messageCount: number;
  artifactCount: number;
  citationCount: number;
  attachmentNames: string[];
  knowledgeBaseIds: string[];
  latestEvaluation?: TrainingEvaluation;
  lastMessage?: string;
  createdAt: string;
  updatedAt: string;
  workflowId?: string;
  lastRunId?: string;
  /** 绑定的自建智能体；空表示默认助手。 */
  agentId?: string;
};

type ConversationDetail = ConversationSummary & {
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    /** 实际作答的智能体（转交后是专项智能体），历史里优先用它署名。 */
    agentName?: string;
    agentAvatar?: string;
    toolNotes?: Array<{
      toolId: string;
      name: string;
      ok: boolean;
      latencyMs: number;
      summary?: string;
      kind?: "tool" | "delegation";
      serverName?: string;
      toolName?: string;
    }>;
  }>;
  artifacts: ChatArtifact[];
  citations: KnowledgeCitation[];
};

type GrowthSummary = {
  totalTrainings: number;
  averageScore: number;
  growthStage: "建立基线" | "补齐训练" | "专项提升";
  recommendedAction: {
    trainingType: TrainingType;
    reason: string;
    objective: string;
    completionCriteria: string;
    prompt: string;
  };
  dimensionAverages: EvaluationDimension[];
  trainingTypeCounts: Record<TrainingType, number>;
  trainingTypeSummaries: Array<{
    trainingType: TrainingType;
    count: number;
    averageScore: number;
    latestTitle?: string;
    latestScore?: number;
    evidenceCount: number;
    artifactCount: number;
    citationCount: number;
    status: "已覆盖" | "待训练";
    nextAction: string;
  }>;
  growthTimeline: Array<{
    id: string;
    title: string;
    trainingType: TrainingType;
    score: number;
    dimensions: EvaluationDimension[];
    weakDimensions: string[];
    artifactCount: number;
    nextTask: string;
    createdAt: string;
  }>;
  evidenceRecords: Array<{
    id: string;
    title: string;
    trainingType: TrainingType;
    score: number;
    dimensions: EvaluationDimension[];
    weakDimensions: string[];
    artifactCount: number;
    citationCount: number;
    nextTask: string;
    createdAt: string;
  }>;
  representativeArtifacts: Array<{
    id: string;
    title: string;
    trainingType: TrainingType;
    score: number;
    artifactCount: number;
    citationCount: number;
    reason: string;
    createdAt: string;
  }>;
  capabilityMatrix: Array<{
    name: string;
    score: number;
    evidence: string;
    nextAction: string;
  }>;
  reflectionSummary: {
    totalReflections: number;
    latestTitle?: string;
    latestScore?: number;
    evidenceCount: number;
    nextAction: string;
  };
  recentConversations: ConversationSummary[];
  recentEvaluations: TrainingEvaluation[];
  weakDimensions: EvaluationDimension[];
  recommendedNextTask: string;
};

type LessonPlanInput = {
  subject: string;
  grade: string;
  topic: string;
  duration: string;
  textbookContext: string;
  studentProfile: string;
  knowledgeBaseIds: string[];
  skills: string[];
};

type LessonPlanSection = {
  heading: string;
  body?: string;
  bullets?: string[];
};

type LessonPlanDraft = {
  title: string;
  input: LessonPlanInput;
  sections: LessonPlanSection[];
  sourceNote: string;
  version: number;
  createdAt: string;
};

type LessonPlanDiagnostic = {
  overallScore: number;
  dimensions: EvaluationDimension[];
  diagnosis: string[];
  suggestions: string[];
  nextTask: string;
};

type LessonPlanComparison = {
  summary: string;
  items: Array<{
    dimension: "目标" | "学情" | "活动" | "评价" | "育人融入";
    before: string;
    after: string;
    improvement: string;
  }>;
  evidence: string[];
};

type LessonPlanResponse = {
  conversationId: string;
  draft: LessonPlanDraft;
  diagnostic: LessonPlanDiagnostic;
  citations: KnowledgeCitation[];
  evaluation: TrainingEvaluation;
  comparison?: LessonPlanComparison;
};

type LessonPlanPhase = "collecting" | "generating" | "generated" | "refining" | "error";

type InsightMode = "thinking" | "lessonPreview" | "reflectionPreview" | "files";

type LessonPlanState = {
  phase: LessonPlanPhase;
  input: LessonPlanInput;
  collectionMode?: "guided";
  currentStepId?: string;
  answeredStepIds?: string[];
  pendingQuestion?: string;
  isReadyToGenerate?: boolean;
  draft?: LessonPlanDraft;
  diagnostic?: LessonPlanDiagnostic;
  comparison?: LessonPlanComparison;
  citations: KnowledgeCitation[];
  artifact?: ChatArtifact;
  conversationId?: string;
  version: number;
  status?: string;
  thinkingProgress?: GenerationThinkingProgress;
};

type InternshipReflectionInput = {
  schoolClass: string;
  subjectTopic: string;
  internshipDate: string;
  classroomSegment: string;
  observationFocus: string;
  problems: string;
  personalFeeling: string;
  improvementDirection: string;
  knowledgeBaseIds: string[];
};

type InternshipEvidenceItem = {
  id: string;
  name: string;
  type: "image" | "document" | "text";
  summary: string;
  observationPoints: string[];
  privacyNote?: string;
};

type InternshipReflectionSection = {
  heading: string;
  body?: string;
  bullets?: string[];
};

type InternshipReflectionDraft = {
  title: string;
  input: InternshipReflectionInput;
  evidence: InternshipEvidenceItem[];
  sections: InternshipReflectionSection[];
  sourceNote: string;
  version: number;
  createdAt: string;
};

type InternshipReflectionDiagnostic = {
  overallScore: number;
  dimensions: EvaluationDimension[];
  diagnosis: string[];
  suggestions: string[];
  nextTask: string;
};

type InternshipReflectionResponse = {
  conversationId: string;
  draft: InternshipReflectionDraft;
  diagnostic: InternshipReflectionDiagnostic;
  citations: KnowledgeCitation[];
  evidence: InternshipEvidenceItem[];
  evaluation: TrainingEvaluation;
};

type InternshipReflectionPhase =
  | "collecting"
  | "generating"
  | "generated"
  | "refining"
  | "error";

type InternshipReflectionState = {
  phase: InternshipReflectionPhase;
  input: InternshipReflectionInput;
  evidence: InternshipEvidenceItem[];
  evidenceFiles: Attachment[];
  collectionMode?: "guided";
  currentStepId?: string;
  answeredStepIds?: string[];
  pendingQuestion?: string;
  isReadyToGenerate?: boolean;
  draft?: InternshipReflectionDraft;
  diagnostic?: InternshipReflectionDiagnostic;
  citations: KnowledgeCitation[];
  artifact?: ChatArtifact;
  conversationId?: string;
  version: number;
  status?: string;
  thinkingProgress?: GenerationThinkingProgress;
};

type ChatStreamEvent = {
  event: string;
  data: string;
};

type StreamDonePayload = {
  conversationId?: string;
  draft?: LessonPlanDraft | InternshipReflectionDraft;
  diagnostic?: LessonPlanDiagnostic | InternshipReflectionDiagnostic;
  comparison?: LessonPlanComparison;
  citations?: KnowledgeCitation[];
  evidence?: InternshipEvidenceItem[];
  evaluation?: TrainingEvaluation;
};

type StreamPhasePayload = Partial<GenerationThinkingProgress> & {
  stepId?: string;
  label?: string;
  detail?: string;
};

type GuidedStep<TInput> = {
  id: string;
  label: string;
  question: string;
  field?: keyof TInput | "objectivePreference" | "evidenceDecision";
  required: boolean;
  fallback?: string;
  agentName: string;
};

type QuickTask = {
  label: string;
  prompt: string;
  trainingType: TrainingType;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
};

const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_TOTAL_SIZE = 10 * 1024 * 1024;
const GENERATION_STAGE_DELAY_MS = 720;
const RESULT_REVEAL_DELAY_MS = 420;
const SUPPORTED_ATTACHMENT_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "pdf",
  "txt",
  "md",
  "csv",
  "json"
]);

const lessonPlanGenerateThinkingSteps: GenerationThinkingStep[] = [
  {
    id: "lesson-context",
    label: "理解课程信息",
    detail: "读取学科、年级、课题、课时、教材背景和训练目标。"
  },
  {
    id: "lesson-knowledge",
    label: "检索知识库证据",
    detail: "优先查找课程标准、教材片段和优秀课例，准备引用依据。"
  },
  {
    id: "lesson-structure",
    label: "组织教案结构",
    detail: "把目标、学情、活动流程、提问预设和育人融入点串成完整初稿。"
  },
  {
    id: "lesson-diagnosis",
    label: "诊断薄弱维度",
    detail: "按目标、学情、活动、互动、反思和师德育人生成评分。"
  },
  {
    id: "lesson-artifact",
    label: "整理预览和 Word",
    detail: "准备可预览成果、引用信息和可下载文档。"
  }
];

const lessonPlanRefineThinkingSteps: GenerationThinkingStep[] = [
  {
    id: "lesson-refine-issues",
    label: "读取诊断建议",
    detail: "定位目标、学情、活动、互动、反思和育人融入中的薄弱点。"
  },
  {
    id: "lesson-refine-evidence",
    label: "复核证据来源",
    detail: "保留已有知识库引用，并重新组织可用于优化的依据。"
  },
  {
    id: "lesson-refine-draft",
    label: "生成优化稿",
    detail: "让优化内容逐项回应诊断问题，而不是简单改写原文。"
  },
  {
    id: "lesson-refine-score",
    label: "重新诊断评分",
    detail: "检查优化稿是否形成更完整的教学闭环。"
  },
  {
    id: "lesson-refine-artifact",
    label: "更新预览和 Word",
    detail: "替换为新版本成果，并保留可下载文件。"
  }
];

const reflectionGenerateThinkingSteps: GenerationThinkingStep[] = [
  {
    id: "reflection-context",
    label: "还原课堂事实",
    detail: "读取班级、课题、实习日期、课堂片段和观察重点。"
  },
  {
    id: "reflection-evidence",
    label: "整理证据材料",
    detail: "合并文本、上传文件和知识库引用，形成可追溯证据链。"
  },
  {
    id: "reflection-model",
    label: "建立反思结构",
    detail: "按观察证据、问题诊断、原因分析、改进行动和师德育人组织。"
  },
  {
    id: "reflection-diagnosis",
    label: "评估反思质量",
    detail: "检查证据、理论连接、改进闭环和行动计划是否完整。"
  },
  {
    id: "reflection-artifact",
    label: "整理预览和 Word",
    detail: "准备反思预览、证据摘要和可下载文档。"
  }
];

const reflectionRefineThinkingSteps: GenerationThinkingStep[] = [
  {
    id: "reflection-refine-issues",
    label: "读取诊断建议",
    detail: "确认反思中证据、原因、理论和行动计划的薄弱处。"
  },
  {
    id: "reflection-refine-evidence",
    label: "复核证据链",
    detail: "把已有课堂事实、上传材料和知识库依据重新对齐。"
  },
  {
    id: "reflection-refine-draft",
    label: "生成优化反思",
    detail: "让每段改写都对应一个可观察问题和一个后续行动。"
  },
  {
    id: "reflection-refine-score",
    label: "重新诊断评分",
    detail: "检查优化稿是否更适合提交和成长档案沉淀。"
  },
  {
    id: "reflection-refine-artifact",
    label: "更新预览和 Word",
    detail: "替换为新版本成果，并保留证据摘要。"
  }
];

const quickTasks: QuickTask[] = [
  {
    label: "帮我生成一份教案",
    prompt: "帮我生成一份完整教案，包含教学目标、重难点、流程、板书和课后反思。",
    trainingType: "教案诊断",
    icon: FilePenLine
  },
  {
    label: "陪我练习说课",
    prompt: "陪我练习说课，请先给我一份说课结构，再模拟评委追问。",
    trainingType: "说课陪练",
    icon: Mic
  },
  {
    label: "模拟课堂训练",
    prompt: "模拟一轮课堂提问，请围绕学生可能的回答连续追问。",
    trainingType: "模拟课堂",
    icon: MessageCircleQuestion
  },
  {
    label: "整理实习日志与反思",
    prompt: "帮我整理实习日志与反思，突出课堂观察、问题分析和改进计划。",
    trainingType: "实习反思",
    icon: NotebookPen
  }
];

const officeQuickTasks = [
  {
    label: "写一份工作总结",
    prompt: "帮我写一份本周工作总结，按完成事项、关键进展、问题与下周计划组织。",
    icon: NotebookPen
  },
  {
    label: "整理会议纪要",
    prompt: "帮我把会议内容整理成结构化纪要，包含结论、待办、负责人和截止时间。",
    icon: FileText
  },
  {
    label: "翻译并润色",
    prompt: "帮我把下面这段内容翻译成英文，并润色成适合对外沟通的表达。",
    icon: Languages
  },
  {
    label: "分析表格数据",
    prompt: "我会上传一份表格，请帮我分析趋势、异常和可执行的业务建议。",
    icon: Table2
  }
];

const defaultLessonPlanInput: LessonPlanInput = {
  subject: "语文",
  grade: "小学五年级",
  topic: "草船借箭",
  duration: "1课时",
  textbookContext: "统编版教材相关课文或教师提供的知识点",
  studentProfile: "学生具备基础阅读能力，但对文本人物形象、情节推进和历史语境的理解需要支架。",
  knowledgeBaseIds: [],
  skills: ["minimaxskill"]
};

const defaultInternshipReflectionInput: InternshipReflectionInput = {
  schoolClass: "教育实习班级",
  subjectTopic: "课堂观察与教学片段",
  internshipDate: "实习日期待补充",
  classroomSegment: "记录一次课堂导入、提问互动或学生练习反馈片段。",
  observationFocus: "关注学生参与、教师提问、课堂反馈和目标达成情况。",
  problems: "课堂观察中发现学生表达不够充分，教师追问和评价支架仍可优化。",
  personalFeeling: "作为实习教师，能够感受到真实课堂中教学设计与现场生成之间的差异。",
  improvementDirection: "下一次实习中准备提前设计问题链、观察记录表和分层反馈语。",
  knowledgeBaseIds: []
};

const lessonPlanGuidedSteps: Array<GuidedStep<LessonPlanInput>> = [
  {
    id: "subject",
    label: "学科",
    field: "subject",
    required: true,
    fallback: defaultLessonPlanInput.subject,
    agentName: "教材分析 Agent",
    question: "我是教案设计 Agent。我们一步步完成教案，先告诉我学科是什么？"
  },
  {
    id: "grade",
    label: "年级/学段",
    field: "grade",
    required: true,
    fallback: defaultLessonPlanInput.grade,
    agentName: "学情分析 Agent",
    question: "好的。这个教案面向哪个年级或学段？"
  },
  {
    id: "topic",
    label: "课题",
    field: "topic",
    required: true,
    fallback: defaultLessonPlanInput.topic,
    agentName: "目标设计 Agent",
    question: "这节课的课题或内容是什么？可以直接写课题名。"
  },
  {
    id: "duration",
    label: "课时",
    field: "duration",
    required: true,
    fallback: defaultLessonPlanInput.duration,
    agentName: "活动生成 Agent",
    question: "这节课计划用多长时间？例如 1 课时、40 分钟。"
  },
  {
    id: "textbookContext",
    label: "教材或知识点",
    field: "textbookContext",
    required: true,
    fallback: defaultLessonPlanInput.textbookContext,
    agentName: "教材分析 Agent",
    question: "请补充教材版本、单元位置或核心知识点。如果不清楚，可以回复“按默认”。"
  },
  {
    id: "studentProfile",
    label: "学情特点",
    field: "studentProfile",
    required: true,
    fallback: defaultLessonPlanInput.studentProfile,
    agentName: "学情分析 Agent",
    question: "学生已有基础和可能困难是什么？简单描述几句就可以。"
  },
  {
    id: "objectivePreference",
    label: "教学目标偏好",
    field: "objectivePreference",
    required: false,
    fallback: "强调核心素养、课堂活动和可评价的学习结果。",
    agentName: "目标设计 Agent",
    question: "你希望教学目标更突出哪一类？比如核心素养、考试能力、活动探究、学科育人。"
  },
  {
    id: "knowledgeBaseIds",
    label: "是否引用知识库",
    field: "knowledgeBaseIds",
    required: false,
    fallback: "不引用",
    agentName: "评价优化 Agent",
    question: "需要引用当前已选知识库资料吗？回复“需要”或“不需要”。"
  }
];

const reflectionGuidedSteps: Array<GuidedStep<InternshipReflectionInput>> = [
  {
    id: "internshipDate",
    label: "实习日期",
    field: "internshipDate",
    required: true,
    fallback: defaultInternshipReflectionInput.internshipDate,
    agentName: "课堂观察 Agent",
    question: "我是实习反思 Agent。我会先还原课堂事实，再帮你形成证据驱动的反思。请先告诉我实习日期。"
  },
  {
    id: "schoolClass",
    label: "实习学校/班级",
    field: "schoolClass",
    required: true,
    fallback: defaultInternshipReflectionInput.schoolClass,
    agentName: "课堂观察 Agent",
    question: "这次实习发生在哪个学校或班级？"
  },
  {
    id: "subjectTopic",
    label: "学科课题",
    field: "subjectTopic",
    required: true,
    fallback: defaultInternshipReflectionInput.subjectTopic,
    agentName: "课堂观察 Agent",
    question: "这节课的学科和课题是什么？"
  },
  {
    id: "classroomSegment",
    label: "课堂片段",
    field: "classroomSegment",
    required: true,
    fallback: defaultInternshipReflectionInput.classroomSegment,
    agentName: "证据整理 Agent",
    question: "请描述一个你印象最深的课堂片段，比如导入、提问、练习或学生反馈。"
  },
  {
    id: "observationFocus",
    label: "观察重点",
    field: "observationFocus",
    required: true,
    fallback: defaultInternshipReflectionInput.observationFocus,
    agentName: "问题诊断 Agent",
    question: "你这次主要想观察什么？例如学生参与、教师提问、课堂评价、目标达成。"
  },
  {
    id: "problems",
    label: "遇到的问题",
    field: "problems",
    required: true,
    fallback: defaultInternshipReflectionInput.problems,
    agentName: "问题诊断 Agent",
    question: "课堂中你发现了什么问题或值得反思的现象？"
  },
  {
    id: "personalFeeling",
    label: "个人感受",
    field: "personalFeeling",
    required: true,
    fallback: defaultInternshipReflectionInput.personalFeeling,
    agentName: "改进建议 Agent",
    question: "作为实习教师，你当时或课后最直接的感受是什么？"
  },
  {
    id: "improvementDirection",
    label: "希望改进方向",
    field: "improvementDirection",
    required: true,
    fallback: defaultInternshipReflectionInput.improvementDirection,
    agentName: "改进建议 Agent",
    question: "下一次你希望具体改进什么？最好写成能执行的动作。"
  },
  {
    id: "evidenceDecision",
    label: "课堂证据",
    field: "evidenceDecision",
    required: false,
    fallback: "本次暂不补充课堂证据。",
    agentName: "证据整理 Agent",
    question: "是否要上传课堂证据？可以现在上传图片/PDF/TXT，也可以回复“暂不上传”。"
  },
  {
    id: "knowledgeBaseIds",
    label: "是否引用知识库",
    field: "knowledgeBaseIds",
    required: false,
    fallback: "不引用",
    agentName: "文档生成 Agent",
    question: "需要引用当前已选知识库资料来优化专业表达吗？回复“需要”或“不需要”。"
  }
];

function createId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getStableHash(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function getGuidedThinkingDelayMs(messageId: string, content: string) {
  const normalizedContent = content.replace(/\s+/g, " ").trim();
  const contentLength = Array.from(normalizedContent).length;
  const seed = getStableHash(`${messageId}:${normalizedContent}`);
  const isSummary =
    normalizedContent.includes("信息摘要") ||
    normalizedContent.includes("素材摘要");
  const isKnowledgeBaseStep = normalizedContent.includes("知识库");
  const asksQuestion = /[？?]/.test(normalizedContent);
  const lengthDelay = Math.min(520, Math.round(contentLength * 4.2));
  const profileDelay = isSummary
    ? 640
    : isKnowledgeBaseStep
      ? 440
      : asksQuestion
        ? 260
        : 180;
  const jitter = (seed % 720) - 220;
  const tenthSecondOffset = (Math.floor(seed / 720) % 5) * 85;

  return Math.max(
    380,
    Math.min(1900, 240 + lengthDelay + profileDelay + jitter + tenthSecondOffset)
  );
}

function buildThinkingProgress(
  steps: GenerationThinkingStep[],
  activeIndex: number
): GenerationThinkingProgress {
  const boundedIndex = Math.min(Math.max(activeIndex, 0), steps.length - 1);

  return {
    steps,
    activeStepId: steps[boundedIndex]?.id || "",
    completedStepIds: steps.slice(0, boundedIndex).map((step) => step.id)
  };
}

function completeThinkingProgress(
  steps: GenerationThinkingStep[]
): GenerationThinkingProgress {
  return {
    steps,
    activeStepId: steps[steps.length - 1]?.id || "",
    completedStepIds: steps.map((step) => step.id)
  };
}

function normalizeStreamPhaseProgress(
  phase: StreamPhasePayload,
  fallbackSteps: GenerationThinkingStep[]
): GenerationThinkingProgress {
  const steps = phase.steps?.length ? phase.steps : fallbackSteps;
  const activeStepId =
    phase.activeStepId || phase.stepId || steps[0]?.id || "";

  return {
    steps,
    activeStepId,
    completedStepIds: phase.completedStepIds || []
  };
}

function getActiveThinkingStep(progress?: GenerationThinkingProgress) {
  if (!progress) {
    return undefined;
  }

  return progress.steps.find((step) => step.id === progress.activeStepId);
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDateTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatKnowledgeSource(source: KnowledgeSource) {
  if (source === "ima") {
    return "IMA";
  }

  if (source === "external") {
    return "外部";
  }

  return "本地";
}

function formatKnowledgeCount(base: KnowledgeBase) {
  return base.source === "ima"
    ? `${base.documentCount} 条内容`
    : `${base.documentCount} 个文档`;
}

function isKnowledgeBaseOverviewQuery(value: string) {
  const text = value.replace(/\s+/g, "").trim();

  return (
    /(这个|该|所选|当前|已选|此)?(知识库|资料库).*(有什么作用|有什么用|能做什么|里面有什么|包含什么|有哪些资料|有些什么|作用|用途)/.test(
      text
    ) ||
    /(有什么作用|有什么用|能做什么|里面有什么|包含什么|有哪些资料|有些什么|作用|用途).*(这个|该|所选|当前|已选|此)?(知识库|资料库)/.test(
      text
    )
  );
}

function createLessonPlanInput(
  patch: Partial<LessonPlanInput> = {}
): LessonPlanInput {
  return {
    ...defaultLessonPlanInput,
    ...patch,
    knowledgeBaseIds: patch.knowledgeBaseIds
      ? [...patch.knowledgeBaseIds]
      : [...defaultLessonPlanInput.knowledgeBaseIds],
    skills: patch.skills ? [...patch.skills] : [...defaultLessonPlanInput.skills]
  };
}

function getDefaultedLessonFields(input: LessonPlanInput) {
  return [
    ["学科", input.subject, defaultLessonPlanInput.subject],
    ["年级/学段", input.grade, defaultLessonPlanInput.grade],
    ["课题", input.topic, defaultLessonPlanInput.topic],
    ["课时", input.duration, defaultLessonPlanInput.duration],
    ["教材或知识点", input.textbookContext, defaultLessonPlanInput.textbookContext],
    ["学情特点", input.studentProfile, defaultLessonPlanInput.studentProfile]
  ]
    .filter(([, value, fallback]) => String(value).trim() === String(fallback).trim())
    .map(([label]) => label);
}

function createInternshipReflectionInput(
  patch: Partial<InternshipReflectionInput> = {}
): InternshipReflectionInput {
  return {
    ...defaultInternshipReflectionInput,
    ...patch,
    knowledgeBaseIds: patch.knowledgeBaseIds
      ? [...patch.knowledgeBaseIds]
      : [...defaultInternshipReflectionInput.knowledgeBaseIds]
  };
}

function getDefaultedReflectionFields(input: InternshipReflectionInput) {
  return [
    ["实习学校/班级", input.schoolClass, defaultInternshipReflectionInput.schoolClass],
    ["学科课题", input.subjectTopic, defaultInternshipReflectionInput.subjectTopic],
    ["实习日期", input.internshipDate, defaultInternshipReflectionInput.internshipDate],
    ["课堂片段", input.classroomSegment, defaultInternshipReflectionInput.classroomSegment],
    ["观察重点", input.observationFocus, defaultInternshipReflectionInput.observationFocus],
    ["遇到的问题", input.problems, defaultInternshipReflectionInput.problems],
    ["个人感受", input.personalFeeling, defaultInternshipReflectionInput.personalFeeling],
    [
      "希望改进的方向",
      input.improvementDirection,
      defaultInternshipReflectionInput.improvementDirection
    ]
  ]
    .filter(([, value, fallback]) => String(value).trim() === String(fallback).trim())
    .map(([label]) => label);
}

function isDefaultAnswer(text: string) {
  return /^(跳过|不知道|不清楚|按默认|默认|随便|都可以)$/i.test(text.trim());
}

function isAffirmativeAnswer(text: string) {
  return /需要|引用|使用|是|好|可以|要/.test(text);
}

function isNegativeAnswer(text: string) {
  return /不需要|不用|不要|否|暂不|不引用|不上传|没有/.test(text);
}

function resolveKnowledgeBaseChoice(answer: string, selectedBaseIds: string[]) {
  const cleanAnswer = answer.trim();

  if (isNegativeAnswer(cleanAnswer) || isDefaultAnswer(cleanAnswer)) {
    return {
      kind: "negative" as const,
      knowledgeBaseIds: [],
      message: "本次不引用知识库，将使用默认实训框架。"
    };
  }

  if (isAffirmativeAnswer(cleanAnswer)) {
    if (selectedBaseIds.length) {
      return {
        kind: "affirmative" as const,
        knowledgeBaseIds: selectedBaseIds,
        message: `已引用 ${selectedBaseIds.length} 个知识库，生成时会优先检索资料。`
      };
    }

    return {
      kind: "missing" as const,
      knowledgeBaseIds: [],
      message: "当前还没有选中知识库，请先点底部“知识库”选择，或回复“不需要”继续。"
    };
  }

  return {
    kind: "unclear" as const,
    knowledgeBaseIds: [],
    message: "请回复“需要”或“不需要”。如果选择“需要”，请先在底部“知识库”里勾选资料库。"
  };
}

function isGenerateCommand(text: string) {
  return /^(生成|开始生成|生成word|生成 Word|生成文档|导出|生成教案|生成实习反思)$/i.test(
    text.trim()
  );
}

function getNextGuidedQuestion<TInput>(
  steps: Array<GuidedStep<TInput>>,
  answeredStepIds: string[]
) {
  return steps.find((step) => !answeredStepIds.includes(step.id));
}

function buildCollectedSummary<TInput>(
  input: TInput,
  steps: Array<GuidedStep<TInput>>
) {
  return steps
    .filter((step) => step.field && step.field !== "evidenceDecision")
    .map((step) => {
      const value = step.field ? input[step.field as keyof TInput] : undefined;
      const text = Array.isArray(value) ? `${value.length} 个已选` : String(value || "未填写");
      return { label: step.label, value: text };
    });
}

function buildGuidedProgressText<TInput>(
  steps: Array<GuidedStep<TInput>>,
  answeredStepIds: string[]
) {
  return `${answeredStepIds.length}/${steps.length}`;
}

function formatGuidedReadyMessage<TInput>(
  input: TInput,
  steps: Array<GuidedStep<TInput>>,
  title: string
) {
  const summary = buildCollectedSummary(input, steps)
    .slice(0, 8)
    .map((item) => `- ${item.label}：${item.value}`)
    .join("\n");

  return `${title}\n${summary}\n\n我已整理好信息，回复“生成”即可生成 Word，也可以继续补充修改。`;
}

function createEvidenceAttachments(files: Attachment[]) {
  return files.map((attachment) => ({
    ...attachment,
    id: createId("evidence"),
    previewUrl:
      attachment.previewUrl ||
      (attachment.file.type.startsWith("image/")
        ? URL.createObjectURL(attachment.file)
        : undefined)
  }));
}

function applyLessonGuidedAnswer(
  state: LessonPlanState,
  step: GuidedStep<LessonPlanInput>,
  answer: string,
  selectedBaseIds: string[]
) {
  const useFallback = isDefaultAnswer(answer);
  const cleanAnswer = answer.trim();
  const value = useFallback ? step.fallback || "" : cleanAnswer;
  const nextInput = { ...state.input };

  if (step.field === "knowledgeBaseIds") {
    nextInput.knowledgeBaseIds = resolveKnowledgeBaseChoice(
      cleanAnswer,
      selectedBaseIds
    ).knowledgeBaseIds;
  } else if (step.field === "objectivePreference") {
    const preference = value || step.fallback || "";
    nextInput.textbookContext = `${nextInput.textbookContext}\n教学目标偏好：${preference}`.trim();
  } else if (step.field) {
    nextInput[step.field as keyof LessonPlanInput] = value as never;
  }

  return nextInput;
}

function applyReflectionGuidedAnswer(
  state: InternshipReflectionState,
  step: GuidedStep<InternshipReflectionInput>,
  answer: string,
  selectedBaseIds: string[],
  evidenceFiles: Attachment[]
) {
  const useFallback = isDefaultAnswer(answer);
  const cleanAnswer = answer.trim();
  const value = useFallback ? step.fallback || "" : cleanAnswer;
  const nextInput = { ...state.input };
  const nextEvidenceFiles = [...state.evidenceFiles, ...createEvidenceAttachments(evidenceFiles)];
  let status = state.status;

  if (step.field === "knowledgeBaseIds") {
    nextInput.knowledgeBaseIds =
      isAffirmativeAnswer(cleanAnswer) && !isNegativeAnswer(cleanAnswer)
        ? selectedBaseIds
        : [];
  } else if (step.field === "evidenceDecision") {
    status = nextEvidenceFiles.length
      ? `已收到 ${nextEvidenceFiles.length} 份课堂证据。`
      : "本次暂不补充课堂证据。";
  } else if (step.field) {
    nextInput[step.field as keyof InternshipReflectionInput] = value as never;
  }

  return { input: nextInput, evidenceFiles: nextEvidenceFiles, status };
}

function getActiveGuidedMessage(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => {
    const lessonState = message.lessonPlanState;
    const reflectionState = message.internshipReflectionState;

    return (
      (lessonState?.collectionMode === "guided" &&
        lessonState.phase === "collecting" &&
        !lessonState.isReadyToGenerate &&
        message.status !== "generating") ||
      (reflectionState?.collectionMode === "guided" &&
        reflectionState.phase === "collecting" &&
        !reflectionState.isReadyToGenerate &&
        message.status !== "generating")
    );
  });
}

function getReadyGuidedMessage(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => {
    const lessonState = message.lessonPlanState;
    const reflectionState = message.internshipReflectionState;

    return (
      (lessonState?.collectionMode === "guided" &&
        lessonState.phase === "collecting" &&
        lessonState.isReadyToGenerate &&
        message.status !== "generating") ||
      (reflectionState?.collectionMode === "guided" &&
        reflectionState.phase === "collecting" &&
        reflectionState.isReadyToGenerate &&
        message.status !== "generating")
    );
  });
}

function getLessonPlanWeaknesses(diagnostic?: LessonPlanDiagnostic) {
  if (!diagnostic) {
    return [];
  }

  return [...diagnostic.dimensions]
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map((dimension) => dimension.name);
}

function getReflectionWeaknesses(diagnostic?: InternshipReflectionDiagnostic) {
  if (!diagnostic) {
    return [];
  }

  return [...diagnostic.dimensions]
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map((dimension) => dimension.name);
}

function buildReflectionEvidenceChains(draft?: InternshipReflectionDraft) {
  if (!draft) {
    return [];
  }

  const problemText =
    draft.sections.find((section) => /问题分析|问题诊断/.test(section.heading))?.body ||
    draft.input.problems;
  const actionSection = draft.sections.find((section) =>
    /改进策略|改进计划|后续行动/.test(section.heading)
  );
  const actionText =
    actionSection?.bullets?.[0] || actionSection?.body || draft.input.improvementDirection;

  return draft.evidence.slice(0, 5).map((item, index) => ({
    id: item.id || `reflection-chain-${index}`,
    source: item.name,
    evidence: item.summary,
    diagnosis:
      item.observationPoints[0] ||
      (problemText.length > 92 ? `${problemText.slice(0, 92)}...` : problemText),
    action: actionText.length > 92 ? `${actionText.slice(0, 92)}...` : actionText
  }));
}

function isLessonPlanWizardRequest(text: string) {
  return /教案|教学设计|生成.*课|设计.*课/.test(text);
}

function isInternshipReflectionWizardRequest(text: string) {
  return /实习|反思|日志|课堂观察|听课记录/.test(text);
}

function inferLessonPlanPatchFromPrompt(text: string): Partial<LessonPlanInput> {
  const bracketTopic = text.match(/《([^》]{1,32})》/);
  const topicLabel = text.match(/(?:课题|主题|内容)[：:]\s*([^\s，。；;]{1,32})/);
  const subject = text.match(/(语文|数学|英语|科学|历史|地理|物理|化学|生物|道德与法治|音乐|美术|体育)/)?.[1];
  const grade = text.match(/(小学|初中|高中)?[一二三四五六七八九十\d]+年级/)?.[0];

  return {
    ...(subject ? { subject } : {}),
    ...(grade ? { grade } : {}),
    ...(bracketTopic?.[1] || topicLabel?.[1]
      ? { topic: bracketTopic?.[1] || topicLabel?.[1] }
      : {})
  };
}

function inferInternshipReflectionPatchFromPrompt(
  text: string
): Partial<InternshipReflectionInput> {
  const subjectTopic = text.match(/(?:课题|主题|内容)[：:]\s*([^\n，。；;]{1,36})/)?.[1];
  const date = text.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/)?.[0];

  return {
    ...(subjectTopic ? { subjectTopic } : {}),
    ...(date ? { internshipDate: date.replace(/[年月/]/g, "-").replace(/日$/, "") } : {}),
    classroomSegment: text.length > 12 ? text : defaultInternshipReflectionInput.classroomSegment
  };
}

function buildLessonPlanThinkingSummary(message?: ChatMessage) {
  const state = message?.lessonPlanState;

  if (!state) {
    return "";
  }

  if (state.collectionMode === "guided" && state.phase === "collecting") {
    const answeredCount = state.answeredStepIds?.length || 0;
    const currentStep = lessonPlanGuidedSteps.find((step) => step.id === state.currentStepId);

    return [
      "我先把教案生成拆成连续追问，而不是一次性让用户填表。",
      `已经确认 ${answeredCount} 项课程信息，当前重点是${state.isReadyToGenerate ? "把信息收束成可生成的教案上下文" : `由 ${currentStep?.agentName || "教案设计 Agent"}确认「${currentStep?.label || "下一项信息"}」`}。`,
      "等关键信息齐了，再调用教案生成接口并导出 Word。"
    ].join("\n");
  }

  const defaultedFields = getDefaultedLessonFields(state.input);
  const steps = [
    `1. 信息采集：已读取「${state.input.subject} / ${state.input.grade} / ${state.input.topic || "默认课题"}」等课程信息。`,
    `2. 信息补全：${defaultedFields.length ? `使用演示默认值补齐 ${defaultedFields.join("、")}，后续仍可重新填写。` : "用户提供的信息较完整，未明显依赖默认补齐。"}`,
    `3. 知识检索：${state.input.knowledgeBaseIds.length ? `已选择 ${state.input.knowledgeBaseIds.length} 个知识库，生成时优先引用课程标准、课例或教材片段。` : "未选择知识库，本次使用通用师范生实训框架。"}`,
    `4. 结构生成：围绕教学目标、学情分析、教学过程、课堂提问、板书、作业和师德育人融入点组织教案。`,
    `5. 诊断导出：${state.diagnostic ? `完成 ${state.diagnostic.overallScore} 分诊断，并生成 Word 成果。` : "生成完成后会自动评分并准备 Word 成果。"}`
  ];

  return steps.join("\n");
}

function buildInternshipReflectionThinkingSummary(message?: ChatMessage) {
  const state = message?.internshipReflectionState;

  if (!state) {
    return "";
  }

  if (state.collectionMode === "guided" && state.phase === "collecting") {
    const answeredCount = state.answeredStepIds?.length || 0;
    const currentStep = reflectionGuidedSteps.find((step) => step.id === state.currentStepId);

    return [
      "我先还原课堂事实，再追问证据和改进方向，避免直接生成空泛反思。",
      `已经确认 ${answeredCount} 项实习素材，当前重点是${state.isReadyToGenerate ? "把课堂事实、问题和证据链收束成反思素材" : `由 ${currentStep?.agentName || "实习反思 Agent"}确认「${currentStep?.label || "下一项信息"}」`}。`,
      "等素材齐了，再生成 Word，并把结果保存到历史记录和成长档案。"
    ].join("\n");
  }

  const defaultedFields = getDefaultedReflectionFields(state.input);
  const steps = [
    `1. 信息采集：已读取「${state.input.schoolClass} / ${state.input.subjectTopic} / ${state.input.internshipDate}」等实习信息。`,
    `2. 证据整理：${state.evidenceFiles.length || state.evidence.length ? `已接收 ${state.evidenceFiles.length || state.evidence.length} 份图片或材料证据，用于提取课堂观察点。` : "暂未上传图片证据，将使用文本信息生成反思。"}`,
    `3. 信息补全：${defaultedFields.length ? `使用演示默认值补齐 ${defaultedFields.join("、")}，后续仍可重新填写。` : "用户提供的信息较完整，未明显依赖默认补齐。"}`,
    `4. 反思建模：按“观察证据—问题诊断—原因分析—改进行动—师德育人”组织报告。`,
    `5. 成果归档：${state.diagnostic ? `完成 ${state.diagnostic.overallScore} 分诊断，并生成 Word 反思报告。` : "生成完成后会自动评分、保存历史并计入成长报告。"}`
  ];

  return steps.join("\n");
}

function formatProviderStatus(status: KnowledgeProviderStatus) {
  const labels: Record<KnowledgeProviderStatus, string> = {
    connected: "已连接",
    not_configured: "未配置",
    error: "连接失败",
    syncing: "同步中"
  };

  return labels[status];
}

function getFileExtension(fileName: string) {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

function isSupportedAttachment(file: File) {
  return SUPPORTED_ATTACHMENT_EXTENSIONS.has(getFileExtension(file.name));
}

function hasInsight(message: ChatMessage) {
  return Boolean(
    message.thinkingEnabled ||
      message.thinkingText ||
      message.thinkingSeconds ||
      message.artifacts?.length ||
      message.lessonPlanState ||
      message.internshipReflectionState
  );
}

function isStructuredTaskThinkingInProgress(message: ChatMessage) {
  return Boolean(
    message.status === "generating" &&
      message.thinkingEnabled &&
      (message.lessonPlanState || message.internshipReflectionState)
  );
}

function getStructuredTaskThinkingSeconds(
  message: ChatMessage,
  currentTime: number
) {
  return Math.max(
    0,
    (currentTime - (message.thinkingStartedAt || currentTime)) / 1000
  );
}

function getInsightLabel(message: ChatMessage, currentTime: number) {
  if (isStructuredTaskThinkingInProgress(message)) {
    return `思考中・${getStructuredTaskThinkingSeconds(message, currentTime).toFixed(1)}s`;
  }

  if (
    (message.lessonPlanState || message.internshipReflectionState) &&
    typeof message.thinkingSeconds === "number"
  ) {
    return `思考耗时・${message.thinkingSeconds.toFixed(1)}s`;
  }

  if (
    message.internshipReflectionState?.phase === "generating" ||
    message.internshipReflectionState?.phase === "refining"
  ) {
    return "生成反思中";
  }

  if (
    message.lessonPlanState?.phase === "generating" ||
    message.lessonPlanState?.phase === "refining"
  ) {
    return "生成教案中";
  }

  if (message.status === "generating" && message.thinkingEnabled) {
    const elapsedSeconds =
      message.thinkingSeconds ??
      Math.max(
        0,
        ((message.thinkingStartedAt ? currentTime - message.thinkingStartedAt : 0) /
          1000)
      );

    return `思考 ${elapsedSeconds.toFixed(1)}s`;
  }

  if (message.thinkingSeconds) {
    return `思考 ${message.thinkingSeconds.toFixed(1)}s`;
  }

  if (message.lessonPlanState?.phase === "collecting") {
    return "思考过程";
  }

  if (message.internshipReflectionState?.phase === "collecting") {
    return "思考过程";
  }

  if (message.internshipReflectionState?.draft) {
    return "查看反思";
  }

  if (message.lessonPlanState?.draft) {
    return "查看教案";
  }

  if (message.artifacts?.length) {
    return "查看文件";
  }

  return "无思考过程";
}

function getThinkingToggleStyle(message: ChatMessage, currentTime: number) {
  if (isStructuredTaskThinkingInProgress(message)) {
    return { minWidth: "132px" };
  }

  if (!(message.status === "generating" && message.thinkingEnabled)) {
    return undefined;
  }

  const elapsedSeconds = Math.max(
    0,
    (currentTime - (message.thinkingStartedAt || currentTime)) / 1000
  );
  const width = Math.min(124, 88 + elapsedSeconds * 7);

  return { minWidth: `${width}px` };
}

function summarizeThinkingText(message?: ChatMessage) {
  const reflectionThinking = buildInternshipReflectionThinkingSummary(message);

  if (reflectionThinking) {
    return reflectionThinking;
  }

  const lessonThinking = buildLessonPlanThinkingSummary(message);

  if (lessonThinking) {
    return lessonThinking;
  }

  const cleanedText = message?.thinkingText
    ?.replace(/<artifacts_json>[\s\S]*?<\/artifacts_json>/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanedText) {
    return "";
  }

  const prompt = message?.sourcePrompt?.trim();
  const topic = detectThinkingTopic(`${prompt || ""} ${cleanedText}`);
  const outputShape = detectThinkingOutputShape(`${prompt || ""} ${cleanedText}`);
  const highlights = extractThinkingHighlights(cleanedText);
  const promptLine = prompt
    ? `围绕「${truncateText(prompt, 34)}」，模型主要把它判断为${topic}相关任务，并把回答收束到${outputShape}。`
    : `模型主要把本次请求判断为${topic}相关任务，并把回答收束到${outputShape}。`;

  if (!highlights.length) {
    return promptLine;
  }

  const detailLine =
    highlights.length === 1
      ? `关键考虑是：${highlights[0]}。`
      : `关键考虑集中在：${highlights.slice(0, 3).join("；")}。`;

  return `${promptLine}\n\n${detailLine}`;
}

function extractThinkingHighlights(text: string) {
  const genericPatterns = [
    /用户|需要|应该|回答|任务|问题|内容|提供|生成|思考/g,
    /I need|we need|the user|answer|response/gi
  ];

  return text
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map((sentence) =>
      sentence
        .replace(/^[\s\-*序号\d.、:：]+/, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((sentence) => sentence.length >= 10)
    .map((sentence) => truncateText(sentence, 58))
    .filter((sentence, index, sentences) => {
      const normalized = sentence.replace(/[，。！？,.!?;；]/g, "");
      const signalText = genericPatterns.reduce(
        (value, pattern) => value.replace(pattern, ""),
        normalized
      );

      return signalText.length >= 6 && sentences.indexOf(sentence) === index;
    })
    .slice(0, 3);
}

function truncateText(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function detectThinkingTopic(text: string) {
  if (/课堂观察/.test(text)) {
    return "课堂观察";
  }

  if (/教案|教学设计/.test(text)) {
    return "教案设计";
  }

  if (/说课/.test(text)) {
    return "说课训练";
  }

  if (/实习|反思|日志/.test(text)) {
    return "实习反思";
  }

  if (/PPT|汇报|幻灯片/.test(text)) {
    return "汇报材料";
  }

  if (/文件|Markdown|Word|docx|pptx/.test(text)) {
    return "文件生成";
  }

  return "当前教学任务";
}

function detectThinkingOutputShape(text: string) {
  if (/两句话|一句话|简洁|简短/.test(text)) {
    return "简短表达";
  }

  if (/文件|Markdown|Word|docx|PPT|pptx/.test(text)) {
    return "可下载文件";
  }

  if (/步骤|结构|流程/.test(text)) {
    return "清晰步骤";
  }

  return "清晰结构";
}

function Conversation({
  messages,
  activeInsightMessageId,
  knowledgeBases,
  onDownloadLessonPlan,
  onDownloadReflection,
  onOpenLessonPreview,
  onOpenReflectionPreview,
  onRefineLessonPlan,
  onRefineReflection,
  onResetLessonPlan,
  onResetReflection,
  onSubmitLessonPlan,
  onSubmitReflection,
  onAttachReflectionEvidence,
  onRemoveReflectionEvidence,
  onToggleLessonPlanKnowledgeBase,
  onToggleReflectionKnowledgeBase,
  onToggleThinking,
  onUpdateLessonPlanInput,
  onUpdateReflectionInput
}: {
  messages: ChatMessage[];
  activeInsightMessageId?: string;
  knowledgeBases: KnowledgeBase[];
  onDownloadLessonPlan: (messageId: string) => void;
  onDownloadReflection: (messageId: string) => void;
  onOpenLessonPreview: (messageId: string) => void;
  onOpenReflectionPreview: (messageId: string) => void;
  onRefineLessonPlan: (messageId: string) => void;
  onRefineReflection: (messageId: string) => void;
  onResetLessonPlan: (messageId: string) => void;
  onResetReflection: (messageId: string) => void;
  onSubmitLessonPlan: (messageId: string) => void;
  onSubmitReflection: (messageId: string) => void;
  onAttachReflectionEvidence: (messageId: string, files: FileList | null) => void;
  onRemoveReflectionEvidence: (messageId: string, attachmentId: string) => void;
  onToggleLessonPlanKnowledgeBase: (messageId: string, baseId: string) => void;
  onToggleReflectionKnowledgeBase: (messageId: string, baseId: string) => void;
  onToggleThinking: (messageId: string) => void;
  onUpdateLessonPlanInput: (
    messageId: string,
    patch: Partial<LessonPlanInput>
  ) => void;
  onUpdateReflectionInput: (
    messageId: string,
    patch: Partial<InternshipReflectionInput>
  ) => void;
}) {
  const conversationRef = useRef<HTMLElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => Date.now());

  function isNearConversationBottom(element: HTMLElement) {
    return element.scrollHeight - element.scrollTop - element.clientHeight < 96;
  }

  useEffect(() => {
    const hasActiveThinking = messages.some(
      (message) => message.status === "generating" && message.thinkingEnabled
    );

    if (!hasActiveThinking) {
      return;
    }

    setCurrentTime(Date.now());
    const intervalId = window.setInterval(() => {
      setCurrentTime(Date.now());
    }, 100);

    return () => window.clearInterval(intervalId);
  }, [messages]);

  useEffect(() => {
    const conversation = conversationRef.current;

    if (!conversation) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (shouldAutoScrollRef.current || isNearConversationBottom(conversation)) {
        conversation.scrollTop = conversation.scrollHeight;
        shouldAutoScrollRef.current = true;
        setShowScrollToBottom(false);
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [messages]);

  if (messages.length === 0) {
    return null;
  }

  return (
    <section className="conversation-shell" aria-label="对话内容">
      <section
        className="conversation"
        ref={conversationRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          const nearBottom = isNearConversationBottom(target);

          shouldAutoScrollRef.current = nearBottom;
          setShowScrollToBottom(!nearBottom);
        }}
      >
        {messages.map((message) => (
        <article
          className={`message message-${message.role}`}
          key={message.id}
        >
          <div
            className={`message-bubble ${
              message.role === "assistant" && hasInsight(message)
                ? "message-bubble-with-insight"
                : ""
            }`}
          >
            {message.role === "assistant" && hasInsight(message) ? (
              <button
                className={`message-thought-toggle ${
                  activeInsightMessageId === message.id
                    ? "message-thought-toggle-active"
                    : ""
                } ${
                  message.status === "generating"
                    ? "message-thought-toggle-generating"
                    : ""
                }`}
                type="button"
                aria-expanded={activeInsightMessageId === message.id}
                aria-label={`${getInsightLabel(message, currentTime)}：展开或收起思考过程与生成文件`}
                title="展开思考过程与生成文件"
                style={getThinkingToggleStyle(message, currentTime)}
                onClick={() => onToggleThinking(message.id)}
              >
                <Brain size={15} strokeWidth={2.2} />
                <span>{getInsightLabel(message, currentTime)}</span>
                {!isStructuredTaskThinkingInProgress(message) ? (
                  <ChevronRight size={15} strokeWidth={2.4} />
                ) : null}
              </button>
            ) : null}
            {message.role === "assistant" &&
            (message.agentName || message.traceAgents?.length || message.toolNotes?.length) ? (
              <div className="message-meta" aria-label="回答来源">
                {message.agentName ? (
                  <span className="message-agent-tag">
                    <AgentAvatar
                      name={message.agentName}
                      avatar={message.agentAvatar}
                      size={20}
                    />
                    {message.agentName}
                    {message.durationMs ? (
                      <small>{formatDuration(message.durationMs)}</small>
                    ) : null}
                  </span>
                ) : null}
                {message.traceAgents?.map((agent, index) => (
                  <span
                    className={`message-agent-row is-${agent.kind}`}
                    key={`trace-${index}`}
                    title={
                      agent.kind === "subworkflow"
                        ? `子流程：${agent.name}`
                        : agent.kind === "llm"
                          ? `模型节点：${agent.name}`
                          : `智能体：${agent.name}`
                    }
                  >
                    <Bot size={11} strokeWidth={2.2} />
                    <span>{agent.name}</span>
                    {agent.durationMs ? (
                      <small>{(agent.durationMs / 1000).toFixed(1)}s</small>
                    ) : null}
                  </span>
                ))}
                {message.toolNotes
                  // 转交已经体现在署名上，不再单独显示一条「转交给 XX」的过程条。
                  ?.filter((note) => note.kind !== "delegation")
                  .map((note, index) => (
                    <span
                      className={`message-tool-row is-${note.stage} ${
                        note.ok === false ? "is-failed" : ""
                      }`}
                      key={`${note.toolId}-${index}`}
                      title={note.summary ?? note.name}
                    >
                      <Wrench size={12} strokeWidth={2.2} />
                      <span>{toolLabelOf(note)}</span>
                      <small>
                        {note.stage === "running"
                          ? "执行中"
                          : note.stage === "skipped"
                            ? "未调用"
                            : note.ok === false
                              ? "执行失败"
                              : note.latencyMs
                                ? `工具执行 · ${(note.latencyMs / 1000).toFixed(3)}s`
                                : "工具执行"}
                      </small>
                    </span>
                  ))}
              </div>
            ) : null}
            {message.lessonPlanState && message.lessonPlanState.phase !== "collecting" ? (
              <LessonPlanMessageCard
                knowledgeBases={knowledgeBases}
                message={message}
                onDownload={() => onDownloadLessonPlan(message.id)}
                onOpenPreview={() => onOpenLessonPreview(message.id)}
                onRefine={() => onRefineLessonPlan(message.id)}
                onReset={() => onResetLessonPlan(message.id)}
                onSubmit={() => onSubmitLessonPlan(message.id)}
                onToggleKnowledgeBase={(baseId) =>
                  onToggleLessonPlanKnowledgeBase(message.id, baseId)
                }
                onUpdateInput={(patch) =>
                  onUpdateLessonPlanInput(message.id, patch)
                }
              />
            ) : message.internshipReflectionState &&
              message.internshipReflectionState.phase !== "collecting" ? (
              <InternshipReflectionMessageCard
                knowledgeBases={knowledgeBases}
                message={message}
                onAttachEvidence={(files) =>
                  onAttachReflectionEvidence(message.id, files)
                }
                onDownload={() => onDownloadReflection(message.id)}
                onOpenPreview={() => onOpenReflectionPreview(message.id)}
                onRefine={() => onRefineReflection(message.id)}
                onRemoveEvidence={(attachmentId) =>
                  onRemoveReflectionEvidence(message.id, attachmentId)
                }
                onReset={() => onResetReflection(message.id)}
                onSubmit={() => onSubmitReflection(message.id)}
                onToggleKnowledgeBase={(baseId) =>
                  onToggleReflectionKnowledgeBase(message.id, baseId)
                }
                onUpdateInput={(patch) => onUpdateReflectionInput(message.id, patch)}
              />
            ) : message.evaluation?.trainingType === "模拟课堂" ? (
              <ClassroomRecordCard message={message} />
            ) : (
              <MessageMarkdown
                text={
                  message.content ||
                  (message.status === "generating" ? "正在生成..." : "")
                }
              />
            )}
            {message.attachments?.length ? (
              <div className="message-attachments">
                {message.attachments.map((attachment) => (
                  <span className="message-file" key={attachment.id}>
                    <FileText size={15} strokeWidth={2} />
                    {attachment.name}
                  </span>
                ))}
              </div>
            ) : null}
            {message.role === "assistant" && message.artifacts?.length ? (
              <div className="message-artifacts" aria-label="生成文件">
                {message.artifacts.map((artifact) => (
                  <a
                    className="message-artifact"
                    href={artifact.url}
                    key={artifact.id}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FileText size={16} strokeWidth={2.1} />
                    <span>{artifact.name}</span>
                    <small>{artifact.type.toUpperCase()}</small>
                  </a>
                ))}
              </div>
            ) : null}
            {message.role === "assistant" && message.knowledgeBaseIds?.length ? (
              <div className="message-knowledge-status" aria-live="polite">
                <Database size={15} strokeWidth={2.1} />
                <span>
                  {message.knowledgeQueryMode === "overview"
                    ? `已读取 ${message.knowledgeBaseIds.length} 个已选知识库的真实资料信息。`
                    : message.citations?.length
                      ? `已引用 ${message.citations.length} 条资料：${[
                          ...new Set(
                            message.citations
                              .slice(0, 3)
                              .map((citation) => citation.documentName)
                          )
                        ].join("、")}`
                      : "已启用知识库，但本题未找到相关资料；以下为通用回答。"}
                </span>
              </div>
            ) : null}
            {message.role === "assistant" && message.citations?.length ? (
              <div className="message-citations" aria-label="引用来源">
                <div className="message-citations-title">
                  <Layers3 size={15} strokeWidth={2.1} />
                  <span>引用来源</span>
                </div>
                {message.citations.slice(0, 3).map((citation) => (
                  <details className="message-citation" key={citation.id}>
                    <summary>
                      <span>{citation.documentName}</span>
                      <small>{citation.knowledgeBaseName}</small>
                    </summary>
                    <p>{citation.snippet}</p>
                  </details>
                ))}
              </div>
            ) : null}
          </div>
        </article>
        ))}
      </section>
      {showScrollToBottom ? (
        <button
          className="scroll-bottom-button"
          type="button"
          onClick={() => {
            const conversation = conversationRef.current;

            if (!conversation) {
              return;
            }

            shouldAutoScrollRef.current = true;
            conversation.scrollTop = conversation.scrollHeight;
            setShowScrollToBottom(false);
          }}
        >
          <ChevronRight size={15} strokeWidth={2.4} />
          回到底部
        </button>
      ) : null}
    </section>
  );
}

function GenerationThinkingPanel({
  progress,
  streamText,
  fallbackLabel,
  fallbackDetail
}: {
  progress?: GenerationThinkingProgress;
  streamText?: string;
  fallbackLabel: string;
  fallbackDetail: string;
}) {
  const steps =
    progress?.steps.length
      ? progress.steps
      : [{ id: "fallback", label: fallbackLabel, detail: fallbackDetail }];
  const activeStep = getActiveThinkingStep(progress) || steps[0];
  const completedStepIds = new Set(progress?.completedStepIds || []);
  const completedCount = progress
    ? progress.completedStepIds.length
    : 0;
  const progressPercent = Math.max(
    8,
    Math.round((completedCount / Math.max(steps.length, 1)) * 100)
  );

  return (
    <section className="generation-thinking-panel" aria-label="生成思考过程">
      <header>
        <div>
          <span>可解释生成过程</span>
          <strong>{activeStep.label}</strong>
        </div>
        <small>{completedCount}/{steps.length}</small>
      </header>
      <p>{activeStep.detail}</p>
      <div className="generation-thinking-track" aria-hidden="true">
        <i style={{ width: `${progressPercent}%` }} />
      </div>
      {streamText?.trim() ? (
        <pre className="generation-stream-preview">
          {streamText.trim().slice(-900)}
        </pre>
      ) : null}
      <ol>
        {steps.map((step) => {
          const isActive = step.id === activeStep.id;
          const isDone = completedStepIds.has(step.id);

          return (
            <li
              className={`${isActive ? "generation-step-active" : ""} ${
                isDone ? "generation-step-done" : ""
              }`}
              key={step.id}
            >
              <span>
                {isDone ? (
                  <Check size={13} strokeWidth={2.6} />
                ) : isActive ? (
                  <Clock3 size={13} strokeWidth={2.4} />
                ) : null}
              </span>
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function LessonPlanMessageCard({
  knowledgeBases,
  message,
  onDownload,
  onOpenPreview,
  onRefine,
  onReset,
  onSubmit,
  onToggleKnowledgeBase,
  onUpdateInput
}: {
  knowledgeBases: KnowledgeBase[];
  message: ChatMessage;
  onDownload: () => void;
  onOpenPreview: () => void;
  onRefine: () => void;
  onReset: () => void;
  onSubmit: () => void;
  onToggleKnowledgeBase: (baseId: string) => void;
  onUpdateInput: (patch: Partial<LessonPlanInput>) => void;
}) {
  const state = message.lessonPlanState;

  if (!state) {
    return null;
  }

  const isBusy = state.phase === "generating" || state.phase === "refining";
  const isGenerated = state.phase === "generated" && state.draft;
  const weaknesses = getLessonPlanWeaknesses(state.diagnostic);
  const answeredStepIds = state.answeredStepIds || [];
  const currentStep =
    lessonPlanGuidedSteps.find((step) => step.id === state.currentStepId) ||
    lessonPlanGuidedSteps[0];
  const answeredSet = new Set(answeredStepIds);
  const collectedSummary = buildCollectedSummary(state.input, lessonPlanGuidedSteps).filter(
    (item) =>
      lessonPlanGuidedSteps.some(
        (step) => step.label === item.label && answeredSet.has(step.id)
      )
  );

  return (
    <section className="lesson-chat-card" aria-label="教案生成向导">
      <header className="lesson-chat-header">
        <div>
          <span>{isGenerated ? `教案成果 V${state.version}` : "教案设计 Agent"}</span>
          <h3>{state.draft?.title || "一问一答生成 Word 教案"}</h3>
        </div>
        {isBusy ? <small>处理中...</small> : null}
      </header>

      {isBusy ? (
        <GenerationThinkingPanel
          progress={state.thinkingProgress}
          streamText={message.content}
          fallbackLabel={state.status || "正在生成教案..."}
          fallbackDetail="教案设计 Agent 正在整理课程信息、证据来源、诊断维度和可导出成果。"
        />
      ) : isGenerated && state.draft ? (
        <div className="lesson-result-card">
          <div className="lesson-result-summary">
            <strong>{state.diagnostic?.overallScore ?? "--"}</strong>
            <span>诊断总分</span>
            <p>
              {state.citations.length
                ? `已引用 ${state.citations.length} 条知识库片段`
                : "未引用知识库资料，使用默认实训框架生成"}
            </p>
          </div>
          <div className="lesson-result-meta">
            <p>{state.draft.sourceNote}</p>
            {weaknesses.length ? (
              <div>
                <span>薄弱项</span>
                {weaknesses.map((item) => (
                  <small key={item}>{item}</small>
                ))}
              </div>
            ) : null}
            {state.artifact ? (
              <a
                className="lesson-artifact-inline"
                href={state.artifact.url}
                target="_blank"
                rel="noreferrer"
              >
                <FileText size={16} strokeWidth={2.1} />
                {state.artifact.name}
              </a>
            ) : (
              <span className="lesson-artifact-inline">Word 文件准备中</span>
            )}
          </div>
          {state.comparison ? (
            <LessonPlanComparisonPanel compact comparison={state.comparison} />
          ) : null}
          <div className="training-next-step">
            <span>下一步</span>
            <strong>{weaknesses.length ? "先按诊断建议优化" : "预览并下载成果"}</strong>
            <p>
              {state.artifact
                ? "可查看完整预览、下载 Word；若要进入主演示下一环节，继续在新对话中发起说课陪练。"
                : "教案内容已生成，Word 文件还在等待导出；可先预览内容，稍后再下载。"}
            </p>
          </div>
          <div className="lesson-chat-actions">
            <button type="button" onClick={onOpenPreview}>
              <FileText size={16} strokeWidth={2.2} />
              查看完整预览
            </button>
            <button type="button" onClick={onRefine} disabled={isBusy}>
              <RotateCcw size={16} strokeWidth={2.2} />
              按建议优化
            </button>
            <button type="button" onClick={onReset} disabled={isBusy}>
              <FilePenLine size={16} strokeWidth={2.2} />
              重新填写
            </button>
            <button type="button" onClick={onDownload} disabled={!state.artifact}>
              <Download size={16} strokeWidth={2.2} />
              下载 Word
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="lesson-chat-intro">
            {state.isReadyToGenerate
              ? "课程设计链已经整理完成。回复“生成”或点击按钮，我会生成可预览和下载的 Word 教案。"
              : state.pendingQuestion || currentStep.question}
          </p>
          <div className="guided-agent-flow" aria-label="教案设计智能体链路">
            {["教材分析 Agent", "学情分析 Agent", "目标设计 Agent", "活动生成 Agent", "评价优化 Agent"].map(
              (agent) => (
                <span
                  className={agent === currentStep.agentName ? "guided-agent-active" : ""}
                  key={agent}
                >
                  {agent}
                </span>
              )
            )}
          </div>
          <section className="guided-progress-panel" aria-label="教案采集进度">
            <div>
              <span>采集进度</span>
              <strong>{buildGuidedProgressText(lessonPlanGuidedSteps, answeredStepIds)}</strong>
            </div>
            <div className="dimension-track">
              <i
                style={{
                  width: `${(answeredStepIds.length / lessonPlanGuidedSteps.length) * 100}%`
                }}
              />
            </div>
            <p>
              当前由 {state.isReadyToGenerate ? "评价优化 Agent" : currentStep.agentName}
              处理。请直接在底部输入框回答，回复“跳过”可使用默认值。
            </p>
          </section>
          <div className="guided-summary-list" aria-label="已收集教案信息">
            {collectedSummary.length ? (
              collectedSummary.map((item) => (
                <article key={item.label}>
                  <span>{item.label}</span>
                  <p>{item.value}</p>
                </article>
              ))
            ) : (
              <p>还没有收集到课程信息，回答第一个问题后会在这里沉淀摘要。</p>
            )}
          </div>
          {state.isReadyToGenerate ? (
            <div className="guided-ready-note">
              <pre>{message.content}</pre>
            </div>
          ) : null}
          {state.status ? <p className="lesson-chat-status">{state.status}</p> : null}
          <div className="lesson-chat-actions">
            <button
              className="lesson-chat-primary"
              type="button"
              disabled={isBusy || !state.isReadyToGenerate}
              onClick={onSubmit}
            >
              <FilePenLine size={16} strokeWidth={2.2} />
              {isBusy ? "正在生成..." : "生成 Word 教案"}
            </button>
            <button type="button" disabled={isBusy} onClick={onReset}>
              <RotateCcw size={16} strokeWidth={2.2} />
              重新开始
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function InternshipReflectionMessageCard({
  knowledgeBases,
  message,
  onAttachEvidence,
  onDownload,
  onOpenPreview,
  onRefine,
  onRemoveEvidence,
  onReset,
  onSubmit,
  onToggleKnowledgeBase,
  onUpdateInput
}: {
  knowledgeBases: KnowledgeBase[];
  message: ChatMessage;
  onAttachEvidence: (files: FileList | null) => void;
  onDownload: () => void;
  onOpenPreview: () => void;
  onRefine: () => void;
  onRemoveEvidence: (attachmentId: string) => void;
  onReset: () => void;
  onSubmit: () => void;
  onToggleKnowledgeBase: (baseId: string) => void;
  onUpdateInput: (patch: Partial<InternshipReflectionInput>) => void;
}) {
  const evidenceInputRef = useRef<HTMLInputElement>(null);
  const state = message.internshipReflectionState;

  if (!state) {
    return null;
  }

  const isBusy = state.phase === "generating" || state.phase === "refining";
  const isGenerated = state.phase === "generated" && state.draft;
  const weaknesses = getReflectionWeaknesses(state.diagnostic);
  const answeredStepIds = state.answeredStepIds || [];
  const currentStep =
    reflectionGuidedSteps.find((step) => step.id === state.currentStepId) ||
    reflectionGuidedSteps[0];
  const answeredSet = new Set(answeredStepIds);
  const collectedSummary = buildCollectedSummary(state.input, reflectionGuidedSteps).filter(
    (item) =>
      reflectionGuidedSteps.some(
        (step) => step.label === item.label && answeredSet.has(step.id)
      )
  );
  const isEvidenceStep = currentStep.id === "evidenceDecision" && !state.isReadyToGenerate;
  const reflectionAgentSteps = [
    {
      name: "记录课堂事实",
      detail: "课堂观察 Agent 先抓取时间、班级、片段和观察重点。"
    },
    {
      name: "补充证据材料",
      detail: "证据整理 Agent 关联听课记录、板书、作业截图和知识库资料。"
    },
    {
      name: "生成并优化反思",
      detail: "问题诊断、改进建议和文档生成 Agent 共同输出 Word 成果。"
    }
  ];
  const evidenceChain = [
    {
      label: "课堂片段",
      value: state.input.classroomSegment
    },
    {
      label: "上传材料",
      value: state.evidence.length
        ? `${state.evidence.length} 份已解析证据`
        : state.evidenceFiles.length
          ? `${state.evidenceFiles.length} 份待解析材料`
          : "暂未上传"
    },
    {
      label: "知识库引用",
      value: state.citations.length
        ? `${state.citations.length} 条引用`
        : state.input.knowledgeBaseIds.length
          ? `${state.input.knowledgeBaseIds.length} 个知识库待检索`
          : "未选择"
    },
    {
      label: "诊断维度",
      value: state.diagnostic
        ? state.diagnostic.dimensions.map((dimension) => dimension.name).join("、")
        : "生成后形成观察证据、问题意识、原因分析等维度"
    }
  ];
  const generatedEvidenceChains = buildReflectionEvidenceChains(state.draft);

  return (
    <section className="reflection-chat-card" aria-label="实习日志与反思向导">
      <header className="lesson-chat-header">
        <div>
          <span>{isGenerated ? `实习反思智能体 V${state.version}` : "实习反思智能体"}</span>
          <h3>{state.draft?.title || "上传课堂证据，整理实习日志与反思"}</h3>
        </div>
        {isBusy ? <small>处理中...</small> : null}
      </header>
      <div className="reflection-agent-flow" aria-label="实习反思智能体流程">
        {reflectionAgentSteps.map((step, index) => (
          <article key={step.name}>
            <span>{index + 1}</span>
            <div>
              <strong>{step.name}</strong>
              <p>{step.detail}</p>
            </div>
          </article>
        ))}
      </div>

      {isBusy ? (
        <GenerationThinkingPanel
          progress={state.thinkingProgress}
          streamText={message.content}
          fallbackLabel={state.status || "正在生成实习反思..."}
          fallbackDetail="实习反思智能体正在整理课堂事实、证据链、问题诊断和可提交文档。"
        />
      ) : isGenerated && state.draft ? (
        <div className="lesson-result-card">
          <div className="lesson-result-summary">
            <strong>{state.diagnostic?.overallScore ?? "--"}</strong>
            <span>反思质量</span>
            <p>
              {state.evidence.length
                ? `已整理 ${state.evidence.length} 份课堂证据`
                : "未上传证据，使用默认反思框架生成"}
            </p>
          </div>
          <div className="lesson-result-meta">
            <p>{state.draft.sourceNote}</p>
            {weaknesses.length ? (
              <div>
                <span>薄弱项</span>
                {weaknesses.map((item) => (
                  <small key={item}>{item}</small>
                ))}
              </div>
            ) : null}
            {state.artifact ? (
              <a
                className="lesson-artifact-inline"
                href={state.artifact.url}
                target="_blank"
                rel="noreferrer"
              >
                <FileText size={16} strokeWidth={2.1} />
                {state.artifact.name}
              </a>
            ) : (
              <span className="lesson-artifact-inline">Word 文件准备中</span>
            )}
          </div>
          <div className="reflection-evidence-result">
            {state.evidence.length ? (
              state.evidence.slice(0, 3).map((item) => (
                <article key={item.id}>
                  <strong>{item.name}</strong>
                  <p>{item.summary}</p>
                </article>
              ))
            ) : (
              <p>本次未使用图片或材料证据。</p>
            )}
          </div>
          {generatedEvidenceChains.length ? (
            <div className="reflection-evidence-chain-list">
              <header>
                <Sparkles size={15} strokeWidth={2.2} />
                <strong>证据链</strong>
              </header>
              {generatedEvidenceChains.slice(0, 3).map((item) => (
                <article key={item.id}>
                  <span>{item.source}</span>
                  <p>{item.evidence}</p>
                  <small>{item.diagnosis}</small>
                  <b>{item.action}</b>
                </article>
              ))}
            </div>
          ) : null}
          <div className="reflection-evidence-chain">
            <header>
              <Sparkles size={15} strokeWidth={2.2} />
              <strong>证据链如何支撑反思</strong>
            </header>
            <div>
              {evidenceChain.map((item) => (
                <article key={item.label}>
                  <span>{item.label}</span>
                  <p>{item.value}</p>
                </article>
              ))}
            </div>
          </div>
          <div className="training-next-step">
            <span>下一步</span>
            <strong>{weaknesses.length ? "先补强薄弱项" : "预览并下载反思"}</strong>
            <p>
              {state.artifact
                ? "可查看完整预览、下载 Word；若要继续沉淀能力证据，进入成长档案查看本次记录。"
                : "反思内容已生成，Word 文件还在等待导出；可先预览内容，稍后再下载。"}
            </p>
          </div>
          <div className="lesson-chat-actions">
            <button type="button" onClick={onOpenPreview}>
              <FileText size={16} strokeWidth={2.2} />
              查看完整预览
            </button>
            <button type="button" onClick={onRefine} disabled={isBusy}>
              <RotateCcw size={16} strokeWidth={2.2} />
              按建议优化
            </button>
            <button type="button" onClick={onReset} disabled={isBusy}>
              <NotebookPen size={16} strokeWidth={2.2} />
              重新填写
            </button>
            <button type="button" onClick={onDownload} disabled={!state.artifact}>
              <Download size={16} strokeWidth={2.2} />
              下载 Word
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="lesson-chat-intro">
            {state.isReadyToGenerate
              ? "反思素材和证据链已经整理完成。回复“生成”或点击按钮，我会生成可提交的 Word 反思。"
              : state.pendingQuestion || currentStep.question}
          </p>
          <div className="reflection-agent-team">
            {["课堂观察 Agent", "证据整理 Agent", "问题诊断 Agent", "改进建议 Agent", "文档生成 Agent"].map(
              (agent) => (
                <span
                  className={agent === currentStep.agentName ? "guided-agent-active" : ""}
                  key={agent}
                >
                  {agent}
                </span>
              )
            )}
          </div>
          <section className="guided-progress-panel" aria-label="实习反思采集进度">
            <div>
              <span>采集进度</span>
              <strong>{buildGuidedProgressText(reflectionGuidedSteps, answeredStepIds)}</strong>
            </div>
            <div className="dimension-track">
              <i
                style={{
                  width: `${(answeredStepIds.length / reflectionGuidedSteps.length) * 100}%`
                }}
              />
            </div>
            <p>
              当前由 {state.isReadyToGenerate ? "文档生成 Agent" : currentStep.agentName}
              处理。文字回答请直接发到底部输入框。
            </p>
          </section>
          <div className="guided-summary-list" aria-label="已收集反思素材">
            {collectedSummary.length ? (
              collectedSummary.map((item) => (
                <article key={item.label}>
                  <span>{item.label}</span>
                  <p>{item.value}</p>
                </article>
              ))
            ) : (
              <p>还没有收集到实习素材，回答第一个问题后会在这里沉淀摘要。</p>
            )}
          </div>
          {state.isReadyToGenerate ? (
            <div className="guided-ready-note">
              <pre>{message.content}</pre>
            </div>
          ) : null}
          <section className="reflection-evidence-picker">
            <header>
              <Paperclip size={15} strokeWidth={2.1} />
              <strong>课堂证据</strong>
              <span>{state.evidenceFiles.length} 个已选</span>
            </header>
            <input
              className="file-input"
              ref={evidenceInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.json,image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv,application/json"
              multiple
              onChange={(event) => {
                onAttachEvidence(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={isBusy}
              onClick={() => evidenceInputRef.current?.click()}
            >
              <UploadCloud size={16} strokeWidth={2.2} />
              {isEvidenceStep ? "上传图片/材料并发送" : "补充课堂证据"}
            </button>
            {state.evidenceFiles.length ? (
              <div className="reflection-evidence-list">
                {state.evidenceFiles.map((file) => (
                  <article key={file.id}>
                    {file.previewUrl ? (
                      <img src={file.previewUrl} alt={file.name} />
                    ) : (
                      <FileText size={18} strokeWidth={2.1} />
                    )}
                    <span>{file.name}</span>
                    <small>{formatFileSize(file.size)}</small>
                    <button
                      type="button"
                      aria-label={`移除 ${file.name}`}
                      onClick={() => onRemoveEvidence(file.id)}
                    >
                      <X size={13} strokeWidth={2.4} />
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <p>可上传板书、作业、听课记录截图或课堂照片作为反思证据。</p>
            )}
          </section>
          {state.status ? <p className="lesson-chat-status">{state.status}</p> : null}
          <div className="lesson-chat-actions">
            <button
              className="lesson-chat-primary"
              type="button"
              disabled={isBusy || !state.isReadyToGenerate}
              onClick={onSubmit}
            >
              <NotebookPen size={16} strokeWidth={2.2} />
              {isBusy ? "正在生成..." : "生成实习反思 Word"}
            </button>
            <button type="button" disabled={isBusy} onClick={onReset}>
              <RotateCcw size={16} strokeWidth={2.2} />
              重新开始
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function InsightPanel({
  isOpen,
  message,
  onClose,
  onOpenMaterials
}: {
  isOpen: boolean;
  message?: ChatMessage;
  onClose: () => void;
  onOpenMaterials: () => void;
}) {
  const [activeMode, setActiveMode] = useState<InsightMode>("thinking");
  const hasLessonPreview = Boolean(message?.lessonPlanState?.draft);
  const hasReflectionPreview = Boolean(message?.internshipReflectionState?.draft);
  const fileCount =
    (message?.artifacts?.length || 0) +
    (message?.lessonPlanState?.artifact ? 1 : 0) +
    (message?.internshipReflectionState?.artifact ? 1 : 0);

  useEffect(() => {
    if (!message) {
      return;
    }

    if (message.insightMode === "lessonPreview" && hasLessonPreview) {
      setActiveMode("lessonPreview");
      return;
    }

    if (message.insightMode === "reflectionPreview" && hasReflectionPreview) {
      setActiveMode("reflectionPreview");
      return;
    }

    if (message.insightMode === "files") {
      setActiveMode("files");
      return;
    }

    setActiveMode("thinking");
  }, [hasLessonPreview, hasReflectionPreview, message]);

  return (
    <AnimatePresence>
      {isOpen ? (
        <motion.div
          className="insight-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
        >
          <motion.aside
            className="insight-panel"
            aria-label="思考过程和生成文件侧边栏"
            initial={{ x: 36, opacity: 0, scale: 0.985 }}
            animate={{ x: 0, opacity: 1, scale: 1 }}
            exit={{ x: 36, opacity: 0, scale: 0.985 }}
            transition={{ type: "spring", stiffness: 360, damping: 34 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="insight-header">
              <div>
                <span className="insight-kicker">AI Workspace</span>
                <h2>思考、预览与文件</h2>
              </div>
              <button
                className="insight-close"
                type="button"
                aria-label="关闭侧边面板"
                onClick={onClose}
              >
                <X size={18} strokeWidth={2.4} />
              </button>
            </div>

            <div className="insight-tabs" role="tablist" aria-label="侧栏内容">
              <button
                className={activeMode === "thinking" ? "insight-tab-active" : ""}
                type="button"
                role="tab"
                aria-selected={activeMode === "thinking"}
                onClick={() => setActiveMode("thinking")}
              >
                思考摘要
              </button>
              {hasLessonPreview ? (
                <button
                  className={activeMode === "lessonPreview" ? "insight-tab-active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={activeMode === "lessonPreview"}
                  onClick={() => setActiveMode("lessonPreview")}
                >
                  教案预览
                </button>
              ) : null}
              {hasReflectionPreview ? (
                <button
                  className={activeMode === "reflectionPreview" ? "insight-tab-active" : ""}
                  type="button"
                  role="tab"
                  aria-selected={activeMode === "reflectionPreview"}
                  onClick={() => setActiveMode("reflectionPreview")}
                >
                  反思预览
                </button>
              ) : null}
              <button
                className={activeMode === "files" ? "insight-tab-active" : ""}
                type="button"
                role="tab"
                aria-selected={activeMode === "files"}
                onClick={() => setActiveMode("files")}
              >
                成果与参考资料
              </button>
            </div>

            <div className="insight-body">
              {activeMode === "thinking" ? (
                <>
                  <section className="thought-card" aria-label="思考过程">
                    <header className="section-heading">
                      <Brain size={17} strokeWidth={2.2} />
                      <h3>思考摘要</h3>
                    </header>
                    <pre>
                      {summarizeThinkingText(message) ||
                        (message?.thinkingEnabled
                          ? "本次请求未返回可总结的思考过程。"
                          : "本次请求未开启深度思考。")}
                    </pre>
                  </section>

                  <EvaluationPanel evaluation={message?.evaluation} />
                </>
              ) : null}

              {activeMode === "lessonPreview" && message?.lessonPlanState?.draft ? (
                <LessonPlanPreview
                  citations={message.lessonPlanState.citations}
                  comparison={message.lessonPlanState.comparison}
                  diagnostic={message.lessonPlanState.diagnostic}
                  draft={message.lessonPlanState.draft}
                />
              ) : null}

              {activeMode === "reflectionPreview" &&
              message?.internshipReflectionState?.draft ? (
                <InternshipReflectionPreview
                  citations={message.internshipReflectionState.citations}
                  diagnostic={message.internshipReflectionState.diagnostic}
                  draft={message.internshipReflectionState.draft}
                />
              ) : null}

              {activeMode === "files" ? (
                <section className="files-panel" aria-label="输出文件和引用来源">
                  <div className="files-heading">
                    <h3>输出文件</h3>
                    <span>{fileCount} 个文件</span>
                  </div>
                  {message?.lessonPlanState?.artifact ? (
                    <GeneratedFileLink file={message.lessonPlanState.artifact} />
                  ) : null}
                  {message?.internshipReflectionState?.artifact ? (
                    <GeneratedFileLink file={message.internshipReflectionState.artifact} />
                  ) : null}
                  {message?.artifacts?.length
                    ? message.artifacts.map((file) => (
                        <GeneratedFileLink file={file} key={file.id} />
                      ))
                    : null}
                  {!fileCount ? (
                    <article className="generated-file">
                      <header>
                        <Code size={17} strokeWidth={2.1} />
                        <span>暂无输出文件</span>
                      </header>
                      <p>模型没有为本次回复生成可下载文件。</p>
                    </article>
                  ) : null}
                  <CitationPanel
                    citations={
                      message?.internshipReflectionState?.citations ||
                      message?.lessonPlanState?.citations ||
                      message?.citations ||
                      []
                    }
                    onOpenMaterials={onOpenMaterials}
                  />
                </section>
              ) : null}
            </div>
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function GeneratedFileLink({ file }: { file: ChatArtifact }) {
  return (
    <a
      className="generated-file generated-file-link"
      href={file.url}
      target="_blank"
      rel="noreferrer"
    >
      <header>
        <FileText size={17} strokeWidth={2.1} />
        <span>{file.name}</span>
        <small>{file.type.toUpperCase()}</small>
      </header>
      <p>{formatFileSize(file.size)}</p>
    </a>
  );
}

function CitationPanel({
  citations,
  onOpenMaterials
}: {
  citations: KnowledgeCitation[];
  onOpenMaterials?: () => void;
}) {
  return (
    <section className="sources-card" aria-label="本次参考资料">
      <div className="sources-card-heading">
        <h3>本次参考资料</h3>
        {onOpenMaterials ? (
          <button type="button" onClick={onOpenMaterials}>
            <BookOpen size={15} strokeWidth={2.1} />
            回看资料
          </button>
        ) : null}
      </div>
      {citations.length ? (
        citations.slice(0, 5).map((citation) => (
          <article className="source-item" key={citation.id}>
            <span>{formatKnowledgeSource(citation.source)}</span>
            <strong>{citation.documentName}</strong>
            <small>{citation.knowledgeBaseName}</small>
            <p>{truncateText(citation.snippet, 130)}</p>
          </article>
        ))
      ) : (
        <p className="evaluation-empty">本次未引用资料，本次使用通用训练框架。</p>
      )}
    </section>
  );
}

function LessonPlanComparisonPanel({
  comparison,
  compact = false
}: {
  comparison: LessonPlanComparison;
  compact?: boolean;
}) {
  const visibleItems = compact ? comparison.items.slice(0, 3) : comparison.items;

  return (
    <section
      className={`lesson-comparison-panel ${
        compact ? "lesson-comparison-compact" : ""
      }`}
      aria-label="教案优化前后对比"
    >
      <header>
        <GitCompareArrows size={17} strokeWidth={2.2} />
        <div>
          <strong>前后对比</strong>
          <p>{comparison.summary}</p>
        </div>
      </header>
      <div className="lesson-comparison-grid">
        {visibleItems.map((item) => (
          <article key={item.dimension}>
            <span>{item.dimension}</span>
            <p>
              <b>优化前</b>
              {item.before}
            </p>
            <p>
              <b>优化后</b>
              {item.after}
            </p>
            <small>{item.improvement}</small>
          </article>
        ))}
      </div>
      {!compact && comparison.evidence.length ? (
        <div className="lesson-comparison-evidence">
          {comparison.evidence.map((item) => (
            <p key={item}>{item}</p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function LessonPlanPreview({
  citations,
  comparison,
  diagnostic,
  draft
}: {
  citations: KnowledgeCitation[];
  comparison?: LessonPlanComparison;
  diagnostic?: LessonPlanDiagnostic;
  draft: LessonPlanDraft;
}) {
  return (
    <section className="lesson-preview" aria-label="教案 Word 预览">
      <div className="lesson-preview-paper">
        <header className="lesson-preview-title">
          <span>Word Preview</span>
          <h2>{draft.title}</h2>
          <p>
            学科：{draft.input.subject} · 年级：{draft.input.grade} · 课时：
            {draft.input.duration}
          </p>
        </header>
        <section className="lesson-preview-note">
          <strong>生成说明</strong>
          <p>{draft.sourceNote}</p>
        </section>
        {comparison ? <LessonPlanComparisonPanel comparison={comparison} /> : null}
        {draft.sections.map((section) => (
          <article className="lesson-preview-section" key={section.heading}>
            <h3>{section.heading}</h3>
            {section.body ? <p>{section.body}</p> : null}
            {section.bullets?.length ? (
              <ul>
                {section.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            ) : null}
          </article>
        ))}
      </div>
      <aside className="lesson-preview-diagnostic">
        <strong>{diagnostic?.overallScore ?? "--"}</strong>
        <span>诊断总分</span>
        <p>
          {diagnostic?.suggestions?.[0] ||
            diagnostic?.nextTask ||
            "生成完成后会显示诊断建议。"}
        </p>
        <small>
          {citations.length
            ? `引用 ${citations.length} 条资料`
            : "未引用知识库资料"}
        </small>
      </aside>
    </section>
  );
}

function InternshipReflectionPreview({
  citations,
  diagnostic,
  draft
}: {
  citations: KnowledgeCitation[];
  diagnostic?: InternshipReflectionDiagnostic;
  draft: InternshipReflectionDraft;
}) {
  const sectionGroups = [
    {
      name: "事实记录",
      sections: draft.sections.filter((section) =>
        /基本信息|课堂观察|材料证据/.test(section.heading)
      )
    },
    {
      name: "问题诊断",
      sections: draft.sections.filter((section) =>
        /问题诊断|问题分析|原因分析|理论依据|前序训练关联/.test(section.heading)
      )
    },
    {
      name: "行动计划",
      sections: draft.sections.filter((section) =>
        /改进计划|改进策略|后续行动/.test(section.heading)
      )
    },
    {
      name: "师德育人",
      sections: draft.sections.filter((section) => /师德育人/.test(section.heading))
    },
    {
      name: "下一次验证",
      sections: draft.sections.filter((section) =>
        /下一次实践|可迁移经验/.test(section.heading)
      )
    }
  ].filter((group) => group.sections.length);
  const evidenceChains = buildReflectionEvidenceChains(draft);

  return (
    <section className="lesson-preview" aria-label="实习反思 Word 预览">
      <div className="lesson-preview-paper">
        <header className="lesson-preview-title">
          <span>Reflection Preview</span>
          <h2>{draft.title}</h2>
          <p>
            {draft.input.schoolClass} · {draft.input.subjectTopic} ·{" "}
            {draft.input.internshipDate}
          </p>
        </header>
        <section className="lesson-preview-note">
          <strong>生成说明</strong>
          <p>{draft.sourceNote}</p>
        </section>
        {draft.evidence.length ? (
          <section className="lesson-preview-note">
            <strong>课堂证据</strong>
            {draft.evidence.slice(0, 4).map((item) => (
              <p key={item.id}>
                {item.name}：{item.summary}
              </p>
            ))}
          </section>
        ) : null}
        {evidenceChains.length ? (
          <section className="reflection-preview-evidence-chain">
            <strong>证据链</strong>
            {evidenceChains.map((item) => (
              <article key={item.id}>
                <span>{item.source}</span>
                <p>{item.evidence}</p>
                <small>{item.diagnosis}</small>
                <b>{item.action}</b>
              </article>
            ))}
          </section>
        ) : null}
        {sectionGroups.map((group) => (
          <section className="reflection-preview-group" key={group.name}>
            <strong>{group.name}</strong>
            {group.sections.map((section) => (
              <article className="lesson-preview-section" key={section.heading}>
                <h3>{section.heading}</h3>
                {section.body ? <p>{section.body}</p> : null}
                {section.bullets?.length ? (
                  <ul>
                    {section.bullets.map((bullet) => (
                      <li key={bullet}>{bullet}</li>
                    ))}
                  </ul>
                ) : null}
              </article>
            ))}
          </section>
        ))}
      </div>
      <aside className="lesson-preview-diagnostic">
        <strong>{diagnostic?.overallScore ?? "--"}</strong>
        <span>反思质量</span>
        <p>
          {diagnostic?.suggestions?.[0] ||
            diagnostic?.nextTask ||
            "生成完成后会显示诊断建议。"}
        </p>
        <small>
          {citations.length
            ? `引用 ${citations.length} 条资料`
            : "未引用知识库资料"}
        </small>
      </aside>
    </section>
  );
}

type SpeakTrainingRoomProps = {
  selectedKnowledgeBaseIds: string[];
  onTrainingSaved: () => void;
  onOpenMaterials: () => void;
};

type SpeakTrainingMode = "standard" | "realtime" | "silent";
type SpeakPracticeInputMode = "voice" | "text";

const speakStageSeedMeta: Array<{
  id: SpeakStageId;
  name: string;
  suggestedMinSec: number;
  suggestedMaxSec: number;
  missingSignals: string[];
}> = [
  { id: "textbook", name: "说教材", suggestedMinSec: 35, suggestedMaxSec: 70, missingSignals: ["教材", "课标", "单元"] },
  { id: "student", name: "说学情", suggestedMinSec: 35, suggestedMaxSec: 70, missingSignals: ["学生", "基础", "困难"] },
  { id: "objective", name: "说目标", suggestedMinSec: 45, suggestedMaxSec: 90, missingSignals: ["目标", "能够", "达成"] },
  { id: "keyPoint", name: "说重难点", suggestedMinSec: 35, suggestedMaxSec: 70, missingSignals: ["重点", "难点", "突破"] },
  { id: "method", name: "说方法", suggestedMinSec: 35, suggestedMaxSec: 80, missingSignals: ["教法", "学法", "学生"] },
  { id: "process", name: "说过程", suggestedMinSec: 150, suggestedMaxSec: 260, missingSignals: ["导入", "新授", "小结"] },
  { id: "activity", name: "说活动", suggestedMinSec: 55, suggestedMaxSec: 110, missingSignals: ["任务", "分组", "产出"] },
  { id: "assessment", name: "说评价", suggestedMinSec: 45, suggestedMaxSec: 90, missingSignals: ["评价", "标准", "反馈"] },
  { id: "reflection", name: "说反思", suggestedMinSec: 25, suggestedMaxSec: 60, missingSignals: ["反思", "改进"] }
];

const speakStageProgressSeed: SpeakStageProgress[] = speakStageSeedMeta.map(
  (stage, index) => ({
    ...stage,
    progress: 0,
    status: index === 0 ? "active" : "pending",
    evidence: [],
    durationSec: 0,
    completenessScore: 0,
    warnings: []
  })
);

const speakCoverageGroups: Array<{
  id: string;
  name: string;
  stageIds: SpeakStageId[];
  supplementPrompt: string;
}> = [
  {
    id: "basis",
    name: "教学依据",
    stageIds: ["textbook", "student"],
    supplementPrompt: "建议补充：请说明本课的教材或课标依据，以及学生已有基础和可能遇到的困难。"
  },
  {
    id: "goal",
    name: "目标与重难点",
    stageIds: ["objective", "keyPoint"],
    supplementPrompt: "建议补充：请说明可观察的教学目标、重点难点，以及你将如何突破难点。"
  },
  {
    id: "design",
    name: "教学设计",
    stageIds: ["method", "process", "activity"],
    supplementPrompt: "建议补充：请说明教学流程、学生任务产出，以及教师将如何追问和反馈。"
  },
  {
    id: "assessment",
    name: "评价设计",
    stageIds: ["assessment"],
    supplementPrompt: "建议补充：请说明评价标准、反馈方式，以及如何依据学生表现判断目标达成。"
  },
  {
    id: "reflection",
    name: "教学反思",
    stageIds: ["reflection"],
    supplementPrompt: "建议补充：请说明课后将依据哪些学习证据反思教学，并如何调整下一次教学。"
  }
];

type SpeakMaterialItem = {
  id: string;
  subject: "通用" | "语文" | "数学" | "英语" | "科学";
  stageId: SpeakStageId;
  title: string;
  tag: string;
  text: string;
};

type SpeakFavoriteItem = {
  id: string;
  type: "question" | "stage" | "deduction" | "phrase" | "material" | "segment";
  title: string;
  detail: string;
  stageId?: SpeakStageId;
  createdAt: string;
};

type SpeakArchiveItem = {
  id: string;
  conversationId?: string;
  stageId: SpeakStageId;
  stageName: string;
  text: string;
  durationSec: number;
  wpm: number;
  annotationCount: number;
  createdAt: string;
};

type SpeakOralDraft = {
  sourceTitle: string;
  stageName: string;
  text: string;
};

type SpeakExamPaper = {
  id: string;
  subject: SpeakMaterialItem["subject"];
  grade: string;
  topic: string;
  textbookHint: string;
  studentHint: string;
  requiredQuestion: string;
};

type SpeakRiskWarning = {
  id: string;
  title: string;
  detail: string;
  severity: "warning" | "error";
};

const speakMaterialBank: SpeakMaterialItem[] = [
  {
    id: "standard-core",
    subject: "通用",
    stageId: "textbook",
    title: "新课标依据",
    tag: "课标",
    text: "依据新课标要求，本课不只关注知识获得，更强调学生在真实问题中形成观察、表达、探究和迁移能力。"
  },
  {
    id: "student-common",
    subject: "通用",
    stageId: "student",
    title: "学情通用句",
    tag: "学情",
    text: "学生已有一定生活经验和初步知识基础，但在抽象概括、依据表达和迁移运用方面仍需要教师提供学习支架。"
  },
  {
    id: "objective-behavior",
    subject: "通用",
    stageId: "objective",
    title: "可测目标",
    tag: "目标",
    text: "通过本课学习，学生能够说出核心概念，结合材料解释关键依据，并在任务情境中完成迁移运用。"
  },
  {
    id: "keypoint-break",
    subject: "通用",
    stageId: "keyPoint",
    title: "重难点突破",
    tag: "重难点",
    text: "本课重点是理解并运用核心概念，难点在于学生容易停留在表层记忆。我将通过情境问题、合作探究和即时反馈突破难点。"
  },
  {
    id: "method-learning",
    subject: "通用",
    stageId: "method",
    title: "教法学法区分",
    tag: "教法",
    text: "教法上采用情境创设、问题链引导和支架点拨；学法上引导学生自主思考、合作交流、展示表达和反思改进。"
  },
  {
    id: "process-chain",
    subject: "通用",
    stageId: "process",
    title: "教学过程框架",
    tag: "过程",
    text: "教学过程分为情境导入、问题探究、合作展示、巩固迁移和课堂小结五个环节，环节之间围绕同一核心问题逐步推进。"
  },
  {
    id: "activity-group",
    subject: "通用",
    stageId: "activity",
    title: "小组活动",
    tag: "活动",
    text: "学生四人一组，围绕主问题讨论 3 分钟，形成一条观点和一条依据，由汇报员展示，教师根据回答进行追问和归纳。"
  },
  {
    id: "assessment-evidence",
    subject: "通用",
    stageId: "assessment",
    title: "评价证据",
    tag: "评价",
    text: "评价主要依据学生课堂表达、任务单完成情况和展示反馈，重点观察学生是否能说清观点、给出依据并完成迁移。"
  },
  {
    id: "reflection-improve",
    subject: "通用",
    stageId: "reflection",
    title: "教学反思",
    tag: "反思",
    text: "课后我将结合学生任务单和课堂生成，反思问题链是否有效、活动时间是否合理，并在二次备课中调整支架。"
  },
  {
    id: "chinese-text",
    subject: "语文",
    stageId: "textbook",
    title: "语文教材分析",
    tag: "语文",
    text: "本课文本语言具有典型表达特色，适合引导学生在朗读、品析和表达迁移中理解内容与情感。"
  },
  {
    id: "math-key",
    subject: "数学",
    stageId: "keyPoint",
    title: "数学难点",
    tag: "数学",
    text: "数学难点在于学生从直观操作过渡到抽象概括，因此我会用操作活动、图示表征和变式练习逐步建立模型。"
  },
  {
    id: "english-activity",
    subject: "英语",
    stageId: "activity",
    title: "英语活动",
    tag: "英语",
    text: "学生先进行 pair work 完成信息差交流，再进行 group report，在真实语境中使用目标语言表达观点。"
  },
  {
    id: "science-inquiry",
    subject: "科学",
    stageId: "method",
    title: "科学探究",
    tag: "科学",
    text: "科学课采用观察实验、证据记录和交流质疑的方式，让学生经历提出问题、验证猜想和解释现象的过程。"
  }
];

const speakSampleDrafts: Record<SpeakStageId, string> = {
  textbook:
    "我首先进行教材分析。本课位于本单元的关键位置，既承接前一课的知识基础，又为后续学习提供方法支撑。依据新课标要求，本课需要把知识学习和核心素养发展结合起来。",
  student:
    "从学情来看，学生已有一定生活经验和初步知识基础，但在抽象概括、依据表达和迁移运用方面还存在困难。因此教学中需要通过情境、问题链和合作交流提供支架。",
  objective:
    "基于教材和学情，我确定以下教学目标：学生能够说出核心概念，结合材料解释关键依据，并在任务情境中完成迁移运用。目标表述强调可观察、可评价的学习结果。",
  keyPoint:
    "本课重点是理解并运用核心概念，难点在于学生容易停留在表层记忆，不能结合情境说明依据。突破策略是通过情境问题、合作探究和即时反馈逐步推进。",
  method:
    "教法上，我采用情境创设、问题链引导和支架点拨；学法上，引导学生自主思考、合作交流、展示表达和反思改进，使学生真正经历知识建构过程。",
  process:
    "教学过程分为五个环节：情境导入激活经验，问题探究形成理解，合作展示促进表达，巩固迁移检验达成，课堂小结回扣目标。各环节围绕同一核心问题展开。",
  activity:
    "课堂活动中，学生四人一组，围绕主问题讨论 3 分钟，形成一条观点和一条依据。展示后我会根据学生回答进行追问、补充和归纳，保证活动有产出、有反馈。",
  assessment:
    "评价设计主要依据学生课堂表达、任务单完成情况和展示反馈。评价标准包括能否说清观点、能否给出依据、能否完成迁移任务，从而判断目标达成情况。",
  reflection:
    "教学反思方面，课后我将结合学生任务单和课堂生成，反思问题链是否有效、活动时间是否合理、支架是否充分，并在二次备课中进行调整。"
};

const speakExamPapers: SpeakExamPaper[] = [
  {
    id: "exam_cn_1",
    subject: "语文",
    grade: "小学高年级",
    topic: "《桥》人物形象分析",
    textbookHint: "文本情节集中，人物语言和动作描写突出，适合训练朗读品析与依据表达。",
    studentHint: "学生能概括故事情节，但容易只说感受，缺少结合文本细节说明人物品质。",
    requiredQuestion: "如果学生只说老支书很伟大，却找不到依据，你怎么引导？"
  },
  {
    id: "exam_math_1",
    subject: "数学",
    grade: "小学四年级",
    topic: "《三角形的内角和》",
    textbookHint: "本课从操作验证走向抽象概括，是几何直观和推理意识发展的关键内容。",
    studentHint: "学生有量角经验，但从个别测量结果上升到一般结论需要操作和交流支架。",
    requiredQuestion: "如果学生测量结果不是 180 度，你如何处理误差并推进结论？"
  },
  {
    id: "exam_en_1",
    subject: "英语",
    grade: "初中七年级",
    topic: "Unit 4 Where's my schoolbag?",
    textbookHint: "本课围绕位置表达展开，适合在真实语境中训练方位介词和问答表达。",
    studentHint: "学生能理解部分词汇，但完整问答和迁移表达需要情境操练。",
    requiredQuestion: "如果 pair work 中学生只读句子不交流，你怎样调整活动？"
  },
  {
    id: "exam_science_1",
    subject: "科学",
    grade: "小学三年级",
    topic: "《水到哪里去了》",
    textbookHint: "本课以生活现象为起点，引导学生通过观察和证据记录理解蒸发现象。",
    studentHint: "学生熟悉水变少的现象，但容易把蒸发简单理解为消失，需要证据解释。",
    requiredQuestion: "如果学生认为水凭空消失了，你如何用实验和追问帮助其修正？"
  }
];

const speakRoleMeta: Record<SpeakRoleId, { label: string; compact: string }> = {
  researcher: { label: "研究员", compact: "研" },
  teacher: { label: "教研员", compact: "教" },
  expert: { label: "专家", compact: "专" }
};

function SpeakTrainingRoom({
  selectedKnowledgeBaseIds,
  onTrainingSaved,
  onOpenMaterials
}: SpeakTrainingRoomProps) {
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [draftText, setDraftText] = useState("");
  const [draftInputMode, setDraftInputMode] =
    useState<SpeakDraftInputMode>("manual");
  const [practiceInputMode, setPracticeInputMode] =
    useState<SpeakPracticeInputMode>("voice");
  const [isTextPracticeActive, setIsTextPracticeActive] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [status, setStatus] = useState("准备开始完整说课训练。");
  const [isRecording, setIsRecording] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [trainingMode, setTrainingMode] = useState<SpeakTrainingMode>("standard");
  const [currentStage, setCurrentStage] = useState<SpeakStageProgress>(
    speakStageProgressSeed[0]
  );
  const [stageProgress, setStageProgress] = useState<SpeakStageProgress[]>(
    speakStageProgressSeed
  );
  const [segments, setSegments] = useState<SpeakTrainingSegment[]>([]);
  const [roleComments, setRoleComments] = useState<RoleAgentComment[]>([]);
  const [questions, setQuestions] = useState<SpeakTrainingQuestion[]>([]);
  const [defenseQuestions, setDefenseQuestions] = useState<DefenseQuestion[]>([]);
  const [defenseOptimization, setDefenseOptimization] = useState<DefenseOptimizationPlan>();
  const [aiFocusHints, setAiFocusHints] = useState<SpeakAiFocusHint[]>([]);
  const [evaluation, setEvaluation] = useState<TrainingEvaluation | undefined>();
  const [report, setReport] = useState<SpeakTrainingReport | undefined>();
  const [isSpeakReportDocumentOpen, setIsSpeakReportDocumentOpen] = useState(false);
  const [retrainFocus, setRetrainFocus] = useState<SpeakRetrainFocus>();
  const [retrainComparisons, setRetrainComparisons] = useState<SpeakRetrainComparison[]>([]);
  const [summary, setSummary] = useState<SpeakTrainingTurnResult["summary"]>();
  const [audioBlob, setAudioBlob] = useState<Blob | undefined>();
  const [responseText, setResponseText] = useState("");
  const [activeDefenseDetailId, setActiveDefenseDetailId] = useState<string>();
  const [micLevel, setMicLevel] = useState(0);
  const [sentAudioFrameCount, setSentAudioFrameCount] = useState(0);
  const [examMode, setExamMode] = useState(false);
  const [selectedExamPaper, setSelectedExamPaper] = useState<SpeakExamPaper | undefined>();
  const [remainingSec, setRemainingSec] = useState(600);
  const [segmentStartedAt, setSegmentStartedAt] = useState<number | undefined>();
  const [activeTool, setActiveTool] = useState<"materials" | "collection" | "archive" | "sample">("materials");
  const [favoriteItems, setFavoriteItems] = useState<SpeakFavoriteItem[]>(() =>
    readSpeakFavorites()
  );
  const [archiveItems, setArchiveItems] = useState<SpeakArchiveItem[]>(() =>
    readSpeakArchive()
  );
  const [materialQuery, setMaterialQuery] = useState("");
  const [materialSubject, setMaterialSubject] = useState<SpeakMaterialItem["subject"] | "全部">("全部");
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveStageId, setArchiveStageId] = useState<SpeakStageId | "all">("all");
  const [sampleStageId, setSampleStageId] = useState<SpeakStageId>("textbook");
  const [reRecordSegmentId, setReRecordSegmentId] = useState<string | undefined>();
  const [oralDraft, setOralDraft] = useState<SpeakOralDraft | undefined>();
  const [oralDraftError, setOralDraftError] = useState("");
  const [isOralizingMaterial, setIsOralizingMaterial] = useState(false);
  const [coverageHint, setCoverageHint] = useState<string | undefined>();
  const [speechConfig, setSpeechConfig] = useState<SpeakTrainingConfig>({
    asrProvider: "browser",
    ttsProvider: "browser",
    realtimeMode: "mvp"
  });
  const [isSpeechConfigLoaded, setIsSpeechConfigLoaded] = useState(false);
  const [, setTimerTick] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const isRecordingRef = useRef(false);
  const realtimeSocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const pendingAudioFramesRef = useRef<string[]>([]);
  const pendingRealtimeTranscriptsRef = useRef<
    Array<{ text: string; final: boolean; pauseDurationMs?: number; durationSec?: number }>
  >([]);
  const pendingAudioEndRef = useRef(false);
  const sentAudioFrameCountRef = useRef(0);
  const asrFinalizeTimerRef = useRef<number | undefined>(undefined);
  const manualRealtimeTimerRef = useRef<number | undefined>(undefined);
  const pendingManualRealtimeDraftRef = useRef("");
  const lastManualRealtimeDraftRef = useRef("");
  const spokenQuestionIdsRef = useRef<Set<string>>(new Set());
  const recentSpeechKeysRef = useRef<Map<string, number>>(new Map());
  const speechPlaybackRef = useRef<Promise<void>>(Promise.resolve());
  const latestRoleAudioRef = useRef<HTMLAudioElement | null>(null);
  const draftTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const latestRoleAudioKeyRef = useRef("");
  const isRoleAudioMutedRef = useRef(false);
  const audioUnlockedRef = useRef(false);
  const lastSpeechAtRef = useRef<number>(Date.now());
  const usesIflytekAsr =
    speechConfig.asrProvider === "iflytek" && speechConfig.iflytekConfigured;
  const usesIflytekTts =
    speechConfig.ttsProvider === "iflytek" && speechConfig.iflytekConfigured;
  const recognitionSupported =
    typeof window !== "undefined" &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const isRealtime = trainingMode === "realtime";
  const isSilent = trainingMode === "silent";
  const usesRealtimeIflytekAsr = isRealtime && usesIflytekAsr;
  const pendingQuestion = questions.find((question) => question.status === "pending");
  const pendingDefenseQuestion = defenseQuestions.find(
    (question) => question.status === "pending"
  );
  const defenseQuestionItems = [...questions, ...defenseQuestions];
  const activeDefenseDetail = defenseQuestionItems.find(
    (question) => question.id === activeDefenseDetailId
  );
  const activeDefenseOptimization = activeDefenseDetail
    ? defenseOptimization?.items.find((item) => item.questionId === activeDefenseDetail.id)
    : undefined;
  const pendingDefenseCount = defenseQuestionItems.filter(
    (question) => question.status === "pending"
  ).length;
  const activeDefenseQuestion = pendingQuestion || pendingDefenseQuestion;
  const priorityFocus = report ? getSpeakPriorityFocus(report) : undefined;
  const latestRetrainComparison = retrainComparisons[retrainComparisons.length - 1];
  const latestOverallScoreChange = latestRetrainComparison
    ? latestRetrainComparison.afterOverallScore - latestRetrainComparison.beforeOverallScore
    : undefined;
  const latestStageProgressChange =
    latestRetrainComparison?.beforeStageProgress !== undefined &&
    latestRetrainComparison.afterStageProgress !== undefined
      ? latestRetrainComparison.afterStageProgress - latestRetrainComparison.beforeStageProgress
      : undefined;
  const activeDefenseRole = activeDefenseQuestion
    ? speakRoleMeta[activeDefenseQuestion.role]
    : undefined;
  const currentSegmentDurationSec = segmentStartedAt
    ? Math.max(0, Math.round((Date.now() - segmentStartedAt) / 1000))
    : 0;
  const liveText = `${draftText}${interimText ? ` ${interimText}` : ""}`;
  const canEditDraft = isTextPracticeActive || Boolean(liveText.trim());
  const draftInputLabel =
    draftInputMode === "mixed"
      ? "语音 + 手动"
      : draftInputMode === "speech"
        ? "语音转写"
        : "手动输入";
  const liveWordCount = countSpeakWords(liveText);
  const liveWpm = currentSegmentDurationSec
    ? Math.round((liveWordCount / currentSegmentDurationSec) * 60)
    : 0;
  const coverageGroups = speakCoverageGroups.map((group) => {
    const stages = group.stageIds.map(
      (stageId) => stageProgress.find((stage) => stage.id === stageId) ||
        speakStageProgressSeed.find((stage) => stage.id === stageId)!
    );
    const coveredStages = stages.filter((stage) => stage.progress >= 55);
    const evidence = [...new Set(stages.flatMap((stage) => stage.evidence))].slice(0, 3);
    const missingSignals = [...new Set(stages.flatMap((stage) => stage.missingSignals))].slice(0, 3);

    return {
      ...group,
      isCovered: coveredStages.length === stages.length,
      progress: Math.round(stages.reduce((total, stage) => total + stage.progress, 0) / stages.length),
      evidence,
      missingSignals
    };
  });
  const allAnnotations = [
    ...segments.flatMap((segment) => segment.annotations || []),
    ...questions
      .filter((question) => question.feedback)
      .map((question) => ({
        id: question.id,
        type: "missing_point" as const,
        severity: (question.score && question.score < 70 ? "warning" : "info") as
          | "info"
          | "warning",
        message: question.feedback || "",
        suggestion: question.question
      })),
    ...(summary ? [] : [])
  ];
  const filteredMaterials = speakMaterialBank.filter((item) => {
    const query = materialQuery.trim();
    const matchesSubject = materialSubject === "全部" || item.subject === materialSubject;
    const matchesQuery =
      !query ||
      `${item.title}${item.tag}${item.text}${item.subject}${getSpeakStageName(item.stageId)}`.includes(query);
    return matchesSubject && matchesQuery;
  });
  const filteredArchiveItems = archiveItems.filter((item) => {
    const query = archiveQuery.trim();
    const matchesStage = archiveStageId === "all" || item.stageId === archiveStageId;
    const matchesQuery =
      !query || `${item.stageName}${item.text}${item.createdAt}`.includes(query);
    return matchesStage && matchesQuery;
  });
  const sampleDraftText =
    segments
      .filter((segment) => segment.stageId === sampleStageId)
      .map((segment) => segment.text)
      .join("\n\n") ||
    (currentStage.id === sampleStageId ? liveText : "");
  const sampleOwnText =
    sampleDraftText || "你的同模块说课内容会显示在这里，便于逐句对照。";
  const combinedSpeakText = [
    selectedExamPaper
      ? `${selectedExamPaper.topic} ${selectedExamPaper.textbookHint} ${selectedExamPaper.studentHint}`
      : "",
    ...segments.map((segment) => segment.text),
    liveText
  ]
    .join("\n")
    .trim();
  const riskWarnings = buildSpeakRiskWarnings({
    text: combinedSpeakText,
    stageProgress,
    liveWpm,
    examMode,
    remainingSec
  });

  useEffect(() => {
    void loadSpeakTrainingConfig();

    return () => {
      stopRecognition();
      stopPcmStreaming();
      clearAsrFinalizeTimer();
      clearManualRealtimeTimer();
      mediaRecorderRef.current?.stop();
      realtimeSocketRef.current?.close();
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    accountStorage.setItem("speak-training-favorites", JSON.stringify(favoriteItems));
  }, [favoriteItems]);

  useEffect(() => {
    accountStorage.setItem("speak-training-archive", JSON.stringify(archiveItems));
  }, [archiveItems]);

  useEffect(() => {
    if (!segments.length) {
      return;
    }

    setArchiveItems((current) => mergeArchiveItems(current, segments, conversationId));
  }, [conversationId, segments]);

  useEffect(() => {
    if (!isRecording || !examMode) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setRemainingSec((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          setStatus("全真倒计时结束，已自动收束本段。");
          setIsRecording(false);
          stopRecognition();
          stopPcmStreaming();
          mediaRecorderRef.current?.stop();
          void submitTurn();
          return 0;
        }

        if (current === 121 && !isSilent) {
          setStatus("本轮限时练习还剩 2 分钟，请准备收束核心内容。");
        }

        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [examMode, isRecording, isSilent]);

  useEffect(() => {
    if (!segmentStartedAt) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setTimerTick((current) => current + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [segmentStartedAt]);

  useEffect(() => {
    isRecordingRef.current = isRecording;
  }, [isRecording]);

  async function loadSpeakTrainingConfig() {
    try {
      const response = await fetch("/api/speak-training/config");
      const payload = (await response.json()) as { config?: SpeakTrainingConfig };

      if (payload.config) {
        setSpeechConfig(payload.config);
        setIsSpeechConfigLoaded(true);
        return payload.config;
      }
    } catch {
      setStatus("语音配置读取失败，已使用浏览器兜底模式。");
    }

    setIsSpeechConfigLoaded(true);
    return undefined;
  }

  function openRealtimeSocket(nextConversationId = conversationId) {
    if (realtimeSocketRef.current?.readyState === WebSocket.OPEN) {
      return realtimeSocketRef.current;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    // 走同源：开发态由 Vite 代理 /api（含 ws），部署态由反向代理转发。
    const socket = new WebSocket(
      `${protocol}://${window.location.host}/api/speak-training/realtime`
    );
    realtimeSocketRef.current = socket;
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "start",
          conversationId: nextConversationId,
          currentStageId: currentStage.id,
          knowledgeBaseIds: selectedKnowledgeBaseIds
        })
      );
      flushPendingAudioFrames();
      flushPendingRealtimeTranscripts();
      flushManualRealtimeTranscript();
      setStatus("实时教研现场已连接。");
    };
    socket.onmessage = (event) => {
      handleRealtimeEvent(JSON.parse(event.data) as SpeakRealtimeServerEvent);
    };
    socket.onerror = () => {
      setStatus("实时连接失败，仍可使用回合制训练。");
      setTrainingMode("standard");
    };
    socket.onclose = () => {
      realtimeSocketRef.current = null;
      setTrainingMode((current) => (current === "realtime" ? "standard" : current));
      pendingAudioFramesRef.current = [];
      pendingRealtimeTranscriptsRef.current = [];
      pendingAudioEndRef.current = false;
    };

    return socket;
  }

  function handleRealtimeEvent(event: SpeakRealtimeServerEvent) {
    if (event.type === "session") {
      setConversationId(event.session.conversationId);
      setStageProgress(event.session.stageProgress);
      setCurrentStage(
        event.session.stageProgress.find((stage) => stage.id === event.session.currentStageId) ||
          event.session.stageProgress[0] ||
          speakStageProgressSeed[0]
      );
      setSegments(event.session.segments || []);
      setQuestions(event.session.questions);
      setDefenseQuestions(event.session.defenseQuestions || []);
      setDefenseOptimization(event.session.defenseOptimization);
      setAiFocusHints(event.session.aiFocusHints || []);
      setReport(event.session.report);
      return;
    }

    if (event.type === "stage_update") {
      setCurrentStage(event.currentStage);
      setStageProgress(event.stageProgress);
      if (event.report) {
        setReport(event.report);
      }
      return;
    }

    if (event.type === "asr_delta") {
      clearAsrFinalizeTimer();
      lastSpeechAtRef.current = Date.now();
      appendSpeechDraft(event.text);
      setStatus(event.final ? "讯飞听写已完成本句识别。" : "讯飞听写识别中。");
      return;
    }

    if (event.type === "role_question") {
      clearAsrFinalizeTimer();
      setQuestions((current) => mergeSpeakQuestion(current, event.question));
      setStatus(`${event.question.roleName}正在追问。`);
      if (!spokenQuestionIdsRef.current.has(event.question.id)) {
        spokenQuestionIdsRef.current.add(event.question.id);
        void playRoleSpeech(event.question.question, event.question.role, {
          auto: true,
          dedupeKey: event.question.id
        });
      }
      return;
    }

    if (event.type === "tts_instruction") {
      return;
    }

    if (event.type === "final_evaluation") {
      clearAsrFinalizeTimer();
      setEvaluation(event.evaluation);
      if (event.report) {
        setReport(event.report);
      }
      onTrainingSaved();
      return;
    }

    if (event.type === "error") {
      clearAsrFinalizeTimer();
      setStatus(event.message);
    }
  }

  async function startRecording() {
    setStatus(
      isSilent
        ? "静音模拟进行中：结束后统一生成书面评价与建议。"
        : "正在监听你的说课。"
    );
    setIsRecording(true);
    isRecordingRef.current = true;
    setSegmentStartedAt(Date.now());
    if (examMode && remainingSec <= 0) {
      setRemainingSec(600);
    }
    if (!isSilent) {
      unlockAudioPlayback();
    }
    lastSpeechAtRef.current = Date.now();
    const latestConfig = isSpeechConfigLoaded
      ? speechConfig
      : (await loadSpeakTrainingConfig()) || speechConfig;
    const shouldUseRealtime = isRealtime;
    // 讯飞实时听写依赖实时 WebSocket。常规练习和静音模拟统一使用浏览器转写，
    // 以便每句识别结果直接回填到演练稿，而不会落入没有消费者的音频帧队列。
    const shouldUseIflytekAsr =
      shouldUseRealtime && latestConfig.asrProvider === "iflytek" && latestConfig.iflytekConfigured;

    if (shouldUseRealtime) {
      openRealtimeSocket();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        setAudioBlob(blob);
        stream.getTracks().forEach((track) => track.stop());
      };
      mediaRecorderRef.current = recorder;
      recorder.start();

      if (shouldUseIflytekAsr) {
        await startPcmStreaming(stream);
      }
    } catch {
      setIsRecording(false);
      setSegmentStartedAt(undefined);
      setStatus("未能打开麦克风，可以直接在转写区输入说课内容。");
      return;
    }

    // 实时模式同时保留浏览器最终转写作为追问兜底：讯飞返回延迟或未收束时，
    // 评委仍能根据浏览器识别出的完整句子及时追问。
    startRecognition();
  }

  function startRecognition() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!Recognition) {
      setStatus(
        isSilent
          ? "当前浏览器不支持语音转写，静音模拟仍可录音并手动输入文稿。"
          : "当前浏览器不支持实时语音识别，请用文本输入或配置生产 ASR。"
      );
      return;
    }

    recognitionRef.current?.abort();
    const recognition = new Recognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let finalText = "";
      let interim = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript || "";

        if (result.isFinal) {
          finalText += text;
        } else {
          interim += text;
        }
      }

      if (finalText.trim()) {
        lastSpeechAtRef.current = Date.now();
        appendSpeechDraft(finalText);
        sendRealtimeTranscript(finalText, true);
      }

      setInterimText(interim);
    };
    recognition.onerror = (event) => {
      if (event.error !== "aborted" && event.error !== "no-speech") {
        setStatus(`语音识别中断：${event.error}`);
      }
    };
    recognition.onend = () => {
      setInterimText("");
      // Chrome 的浏览器转写会在短暂停顿后自然结束；训练仍在录音时自动续接，
      // 让常规练习和静音模拟都能持续把语音写进内容框。
      if (recognitionRef.current === recognition && isRecordingRef.current) {
        window.setTimeout(() => {
          if (recognitionRef.current !== recognition || !isRecordingRef.current) {
            return;
          }
          try {
            recognition.start();
          } catch {
            // 已处于启动状态时无需重复提示，下一次 onend 会继续处理。
          }
        }, 180);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setStatus("浏览器语音转写启动失败，请检查麦克风权限后重试。");
    }
  }

  function stopRecognition() {
    isRecordingRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;
  }

  async function startPcmStreaming(stream: MediaStream) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) {
      setStatus("当前浏览器不支持 WebAudio，无法启用讯飞实时听写。");
      return;
    }

    const audioContext = new AudioContextClass();
    sentAudioFrameCountRef.current = 0;
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    audioContextRef.current = audioContext;
    audioSourceRef.current = source;
    audioProcessorRef.current = processor;
    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      setMicLevel(calculateMicLevel(input));
      const pcm = downsampleTo16kPcm(input, audioContext.sampleRate);
      sentAudioFrameCountRef.current += 1;
      setSentAudioFrameCount(sentAudioFrameCountRef.current);
      sendRealtimeAudioFrame(arrayBufferToBase64(pcm.buffer));
    };
    source.connect(processor);
    processor.connect(audioContext.destination);
    setStatus("讯飞实时听写已启用。");
  }

  function stopPcmStreaming() {
    audioProcessorRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    void audioContextRef.current?.close();
    audioProcessorRef.current = null;
    audioSourceRef.current = null;
    audioContextRef.current = null;
    setMicLevel(0);
  }

  function pauseTraining() {
    setIsRecording(false);
    stopRecognition();
    stopPcmStreaming();
    mediaRecorderRef.current?.stop();
    setStatus(isSilent ? "静音模拟已暂停，可继续或结束本次模拟。" : "已暂停，系统会判断是否需要追问。");

    if (!isSilent && (isRealtime || usesRealtimeIflytekAsr)) {
      if (usesRealtimeIflytekAsr) {
        if (sendRealtimeAudioEnd()) {
          startAsrFinalizeTimer();
        }
      } else {
        const pauseDurationMs = Math.max(2600, Date.now() - lastSpeechAtRef.current);
        sendRealtimeTranscript(draftText.trim(), true, pauseDurationMs);
      }
    }
  }

  function sendRealtimeTranscript(
    text: string,
    final = false,
    pauseDurationMs?: number
  ) {
    const socket = realtimeSocketRef.current;

    if (isSilent || (!isRealtime && !usesRealtimeIflytekAsr) || !text.trim()) {
      return;
    }

    const event = {
      text,
      final,
      pauseDurationMs,
      durationSec: segmentStartedAt
        ? Math.max(1, Math.round((Date.now() - segmentStartedAt) / 1000))
        : undefined
    };

    if (socket?.readyState !== WebSocket.OPEN) {
      pendingRealtimeTranscriptsRef.current.push(event);
      pendingRealtimeTranscriptsRef.current = pendingRealtimeTranscriptsRef.current.slice(-20);
      return;
    }

    socket.send(JSON.stringify({ type: "transcript_delta", ...event }));
  }

  function flushPendingRealtimeTranscripts() {
    const socket = realtimeSocketRef.current;

    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const event of pendingRealtimeTranscriptsRef.current) {
      socket.send(JSON.stringify({ type: "transcript_delta", ...event }));
    }

    pendingRealtimeTranscriptsRef.current = [];
  }

  function sendRealtimeAudioFrame(audio: string) {
    const socket = realtimeSocketRef.current;

    if (!usesRealtimeIflytekAsr || isSilent) {
      return;
    }

    if (socket?.readyState !== WebSocket.OPEN) {
      pendingAudioFramesRef.current.push(audio);

      if (pendingAudioFramesRef.current.length > 80) {
        pendingAudioFramesRef.current = pendingAudioFramesRef.current.slice(-80);
      }

      return;
    }

    socket.send(
      JSON.stringify({
        type: "audio_frame",
        audio,
        sampleRate: 16000
      })
    );
  }

  function sendRealtimeAudioEnd() {
    const socket = realtimeSocketRef.current;

    if (!usesRealtimeIflytekAsr || isSilent) {
      return false;
    }

    if (sentAudioFrameCountRef.current === 0) {
      setStatus("没有采集到麦克风音频，请确认浏览器麦克风权限和系统输入设备。");
      return false;
    }

    if (socket?.readyState !== WebSocket.OPEN) {
      pendingAudioEndRef.current = true;
      return true;
    }

    flushPendingAudioFrames();
    socket.send(JSON.stringify({ type: "audio_end" }));
    return true;
  }

  function startAsrFinalizeTimer() {
    clearAsrFinalizeTimer();
    asrFinalizeTimerRef.current = window.setTimeout(() => {
      setStatus(
        "讯飞仍未返回转写。请确认麦克风有输入；如果刚才只说了很短几个字，建议说满 3 秒后再结束。"
      );
    }, 3000);
  }

  function clearAsrFinalizeTimer() {
    if (asrFinalizeTimerRef.current !== undefined) {
      window.clearTimeout(asrFinalizeTimerRef.current);
      asrFinalizeTimerRef.current = undefined;
    }
  }

  function flushPendingAudioFrames() {
    const socket = realtimeSocketRef.current;

    if (!usesRealtimeIflytekAsr || isSilent || socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const audio of pendingAudioFramesRef.current) {
      socket.send(
        JSON.stringify({
          type: "audio_frame",
          audio,
          sampleRate: 16000
        })
      );
    }

    pendingAudioFramesRef.current = [];

    if (pendingAudioEndRef.current) {
      pendingAudioEndRef.current = false;
      socket.send(JSON.stringify({ type: "audio_end" }));
    }
  }

  async function submitTurn() {
    const transcript = liveText.trim();

    if (!transcript && !audioBlob) {
      setStatus("请先录音或输入一段说课内容。");
      return;
    }

    const submittedDurationSec = segmentStartedAt
      ? Math.max(1, Math.round((Date.now() - segmentStartedAt) / 1000))
      : undefined;
    setIsRecording(false);
    isRecordingRef.current = false;
    setIsTextPracticeActive(false);
    setSegmentStartedAt(undefined);
    setIsSubmitting(true);
    setStatus(isSilent ? "静音模拟已结束，正在生成书面评价与建议。" : "正在生成三角色反馈。");

    try {
      const formData = new FormData();
      formData.append("transcript", transcript);
      formData.append("source", resolveDraftSubmitSource(transcript));
      formData.append("knowledgeBaseIds", JSON.stringify(selectedKnowledgeBaseIds));
      formData.append("currentStageId", currentStage.id);
      if (submittedDurationSec) {
        formData.append(
          "durationSec",
          String(submittedDurationSec)
        );
        formData.append("segmentStartedAt", new Date(Date.now() - submittedDurationSec * 1000).toISOString());
      }

      if (reRecordSegmentId) {
        formData.append("reRecordOfSegmentId", reRecordSegmentId);
      }

      if (retrainFocus) {
        formData.append("retrainTargetStageId", retrainFocus.stageId || currentStage.id);
        formData.append("retrainTitle", retrainFocus.title);
      }

      if (conversationId) {
        formData.append("conversationId", conversationId);
      }

      if (audioBlob) {
        formData.append("audio", audioBlob, "speak-training.webm");
      }

      const response = await fetch("/api/speak-training/turn", {
        method: "POST",
        body: formData
      });
      const payload = (await response.json().catch(() => ({}))) as SpeakTrainingTurnResult & {
        message?: string;
      };

      if (!response.ok) {
        throw new Error(payload.message || "说课训练提交失败。");
      }

      setConversationId(payload.conversationId);
      setCurrentStage(payload.currentStage);
      setStageProgress(payload.stageProgress);
      setSegments(payload.session.segments || []);
      setRoleComments(payload.roleComments);
      setQuestions(isSilent ? [] : payload.questions);
      setDefenseQuestions(isSilent ? [] : payload.defenseQuestions || []);
      setDefenseOptimization(payload.session.defenseOptimization);
      setAiFocusHints(payload.session.aiFocusHints || []);
      setEvaluation(payload.evaluation);
      setReport(payload.report);
      setSummary(payload.summary);
      setRetrainFocus(undefined);
      setRetrainComparisons(retrainFocus ? payload.session.retrainComparisons || [] : []);
      setDraftText("");
      setDraftInputMode("manual");
      setIsTextPracticeActive(false);
      setInterimText("");
      setAudioBlob(undefined);
      setSegmentStartedAt(undefined);
      setReRecordSegmentId(undefined);
      setCoverageHint(undefined);
      setStatus(payload.asrNotice || "本轮反馈已生成。");
      if (!isSilent && payload.tts[0]) {
        void playRoleSpeech(payload.tts[0].text, payload.tts[0].role);
      }
      onTrainingSaved();
    } catch (error) {
      setStatus(formatSpeakRequestError(error, "说课训练提交失败。"));
    } finally {
      setIsSubmitting(false);
    }
  }

  function selectPracticeInputMode(nextMode: SpeakPracticeInputMode) {
    if (nextMode === practiceInputMode || isRecording || isSubmitting) {
      return;
    }

    setPracticeInputMode(nextMode);
    setIsTextPracticeActive(nextMode === "text");

    if (nextMode === "text") {
      setDraftInputMode("manual");
      setStatus("文本练习已就绪：可直接点击输入框输入或粘贴说课内容。");
    } else {
      setStatus("语音说课已就绪：点击“开始说课”后开启录音与转写。");
    }
  }

  function selectTrainingMode(nextMode: SpeakTrainingMode) {
    if (nextMode === trainingMode || isRecording || isSubmitting) {
      return;
    }

    realtimeSocketRef.current?.close();
    realtimeSocketRef.current = null;
    pendingAudioFramesRef.current = [];
    pendingRealtimeTranscriptsRef.current = [];
    pendingAudioEndRef.current = false;
    clearManualRealtimeTimer();
    pendingManualRealtimeDraftRef.current = "";
    lastManualRealtimeDraftRef.current = "";

    if (nextMode === "silent") {
      isRoleAudioMutedRef.current = true;
      window.speechSynthesis?.cancel();
      latestRoleAudioRef.current?.pause();
      if (latestRoleAudioRef.current) {
        latestRoleAudioRef.current.currentTime = 0;
      }
      setQuestions([]);
      setDefenseQuestions([]);
      setResponseText("");
      setRoleComments([]);
      setEvaluation(undefined);
      setReport(undefined);
      setSummary(undefined);
      setStatus("静音模拟已就绪：全程不追问、不播报，结束后生成书面评价与建议。");
    } else if (nextMode === "realtime") {
      isRoleAudioMutedRef.current = false;
      setStatus("实时追问已开启，系统会根据你的说课内容进行临场追问。");
      openRealtimeSocket();
    } else {
      isRoleAudioMutedRef.current = false;
      setStatus("已切换到完整说课：完成后再获取反馈与答辩题。");
    }

    setTrainingMode(nextMode);
  }

  function submitResponse() {
    const text = responseText.trim();
    const targetQuestion =
      activeDefenseDetail?.status === "pending"
        ? activeDefenseDetail
        : pendingQuestion || pendingDefenseQuestion;

    if (!text || !targetQuestion) {
      return;
    }

    const socket = realtimeSocketRef.current;

    if (isRealtime && socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "user_response",
          questionId: targetQuestion.id,
          text
        })
      );
    } else {
      void submitQuestionResponse(targetQuestion.id, text);
    }

    setResponseText("");
  }

  async function submitQuestionResponse(questionId: string, text: string) {
    const socket = realtimeSocketRef.current;

    if (isRealtime && socket?.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          type: "user_response",
          questionId,
          text
        })
      );
      return;
    }

    if (!conversationId) {
      setStatus("请先完成一次完整说课分析，再进入答辩。");
      return;
    }

    try {
      setStatus("正在判分答辩回应。");
      const response = await fetch("/api/speak-training/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          questionId,
          text,
          knowledgeBaseIds: selectedKnowledgeBaseIds
        })
      });
      const payload = (await response.json()) as {
        session?: SpeakTrainingSessionState;
        questions?: SpeakTrainingQuestion[];
        defenseQuestions?: DefenseQuestion[];
        evaluation?: TrainingEvaluation;
        report?: SpeakTrainingReport;
        defenseOptimization?: DefenseOptimizationPlan;
        answeredQuestion?: {
          roleName: string;
          score?: number;
          feedback?: string;
        };
        message?: string;
      };

      if (!response.ok) {
        throw new Error(payload.message || "答辩回应提交失败。");
      }

      if (payload.session) {
        setSegments(payload.session.segments || []);
      }
      setQuestions(payload.questions || []);
      setDefenseQuestions(payload.defenseQuestions || []);
      setDefenseOptimization(payload.defenseOptimization || payload.session?.defenseOptimization);
      setActiveDefenseDetailId(questionId);
      setEvaluation(payload.evaluation);
      setReport(payload.report);
      setStatus(
        payload.answeredQuestion
          ? `${payload.answeredQuestion.roleName}评分 ${payload.answeredQuestion.score ?? "--"} 分：${payload.answeredQuestion.feedback || "已完成点评。"}`
          : "答辩点评已更新。"
      );
      onTrainingSaved();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "答辩回应提交失败。");
    }
  }

  function finishRealtime() {
    if (sendRealtimeAudioEnd()) {
      startAsrFinalizeTimer();
    }
    stopPcmStreaming();
    realtimeSocketRef.current?.send(JSON.stringify({ type: "finish" }));
    setStatus("正在收束本次实时说课训练。");
  }

  function resetTraining() {
    stopRecognition();
    stopPcmStreaming();
    clearAsrFinalizeTimer();
    mediaRecorderRef.current?.stop();
    realtimeSocketRef.current?.close();
    pendingAudioFramesRef.current = [];
    pendingRealtimeTranscriptsRef.current = [];
    pendingAudioEndRef.current = false;
    clearManualRealtimeTimer();
    pendingManualRealtimeDraftRef.current = "";
    lastManualRealtimeDraftRef.current = "";
    sentAudioFrameCountRef.current = 0;
    spokenQuestionIdsRef.current.clear();
    recentSpeechKeysRef.current.clear();
    latestRoleAudioRef.current?.pause();
    latestRoleAudioRef.current = null;
    latestRoleAudioKeyRef.current = "";
    isRoleAudioMutedRef.current = false;
    window.speechSynthesis?.cancel();
    setSentAudioFrameCount(0);
    setMicLevel(0);
    setConversationId(undefined);
    setDraftText("");
    setDraftInputMode("manual");
    setPracticeInputMode("voice");
    setIsTextPracticeActive(false);
    setInterimText("");
    setSegments([]);
    setRoleComments([]);
    setQuestions([]);
    setDefenseQuestions([]);
    setDefenseOptimization(undefined);
    setActiveDefenseDetailId(undefined);
    setAiFocusHints([]);
    setEvaluation(undefined);
    setReport(undefined);
    setIsSpeakReportDocumentOpen(false);
    setSummary(undefined);
    setRetrainFocus(undefined);
    setRetrainComparisons([]);
    setAudioBlob(undefined);
    setCurrentStage(speakStageProgressSeed[0]);
    setStageProgress(speakStageProgressSeed);
    setIsRecording(false);
    setTrainingMode("standard");
    setSelectedExamPaper(undefined);
    setRemainingSec(600);
    setSegmentStartedAt(undefined);
    setReRecordSegmentId(undefined);
    setCoverageHint(undefined);
    setStatus("已重置完整说课训练。");
  }

  function addFavorite(item: Omit<SpeakFavoriteItem, "id" | "createdAt">) {
    setFavoriteItems((current) => {
      const exists = current.some(
        (favorite) =>
          favorite.type === item.type &&
          favorite.title === item.title &&
          favorite.detail === item.detail
      );

      if (exists) {
        return current;
      }

      return [
        {
          ...item,
          id: `favorite_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          createdAt: new Date().toISOString()
        },
        ...current
      ].slice(0, 80);
    });
    setStatus("已加入薄弱收藏。");
  }

  function removeFavorite(id: string) {
    setFavoriteItems((current) => current.filter((item) => item.id !== id));
  }

  function applyTextToDraft(text: string) {
    markManualDraftEdit();
    ensureSegmentTimer();
    setDraftText((current) => `${current}${current ? "\n" : ""}${text}`);
  }

  function startPriorityRetraining() {
    if (!priorityFocus) {
      return;
    }

    const originalSegment = priorityFocus.stageId
      ? [...segments]
          .reverse()
          .find((segment) => segment.stageId === priorityFocus.stageId)
      : undefined;
    const matchingStage = priorityFocus.stageId
      ? stageProgress.find((stage) => stage.id === priorityFocus.stageId)
      : undefined;

    setRetrainFocus({ ...priorityFocus, originalText: originalSegment?.text });
    setRetrainComparisons([]);
    setPracticeInputMode("text");
    setIsTextPracticeActive(true);
    setDraftInputMode("manual");
    setDraftText("");
    setInterimText("");
    setAudioBlob(undefined);
    setReRecordSegmentId(originalSegment?.id);
    setCoverageHint(undefined);
    if (matchingStage) {
      setCurrentStage(matchingStage);
    }
    setStatus(`专项重练已就绪：${priorityFocus.title}。完成后会生成更新后的反馈。`);
    window.requestAnimationFrame(() => draftTextareaRef.current?.focus());
  }

  async function generateOralDraft({
    title,
    text,
    stageId = currentStage.id,
    existingDraft = liveText
  }: {
    title: string;
    text: string;
    stageId?: SpeakStageId;
    existingDraft?: string;
  }) {
    const sourceText = text.trim();

    if (!sourceText) {
      setOralDraftError("当前参考素材为空，无法生成口语表达。");
      return;
    }

    setIsOralizingMaterial(true);
    setOralDraftError("");
    setOralDraft(undefined);

    try {
      const response = await fetch("/api/speak-training/oralize-material", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          materialTitle: title,
          materialText: sourceText,
          currentStageId: stageId,
          currentStageName: getSpeakStageName(stageId),
          existingDraft: existingDraft.trim(),
          examPaper: selectedExamPaper
            ? {
                grade: selectedExamPaper.grade,
                subject: selectedExamPaper.subject,
                topic: selectedExamPaper.topic,
                textbookHint: selectedExamPaper.textbookHint,
                studentHint: selectedExamPaper.studentHint
              }
            : undefined
        })
      });
      const payload = (await response.json().catch(() => ({}))) as {
        oralDraft?: string;
        message?: string;
      };

      if (!response.ok || !payload.oralDraft?.trim()) {
        throw new Error(payload.message || "口语表达生成失败，请稍后重试。");
      }

      setOralDraft({
        sourceTitle: title,
        stageName: getSpeakStageName(stageId),
        text: payload.oralDraft.trim()
      });
      setStatus("已生成口语候选稿，请确认后再应用到演练稿。");
    } catch (error) {
      setOralDraftError(error instanceof Error ? error.message : "口语表达生成失败，请稍后重试。");
    } finally {
      setIsOralizingMaterial(false);
    }
  }

  function appendSpeechDraft(text: string) {
    if (!text.trim()) {
      return;
    }

    setDraftInputMode((current) => {
      if (current === "manual" && !draftText.trim()) {
        return "speech";
      }

      return current === "speech" ? "speech" : "mixed";
    });
    setDraftText((current) => `${current}${text}`);
  }

  function handleDraftTextChange(value: string) {
    markManualDraftEdit(value);
    setInterimText("");
    setDraftText(value);

    if (value.trim()) {
      ensureSegmentTimer();
    } else if (!isRecording) {
      setSegmentStartedAt(undefined);
    }

    scheduleManualRealtimeAnalysis(value);
  }

  function clearManualRealtimeTimer() {
    if (manualRealtimeTimerRef.current) {
      window.clearTimeout(manualRealtimeTimerRef.current);
      manualRealtimeTimerRef.current = undefined;
    }
  }

  function scheduleManualRealtimeAnalysis(value: string) {
    clearManualRealtimeTimer();

    if (!isRealtime || !value.trim()) {
      if (!value.trim()) {
        pendingManualRealtimeDraftRef.current = "";
        lastManualRealtimeDraftRef.current = "";
      }
      return;
    }

    pendingManualRealtimeDraftRef.current = value;
    manualRealtimeTimerRef.current = window.setTimeout(() => {
      manualRealtimeTimerRef.current = undefined;
      flushManualRealtimeTranscript();
    }, 700);
  }

  function flushManualRealtimeTranscript() {
    const nextDraft = pendingManualRealtimeDraftRef.current.trim();

    if (!nextDraft) {
      return;
    }

    const previousDraft = lastManualRealtimeDraftRef.current;
    const delta = nextDraft.startsWith(previousDraft)
      ? nextDraft.slice(previousDraft.length).trim()
      : nextDraft;

    pendingManualRealtimeDraftRef.current = "";
    lastManualRealtimeDraftRef.current = nextDraft;

    if (delta) {
      sendRealtimeTranscript(delta, true);
    }
  }

  function markManualDraftEdit(nextValue = draftText) {
    setDraftInputMode((current) => {
      if (!nextValue.trim()) {
        return "manual";
      }

      return current === "speech" ? "mixed" : current;
    });
  }

  function ensureSegmentTimer() {
    setSegmentStartedAt((current) => current || Date.now());
  }

  function resolveDraftSubmitSource(transcript: string) {
    if (!transcript) {
      return "audio_upload";
    }

    if (draftInputMode === "manual" && !audioBlob) {
      return "text";
    }

    return "browser_asr";
  }

  function restoreArchiveItem(item: SpeakArchiveItem, mode: "append" | "replace") {
    if (mode === "replace") {
      setDraftText(item.text);
      setDraftInputMode("manual");
    } else {
      applyTextToDraft(item.text);
    }
    setCurrentStage(
      stageProgress.find((stage) => stage.id === item.stageId) || currentStage
    );
    setActiveTool("archive");
    setStatus(`已恢复「${item.stageName}」文稿。`);
  }

  function prepareReRecordFromArchive(item: SpeakArchiveItem) {
    setReRecordSegmentId(item.id);
    setCurrentStage(
      stageProgress.find((stage) => stage.id === item.stageId) || currentStage
    );
    setDraftText(item.text);
    setDraftInputMode("manual");
    setActiveTool("archive");
    setStatus(`准备重录「${item.stageName}」。`);
  }

  function exportArchiveText() {
    const content = filteredArchiveItems.length
      ? filteredArchiveItems
          .map(
            (item, index) =>
              `# ${index + 1}. ${item.stageName} ${formatSpeakDuration(item.durationSec)} ${item.wpm}字/分\n${item.text}`
          )
          .join("\n\n")
      : "暂无可导出的说课存档。";
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `说课训练存档-${new Date().toISOString().slice(0, 10)}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function drawExamPaper() {
    const nextPaper =
      speakExamPapers[Math.floor(Math.random() * speakExamPapers.length)] ||
      speakExamPapers[0];
    setSelectedExamPaper(nextPaper);
    setExamMode(true);
    setRemainingSec(600);
    setCurrentStage(speakStageProgressSeed[0]);
    setDraftText("");
    setDraftInputMode("manual");
    setInterimText("");
    setResponseText("");
    setStatus(`已抽取全真套卷：${nextPaper.grade}${nextPaper.subject}「${nextPaper.topic}」。`);
  }

  function startExamSimulation() {
    if (!selectedExamPaper) {
      drawExamPaper();
      return;
    }

    setExamMode(true);
    setRemainingSec(600);
    setDraftText("");
    setDraftInputMode("manual");
    setInterimText("");
    setCurrentStage(speakStageProgressSeed[0]);
    setStatus("全真模拟已就绪：题目资料保留在套卷卡片中，演练稿仅记录你的实际说课内容。");
  }

  async function playRoleSpeech(
    text: string,
    role: SpeakRoleId | "system",
    options: { auto?: boolean; dedupeKey?: string } = {}
  ) {
    const normalizedText = text.replace(/\s+/g, "");

    if (!normalizedText || (options.auto && isRoleAudioMutedRef.current)) {
      return;
    }

    const textKey = `${role}:${normalizedText}`;
    const now = Date.now();
    const recentTextAt = recentSpeechKeysRef.current.get(textKey);

    if (options.auto && recentTextAt && now - recentTextAt < 10000) {
      return;
    }

    if (options.auto) {
      recentSpeechKeysRef.current.set(textKey, now);

      if (options.dedupeKey) {
        recentSpeechKeysRef.current.set(options.dedupeKey, now);
      }
    }

    speechPlaybackRef.current = speechPlaybackRef.current
      .catch(() => undefined)
      .then(async () => {
        if (usesIflytekTts) {
          try {
            const response = await fetch("/api/speak-training/tts", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ text, role })
            });
            const payload = (await response.json()) as {
              audioBase64?: string;
              contentType?: string;
              message?: string;
            };

            if (!response.ok || !payload.audioBase64) {
              throw new Error(payload.message || "讯飞语音合成失败。");
            }

            const audioBlob = base64ToBlob(
              payload.audioBase64,
              payload.contentType || "audio/mpeg"
            );
            const audio = new Audio(URL.createObjectURL(audioBlob));
            latestRoleAudioRef.current = audio;
            latestRoleAudioKeyRef.current = textKey;
            if (options.auto && isRoleAudioMutedRef.current) {
              return;
            }
            await audio.play().catch((error) => {
              if (!options.auto && !isRoleAudioMutedRef.current) {
                speakText(text, role);
                return;
              }

              throw error;
            });
            return;
          } catch (error) {
            setStatus(
              error instanceof Error
                ? `${error.message}，已切换为浏览器语音播报。`
                : "讯飞语音合成失败，已切换为浏览器语音播报。"
            );
            if (!isRoleAudioMutedRef.current) {
              speakText(text, role);
              return;
            }
          }
        }

        if (!options.auto && !isRoleAudioMutedRef.current) {
          speakText(text, role);
        }
      });

    await speechPlaybackRef.current;
  }

  function unlockAudioPlayback() {
    if (audioUnlockedRef.current) {
      return;
    }

    const audio = new Audio(
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA="
    );
    audio.volume = 0;
    audio
      .play()
      .then(() => {
        audio.pause();
        audioUnlockedRef.current = true;
      })
      .catch(() => {
        audioUnlockedRef.current = false;
      });
  }

  async function replayOrSpeakQuestion(text: string, role: SpeakRoleId) {
    if (isSilent) {
      return;
    }

    const textKey = `${role}:${text.replace(/\s+/g, "")}`;

    if (latestRoleAudioRef.current && latestRoleAudioKeyRef.current === textKey) {
      latestRoleAudioRef.current.currentTime = 0;
      await latestRoleAudioRef.current.play().catch(() => playRoleSpeech(text, role));
      return;
    }

    await playRoleSpeech(text, role);
  }

  return (
    <section className="speak-room" aria-label="说课训练室">
      <header className="speak-room-header">
        <div>
          <h1>说课训练室</h1>
          <p>
            {isSilent
              ? "静音模拟：完整说完后，再查看书面评价与建议。"
              : isRealtime
                ? "实时追问：模拟研究员、教研员和专家的临场答辩。"
                : "完整说课：完成后获取角色化反馈与答辩题。"}
          </p>
        </div>
        <div className="speak-room-mode">
          <div className="speak-training-mode-selector" role="radiogroup" aria-label="训练方式">
            {[
              { id: "standard" as const, label: "完整说课" },
              { id: "realtime" as const, label: "实时追问" },
            ].map((mode) => (
              <button
                className={
                  (mode.id === "standard" ? !isRealtime : isRealtime)
                    ? "speak-mode-active"
                    : ""
                }
                type="button"
                role="radio"
                aria-checked={mode.id === "standard" ? !isRealtime : isRealtime}
                disabled={isRecording || isSubmitting}
                key={mode.id}
                onClick={() => selectTrainingMode(mode.id)}
              >
                {mode.id === "realtime" ? <Radio size={16} strokeWidth={2.2} /> : <Mic size={16} strokeWidth={2.2} />}
                <span>{mode.label}</span>
              </button>
            ))}
          </div>
          <label className="speak-silent-switch">
            <input
              type="checkbox"
              checked={isSilent}
              disabled={isRealtime || isRecording || isSubmitting}
              onChange={(event) => selectTrainingMode(event.target.checked ? "silent" : "standard")}
            />
            <span className="speak-silent-switch-copy">
              <strong>静音模拟</strong>
              <small>过程不追问、不播报</small>
            </span>
          </label>
          <div className="speak-room-actions">
            <button type="button" onClick={drawExamPaper}>
              <Sparkles size={18} strokeWidth={2.2} />
              <span>抽取套卷</span>
            </button>
            <button
              className={examMode ? "speak-mode-active" : ""}
              type="button"
              aria-pressed={examMode}
              onClick={() => {
                setExamMode((current) => !current);
                setRemainingSec(600);
              }}
            >
              <Clock3 size={18} strokeWidth={2.2} />
              <span>{examMode ? "全真 10 分钟" : "开启全真模式"}</span>
            </button>
            <button type="button" onClick={resetTraining}>
              <RotateCcw size={18} strokeWidth={2.2} />
              <span>重置</span>
            </button>
          </div>
        </div>
      </header>

      {selectedExamPaper ? (
        <section className="speak-exam-paper" aria-label="全真模拟套卷">
          <div>
            <span>{selectedExamPaper.grade} · {selectedExamPaper.subject}</span>
            <strong>{selectedExamPaper.topic}</strong>
            <p>{selectedExamPaper.textbookHint}</p>
            <p>{selectedExamPaper.studentHint}</p>
          </div>
          <aside>
            <span>结构化答辩题</span>
            <p>{selectedExamPaper.requiredQuestion}</p>
            <button type="button" onClick={startExamSimulation}>
              开始套卷
            </button>
          </aside>
        </section>
      ) : null}

      <div className="speak-room-grid">
        <section className="speak-stage-panel speak-coverage-panel" aria-label="说课结构识别">
          <header>
            <span>说课结构识别</span>
          </header>
          <p className="speak-coverage-intro">
            完整说完后，系统会自动识别你已覆盖的结构和待补内容。
          </p>
          <div className="speak-coverage-list">
            {coverageGroups.map((group) => {
              const progress = Math.max(0, Math.min(100, group.progress));

              return (
                <article
                  className={group.isCovered ? "is-covered" : "is-missing"}
                  key={group.id}
                  style={{ "--coverage-progress": `${progress}%` } as React.CSSProperties}
                >
                  <strong>{group.name}</strong>
                  <div
                    className="speak-coverage-progress"
                    role="progressbar"
                    aria-label={`${group.name}识别进度`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                  >
                    <i style={{ transform: `scaleX(${progress / 100})` }} />
                    <b>{progress}%</b>
                  </div>
                  {group.evidence.length ? (
                    <p>已识别：{group.evidence.join("、")}</p>
                  ) : (
                    <p>等待识别完整说课内容</p>
                  )}
                  {!group.isCovered ? (
                    <button type="button" onClick={() => setCoverageHint(group.supplementPrompt)}>
                      待补：{group.missingSignals.join("、") || "关键内容"}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        </section>

        <section
          className={`speak-transcript-panel speak-primary-workspace ${isSilent ? "is-silent" : ""}`}
          aria-label="说课内容输入"
        >
          <header>
            <div>
              <strong>完整说课内容</strong>
              <span>
                {isSilent
                  ? recognitionSupported
                    ? "浏览器语音转写 · 静音模拟"
                    : "录音 + 手动输入 · 静音模拟"
                  : usesRealtimeIflytekAsr
                  ? "讯飞实时听写"
                  : recognitionSupported
                    ? "浏览器 ASR MVP"
                    : "文本兜底模式"}
              </span>
            </div>
            <span className="speak-status">{status}</span>
          </header>
          <div className="speak-input-method-selector" role="radiogroup" aria-label="说课输入方式">
            <button
              className={practiceInputMode === "voice" ? "is-active" : ""}
              type="button"
              role="radio"
              aria-checked={practiceInputMode === "voice"}
              disabled={isRecording || isSubmitting}
              onClick={() => selectPracticeInputMode("voice")}
            >
              <Mic size={15} strokeWidth={2.2} />
              语音说课
            </button>
            <button
              className={practiceInputMode === "text" ? "is-active" : ""}
              type="button"
              role="radio"
              aria-checked={practiceInputMode === "text"}
              disabled={isRecording || isSubmitting}
              onClick={() => selectPracticeInputMode("text")}
            >
              <NotebookPen size={15} strokeWidth={2.2} />
              文本练习
            </button>
            <span>
              {practiceInputMode === "voice"
                ? "开始说课后自动转写；转写内容可修正。"
                : isTextPracticeActive
                  ? "正在记录文本练习内容。"
                  : "点击开始文本练习后输入内容。"}
            </span>
          </div>
          {isSilent ? (
            <div className="speak-silent-mode-banner" role="status">
              <Mic size={16} strokeWidth={2.2} />
              <div>
                <strong>静音模拟已开启</strong>
                <span>可正常语音输入与转写；不会中途追问或播放角色语音。</span>
              </div>
            </div>
          ) : null}
          {practiceInputMode === "voice" ? (
            <div className="speak-audio-meter" aria-label="麦克风输入状态">
              <span>麦克风</span>
              <div>
                <i style={{ width: `${micLevel}%` }} />
              </div>
              <small>
                {isSilent
                  ? recognitionSupported
                    ? "语音转写中"
                    : "可录音，支持手动输入"
                  : usesRealtimeIflytekAsr
                    ? `已发送 ${sentAudioFrameCount} 帧`
                    : "浏览器识别"}
              </small>
            </div>
          ) : null}
          <div className="speak-exam-strip" aria-label="说课计时和语速">
            <div className={examMode && remainingSec <= 120 ? "warning" : ""}>
              <Clock3 size={16} strokeWidth={2.2} />
              <span>{examMode ? "倒计时" : "练习计时"}</span>
              <strong>{formatSpeakDuration(examMode ? remainingSec : currentSegmentDurationSec)}</strong>
            </div>
            <div className={liveWpm > 260 || (liveWpm > 0 && liveWpm < 130) ? "warning" : ""}>
              <Gauge size={16} strokeWidth={2.2} />
              <span>语速</span>
              <strong>{liveWpm || 0} 字/分</strong>
            </div>
          </div>
          {coverageHint ? (
            <div className="speak-coverage-hint" role="status">
              <span>{coverageHint}</span>
              <button type="button" onClick={() => setCoverageHint(undefined)}>收起</button>
            </div>
          ) : null}
          {retrainFocus ? (
            <section className="speak-retrain-banner" aria-label="专项重练任务">
              <div>
                <span>专项重练</span>
                <strong>{retrainFocus.title}</strong>
                <p>{retrainFocus.practicePrompt}</p>
                {retrainFocus.originalText ? (
                  <small>上一次这一段：{truncateText(retrainFocus.originalText, 96)}</small>
                ) : null}
                {retrainFocus.suggestedText ? (
                  <blockquote>{retrainFocus.suggestedText}</blockquote>
                ) : null}
              </div>
              <button type="button" onClick={() => setRetrainFocus(undefined)}>取消重练</button>
            </section>
          ) : null}
          <textarea
            ref={draftTextareaRef}
            value={liveText}
            className={practiceInputMode === "voice" && !canEditDraft ? "is-locked" : ""}
            readOnly={practiceInputMode === "voice" && !canEditDraft}
            aria-readonly={practiceInputMode === "voice" && !canEditDraft}
            onChange={(event) => handleDraftTextChange(event.target.value)}
            placeholder={
              practiceInputMode === "voice"
                ? "点击“开始说课”后，语音转写会显示在这里。"
                : "点击此处即可输入或粘贴说课内容。"
            }
            rows={8}
          />
          <div className="speak-draft-meta" aria-label="当前文稿状态">
            <span>{draftInputLabel}</span>
            <span>{liveWordCount} 字</span>
          </div>
          <div className="speak-controls">
            {practiceInputMode === "voice" ? (
              <>
                <button
                  className="speak-primary"
                  type="button"
                  disabled={isRecording}
                  onClick={() => void startRecording()}
                >
                  <Play size={18} strokeWidth={2.3} />
                  <span>开始说课</span>
                </button>
                <button type="button" disabled={!isRecording} onClick={pauseTraining}>
                  <Pause size={18} strokeWidth={2.3} />
                  <span>暂停判断</span>
                </button>
              </>
            ) : null}
            {!isRealtime ? (
              <button
                type="button"
                disabled={isSubmitting || !liveText.trim() || (isSilent && isRecording)}
                onClick={() => {
                  setIsRecording(false);
                  stopRecognition();
                  stopPcmStreaming();
                  mediaRecorderRef.current?.stop();
                  if (draftText.trim()) {
                    void submitTurn();
                  } else if (usesRealtimeIflytekAsr && !isSilent) {
                    if (sendRealtimeAudioEnd()) {
                      setStatus("正在整理讯飞转写，通常 1-2 秒。");
                      startAsrFinalizeTimer();
                    }
                  } else {
                    void submitTurn();
                  }
                }}
              >
                <Square size={16} strokeWidth={2.4} />
                <span>{isSubmitting ? "分析中" : "结束并分析"}</span>
              </button>
            ) : null}
            {isRealtime ? (
              <button type="button" onClick={finishRealtime}>
                <Check size={17} strokeWidth={2.4} />
                <span>结束实时训练</span>
              </button>
            ) : null}
          </div>
        </section>

        <aside className="speak-examiner-stack" aria-label="答辩辅助工具">
          <header className="speak-tools-heading">
            <div>
              <span>答辩辅助台</span>
              <strong>评委与提示</strong>
            </div>
            <small>随答辩进程更新</small>
          </header>
          {priorityFocus ? (
            <section className="speak-priority-feedback speak-priority-focus-panel" aria-label="本轮最该改">
              <div className="speak-priority-feedback-heading">
                <span>本轮最该改</span>
                <strong>{priorityFocus.title}</strong>
              </div>
              <p>{priorityFocus.reason}</p>
              <small>{priorityFocus.practicePrompt}</small>
              {latestRetrainComparison ? (
                <div className="speak-retrain-result" aria-label="专项重练结果">
                  <span>刚完成专项重练 · {latestRetrainComparison.stageName}</span>
                  <div>
                    <p>
                      综合评分 <b>{latestRetrainComparison.beforeOverallScore} → {latestRetrainComparison.afterOverallScore}</b>
                      <small className={latestOverallScoreChange && latestOverallScoreChange < 0 ? "is-down" : ""}>
                        {latestOverallScoreChange === 0
                          ? "持平"
                          : `${latestOverallScoreChange && latestOverallScoreChange > 0 ? "提升" : "下降"} ${Math.abs(latestOverallScoreChange || 0)} 分`}
                      </small>
                    </p>
                    {latestRetrainComparison.beforeStageProgress !== undefined && latestRetrainComparison.afterStageProgress !== undefined ? (
                      <p>
                        环节覆盖 <b>{latestRetrainComparison.beforeStageProgress}% → {latestRetrainComparison.afterStageProgress}%</b>
                        <small className={latestStageProgressChange && latestStageProgressChange < 0 ? "is-down" : ""}>
                          {latestStageProgressChange === 0
                            ? "持平"
                            : `${latestStageProgressChange && latestStageProgressChange > 0 ? "提升" : "下降"} ${Math.abs(latestStageProgressChange || 0)}%`}
                        </small>
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <div className="speak-priority-feedback-actions">
                <button className="speak-primary" type="button" onClick={startPriorityRetraining}>
                  立即重练这一段
                  <ChevronRight size={16} strokeWidth={2.4} />
                </button>
              </div>
            </section>
          ) : aiFocusHints.length ? (
            <section className="speak-ai-focus-panel" aria-label="本次说课专业关注点">
              <strong>本次说课专业关注点</strong>
              {aiFocusHints.map((hint) => (
                <article key={`${hint.label}:${hint.sourceEvidence}`}>
                  <span>{hint.label}</span>
                  <p>{hint.detail}</p>
                  <small>{hint.sourceEvidence}</small>
                </article>
              ))}
            </section>
          ) : null}
          <section className="speak-roles-panel" aria-label="专家角色">
            {(["researcher", "teacher", "expert"] as SpeakRoleId[]).map((roleId) => {
              const comment = roleComments.find((item) => item.role === roleId);
              const roleQuestion = questions.find(
                (question) => question.role === roleId && question.status === "pending"
              );
              const meta = speakRoleMeta[roleId];

              return (
                <article className={`speak-role ${roleId}`} key={roleId}>
                  <header>
                    <span>{meta.compact}</span>
                    <div>
                      <strong>{comment?.name || meta.label}</strong>
                      <small>
                        {report?.examinerScores.find((score) => score.role === roleId)?.focus ||
                          comment?.voiceStyle ||
                          "等待发言"}
                      </small>
                    </div>
                    {report?.examinerScores.find((score) => score.role === roleId) ? (
                      <b>{report.examinerScores.find((score) => score.role === roleId)?.score}</b>
                    ) : null}
                  </header>
                  <p>
                    {roleQuestion?.question ||
                      comment?.comment ||
                      "完成完整说课后，这里会给出角色化反馈。"}
                  </p>
                  <small>
                    {roleQuestion?.reason ||
                      report?.examinerScores.find((score) => score.role === roleId)?.deductions[0] ||
                      comment?.suggestion ||
                      comment?.focus ||
                      " "}
                  </small>
                  {!isSilent && (roleQuestion || comment?.question) ? (
                    <button
                      type="button"
                      onClick={() =>
                        void replayOrSpeakQuestion(
                          roleQuestion?.question || comment?.question || "",
                          roleId
                        )
                      }
                    >
                      <Volume2 size={15} strokeWidth={2.2} />
                      播放追问
                    </button>
                  ) : null}
                </article>
              );
            })}
          </section>

        <section className="speak-advice-panel" aria-label="话术提醒与纠错">
          <header>
            <strong>话术提醒</strong>
            <span>
              {isSilent && !report
                ? "结束后查看"
                : riskWarnings.length || allAnnotations.length
                ? `${riskWarnings.length + allAnnotations.length} 条`
                : "待提交"}
            </span>
          </header>
          <div className="speak-advice-body">
            {isSilent && !report ? (
              <div className="speak-silent-notice">
                <Mic size={16} strokeWidth={2.2} />
                <div>
                  <strong>静音模拟进行中</strong>
                  <p>过程提示和风险记录将在结束后，与评价建议一起呈现。</p>
                </div>
              </div>
            ) : (
              <>
                <div className="speak-risk-slot">
                  {riskWarnings.length ? (
                  <div className="speak-risk-panel" aria-label="高频雷区预警">
                    {riskWarnings.slice(0, 3).map((risk) => (
                      <article className={risk.severity} key={risk.id}>
                        <AlertTriangle size={15} strokeWidth={2.2} />
                        <div>
                          <strong>{risk.title}</strong>
                          <p>{risk.detail}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                  ) : null}
                </div>
                {allAnnotations.length ? (
                  <div className="speak-annotation-list" aria-label="实时纠错标注">
                    {allAnnotations.slice(0, 5).map((annotation) => (
                      <article className={annotation.severity} key={annotation.id}>
                        <AlertTriangle size={15} strokeWidth={2.2} />
                        <div>
                          <strong>{annotation.message}</strong>
                          <p>{annotation.suggestion}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="speak-annotation-empty">
                    <Check size={15} strokeWidth={2.2} />
                    <span>提交后会标注口语化、术语、逻辑和缺漏问题。</span>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        <section className="speak-feedback-panel" aria-label="训练反馈">
          <header>
            <strong>复盘报告</strong>
            <span>
              {report
                ? `${report.overallScore} 分 · ${report.pass ? "达线" : "待提升"}`
                : evaluation
                  ? `${evaluation.overallScore} 分`
                  : "等待评价"}
            </span>
          </header>
          {report ? (
            <div className="speak-report-document-area">
              <button className="speak-report-document" type="button" onClick={() => setIsSpeakReportDocumentOpen(true)}>
                <FileText size={34} strokeWidth={1.9} />
                <span>
                  <strong>复盘报告.docx</strong>
                  <small>{report.overallScore} 分 · {report.pass ? "达到训练目标" : "建议继续专项训练"}</small>
                </span>
                <ChevronRight size={18} strokeWidth={2.2} />
              </button>
              <p>点击文档查看完整缺漏、扣分点、训练建议和话术优化。</p>
            </div>
          ) : summary ? (
            <div className="speak-summary">
              <p>{summary.teachingLogic}</p>
              <p>{summary.objectiveRationality}</p>
              <ul>{summary.improvementAdvice.map((item) => <li key={item}>{item}</li>)}</ul>
            </div>
          ) : (
            <p className="speak-empty">提交第一段后会生成教学逻辑、目标合理性与改进建议。</p>
          )}
          {evaluation && !report ? (
            <div className="speak-evaluation-compact">
              {evaluation.dimensions.map((dimension) => (
                <div key={dimension.name}>
                  <span>{dimension.name}</span>
                  <i><b style={{ width: `${dimension.score}%` }} /></i>
                  <strong>{dimension.score}</strong>
                </div>
              ))}
            </div>
          ) : null}
          {evaluation ? (
            <CitationPanel
              citations={evaluation.citations}
              onOpenMaterials={onOpenMaterials}
            />
          ) : null}
        </section>
        </aside>

        <section className="speak-question-panel" aria-label="追问队列">
          <header>
            <div>
              <strong>追问与答辩</strong>
              <span>
                {isSilent
                  ? report
                    ? "静音模拟已完成"
                    : "静音模拟进行中"
                  : activeDefenseQuestion
                    ? "等待回应"
                    : "节奏正常"}
              </span>
            </div>
            <div className={`speak-defense-current ${activeDefenseRole ? activeDefenseQuestion?.role : "idle"}`}>
              <span aria-hidden="true">{activeDefenseRole?.compact || "问"}</span>
              <div>
                <small>{activeDefenseRole ? "当前发问" : "评委席"}</small>
                <strong>{activeDefenseRole?.label || "等待下一轮追问"}</strong>
              </div>
            </div>
          </header>
          {activeDefenseDetail ? (
            <div className="speak-defense-detail">
              <button className="speak-defense-back" type="button" onClick={() => setActiveDefenseDetailId(undefined)}>
                ← 返回问题列表{pendingDefenseCount ? `（还剩 ${pendingDefenseCount} 题）` : ""}
              </button>
              <article className={activeDefenseDetail.status}>
                <span>{formatDefenseQuestionLabel(activeDefenseDetail)}</span>
                <strong>{activeDefenseDetail.question}</strong>
                <small>{formatDefenseQuestionNote(activeDefenseDetail)}</small>
              </article>
              {activeDefenseDetail.status === "pending" && !isSilent ? (
                <div className="speak-response">
                  <textarea
                    value={responseText}
                    onChange={(event) => setResponseText(event.target.value)}
                    placeholder="回应当前追问..."
                    rows={3}
                  />
                  <button type="button" onClick={submitResponse}>回应追问</button>
                </div>
              ) : (
                <div className="speak-defense-answer">
                  <span>你的回答</span>
                  <p>{activeDefenseDetail.answer || "本题尚未记录回答。"}</p>
                  {activeDefenseDetail.feedback ? <small>{activeDefenseDetail.feedback}</small> : null}
                </div>
              )}
              {activeDefenseOptimization ? (
                <section className="speak-defense-optimization" aria-label="本题答辩复盘">
                  <header>
                    <div><span>本题复盘</span><strong>{activeDefenseOptimization.target}</strong></div>
                    {activeDefenseDetail.score !== undefined ? <small>{activeDefenseDetail.score} 分</small> : null}
                  </header>
                  <p><b>原文定位：</b>{activeDefenseOptimization.originalEvidence}</p>
                  <p><b>本次问答：</b>{activeDefenseOptimization.answerDiagnosis}</p>
                  <p><b>你可以这样改：</b>{activeDefenseOptimization.revisionPlan}</p>
                  <p className="speak-defense-replacement"><b>课堂上可直接这样说：</b>{activeDefenseOptimization.replacementScript}</p>
                  <ul>{activeDefenseOptimization.preparationActions.map((action) => <li key={action}>{action}</li>)}</ul>
                </section>
              ) : null}
            </div>
          ) : (
            <>
              <div className="speak-question-list">
                {isSilent ? (
                  <p className="speak-empty">{report ? "本轮静音模拟仅生成书面评价，请查看复盘报告中的扣分点与专项建议。" : "静音模拟期间不安排中途追问，结束后统一生成书面评价与建议。"}</p>
                ) : defenseQuestionItems.length ? (
                  defenseQuestionItems.map((question) => (
                    <article className={question.status} key={question.id}>
                      <span>{formatDefenseQuestionLabel(question)}</span>
                      <p>{question.question}</p>
                      <small>{formatDefenseQuestionNote(question)}</small>
                      <div className="speak-question-actions">
                        <button type="button" onClick={() => setActiveDefenseDetailId(question.id)}>
                          {question.status === "answered" ? "查看复盘" : "进入回答"}
                        </button>
                        <button type="button" onClick={() => void replayOrSpeakQuestion(question.question, question.role)}><Volume2 size={15} strokeWidth={2.2} />播放追问</button>
                        <button type="button" onClick={() => addFavorite({ type: "question", title: `${question.roleName}追问`, detail: question.question, stageId: "targetDimension" in question ? undefined : currentStage.id })}><Bookmark size={15} strokeWidth={2.2} />收藏</button>
                      </div>
                    </article>
                  ))
                ) : (
                  <p className="speak-empty">完成完整说课后会生成追问和 3-5 道答辩题。</p>
                )}
              </div>
              {defenseOptimization?.items.length ? <p className="speak-defense-summary">已完成 {defenseOptimization.items.length} 题复盘，点击“查看复盘”可回看具体修改建议。</p> : null}
            </>
          )}
        </section>



        {report && isSpeakReportDocumentOpen ? (
          <div
            className="speak-report-modal"
            role="dialog"
            aria-modal="true"
            aria-label="复盘报告文档预览"
          >
            <div className="speak-report-document-preview">
              <header>
                <div>
                  <span>复盘报告.docx</span>
                  <strong>说课训练复盘报告</strong>
                </div>
                <button type="button" onClick={() => setIsSpeakReportDocumentOpen(false)}>
                  <X size={18} strokeWidth={2.2} />
                  关闭
                </button>
              </header>
              <div className="speak-report-document-content">
                <section>
                  <h3>综合结果</h3>
                  <p>
                    本轮综合得分 {report.overallScore} 分，
                    {report.pass ? "已达到本轮训练目标。" : "本轮还有需要补强的环节。"}
                  </p>
                </section>
                <section>
                  <h3>缺漏环节</h3>
                  <p>{report.missingStages.length ? report.missingStages.join("、") : "暂无明显缺漏。"}</p>
                </section>
                <section>
                  <h3>阶段覆盖与证据</h3>
                  <div className="speak-report-stage-coverage">
                    {(report.stageCoverage || []).map((stage) => (
                      <article className={stage.status} key={stage.id}>
                        <header>
                          <strong>{stage.name}</strong>
                          <span>{stage.progress}%</span>
                        </header>
                        <p>
                          {stage.evidence.length
                            ? `证据：${stage.evidence.join("、")}`
                            : `待补：${stage.missingSignals.join("、") || "阶段证据"}`}
                        </p>
                        <small>{stage.action}</small>
                      </article>
                    ))}
                  </div>
                </section>
                <section>
                  <h3>证据链</h3>
                  <div className="speak-report-evidence-chain">
                    {(report.evidenceChains || []).slice(0, 6).map((chain) => (
                      <article key={`${chain.stageName}-${chain.evidence}`}>
                        <strong>{chain.stageName}</strong>
                        <p>{chain.evidence}</p>
                        <span>{chain.diagnosis}</span>
                        <small>{chain.suggestion}</small>
                      </article>
                    ))}
                  </div>
                </section>
                <section>
                  <h3>逻辑断点、术语问题与答辩风险</h3>
                  <ul>
                    {[
                      ...(report.logicBreakpoints || []),
                      ...(report.termIssues || []),
                      ...(report.defenseRisks || [])
                    ].length ? (
                      [
                        ...(report.logicBreakpoints || []),
                        ...(report.termIssues || []),
                        ...(report.defenseRisks || [])
                      ].map((item) => <li key={item}>{item}</li>)
                    ) : (
                      <li>暂无明显逻辑断点、术语问题或答辩风险。</li>
                    )}
                  </ul>
                </section>
                <section>
                  <h3>扣分点</h3>
                  <ul>
                    {report.lostPoints.map((item) => (
                      <li key={item}>
                        <span>{item}</span>
                        <button
                          type="button"
                          onClick={() =>
                            addFavorite({
                              type: "deduction",
                              title: "复盘扣分点",
                              detail: item,
                              stageId: currentStage.id
                            })
                          }
                        >
                          收藏
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>专项训练推荐</h3>
                  <ul>
                    {report.recommendedDrills.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>话术优化</h3>
                  {report.optimizedPhrases.length ? (
                    report.optimizedPhrases.map((item) => (
                      <article key={item.original}>
                        <span>{item.original}</span>
                        <p>{item.optimized}</p>
                        <button type="button" onClick={() => applyTextToDraft(item.optimized)}>
                          采用此表达
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            addFavorite({
                              type: "phrase",
                              title: "话术优化",
                              detail: `${item.original} -> ${item.optimized}`,
                              stageId: currentStage.id
                            })
                          }
                        >
                          收藏
                        </button>
                      </article>
                    ))
                  ) : (
                    <p>本轮暂无典型低分话术，可继续提交更完整说课稿。</p>
                  )}
                </section>
                <section>
                  <h3>考官维度评分</h3>
                  <ul>
                    {report.examinerScores.map((score) => (
                      <li key={score.role}>
                        <strong>{score.roleName}：{score.score} 分</strong>
                        <span>{score.focus}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
          </div>
        ) : null}

      </div>
    </section>
  );
}

function mergeSpeakQuestion(
  questions: SpeakTrainingQuestion[],
  nextQuestion: SpeakTrainingQuestion
) {
  return questions.some((question) => question.id === nextQuestion.id)
    ? questions.map((question) =>
        question.id === nextQuestion.id ? nextQuestion : question
      )
    : [...questions, nextQuestion];
}

function formatDefenseQuestionLabel(question: SpeakTrainingQuestion | DefenseQuestion) {
  if ("targetDimension" in question) {
    const sourceLabel =
      question.source === "weakness"
        ? "薄弱项专项"
        : question.source === "followup"
          ? "答辩追问"
          : question.source === "ai"
            ? "基于你的说课内容"
            : "通用答辩";
    return `${question.roleName} · ${sourceLabel} · ${question.targetDimension}`;
  }

  return `${question.roleName} · 根据本轮说课`;
}

function formatDefenseQuestionNote(question: SpeakTrainingQuestion | DefenseQuestion) {
  if ("reason" in question) {
    return question.reason;
  }

  if (question.source === "ai") {
    return question.sourceEvidence || "AI 已根据你的说课内容生成本题。";
  }

  return question.feedback || (question.level === "advanced"
    ? "拔高追问，考查理论迁移与临场应变。"
    : "结构化答辩真题。");
}

function getSpeakStageName(stageId: SpeakStageId) {
  return speakStageSeedMeta.find((stage) => stage.id === stageId)?.name || "说课阶段";
}

function favoriteTypeLabel(type: SpeakFavoriteItem["type"]) {
  const labels: Record<SpeakFavoriteItem["type"], string> = {
    question: "答辩问题",
    stage: "薄弱模块",
    deduction: "扣分点",
    phrase: "话术",
    material: "素材",
    segment: "文稿"
  };

  return labels[type];
}

function readSpeakFavorites() {
  try {
    const raw = accountStorage.getItem("speak-training-favorites");
    const parsed = raw ? (JSON.parse(raw) as SpeakFavoriteItem[]) : [];
    return Array.isArray(parsed) ? parsed.filter(isSpeakFavoriteItem) : [];
  } catch {
    return [];
  }
}

function readSpeakArchive() {
  try {
    const raw = accountStorage.getItem("speak-training-archive");
    const parsed = raw ? (JSON.parse(raw) as SpeakArchiveItem[]) : [];
    return Array.isArray(parsed) ? parsed.filter(isSpeakArchiveItem) : [];
  } catch {
    return [];
  }
}

function mergeArchiveItems(
  current: SpeakArchiveItem[],
  segments: SpeakTrainingSegment[],
  conversationId?: string
) {
  const archiveMap = new Map(current.map((item) => [item.id, item]));

  for (const segment of segments) {
    archiveMap.set(segment.id, {
      id: segment.id,
      conversationId,
      stageId: segment.stageId,
      stageName: getSpeakStageName(segment.stageId),
      text: segment.text,
      durationSec: segment.durationSec,
      wpm: segment.wpm,
      annotationCount: segment.annotations?.length || 0,
      createdAt: segment.createdAt
    });
  }

  return [...archiveMap.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 120);
}

function isSpeakFavoriteItem(value: unknown): value is SpeakFavoriteItem {
  const item = value as SpeakFavoriteItem;
  return (
    typeof item?.id === "string" &&
    typeof item.title === "string" &&
    typeof item.detail === "string" &&
    typeof item.createdAt === "string"
  );
}

function isSpeakArchiveItem(value: unknown): value is SpeakArchiveItem {
  const item = value as SpeakArchiveItem;
  return (
    typeof item?.id === "string" &&
    typeof item.text === "string" &&
    typeof item.stageName === "string" &&
    typeof item.createdAt === "string"
  );
}

function buildSpeakRiskWarnings(input: {
  text: string;
  stageProgress: SpeakStageProgress[];
  liveWpm: number;
  examMode: boolean;
  remainingSec: number;
}) {
  const text = input.text.replace(/\s+/g, "");
  const risks: SpeakRiskWarning[] = [];

  if (text.length > 80 && !/学生|学情|差异|基础|困难|已有经验/.test(text)) {
    risks.push({
      id: "risk_no_student",
      title: "只讲知识，缺少学生",
      detail: "说课练习中需要说明学生已有基础、学习困难和支架安排。",
      severity: "warning"
    });
  }

  if (/活动|讨论|探究|小组/.test(text) && !/分钟|任务|产出|展示|反馈/.test(text)) {
    risks.push({
      id: "risk_activity_empty",
      title: "活动缺少执行细节",
      detail: "补充任务、时间、分组、产出和教师反馈，避免活动停留在口号。",
      severity: "warning"
    });
  }

  if (/核心素养|建构主义|最近发展区|新课改/.test(text) && !/通过|经历|观察|表达|迁移|反思|操作/.test(text)) {
    risks.push({
      id: "risk_theory_label",
      title: "理论标签化",
      detail: "理论术语后要接学生学习行为，否则容易被教育学专家追问。",
      severity: "warning"
    });
  }

  if (input.stageProgress.some((stage) => stage.status === "missing")) {
    risks.push({
      id: "risk_missing_stage",
      title: "模块缺漏",
      detail: "左侧出现缺漏模块，完整说课需要覆盖九个核心环节。",
      severity: "error"
    });
  }

  if (input.liveWpm > 260) {
    risks.push({
      id: "risk_speed_fast",
      title: "语速过快",
      detail: "当前语速超过 260 字/分，建议放慢关键句并保留停顿。",
      severity: "warning"
    });
  }

  if (input.examMode && input.remainingSec <= 120) {
    risks.push({
      id: "risk_exam_time",
      title: "全真倒计时进入收束",
      detail: "剩余 2 分钟内建议快速补齐评价和教学反思。",
      severity: "warning"
    });
  }

  return risks;
}

function formatSpeakRequestError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";

  if (/load failed|failed to fetch|networkerror|network request failed|fetch failed/i.test(message)) {
    return "说课训练提交失败：本地服务暂时未连接，请确认项目已启动后重试。";
  }

  return message || fallback;
}

function formatSpeakDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "0:00";
  }

  const minute = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minute}:${String(rest).padStart(2, "0")}`;
}

function countSpeakWords(text: string) {
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const words = text
    .replace(/[\u4e00-\u9fa5]/g, " ")
    .split(/\s+/)
    .filter(Boolean).length;
  return chineseChars + words;
}

function speakText(text: string, role: SpeakRoleId | "system") {
  if (!("speechSynthesis" in window) || !text.trim()) {
    return;
  }

  window.speechSynthesis.cancel();
  window.speechSynthesis.resume();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  const voices = window.speechSynthesis.getVoices();
  const zhVoice =
    voices.find((voice) => /zh|Chinese|中文/i.test(`${voice.lang} ${voice.name}`)) ||
    voices[0];

  if (zhVoice) {
    utterance.voice = zhVoice;
  }

  if (role === "researcher") {
    utterance.rate = 0.82;
    utterance.pitch = 0.82;
  } else if (role === "expert") {
    utterance.rate = 0.9;
    utterance.pitch = 0.92;
  } else {
    utterance.rate = 1;
    utterance.pitch = 1;
  }

  window.speechSynthesis.speak(utterance);
}

function downsampleTo16kPcm(samples: Float32Array, sourceRate: number) {
  const targetRate = 16000;

  if (sourceRate === targetRate) {
    return floatTo16BitPcm(samples);
  }

  const ratio = sourceRate / targetRate;
  const outputLength = Math.floor(samples.length / ratio);
  const output = new Float32Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(Math.floor((index + 1) * ratio), samples.length);
    let total = 0;
    let count = 0;

    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      total += samples[inputIndex];
      count += 1;
    }

    output[index] = count ? total / count : samples[start] || 0;
  }

  return floatTo16BitPcm(output);
}

function floatTo16BitPcm(samples: Float32Array) {
  const output = new Int16Array(samples.length);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output;
}

function calculateMicLevel(samples: Float32Array) {
  let sum = 0;

  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }

  const rms = Math.sqrt(sum / Math.max(samples.length, 1));
  return Math.min(100, Math.round(rms * 420));
}

function arrayBufferToBase64(buffer: ArrayBufferLike) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }

  return window.btoa(binary);
}

function base64ToBlob(base64: string, contentType: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Blob([bytes], { type: contentType });
}

function EvaluationPanel({ evaluation }: { evaluation?: TrainingEvaluation }) {
  return (
    <section className="evaluation-card" aria-label="训练评价">
      <header className="section-heading">
        <Target size={17} strokeWidth={2.2} />
        <h3>训练评价</h3>
      </header>
      {evaluation ? (
        <>
          <div className="evaluation-score">
            <strong>{evaluation.overallScore}</strong>
            <span>{evaluation.trainingType}</span>
          </div>
          <div className="evaluation-dimensions">
            {evaluation.dimensions.map((dimension) => (
              <div className="dimension-row" key={dimension.name}>
                <span>{dimension.name}</span>
                <div className="dimension-track">
                  <i style={{ width: `${dimension.score}%` }} />
                </div>
                <strong>{dimension.score}</strong>
              </div>
            ))}
          </div>
          <div className="evaluation-notes">
            {evaluation.diagnosis.slice(0, 2).map((item) => (
              <p key={item}>{item}</p>
            ))}
            <strong>下一步：{evaluation.nextTask}</strong>
          </div>
        </>
      ) : (
        <p className="evaluation-empty">训练完成后会自动生成结构化评价。</p>
      )}
    </section>
  );
}

function ClassroomRecordCard({ message }: { message: ChatMessage }) {
  return (
    <div className="classroom-record-card">
      <EvaluationPanel evaluation={message.evaluation} />
      <MessageMarkdown text={message.content || ""} />
    </div>
  );
}

type ComposerProps = {
  attachments: Attachment[];
  attachmentError?: string;
  enableThinking: boolean;
  inputValue: string;
  isGenerating: boolean;
  knowledgeBases: KnowledgeBase[];
  knowledgePanelRequestKey: number;
  knowledgeSelectionMode?: "lesson-guided";
  knowledgeUploadStatus?: string;
  placeholder?: string;
  ariaLabel?: string;
  selectedKnowledgeBaseIds: string[];
  /** 输入框下方的模型选择器，由外层注入，Composer 自己不关心模型从哪来。 */
  modelSlot?: React.ReactNode;
  onAttachFiles: (files: FileList | null) => void;
  onChangeInput: (value: string) => void;
  onClearKnowledgeBases: () => void;
  onConfirmKnowledgeSelection: () => boolean;
  onRemoveAttachment: (id: string) => void;
  onSend: () => void;
  onOpenVoice: () => void;
  onSkipKnowledgeSelection: () => void;
  onToggleKnowledgeBase: (id: string) => void;
  onToggleThinking: () => void;
  onUploadKnowledgeDocument: (baseId: string, file: File) => void;
};

function Composer({
  attachments,
  attachmentError,
  enableThinking,
  inputValue,
  isGenerating,
  knowledgeBases,
  knowledgePanelRequestKey,
  knowledgeSelectionMode,
  knowledgeUploadStatus,
  placeholder = "输入教学任务",
  ariaLabel = "教学任务输入",
  selectedKnowledgeBaseIds,
  modelSlot,
  onAttachFiles,
  onChangeInput,
  onClearKnowledgeBases,
  onConfirmKnowledgeSelection,
  onRemoveAttachment,
  onSend,
  onOpenVoice,
  onSkipKnowledgeSelection,
  onToggleKnowledgeBase,
  onToggleThinking,
  onUploadKnowledgeDocument
}: ComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const knowledgeFileInputRef = useRef<HTMLInputElement>(null);
  const [isKnowledgePanelOpen, setIsKnowledgePanelOpen] = useState(false);
  const [knowledgePanelError, setKnowledgePanelError] = useState<string | undefined>();
  const [uploadTargetBaseId, setUploadTargetBaseId] = useState("");
  const isLessonKnowledgeMode = knowledgeSelectionMode === "lesson-guided";
  const selectedKnowledgeBases = knowledgeBases.filter((base) =>
    selectedKnowledgeBaseIds.includes(base.id)
  );
  const canSend =
    !isGenerating && (inputValue.trim().length > 0 || attachments.length > 0);
  useEffect(() => {
    if (!uploadTargetBaseId && knowledgeBases[0]) {
      setUploadTargetBaseId(knowledgeBases[0].id);
    }
  }, [knowledgeBases, uploadTargetBaseId]);

  useEffect(() => {
    if (knowledgePanelRequestKey > 0) {
      setIsKnowledgePanelOpen(true);
    }
  }, [knowledgePanelRequestKey]);

  useEffect(() => {
    if (selectedKnowledgeBaseIds.length) {
      setKnowledgePanelError(undefined);
    }
  }, [selectedKnowledgeBaseIds]);

  useEffect(() => {
    if (!isKnowledgePanelOpen) {
      return;
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsKnowledgePanelOpen(false);
        setKnowledgePanelError(undefined);
      }
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isKnowledgePanelOpen]);

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    onAttachFiles(event.target.files);
    event.target.value = "";
  }

  function handleKnowledgeFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (file && uploadTargetBaseId) {
      onUploadKnowledgeDocument(uploadTargetBaseId, file);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  }

  function closeKnowledgePanel() {
    setIsKnowledgePanelOpen(false);
    setKnowledgePanelError(undefined);
  }

  function handleCompleteKnowledgeSelection() {
    if (isLessonKnowledgeMode) {
      if (!selectedKnowledgeBaseIds.length) {
        setKnowledgePanelError(
          "当前还没有选中知识库，请先选择知识库，或选择“不引用，继续”。"
        );
        return;
      }

      if (onConfirmKnowledgeSelection()) {
        closeKnowledgePanel();
      } else {
        setKnowledgePanelError("当前没有等待知识库选择的教案步骤，请返回对话继续。");
      }
      return;
    }

    closeKnowledgePanel();
  }

  function handleSkipKnowledgeSelection() {
    onSkipKnowledgeSelection();
    closeKnowledgePanel();
  }

  return (
    <section className="composer-stack" aria-label={ariaLabel}>
      {selectedKnowledgeBases.length ? (
        <div className="knowledge-chip-list" aria-label="已选择知识库">
          {selectedKnowledgeBases.map((base) => (
            <span className="knowledge-chip" key={base.id}>
              <Database size={15} strokeWidth={2} />
              <span>{base.name}</span>
              <button
                type="button"
                aria-label={`移除知识库 ${base.name}`}
                onClick={() => onToggleKnowledgeBase(base.id)}
              >
                <X size={13} strokeWidth={2.3} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {attachments.length ? (
        <div className="attachment-list" aria-label="已选择文件">
          {attachments.map((attachment) => (
            <span className="attachment-chip" key={attachment.id}>
              <FileText size={16} strokeWidth={2} />
              <span>{attachment.name}</span>
              <small>{formatFileSize(attachment.size)}</small>
              <button
                type="button"
                aria-label={`移除 ${attachment.name}`}
                onClick={() => onRemoveAttachment(attachment.id)}
              >
                <X size={14} strokeWidth={2.3} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {attachmentError ? (
        <p className="attachment-error" role="alert">
          {attachmentError}
        </p>
      ) : null}
      <div className="composer">
        <textarea
          className="composer-input"
          value={inputValue}
          onChange={(event) => onChangeInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={isGenerating}
          rows={4}
        />

        <div className="composer-actions">
          <div className="composer-left-actions">
            <input
              className="file-input"
              ref={fileInputRef}
              type="file"
              accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.csv,.json,image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/markdown,text/csv,application/json"
              multiple
              onChange={handleFileChange}
            />
            <input
              className="file-input"
              ref={knowledgeFileInputRef}
              type="file"
              accept=".pdf,.txt,.md,.csv,.json,application/pdf,text/plain,text/markdown,text/csv,application/json"
              onChange={handleKnowledgeFileChange}
            />
            <button
              className={`soft-button ${attachments.length ? "soft-button-active" : ""}`}
              type="button"
              aria-pressed={attachments.length > 0}
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={22} strokeWidth={2.25} />
              <span>上传文件</span>
            </button>
            <button
              className={`soft-button ${
                isKnowledgePanelOpen || selectedKnowledgeBaseIds.length
                  ? "soft-button-active"
                  : ""
              }`}
              type="button"
              aria-expanded={isKnowledgePanelOpen}
              aria-pressed={selectedKnowledgeBaseIds.length > 0}
              onClick={() => {
                setKnowledgePanelError(undefined);
                setIsKnowledgePanelOpen((value) => !value);
              }}
            >
              <AtSign size={22} strokeWidth={2.25} />
              <span>知识库</span>
            </button>
            {createPortal(
              <AnimatePresence>
                {isKnowledgePanelOpen ? (
                    <motion.div
                      className="knowledge-popover"
                      initial={{ opacity: 0, y: 8, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 8, scale: 0.98 }}
                      transition={{ duration: 0.16, ease: "easeOut" }}
                    >
                  <header className="knowledge-popover-header">
                    <span>
                      <strong>
                        {isLessonKnowledgeMode ? "为本次教案选择知识库" : "引用知识库"}
                      </strong>
                      <small>
                        {isLessonKnowledgeMode
                          ? "完成选择后继续教案信息采集"
                          : "只影响本次提问"}
                      </small>
                    </span>
                    <button
                      className="knowledge-popover-close"
                      type="button"
                      aria-label="关闭知识库选择"
                      onClick={closeKnowledgePanel}
                    >
                      <X size={15} strokeWidth={2.4} />
                    </button>
                  </header>
                  <div className="knowledge-popover-list">
                    {knowledgeBases.length ? (
                      knowledgeBases.map((base) => {
                        const isSelected = selectedKnowledgeBaseIds.includes(base.id);

                        return (
                          <button
                            className={`knowledge-option ${
                              isSelected ? "knowledge-option-active" : ""
                            }`}
                            type="button"
                            key={base.id}
                            onClick={() => {
                              setKnowledgePanelError(undefined);
                              onToggleKnowledgeBase(base.id);
                            }}
                          >
                            <Database size={17} strokeWidth={2.1} />
                            <span>
                              <strong>{base.name}</strong>
                              <small>{formatKnowledgeCount(base)}</small>
                            </span>
                            {isSelected ? <Check size={16} strokeWidth={2.4} /> : null}
                          </button>
                        );
                      })
                    ) : (
                      <p className="knowledge-empty">暂无知识库</p>
                    )}
                  </div>
                  {knowledgePanelError ? (
                    <p className="knowledge-panel-error" role="alert">
                      {knowledgePanelError}
                    </p>
                  ) : null}
                  <div className="knowledge-upload-box">
                    <label>
                      <span>上传到知识库</span>
                      <select
                        value={uploadTargetBaseId}
                        onChange={(event) => setUploadTargetBaseId(event.target.value)}
                      >
                        {knowledgeBases.map((base) => (
                          <option value={base.id} key={base.id}>
                            {base.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={!uploadTargetBaseId}
                      onClick={() => knowledgeFileInputRef.current?.click()}
                    >
                      <UploadCloud size={16} strokeWidth={2.2} />
                      上传资料
                    </button>
                    {knowledgeUploadStatus ? (
                      <p>{knowledgeUploadStatus}</p>
                    ) : null}
                  </div>
                  <div className="knowledge-popover-actions">
                    <span>
                      已选择 {selectedKnowledgeBaseIds.length} 个知识库
                    </span>
                    <div>
                      {isLessonKnowledgeMode ? (
                        <button
                          className="knowledge-action-secondary"
                          type="button"
                          onClick={handleSkipKnowledgeSelection}
                        >
                          不引用，继续
                        </button>
                      ) : (
                        <button
                          className="knowledge-action-secondary"
                          type="button"
                          onClick={onClearKnowledgeBases}
                          disabled={!selectedKnowledgeBaseIds.length}
                        >
                          清空
                        </button>
                      )}
                      <button
                        className="knowledge-action-primary"
                        type="button"
                        onClick={handleCompleteKnowledgeSelection}
                      >
                        {isLessonKnowledgeMode ? "完成选择" : "完成"}
                      </button>
                    </div>
                  </div>
                    </motion.div>
                  ) : null}
              </AnimatePresence>,
              document.body
            )}
            <button
              className={`soft-button thinking-mode-button ${
                enableThinking ? "soft-button-active thinking-mode-button-active" : ""
              }`}
              type="button"
              aria-label="深度思考"
              aria-pressed={enableThinking}
              disabled={isGenerating}
              onClick={onToggleThinking}
            >
              <Brain size={22} strokeWidth={2.25} />
              <span>深度思考</span>
            </button>
          </div>
          <div className="composer-right-actions">
            {modelSlot}
            <button
              className="voice-entry-button"
              type="button"
              aria-label="语音说课"
              onClick={onOpenVoice}
            >
              <Mic size={19} strokeWidth={2.2} />
            </button>
            <button
              className="send-button"
              type="button"
              aria-label="发送"
              disabled={!canSend}
              onClick={onSend}
            >
              <Send size={24} strokeWidth={2.5} fill="currentColor" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** 列表摘要要的是可读文字：把 Markdown 记号擦掉，别让 ** 和 | 跑到卡片上。 */
function markdownToPlain(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "（代码）")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_~`]/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 回复耗时：不足一秒也显示成 0.x 秒，不四舍五入成 0。 */
function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${Math.round(seconds % 60)}s`;
}

async function readChatStream(
  response: Response,
  handlers: {
    onDelta: (content: string) => void;
    onThinkingDelta: (content: string) => void;
    onPhase?: (phase: StreamPhasePayload) => void;
    onMetrics: (thinkingSeconds: number) => void;
    onArtifact: (artifact: ChatArtifact) => void;
    onCitation: (citation: KnowledgeCitation) => void;
    onEvaluation: (evaluation: TrainingEvaluation) => void;
    onTool?: (note: ToolNote) => void;
    onMeta?: (workflowName: string) => void;
    onTrace?: (trace: { agents: TraceAgent[]; tools: ToolNote[] }) => void;
    /** 这一轮由专项智能体作答：把气泡上的徽标换成它。 */
    onDelegated?: (delegated: DelegatedAnswerInfo) => void;
    onDone: (payload: StreamDonePayload) => void;
    onError: (message: string) => void;
  }
) {
  if (!response.ok || !response.body) {
    const errorPayload = await response.json().catch(() => undefined) as
      | { message?: string }
      | undefined;
    throw new Error(errorPayload?.message || "模型服务暂时不可用，请稍后重试");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";

    for (const event of events) {
      handleChatStreamEvent(parseChatStreamEvent(event), handlers);
    }
  }

  if (buffer.trim()) {
    handleChatStreamEvent(parseChatStreamEvent(buffer), handlers);
  }
}

function parseChatStreamEvent(rawEvent: string): ChatStreamEvent {
  const lines = rawEvent.split(/\r?\n/);
  const event = lines
    .find((line) => line.startsWith("event:"))
    ?.replace(/^event:\s?/, "");
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, ""))
    .join("\n");

  return {
    event: event || "message",
    data
  };
}

function handleChatStreamEvent(
  streamEvent: ChatStreamEvent,
  handlers: {
    onDelta: (content: string) => void;
    onThinkingDelta: (content: string) => void;
    onPhase?: (phase: StreamPhasePayload) => void;
    onMetrics: (thinkingSeconds: number) => void;
    onArtifact: (artifact: ChatArtifact) => void;
    onCitation: (citation: KnowledgeCitation) => void;
    onEvaluation: (evaluation: TrainingEvaluation) => void;
    onTool?: (note: ToolNote) => void;
    /** 工作流会话：meta 事件带出工作流名，用作回复徽标。 */
    onMeta?: (workflowName: string) => void;
    /** 工作流会话：运行轨迹（走了哪些智能体、调了哪些工具）。 */
    onTrace?: (trace: { agents: TraceAgent[]; tools: ToolNote[] }) => void;
    /** 这一轮由专项智能体作答：把气泡上的徽标换成它。 */
    onDelegated?: (delegated: DelegatedAnswerInfo) => void;
    onDone: (payload: StreamDonePayload) => void;
    onError: (message: string) => void;
  }
) {
  if (!streamEvent.data) {
    return;
  }

  const payload = JSON.parse(streamEvent.data) as {
    artifact?: ChatArtifact;
    content?: string;
    conversationId?: string;
    message?: string;
    name?: string;
    type?: string;
    url?: string;
    size?: number;
    id?: string;
    thinkingSeconds?: number;
    knowledgeBaseId?: string;
    knowledgeBaseName?: string;
    documentId?: string;
    documentName?: string;
    snippet?: string;
    source?: "local";
    score?: number;
    evaluation?: TrainingEvaluation;
    trainingType?: TrainingType;
    overallScore?: number;
    dimensions?: EvaluationDimension[];
    diagnosis?: string[];
    suggestions?: string[];
    nextTask?: string;
    citations?: KnowledgeCitation[];
    createdAt?: string;
    draft?: LessonPlanDraft | InternshipReflectionDraft;
    diagnostic?: LessonPlanDiagnostic | InternshipReflectionDiagnostic;
    comparison?: LessonPlanComparison;
    evidence?: InternshipEvidenceItem[];
    stepId?: string;
    label?: string;
    detail?: string;
    steps?: GenerationThinkingStep[];
    activeStepId?: string;
    completedStepIds?: string[];
    toolId?: string;
    stage?: "running" | "done" | "skipped";
    ok?: boolean;
    summary?: string;
    latencyMs?: number;
    kind?: "tool" | "delegation";
    serverName?: string;
    toolName?: string;
    targetAgent?: { id?: string; name?: string; avatar?: string };
    workflowName?: string;
    agentId?: string;
    agentName?: string;
    agentAvatar?: string;
    trace?: {
      agents?: Array<{
        name?: string;
        kind?: string;
        durationMs?: number;
        agentId?: string;
      }>;
      tools?: Array<{
        toolId?: string;
        name?: string;
        ok?: boolean;
        latencyMs?: number;
      }>;
    };
  };

  if (
    streamEvent.event === "meta" &&
    typeof payload.workflowName === "string" &&
    payload.workflowName.trim()
  ) {
    handlers.onMeta?.(payload.workflowName.trim());
  }

  if (
    streamEvent.event === "trace" &&
    (payload.trace?.agents?.length || payload.trace?.tools?.length)
  ) {
    const agents: TraceAgent[] = (payload.trace.agents ?? [])
      .filter((item): item is { name: string; kind?: string; durationMs?: number; agentId?: string } =>
        typeof item.name === "string" && item.name.trim() !== ""
      )
      .map((item) => ({
        name: item.name,
        kind:
          item.kind === "subworkflow" || item.kind === "llm" || item.kind === "agent"
            ? item.kind
            : "agent",
        durationMs:
          typeof item.durationMs === "number" && item.durationMs > 0
            ? item.durationMs
            : undefined,
        agentId: typeof item.agentId === "string" ? item.agentId : undefined
      }));
    const tools: ToolNote[] = (payload.trace.tools ?? [])
      .filter(
        (item): item is { toolId: string; name: string; ok?: boolean; latencyMs?: number } =>
          typeof item.name === "string" &&
          item.name.trim() !== "" &&
          typeof item.toolId === "string" &&
          item.toolId.trim() !== ""
      )
      .map((item) => ({
        toolId: item.toolId,
        name: item.name,
        stage: "done" as const,
        ok: item.ok,
        latencyMs: item.latencyMs
      }));
    handlers.onTrace?.({ agents, tools });
  }

  if (
    streamEvent.event === "delegated" &&
    typeof payload.agentName === "string" &&
    payload.agentName.trim()
  ) {
    handlers.onDelegated?.({
      agentId: payload.agentId,
      agentName: payload.agentName.trim(),
      agentAvatar: payload.agentAvatar
    });
  }

  if (
    streamEvent.event === "tool" &&
    payload.toolId &&
    payload.name &&
    payload.stage
  ) {
    handlers.onTool?.({
      toolId: payload.toolId,
      name: payload.name,
      stage: payload.stage,
      ok: payload.ok,
      summary: payload.summary,
      latencyMs: payload.latencyMs,
      kind: payload.kind ?? (payload.toolId.startsWith("agent://") ? "delegation" : "tool"),
      serverName: typeof payload.serverName === "string" ? payload.serverName : undefined,
      toolName: typeof payload.toolName === "string" ? payload.toolName : undefined,
      targetAgent:
        payload.targetAgent && typeof payload.targetAgent.name === "string"
          ? {
              id: String(payload.targetAgent.id ?? ""),
              name: payload.targetAgent.name,
              avatar: payload.targetAgent.avatar
            }
          : undefined
    });
  }

  if (streamEvent.event === "delta" && payload.content) {
    handlers.onDelta(payload.content);
  }

  if (streamEvent.event === "thinking_delta" && payload.content) {
    handlers.onThinkingDelta(payload.content);
  }

  if (streamEvent.event === "phase") {
    handlers.onPhase?.({
      stepId: payload.stepId,
      label: payload.label,
      detail: payload.detail,
      steps: payload.steps,
      activeStepId: payload.activeStepId,
      completedStepIds: payload.completedStepIds
    });
  }

  if (
    streamEvent.event === "metrics" &&
    typeof payload.thinkingSeconds === "number"
  ) {
    handlers.onMetrics(payload.thinkingSeconds);
  }

  if (
    streamEvent.event === "artifact" &&
    payload.id &&
    payload.name &&
    payload.type &&
    payload.url &&
    typeof payload.size === "number"
  ) {
    handlers.onArtifact({
      id: payload.id,
      name: payload.name,
      type: payload.type,
      url: payload.url,
      size: payload.size
    });
  }

  if (
    streamEvent.event === "citation" &&
    payload.id &&
    payload.knowledgeBaseId &&
    payload.knowledgeBaseName &&
    payload.documentId &&
    payload.documentName &&
    payload.snippet &&
    payload.source &&
    typeof payload.score === "number"
  ) {
    handlers.onCitation({
      id: payload.id,
      knowledgeBaseId: payload.knowledgeBaseId,
      knowledgeBaseName: payload.knowledgeBaseName,
      documentId: payload.documentId,
      documentName: payload.documentName,
      snippet: payload.snippet,
      source: payload.source,
      score: payload.score
    });
  }

  if (streamEvent.event === "evaluation" && isTrainingEvaluation(payload)) {
    handlers.onEvaluation(payload);
  }

  if (streamEvent.event === "done") {
    const donePayload = payload as typeof payload & StreamDonePayload;

    handlers.onDone({
      conversationId: donePayload.conversationId,
      draft: donePayload.draft,
      diagnostic: donePayload.diagnostic,
      comparison: donePayload.comparison,
      citations: donePayload.citations,
      evidence: donePayload.evidence,
      evaluation: donePayload.evaluation
    });
  }

  if (streamEvent.event === "error") {
    handlers.onError(
      "message" in payload && typeof payload.message === "string"
        ? payload.message
        : "模型服务暂时不可用，请稍后重试"
    );
  }
}

function isTrainingEvaluation(value: unknown): value is TrainingEvaluation {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TrainingEvaluation).id === "string" &&
    typeof (value as TrainingEvaluation).conversationId === "string" &&
    typeof (value as TrainingEvaluation).overallScore === "number" &&
    Array.isArray((value as TrainingEvaluation).dimensions) &&
    Array.isArray((value as TrainingEvaluation).diagnosis) &&
    Array.isArray((value as TrainingEvaluation).suggestions)
  );
}

function createVisibleTextStreamer(onChunk: (content: string) => void) {
  let queuedText = "";
  let timerId: number | undefined;
  let stopped = false;
  const flushResolvers: Array<() => void> = [];

  function resolveFlushes() {
    if (queuedText || timerId !== undefined) {
      return;
    }

    while (flushResolvers.length) {
      flushResolvers.shift()?.();
    }
  }

  function schedule() {
    if (stopped || timerId !== undefined || !queuedText) {
      return;
    }

    timerId = window.setTimeout(() => {
      timerId = undefined;

      if (stopped) {
        return;
      }

      const chunkSize = queuedText.length > 80 ? 6 : queuedText.length > 32 ? 3 : 1;
      const nextChunk = queuedText.slice(0, chunkSize);
      queuedText = queuedText.slice(chunkSize);
      onChunk(nextChunk);

      if (queuedText) {
        schedule();
      } else {
        resolveFlushes();
      }
    }, 16);
  }

  return {
    enqueue(content: string) {
      if (stopped || !content) {
        return;
      }

      queuedText += content;
      schedule();
    },
    flush() {
      if (!queuedText && timerId === undefined) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        flushResolvers.push(resolve);
        schedule();
      });
    },
    stop() {
      stopped = true;
      queuedText = "";

      if (timerId !== undefined) {
        window.clearTimeout(timerId);
        timerId = undefined;
      }

      resolveFlushes();
    }
  };
}

function KnowledgeCenter({
  bases,
  activeBaseId,
  documents,
  chunks,
  selectedDocumentId,
  searchQuery,
  searchResults,
  providers,
  status,
  onBackToChat,
  onCreateBase,
  onDeleteDocument,
  onSyncIma,
  onSearch,
  onSearchQueryChange,
  onSelectBase,
  onSelectDocument,
  onTestIma,
  onUploadDocument
}: {
  bases: KnowledgeBase[];
  activeBaseId?: string;
  documents: KnowledgeDocument[];
  chunks: KnowledgeChunk[];
  selectedDocumentId?: string;
  searchQuery: string;
  searchResults: KnowledgeCitation[];
  providers: KnowledgeProviderInfo[];
  status?: string;
  onBackToChat: () => void;
  onCreateBase: (name: string) => void;
  onDeleteDocument: (documentId: string) => void;
  onSyncIma: () => void;
  onSearch: () => void;
  onSearchQueryChange: (value: string) => void;
  onSelectBase: (id: string) => void;
  onSelectDocument: (id: string) => void;
  onTestIma: () => void;
  onUploadDocument: (file: File) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [newBaseName, setNewBaseName] = useState("");
  const activeBase = bases.find((base) => base.id === activeBaseId);
  const isActiveBaseRemote = activeBase?.source !== "local";
  const selectedDocument = documents.find(
    (document) => document.id === selectedDocumentId
  );
  const imaProvider = providers.find((provider) => provider.id === "ima");

  function handleCreateBase() {
    const name = newBaseName.trim();

    if (!name) {
      return;
    }

    onCreateBase(name);
    setNewBaseName("");
  }

  function handleUploadChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (file) {
      onUploadDocument(file);
    }
  }

  return (
    <section className="knowledge-center" aria-label="知识库管理">
      <header className="knowledge-page-header">
        <div>
          <span>Knowledge Base</span>
          <h1>知识库管理</h1>
          <p>长期保存教学资料，在聊天里按需引用，并用召回测试确认命中的片段。</p>
        </div>
        <button type="button" onClick={onBackToChat}>
          <MessageCircleQuestion size={17} strokeWidth={2.2} />
          回到对话
        </button>
      </header>

      <div className="knowledge-layout">
        <aside className="knowledge-bases-panel">
          <div className="knowledge-create">
            <input
              value={newBaseName}
              onChange={(event) => setNewBaseName(event.target.value)}
              placeholder="新建知识库"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleCreateBase();
                }
              }}
            />
            <button type="button" aria-label="新建知识库" onClick={handleCreateBase}>
              <Plus size={18} strokeWidth={2.4} />
            </button>
          </div>
          <div className="knowledge-base-list">
            {bases.map((base) => (
              <button
                className={`knowledge-base-item ${
                  base.id === activeBaseId ? "knowledge-base-item-active" : ""
                }`}
                key={base.id}
                type="button"
                onClick={() => onSelectBase(base.id)}
              >
                <Database size={18} strokeWidth={2.1} />
                <span>
                  <strong>{base.name}</strong>
                  <small>
                    {formatKnowledgeCount(base)} · {formatKnowledgeSource(base.source)}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <div className="provider-panel">
            <div className="provider-heading">
              <h2>接入平台</h2>
              <span>{imaProvider?.status ? formatProviderStatus(imaProvider.status) : "检测中"}</span>
            </div>
            {providers.map((provider) => (
              <article className="provider-card" key={provider.id}>
                <div>
                  <strong>{provider.name}</strong>
                  <p>{provider.message || provider.description}</p>
                </div>
                <small>{formatProviderStatus(provider.status)}</small>
              </article>
            ))}
            <div className="provider-actions">
              <button type="button" onClick={onTestIma}>
                测试 IMA
              </button>
              <button type="button" onClick={onSyncIma}>
                同步 IMA
              </button>
            </div>
          </div>
        </aside>

        <section className="knowledge-documents-panel">
          <div className="knowledge-section-title">
            <div>
              <h2>{activeBase?.name || "选择知识库"}</h2>
              <p>
                {isActiveBaseRemote
                  ? "IMA 知识库保留在远程平台，StarLattice 会在聊天和教案生成时按需检索引用。"
                  : "上传 PDF、TXT、MD、CSV、JSON，系统会自动分块并建立检索索引。"}
              </p>
            </div>
            <input
              className="file-input"
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.md,.csv,.json,application/pdf,text/plain,text/markdown,text/csv,application/json"
              onChange={handleUploadChange}
            />
            <button
              type="button"
              disabled={!activeBaseId || isActiveBaseRemote}
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadCloud size={17} strokeWidth={2.2} />
              {isActiveBaseRemote ? "远程资料" : "上传资料"}
            </button>
          </div>

          {status ? <p className="knowledge-status">{status}</p> : null}

          <div className="knowledge-document-list">
            {isActiveBaseRemote ? (
              <div className="knowledge-empty-state">
                <Database size={26} strokeWidth={1.9} />
                <p>
                  已接入 {activeBase?.name || "IMA 知识库"}，共{" "}
                  {activeBase ? formatKnowledgeCount(activeBase) : "0 条内容"}。
                </p>
                <p className="knowledge-muted">
                  远程资料不会下载成本地文档，因此这里不显示“分块”和“文件大小”。可在右侧召回测试中输入问题验证命中内容。
                </p>
              </div>
            ) : documents.length ? (
              documents.map((document) => (
                <article
                  className={`knowledge-document ${
                    document.id === selectedDocumentId
                      ? "knowledge-document-active"
                      : ""
                  }`}
                  key={document.id}
                >
                  <button
                    type="button"
                    onClick={() => onSelectDocument(document.id)}
                  >
                    <FileText size={18} strokeWidth={2.1} />
                    <span>
                      <strong>{document.name}</strong>
                      <small>
                        {document.type.toUpperCase()} · {document.chunkCount} 段 ·{" "}
                        {formatFileSize(document.size)}
                      </small>
                    </span>
                  </button>
                  <button
                    className="document-delete"
                    type="button"
                    aria-label={`删除 ${document.name}`}
                    disabled={isActiveBaseRemote}
                    onClick={() => onDeleteDocument(document.id)}
                  >
                    <Trash2 size={16} strokeWidth={2.2} />
                  </button>
                </article>
              ))
            ) : (
              <div className="knowledge-empty-state">
                <FileText size={26} strokeWidth={1.9} />
                <p>这个知识库还没有资料。</p>
              </div>
            )}
          </div>
        </section>

        <aside className="knowledge-detail-panel">
          <section className="chunk-preview">
            <h2>文档详情</h2>
            {selectedDocument ? (
              <>
                <div className="selected-document-meta">
                  <strong>{selectedDocument.name}</strong>
                  <span>{selectedDocument.chunkCount} 个分块</span>
                </div>
                <div className="chunk-list">
                  {chunks.length ? (
                    chunks.slice(0, 5).map((chunk) => (
                      <article className="chunk-item" key={chunk.id}>
                        <span>Chunk {chunk.index + 1}</span>
                        <p>{truncateText(chunk.content, 210)}</p>
                      </article>
                    ))
                  ) : (
                    <p className="knowledge-muted">选择文档后预览分块。</p>
                  )}
                </div>
              </>
            ) : isActiveBaseRemote ? (
              <p className="knowledge-muted">
                IMA 知识库按问题实时召回，不生成本地分块预览。
              </p>
            ) : (
              <p className="knowledge-muted">从左侧文档列表选择一个文档。</p>
            )}
          </section>

          <section className="retrieval-test">
            <h2>召回测试</h2>
            <div className="retrieval-search">
              <Search size={17} strokeWidth={2.2} />
              <input
                value={searchQuery}
                onChange={(event) => onSearchQueryChange(event.target.value)}
                placeholder="输入问题测试命中片段"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    onSearch();
                  }
                }}
              />
              <button type="button" onClick={onSearch}>
                测试
              </button>
            </div>
            <div className="retrieval-results">
              {searchResults.length ? (
                searchResults.map((result) => (
                  <article className="retrieval-result" key={result.id}>
                    <strong>{result.documentName}</strong>
                    <span>{result.knowledgeBaseName}</span>
                    <p>{result.snippet}</p>
                  </article>
                ))
              ) : (
                <p className="knowledge-muted">测试后会显示最可能被引用的片段。</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

type TeachingResourceCenterProps = {
  bases: KnowledgeBase[];
  activeBaseId?: string;
  documents: KnowledgeDocument[];
  chunks: KnowledgeChunk[];
  selectedDocumentId?: string;
  searchQuery: string;
  searchResults: KnowledgeCitation[];
  searchState: KnowledgeSearchState;
  providers: KnowledgeProviderInfo[];
  starterPacks: StarterKnowledgePack[];
  status?: string;
  onBackToChat: () => void;
  onCreateBase: (name: string) => void;
  onRenameBase: (id: string, name: string) => void;
  onDeleteBase: (id: string) => void;
  onDeleteDocument: (documentId: string) => void;
  onSyncIma: () => void;
  onSearch: () => void;
  onSearchQueryChange: (value: string) => void;
  onSelectBase: (id: string) => void;
  onSelectDocument: (id: string) => void;
  onTestIma: () => void;
  onImportStarterPack: (packId: string) => void;
  onStartTraining: (trainingType: TrainingType, knowledgeBaseId?: string) => void;
  onUploadDocument: (file: File, metadata: KnowledgeDocumentMetadata) => Promise<void>;
};

function TeachingResourceCenter({
  bases,
  activeBaseId,
  documents,
  chunks,
  selectedDocumentId,
  searchQuery,
  searchResults,
  searchState,
  providers,
  starterPacks,
  status,
  onBackToChat,
  onCreateBase,
  onRenameBase,
  onDeleteBase,
  onDeleteDocument,
  onSyncIma,
  onSearch,
  onSearchQueryChange,
  onSelectBase,
  onSelectDocument,
  onTestIma,
  onImportStarterPack,
  onStartTraining,
  onUploadDocument
}: TeachingResourceCenterProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [newBaseName, setNewBaseName] = useState("");
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [uploadStates, setUploadStates] = useState<
    Record<string, "queued" | "uploading" | "success" | "error">
  >({});
  const [metadata, setMetadata] = useState<KnowledgeDocumentMetadata>({
    resourceType: "其他",
    subject: "",
    schoolStage: "",
    tags: []
  });
  const [intendedTraining, setIntendedTraining] = useState<TrainingType>("教案诊断");
  const [tagInput, setTagInput] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<KnowledgeResourceType | "全部类型">("全部类型");
  const [stageFilter, setStageFilter] = useState("全部学段");
  const [detailTab, setDetailTab] = useState<"document" | "search">("document");
  const [activeView, setActiveView] = useState<"home" | "manage">("home");
  const activeBase = bases.find((base) => base.id === activeBaseId);
  const isRemote = activeBase?.source !== "local";
  const selectedDocument = documents.find((document) => document.id === selectedDocumentId);
  const resourceTypes: KnowledgeResourceType[] = [
    "课程标准",
    "教材/课件",
    "优秀课例",
    "课堂证据",
    "教研资料",
    "其他"
  ];
  const localBases = bases.filter((base) => base.source === "local");
  const remoteBases = bases.filter((base) => base.source !== "local");
  const schoolStages = Array.from(new Set(documents.map((document) => document.schoolStage).filter(Boolean)));
  const visibleDocuments = documents.filter((document) =>
    document.name.toLocaleLowerCase().includes(nameFilter.trim().toLocaleLowerCase()) &&
    (typeFilter === "全部类型" || document.resourceType === typeFilter) &&
    (stageFilter === "全部学段" || document.schoolStage === stageFilter)
  );
  const imaProvider = providers.find((provider) => provider.id === "ima");
  const recentBases = [...localBases].slice(-3).reverse();
  const trainingTasks: Array<{
    trainingType: TrainingType;
    title: string;
    detail: string;
    materials: string;
  }> = [
    { trainingType: "教案诊断", title: "写教案", detail: "把课程依据、活动和评价组织成教学设计。", materials: "课程标准、教材课件、优秀课例" },
    { trainingType: "说课陪练", title: "练说课", detail: "用可信依据梳理教材、学情与教学设计。", materials: "课程标准、优秀课例、教研资料" },
    { trainingType: "模拟课堂", title: "模拟课堂", detail: "带着资料进入提问、追问与课堂应变练习。", materials: "教材课件、课堂证据、优秀课例" },
    { trainingType: "实习反思", title: "写实习反思", detail: "把课堂片段和改进行动整理成可回看的反思。", materials: "课堂证据、学生作品、教研资料" }
  ];

  function openImport(files: File[]) {
    if (!files.length) return;
    setImportFiles(files);
    setUploadStates(Object.fromEntries(files.map((file) => [getResourceUploadKey(file), "queued"])));
    setIsImportOpen(true);
  }

  function addTag() {
    const tag = tagInput.trim();
    if (!tag || metadata.tags.includes(tag) || metadata.tags.length >= 8) return;
    setMetadata((current) => ({ ...current, tags: [...current.tags, tag] }));
    setTagInput("");
  }

  async function importQueue() {
    const uploadMetadata: KnowledgeDocumentMetadata = {
      ...metadata,
      tags: Array.from(new Set([...metadata.tags, `用途：${intendedTraining}`]))
    };

    for (const file of importFiles) {
      const key = getResourceUploadKey(file);
      setUploadStates((current) => ({ ...current, [key]: "uploading" }));
      try {
        await onUploadDocument(file, uploadMetadata);
        setUploadStates((current) => ({ ...current, [key]: "success" }));
      } catch {
        setUploadStates((current) => ({ ...current, [key]: "error" }));
      }
    }
  }

  function createBase() {
    const name = newBaseName.trim();
    if (!name) return;
    onCreateBase(name);
    setNewBaseName("");
    setIsCreateOpen(false);
  }

  function renameBase() {
    if (!activeBase || isRemote) return;
    const name = window.prompt("输入新的资料库名称", activeBase.name)?.trim();
    if (name && name !== activeBase.name) onRenameBase(activeBase.id, name);
  }

  function deleteBase() {
    if (!activeBase || isRemote) return;
    if (window.confirm(`删除「${activeBase.name}」及其中的全部资料？此操作无法撤销。`)) {
      onDeleteBase(activeBase.id);
    }
  }

  return (
    <section className="knowledge-center resource-library" aria-label="我的备课资料">
      <header className="knowledge-page-header resource-library-header">
        <div>
          <span>My teaching materials</span>
          <h1>我的备课资料</h1>
          <p>把有用的课程资料带进教案、说课、课堂演练和实习反思。</p>
        </div>
        <div className="knowledge-header-actions">
          <button className="knowledge-action-secondary" type="button" onClick={() => setActiveView((value) => value === "home" ? "manage" : "home")}>{activeView === "home" ? "管理资料" : "返回资料主页"}</button>
          {activeView === "manage" ? <><button className="knowledge-action-secondary" type="button" onClick={() => setIsCreateOpen(true)}>新建资料包</button><button className="knowledge-action-primary" type="button" disabled={!activeBaseId || isRemote} onClick={() => fileInputRef.current?.click()}><UploadCloud size={17} />导入资料</button></> : null}
          <button className="knowledge-back-button" type="button" onClick={onBackToChat}>回到对话</button>
        </div>
      </header>

      {activeView === "home" ? <div className="student-materials-home">
        <section className="materials-task-section">
          <div className="materials-section-heading"><div><span>从任务开始</span><h2>这次想用资料完成什么？</h2><p>先选训练，再带着资料进入练习。</p></div>{activeBase ? <small>当前资料包：{activeBase.name}</small> : null}</div>
          <div className="materials-task-grid">{trainingTasks.map((task) => <article key={task.trainingType}><strong>{task.title}</strong><p>{task.detail}</p><small>推荐：{task.materials}</small><button type="button" onClick={() => onStartTraining(task.trainingType, activeBase?.id)}>带资料开始</button></article>)}</div>
        </section>

        <section className="materials-pack-section">
          <div className="materials-section-heading"><div><span>示例资料包</span><h2>不知道先放什么？从示例开始</h2><p>示例会复制到你的本地资料中，可自由修改和删除。</p></div></div>
          <div className="materials-pack-grid">{starterPacks.map((pack) => <article key={pack.id}><div><strong>{pack.name}</strong><span>{pack.documentCount} 份示例资料</span></div><p>{pack.description}</p><small>适合：{pack.recommendedFor.join("、")}</small><button className="knowledge-action-secondary" type="button" onClick={() => onImportStarterPack(pack.id)}>复制到我的资料</button></article>)}</div>
        </section>

        <section className="materials-recent-section">
          <div className="materials-section-heading"><div><span>我的资料包</span><h2>最近使用</h2></div><button className="knowledge-text-button" type="button" onClick={() => setActiveView("manage")}>查看全部资料</button></div>
          {recentBases.length ? <div className="materials-recent-list">{recentBases.map((base) => <button type="button" key={base.id} onClick={() => { onSelectBase(base.id); setActiveView("manage"); }}><Database size={18} /><span><strong>{base.name}</strong><small>{formatKnowledgeCount(base)} · 可用于训练</small></span><ChevronRight size={16} /></button>)}</div> : <div className="materials-empty-guide"><FileText size={22} /><p>还没有自己的资料包。可以复制示例资料包，或进入管理资料导入第一份材料。</p><button className="knowledge-action-primary" type="button" onClick={() => setActiveView("manage")}>去管理资料</button></div>}
        </section>
      </div> : <>

      {isCreateOpen ? <form className="knowledge-inline-form" onSubmit={(event) => { event.preventDefault(); createBase(); }}>
        <label><span>资料包名称</span><input autoFocus value={newBaseName} onChange={(event) => setNewBaseName(event.target.value)} placeholder="例如：七年级数学分数的意义" /></label>
        <button className="knowledge-action-primary" type="submit">创建资料包</button>
        <button className="knowledge-text-button" type="button" onClick={() => setIsCreateOpen(false)}>取消</button>
      </form> : null}

      <input ref={fileInputRef} className="file-input" type="file" multiple accept=".pdf,.txt,.md,.csv,.json,.docx,.xlsx,.pptx" onChange={(event) => { openImport(Array.from(event.target.files || [])); event.target.value = ""; }} />

      {isImportOpen ? <section className="knowledge-import-panel" aria-label="导入教学资料">
        <div className="knowledge-import-heading"><div><span>导入到资料包</span><strong>{activeBase?.name || "未选择资料包"}</strong></div><button className="knowledge-text-button" type="button" onClick={() => setIsImportOpen(false)}>收起</button></div>
        <div className="knowledge-import-metadata">
          <label><span>这是什么资料</span><select value={metadata.resourceType} onChange={(event) => setMetadata((current) => ({ ...current, resourceType: event.target.value as KnowledgeResourceType }))}>{resourceTypes.map((type) => <option key={type}>{type}</option>)}</select></label>
          <label><span>打算用在哪项训练</span><select value={intendedTraining} onChange={(event) => setIntendedTraining(event.target.value as TrainingType)}>{trainingTasks.map((task) => <option key={task.trainingType} value={task.trainingType}>{task.title}</option>)}</select></label>
          <label><span>学科（可跳过）</span><input value={metadata.subject} onChange={(event) => setMetadata((current) => ({ ...current, subject: event.target.value }))} placeholder="例如：数学" /></label>
          <label><span>学段（可跳过）</span><select value={metadata.schoolStage} onChange={(event) => setMetadata((current) => ({ ...current, schoolStage: event.target.value }))}><option value="">未填写</option><option value="小学">小学</option><option value="初中">初中</option><option value="高中">高中</option><option value="通用">通用</option></select></label>
          <label className="knowledge-tag-field"><span>补充标签（可跳过）</span><div><input value={tagInput} onChange={(event) => setTagInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTag(); } }} placeholder="输入后按回车" /><button type="button" onClick={addTag}>添加</button></div></label>
        </div>
        {metadata.tags.length ? <div className="knowledge-tag-list">{metadata.tags.map((tag) => <button key={tag} type="button" onClick={() => setMetadata((current) => ({ ...current, tags: current.tags.filter((item) => item !== tag) }))}>{tag}<X size={12} /></button>)}</div> : null}
        <div className="knowledge-upload-queue">{importFiles.map((file) => { const state = uploadStates[getResourceUploadKey(file)] || "queued"; return <div key={getResourceUploadKey(file)} className="knowledge-upload-row"><FileText size={17} /><span><strong>{file.name}</strong><small>{formatFileSize(file.size)} · {formatResourceUploadState(state)}{state === "success" ? ` · 可用于${intendedTraining}` : ""}</small></span><span className={`knowledge-upload-state is-${state}`}>{state === "success" ? <Check size={15} /> : state === "error" ? <AlertTriangle size={15} /> : null}</span></div>; })}</div>
        <button className="knowledge-action-primary" type="button" onClick={() => void importQueue()} disabled={!importFiles.length || isRemote}>开始导入（{importFiles.length}）</button>
        {Object.values(uploadStates).some((state) => state === "success") && activeBaseId ? <button className="knowledge-action-secondary" type="button" onClick={() => onStartTraining(intendedTraining, activeBaseId)}>立即用于{trainingTasks.find((task) => task.trainingType === intendedTraining)?.title || "训练"}</button> : null}
      </section> : null}

      <div className="knowledge-layout resource-library-layout">
        <aside className="knowledge-bases-panel">
          <div className="knowledge-sidebar-heading"><span>资料包</span><small>{localBases.length} 个本地包</small></div>
          <p className="knowledge-tree-label">我的资料包</p>
          <div className="knowledge-base-list">{localBases.map((base) => <button className={`knowledge-base-item ${base.id === activeBaseId ? "knowledge-base-item-active" : ""}`} key={base.id} type="button" onClick={() => onSelectBase(base.id)}><Database size={18} /><span><strong>{base.name}</strong><small>{formatKnowledgeCount(base)} · 本地资料</small></span></button>)}</div>
          <div className="knowledge-external-section"><p className="knowledge-tree-label">外部资料</p>{remoteBases.length ? remoteBases.map((base) => <button className={`knowledge-base-item ${base.id === activeBaseId ? "knowledge-base-item-active" : ""}`} key={base.id} type="button" onClick={() => onSelectBase(base.id)}><BookOpen size={18} /><span><strong>{base.name}</strong><small>{formatKnowledgeCount(base)} · 外部资料</small></span></button>) : <p className="knowledge-muted">连接外部资料后，会在训练时按需引用。</p>}</div>
          <details className="knowledge-connection-panel"><summary>外部资料设置</summary><div className="provider-panel"><div className="provider-heading"><h2>IMA 连接</h2><span>{imaProvider?.status ? formatProviderStatus(imaProvider.status) : "检测中"}</span></div><p>{imaProvider?.message || "外部资料仅在训练时实时检索。"}</p><div className="provider-actions"><button type="button" onClick={onTestIma}>测试连接</button><button type="button" onClick={onSyncIma}>同步资料</button></div></div></details>
        </aside>

        <section className="knowledge-documents-panel">
          <div className="knowledge-section-title"><div><span className="knowledge-breadcrumb">我的备课资料 / {isRemote ? "外部资料" : "我的资料包"}</span><h2>{activeBase?.name || "选择资料包"}</h2><p>{isRemote ? "外部资料保留在原平台，可在右侧“问资料一个问题”中确认能否提供依据。" : "按资料类型和学段筛选，快速确认哪些依据可以用于本次训练。"}</p></div>{activeBase && !isRemote ? <div className="knowledge-base-actions"><button type="button" onClick={renameBase}>重命名</button><button className="danger" type="button" onClick={deleteBase}>删除</button></div> : null}</div>
          {status ? <p className="knowledge-status">{status}</p> : null}
          <div className="knowledge-document-toolbar"><label className="knowledge-filter-search"><Search size={16} /><input value={nameFilter} onChange={(event) => setNameFilter(event.target.value)} placeholder="搜索当前资料包" /></label><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as KnowledgeResourceType | "全部类型")}><option>全部类型</option>{resourceTypes.map((type) => <option key={type}>{type}</option>)}</select><select value={stageFilter} onChange={(event) => setStageFilter(event.target.value)}><option>全部学段</option>{schoolStages.map((stage) => <option key={stage}>{stage}</option>)}</select></div>
          <div className="knowledge-document-list knowledge-document-table-wrap">
            {isRemote ? <div className="knowledge-empty-state"><Database size={26} /><p>已接入 {activeBase?.name || "IMA 外部资料"}，共 {activeBase ? formatKnowledgeCount(activeBase) : "0 条内容"}。</p><p className="knowledge-muted">外部资料由 IMA 管理，本平台只读查找，不显示文件详情。</p></div> : visibleDocuments.length ? <table className="knowledge-document-table"><thead><tr><th>资料</th><th>类型</th><th>学科 / 学段</th><th>标签</th><th>整理状态</th><th aria-label="操作" /></tr></thead><tbody>{visibleDocuments.map((document) => <tr className={document.id === selectedDocumentId ? "is-selected" : ""} key={document.id}><td><button className="knowledge-document-name" type="button" onClick={() => { onSelectDocument(document.id); setDetailTab("document"); }}><FileText size={17} /><span><strong>{document.name}</strong><small>{document.type.toUpperCase()} · {formatFileSize(document.size)} · {formatDateTime(document.createdAt)}</small></span></button></td><td><span className="knowledge-type-badge">{document.resourceType}</span></td><td><span>{document.subject || "未填写"}</span><small>{document.schoolStage || "未填写"}</small></td><td>{document.tags.length ? <div className="knowledge-tag-list compact">{document.tags.slice(0, 2).map((tag) => <span key={tag}>{tag}</span>)}</div> : <small>未分类</small>}</td><td><span className="knowledge-index-ready"><Check size={14} />资料已整理</span><small>{document.chunkCount} 处可引用内容</small></td><td><button className="document-delete" type="button" aria-label={`删除 ${document.name}`} onClick={() => onDeleteDocument(document.id)}><Trash2 size={16} /></button></td></tr>)}</tbody></table> : <div className="knowledge-empty-state"><FileText size={26} /><p>{documents.length ? "没有符合筛选条件的资料。" : "这个资料包还没有资料。"}</p>{!documents.length ? <button className="knowledge-action-primary" type="button" onClick={() => fileInputRef.current?.click()}>导入第一份资料</button> : null}</div>}
          </div>
        </section>

        <aside className="knowledge-detail-panel">
          <div className="knowledge-detail-tabs" role="tablist"><button type="button" className={detailTab === "document" ? "active" : ""} onClick={() => setDetailTab("document")}>资料详情</button><button type="button" className={detailTab === "search" ? "active" : ""} onClick={() => setDetailTab("search")}>问资料一个问题</button></div>
          {detailTab === "document" ? <section className="chunk-preview"><h2>可引用内容</h2>{selectedDocument ? <><div className="selected-document-meta"><strong>{selectedDocument.name}</strong><span>{selectedDocument.resourceType} · {selectedDocument.subject || "未填写学科"} · {selectedDocument.schoolStage || "未填写学段"}</span>{selectedDocument.tags.length ? <div className="knowledge-tag-list compact">{selectedDocument.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}</div><div className="chunk-list">{chunks.length ? chunks.slice(0, 5).map((chunk) => <article className="chunk-item" key={chunk.id}><span>可引用片段 {chunk.index + 1}</span><p>{truncateText(chunk.content, 210)}</p></article>) : <p className="knowledge-muted">资料整理完成后会显示可引用内容。</p>}</div></> : <p className="knowledge-muted">{isRemote ? "外部资料会在提问时实时查找可引用内容。" : "从资料列表选择一个文档，即可查看系统可引用的内容。"}</p>}</section> : null}
          {detailTab === "search" ? <section className="retrieval-test"><h2>问资料一个问题</h2><p className="knowledge-muted">输入真实教学问题，看看资料能提供哪些依据。</p><div className="retrieval-search"><Search size={17} /><input value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onSearch(); }} placeholder="例如：分数的意义常见学习误区" /><button type="button" disabled={searchState === "loading"} onClick={onSearch}>{searchState === "loading" ? "查找中" : "问资料"}</button></div><div className="retrieval-results">{searchState === "idle" ? <p className="knowledge-muted">提问后会显示最适合参考的资料内容。</p> : null}{searchState === "loading" ? <p className="knowledge-retrieval-message">正在查找最相关的教学依据…</p> : null}{searchState === "empty" ? <p className="knowledge-retrieval-message is-empty">没有找到相关内容。试着换成更具体的课题、知识点或教学目标，也可以补充相关资料。</p> : null}{searchState === "error" ? <p className="knowledge-retrieval-message is-error">暂时无法完成查找，请稍后再试。</p> : null}{searchState === "success" ? searchResults.map((result) => <button className="retrieval-result" type="button" key={result.id} onClick={() => { if (result.source === "local") { onSelectDocument(result.documentId); setDetailTab("document"); } }}><strong>{result.documentName}</strong><span>{result.knowledgeBaseName} · {formatKnowledgeSource(result.source)} · 匹配程度 {Math.round(Math.min(result.score, 1) * 100)}%</span><p>{result.snippet}</p></button>) : null}</div></section> : null}
        </aside>
      </div>
      </>}
    </section>
  );
}

function getResourceUploadKey(file: File) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function formatResourceUploadState(state: "queued" | "uploading" | "success" | "error") {
  return { queued: "等待导入", uploading: "正在整理可引用内容", success: "已完成", error: "导入失败" }[state];
}

function HistoryCenter({
  conversations,
  status,
  onBackToChat,
  onRefresh,
  onRestore
}: {
  conversations: ConversationSummary[];
  status?: string;
  onBackToChat: () => void;
  onRefresh: () => void;
  onRestore: (id: string) => void;
}) {
  const [filter, setFilter] = useState<TrainingType | "通用对话" | "全部">("全部");
  const visibleConversations =
    filter === "全部"
      ? conversations
      : conversations.filter((conversation) =>
          filter === "通用对话"
            ? conversation.assistantMode === "office"
            : conversation.trainingType === filter
        );

  return (
    <section className="history-center" aria-label="对话历史">
      <header className="knowledge-page-header">
        <div>
          <span>Conversation History</span>
          <h1>对话历史</h1>
          <p>统一查看通用对话与教育训练记录，可按类型筛选并回到原对话继续。</p>
        </div>
        <div className="page-header-actions">
          <button type="button" onClick={onRefresh}>
            <RotateCcw size={17} strokeWidth={2.2} />
            刷新
          </button>
          <button type="button" onClick={onBackToChat}>
            <MessageCircleQuestion size={17} strokeWidth={2.2} />
            回到对话
          </button>
        </div>
      </header>

      <div className="history-toolbar">
        {(["全部", "通用对话", "教案诊断", "说课陪练", "模拟课堂", "实习反思", "谈心谈话"] as Array<
          TrainingType | "通用对话" | "全部"
        >).map((type) => (
          <button
            className={filter === type ? "history-filter-active" : ""}
            type="button"
            key={type}
            onClick={() => setFilter(type)}
          >
            {type}
          </button>
        ))}
      </div>

      {status ? <p className="knowledge-status">{status}</p> : null}

      <div className="history-list">
        {visibleConversations.length ? (
          visibleConversations.map((conversation) => (
            <article className="history-item" key={conversation.id}>
              <div className="history-main">
                <span className="training-badge">
                  {conversation.workflowId
                    ? "工作流"
                    : conversation.assistantMode === "office"
                      ? "通用对话"
                      : conversation.trainingType}
                </span>
                <h2>{conversation.title}</h2>
                <p>{truncateText(markdownToPlain(conversation.lastMessage || "") || "暂无回复摘要", 140)}</p>
                <div className="history-meta">
                  <span>{formatDateTime(conversation.updatedAt)}</span>
                  <span>{conversation.messageCount} 条消息</span>
                  <span>{conversation.citationCount} 条引用</span>
                  <span>{conversation.artifactCount} 个文件</span>
                </div>
              </div>
              <div className="history-score">
                {conversation.workflowId ? (
                  <>
                    <strong>{conversation.messageCount}</strong>
                    <span>条消息 · 工作流会话</span>
                  </>
                ) : conversation.assistantMode === "office" ? (
                  <>
                    <strong>{conversation.messageCount}</strong>
                    <span>条消息 · 通用对话</span>
                  </>
                ) : conversation.latestEvaluation ? (
                  <>
                    <strong>{conversation.latestEvaluation.overallScore}</strong>
                    <span>综合评价</span>
                  </>
                ) : (
                  <>
                    <strong>--</strong>
                    <span>待评价</span>
                  </>
                )}
                <button type="button" onClick={() => onRestore(conversation.id)}>
                  继续
                  <ChevronRight size={16} strokeWidth={2.3} />
                </button>
              </div>
            </article>
          ))
        ) : (
          <div className="history-empty">
            <FileText size={28} strokeWidth={1.9} />
            <p>还没有匹配的对话记录。</p>
          </div>
        )}
      </div>
    </section>
  );
}

type GrowthTrendMetric = "综合能力" | "教学设计" | "课堂表达" | "课堂互动" | "教学反思";

const growthTrendMetrics: Array<{
  name: GrowthTrendMetric;
  keywords: string[];
}> = [
  { name: "综合能力", keywords: [] },
  { name: "教学设计", keywords: ["目标", "设计", "教案", "流程", "任务", "重难点", "教材", "学情", "活动"] },
  { name: "课堂表达", keywords: ["表达", "说课", "语言", "结构", "答辩"] },
  { name: "课堂互动", keywords: ["互动", "应变", "评价", "反馈", "控场", "追问"] },
  { name: "教学反思", keywords: ["反思", "改进", "证据", "原因", "理论", "闭环"] }
];

function GrowthTrendPanel({
  timeline,
  metric,
  onMetricChange
}: {
  timeline: GrowthSummary["evidenceRecords"];
  metric: GrowthTrendMetric;
  onMetricChange: (metric: GrowthTrendMetric) => void;
}) {
  const selectedMetric = growthTrendMetrics.find((item) => item.name === metric)!;
  const records = [...timeline]
    .filter((item) => item.score > 0)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(-8);
  const points = records
    .map((record) => {
      if (metric === "综合能力") {
        return { record, score: record.score };
      }

      const matched = record.dimensions.filter((dimension) =>
        selectedMetric.keywords.some((keyword) => dimension.name.includes(keyword))
      );
      if (!matched.length) {
        return null;
      }

      return {
        record,
        score: Math.round(
          matched.reduce((total, dimension) => total + dimension.score, 0) / matched.length
        )
      };
    })
    .filter((point): point is { record: GrowthSummary["evidenceRecords"][number]; score: number } => Boolean(point));
  const chartWidth = 560;
  const chartHeight = 176;
  const chartPadding = { top: 16, right: 14, bottom: 27, left: 32 };
  const drawableWidth = chartWidth - chartPadding.left - chartPadding.right;
  const drawableHeight = chartHeight - chartPadding.top - chartPadding.bottom;
  const positionOf = (score: number, index: number) => ({
    x:
      points.length > 1
        ? chartPadding.left + (drawableWidth * index) / (points.length - 1)
        : chartPadding.left + drawableWidth / 2,
    y: chartPadding.top + ((100 - score) / 100) * drawableHeight
  });
  const linePoints = points
    .map((point, index) => {
      const position = positionOf(point.score, index);
      return `${position.x},${position.y}`;
    })
    .join(" ");
  const latestPoint = points[points.length - 1];
  const priorPoint = points[points.length - 2];
  const scoreChange = latestPoint && priorPoint ? latestPoint.score - priorPoint.score : undefined;

  return (
    <section className="growth-panel growth-trend-panel" aria-label="能力成长趋势">
      <header className="growth-trend-header">
        <div>
          <div className="growth-panel-title">
            <TrendingUp size={18} strokeWidth={2.2} />
            <h2>能力成长趋势</h2>
          </div>
          <p>基于每次已完成训练的评价记录</p>
        </div>
        <div className="growth-trend-tabs" role="group" aria-label="选择能力维度">
          {growthTrendMetrics.map((item) => (
            <button
              type="button"
              key={item.name}
              className={metric === item.name ? "is-active" : undefined}
              aria-pressed={metric === item.name}
              onClick={() => onMetricChange(item.name)}
            >
              {item.name}
            </button>
          ))}
        </div>
      </header>

      {points.length ? (
        <>
          <div className="growth-trend-chart-wrap">
            <svg
              className="growth-trend-chart"
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              role="img"
              aria-label={`${metric}随训练记录变化的折线图`}
            >
              {[25, 50, 75, 100].map((value) => {
                const y = chartPadding.top + ((100 - value) / 100) * drawableHeight;
                return (
                  <g key={value}>
                    <line x1={chartPadding.left} x2={chartWidth - chartPadding.right} y1={y} y2={y} />
                    <text x={chartPadding.left - 8} y={y + 4}>{value}</text>
                  </g>
                );
              })}
              {points.length > 1 ? <polyline points={linePoints} /> : null}
              {points.map((point, index) => {
                const position = positionOf(point.score, index);
                return (
                  <g key={point.record.id}>
                    <title>{`${point.record.title}：${point.score} 分`}</title>
                    <circle cx={position.x} cy={position.y} r={index === points.length - 1 ? 5 : 3.5} />
                    <text className="growth-trend-x-label" x={position.x} y={chartHeight - 7}>
                      {`训练${index + 1}`}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="growth-trend-insight">
            <strong>{metric}：{latestPoint?.score} 分</strong>
            <span>
              {scoreChange === undefined
                ? "完成下一次同类评价后，将形成可比较趋势。"
                : scoreChange === 0
                  ? "与上一次评价持平，建议结合证据记录确认下一步练习重点。"
                  : `较上一次${scoreChange > 0 ? "提升" : "下降"} ${Math.abs(scoreChange)} 分。`}
            </span>
            <small>最近证据：{latestPoint?.record.trainingType} · {latestPoint?.record.title}</small>
          </div>
        </>
      ) : (
        <div className="growth-trend-empty">
          <TrendingUp size={22} strokeWidth={1.9} />
          <p>{metric === "综合能力" ? "完成一次带评价的训练后，这里会显示能力趋势。" : `暂未积累可计算「${metric}」的评价记录。`}</p>
        </div>
      )}
    </section>
  );
}

function GrowthCenter({
  summary,
  status,
  recordPreview,
  recordPreviewStatus,
  onBackToChat,
  onExport,
  onStartTraining,
  onOpenTrainingRecord,
  onCloseTrainingRecord,
  onContinueTrainingRecord
}: {
  summary?: GrowthSummary;
  status?: string;
  recordPreview?: ConversationDetail;
  recordPreviewStatus?: string;
  onBackToChat: () => void;
  onExport: (type: "md" | "docx") => void;
  onStartTraining: (action: GrowthSummary["recommendedAction"]) => void;
  onOpenTrainingRecord: (conversationId: string) => void;
  onCloseTrainingRecord: () => void;
  onContinueTrainingRecord: (conversationId: string) => void;
}) {
  const [trendMetric, setTrendMetric] = useState<GrowthTrendMetric>("综合能力");
  const trainingCounts = summary?.trainingTypeCounts;
  const trainingTypeSummaries =
    summary?.trainingTypeSummaries?.length
      ? summary.trainingTypeSummaries
      : (["教案诊断", "说课陪练", "模拟课堂", "实习反思", "谈心谈话"] as TrainingType[]).map(
          (trainingType) => ({
            trainingType,
            count: trainingCounts?.[trainingType] || 0,
            averageScore: 0,
            latestTitle: undefined as string | undefined,
            latestScore: undefined as number | undefined,
            evidenceCount: 0,
            artifactCount: 0,
            citationCount: 0,
            status: trainingCounts?.[trainingType] ? ("已覆盖" as const) : ("待训练" as const),
            nextAction: "完成一次训练后生成下一步任务。"
          })
        );
  const coveredTrainingTypes = trainingTypeSummaries.filter(
    (item) => item.count > 0
  ).length;
  const weakNames =
    summary?.weakDimensions.slice(0, 3).map((dimension) => dimension.name).join("、") || "暂无薄弱项";
  const latestLift =
    summary?.recentEvaluations[0]?.suggestions?.[0] ||
    summary?.dimensionAverages[0]?.comment ||
    "完成一次训练后会生成阶段提升点。";
  const maxCount = Math.max(
    1,
    ...trainingTypeSummaries.map((item) => item.count)
  );
  const recommendedAction = summary?.recommendedAction || {
    trainingType: "教案诊断" as TrainingType,
    reason: "完成第一份带评价的训练记录后，系统才能判断你的能力起点。",
    objective: "先完成一次教案诊断，建立第一份能力基线。",
    completionCriteria: "完成本轮训练并生成一份带评价的记录。",
    prompt: "帮我生成一份完整教案，包含教学目标、重难点、流程、板书和课后反思。"
  };
  const evidenceRecords = summary?.evidenceRecords || [];
  const topCapabilities = [...(summary?.capabilityMatrix || [])]
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);
  const recentEvidence = [...evidenceRecords]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 3);
  const representativeArtifacts = (summary?.representativeArtifacts || []).slice(0, 3);
  const strongestDimension = [...(summary?.dimensionAverages || [])].sort((a, b) => b.score - a.score)[0];

  return (
    <section className="growth-center" aria-label="成长档案">
      <header className="knowledge-page-header">
        <div>
          <span>Growth Portfolio</span>
          <h1>成长报告</h1>
          <p>用一页看清当前阶段、关键证据和下一步训练。</p>
        </div>
        <div className="page-header-actions">
          <button type="button" onClick={() => onExport("md")}>
            <Download size={17} strokeWidth={2.2} />
            导出 MD
          </button>
          <button type="button" onClick={() => onExport("docx")}>
            <Download size={17} strokeWidth={2.2} />
            导出 Word
          </button>
          <button type="button" onClick={onBackToChat}>
            <MessageCircleQuestion size={17} strokeWidth={2.2} />
            回到对话
          </button>
        </div>
      </header>

      {status ? <p className="knowledge-status">{status}</p> : null}

      <div className="growth-layout growth-single-page">
        <section className="growth-hero-panel growth-report-summary growth-wide">
          <div className="growth-stage-summary">
            <span>当前成长结论</span>
            <strong>{summary?.growthStage || "建立基线"}</strong>
            <p>
              已完成 {summary?.totalTrainings || 0} 次训练，训练覆盖 {coveredTrainingTypes}/{trainingTypeSummaries.length}；
              平均得分 {summary?.averageScore || 0} 分，当前最需提升：{weakNames}。
            </p>
            <div className="growth-summary-metrics" aria-label="成长核心指标">
              <article>
                <span>平均分</span>
                <b>{summary?.averageScore || 0}</b>
              </article>
              <article>
                <span>训练次数</span>
                <b>{summary?.totalTrainings || 0}</b>
              </article>
              <article>
                <span>能力优势</span>
                <b>{strongestDimension?.name || "待生成"}</b>
              </article>
            </div>
            <p className="growth-latest-lift">最新提升点：{latestLift}</p>
          </div>
          <div className="growth-report-action">
            <span>推荐下一步 · {recommendedAction.trainingType}</span>
            <h2>{recommendedAction.objective}</h2>
            <p>{recommendedAction.reason}</p>
            <small>完成标准：{recommendedAction.completionCriteria}</small>
            <button type="button" onClick={() => onStartTraining(recommendedAction)}>
              开始本次训练
              <ChevronRight size={17} strokeWidth={2.4} />
            </button>
          </div>
        </section>

        <section className="growth-panel growth-capability-panel">
          <header>
            <BarChart3 size={18} strokeWidth={2.2} />
            <h2>能力地图</h2>
          </header>
          <div className="growth-dimensions capability-matrix-list">
            {topCapabilities.length ? (
              topCapabilities.map((dimension) => (
                <article
                  className="growth-dimension"
                  key={dimension.name}
                >
                  <div>
                    <strong>{dimension.name}</strong>
                    <span>{dimension.score} 分 · 达标线 80</span>
                  </div>
                  <div className="dimension-track">
                    <i style={{ width: `${dimension.score}%` }} />
                  </div>
                  <p>{dimension.evidence}</p>
                  <small>{dimension.nextAction}</small>
                </article>
              ))
            ) : (
              <p className="knowledge-muted">暂无能力矩阵，完成训练后会自动生成。</p>
            )}
          </div>
        </section>

        <GrowthTrendPanel
          timeline={evidenceRecords}
          metric={trendMetric}
          onMetricChange={setTrendMetric}
        />

        <section className="growth-panel growth-wide">
          <header>
            <Target size={18} strokeWidth={2.2} />
            <h2>训练覆盖</h2>
          </header>
          <div className="training-type-coverage">
            {trainingTypeSummaries.map((item) => (
              <article key={item.trainingType}>
                <div>
                  <strong>{item.trainingType}</strong>
                  <span className={item.status === "已覆盖" ? "is-covered" : "is-pending"}>
                    {item.status}
                  </span>
                </div>
                <div className="dimension-track">
                  <i style={{ width: `${(item.count / maxCount) * 100}%` }} />
                </div>
                <p>
                  {item.count} 次 · 均分 {item.averageScore || "--"} · 证据
                  {item.evidenceCount} 条 · 成果 {item.artifactCount} 个
                </p>
                <small>
                  {item.latestTitle ? `最新：${item.latestTitle}` : item.nextAction}
                </small>
              </article>
            ))}
          </div>
          <div className="reflection-growth-summary">
            <span>实习反思只是成长档案的一类证据</span>
            <strong>{summary?.reflectionSummary.totalReflections || 0} 篇</strong>
            <p>
              {summary?.reflectionSummary.latestTitle || "尚未生成实习反思"} · 证据
              {summary?.reflectionSummary.evidenceCount || 0} 条
            </p>
          </div>
        </section>

        <section className="growth-panel">
          <header>
            <Layers3 size={18} strokeWidth={2.2} />
            <h2>最近证据</h2>
          </header>
          <div className="growth-timeline">
            {recentEvidence.length ? (
              recentEvidence.map((item) => (
                <article key={item.id}>
                  <div>
                    <span>{item.trainingType}</span>
                    <strong>{item.title}</strong>
                    <small>{formatDateTime(item.createdAt)}</small>
                  </div>
                  <div>
                    <b>{item.score || "--"} 分</b>
                    <p>
                      薄弱项：{item.weakDimensions.join("、") || "暂无"} · 成果
                      {item.artifactCount} 个 · 引用 {item.citationCount} 条
                    </p>
                    <p>{item.nextTask}</p>
                    <button type="button" onClick={() => onOpenTrainingRecord(item.id)}>
                      查看记录摘要
                      <ChevronRight size={15} strokeWidth={2.3} />
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <p className="knowledge-muted">完成训练后会自动沉淀最近证据。</p>
            )}
          </div>
        </section>

        <section className="growth-panel">
          <header>
            <FileText size={18} strokeWidth={2.2} />
            <h2>代表性成果</h2>
          </header>
          <div className="representative-artifacts">
            {representativeArtifacts.length ? (
              representativeArtifacts.map((item) => (
                <article key={item.id}>
                  <div>
                    <span>{item.trainingType}</span>
                    <strong>{item.title}</strong>
                  </div>
                  <p>{item.reason}</p>
                  <small>
                    {item.score || "--"} 分 · 成果 {item.artifactCount} 个 · 引用{" "}
                    {item.citationCount} 条
                  </small>
                </article>
              ))
            ) : (
              <p className="knowledge-muted">生成教案、课堂报告或实习反思后会出现代表成果。</p>
            )}
          </div>
        </section>
      </div>
      {recordPreview || recordPreviewStatus ? (
        <TrainingRecordPreviewDialog
          conversation={recordPreview}
          status={recordPreviewStatus}
          onClose={onCloseTrainingRecord}
          onContinue={onContinueTrainingRecord}
        />
      ) : null}
    </section>
  );
}

function TrainingRecordPreviewDialog({
  conversation,
  status,
  onClose,
  onContinue
}: {
  conversation?: ConversationDetail;
  status?: string;
  onClose: () => void;
  onContinue: (conversationId: string) => void;
}) {
  const evaluation = conversation?.latestEvaluation;
  const lastAssistantMessage = conversation
    ? [...conversation.messages].reverse().find((message) => message.role === "assistant")
    : undefined;

  return createPortal(
    <div className="growth-record-modal" role="presentation" onMouseDown={onClose}>
      <section
        className="growth-record-preview"
        role="dialog"
        aria-modal="true"
        aria-label="训练记录摘要"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>训练记录摘要</span>
            <strong>{conversation?.title || "正在读取训练记录"}</strong>
            {conversation ? (
              <small>
                {conversation.trainingType} · {formatDateTime(conversation.updatedAt)}
              </small>
            ) : null}
          </div>
          <button type="button" aria-label="关闭训练记录摘要" onClick={onClose}>
            <X size={18} strokeWidth={2.2} />
          </button>
        </header>

        {status ? <p className="knowledge-status">{status}</p> : null}

        {conversation ? (
          <>
            <div className="growth-record-stats">
              <article>
                <span>综合评价</span>
                <b>{evaluation?.overallScore ?? "--"}</b>
              </article>
              <article>
                <span>消息</span>
                <b>{conversation.messageCount}</b>
              </article>
              <article>
                <span>引用</span>
                <b>{conversation.citationCount}</b>
              </article>
              <article>
                <span>成果</span>
                <b>{conversation.artifactCount}</b>
              </article>
            </div>

            <section className="growth-record-section">
              <h2>评价结论</h2>
              {evaluation ? (
                <>
                  <p>{evaluation.diagnosis.slice(0, 2).join("；") || "本次训练已生成评价记录。"}</p>
                  <div className="growth-record-dimensions">
                    {evaluation.dimensions.slice(0, 4).map((dimension) => (
                      <article key={dimension.name}>
                        <span>{dimension.name}</span>
                        <b>{dimension.score}</b>
                      </article>
                    ))}
                  </div>
                  <p>下一步：{evaluation.nextTask}</p>
                </>
              ) : (
                <p>这条记录暂时没有评价分数，可以继续训练后生成评价。</p>
              )}
            </section>

            <section className="growth-record-section">
              <h2>记录内容</h2>
              <p>{truncateText(markdownToPlain(lastAssistantMessage?.content || conversation.lastMessage || "") || "暂无内容摘要。", 320)}</p>
            </section>

            <section className="growth-record-section">
              <h2>资料状态</h2>
              <p>
                本记录关联 {conversation.knowledgeBaseIds.length} 个知识库。
                这里仅用于回看证据，不会改变当前对话已选择的知识库。
              </p>
            </section>

            <footer>
              <button type="button" onClick={onClose}>关闭</button>
              <button className="primary" type="button" onClick={() => onContinue(conversation.id)}>
                继续这次训练
                <ChevronRight size={16} strokeWidth={2.3} />
              </button>
            </footer>
          </>
        ) : null}
      </section>
    </div>,
    document.body
  );
}

const CHAT_MODEL_STORAGE_KEY = "starlattice.chat-model";

function readChatModelId(): string {
  try {
    return accountStorage.getItem(CHAT_MODEL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistChatModelId(id: string) {
  try {
    if (id) {
      accountStorage.setItem(CHAT_MODEL_STORAGE_KEY, id);
    } else {
      accountStorage.removeItem(CHAT_MODEL_STORAGE_KEY);
    }
  } catch {
    // 隐私模式下写不了本地存储，状态在当前会话里仍然有效。
  }
}

function App() {
  const auth = useAuth();
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  /** 从模型选择器点「添加或管理模型」时直接落到模型页签。 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  /** 对话页单独选的模型；空值表示跟随设置里的默认。 */
  const [chatModelId, setChatModelId] = useState(readChatModelId);

  useEffect(() => {
    applyAppearance(appearance);
    persistAppearance(appearance);
  }, [appearance]);

  const [activeSection, setActiveSection] = useState<
    | "workbench"
    | "chat"
    | "knowledge"
    | "history"
    | "growth"
    | "speak"
    | "counseling"
    | "classroom"
    | "platform"
    | "scenarios"
    | "registry"
    | "library"
    | "mcp"
    | "plugins"
    | "monitor"
    | "report"
    | "evolution"
  >("workbench");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [newTaskToken, setNewTaskToken] = useState(0);
  const [workflowOpenRequest, setWorkflowOpenRequest] = useState<
    { id: string; token: number; nodeId?: string } | undefined
  >();
  const [monitorRunRequest, setMonitorRunRequest] = useState<
    { runId: string; token: number } | undefined
  >();
  const [classroomRunRequest, setClassroomRunRequest] = useState<
    { runId: string; token: number } | undefined
  >();
  const [counselingRunRequest, setCounselingRunRequest] = useState<
    { runId: string; token: number } | undefined
  >();
  const [isVoiceOpen, setIsVoiceOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | undefined>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatMode, setChatMode] = useState<ChatMode>("education");
  // 自建智能体：为空表示用默认助手，选了就把它的角色/提示词/模型带上。
  const [chatAgents, setChatAgents] = useState<AgentRecord[]>([]);
  const [activeAgentId, setActiveAgentId] = useState("");
  // 空状态页「使用智能体」开关：打开才出现下拉选择，不把整排智能体都摆出来。
  const [agentPickerOn, setAgentPickerOn] = useState(false);
  const [agentVariableValues, setAgentVariableValues] = useState<Record<string, string>>({});
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowChatOption[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [workflowVariables, setWorkflowVariables] = useState<WorkflowInputVariable[]>([]);
  const [workflowLoadError, setWorkflowLoadError] = useState<string | undefined>();
  const chatModeBeforeWorkflowRef = useRef<"office" | "education">("education");
  const [currentTrainingType, setCurrentTrainingType] =
    useState<TrainingType>("教案诊断");
  const [activeInsightMessageId, setActiveInsightMessageId] = useState<
    string | undefined
  >();
  const [enableThinking, setEnableThinking] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [restoredCounselingSessionId, setRestoredCounselingSessionId] = useState<
    string | undefined
  >();
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [knowledgeProviders, setKnowledgeProviders] = useState<
    KnowledgeProviderInfo[]
  >([]);
  const [starterKnowledgePacks, setStarterKnowledgePacks] = useState<
    StarterKnowledgePack[]
  >([]);
  const [selectedKnowledgeBaseIds, setSelectedKnowledgeBaseIds] = useState<string[]>(
    []
  );
  const [pendingKnowledgeSelection, setPendingKnowledgeSelection] =
    useState<PendingKnowledgeSelection | undefined>();
  const [knowledgePanelRequestKey, setKnowledgePanelRequestKey] = useState(0);
  const [activeKnowledgeBaseId, setActiveKnowledgeBaseId] = useState<
    string | undefined
  >();
  const [knowledgeDocuments, setKnowledgeDocuments] = useState<
    KnowledgeDocument[]
  >([]);
  const [selectedKnowledgeDocumentId, setSelectedKnowledgeDocumentId] =
    useState<string | undefined>();
  const [knowledgeChunks, setKnowledgeChunks] = useState<KnowledgeChunk[]>([]);
  const [knowledgeSearchQuery, setKnowledgeSearchQuery] = useState("");
  const [knowledgeSearchResults, setKnowledgeSearchResults] = useState<
    KnowledgeCitation[]
  >([]);
  const [knowledgeSearchState, setKnowledgeSearchState] = useState<KnowledgeSearchState>(
    "idle"
  );
  const [knowledgeStatus, setKnowledgeStatus] = useState<string | undefined>();
  const [conversationHistory, setConversationHistory] = useState<
    ConversationSummary[]
  >([]);
  const [historyStatus, setHistoryStatus] = useState<string | undefined>();
  const [growthSummary, setGrowthSummary] = useState<GrowthSummary | undefined>();
  const [growthStatus, setGrowthStatus] = useState<string | undefined>();
  const [growthRecordPreview, setGrowthRecordPreview] =
    useState<ConversationDetail | undefined>();
  const [growthRecordPreviewStatus, setGrowthRecordPreviewStatus] =
    useState<string | undefined>();
  const activeRequestRef = useRef<AbortController | null>(null);
  // 当前选中的自建智能体；被删掉或还没加载出来时按默认助手处理。
  const activeAgent = chatAgents.find((agent) => agent.id === activeAgentId);
  const agentVariableDefs = activeAgent?.chatConfig?.variables ?? [];

  // 工作流会话：列表加载一次，选中项变化时再取该工作流的输入声明。
  useEffect(() => {
    let cancelled = false;
    void platformApi
      .listWorkflows()
      .then((payload) => {
        if (cancelled) {
          return;
        }
        const options = readWorkflowOptions(payload);
        setWorkflowOptions(options);
        setWorkflowLoadError(undefined);
        setSelectedWorkflowId((current) => current || options[0]?.id || "");
      })
      .catch(() => {
        if (!cancelled) {
          setWorkflowLoadError("工作流列表加载失败，请刷新页面重试。");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedWorkflowId) {
      setWorkflowVariables([]);
      return;
    }
    let cancelled = false;
    void platformApi
      .getWorkflow(selectedWorkflowId)
      .then((payload) => {
        if (!cancelled) {
          setWorkflowVariables(readWorkflowVariables(payload));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setWorkflowVariables([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkflowId]);

  useEffect(() => {
    void loadKnowledgeBases();
    void loadKnowledgeProviders();
    void loadStarterKnowledgePacks();
  }, []);

  // 自建智能体：进页面拉一次，注册中心新建后切回来也能看到。
  useEffect(() => {
    let cancelled = false;
    void platformApi
      .listAgents("chat")
      .then((payload) => {
        if (!cancelled) {
          setChatAgents(payload.agents.filter((agent) => agent.enabled));
        }
      })
      .catch(() => {
        // 拿不到就当没有自建智能体，不影响默认对话
      });
    return () => {
      cancelled = true;
    };
  }, [activeSection]);

  useEffect(() => {
    if (activeSection === "history") {
      void loadConversationHistory();
    }

    if (activeSection === "growth") {
      void loadGrowthSummary();
    }
  }, [activeSection]);

  useEffect(() => {
    if (!activeKnowledgeBaseId) {
      setKnowledgeDocuments([]);
      return;
    }

    void loadKnowledgeDocuments(activeKnowledgeBaseId);
  }, [activeKnowledgeBaseId]);

  useEffect(() => {
    if (!selectedKnowledgeDocumentId) {
      setKnowledgeChunks([]);
      return;
    }

    void loadKnowledgeChunks(selectedKnowledgeDocumentId);
  }, [selectedKnowledgeDocumentId]);

  async function loadKnowledgeBases(nextActiveId?: string) {
    try {
      const response = await fetch("/api/knowledge/bases");
      const payload = (await response.json()) as { bases: KnowledgeBase[] };
      const bases = payload.bases || [];
      setKnowledgeBases(bases);
      setActiveKnowledgeBaseId((current) => {
        if (nextActiveId) {
          return nextActiveId;
        }

        return current && bases.some((base) => base.id === current)
          ? current
          : bases[0]?.id;
      });
    } catch {
      setKnowledgeStatus("知识库列表加载失败。");
    }
  }

  async function loadKnowledgeProviders() {
    try {
      const response = await fetch("/api/knowledge/providers");
      const payload = (await response.json()) as {
        providers: KnowledgeProviderInfo[];
      };
      setKnowledgeProviders(payload.providers || []);
    } catch {
      setKnowledgeStatus("知识库平台状态加载失败。");
    }
  }

  async function loadStarterKnowledgePacks() {
    try {
      const response = await fetch("/api/knowledge/starter-packs");
      const payload = (await response.json()) as { packs: StarterKnowledgePack[] };
      setStarterKnowledgePacks(payload.packs || []);
    } catch {
      setKnowledgeStatus("示例资料包加载失败，请稍后重试。");
    }
  }

  async function importStarterKnowledgePack(packId: string) {
    setKnowledgeStatus("正在复制示例资料包...");

    try {
      const response = await fetch(`/api/knowledge/starter-packs/${packId}/import`, {
        method: "POST",
        headers: SAME_ORIGIN_HEADERS
      });
      const payload = (await response.json()) as { base?: KnowledgeBase; message?: string };

      if (!response.ok || !payload.base) {
        throw new Error(payload.message || "示例资料包导入失败。");
      }

      setKnowledgeStatus(`已复制「${payload.base.name}」，现在可以带着它开始训练。`);
      await loadKnowledgeBases(payload.base.id);
      setSelectedKnowledgeBaseIds([payload.base.id]);
    } catch (error) {
      setKnowledgeStatus(error instanceof Error ? error.message : "示例资料包导入失败。");
    }
  }

  function startTrainingFromMaterials(trainingType: TrainingType, knowledgeBaseId?: string) {
    const knowledgeBaseIds = knowledgeBaseId
      ? [knowledgeBaseId]
      : selectedKnowledgeBaseIds;
    setSelectedKnowledgeBaseIds(knowledgeBaseIds);
    setActiveInsightMessageId(undefined);

    if (trainingType === "谈心谈话") {
      setRestoredCounselingSessionId(undefined);
    }

    if (trainingType === "教案诊断") {
      startLessonPlanWizard(undefined, knowledgeBaseIds);
      return;
    }

    if (trainingType === "实习反思") {
      startInternshipReflectionWizard(undefined, knowledgeBaseIds);
      return;
    }

    setCurrentTrainingType(trainingType);
    setActiveSection(
      trainingType === "说课陪练"
        ? "speak"
        : trainingType === "谈心谈话"
          ? "counseling"
          : "classroom"
    );
  }

  async function testImaProvider() {
    setKnowledgeStatus("正在测试 IMA 连接...");

    try {
      const response = await fetch("/api/knowledge/providers/ima/test", {
        method: "POST",
        headers: SAME_ORIGIN_HEADERS
      });
      const payload = (await response.json()) as {
        result?: { message?: string; ok?: boolean };
      };

      if (!response.ok) {
        throw new Error(payload.result?.message || "IMA 连接测试失败。");
      }

      setKnowledgeStatus(payload.result?.message || "IMA 连接成功。");
      await loadKnowledgeProviders();
      await loadKnowledgeBases(activeKnowledgeBaseId);
    } catch (error) {
      setKnowledgeStatus(
        error instanceof Error ? error.message : "IMA 连接测试失败。"
      );
      await loadKnowledgeProviders();
    }
  }

  async function syncImaProvider() {
    setKnowledgeStatus("正在同步 IMA 知识库...");

    try {
      const response = await fetch("/api/knowledge/providers/ima/sync", {
        method: "POST",
        headers: SAME_ORIGIN_HEADERS
      });
      const payload = (await response.json()) as {
        result?: { message?: string; ok?: boolean; bases?: KnowledgeBase[] };
      };

      if (!response.ok) {
        throw new Error(payload.result?.message || "IMA 知识库同步失败。");
      }

      setKnowledgeStatus(payload.result?.message || "IMA 知识库已同步。");
      await loadKnowledgeProviders();
      await loadKnowledgeBases(payload.result?.bases?.[0]?.id || activeKnowledgeBaseId);
    } catch (error) {
      setKnowledgeStatus(
        error instanceof Error ? error.message : "IMA 知识库同步失败。"
      );
      await loadKnowledgeProviders();
    }
  }

  async function loadKnowledgeDocuments(baseId: string) {
    try {
      const response = await fetch(`/api/knowledge/bases/${baseId}/documents`);
      const payload = (await response.json()) as {
        documents: KnowledgeDocument[];
      };
      const documents = payload.documents || [];
      setKnowledgeDocuments(documents);
      setSelectedKnowledgeDocumentId((current) =>
        current && documents.some((document) => document.id === current)
          ? current
          : documents[0]?.id
      );
    } catch {
      setKnowledgeStatus("知识库文档加载失败。");
    }
  }

  async function loadKnowledgeChunks(documentId: string) {
    try {
      const response = await fetch(`/api/knowledge/documents/${documentId}/chunks`);
      const payload = (await response.json()) as { chunks: KnowledgeChunk[] };
      setKnowledgeChunks(payload.chunks || []);
    } catch {
      setKnowledgeStatus("文档分块加载失败。");
    }
  }

  async function createKnowledgeBase(name: string) {
    try {
      const response = await fetch("/api/knowledge/bases", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name })
      });
      const payload = (await response.json()) as { base: KnowledgeBase };

      if (!response.ok || !payload.base) {
        throw new Error("资料库创建失败。");
      }
      setKnowledgeStatus(`已创建「${payload.base.name}」。`);
      await loadKnowledgeBases(payload.base.id);
    } catch {
      setKnowledgeStatus("知识库创建失败。");
    }
  }

  async function renameKnowledgeBase(id: string, name: string) {
    try {
      const response = await fetch(`/api/knowledge/bases/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name })
      });
      const payload = (await response.json().catch(() => undefined)) as
        | { base?: KnowledgeBase; message?: string }
        | undefined;

      if (!response.ok || !payload?.base) {
        throw new Error(payload?.message || "资料库重命名失败。");
      }

      setKnowledgeStatus(`已将资料库重命名为「${payload.base.name}」。`);
      await loadKnowledgeBases(id);
    } catch (error) {
      setKnowledgeStatus(error instanceof Error ? error.message : "资料库重命名失败。");
    }
  }

  async function deleteKnowledgeBase(id: string) {
    try {
      const response = await fetch(`/api/knowledge/bases/${id}`, {
        method: "DELETE",
        headers: SAME_ORIGIN_HEADERS
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          | { message?: string }
          | undefined;
        throw new Error(payload?.message || "资料库删除失败。");
      }

      setKnowledgeStatus("资料库已删除。");
      setSelectedKnowledgeDocumentId(undefined);
      setKnowledgeChunks([]);
      await loadKnowledgeBases();
    } catch (error) {
      setKnowledgeStatus(error instanceof Error ? error.message : "资料库删除失败。");
    }
  }

  async function uploadKnowledgeDocument(
    baseId: string,
    file: File,
    metadata: KnowledgeDocumentMetadata
  ) {
    const formData = new FormData();
    formData.append("file", file, file.name);
    formData.append("resourceType", metadata.resourceType);
    formData.append("subject", metadata.subject);
    formData.append("schoolStage", metadata.schoolStage);
    formData.append("tags", JSON.stringify(metadata.tags));
    setKnowledgeStatus(`正在上传 ${file.name}...`);

    try {
      const response = await fetch(`/api/knowledge/bases/${baseId}/documents`, {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as
          | { message?: string }
          | undefined;
        throw new Error(payload?.message || "知识库资料上传失败。");
      }

      setKnowledgeStatus(`已上传 ${file.name}。`);
      await loadKnowledgeBases(baseId);
      await loadKnowledgeDocuments(baseId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "知识库资料上传失败。";
      setKnowledgeStatus(message);
      throw new Error(message);
    }
  }

  async function deleteKnowledgeDocument(documentId: string) {
    if (!activeKnowledgeBaseId) {
      return;
    }

    try {
      const response = await fetch(
        `/api/knowledge/bases/${activeKnowledgeBaseId}/documents/${documentId}`,
        { method: "DELETE", headers: SAME_ORIGIN_HEADERS }
      );

      if (!response.ok) {
        throw new Error("知识库文档删除失败。");
      }

      setKnowledgeStatus("文档已删除。");
      await loadKnowledgeBases(activeKnowledgeBaseId);
      await loadKnowledgeDocuments(activeKnowledgeBaseId);
    } catch {
      setKnowledgeStatus("知识库文档删除失败。");
    }
  }

  async function searchKnowledge() {
    const query = knowledgeSearchQuery.trim();
    const ids = activeKnowledgeBaseId ? [activeKnowledgeBaseId] : [];

    if (!query || ids.length === 0) {
      setKnowledgeSearchResults([]);
      setKnowledgeSearchState("idle");
      return;
    }

    setKnowledgeSearchState("loading");
    try {
      const response = await fetch("/api/knowledge/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          knowledgeBaseIds: ids,
          topK: 5
        })
      });
      const payload = (await response.json()) as {
        citations?: KnowledgeCitation[];
        message?: string;
      };

      if (!response.ok) {
        throw new Error(payload.message || "检索验证失败。");
      }

      const citations = payload.citations || [];
      setKnowledgeSearchResults(citations);
      setKnowledgeSearchState(citations.length ? "success" : "empty");
    } catch (error) {
      setKnowledgeSearchResults([]);
      setKnowledgeSearchState("error");
      setKnowledgeStatus(error instanceof Error ? error.message : "检索验证失败。");
    }
  }

  async function loadConversationHistory() {
    try {
      const response = await fetch("/api/conversations");
      const payload = (await response.json()) as {
        conversations: ConversationSummary[];
      };
      setConversationHistory(payload.conversations || []);
      setHistoryStatus(undefined);
    } catch {
      setHistoryStatus("对话记录加载失败。");
    }
  }

  async function restoreConversation(conversationId: string) {
    try {
      const response = await fetch(`/api/conversations/${conversationId}`);

      if (!response.ok) {
        throw new Error("对话记录不存在。");
      }

      const payload = (await response.json()) as {
        conversation: ConversationDetail;
      };
      const conversation = payload.conversation;
      if (conversation.trainingType === "谈心谈话") {
        setRestoredCounselingSessionId(conversation.id);
        setCurrentTrainingType("谈心谈话");
        setActiveInsightMessageId(undefined);
        setActiveSection("counseling");
        return;
      }
      const restoredMessages = conversation.messages.map((message, index) => {
        // 历史里也标上是谁回答的。存档里记了成功的转交记录（toolId=agent://xxx），
        // 说明那一轮是专项智能体答的，署名要还给它；否则退回会话绑定的智能体。
        const delegatedNote = message.toolNotes?.find(
          (note) => note.ok && (note.kind === "delegation" || note.toolId.startsWith("agent://"))
        );
        const delegatedName = delegatedNote?.name.replace(/^转交给/, "");
        const conversationAgent = chatAgents.find((agent) => agent.id === conversation.agentId);
        return {
          id: createId(`restored-${index}`),
          role: message.role,
          content: message.content,
          status: "done" as const,
          sourcePrompt: conversation.title,
          agentName:
            message.role === "assistant"
              ? message.agentName || delegatedName || conversationAgent?.name
              : undefined,
          agentAvatar:
            message.role === "assistant"
              ? message.agentAvatar || (delegatedName ? undefined : conversationAgent?.avatar)
              : undefined,
          toolNotes: message.toolNotes?.map((note) => ({
            toolId: note.toolId,
            name: note.name,
            stage: "done" as const,
            ok: note.ok,
            latencyMs: note.latencyMs,
            summary: note.summary,
            serverName: note.serverName,
            toolName: note.toolName,
            kind:
              note.kind ??
              (note.toolId.startsWith("agent://") ? ("delegation" as const) : ("tool" as const))
          })),
          artifacts:
            message.role === "assistant" && index === conversation.messages.length - 1
              ? conversation.artifacts
              : undefined,
        citations:
          message.role === "assistant" && index === conversation.messages.length - 1
            ? conversation.citations
            : undefined,
        evaluation:
          message.role === "assistant" && index === conversation.messages.length - 1
            ? conversation.latestEvaluation
            : undefined
        };
      });
      setConversationId(conversation.id);
      setMessages(restoredMessages);
      // 回到当初那个智能体，否则接着聊会突然换人格。
      // 智能体已经被删掉时退回默认助手，不然下一次发送会因为找不到人直接报错；
      // 列表还没加载完就先保留 id，宁可等一次加载也别把有效的绑定清掉。
      const boundAgent = conversation.agentId
        ? chatAgents.find((agent) => agent.id === conversation.agentId)
        : undefined;
      if (boundAgent) {
        setActiveAgentId(boundAgent.id);
      } else if (chatAgents.length > 0) {
        setActiveAgentId("");
      } else {
        setActiveAgentId(conversation.agentId ?? "");
      }
      if (conversation.workflowId) {
        // 工作流会话靠 workflow_id 还原，assistant_mode 仍保持 office，不改历史数据结构。
        setChatMode("workflow");
        setSelectedWorkflowId(conversation.workflowId);
      } else {
        const restoredMode = conversation.assistantMode === "office" ? "office" : "education";
        setChatMode(restoredMode);
      }
      if (conversation.trainingType !== "通用对话") {
        setCurrentTrainingType(conversation.trainingType);
      }
      setSelectedKnowledgeBaseIds(conversation.knowledgeBaseIds);
      setActiveInsightMessageId(undefined);
      setActiveSection("chat");
    } catch (error) {
      setHistoryStatus(
        error instanceof Error ? error.message : "对话记录恢复失败。"
      );
    }
  }

  async function openGrowthTrainingRecord(conversationId: string) {
    setGrowthRecordPreview(undefined);
    setGrowthRecordPreviewStatus("正在读取训练记录摘要...");

    try {
      const response = await fetch(`/api/conversations/${conversationId}`);

      if (!response.ok) {
        throw new Error("训练记录不存在。");
      }

      const payload = (await response.json()) as {
        conversation: ConversationDetail;
      };
      setGrowthRecordPreview(payload.conversation);
      setGrowthRecordPreviewStatus(undefined);
    } catch (error) {
      setGrowthRecordPreviewStatus(
        error instanceof Error ? error.message : "训练记录读取失败。"
      );
    }
  }

  function closeGrowthTrainingRecord() {
    setGrowthRecordPreview(undefined);
    setGrowthRecordPreviewStatus(undefined);
  }

  function continueGrowthTrainingRecord(conversationId: string) {
    closeGrowthTrainingRecord();
    void restoreConversation(conversationId);
  }

  async function loadGrowthSummary() {
    try {
      const response = await fetch("/api/growth/summary");
      const payload = (await response.json()) as { summary: GrowthSummary };
      setGrowthSummary(payload.summary);
      setGrowthStatus(undefined);
    } catch {
      setGrowthStatus("成长报告加载失败。");
    }
  }

  async function exportGrowthReport(type: "md" | "docx") {
    setGrowthStatus(`正在生成 ${type.toUpperCase()} 报告...`);

    try {
      const response = await fetch("/api/growth/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type })
      });

      if (!response.ok) {
        throw new Error("成长报告生成失败。");
      }

      const payload = (await response.json()) as { artifact: ChatArtifact };
      setGrowthStatus(`已生成 ${payload.artifact.name}。`);
      window.open(payload.artifact.url, "_blank", "noopener,noreferrer");
      await loadGrowthSummary();
    } catch (error) {
      setGrowthStatus(
        error instanceof Error ? error.message : "成长报告生成失败。"
      );
    }
  }

  async function streamGuidedAssistantMessage(
    messageId: string,
    content: string,
    options?: { simulateThinking?: boolean }
  ) {
    const visibleTextStreamer = createVisibleTextStreamer((chunk) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? { ...message, content: `${message.content || ""}${chunk}` }
            : message
        )
      );
    });

    if (options?.simulateThinking) {
      await wait(getGuidedThinkingDelayMs(messageId, content));
    }

    visibleTextStreamer.enqueue(content);
    await visibleTextStreamer.flush();
    const completedAt = Date.now();
    setMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              status: "done",
              thinkingSeconds: message.thinkingEnabled
                ? Math.max(
                    0,
                    (completedAt - (message.thinkingStartedAt || completedAt)) / 1000
                  )
                : message.thinkingSeconds
            }
          : message
      )
    );
  }

  async function exportLessonPlanDraft(draft: LessonPlanDraft) {
    const response = await fetch("/api/lesson-plans/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft })
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { message?: string }
        | undefined;
      throw new Error(payload?.message || "教案 Word 导出失败。");
    }

    const payload = (await response.json()) as { artifact: ChatArtifact };
    return payload.artifact;
  }

  function updateLessonPlanMessage(
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage
  ) {
    setMessages((current) =>
      current.map((message) => (message.id === messageId ? updater(message) : message))
    );
  }

  async function playLessonPlanThinkingStages(
    messageId: string,
    steps: GenerationThinkingStep[],
    controller: { cancelled: boolean }
  ) {
    for (let index = 0; index < steps.length; index += 1) {
      if (controller.cancelled) {
        return;
      }

      const step = steps[index];
      updateLessonPlanMessage(messageId, (message) => ({
        ...message,
        thinkingText: steps
          .slice(0, index + 1)
          .map((item) => `${item.label}：${item.detail}`)
          .join("\n"),
        lessonPlanState: message.lessonPlanState
          ? {
              ...message.lessonPlanState,
              status: step.label,
              thinkingProgress: buildThinkingProgress(steps, index)
            }
          : message.lessonPlanState
      }));
      await wait(GENERATION_STAGE_DELAY_MS + index * 90);
    }
  }

  function startLessonPlanWizard(
    prompt = quickTasks[0].prompt,
    knowledgeBaseIds = selectedKnowledgeBaseIds
  ) {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setPendingKnowledgeSelection(undefined);

    const firstStep = lessonPlanGuidedSteps[0];
    const input = createLessonPlanInput({
      ...inferLessonPlanPatchFromPrompt(prompt),
      knowledgeBaseIds
    });
    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      content: prompt
    };
    const assistantMessage: ChatMessage = {
      id: createId("assistant-lesson"),
      role: "assistant",
      content: "",
      status: "generating",
      thinkingEnabled: true,
      thinkingStartedAt: Date.now(),
      sourcePrompt: prompt,
      insightMode: "thinking",
      lessonPlanState: {
        phase: "collecting",
        input,
        collectionMode: "guided",
        currentStepId: firstStep.id,
        answeredStepIds: [],
        pendingQuestion: firstStep.question,
        isReadyToGenerate: false,
        citations: [],
        version: 1,
        status: "请直接在底部输入框回答，回复“跳过”可使用默认值。"
      }
    };

    setChatMode("education");
    setCurrentTrainingType("教案诊断");
    setActiveSection("chat");
    setInputValue("");
    setAttachments([]);
    setAttachmentError(undefined);
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setActiveInsightMessageId(undefined);
    void streamGuidedAssistantMessage(assistantMessage.id, firstStep.question, {
      simulateThinking: true
    });
  }

  function updateLessonPlanMessageInput(
    messageId: string,
    patch: Partial<LessonPlanInput>
  ) {
    updateLessonPlanMessage(messageId, (message) => {
      const state = message.lessonPlanState;

      if (!state) {
        return message;
      }

      return {
        ...message,
        lessonPlanState: {
          ...state,
          input: {
            ...state.input,
            ...patch
          },
          status: "信息已更新，点击生成后会按最新内容产出教案。"
        }
      };
    });
  }

  function toggleLessonPlanMessageKnowledgeBase(messageId: string, baseId: string) {
    updateLessonPlanMessage(messageId, (message) => {
      const state = message.lessonPlanState;

      if (!state) {
        return message;
      }

      const knowledgeBaseIds = state.input.knowledgeBaseIds.includes(baseId)
        ? state.input.knowledgeBaseIds.filter((item) => item !== baseId)
        : [...state.input.knowledgeBaseIds, baseId];

      return {
        ...message,
        lessonPlanState: {
          ...state,
          input: {
            ...state.input,
            knowledgeBaseIds
          },
          status: knowledgeBaseIds.length
            ? `已选择 ${knowledgeBaseIds.length} 个知识库。`
            : "已取消知识库引用，将使用默认实训框架。"
        }
      };
    });
  }

  async function runLessonPlanRequest(
    messageId: string,
    action: "generate" | "refine",
    state: LessonPlanState
  ) {
    const startedAt = Date.now();
    const busyPhase: LessonPlanPhase = action === "generate" ? "generating" : "refining";
    const busyText = action === "generate" ? "正在生成教案..." : "正在按建议优化...";
    const thinkingSteps =
      action === "generate"
        ? lessonPlanGenerateThinkingSteps
        : lessonPlanRefineThinkingSteps;
    let streamPayload: LessonPlanResponse | undefined;

    setIsGenerating(true);
    updateLessonPlanMessage(messageId, (message) => ({
      ...message,
      status: "generating",
      thinkingEnabled: true,
      thinkingStartedAt: startedAt,
      thinkingText: "",
      insightMode: "thinking",
      lessonPlanState: message.lessonPlanState
        ? {
            ...message.lessonPlanState,
            phase: busyPhase,
            status: busyText,
            thinkingProgress: buildThinkingProgress(thinkingSteps, 0)
          }
        : {
            ...state,
            phase: busyPhase,
            status: busyText,
            thinkingProgress: buildThinkingProgress(thinkingSteps, 0)
          }
    }));

    try {
      const response = await fetch(`/api/lesson-plans/${action}/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...state.input,
          input: state.input,
          draft: action === "refine" ? state.draft : undefined,
          conversationId: state.conversationId
        })
      });

      await readChatStream(response, {
        onDelta(content) {
          updateLessonPlanMessage(messageId, (message) => ({
            ...message,
            content: `${message.content || ""}${content}`
          }));
        },
        onThinkingDelta(content) {
          updateLessonPlanMessage(messageId, (message) => ({
            ...message,
            thinkingText: `${message.thinkingText || ""}${content}`
          }));
        },
        onPhase(phase) {
          const progress = normalizeStreamPhaseProgress(phase, thinkingSteps);
          updateLessonPlanMessage(messageId, (message) => ({
            ...message,
            lessonPlanState: message.lessonPlanState
              ? {
                  ...message.lessonPlanState,
                  status: phase.label || message.lessonPlanState.status,
                  thinkingProgress: progress
                }
              : message.lessonPlanState
          }));
        },
        onMetrics(thinkingSeconds) {
          updateLessonPlanMessage(messageId, (message) => ({
            ...message,
            thinkingSeconds
          }));
        },
        onArtifact(artifact) {
          updateLessonPlanMessage(messageId, (message) => ({
            ...message,
            artifacts: [...(message.artifacts || []), artifact]
          }));
        },
        onCitation(citation) {
          updateLessonPlanMessage(messageId, (message) => ({
            ...message,
            citations: [...(message.citations || []), citation]
          }));
        },
        onEvaluation(evaluation) {
          updateLessonPlanMessage(messageId, (message) => ({
            ...message,
            evaluation
          }));
        },
        onDone(payload) {
          if (!payload.draft || !payload.diagnostic || !payload.evaluation) {
            return;
          }

          streamPayload = {
            conversationId: payload.conversationId || "",
            draft: payload.draft as LessonPlanDraft,
            diagnostic: payload.diagnostic as LessonPlanDiagnostic,
            citations: payload.citations || [],
            evaluation: payload.evaluation,
            comparison: payload.comparison
          };
        },
        onError(message) {
          throw new Error(message);
        }
      });

      if (!streamPayload) {
        throw new Error("教案流式生成未返回结果。");
      }

      const finalPayload = streamPayload;
      let artifact: ChatArtifact | undefined;
      let exportStatus = "教案已生成，Word 文件已准备好。";

      try {
        artifact = await exportLessonPlanDraft(finalPayload.draft);
      } catch (error) {
        exportStatus =
          error instanceof Error
            ? `教案已生成，但 ${error.message}`
            : "教案已生成，但 Word 导出失败。";
      }

      updateLessonPlanMessage(messageId, (message) => ({
        ...message,
        content: `${finalPayload.draft.title} 已生成，正在整理预览。`,
        lessonPlanState: message.lessonPlanState
          ? {
              ...message.lessonPlanState,
              status: "生成完成，正在展开结果预览",
              thinkingProgress: completeThinkingProgress(thinkingSteps)
            }
          : message.lessonPlanState
      }));
      await wait(RESULT_REVEAL_DELAY_MS);

      const thinkingSeconds = Math.max(0.2, (Date.now() - startedAt) / 1000);
      updateLessonPlanMessage(messageId, (message) => ({
        ...message,
        content: `${finalPayload.draft.title} 已生成。`,
        status: "done",
        thinkingSeconds,
        artifacts: artifact ? [artifact] : [],
        citations: finalPayload.citations || [],
        evaluation: finalPayload.evaluation,
        insightMode: "lessonPreview",
        lessonPlanState: {
          phase: "generated",
          input: finalPayload.draft.input,
          draft: finalPayload.draft,
          diagnostic: finalPayload.diagnostic,
          comparison: finalPayload.comparison,
          citations: finalPayload.citations || [],
          artifact,
          conversationId: finalPayload.conversationId,
          version: finalPayload.draft.version,
          status: exportStatus,
          thinkingProgress: completeThinkingProgress(thinkingSteps)
        }
      }));
      await loadConversationHistory();
      await loadGrowthSummary();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "教案生成失败，请稍后重试。";
      const thinkingSeconds = Math.max(0.2, (Date.now() - startedAt) / 1000);
      updateLessonPlanMessage(messageId, (currentMessage) => ({
        ...currentMessage,
        content: message,
        status: "error",
        thinkingSeconds,
        lessonPlanState: currentMessage.lessonPlanState
          ? {
              ...currentMessage.lessonPlanState,
              phase: "error",
              status: message
            }
          : state
      }));
    } finally {
      setIsGenerating(false);
    }
  }

  function submitLessonPlanMessage(messageId: string) {
    const message = messages.find((item) => item.id === messageId);
    const state = message?.lessonPlanState;

    if (!state) {
      return;
    }

    void runLessonPlanRequest(messageId, "generate", state);
  }

  function refineLessonPlanMessage(messageId: string) {
    const sourceMessage = messages.find((item) => item.id === messageId);
    const sourceState = sourceMessage?.lessonPlanState;

    if (!sourceState?.draft) {
      return;
    }

    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      content: "按建议优化这份教案。"
    };
    const assistantId = createId("assistant-lesson");
    const nextState: LessonPlanState = {
      phase: "refining",
      input: sourceState.input,
      draft: sourceState.draft,
      diagnostic: sourceState.diagnostic,
      citations: sourceState.citations,
      artifact: sourceState.artifact,
      conversationId: sourceState.conversationId,
      version: sourceState.version + 1,
      status: "正在根据诊断建议生成优化版教案..."
    };
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      status: "generating",
      thinkingEnabled: true,
      thinkingStartedAt: Date.now(),
      sourcePrompt: "按建议优化这份教案。",
      insightMode: "thinking",
      lessonPlanState: nextState
    };

    setMessages((current) => [...current, userMessage, assistantMessage]);
    setActiveInsightMessageId(undefined);
    void runLessonPlanRequest(assistantId, "refine", nextState);
  }

  function resetLessonPlanMessage(messageId: string) {
    setPendingKnowledgeSelection(undefined);
    updateLessonPlanMessage(messageId, (message) => {
      const state = message.lessonPlanState;

      if (!state) {
        return message;
      }
      const firstStep = lessonPlanGuidedSteps[0];

      return {
        ...message,
        content: "",
        status: "generating",
        thinkingEnabled: true,
        thinkingStartedAt: Date.now(),
        thinkingSeconds: undefined,
        thinkingText: "",
        artifacts: [],
        citations: [],
        evaluation: undefined,
        insightMode: "thinking",
        lessonPlanState: {
          phase: "collecting",
          input: createLessonPlanInput({
            knowledgeBaseIds: state.input.knowledgeBaseIds
          }),
          collectionMode: "guided",
          currentStepId: firstStep.id,
          answeredStepIds: [],
          pendingQuestion: firstStep.question,
          isReadyToGenerate: false,
          citations: [],
          version: state.version,
          status: "已重新开始教案设计链，请在底部输入框回答第一个问题。"
        }
      };
    });
    void streamGuidedAssistantMessage(messageId, lessonPlanGuidedSteps[0].question, {
      simulateThinking: true
    });
  }

  function openLessonPlanPreview(messageId: string) {
    updateLessonPlanMessage(messageId, (message) => ({
      ...message,
      insightMode: "lessonPreview"
    }));
    setActiveInsightMessageId(messageId);
  }

  function downloadLessonPlanMessage(messageId: string) {
    const artifact = messages.find((message) => message.id === messageId)
      ?.lessonPlanState?.artifact;

    if (artifact) {
      window.open(artifact.url, "_blank", "noopener,noreferrer");
    }
  }

  async function exportInternshipReflectionDraft(draft: InternshipReflectionDraft) {
    const response = await fetch("/api/internship-reflections/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ draft })
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        | { message?: string }
        | undefined;
      throw new Error(payload?.message || "实习反思 Word 导出失败。");
    }

    const payload = (await response.json()) as { artifact: ChatArtifact };
    return payload.artifact;
  }

  function updateReflectionMessage(
    messageId: string,
    updater: (message: ChatMessage) => ChatMessage
  ) {
    setMessages((current) =>
      current.map((message) => (message.id === messageId ? updater(message) : message))
    );
  }

  async function playReflectionThinkingStages(
    messageId: string,
    steps: GenerationThinkingStep[],
    controller: { cancelled: boolean }
  ) {
    for (let index = 0; index < steps.length; index += 1) {
      if (controller.cancelled) {
        return;
      }

      const step = steps[index];
      updateReflectionMessage(messageId, (message) => ({
        ...message,
        thinkingText: steps
          .slice(0, index + 1)
          .map((item) => `${item.label}：${item.detail}`)
          .join("\n"),
        internshipReflectionState: message.internshipReflectionState
          ? {
              ...message.internshipReflectionState,
              status: step.label,
              thinkingProgress: buildThinkingProgress(steps, index)
            }
          : message.internshipReflectionState
      }));
      await wait(GENERATION_STAGE_DELAY_MS + index * 90);
    }
  }

  function startInternshipReflectionWizard(
    prompt = quickTasks[3].prompt,
    knowledgeBaseIds = selectedKnowledgeBaseIds
  ) {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setPendingKnowledgeSelection(undefined);

    const firstStep = reflectionGuidedSteps[0];
    const input = createInternshipReflectionInput({
      ...inferInternshipReflectionPatchFromPrompt(prompt),
      knowledgeBaseIds
    });
    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      content: prompt
    };
    const assistantMessage: ChatMessage = {
      id: createId("assistant-reflection"),
      role: "assistant",
      content: "",
      status: "generating",
      thinkingEnabled: true,
      thinkingStartedAt: Date.now(),
      sourcePrompt: prompt,
      insightMode: "thinking",
      internshipReflectionState: {
        phase: "collecting",
        input,
        evidence: [],
        evidenceFiles: [],
        collectionMode: "guided",
        currentStepId: firstStep.id,
        answeredStepIds: [],
        pendingQuestion: firstStep.question,
        isReadyToGenerate: false,
        citations: [],
        version: 1,
        status: "请直接在底部输入框回答；到证据步骤时可上传图片、听课记录或作业材料。"
      }
    };

    setChatMode("education");
    setCurrentTrainingType("实习反思");
    setActiveSection("chat");
    setInputValue("");
    setAttachments([]);
    setAttachmentError(undefined);
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setActiveInsightMessageId(undefined);
    void streamGuidedAssistantMessage(assistantMessage.id, firstStep.question, {
      simulateThinking: true
    });
  }

  function updateReflectionMessageInput(
    messageId: string,
    patch: Partial<InternshipReflectionInput>
  ) {
    updateReflectionMessage(messageId, (message) => {
      const state = message.internshipReflectionState;

      if (!state) {
        return message;
      }

      return {
        ...message,
        internshipReflectionState: {
          ...state,
          input: {
            ...state.input,
            ...patch
          },
          status: "信息已更新，点击生成后会按最新内容整理实习反思。"
        }
      };
    });
  }

  function toggleReflectionKnowledgeBase(messageId: string, baseId: string) {
    updateReflectionMessage(messageId, (message) => {
      const state = message.internshipReflectionState;

      if (!state) {
        return message;
      }

      const knowledgeBaseIds = state.input.knowledgeBaseIds.includes(baseId)
        ? state.input.knowledgeBaseIds.filter((item) => item !== baseId)
        : [...state.input.knowledgeBaseIds, baseId];

      return {
        ...message,
        internshipReflectionState: {
          ...state,
          input: {
            ...state.input,
            knowledgeBaseIds
          },
          status: knowledgeBaseIds.length
            ? `已选择 ${knowledgeBaseIds.length} 个知识库。`
            : "已取消知识库引用，将使用默认反思框架。"
        }
      };
    });
  }

  function attachReflectionEvidence(messageId: string, files: FileList | null) {
    if (!files?.length) {
      return;
    }

    const incomingFiles = Array.from(files);
    const unsupportedFile = incomingFiles.find((file) => !isSupportedAttachment(file));

    if (unsupportedFile) {
      updateReflectionMessage(messageId, (message) => ({
        ...message,
        internshipReflectionState: message.internshipReflectionState
          ? {
              ...message.internshipReflectionState,
              status: `暂不支持 ${unsupportedFile.name}，请上传图片、PDF、TXT、MD、CSV 或 JSON。`
            }
          : undefined
      }));
      return;
    }

    updateReflectionMessage(messageId, (message) => {
      const state = message.internshipReflectionState;

      if (!state) {
        return message;
      }

      if (state.evidenceFiles.length + incomingFiles.length > MAX_ATTACHMENT_COUNT) {
        return {
          ...message,
          internshipReflectionState: {
            ...state,
            status: `最多一次上传 ${MAX_ATTACHMENT_COUNT} 个证据材料。`
          }
        };
      }

      const nextTotalSize =
        state.evidenceFiles.reduce((total, attachment) => total + attachment.size, 0) +
        incomingFiles.reduce((total, file) => total + file.size, 0);

      if (nextTotalSize > MAX_ATTACHMENT_TOTAL_SIZE) {
        return {
          ...message,
          internshipReflectionState: {
            ...state,
            status: `证据材料总大小不能超过 ${formatFileSize(MAX_ATTACHMENT_TOTAL_SIZE)}。`
          }
        };
      }

      const nextFiles = incomingFiles.map((file) => ({
        id: createId("evidence"),
        file,
        name: file.name,
        size: file.size,
        previewUrl: file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : undefined
      }));

      return {
        ...message,
        internshipReflectionState: {
          ...state,
          evidenceFiles: [...state.evidenceFiles, ...nextFiles],
          status: `已添加 ${incomingFiles.length} 个课堂证据材料。`
        }
      };
    });
  }

  function removeReflectionEvidence(messageId: string, attachmentId: string) {
    updateReflectionMessage(messageId, (message) => {
      const state = message.internshipReflectionState;

      if (!state) {
        return message;
      }

      const target = state.evidenceFiles.find((file) => file.id === attachmentId);

      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }

      return {
        ...message,
        internshipReflectionState: {
          ...state,
          evidenceFiles: state.evidenceFiles.filter((file) => file.id !== attachmentId),
          status: "已移除证据材料。"
        }
      };
    });
  }

  async function runReflectionRequest(
    messageId: string,
    action: "generate" | "refine",
    state: InternshipReflectionState
  ) {
    const startedAt = Date.now();
    const busyPhase: InternshipReflectionPhase =
      action === "generate" ? "generating" : "refining";
    const busyText =
      action === "generate" ? "正在生成实习反思..." : "正在按建议优化实习反思...";
    const thinkingSteps =
      action === "generate"
        ? reflectionGenerateThinkingSteps
        : reflectionRefineThinkingSteps;
    let streamPayload: InternshipReflectionResponse | undefined;

    setIsGenerating(true);
    updateReflectionMessage(messageId, (message) => ({
      ...message,
      status: "generating",
      thinkingEnabled: true,
      thinkingStartedAt: startedAt,
      thinkingText: "",
      insightMode: "thinking",
      internshipReflectionState: message.internshipReflectionState
        ? {
            ...message.internshipReflectionState,
            phase: busyPhase,
            status: busyText,
            thinkingProgress: buildThinkingProgress(thinkingSteps, 0)
          }
        : {
            ...state,
            phase: busyPhase,
            status: busyText,
            thinkingProgress: buildThinkingProgress(thinkingSteps, 0)
          }
    }));

    try {
      const formData = new FormData();
      formData.append("input", JSON.stringify(state.input));
      formData.append("evidence", JSON.stringify(state.evidence));

      if (action === "refine" && state.draft) {
        formData.append("draft", JSON.stringify(state.draft));
      }

      if (state.conversationId) {
        formData.append("conversationId", state.conversationId);
      }

      for (const attachment of state.evidenceFiles) {
        formData.append("files", attachment.file, attachment.name);
      }

      const response = await fetch(`/api/internship-reflections/${action}/stream`, {
        method: "POST",
        body: formData
      });

      await readChatStream(response, {
        onDelta(content) {
          updateReflectionMessage(messageId, (message) => ({
            ...message,
            content: `${message.content || ""}${content}`
          }));
        },
        onThinkingDelta(content) {
          updateReflectionMessage(messageId, (message) => ({
            ...message,
            thinkingText: `${message.thinkingText || ""}${content}`
          }));
        },
        onPhase(phase) {
          const progress = normalizeStreamPhaseProgress(phase, thinkingSteps);
          updateReflectionMessage(messageId, (message) => ({
            ...message,
            internshipReflectionState: message.internshipReflectionState
              ? {
                  ...message.internshipReflectionState,
                  status: phase.label || message.internshipReflectionState.status,
                  thinkingProgress: progress
                }
              : message.internshipReflectionState
          }));
        },
        onMetrics(thinkingSeconds) {
          updateReflectionMessage(messageId, (message) => ({
            ...message,
            thinkingSeconds
          }));
        },
        onArtifact(artifact) {
          updateReflectionMessage(messageId, (message) => ({
            ...message,
            artifacts: [...(message.artifacts || []), artifact]
          }));
        },
        onCitation(citation) {
          updateReflectionMessage(messageId, (message) => ({
            ...message,
            citations: [...(message.citations || []), citation]
          }));
        },
        onEvaluation(evaluation) {
          updateReflectionMessage(messageId, (message) => ({
            ...message,
            evaluation
          }));
        },
        onDone(payload) {
          if (!payload.draft || !payload.diagnostic || !payload.evaluation) {
            return;
          }

          streamPayload = {
            conversationId: payload.conversationId || "",
            draft: payload.draft as InternshipReflectionDraft,
            diagnostic: payload.diagnostic as InternshipReflectionDiagnostic,
            citations: payload.citations || [],
            evidence: payload.evidence || [],
            evaluation: payload.evaluation
          };
        },
        onError(message) {
          throw new Error(message);
        }
      });

      if (!streamPayload) {
        throw new Error("实习反思流式生成未返回结果。");
      }

      const finalPayload = streamPayload;
      let artifact: ChatArtifact | undefined;
      let exportStatus = "实习反思已生成，Word 文件已准备好。";

      try {
        artifact = await exportInternshipReflectionDraft(finalPayload.draft);
      } catch (error) {
        exportStatus =
          error instanceof Error
            ? `实习反思已生成，但 ${error.message}`
            : "实习反思已生成，但 Word 导出失败。";
      }

      updateReflectionMessage(messageId, (message) => ({
        ...message,
        content: `${finalPayload.draft.title} 已生成，正在整理预览。`,
        internshipReflectionState: message.internshipReflectionState
          ? {
              ...message.internshipReflectionState,
              status: "生成完成，正在展开结果预览",
              thinkingProgress: completeThinkingProgress(thinkingSteps)
            }
          : message.internshipReflectionState
      }));
      await wait(RESULT_REVEAL_DELAY_MS);

      const thinkingSeconds = Math.max(0.2, (Date.now() - startedAt) / 1000);
      updateReflectionMessage(messageId, (message) => ({
        ...message,
        content: `${finalPayload.draft.title} 已生成。`,
        status: "done",
        thinkingSeconds,
        artifacts: artifact ? [artifact] : [],
        citations: finalPayload.citations || [],
        evaluation: finalPayload.evaluation,
        insightMode: "reflectionPreview",
        internshipReflectionState: {
          phase: "generated",
          input: finalPayload.draft.input,
          evidence: finalPayload.evidence || finalPayload.draft.evidence || [],
          evidenceFiles: state.evidenceFiles,
          draft: finalPayload.draft,
          diagnostic: finalPayload.diagnostic,
          citations: finalPayload.citations || [],
          artifact,
          conversationId: finalPayload.conversationId,
          version: finalPayload.draft.version,
          status: exportStatus,
          thinkingProgress: completeThinkingProgress(thinkingSteps)
        }
      }));
      await loadConversationHistory();
      await loadGrowthSummary();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "实习反思生成失败，请稍后重试。";
      const thinkingSeconds = Math.max(0.2, (Date.now() - startedAt) / 1000);
      updateReflectionMessage(messageId, (currentMessage) => ({
        ...currentMessage,
        content: message,
        status: "error",
        thinkingSeconds,
        internshipReflectionState: currentMessage.internshipReflectionState
          ? {
              ...currentMessage.internshipReflectionState,
              phase: "error",
              status: message
            }
          : state
      }));
    } finally {
      setIsGenerating(false);
    }
  }

  function submitReflectionMessage(messageId: string) {
    const message = messages.find((item) => item.id === messageId);
    const state = message?.internshipReflectionState;

    if (!state) {
      return;
    }

    void runReflectionRequest(messageId, "generate", state);
  }

  function refineReflectionMessage(messageId: string) {
    const sourceMessage = messages.find((item) => item.id === messageId);
    const sourceState = sourceMessage?.internshipReflectionState;

    if (!sourceState?.draft) {
      return;
    }

    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      content: "按建议优化这篇实习反思。"
    };
    const assistantId = createId("assistant-reflection");
    const nextState: InternshipReflectionState = {
      phase: "refining",
      input: sourceState.input,
      evidence: sourceState.evidence,
      evidenceFiles: sourceState.evidenceFiles,
      draft: sourceState.draft,
      diagnostic: sourceState.diagnostic,
      citations: sourceState.citations,
      artifact: sourceState.artifact,
      conversationId: sourceState.conversationId,
      version: sourceState.version + 1,
      status: "正在根据诊断建议生成优化版实习反思..."
    };
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      status: "generating",
      thinkingEnabled: true,
      thinkingStartedAt: Date.now(),
      sourcePrompt: "按建议优化这篇实习反思。",
      insightMode: "thinking",
      internshipReflectionState: nextState
    };

    setMessages((current) => [...current, userMessage, assistantMessage]);
    setActiveInsightMessageId(undefined);
    void runReflectionRequest(assistantId, "refine", nextState);
  }

  function resetReflectionMessage(messageId: string) {
    updateReflectionMessage(messageId, (message) => {
      const state = message.internshipReflectionState;

      if (!state) {
        return message;
      }
      const firstStep = reflectionGuidedSteps[0];

      return {
        ...message,
        content: "",
        status: "generating",
        thinkingEnabled: true,
        thinkingStartedAt: Date.now(),
        thinkingSeconds: undefined,
        thinkingText: "",
        artifacts: [],
        citations: [],
        evaluation: undefined,
        insightMode: "thinking",
        internshipReflectionState: {
          phase: "collecting",
          input: createInternshipReflectionInput({
            knowledgeBaseIds: state.input.knowledgeBaseIds
          }),
          evidence: [],
          evidenceFiles: [],
          collectionMode: "guided",
          currentStepId: firstStep.id,
          answeredStepIds: [],
          pendingQuestion: firstStep.question,
          isReadyToGenerate: false,
          citations: [],
          version: state.version,
          status: "已重新开始证据反思链，请在底部输入框回答第一个问题。"
        }
      };
    });
    void streamGuidedAssistantMessage(messageId, reflectionGuidedSteps[0].question, {
      simulateThinking: true
    });
  }

  function openReflectionPreview(messageId: string) {
    updateReflectionMessage(messageId, (message) => ({
      ...message,
      insightMode: "reflectionPreview"
    }));
    setActiveInsightMessageId(messageId);
  }

  function downloadReflectionMessage(messageId: string) {
    const artifact = messages.find((message) => message.id === messageId)
      ?.internshipReflectionState?.artifact;

    if (artifact) {
      window.open(artifact.url, "_blank", "noopener,noreferrer");
    }
  }

  function completePendingLessonKnowledgeSelection(useKnowledgeBases: boolean) {
    const targetMessage = pendingKnowledgeSelection
      ? messages.find((message) => message.id === pendingKnowledgeSelection.messageId)
      : getActiveGuidedMessage(messages);
    const state = targetMessage?.lessonPlanState;

    if (!targetMessage || !state) {
      return false;
    }

    const currentStep =
      lessonPlanGuidedSteps.find((step) => step.id === state.currentStepId) ||
      lessonPlanGuidedSteps[0];

    if (currentStep.field !== "knowledgeBaseIds") {
      return false;
    }

    if (useKnowledgeBases && selectedKnowledgeBaseIds.length === 0) {
      return false;
    }

    const knowledgeBaseIds = useKnowledgeBases ? selectedKnowledgeBaseIds : [];
    const knowledgeBaseChoice = resolveKnowledgeBaseChoice(
      useKnowledgeBases ? "需要" : "不需要",
      knowledgeBaseIds
    );

    if (
      knowledgeBaseChoice.kind === "missing" ||
      knowledgeBaseChoice.kind === "unclear"
    ) {
      return false;
    }

    const nextInput = {
      ...state.input,
      knowledgeBaseIds: knowledgeBaseChoice.knowledgeBaseIds
    };
    const answeredStepIds = Array.from(
      new Set([...(state.answeredStepIds || []), currentStep.id])
    );
    const nextStep = getNextGuidedQuestion(lessonPlanGuidedSteps, answeredStepIds);
    const isReady = !nextStep;
    const assistantContent = `${knowledgeBaseChoice.message}\n\n${
      isReady
        ? formatGuidedReadyMessage(nextInput, lessonPlanGuidedSteps, "教案信息摘要")
        : nextStep.question
    }`;
    const assistantMessage: ChatMessage = {
      id: createId("assistant-lesson"),
      role: "assistant",
      content: "",
      status: "generating",
      thinkingEnabled: true,
      thinkingStartedAt: Date.now(),
      sourcePrompt: targetMessage.sourcePrompt,
      insightMode: "thinking",
      lessonPlanState: {
        ...state,
        input: nextInput,
        currentStepId: nextStep?.id,
        answeredStepIds,
        pendingQuestion: nextStep?.question,
        isReadyToGenerate: isReady,
        status: isReady
          ? "信息已收集完成，回复“生成”即可生成 Word 教案。"
          : `${nextStep.agentName} 正在追问：${nextStep.label}`
      }
    };

    setMessages((current) => [
      ...current.map((message) =>
        message.id === targetMessage.id
          ? { ...message, lessonPlanState: undefined }
          : message
      ),
      assistantMessage
    ]);

    if (!useKnowledgeBases) {
      setSelectedKnowledgeBaseIds([]);
    }

    setPendingKnowledgeSelection(undefined);
    setInputValue("");
    setAttachments([]);
    setAttachmentError(undefined);
    void streamGuidedAssistantMessage(assistantMessage.id, assistantContent, {
      simulateThinking: true
    });
    return true;
  }

  function handleGuidedMessage(text: string, sentAttachments: Attachment[]) {
    const trimmedText = text.trim();
    const readyMessage = getReadyGuidedMessage(messages);

    if (readyMessage && isGenerateCommand(trimmedText)) {
      const userMessage: ChatMessage = {
        id: createId("user"),
        role: "user",
        content: trimmedText || "生成",
        attachments: sentAttachments
      };

      setMessages((current) => [...current, userMessage]);
      setInputValue("");
      setAttachments([]);
      setAttachmentError(undefined);

      if (readyMessage.lessonPlanState) {
        void runLessonPlanRequest(readyMessage.id, "generate", readyMessage.lessonPlanState);
      } else if (readyMessage.internshipReflectionState) {
        void runReflectionRequest(
          readyMessage.id,
          "generate",
          readyMessage.internshipReflectionState
        );
      }

      return true;
    }

    if (readyMessage && (trimmedText || sentAttachments.length)) {
      const userMessage: ChatMessage = {
        id: createId("user"),
        role: "user",
        content: trimmedText || "补充了课堂证据材料",
        attachments: sentAttachments
      };

      if (readyMessage.lessonPlanState) {
        const state = readyMessage.lessonPlanState;
        const nextInput = {
          ...state.input,
          textbookContext: `${state.input.textbookContext}\n补充说明：${trimmedText}`.trim()
        };
        const assistantContent = formatGuidedReadyMessage(
          nextInput,
          lessonPlanGuidedSteps,
          "教案信息摘要"
        );
        const assistantMessage: ChatMessage = {
          id: createId("assistant-lesson"),
          role: "assistant",
          content: "",
          status: "generating",
          thinkingEnabled: true,
          thinkingStartedAt: Date.now(),
          sourcePrompt: readyMessage.sourcePrompt,
          insightMode: "thinking",
          lessonPlanState: {
            ...state,
            input: nextInput,
            status: "已补充到教案生成上下文，回复“生成”即可生成 Word。"
          }
        };

        setMessages((current) => [
          ...current.map((message) =>
            message.id === readyMessage.id
              ? { ...message, lessonPlanState: undefined }
              : message
          ),
          userMessage,
          assistantMessage
        ]);
        setInputValue("");
        setAttachments([]);
        setAttachmentError(undefined);
        void streamGuidedAssistantMessage(assistantMessage.id, assistantContent, {
          simulateThinking: true
        });
        return true;
      }

      if (readyMessage.internshipReflectionState) {
        const state = readyMessage.internshipReflectionState;
        const nextEvidenceFiles = [
          ...state.evidenceFiles,
          ...createEvidenceAttachments(sentAttachments)
        ];
        const nextInput = {
          ...state.input,
          classroomSegment: `${state.input.classroomSegment}\n补充说明：${trimmedText}`.trim()
        };
        const assistantContent = `${formatGuidedReadyMessage(
          nextInput,
          reflectionGuidedSteps,
          "反思素材摘要"
        )}\n\n证据链摘要：已收到 ${nextEvidenceFiles.length} 份课堂证据，生成时会和课堂片段、问题诊断、改进方向一起组织。`;
        const assistantMessage: ChatMessage = {
          id: createId("assistant-reflection"),
          role: "assistant",
          content: "",
          status: "generating",
          thinkingEnabled: true,
          thinkingStartedAt: Date.now(),
          sourcePrompt: readyMessage.sourcePrompt,
          insightMode: "thinking",
          internshipReflectionState: {
            ...state,
            input: nextInput,
            evidenceFiles: nextEvidenceFiles,
            status: "已补充到反思素材，回复“生成”即可生成 Word。"
          }
        };

        setMessages((current) => [
          ...current.map((message) =>
            message.id === readyMessage.id
              ? { ...message, internshipReflectionState: undefined }
              : message
          ),
          userMessage,
          assistantMessage
        ]);
        setInputValue("");
        setAttachments([]);
        setAttachmentError(undefined);
        void streamGuidedAssistantMessage(assistantMessage.id, assistantContent, {
          simulateThinking: true
        });
        return true;
      }
    }

    const activeMessage = getActiveGuidedMessage(messages);

    if (!activeMessage) {
      return false;
    }

    if (!trimmedText && sentAttachments.length === 0) {
      return true;
    }

    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      content: trimmedText || "上传了课堂证据材料",
      attachments: sentAttachments
    };

    if (activeMessage.lessonPlanState) {
      const state = activeMessage.lessonPlanState;
      const currentStep =
        lessonPlanGuidedSteps.find((step) => step.id === state.currentStepId) ||
        lessonPlanGuidedSteps[0];
      const knowledgeBaseChoice =
        currentStep.field === "knowledgeBaseIds"
          ? resolveKnowledgeBaseChoice(
              trimmedText || currentStep.fallback || "",
              selectedKnowledgeBaseIds
            )
          : undefined;
      const nextInput = applyLessonGuidedAnswer(
        state,
        currentStep,
        trimmedText || currentStep.fallback || "",
        selectedKnowledgeBaseIds
      );
      const shouldStayOnKnowledgeStep =
        knowledgeBaseChoice?.kind === "missing" || knowledgeBaseChoice?.kind === "unclear";
      const answeredStepIds = shouldStayOnKnowledgeStep
        ? state.answeredStepIds || []
        : Array.from(new Set([...(state.answeredStepIds || []), currentStep.id]));
      const nextStep = getNextGuidedQuestion(lessonPlanGuidedSteps, answeredStepIds);
      const isReady = !nextStep;
      const assistantContent = knowledgeBaseChoice
        ? knowledgeBaseChoice.kind === "affirmative" || knowledgeBaseChoice.kind === "negative"
          ? `${knowledgeBaseChoice.message}\n\n${formatGuidedReadyMessage(
              nextInput,
              lessonPlanGuidedSteps,
              "教案信息摘要"
            )}`
          : knowledgeBaseChoice.message
        : isReady
          ? formatGuidedReadyMessage(nextInput, lessonPlanGuidedSteps, "教案信息摘要")
          : `好的，我先记下${currentStep.label}：${trimmedText || currentStep.fallback || "按默认"}。\n\n${nextStep.question}`;
      const assistantMessage: ChatMessage = {
        id: createId("assistant-lesson"),
        role: "assistant",
        content: "",
        status: "generating",
        thinkingEnabled: true,
        thinkingStartedAt: Date.now(),
        sourcePrompt: activeMessage.sourcePrompt,
        insightMode: "thinking",
        lessonPlanState: {
          ...state,
          input: nextInput,
          currentStepId: nextStep?.id,
          answeredStepIds,
          pendingQuestion: nextStep?.question,
          isReadyToGenerate: isReady,
          status: knowledgeBaseChoice?.message ||
            (isReady
              ? "信息已收集完成，回复“生成”即可生成 Word 教案。"
              : `${nextStep.agentName} 正在追问：${nextStep.label}`)
        }
      };

      setMessages((current) => [
        ...current.map((message) =>
          message.id === activeMessage.id
            ? { ...message, lessonPlanState: undefined }
            : message
        ),
        userMessage,
        assistantMessage
      ]);
      if (knowledgeBaseChoice?.kind === "missing") {
        setPendingKnowledgeSelection({
          kind: "lesson-guided",
          messageId: assistantMessage.id
        });
        setKnowledgePanelRequestKey((value) => value + 1);
      } else if (
        knowledgeBaseChoice?.kind === "affirmative" ||
        knowledgeBaseChoice?.kind === "negative"
      ) {
        setPendingKnowledgeSelection(undefined);
      }
      setInputValue("");
      setAttachments([]);
      setAttachmentError(undefined);
      void streamGuidedAssistantMessage(assistantMessage.id, assistantContent, {
        simulateThinking: true
      });
      return true;
    }

    if (activeMessage.internshipReflectionState) {
      const state = activeMessage.internshipReflectionState;
      const currentStep =
        reflectionGuidedSteps.find((step) => step.id === state.currentStepId) ||
        reflectionGuidedSteps[0];
      const result = applyReflectionGuidedAnswer(
        state,
        currentStep,
        trimmedText || currentStep.fallback || "",
        selectedKnowledgeBaseIds,
        sentAttachments
      );
      const answeredStepIds = Array.from(
        new Set([...(state.answeredStepIds || []), currentStep.id])
      );
      const nextStep = getNextGuidedQuestion(reflectionGuidedSteps, answeredStepIds);
      const isReady = !nextStep;
      const assistantContent = isReady
        ? `${formatGuidedReadyMessage(result.input, reflectionGuidedSteps, "反思素材摘要")}\n\n证据链摘要：已收到 ${result.evidenceFiles.length} 份课堂证据，生成时会和课堂片段、问题诊断、改进方向一起组织。`
        : `好的，我先记下${currentStep.label}：${trimmedText || currentStep.fallback || "按默认"}。\n\n${nextStep.question}`;
      const assistantMessage: ChatMessage = {
        id: createId("assistant-reflection"),
        role: "assistant",
        content: "",
        status: "generating",
        thinkingEnabled: true,
        thinkingStartedAt: Date.now(),
        sourcePrompt: activeMessage.sourcePrompt,
        insightMode: "thinking",
        internshipReflectionState: {
          ...state,
          input: result.input,
          evidenceFiles: result.evidenceFiles,
          currentStepId: nextStep?.id,
          answeredStepIds,
          pendingQuestion: nextStep?.question,
          isReadyToGenerate: isReady,
          status: isReady
            ? "反思素材已收集完成，回复“生成”即可生成 Word。"
            : result.status || `${nextStep.agentName} 正在追问：${nextStep.label}`
        }
      };

      setMessages((current) => [
        ...current.map((message) =>
          message.id === activeMessage.id
            ? { ...message, internshipReflectionState: undefined }
            : message
        ),
        userMessage,
        assistantMessage
      ]);
      setInputValue("");
      setAttachments([]);
      setAttachmentError(undefined);
      void streamGuidedAssistantMessage(assistantMessage.id, assistantContent, {
        simulateThinking: true
      });
      return true;
    }

    return false;
  }

  function handleAttachFiles(files: FileList | null) {
    if (!files?.length) {
      return;
    }

    const incomingFiles = Array.from(files);
    const unsupportedFile = incomingFiles.find((file) => !isSupportedAttachment(file));

    if (unsupportedFile) {
      setAttachmentError(
        `暂不支持 ${unsupportedFile.name}，请上传图片、PDF、TXT、MD、CSV 或 JSON。`
      );
      return;
    }

    if (attachments.length + incomingFiles.length > MAX_ATTACHMENT_COUNT) {
      setAttachmentError(`最多一次上传 ${MAX_ATTACHMENT_COUNT} 个文件。`);
      return;
    }

    const nextTotalSize =
      attachments.reduce((total, attachment) => total + attachment.size, 0) +
      incomingFiles.reduce((total, file) => total + file.size, 0);

    if (nextTotalSize > MAX_ATTACHMENT_TOTAL_SIZE) {
      setAttachmentError(`附件总大小不能超过 ${formatFileSize(MAX_ATTACHMENT_TOTAL_SIZE)}。`);
      return;
    }

    const nextAttachments = incomingFiles.map((file) => ({
      id: createId("file"),
      file,
      name: file.name,
      size: file.size
    }));

    setAttachments((current) => [...current, ...nextAttachments]);
    setAttachmentError(undefined);
  }

  function handleRemoveAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
    setAttachmentError(undefined);
  }

  function toggleSelectedKnowledgeBase(id: string) {
    setSelectedKnowledgeBaseIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  }

  async function sendMessage(text = inputValue) {
    const trimmedText = text.trim();

    if (isGenerating || (!trimmedText && attachments.length === 0)) {
      return;
    }

    if (chatMode === "education") {
      if (handleGuidedMessage(trimmedText, attachments)) {
        return;
      }

      if (trimmedText && attachments.length === 0 && isLessonPlanWizardRequest(trimmedText)) {
        startLessonPlanWizard(trimmedText);
        return;
      }

      if (
        trimmedText &&
        attachments.length === 0 &&
        isInternshipReflectionWizardRequest(trimmedText)
      ) {
        startInternshipReflectionWizard(trimmedText);
        return;
      }
    }

    const sentAttachments = attachments;
    const sourcePrompt =
      trimmedText ||
      (sentAttachments.length
        ? `分析上传文件：${sentAttachments.map((attachment) => attachment.name).join("、")}`
        : chatMode === "office"
          ? "本次办公任务"
          : "本次教学任务");
    const knowledgeBaseIdsForRequest = [...selectedKnowledgeBaseIds];
    const knowledgeQueryMode = isKnowledgeBaseOverviewQuery(trimmedText)
      ? "overview"
      : "search";
    const userMessage: ChatMessage = {
      id: createId("user"),
      role: "user",
      content: trimmedText || (chatMode === "office" ? "上传了文件" : "上传了教学资料"),
      attachments: sentAttachments
    };
    const assistantMessage: ChatMessage = {
      id: createId("assistant"),
      role: "assistant",
      content: "",
      status: "generating",
      thinkingEnabled: enableThinking,
      thinkingText: "",
      thinkingStartedAt: enableThinking ? Date.now() : undefined,
      sourcePrompt,
      artifacts: [],
      citations: [],
      knowledgeBaseIds: knowledgeBaseIdsForRequest,
      knowledgeQueryMode,
      // 记住这条回复是谁给的：换过智能体之后，历史里也能看出各自说过什么。
      agentName: activeAgent?.name,
      agentAvatar: activeAgent?.avatar
    };
    const requestStartedAt = Date.now();
    const nextMessages = [...messages, userMessage];
    const assistantId = assistantMessage.id;
    const abortController = new AbortController();
    const visibleTextStreamer = createVisibleTextStreamer((content) => {
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? { ...message, content: message.content + content }
            : message
        )
      );
    });
    let completedConversationId: string | undefined;
    // 这一轮被转交出去的专项 Agent 名字：它自己调工具时，气泡要写清楚是谁在干
    let delegatedAgentName: string | undefined;

    activeRequestRef.current?.abort();
    activeRequestRef.current = abortController;
    setMessages([...nextMessages, assistantMessage]);
    setInputValue("");
    setAttachments([]);
    setAttachmentError(undefined);
    setSelectedKnowledgeBaseIds([]);
    setIsGenerating(true);
    // 桌宠进入工作状态：纯表现层，画布出问题也不影响这条请求。
    // 这时候还没有工具事件，只能说清楚"谁在想"，别编造步骤。
    pet.running(activeAgent?.name ? `${activeAgent.name} 在想` : "正在理解问题");

    try {
      let response: Response;

      if (chatMode === "workflow") {
        // 复用画布调试助手的 SSE 内核：问句直接聊、任务才跑流程，delta 格式与聊天流一致。
        if (!selectedWorkflowId) {
          throw new Error("还没选中工作流，请先在页面上方选择一条。");
        }
        if (!trimmedText) {
          throw new Error("工作流会话请直接输入文字，暂不支持只发附件。");
        }
        response = await fetch(
          `/api/platform/workflows/${encodeURIComponent(selectedWorkflowId)}/debug/chat`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: trimmedText,
              input: buildWorkflowChatInput(workflowVariables, trimmedText),
              persist: true,
              conversationId,
              history: nextMessages.map((message) => ({
                role: message.role,
                content: message.content
              }))
            }),
            signal: abortController.signal
          }
        );
      } else {
        const formData = new FormData();
        formData.append(
          "messages",
          JSON.stringify(
            nextMessages.map((message) => ({
              role: message.role,
              content: message.content
            }))
          )
        );
        formData.append("enableThinking", String(enableThinking));
        formData.append("knowledgeBaseIds", JSON.stringify(knowledgeBaseIdsForRequest));
        formData.append("trainingType", currentTrainingType);
        formData.append("assistantMode", chatMode);
        // 输入框下方选的那条模型；没选就不传，由后端用默认模型。
        if (chatModelId) {
          formData.append("model", chatModelId);
        }
        // 选了自建智能体就用它的角色、提示词、模型和上下文设置。
        if (activeAgentId) {
          formData.append("agentId", activeAgentId);
          const filled = Object.fromEntries(
            Object.entries(agentVariableValues).filter(([, value]) => value.trim() !== "")
          );
          if (Object.keys(filled).length > 0) {
            formData.append("variables", JSON.stringify(filled));
          }
        }

        if (conversationId) {
          formData.append("conversationId", conversationId);
        }

        for (const attachment of sentAttachments) {
          formData.append("files", attachment.file, attachment.name);
        }

        response = await fetch("/api/chat/stream", {
          method: "POST",
          body: formData,
          signal: abortController.signal
        });
      }

      await readChatStream(response, {
        onDelta(content) {
          visibleTextStreamer.enqueue(content);
        },
        onTool(note) {
          // 气泡里讲的是这一步真实在干什么，不是固定话术：
          // 调工具就报工具名，转交就报是哪个智能体接手。
          if (note.kind === "delegation") {
            const target = note.targetAgent;
            if (note.stage === "running" && target) {
              // 顺手把这位专项 Agent 从幕后拽到台上来
              delegatedAgentName = target.name;
              pet.helperIn({ castId: castForAgent(target.name).id, name: target.name });
              pet.running(`叫 ${target.name} 来`);
            } else if (note.stage === "done") {
              if (note.ok === false) {
                delegatedAgentName = undefined;
                pet.helperOut();
                pet.error(`${target?.name ?? "专项智能体"} 没接住`);
              } else if (target) {
                pet.running(`${target.name} 接手了`);
              }
            }
          } else if (note.stage === "running") {
            const label = toolCaptionName(note);
            pet.running(delegatedAgentName ? `${delegatedAgentName}·${label}` : `调用 ${label}`);
          } else if (note.stage === "done") {
            const label = toolCaptionName(note);
            if (note.ok === false) {
              pet.error(`${label} 出错`);
            } else {
              pet.running(`${label} 完成`);
            }
          } else if (note.stage === "skipped") {
            pet.running(`${toolCaptionName(note)} 跳过`);
          }
          // 转交不单独占一行：直接把这条回复的署名换成目标 Agent，
          // 学生看到的始终是「谁在答」，而不是「导师说要转给谁」。
          if (note.kind === "delegation") {
            const target = note.targetAgent;
            const failed = note.stage === "done" && note.ok === false;
            setMessages((current) =>
              current.map((item) => {
                if (item.id !== assistantId) {
                  return item;
                }
                if (failed) {
                  // 转交失败还是导师在答，署名得退回原来的智能体。
                  return { ...item, agentName: activeAgent?.name, agentAvatar: activeAgent?.avatar };
                }
                return target
                  ? { ...item, agentName: target.name, agentAvatar: target.avatar }
                  : item;
              })
            );
            return;
          }
          setMessages((current) =>
            current.map((item) => {
              if (item.id !== assistantId) {
                return item;
              }
              const notes = [...(item.toolNotes ?? [])];
              const pending = notes.findIndex(
                (entry) => entry.toolId === note.toolId && entry.stage === "running"
              );
              if (note.stage === "running") {
                notes.push(note);
              } else if (pending >= 0) {
                notes[pending] = note;
              } else {
                notes.push(note);
              }
              return { ...item, toolNotes: notes };
            })
          );
        },
        onThinkingDelta(content) {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    thinkingText: `${message.thinkingText || ""}${content}`
                  }
                : message
            )
          );
        },
        onMeta(workflowName) {
          // 工作流会话的徽标：meta 事件在 SSE 一开始就到，回复是谁给的一目了然。
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId && !message.agentName
                ? { ...message, agentName: workflowName }
                : message
            )
          );
        },
        onDelegated(delegated) {
          // 这一轮是专项智能体在说话：徽标换成它，别让导师占功。
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    agentName: delegated.agentName,
                    agentAvatar: delegated.agentAvatar
                  }
                : message
            )
          );
        },
        onTrace({ agents, tools }) {
          setMessages((current) =>
            current.map((message) => {
              if (message.id !== assistantId) {
                return message;
              }
              // 轨迹里的工具调用映射成 toolNotes，渲染与历史留痕共用同一套药丸样式。
              const existing = message.toolNotes ?? [];
              const seen = new Set(existing.map((note) => `${note.toolId}:${note.name}`));
              const merged = [
                ...existing,
                ...tools.filter((note) => !seen.has(`${note.toolId}:${note.name}`))
              ];
              return { ...message, traceAgents: agents, toolNotes: merged };
            })
          );
        },
        onMetrics(thinkingSeconds) {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? { ...message, thinkingSeconds }
                : message
            )
          );
        },
        onArtifact(artifact) {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    artifacts: [...(message.artifacts || []), artifact]
                  }
                : message
            )
          );
        },
        onCitation(citation) {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId
                ? {
                    ...message,
                    citations: [...(message.citations || []), citation]
                  }
                : message
            )
          );
        },
        onEvaluation(evaluation) {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId ? { ...message, evaluation } : message
            )
          );
        },
        onDone(payload) {
          completedConversationId = payload.conversationId;
        },
        onError(message) {
          throw new Error(message);
        }
      });

      await visibleTextStreamer.flush();

      if (completedConversationId) {
        setConversationId(completedConversationId);
      }

      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? { ...message, status: "done", durationMs: Date.now() - requestStartedAt }
            : message
        )
      );
      // 这一轮顺利答完，桌宠蹦一下；两秒多后自己回待机。
      pet.success();
      void loadConversationHistory();
      if (chatMode === "education") {
        void loadGrowthSummary();
      }
    } catch (error) {
      visibleTextStreamer.stop();

      if (abortController.signal.aborted) {
        // 用户自己按了停止，不算失败，别让桌宠委屈
        pet.rest();
        return;
      }

      const message =
        error instanceof Error
          ? error.message
          : "模型服务暂时不可用，请稍后重试";
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantId
            ? { ...item, content: message, status: "error" }
            : item
        )
      );
      pet.error("这轮没跑通");
    } finally {
      if (activeRequestRef.current === abortController) {
        activeRequestRef.current = null;
      }
      setIsGenerating(false);
    }
  }

  function handleQuickTask(task: QuickTask) {
    if (task.trainingType === "教案诊断") {
      startLessonPlanWizard(task.prompt);
      return;
    }

    if (task.trainingType === "实习反思") {
      startInternshipReflectionWizard(task.prompt);
      return;
    }

    if (task.trainingType === "说课陪练") {
      setCurrentTrainingType("说课陪练");
      setActiveSection("speak");
      return;
    }

    if (task.trainingType === "模拟课堂") {
      setActiveSection("classroom");
      setActiveInsightMessageId(undefined);
      return;
    }

    if (task.trainingType === "谈心谈话") {
      setCurrentTrainingType("谈心谈话");
      setRestoredCounselingSessionId(undefined);
      setActiveSection("counseling");
      setActiveInsightMessageId(undefined);
      return;
    }

    setInputValue(task.prompt);
    setChatMode("education");
    setCurrentTrainingType(task.trainingType);
  }

  function startGrowthRecommendedTraining(action: GrowthSummary["recommendedAction"]) {
    if (action.trainingType === "教案诊断") {
      startLessonPlanWizard(action.prompt);
      return;
    }

    if (action.trainingType === "实习反思") {
      startInternshipReflectionWizard(action.prompt);
      return;
    }

    if (action.trainingType === "说课陪练") {
      setCurrentTrainingType("说课陪练");
      setActiveSection("speak");
      return;
    }

    if (action.trainingType === "谈心谈话") {
      setCurrentTrainingType("谈心谈话");
      setRestoredCounselingSessionId(undefined);
      setActiveSection("counseling");
      setActiveInsightMessageId(undefined);
      return;
    }

    handleNewConversation();
    setCurrentTrainingType("模拟课堂");
    setInputValue(action.prompt);
    setActiveSection("chat");
  }

  function handleNewConversation(mode: ChatMode = "education", workflowId?: string) {
    activeRequestRef.current?.abort();
    activeRequestRef.current = null;
    setMessages([]);
    setInputValue("");
    setAttachments([]);
    setAttachmentError(undefined);
    setConversationId(undefined);
    setRestoredCounselingSessionId(undefined);
    setChatMode(mode);
    if (mode === "workflow") {
      setSelectedWorkflowId(
        workflowId || selectedWorkflowId || workflowOptions[0]?.id || ""
      );
    }
    setCurrentTrainingType("教案诊断");
    setIsGenerating(false);
    setActiveInsightMessageId(undefined);
    setSelectedKnowledgeBaseIds([]);
    setActiveSection("chat");
  }

  /**
   * 换智能体等于换一条会话：不同提示词混在同一段历史里，
   * 模型会拿着前一个角色说的话继续演，结果四不像。
   */
  function handlePickAgent(nextId: string) {
    if (isGenerating || nextId === activeAgentId) {
      return;
    }
    const next = chatAgents.find((agent) => agent.id === nextId);
    setActiveAgentId(nextId);
    setMessages([]);
    setConversationId(undefined);
    setActiveInsightMessageId(undefined);
    setAttachmentError(undefined);
    setSelectedKnowledgeBaseIds([]);
    setInputValue("");
    if (chatMode === "workflow") {
      setChatMode("education");
    }
    const defaults: Record<string, string> = {};
    for (const item of next?.chatConfig?.variables ?? []) {
      defaults[item.key] = item.defaultValue ?? "";
    }
    setAgentVariableValues(defaults);
  }

  /** 空状态页上的开关：这一轮对话要不要绑定智能体。开=出现下拉选择；关=回到默认助手。 */
  function handleToggleAgentPicker() {
    if (isGenerating) {
      return;
    }
    const next = !agentPickerOn;
    setAgentPickerOn(next);
    if (!next) {
      // 关掉开关即回到默认助手；handlePickAgent 里会清掉智能体绑定的消息上下文。
      if (activeAgentId) {
        handlePickAgent("");
      } else if (chatMode === "workflow") {
        setChatMode(chatModeBeforeWorkflowRef.current);
      }
      return;
    }
    // 智能体和工作流互斥：绑了智能体就退出工作流模式，避免两边同时接管这轮对话。
    if (chatMode === "workflow") {
      setChatMode(chatModeBeforeWorkflowRef.current);
    }
  }

  /** 空状态页上的开关：这一轮对话要不要绑定工作流，绑哪一条。 */
  function handleToggleWorkflowChat() {
    if (isGenerating) {
      return;
    }
    const useWorkflow = chatMode !== "workflow";
    if (messages.length > 0) {
      handleNewConversation(useWorkflow ? "workflow" : "education");
      return;
    }
    if (useWorkflow) {
      chatModeBeforeWorkflowRef.current = chatMode === "office" ? "office" : "education";
      setSelectedWorkflowId((current) => current || workflowOptions[0]?.id || "");
      setChatMode("workflow");
    } else {
      setChatMode(chatModeBeforeWorkflowRef.current);
    }
  }

  /** 会话中切换工作流会另起一轮，避免同一个会话里混着两条工作流的上下文。 */
  function handleWorkflowChange(nextId: string) {
    if (!nextId || isGenerating) {
      return;
    }
    if (messages.length > 0) {
      handleNewConversation("workflow", nextId);
      return;
    }
    setSelectedWorkflowId(nextId);
  }

  function handleOpenSceneChat() {
    if (chatMode !== "education") {
      handleNewConversation("education");
      return;
    }
    setActiveSection("chat");
    setActiveInsightMessageId(undefined);
  }

  function handleOpenWorkflow(workflowId: string, nodeId?: string) {
    setWorkflowOpenRequest((current) => ({
      id: workflowId,
      nodeId,
      token: (current?.token ?? 0) + 1
    }));
    setActiveSection("platform");
    setActiveInsightMessageId(undefined);
  }

  function handleOpenMonitorRun(runId: string) {
    setMonitorRunRequest((current) => ({ runId, token: (current?.token ?? 0) + 1 }));
    setActiveSection("monitor");
    setActiveInsightMessageId(undefined);
  }

  function handleOpenSessionFromRun(target: {
    workflowId: string;
    runId: string;
    sessionId?: string;
  }) {
    if (target.workflowId === "classroom-session-v1") {
      setClassroomRunRequest((current) => ({
        runId: target.runId,
        token: (current?.token ?? 0) + 1
      }));
      setActiveSection("classroom");
      return;
    }
    if (target.workflowId === "counseling-session-v1") {
      setCounselingRunRequest((current) => ({
        runId: target.runId,
        token: (current?.token ?? 0) + 1
      }));
      setRestoredCounselingSessionId(target.sessionId);
      setActiveSection("counseling");
    }
  }

  useEffect(() => {
    if (activeSection !== "classroom") {
      setClassroomRunRequest(undefined);
    }
    if (activeSection !== "counseling") {
      setCounselingRunRequest(undefined);
    }
    if (activeSection !== "monitor") {
      setMonitorRunRequest(undefined);
    }
  }, [activeSection]);

  const hasMessages = messages.length > 0;
  const activeInsightMessage = messages.find(
    (message) => message.id === activeInsightMessageId
  );
  const isInsightPanelOpen = Boolean(activeInsightMessage);

  return (
    <>
      <div className="app-photo" aria-hidden="true" />
      <main
        className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${
          isInsightPanelOpen ? "insight-open" : ""
        }`}
      >
      <Sidebar
        activeSection={activeSection}
        chatMode={chatMode}
        collapsed={sidebarCollapsed}
        onOpenWorkbench={() => {
          setActiveSection("workbench");
          setActiveInsightMessageId(undefined);
        }}
        onOpenGrowth={() => {
          setActiveSection("growth");
          setActiveInsightMessageId(undefined);
        }}
        onOpenHistory={() => {
          setActiveSection("history");
          setActiveInsightMessageId(undefined);
        }}
        onOpenKnowledge={() => {
          setActiveSection("knowledge");
          setActiveInsightMessageId(undefined);
        }}
        onOpenClassroom={() => {
          setActiveSection("classroom");
          setActiveInsightMessageId(undefined);
        }}
        onOpenCounselingTraining={() => {
          setCurrentTrainingType("谈心谈话");
          setRestoredCounselingSessionId(undefined);
          setActiveSection("counseling");
          setActiveInsightMessageId(undefined);
        }}
        onOpenSpeakTraining={() => {
          setCurrentTrainingType("说课陪练");
          setActiveSection("speak");
          setActiveInsightMessageId(undefined);
        }}
        onOpenPlatform={() => {
          setActiveSection("platform");
          setActiveInsightMessageId(undefined);
        }}
        onOpenScenarios={() => {
          setActiveSection("scenarios");
          setActiveInsightMessageId(undefined);
        }}
        onOpenRegistry={() => {
          setActiveSection("registry");
          setActiveInsightMessageId(undefined);
        }}
        onOpenLibrary={() => {
          setActiveSection("library");
          setActiveInsightMessageId(undefined);
        }}
        onOpenMcp={() => {
          setActiveSection("mcp");
          setActiveInsightMessageId(undefined);
        }}
        onOpenPlugins={() => {
          setActiveSection("plugins");
          setActiveInsightMessageId(undefined);
        }}
        onOpenMonitor={() => {
          setActiveSection("monitor");
          setActiveInsightMessageId(undefined);
        }}
        onOpenReport={() => {
          setActiveSection("report");
          setActiveInsightMessageId(undefined);
        }}
        onOpenEvolution={() => {
          setActiveSection("evolution");
          setActiveInsightMessageId(undefined);
        }}
        onNewTask={() => {
          setNewTaskToken((value) => value + 1);
          setActiveSection("platform");
          setActiveInsightMessageId(undefined);
        }}
        onOpenChat={handleOpenSceneChat}
        onNewConversation={(mode) => handleNewConversation(mode)}
        onToggle={() => setSidebarCollapsed((value) => !value)}
        onOpenSettings={(tab) => {
          setSettingsTab(tab);
          setSettingsOpen(true);
        }}
        onOpenAccount={() => setAccountOpen(true)}
        onLogout={() => {
          void auth.logout();
        }}
        onSwitchAccount={() => {
          void auth.switchAccount();
        }}
        user={{
          name: auth.user?.displayName ?? "本地用户",
          description:
            auth.user?.role === "owner" ? "所有者 · 本地工作区" : "成员 · 本地工作区"
        }}
      />
      <section className="workspace">
        {activeSection === "workbench" ? (
          <div className="workspace-inner wb-workspace">
            <WorkbenchPage
              onOpenChat={handleOpenSceneChat}
              onOpenPlatform={() => {
                setActiveSection("platform");
                setActiveInsightMessageId(undefined);
              }}
              onOpenWorkflow={(workflowId) => handleOpenWorkflow(workflowId)}
              onOpenMonitor={(runId) => {
                if (runId) {
                  handleOpenMonitorRun(runId);
                  return;
                }
                setActiveSection("monitor");
                setActiveInsightMessageId(undefined);
              }}
              onOpenLibrary={() => {
                setActiveSection("library");
                setActiveInsightMessageId(undefined);
              }}
              onOpenRegistry={() => {
                setActiveSection("registry");
                setActiveInsightMessageId(undefined);
              }}
              onNewWorkflow={() => {
                setNewTaskToken((value) => value + 1);
                setActiveSection("platform");
                setActiveInsightMessageId(undefined);
              }}
            />
          </div>
        ) : activeSection === "knowledge" ? (
          <div className="workspace-inner knowledge-workspace">
            <TeachingResourceCenter
              bases={knowledgeBases}
              activeBaseId={activeKnowledgeBaseId}
              documents={knowledgeDocuments}
              chunks={knowledgeChunks}
              selectedDocumentId={selectedKnowledgeDocumentId}
              searchQuery={knowledgeSearchQuery}
              searchResults={knowledgeSearchResults}
              searchState={knowledgeSearchState}
              providers={knowledgeProviders}
              starterPacks={starterKnowledgePacks}
              status={knowledgeStatus}
              onBackToChat={() => setActiveSection("chat")}
              onCreateBase={createKnowledgeBase}
              onRenameBase={(id, name) => void renameKnowledgeBase(id, name)}
              onDeleteBase={(id) => void deleteKnowledgeBase(id)}
              onDeleteDocument={deleteKnowledgeDocument}
              onSyncIma={() => void syncImaProvider()}
              onSearch={searchKnowledge}
              onSearchQueryChange={setKnowledgeSearchQuery}
              onSelectBase={(id) => {
                setActiveKnowledgeBaseId(id);
                setKnowledgeSearchResults([]);
                setKnowledgeSearchState("idle");
              }}
              onSelectDocument={setSelectedKnowledgeDocumentId}
              onTestIma={() => void testImaProvider()}
              onImportStarterPack={(packId) => void importStarterKnowledgePack(packId)}
              onStartTraining={startTrainingFromMaterials}
              onUploadDocument={(file, metadata) => {
                if (activeKnowledgeBaseId) {
                  return uploadKnowledgeDocument(activeKnowledgeBaseId, file, metadata);
                }

                return Promise.reject(new Error("请先选择资料库。"));
              }}
            />
          </div>
        ) : activeSection === "history" ? (
          <div className="workspace-inner knowledge-workspace">
            <HistoryCenter
              conversations={conversationHistory}
              status={historyStatus}
              onBackToChat={() => setActiveSection("chat")}
              onRefresh={() => void loadConversationHistory()}
              onRestore={(id) => void restoreConversation(id)}
            />
          </div>
        ) : activeSection === "growth" ? (
          <div className="workspace-inner knowledge-workspace">
            <GrowthCenter
              summary={growthSummary}
              status={growthStatus}
              recordPreview={growthRecordPreview}
              recordPreviewStatus={growthRecordPreviewStatus}
              onBackToChat={() => setActiveSection("chat")}
              onExport={(type) => void exportGrowthReport(type)}
              onStartTraining={startGrowthRecommendedTraining}
              onOpenTrainingRecord={(id) => void openGrowthTrainingRecord(id)}
              onCloseTrainingRecord={closeGrowthTrainingRecord}
              onContinueTrainingRecord={continueGrowthTrainingRecord}
            />
          </div>
        ) : activeSection === "speak" ? (
          <div className="workspace-inner speak-workspace">
            <SpeakTrainingRoom
              selectedKnowledgeBaseIds={selectedKnowledgeBaseIds}
              onTrainingSaved={() => {
                void loadConversationHistory();
                void loadGrowthSummary();
              }}
              onOpenMaterials={() => setActiveSection("knowledge")}
            />
          </div>
        ) : activeSection === "classroom" ? (
          <div className="workspace-inner classroom-workspace">
            <ClassroomTrainingPage
              key={`classroom-${classroomRunRequest?.token ?? 0}`}
              selectedKnowledgeBaseIds={selectedKnowledgeBaseIds}
              initialRunId={classroomRunRequest?.runId}
              onOpenMonitorRun={handleOpenMonitorRun}
              onOpenWorkflow={handleOpenWorkflow}
              onOpenMaterials={() => setActiveSection("knowledge")}
            />
          </div>
        ) : activeSection === "counseling" ? (
          <div className="workspace-inner counseling-workspace">
            <CounselingTrainingPage
              key={`${restoredCounselingSessionId || "new-counseling-session"}-${counselingRunRequest?.token ?? 0}`}
              initialSessionId={restoredCounselingSessionId}
              initialRunId={counselingRunRequest?.runId}
              onOpenMonitorRun={handleOpenMonitorRun}
              onOpenWorkflow={handleOpenWorkflow}
              onTrainingSaved={() => {
                void loadConversationHistory();
                void loadGrowthSummary();
              }}
            />
          </div>
        ) : activeSection === "platform" ? (
          <div className="workspace-inner platform-workspace">
            <WorkflowCanvasPage
              newTaskToken={newTaskToken}
              openWorkflowId={workflowOpenRequest?.id}
              openWorkflowToken={workflowOpenRequest?.token}
              openNodeId={workflowOpenRequest?.nodeId}
            />
          </div>
        ) : activeSection === "scenarios" ? (
          <div className="workspace-inner platform-workspace">
            <ScenarioValidationPage
              onOpenWorkflow={handleOpenWorkflow}
              onOpenMonitor={() => setActiveSection("monitor")}
              onOpenMonitorRun={handleOpenMonitorRun}
              onOpenSession={handleOpenSessionFromRun}
              onOpenReport={() => setActiveSection("report")}
              onOpenRegistry={() => setActiveSection("registry")}
              onOpenLibrary={() => setActiveSection("library")}
              onOpenMcp={() => setActiveSection("mcp")}
              onOpenClassroom={() => setActiveSection("classroom")}
              onOpenCounseling={() => {
                setCurrentTrainingType("谈心谈话");
                setRestoredCounselingSessionId(undefined);
                setActiveSection("counseling");
              }}
              onOpenChat={handleOpenSceneChat}
            />
          </div>
        ) : activeSection === "registry" ? (
          <div className="workspace-inner platform-workspace">
            <RegistryPage />
          </div>
        ) : activeSection === "library" ? (
          <div className="workspace-inner platform-workspace">
            <KnowledgePage />
          </div>
        ) : activeSection === "mcp" ? (
          <div className="workspace-inner platform-workspace">
            <McpPage onOpenCanvas={() => setActiveSection("platform")} />
          </div>
        ) : activeSection === "plugins" ? (
          <div className="workspace-inner platform-workspace">
            <PluginsPage />
          </div>
        ) : activeSection === "monitor" ? (
          <div className="workspace-inner platform-workspace">
            <RunMonitorPage
              initialRunId={monitorRunRequest?.runId}
              initialRunToken={monitorRunRequest?.token}
              onOpenSession={handleOpenSessionFromRun}
            />
          </div>
        ) : activeSection === "report" ? (
          <div className="workspace-inner platform-workspace">
            <VerifyReportPage />
          </div>
        ) : activeSection === "evolution" ? (
          <div className="workspace-inner platform-workspace">
            <EvolutionPage />
          </div>
        ) : (
          <div
            className={`workspace-inner chat-workspace has-pet ${
              hasMessages ? "has-messages" : ""
            }`}
          >
          <PetStage />
          {hasMessages && chatMode === "workflow" ? (
            <div className="workflow-chat-bar">
              <span className="workflow-chat-bar-label">当前工作流</span>
              <span className="workflow-chat-bar-name">
                {workflowOptions.find((option) => option.id === selectedWorkflowId)?.name ||
                  selectedWorkflowId}
              </span>
              <span className="workflow-chat-bar-hint">
                问问题直接聊，给具体任务才跑一遍流程
              </span>
            </div>
          ) : null}
          {hasMessages && activeAgent ? (
            <div className="agent-chat-bar">
              <AgentAvatar name={activeAgent.name} avatar={activeAgent.avatar} size={22} />
              <span className="agent-chat-bar-name">{activeAgent.name}</span>
              <span className="agent-chat-bar-hint">
                {activeAgent.description || activeAgent.role || "按自定义提示词回答"}
              </span>
              <button
                type="button"
                className="agent-chat-bar-switch"
                disabled={isGenerating}
                onClick={() => handlePickAgent("")}
              >
                换回默认助手
              </button>
            </div>
          ) : null}
          {!hasMessages ? (
            <>
              {appearance.photoBlend === "layered" && appearance.cutout ? (
                <div className="app-photo-cutout" aria-hidden="true" />
              ) : null}
              <header className="hero">
                <h1>
                  {activeAgent
                    ? activeAgent.chatConfig?.welcome?.trim() ||
                      `和「${activeAgent.name}」聊聊`
                    : chatMode === "office"
                      ? "今天想完成什么办公任务？"
                      : chatMode === "workflow"
                        ? "这条工作流能帮你做什么？"
                        : "今天想完成什么教学任务？"}
                </h1>
                <p>
                  {activeAgent
                    ? activeAgent.description?.trim() ||
                      activeAgent.role ||
                      "它按你设定的角色和提示词回答"
                    : chatMode === "office"
                      ? "写作、总结、翻译、会议纪要、表格整理，都可以直接对话完成"
                      : chatMode === "workflow"
                        ? "直接问教学问题会流式回答；给出明确任务时才会跑一遍工作流，并把最终交付的内容讲给你听"
                        : "说清学段、学科和想要的结果就行，需要跑流程时会自动切过去"}
                </p>
              </header>
              {agentVariableDefs.length > 0 ? (
                <div className="agent-variable-fill" aria-label="填写智能体变量">
                  <span className="agent-variable-fill-title">
                    「{activeAgent?.name}」需要这些信息
                  </span>
                  {agentVariableDefs.map((item) => (
                    <label key={item.key}>
                      <span>
                        {item.label || item.key}
                        {item.required ? <em>必填</em> : null}
                      </span>
                      <input
                        value={agentVariableValues[item.key] ?? ""}
                        placeholder={item.defaultValue || item.key}
                        onChange={(event) =>
                          setAgentVariableValues((current) => ({
                            ...current,
                            [item.key]: event.target.value
                          }))
                        }
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              <div className="new-chat-setup">
                <button
                  className={`new-chat-toggle ${agentPickerOn || Boolean(activeAgentId) ? "is-on" : ""}`}
                  type="button"
                  role="switch"
                  aria-checked={agentPickerOn || Boolean(activeAgentId)}
                  onClick={handleToggleAgentPicker}
                  disabled={isGenerating}
                >
                  <span className="new-chat-toggle-track" aria-hidden="true">
                    <span className="new-chat-toggle-knob" />
                  </span>
                  <span>使用智能体</span>
                </button>
                {agentPickerOn || Boolean(activeAgentId) ? (
                  <select
                    className="new-chat-select"
                    aria-label="选择智能体"
                    value={activeAgentId}
                    disabled={isGenerating}
                    onChange={(event) => handlePickAgent(event.target.value)}
                  >
                    <option value="">默认助手</option>
                    {chatAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <span className="new-chat-setup-divider" aria-hidden="true" />
                <button
                  className={`new-chat-toggle ${chatMode === "workflow" ? "is-on" : ""}`}
                  type="button"
                  role="switch"
                  aria-checked={chatMode === "workflow"}
                  onClick={handleToggleWorkflowChat}
                  disabled={isGenerating}
                >
                  <span className="new-chat-toggle-track" aria-hidden="true">
                    <span className="new-chat-toggle-knob" />
                  </span>
                  <span>使用工作流</span>
                </button>
                {chatMode === "workflow" ? (
                  <select
                    className="new-chat-select"
                    aria-label="选择工作流"
                    value={selectedWorkflowId}
                    disabled={isGenerating || workflowOptions.length === 0}
                    onChange={(event) => handleWorkflowChange(event.target.value)}
                  >
                    {workflowOptions.length === 0 ? (
                      <option value="">加载中…</option>
                    ) : (
                      workflowOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name || option.id}
                        </option>
                      ))
                    )}
                  </select>
                ) : null}
                <span className="new-chat-setup-hint">
                  {activeAgent
                    ? `正在和「${activeAgent.name}」对话`
                    : chatMode === "workflow"
                      ? "问问题直接聊，给具体任务才跑一遍流程"
                      : "打开开关选择智能体或工作流，不选就用默认助手"}
                </span>
                {workflowLoadError ? (
                  <span className="workflow-chat-bar-error">{workflowLoadError}</span>
                ) : null}
              </div>
              {chatMode === "workflow" ? null : activeAgent &&
                (activeAgent.chatConfig?.quickPrompts?.length ?? 0) > 0 ? (
                <div className="quick-row" aria-label="智能体快捷指令">
                  {(activeAgent.chatConfig?.quickPrompts ?? []).map((prompt) => (
                    <button
                      className="quick-pill"
                      type="button"
                      key={prompt}
                      onClick={() => setInputValue(prompt)}
                    >
                      <Sparkles size={17} strokeWidth={2.1} />
                      <span>{prompt}</span>
                    </button>
                  ))}
                </div>
              ) : (
              <div className="quick-row" aria-label={chatMode === "office" ? "快捷办公任务" : "快捷任务"}>
                {(chatMode === "office" ? officeQuickTasks : quickTasks).map((task) => {
                  const Icon = task.icon;

                  return (
                    <button
                      className="quick-pill"
                      type="button"
                      key={task.label}
                      onClick={() =>
                        chatMode === "office"
                          ? setInputValue(task.prompt)
                          : handleQuickTask(task as QuickTask)
                      }
                    >
                      <Icon size={18} strokeWidth={2.1} />
                      <span>{task.label}</span>
                    </button>
                  );
                })}
              </div>
              )}
            </>
          ) : null}
          <Conversation
            messages={messages}
            activeInsightMessageId={activeInsightMessageId}
            knowledgeBases={knowledgeBases}
            onDownloadLessonPlan={downloadLessonPlanMessage}
            onDownloadReflection={downloadReflectionMessage}
            onOpenLessonPreview={openLessonPlanPreview}
            onOpenReflectionPreview={openReflectionPreview}
            onRefineLessonPlan={refineLessonPlanMessage}
            onRefineReflection={refineReflectionMessage}
            onResetLessonPlan={resetLessonPlanMessage}
            onResetReflection={resetReflectionMessage}
            onSubmitLessonPlan={submitLessonPlanMessage}
            onSubmitReflection={submitReflectionMessage}
            onAttachReflectionEvidence={attachReflectionEvidence}
            onRemoveReflectionEvidence={removeReflectionEvidence}
            onToggleLessonPlanKnowledgeBase={toggleLessonPlanMessageKnowledgeBase}
            onToggleReflectionKnowledgeBase={toggleReflectionKnowledgeBase}
            onToggleThinking={(messageId) =>
              setActiveInsightMessageId((current) =>
                current === messageId ? undefined : messageId
              )
            }
            onUpdateLessonPlanInput={updateLessonPlanMessageInput}
            onUpdateReflectionInput={updateReflectionMessageInput}
          />
          <Composer
            ariaLabel={
              chatMode === "office"
                ? "办公任务输入"
                : chatMode === "workflow"
                  ? "工作流会话输入"
                  : "教学任务输入"
            }
            placeholder={
              chatMode === "office"
                ? "输入办公任务"
                : chatMode === "workflow"
                  ? "问个问题，或给这条工作流派个任务"
                  : "输入教学任务"
            }
            attachments={attachments}
            attachmentError={attachmentError}
            enableThinking={enableThinking}
            inputValue={inputValue}
            isGenerating={isGenerating}
            knowledgeBases={knowledgeBases}
            knowledgePanelRequestKey={knowledgePanelRequestKey}
            knowledgeSelectionMode={
              pendingKnowledgeSelection?.kind === "lesson-guided"
                ? "lesson-guided"
                : undefined
            }
            knowledgeUploadStatus={knowledgeStatus}
            selectedKnowledgeBaseIds={selectedKnowledgeBaseIds}
            onAttachFiles={handleAttachFiles}
            onChangeInput={setInputValue}
            onClearKnowledgeBases={() => setSelectedKnowledgeBaseIds([])}
            onConfirmKnowledgeSelection={() =>
              completePendingLessonKnowledgeSelection(true)
            }
            onRemoveAttachment={handleRemoveAttachment}
            onSend={() => sendMessage()}
            onOpenVoice={() => setIsVoiceOpen(true)}
            modelSlot={
              <ModelPicker
                value={chatModelId}
                onChange={(id) => {
                  setChatModelId(id);
                  persistChatModelId(id);
                }}
                onOpenSettings={() => {
                  setSettingsTab("models");
                  setSettingsOpen(true);
                }}
              />
            }
            onSkipKnowledgeSelection={() =>
              void completePendingLessonKnowledgeSelection(false)
            }
            onToggleKnowledgeBase={toggleSelectedKnowledgeBase}
            onToggleThinking={() => setEnableThinking((value) => !value)}
            onUploadKnowledgeDocument={(baseId, file) => {
              void uploadKnowledgeDocument(baseId, file, {
                resourceType: "其他",
                subject: "",
                schoolStage: "",
                tags: []
              });
            }}
          />
          </div>
        )}
      </section>
      <InsightPanel
        isOpen={isInsightPanelOpen}
        message={activeInsightMessage}
        onClose={() => setActiveInsightMessageId(undefined)}
        onOpenMaterials={() => {
          setActiveInsightMessageId(undefined);
          setActiveSection("knowledge");
        }}
      />
      {createPortal(
        <AnimatePresence>
          {isVoiceOpen ? (
            <motion.div
              className="voice-overlay"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              <motion.div
                className="voice-overlay-inner"
                initial={{ opacity: 0, y: 28, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 18, scale: 0.98 }}
                transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
              >
                <VoiceChatStage
                  title="沉浸式说课"
                  onClose={() => setIsVoiceOpen(false)}
                />
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body
      )}
      {settingsOpen ? (
        <SettingsDialog
          appearance={appearance}
          initialTab={settingsTab}
          onChange={setAppearance}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsTab("appearance");
          }}
        />
      ) : null}
      {accountOpen
        ? createPortal(
            <AccountDialog onClose={() => setAccountOpen(false)} />,
            document.body
          )
        : null}
      </main>
    </>
  );
}

// 启动时还没确认身份，先只给中性配色；照片等 AuthProvider 确认账号后再铺。
applyAppearance({ ...readAppearance(), photo: null, cutout: null });

const rootElement = document.getElementById("root")!;
const reactRoot =
  ((rootElement as HTMLElement & { __reactRoot?: ReactDOM.Root }).__reactRoot ??=
    ReactDOM.createRoot(rootElement));

reactRoot.render(
  <React.StrictMode>
    {/* 边界放在认证层外面：登录页和登录后的工作台任何一个抛错，都不至于只剩一张空背景。 */}
    <AppErrorBoundary>
      <AuthProvider>
        <App />
      </AuthProvider>
    </AppErrorBoundary>
  </React.StrictMode>
);
