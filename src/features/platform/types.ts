export type NodeKind =
  | "start"
  | "end"
  | "agent"
  | "llm"
  | "clarify"
  | "knowledge"
  | "tool"
  | "http"
  | "template"
  | "subworkflow"
  | "parallel"
  | "condition"
  | "loop"
  | "verify"
  | "approve"
  | "human";

export type WorkflowNode = {
  id: string;
  kind: NodeKind;
  title?: string;
  description?: string;
  agent?: string;
  agentVersion?: number;
  capabilities?: string[];
  prompt?: string;
  clarifyOn?: "high" | "any" | "never";
  maxQuestions?: number;
  outputFormat?: "text" | "json";
  outputContract?: { required?: string[]; enums?: Record<string, string[]> };
  loopRole?: "diagnose" | "revise";
  promoteToAgent?: string;
  stubOutput?: Record<string, unknown>;
  toolCalling?: boolean;
  expectedKeywords?: string[];
  inputs?: Record<string, unknown>;
  tool?: string;
  args?: Record<string, unknown>;
  query?: string;
  knowledgeBaseIds?: string[];
  topK?: number;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url?: string;
  headers?: Record<string, string>;
  requestBody?: unknown;
  branches?: WorkflowNode[];
  when?: string;
  then?: WorkflowNode[];
  else?: WorkflowNode[];
  maxIterations?: number;
  while?: string;
  patience?: number;
  budget?: { maxDurationMs?: number; maxTokens?: number };
  body?: WorkflowNode[];
  verifier?: string;
  verifiers?: string[];
  rubric?: string[];
  threshold?: number;
  minChars?: number;
  checks?: Array<{ type: "number_match"; tolerance?: number; anchors?: string[] }>;
  instructions?: string;
  assignee?: string;
  timeoutMs?: number;
  submitLabel?: string;
  fields?: HumanField[];
  system?: string;
  model?: string;
  thinking?: boolean;
  temperature?: number;
  maxTokens?: number;
  template?: string;
  workflowId?: string;
  workflowVersion?: number;
  outputs?: Record<string, string>;
};

export type WorkflowEdge = {
  from: string;
  to: string;
  label?: string;
  /** 可选边条件；为假时该边不激活，下游可能被跳过。 */
  when?: string;
};

export type WorkflowVariable = {
  name: string;
  type: "string" | "number" | "boolean" | "object";
  required?: boolean;
  description?: string;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  version: number;
  description?: string;
  inputs: WorkflowVariable[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  knowledgeBaseIds?: string[];
};

export type NodeFieldType = "text" | "textarea" | "number" | "boolean" | "json" | "list" | "select";

export type NodeField = {
  key: string;
  label: string;
  type: NodeFieldType;
  required?: boolean;
  defaultValue?: unknown;
  placeholder?: string;
  help?: string;
  supportsRefs?: boolean;
  options?: string[];
  optionLabels?: Record<string, string>;
};

export type NodeBlock = {
  key: string;
  label: string;
  required: boolean;
  multiple: boolean;
};

export type NodeTypeSpec = {
  kind: NodeKind;
  label: string;
  description: string;
  shape: "node" | "container";
  accent: string;
  fields: NodeField[];
  blocks: NodeBlock[];
};

export type CanvasContract = {
  model: string;
  containers: string;
  edgeScope: string;
  containerEditing: string;
  refSyntax: string;
  operators: string[];
  variableExprForms: string[];
};

export type NodeTypesResponse = {
  version: number;
  commonFields: NodeField[];
  nodeTypes: NodeTypeSpec[];
  canvas: CanvasContract;
};

export type PlatformIssue = {
  code: string;
  path: string;
  message: string;
  /** 调试门禁诊断用：error 阻断进入调试视图，warning 只提示。 */
  severity?: "error" | "warning";
};

export type DiagnoseWorkflowResponse = {
  ok: boolean;
  issues: PlatformIssue[];
};

export type WorkflowSummary = {
  id: string;
  name: string;
  version: number;
  description: string;
  status: string;
  nodeCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowDetail = {
  definition: WorkflowDefinition;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type CompileStats = {
  rootNodes: number;
  stepCount: number;
  maxDepth: number;
  subWorkflows?: number;
};

export type SaveWorkflowResponse = {
  workflow: WorkflowDetail;
  plan: CompileStats;
};

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "cancelled"
  | "verifying"
  | "revising"
  | "waiting_approval"
  | "waiting_input";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalDecision = "approved" | "rejected";

export type ApprovalRecord = {
  id: string;
  runId: string;
  stepId: string;
  nodeId: string;
  title: string;
  instructions?: string;
  assignee?: string;
  status: ApprovalStatus;
  context?: {
    artifact?: unknown;
    artifactNodeId?: string;
    score?: number;
    confidence?: number;
    issues?: string[];
    input?: Record<string, unknown>;
    [key: string]: unknown;
  };
  reviewer?: string;
  comment?: string;
  createdAt: string;
  decidedAt?: string;
  expiresAt?: string;
};

export type HumanFieldType = "text" | "textarea" | "number" | "boolean" | "select";

export type HumanField = {
  key: string;
  label: string;
  type?: HumanFieldType;
  required?: boolean;
  options?: string[];
  defaultValue?: string | number | boolean;
  placeholder?: string;
  description?: string;
};

export type InteractionStatus = "pending" | "answered" | "expired" | "cancelled";

export type InteractionRecord = {
  id: string;
  runId: string;
  stepId: string;
  nodeId: string;
  path: string;
  title: string;
  prompt: string;
  fields: HumanField[];
  context?: Record<string, unknown>;
  status: InteractionStatus;
  response?: Record<string, unknown>;
  actor?: string;
  expiresAt?: string;
  createdAt: string;
  decidedAt?: string;
};

export type InteractionResponse = {
  run: RunRecord;
  steps: StepRecord[];
  interactions: InteractionRecord[];
  interaction: InteractionRecord;
  pending?: InteractionRecord;
};

export type ScheduleDecisionView = {  taskId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  dependsOn: string[];
  score: number;
  breakdown: { capability: number; availability: number; priority: number; model?: number };
  load?: { inFlight: number; capacity: number; ratio: number };
  model?: {
    id: string;
    provider: string;
    model: string;
    tags: string[];
    costTier: "low" | "medium" | "high";
    fit: number;
  };
  reason: string;
  alternatives: Array<{ agentId: string; agentName: string; score: number; capability: number }>;
};

export type SchedulePlanView = {
  batchId: string;
  formula: string;
  decisions: ScheduleDecisionView[];
  blocked: Array<{ taskId: string; taskTitle: string; blockedBy: string[]; reason: string }>;
  unassigned: Array<{ taskId: string; taskTitle: string; reason: string }>;
  stats: { taskCount: number; scheduledCount: number; blockedCount: number; unassignedCount: number };
  requestedAgentIds: Record<string, string>;
};

export type RunRecord = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  mode: "stub" | "live";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  plan?: SchedulePlanView;
  error?: string;
  stepCount: number;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  releaseId?: string;
  experimentId?: string;
  arm?: string;
  priorityClass?: number;
  deadlineAt?: string;
  cancelRequestedAt?: string;
  resumeCount?: number;
  schedulerState?: string;
};

export type StepRecord = {
  id: string;
  runId: string;
  sequence: number;
  path: string;
  nodeId: string;
  nodeKind: NodeKind;
  status: "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped";
  attempts?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
};

export type VerifyDimension = {
  name: string;
  score: number;
  comment?: string;
};

export type VerifyRuleCheck = {
  key: string;
  label: string;
  passed: boolean;
  detail?: string;
  informational?: boolean;
  critical?: boolean;
};

export type VerifyAgentScore = {
  agentId: string;
  agentName: string;
  score: number;
  dimensions?: VerifyDimension[];
  model?: string;
  resolvedModel?: string;
  modelProvider?: string;
  requestedModel?: string;
  modelSource?: string;
  evidenceView?: "pool" | "cited";
  fallback?: boolean;
};

export type VerifyCitationSummary = {
  total: number;
  distinct: number;
  valid: number;
  missing: number;
  pool: number;
  markers: string[];
};

export type VerifyIndependence = {
  level: "prompt" | "evidence" | "model" | "cross-provider";
  modelDistinct: boolean;
  providerDistinct: boolean;
  evidenceDistinct: boolean;
  heuristicFallback: boolean;
  models: string[];
  providers: string[];
};

export type VerifyLayers = {
  rule: { score: number; checks: VerifyRuleCheck[] };
  crossCheck: { score: number; spread: number; agreement: boolean; verifiers: VerifyAgentScore[] };
  baseline: { score: number; coverage: number; matched: string[]; missing: string[] };
};

export type VerifyResult = {
  id: string;
  stepId: string;
  verifier: string;
  score: number;
  confidence: number;
  dimensions: VerifyDimension[];
  issues: string[];
  evidence: string[];
  detail?: {
    layers?: VerifyLayers;
    verifiers?: VerifyAgentScore[];
    citations?: VerifyCitationSummary;
    independence?: VerifyIndependence;
    artifactNodeId?: string;
  };
  createdAt: string;
};

export type LoopIteration = {
  id: string;
  loopNodeId: string;
  iteration: number;
  scoreBefore?: number;
  scoreAfter?: number;
  action: string;
  modelBefore?: string;
  modelAfter?: string;
  changes?: string[];
};

export type AgentCapability = {
  tag: string;
  weight: number;
};

export type AgentRecord = {
  id: string;
  name: string;
  version: number;
  role: string;
  prompt: string;
  tools: string[];
  model: string;
  capabilities: AgentCapability[];
  memory: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SaveAgentResponse = {
  agent: AgentRecord;
  created: boolean;
};

export type AgentVersionRecord = {
  agentId: string;
  version: number;
  snapshot: Omit<AgentRecord, "createdAt" | "updatedAt">;
  createdAt: string;
};

export type AgentVersionsResponse = {
  agentId: string;
  currentVersion: number;
  versions: AgentVersionRecord[];
};

export type RollbackAgentResponse = {
  agent: AgentRecord;
  rolledBackTo: number;
};

export type TeamRecord = {
  id: string;
  name: string;
  description: string;
  agentIds: string[];
  workflowId?: string;
  knowledgeBaseIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type SaveTeamResponse = {
  team: TeamRecord;
  created: boolean;
};

export type ModelProfileView = {
  id: string;
  label: string;
  description: string;
  provider: string;
  model: string;
  tags: string[];
  costTier: "low" | "medium" | "high";
  configured: boolean;
  custom: boolean;
};

export type RegistryAgentView = AgentRecord & {
  callCount: number;
  teamIds: string[];
  modelProfile?: ModelProfileView;
};

export type RegistryOverview = {
  teams: TeamRecord[];
  agents: RegistryAgentView[];
};

export type KnowledgeBaseRef = {
  id: string;
  name: string;
  source: string;
  providerStatus?: string;
  documentCount: number;
  createdAt: string;
  teamIds: string[];
  workflowIds: string[];
};

export type KnowledgeWorkflowRef = {
  id: string;
  name: string;
  version: number;
  knowledgeBaseIds: string[];
};

export type KnowledgeBaseOverview = {
  bases: KnowledgeBaseRef[];
  teams: TeamRecord[];
  workflows: KnowledgeWorkflowRef[];
};

export type StarterKnowledgePack = {
  id: string;
  name: string;
  description: string;
  recommendedFor: string[];
  documentCount: number;
};

export type KnowledgeDocument = {
  id: string;
  knowledgeBaseId: string;
  name: string;
  type: string;
  size: number;
  chunkCount: number;
  resourceType?: string;
  subject?: string;
  schoolStage?: string;
  tags: string[];
  createdAt: string;
};

export type KnowledgeCitation = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  documentId: string;
  documentName: string;
  snippet: string;
  score: number;
  source?: string;
};

export type BindKnowledgeResponse = {
  bound: boolean;
  team?: TeamRecord;
  workflow?: { id: string; version: number; knowledgeBaseIds: string[] };
};

export type ToolKind = "builtin" | "mcp" | "http";

export type ToolRecord = {
  id: string;
  name: string;
  type: ToolKind;
  schema: Record<string, unknown>;
  endpoint?: string;
  description: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SaveToolResponse = {
  tool: ToolRecord;
  created: boolean;
};

export type McpTransport = "stdio" | "http";

export type McpServerView = {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  enabled: boolean;
  lastConnectedAt?: string;
  lastError?: string;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  lastLatencyMs?: number;
  createdAt: string;
  updatedAt: string;
  envKeys: string[];
  toolCount: number;
};

export type McpServerWrite = {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled?: boolean;
};

export type McpToolInfo = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpConnectionInfo = {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
};

export type McpRefreshResponse = {
  server: McpServerView;
  tools: McpToolInfo[];
  info: McpConnectionInfo;
  latencyMs: number;
};

export type McpCallResult = {
  serverId: string;
  serverName: string;
  tool: string;
  latencyMs: number;
  isError: boolean;
  content: unknown[];
  text: string;
  structuredContent?: unknown;
};

export type McpCallResponse = {
  result: McpCallResult;
};

export type SchedulerWorkerView = {
  id: string;
  killed: boolean;
  activeTasks: string[];
  /** 接进程池后补充的字段；模拟 Worker 不返回。 */
  pid?: number;
  slot?: number;
  status?: string;
};

/** Worker 子进程台账记录；与内存里的执行槽分开呈现。 */
export type SchedulerProcessView = {
  id: string;
  host: string;
  pid?: number;
  slot?: number;
  lane: string;
  capabilities: string[];
  capacity: number;
  status: "starting" | "idle" | "busy" | "draining" | "dead";
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  stoppedAt?: string;
  stopReason?: string;
};

export type SchedulerLeadershipView = {
  holder: string;
  heartbeatAt: string;
  expiresAt: string;
};

export type ReclaimerStatusView = {
  holder: string;
  leader: boolean;
  intervalMs: number;
  autoResume: boolean;
  graceMs: number;
  lastTickAt?: string;
  lastReport?: {
    at: string;
    leader: boolean;
    expiredWorkers: number;
    expiredLeases: number;
    requeuedTasks: string[];
    expiredTasks: string[];
    resumed: Array<{ previousRunId: string; runId: string; reason: string }>;
    skipped: Array<{ runId: string; reason: string }>;
  };
};

export type RunCheckpointView = {
  id: string;
  runId: string;
  sequence: number;
  createdAt: string;
  /** trace 只返回摘要；完整状态留在服务端。 */
  nodeCount?: number;
  state?: Record<string, unknown>;
};

export type ReplayPolicy = "dynamic" | "static" | "critical-path" | "fifo" | "recorded";

export type ReplayMetricsView = {
  policy: ReplayPolicy;
  capacity: number;
  tasks: number;
  makespanMs: number;
  waitP50Ms: number;
  waitP95Ms: number;
  waitMaxMs: number;
  avgWaitMs: number;
  deadlineMisses: number;
  priorityInversions: number;
  utilization: number;
};

export type WhatIfResponse = {
  source: { kind: "trace"; runId: string } | { kind: "sandbox" };
  capacity: number;
  taskCount: number;
  recorded: ReplayMetricsView;
  policies: ReplayMetricsView[];
};

export type SchedulerQueueEntry = {
  id: string;
  runId: string;
  nodeId: string;
  path: string;
  priority: number;
  status:
    | "queued"
    | "claimed"
    | "running"
    | "succeeded"
    | "failed"
    | "skipped"
    | "cancelled"
    | "expired";
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  waitMs?: number;
  reason?: string;
  requiredCapability?: string;
  priorityClass?: number;
  effectivePriority?: number;
  profile?: Record<string, unknown>;
  agentId?: string;
  claimedBy?: string;
  claimExpiresAt?: string;
  attempts?: number;
  maxAttempts?: number;
  deadlineAt?: string;
};

export type RunNodeView = {
  runId: string;
  nodeId: string;
  path: string;
  status: "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
  priority: number;
  attempts: number;
  error?: string;
  readyAt?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type TraceResponse = {
  run: RunRecord;
  steps: StepRecord[];
  verifyResults: VerifyResult[];
  loopIterations: LoopIteration[];
  approvals: ApprovalRecord[];
  interactions: InteractionRecord[];
  queue?: SchedulerQueueEntry[];
  runNodes?: RunNodeView[];
  checkpoints?: RunCheckpointView[];
};

export type RunMetrics = {
  runCount: number;
  succeeded: number;
  failed: number;
  successRate: number;
  taskPassed: number;
  taskRate: number;
  scoreAvg: number | null;
  p50Ms: number;
  p95Ms: number;
  stepsAvg: number;
  iterationsAvg: number;
  tokensTotal: number;
  tokensAvg: number;
  estimatedCost: number;
  modes: string[];
};

export type MetricsReport = {
  generatedAt: string;
  costRatePer1kTokens: number;
  overall: RunMetrics;
  workflows: Array<{ workflowId: string } & RunMetrics>;
  alerts: AnomalyAlert[];
};

export type AnomalyAlert = {
  workflowId: string;
  kind: "failure_spike" | "latency_spike" | "score_drift";
  severity: "warning" | "critical";
  message: string;
  value: number;
  threshold: number;
  sampleSize: number;
};

export type EvolutionRelease = {
  id: string;
  workflowId: string;
  version: number;
  label: string;
  status: "draft" | "active" | "canary" | "rolled_back" | "archived";
  origin: string;
  parentReleaseId?: string;
  candidateId?: string;
  artifactHash: string;
  changeSummary: string;
  createdBy: string;
  createdAt: string;
  activatedAt?: string;
  retiredAt?: string;
  artifact?: {
    workflow: { id: string; version: number };
    workflows: Array<{ id: string; version: number }>;
    agents: AgentRecord[];
  };
};

export type EvolutionChange = {
  id: string;
  kind: "prompt_patch" | "model_route" | "tool_policy" | "agent_swap" | "workflow_path";
  target: string;
  before: string;
  after: string;
  rationale?: string;
};

export type EvolutionSecurityFinding = {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  rule: string;
  target: string;
  message: string;
  evidence: string;
};

export type EvolutionGateCase = {
  caseId: string;
  title: string;
  baseScore?: number;
  candidateScore?: number;
  delta?: number;
  baseStatus: string;
  candidateStatus: string;
  baseTokens: number;
  candidateTokens: number;
  threshold: number;
  target: boolean;
};

export type EvolutionGateDecision = {
  passed: boolean;
  reasons: string[];
  policy: Record<string, unknown>;
  stats: {
    caseCount: number;
    pairedCount: number;
    baseMean: number;
    candidateMean: number;
    meanDelta: number;
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
  perCase: EvolutionGateCase[];
  mode: "stub" | "live";
  evaluatedAt: string;
};

export type EvolutionCandidate = {
  id: string;
  workflowId: string;
  baseReleaseId: string;
  draftReleaseId?: string;
  promotedReleaseId?: string;
  source: "self_loop" | "manual" | "diagnose" | "rollback";
  title: string;
  summary: string;
  changes: EvolutionChange[];
  proposedBy: string;
  status:
    | "draft"
    | "gating"
    | "gate_passed"
    | "gate_failed"
    | "approved"
    | "rejected"
    | "promoted"
    | "withdrawn";
  security?: {
    passed: boolean;
    findings: EvolutionSecurityFinding[];
    scannedAt: string;
  };
  gate?: EvolutionGateDecision;
  decisionComment?: string;
  decidedBy?: string;
  decidedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type EvolutionEvaluation = {
  id: string;
  candidateId: string;
  datasetId: string;
  baseReleaseId: string;
  candidateReleaseId: string;
  mode: "stub" | "live";
  status: "running" | "passed" | "failed" | "error";
  decision?: EvolutionGateDecision;
  error?: string;
  startedAt: string;
  finishedAt?: string;
};

export type EvolutionRollout = {
  id: string;
  workflowId: string;
  releaseId: string;
  baseReleaseId: string;
  percent: number;
  status: "canary" | "promoted" | "rolled_back" | "stopped";
  minSamplesPerArm: number;
  maxErrorRateDelta: number;
  maxScoreDrop: number;
  rollbackReason?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
};

export type EvolutionObservation = {
  id: string;
  rolloutId: string;
  runId: string;
  arm: "control" | "treatment";
  workflowId: string;
  releaseId: string;
  status: string;
  passed: boolean;
  score?: number;
  durationMs?: number;
  tokens: number;
  createdAt: string;
};

export type EvolutionAlert = {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  kind: "guardrail" | "gate" | "security" | "system";
  entityType: string;
  entityId: string;
  title: string;
  detail: string;
  acknowledged: boolean;
  createdAt: string;
};

export type EvolutionLedgerEvent = {
  seq: number;
  type: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
  createdAt: string;
};

export type EvolutionLedger = {
  events: EvolutionLedgerEvent[];
  integrity: { valid: boolean; events: number; brokenAt?: number };
};

export type EvolutionOverview = {
  enabled: boolean;
  releases: {
    total: number;
    active: number;
    canary: number;
    byWorkflow: Record<string, number>;
  };
  candidates: { total: number; byStatus: Record<string, number> };
  rollouts: { total: number; canary: number; rolledBack: number };
  alerts: { open: number };
  ledger: { valid: boolean; events: number; brokenAt?: number };
};

export type EvolutionDataset = {
  id: string;
  workflowId: string;
  name: string;
  version: number;
  description: string;
  createdAt: string;
  cases: Array<{
    id: string;
    datasetId: string;
    title: string;
    input: Record<string, unknown>;
    expected: Record<string, unknown>;
    rubric: string[];
    threshold: number;
    tags: string[];
  }>;
};
