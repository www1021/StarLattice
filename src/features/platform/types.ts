export type NodeKind =
  | "agent"
  | "llm"
  | "tool"
  | "template"
  | "subworkflow"
  | "parallel"
  | "condition"
  | "loop"
  | "verify"
  | "approve";

export type WorkflowNode = {
  id: string;
  kind: NodeKind;
  title?: string;
  description?: string;
  agent?: string;
  agentVersion?: number;
  prompt?: string;
  inputs?: Record<string, unknown>;
  tool?: string;
  args?: Record<string, unknown>;
  branches?: WorkflowNode[];
  when?: string;
  then?: WorkflowNode[];
  else?: WorkflowNode[];
  maxIterations?: number;
  while?: string;
  body?: WorkflowNode[];
  verifier?: string;
  rubric?: string[];
  threshold?: number;
  instructions?: string;
  assignee?: string;
  timeoutMs?: number;
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
  | "waiting_approval";

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

export type ScheduleDecisionView = {
  taskId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  dependsOn: string[];
  score: number;
  breakdown: { capability: number; availability: number; priority: number };
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
};

export type VerifyAgentScore = {
  agentId: string;
  agentName: string;
  score: number;
  dimensions?: VerifyDimension[];
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

export type RegistryAgentView = AgentRecord & {
  callCount: number;
  teamIds: string[];
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

export type TraceResponse = {
  run: RunRecord;
  steps: StepRecord[];
  verifyResults: VerifyResult[];
  loopIterations: LoopIteration[];
  approvals: ApprovalRecord[];
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
};
