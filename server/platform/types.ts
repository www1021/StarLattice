export const NODE_KINDS = [
  "start",
  "end",
  "agent",
  "llm",
  "knowledge",
  "tool",
  "http",
  "template",
  "subworkflow",
  "parallel",
  "condition",
  "loop",
  "verify",
  "approve",
  "human"
] as const;

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
  /** 指定 Agent 版本；留空时使用注册中心里的最新版本。 */
  agentVersion?: number;
  prompt?: string;
};

/** 流程入口：把工作流输入原样作为产物，不覆盖最近一次真实产物。 */
export type StartNode = NodeBase & {
  kind: "start";
};

/** 流程出口：汇总输入映射作为最终结果。 */
export type EndNode = NodeBase & {
  kind: "end";
};

/** 确定性知识库检索节点，不依赖模型；未配置范围时使用工作流默认知识库。 */
export type KnowledgeNode = NodeBase & {
  kind: "knowledge";
  query: string;
  knowledgeBaseIds?: string[];
  topK?: number;
};

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** 受 SSRF 防护约束的 HTTP 请求节点：仅 http/https，拒绝内网与元数据地址。 */
export type HttpNode = NodeBase & {
  kind: "http";
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  requestBody?: unknown;
  timeoutMs?: number;
};

export type ToolNode = NodeBase & {
  kind: "tool";
  tool: string;
  args?: Record<string, unknown>;
};

/** 直接调用模型的轻量节点，不依赖注册中心里的 Agent 角色。 */
export type LlmNode = NodeBase & {
  kind: "llm";
  prompt: string;
  system?: string;
  model?: string;
  /** 打开后在产物里保留一段思考摘要。 */
  thinking?: boolean;
  temperature?: number;
  maxTokens?: number;
};

/** 确定性文本模板，支持 ${节点.字段} 变量，不产生模型调用。 */
export type TemplateNode = NodeBase & {
  kind: "template";
  template: string;
};

/** 引用另一个工作流并内联执行；子流程拥有独立输入作用域与 trace 前缀。 */
export type SubWorkflowNode = NodeBase & {
  kind: "subworkflow";
  workflowId: string;
  workflowVersion?: number;
  /** 对外输出映射：键为父流程引用名，值为子流程作用域内的引用表达式。 */
  outputs?: Record<string, string>;
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

export type LoopBudget = {
  maxDurationMs?: number;
  maxTokens?: number;
};

export type LoopNode = NodeBase & {
  kind: "loop";
  maxIterations: number;
  while?: string;
  patience?: number;
  budget?: LoopBudget;
  body: WorkflowNode[];
};

export type VerifyCheck = {
  /** 目前只支持数值比对；未知类型在编译期报错。 */
  type: "number_match";
  /** 相对容差，范围 0–1；留空表示精确匹配。 */
  tolerance?: number;
};

export type VerifyNode = NodeBase & {
  kind: "verify";
  verifier: string;
  rubric?: string[];
  threshold?: number;
  required?: string[];
  expectedKeywords?: string[];
  minChars?: number;
  verifiers?: string[];
  requireEvidence?: boolean;
  checks?: VerifyCheck[];
};

export type ApproveNode = NodeBase & {
  kind: "approve";
  /** 审批说明，会随待审任务展示给审批人。 */
  instructions?: string;
  /** 期望审批人/角色，仅作展示与记录，不参与权限校验。 */
  assignee?: string;
  /** 超时后运行失败；留空使用平台默认值。 */
  timeoutMs?: number;
};

export type HumanFieldType = "text" | "textarea" | "number" | "boolean" | "select";

/** 人工交互节点的输入字段；响应按 key 落库，并直接成为节点输出。 */
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

export type HumanNode = NodeBase & {
  kind: "human";
  /** 展示给操作者的说明或问题。 */
  prompt: string;
  fields?: HumanField[];
  submitLabel?: string;
  assignee?: string;
  /** 超时后运行失败；留空使用平台默认值。 */
  timeoutMs?: number;
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
  /** 提交交互时的上游快照，便于操作者在不读取整条 trace 时也能判断上下文。 */
  context?: Record<string, unknown>;
  status: InteractionStatus;
  response?: Record<string, unknown>;
  actor?: string;
  expiresAt?: string;
  createdAt: string;
  decidedAt?: string;
};

export type WorkflowNode =
  | StartNode
  | EndNode
  | AgentNode
  | LlmNode
  | KnowledgeNode
  | ToolNode
  | HttpNode
  | TemplateNode
  | SubWorkflowNode
  | ParallelNode
  | ConditionNode
  | LoopNode
  | VerifyNode
  | ApproveNode
  | HumanNode;

export type LeafNode =
  | StartNode
  | EndNode
  | AgentNode
  | LlmNode
  | KnowledgeNode
  | ToolNode
  | HttpNode
  | TemplateNode
  | SubWorkflowNode
  | VerifyNode
  | ApproveNode
  | HumanNode;

export type WorkflowEdge = {
  from: string;
  to: string;
  label?: string;
  /** 可选边条件；为假时该边不激活，下游可能被跳过。 */
  when?: string;
};

export type WorkflowDefinition = {
  id: string;
  name: string;
  version: number;
  description?: string;
  inputs: WorkflowVariable[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** 平台级知识库绑定；工具节点未显式指定 knowledgeBaseIds 时作为默认检索范围。 */
  knowledgeBaseIds?: string[];
  /** 运行期调度池限定：设置后只在该团队的 Agent 中选择执行者。 */
  teamId?: string;
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
  | {
      type: "subworkflow";
      path: string;
      nodeId: string;
      title: string;
      node: SubWorkflowNode;
      /** 编译期展开后的子流程程序；运行时切换独立作用域执行。 */
      program: CompiledBlock;
      definition?: WorkflowDefinition;
    }
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
      patience?: number;
      budget?: LoopBudget;
      body: CompiledBlock;
    };

export type CompiledBlock = CompiledStatement[];

export type CompileIssue = {
  code: string;
  path: string;
  message: string;
};

export type CompiledEdge = {
  from: string;
  to: string;
  label?: string;
  when?: CompiledExpression;
};

/** 顶层执行图：执行器按依赖就绪度并发调度，容器内部仍按原语义执行。 */
export type CompiledGraph = {
  nodes: string[];
  edges: CompiledEdge[];
  entry: string[];
};

export type CompiledPlan = {
  workflow: WorkflowDefinition;
  program: CompiledBlock;
  graph: CompiledGraph;
  steps: CompiledStep[];
  order: string[];
  stats: {
    rootNodes: number;
    stepCount: number;
    maxDepth: number;
    subWorkflows: number;
  };
};

export type RunStatus =
  | "queued"
  | "running"
  | "verifying"
  | "revising"
  | "waiting_approval"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "rolled_back"
  | "cancelled";

export type RunMode = "stub" | "live";

export type StepStatus = "pending" | "running" | "waiting" | "succeeded" | "failed" | "skipped";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export type ApprovalRecord = {
  id: string;
  runId: string;
  stepId: string;
  nodeId: string;
  title: string;
  instructions?: string;
  assignee?: string;
  status: ApprovalStatus;
  /** 待审上下文：产物、验证分、问题与节点输入。 */
  context?: Record<string, unknown>;
  reviewer?: string;
  comment?: string;
  createdAt: string;
  decidedAt?: string;
  expiresAt?: string;
};

export type ApprovalDecision = "approved" | "rejected";

export type RunRecord = {
  id: string;
  workflowId: string;
  workflowVersion: number;
  status: RunStatus;
  mode: RunMode;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  /** 运行前调度计划；旧运行没有该字段。 */
  plan?: unknown;
  /** 运行开始时的 DSL 快照；重跑与单步重跑都以它为准，不受后续保存影响。 */
  definition?: WorkflowDefinition;
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
  attempts?: number;
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

export type AgentVersionRecord = {
  agentId: string;
  version: number;
  snapshot: AgentWrite;
  createdAt: string;
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

export type TeamWrite = Omit<TeamRecord, "createdAt" | "updatedAt">;

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

export type McpTransport = "stdio" | "http";

/** 服务端内部配置，env 可能含密钥，接口层必须脱敏后再返回。 */
export type McpServerConfig = {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  enabled: boolean;
  lastConnectedAt?: string;
  lastError?: string;
  /** 最近一次成功握手的信息，用于页面刷新后仍能展示真实协议与服务端版本。 */
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  lastLatencyMs?: number;
  createdAt: string;
  updatedAt: string;
};

export type McpServerView = Omit<McpServerConfig, "env"> & {
  envKeys: string[];
  toolCount: number;
};

export type McpServerWrite = {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
};

export type McpToolInfo = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
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
  detail?: Record<string, unknown>;
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
