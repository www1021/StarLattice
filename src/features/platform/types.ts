export type NodeKind = "agent" | "tool" | "parallel" | "condition" | "loop" | "verify";

export type WorkflowNode = {
  id: string;
  kind: NodeKind;
  title?: string;
  description?: string;
  agent?: string;
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
};

export type SaveWorkflowResponse = {
  workflow: WorkflowDetail;
  plan: CompileStats;
};

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "rolled_back" | "verifying" | "revising";

export type RunRecord = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  mode: "stub" | "live";
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
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
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
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

export type VerifyResult = {
  id: string;
  stepId: string;
  verifier: string;
  score: number;
  confidence: number;
  dimensions: VerifyDimension[];
  issues: string[];
  evidence: string[];
  createdAt: string;
};

export type LoopIteration = {
  id: string;
  loopNodeId: string;
  iteration: number;
  scoreBefore?: number;
  scoreAfter?: number;
  action: string;
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

export type TraceResponse = {
  run: RunRecord;
  steps: StepRecord[];
  verifyResults: VerifyResult[];
  loopIterations: LoopIteration[];
};
