import type { AgentRecord, WorkflowDefinition } from "../types.js";

export type ReleaseStatus = "draft" | "active" | "canary" | "rolled_back" | "archived";

export type ReleaseOrigin = "baseline" | "promotion" | "rollback" | "manual";

/**
 * 发布快照：工作流与其可调度 Agent 在发布时刻的完整冻结副本。
 * 运行期只读这份副本，注册中心后续改动不会影响已发布版本的复现结果。
 */
export type ReleaseArtifact = {
  workflow: WorkflowDefinition;
  /** 根流程引用到的全部子工作流，按 id 冻结，编译时不再回查实时台账。 */
  workflows: WorkflowDefinition[];
  /** 发布时刻启用的全部 Agent；调度器只在这批 Agent 里选择执行者。 */
  agents: AgentRecord[];
};

export type ReleaseManifest = {
  id: string;
  workflowId: string;
  /** 该工作流的第几个发布，从 1 开始。 */
  version: number;
  label: string;
  status: ReleaseStatus;
  origin: ReleaseOrigin;
  parentReleaseId?: string;
  candidateId?: string;
  artifact: ReleaseArtifact;
  artifactHash: string;
  changeSummary: string;
  createdBy: string;
  createdAt: string;
  activatedAt?: string;
  retiredAt?: string;
};

export type ResolvedRelease = {
  manifest: ReleaseManifest;
  workflow: WorkflowDefinition;
  workflows: Map<string, WorkflowDefinition>;
  agents: AgentRecord[];
};

export type EvolutionChangeKind =
  | "prompt_patch"
  | "model_route"
  | "tool_policy"
  | "agent_swap"
  | "workflow_path";

export type EvolutionChange = {
  id: string;
  kind: EvolutionChangeKind;
  /** prompt/model/tool 变更填 Agent id；agent_swap 填节点 path；workflow_path 填工作流 id。 */
  target: string;
  before: string;
  after: string;
  rationale?: string;
};

export type CandidateStatus =
  | "draft"
  | "gating"
  | "gate_passed"
  | "gate_failed"
  | "approved"
  | "rejected"
  | "promoted"
  | "withdrawn";

export type EvolutionCandidate = {
  id: string;
  workflowId: string;
  baseReleaseId: string;
  source: "self_loop" | "manual" | "diagnose" | "rollback";
  title: string;
  summary: string;
  changes: EvolutionChange[];
  proposedBy: string;
  status: CandidateStatus;
  gate?: GateDecision;
  security?: SecurityReport;
  evalRunId?: string;
  draftReleaseId?: string;
  promotedReleaseId?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionComment?: string;
};

export type GatePolicy = {
  /** 指定必须提升的目标用例；为空时只要求整体不退化。 */
  targetCaseIds: string[];
  /** 目标用例最低提升幅度。 */
  minTargetDelta: number;
  /** 单用例最大允许退化幅度。 */
  maxCaseDrop: number;
  /** 整体平均分最大允许退化幅度。 */
  maxMeanDrop: number;
  /** 估算 token 成本相对基线最大增幅（0.15 = 15%）。 */
  maxCostIncreasePct: number;
  /** 单侧配对 bootstrap 的置信水平。 */
  confidence: number;
  /** 少于该用例数不做统计结论，直接拒绝。 */
  minCases: number;
  /** 每条臂至少完成的用例数，避免个别失败被平均掉。 */
  minCompletedPerArm: number;
};

export const DEFAULT_GATE_POLICY: GatePolicy = {
  targetCaseIds: [],
  minTargetDelta: 0.02,
  maxCaseDrop: 0.08,
  maxMeanDrop: 0.01,
  maxCostIncreasePct: 0.15,
  confidence: 0.95,
  minCases: 3,
  minCompletedPerArm: 2
};

export type GateCaseResult = {
  caseId: string;
  title?: string;
  baseScore?: number;
  candidateScore?: number;
  delta?: number;
  baseStatus?: string;
  candidateStatus?: string;
  baseTokens?: number;
  candidateTokens?: number;
  threshold?: number;
  /** 该用例是否被声明为目标用例。 */
  target: boolean;
};

export type GateStats = {
  caseCount: number;
  pairedCount: number;
  baseMean: number;
  candidateMean: number;
  meanDelta: number;
  /** 配对差值的 bootstrap 置信区间下界。 */
  ciLow: number;
  ciHigh: number;
  win: number;
  loss: number;
  tie: number;
  targetDelta?: number;
  baseTokens: number;
  candidateTokens: number;
  costIncreasePct: number;
};

export type GateDecision = {
  passed: boolean;
  reasons: string[];
  policy: GatePolicy;
  stats: GateStats;
  perCase: GateCaseResult[];
  mode: "stub" | "live";
  evaluatedAt: string;
};

export type SecuritySeverity = "critical" | "high" | "medium" | "low";

export type SecurityFinding = {
  id: string;
  severity: SecuritySeverity;
  rule: string;
  target: string;
  message: string;
  evidence: string;
};

export type SecurityReport = {
  passed: boolean;
  findings: SecurityFinding[];
  scannedAt: string;
};

export type EvaluationDataset = {
  id: string;
  workflowId: string;
  name: string;
  version: number;
  description: string;
  createdAt: string;
  cases: EvaluationCase[];
};

export type EvaluationCase = {
  id: string;
  datasetId: string;
  title: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
  rubric: string[];
  threshold: number;
  tags: string[];
};

export type EvaluationRunStatus = "running" | "passed" | "failed" | "error";

export type EvaluationRun = {
  id: string;
  candidateId: string;
  datasetId: string;
  baseReleaseId: string;
  candidateReleaseId: string;
  mode: "stub" | "live";
  status: EvaluationRunStatus;
  decision?: GateDecision;
  error?: string;
  startedAt: string;
  finishedAt?: string;
};

export type RolloutStatus = "canary" | "promoted" | "rolled_back" | "stopped";

export type RolloutArm = "control" | "treatment";

export type ReleaseRollout = {
  id: string;
  workflowId: string;
  releaseId: string;
  baseReleaseId: string;
  percent: number;
  status: RolloutStatus;
  minSamplesPerArm: number;
  maxErrorRateDelta: number;
  maxScoreDrop: number;
  /** 自动回滚触发时的原因；未触发为空。 */
  rollbackReason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type RolloutObservation = {
  id: string;
  rolloutId: string;
  runId: string;
  arm: RolloutArm;
  workflowId: string;
  releaseId: string;
  status: string;
  passed: boolean;
  score?: number;
  durationMs?: number;
  tokens?: number;
  createdAt: string;
};

export type EvolutionAlert = {
  id: string;
  severity: SecuritySeverity;
  kind: "guardrail" | "gate" | "security" | "system";
  entityType: string;
  entityId: string;
  title: string;
  detail: string;
  acknowledged: boolean;
  createdAt: string;
};

export type LedgerEventType =
  | "release.created"
  | "release.activated"
  | "release.archived"
  | "release.rolled_back"
  | "candidate.created"
  | "candidate.gating"
  | "candidate.gate_passed"
  | "candidate.gate_failed"
  | "candidate.approved"
  | "candidate.rejected"
  | "candidate.promoted"
  | "rollout.started"
  | "rollout.observation"
  | "rollout.promoted"
  | "rollout.rolled_back"
  | "alert.raised";

export type LedgerEvent = {
  seq: number;
  type: LedgerEventType;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
  createdAt: string;
};

export type RunReleaseAssignment = {
  runId: string;
  workflowId: string;
  releaseId: string;
  baseReleaseId?: string;
  experimentId?: string;
  arm: RolloutArm;
  rolloutId?: string;
  assignmentKey?: string;
  createdAt: string;
};
