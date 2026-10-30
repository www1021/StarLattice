export const NODE_KINDS = ["agent", "tool", "parallel", "condition", "loop", "verify"] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export type WorkflowVariableType = "string" | "number" | "boolean" | "object";

export type WorkflowVariable = {
  name: string;
  type: WorkflowVariableType;
  required?: boolean;
  description?: string;
};

export type NodeBase = {
  id: string;
  kind: NodeKind;
  title?: string;
  description?: string;
  inputs?: Record<string, unknown>;
};

export type AgentNode = NodeBase & {
  kind: "agent";
  agent: string;
  prompt?: string;
};

export type ToolNode = NodeBase & {
  kind: "tool";
  tool: string;
  args?: Record<string, unknown>;
};

export type ParallelNode = NodeBase & {
  kind: "parallel";
  branches: WorkflowNode[];
};

export type ConditionNode = NodeBase & {
  kind: "condition";
  when: string;
  then: WorkflowNode[];
  else?: WorkflowNode[];
};

export type LoopNode = NodeBase & {
  kind: "loop";
  maxIterations: number;
  while?: string;
  body: WorkflowNode[];
};

export type VerifyNode = NodeBase & {
  kind: "verify";
  verifier: string;
  rubric?: string[];
  threshold?: number;
};

export type WorkflowNode = AgentNode | ToolNode | ParallelNode | ConditionNode | LoopNode | VerifyNode;

export type LeafNode = AgentNode | ToolNode | VerifyNode;

export type WorkflowEdge = {
  from: string;
  to: string;
  label?: string;
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

export type ComparisonOperator = "<" | "<=" | ">" | ">=" | "==" | "!=";

export type CompiledExpression = {
  source: string;
  ref: string;
  operator?: ComparisonOperator;
  value?: string | number | boolean;
};

export type CompiledStep = {
  path: string;
  nodeId: string;
  depth: number;
  node: LeafNode;
};

export type CompiledStatement =
  | { type: "step"; step: CompiledStep }
  | { type: "parallel"; path: string; nodeId: string; title: string; branches: CompiledBlock[] }
  | {
      type: "condition";
      path: string;
      nodeId: string;
      title: string;
      when: CompiledExpression;
      then: CompiledBlock;
      otherwise: CompiledBlock;
    }
  | {
      type: "loop";
      path: string;
      nodeId: string;
      title: string;
      maxIterations: number;
      while?: CompiledExpression;
      body: CompiledBlock;
    };

export type CompiledBlock = CompiledStatement[];

export type CompileIssue = {
  code: string;
  path: string;
  message: string;
};

export type CompiledPlan = {
  workflow: WorkflowDefinition;
  program: CompiledBlock;
  steps: CompiledStep[];
  order: string[];
  stats: {
    rootNodes: number;
    stepCount: number;
    maxDepth: number;
  };
};

export type RunStatus = "queued" | "running" | "verifying" | "revising" | "succeeded" | "failed" | "rolled_back";

export type RunMode = "stub" | "live";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type RunRecord = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  mode: RunMode;
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
  status: StepStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
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

export type AgentWrite = Omit<AgentRecord, "createdAt" | "updatedAt">;

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

export type ToolWrite = Omit<ToolRecord, "createdAt" | "updatedAt">;

export type RegistrySummary = {
  agentCount: number;
  toolCount: number;
  agentsByRole: Record<string, number>;
  toolsByType: Record<ToolKind, number>;
};

export type VerifyDimension = {
  name: string;
  score: number;
  comment?: string;
};

export type VerifyResultRecord = {
  id: string;
  runId: string;
  stepId: string;
  verifier: string;
  score: number;
  confidence: number;
  dimensions: VerifyDimension[];
  issues: string[];
  evidence: string[];
  createdAt: string;
};

export type LoopIterationRecord = {
  id: string;
  runId: string;
  loopNodeId: string;
  iteration: number;
  scoreBefore?: number;
  scoreAfter?: number;
  action: string;
  changes: string[];
  createdAt: string;
};

export type PlatformRunView = {
  run: RunRecord;
  steps: StepRecord[];
};

export class PlatformError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "PlatformError";
  }
}
