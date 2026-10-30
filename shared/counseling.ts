export type CounselingConfig = {
  caseId: string;
  mode: "guided" | "assessment";
  emotion: "焦虑" | "低落" | "愤怒" | "委屈" | "麻木";
  intensity: number;
  trust: number;
  openness: number;
  risk: "ordinary" | "screening" | "urgent";
};

export type CounselingCase = {
  id: string;
  name: string;
  year: string;
  title: string;
  background: string;
  opening: string;
  concern: string;
  goal: string;
  defaults: Omit<CounselingConfig, "caseId" | "mode">;
};

export type StudentState = { trust: number; openness: number; tension: number };
export type CounselingMove = "welcome" | "empathy" | "open_question" | "clarify" | "safety" | "boundary" | "plan" | "repair" | "judgment" | "absolute_secret";
export type CounselingMessage = {
  id: string;
  turnId: string;
  role: "counselor" | "student";
  text: string;
  at: number;
  source: "text" | "voice" | "simulation";
  delivery?: "text" | "playing" | "played" | "interrupted";
  playedMs?: number;
  generation?: "model" | "scenario";
};
export type CounselingEvent = {
  id: string;
  turnId: string;
  at: number;
  kind: "cue" | "risk" | "state" | "interruption";
  severity: "info" | "warning" | "critical";
  title: string;
  evidence: string;
  suggestion: string;
  by?: "student" | "counselor";
  before?: StudentState;
  after?: StudentState;
};
export type CounselingEvidence = { turnId: string; at: number; text: string; moves: CounselingMove[] };
export type CounselingDimension = { name: string; score: number; comment: string; evidenceIds: string[]; applicable: boolean };
export type CounselingReport = {
  overallScore: number;
  dimensions: CounselingDimension[];
  strengths: string[];
  issues: string[];
  nextTask: string;
  safetyStatus: "not_triggered" | "needs_review" | "actions_observed";
  interruptions: { counselor: number; student: number; repairs: number };
  generatedAt: number;
};
export type CounselingSession = {
  id: string;
  config: CounselingConfig;
  student: CounselingCase;
  status: "active" | "finished";
  createdAt: number;
  updatedAt: number;
  messages: CounselingMessage[];
  events: CounselingEvent[];
  state?: StudentState;
  evidence?: CounselingEvidence[];
  report?: CounselingReport;
};
export type CounselingServerEvent =
  | { type: "session"; session: CounselingSession }
  | { type: "student_delta"; turnId: string; text: string }
  | { type: "student_interrupt"; turnId: string; text: string; event?: CounselingEvent }
  | { type: "asr"; text: string; final: boolean }
  | { type: "cancelled"; turnId: string }
  | { type: "turn_done"; turnId: string }
  | { type: "ready" }
  | { type: "error"; message: string; turnId?: string };

export type CounselingCapabilities = { model: boolean; iflytek: boolean; voice: "browser-or-iflytek" };
