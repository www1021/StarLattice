export type StudentType =
  | "top_student"
  | "weak_student"
  | "silent_student"
  | "naughty_student"
  | "misunderstanding_student";

export type StudentLevel = "high" | "middle" | "low";
export type StudentStatus = "focused" | "confused" | "silent" | "active" | "distracted";
export type ClassroomStage = "导入" | "讲解" | "提问" | "活动组织" | "总结" | "未知";
export type TimelineRole = "teacher" | "student" | "observer" | "system";
export type QuestionKind =
  | "greeting"
  | "casual"
  | "ambiguous"
  | "concept"
  | "reason"
  | "example"
  | "comparison"
  | "procedure"
  | "value"
  | "management"
  | "activity"
  | "summary";
export type AnswerQuality = "acknowledgement" | "correct" | "partial" | "misconception" | "silent" | "off_topic";
export type StudentAnswerGenerationMode = "rule" | "llm" | "fallback";
export type ClassroomEventType =
  | "wrong_answer"
  | "no_response"
  | "off_topic"
  | "time_risk"
  | "discipline_issue";

export type StudentAgent = {
  id: string;
  name: string;
  type: StudentType;
  level: StudentLevel;
  personality: string;
  behaviorTendency: string;
  knowledgeFoundation: string;
  participationWillingness: number;
  misconception: string;
  emotionState: string;
  recentMemory: string[];
  currentStatus: StudentStatus;
  lastReaction: string;
};

export type ClassroomMetrics = {
  participation: number;
  understanding: number;
  discipline: number;
  progress: number;
  interactionQuality: number;
  goalAchievement: number;
};

export type ClassroomTimelineItem = {
  id: string;
  role: TimelineRole;
  speaker: string;
  content: string;
  timestamp: number;
  eventType: string;
  studentId?: string;
  answerQuality?: AnswerQuality;
  generationMode?: StudentAnswerGenerationMode;
  validationPassed?: boolean;
};

export type ClassroomEvent = {
  id: string;
  type: ClassroomEventType;
  description: string;
  severity: "low" | "medium" | "high";
  handled: boolean;
  timestamp: number;
  sourceAgent: "课堂事件Agent";
};

export type ClassroomConfig = {
  subject: string;
  grade: string;
  topic: string;
  classType: string;
  trainingGoal: string;
  difficulty: string;
  specialTrainingMode?: string;
  topicKeywords?: string[];
  commonMisconceptions?: string[];
};

export type ClassroomState = ClassroomConfig & {
  knowledgeBaseIds?: string[];
  sessionId: string;
  classProfile: string;
  currentStage: ClassroomStage;
  students: StudentAgent[];
  metrics: ClassroomMetrics;
  timeline: ClassroomTimelineItem[];
  studentMemoryTimeline: StudentMemoryTimelineItem[];
  events: ClassroomEvent[];
  agentRunStats: AgentRunStats;
  turnCount: number;
  createdAt: number;
  updatedAt: number;
  savedConversationId?: string;
};

export type ClassroomCitation = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  documentName: string;
  snippet: string;
  source: "local" | "ima" | "external";
  score: number;
};

export type AgentRunStats = {
  teacherAnalyzerRuns: number;
  studentAgentActivations: number;
  eventAgentTriggers: number;
  observerAgentTips: number;
  reportAgentRuns: number;
};

export type ClassroomActionType =
  | "call_on_student"
  | "follow_up_student"
  | "start_group_activity"
  | "pause_and_manage"
  | "compress_summary";

export type TeacherActionAnalysis = {
  stage: ClassroomStage;
  actionType:
    | "greeting"
    | "casual"
    | "ambiguous"
    | "transition"
    | "explanation"
    | "question"
    | "follow_up"
    | "instruction"
    | "feedback"
    | "management"
    | "summary";
  difficultyLevel: "easy" | "medium" | "hard";
  clarity: number;
  questionKind: QuestionKind;
  specificity: number;
  contentFocus: string;
  topicKeywords: string[];
  expectedAnswerFrame: string;
  expectedPoints: string[];
  commonMisconceptions: string[];
  interactionIntent: boolean;
};

export type StudentReaction = {
  studentId: string;
  studentName: string;
  studentType: StudentType;
  content: string;
  eventType: string;
  answerQuality: AnswerQuality;
  questionKind: QuestionKind;
  topicKeywords: string[];
  agentReason: string;
  triggeredBy: string;
  generationMode?: StudentAnswerGenerationMode;
  validationPassed?: boolean;
  validationIssues?: string[];
  scripted?: boolean;
};

export type ClassroomReport = {
  sessionId: string;
  overallScore: number;
  dimensionScores: Array<{
    name: string;
    score: number;
    comment: string;
  }>;
  eventReview: Array<{
    type: ClassroomEventType;
    description: string;
    handled: boolean;
    comment: string;
  }>;
  strengths: string[];
  issues: string[];
  suggestions: string[];
  evidenceChains: ClassroomEvidenceChain[];
  agentDecisionEvidence: AgentDecisionEvidence[];
  agentCollaboration: AgentCollaborationStep[];
  agentRunStats: AgentRunStats;
  nextTrainingTask: string;
  summary: string;
  modelInsight?: string;
  providerMode: "rule" | "llm";
  savedConversationId?: string;
  generatedAt: number;
};

export type ClassroomArtifact = {
  id: string;
  name: string;
  type: string;
  url: string;
  size: number;
};

export type ClassroomEvidenceChain = {
  id: string;
  teacherMove: string;
  studentAgent: string;
  studentResponse: string;
  eventOrMetric: string;
  observerAdvice: string;
};

export type AgentCollaborationStep = {
  agentName: string;
  role: string;
  output: string;
};

export type StudentMemoryTimelineItem = {
  id: string;
  studentId: string;
  studentName: string;
  fromStatus: StudentStatus;
  toStatus: StudentStatus;
  trigger: string;
  reaction: string;
  agentReason: string;
  stage: ClassroomStage;
  turn: number;
  timestamp: number;
};

export type AgentDecisionEvidence = {
  id: string;
  agentName: string;
  decision: string;
  basis: string;
  impact: string;
};

export type ClassroomSpeakResponse = {
  teacherAction: TeacherActionAnalysis;
  studentReactions: StudentReaction[];
  observerTips: string[];
  updatedMetrics: ClassroomMetrics;
  events: ClassroomEvent[];
  classroomState: ClassroomState;
};
