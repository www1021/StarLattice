export const NODE_KINDS = [
  "start",
  "end",
  "agent",
  "llm",
  "clarify",
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

export type AgentOutputFormat = "text" | "json";

/** JSON 输出的最小契约：缺失字段或枚举越界时直接判定本次 Agent 输出无效。 */
export type AgentOutputContract = {
  required?: string[];
  enums?: Record<string, string[]>;
};

export type AgentNode = NodeBase & {
  kind: "agent";
  agent: string;
  /** 指定 Agent 版本；留空时使用注册中心里的最新版本。 */
  agentVersion?: number;
  /** 节点级能力要求；填写后调度按这些能力找候选，留空继承所选 Agent 的能力标签。 */
  capabilities?: string[];
  prompt?: string;
  /** json 模式下执行器会解析并校验 output，下游可用 ${节点.output.字段} 直接引用。 */
  outputFormat?: AgentOutputFormat;
  outputContract?: AgentOutputContract;
  /** 循环体内的角色：诊断 Agent 不参与「换 Agent」覆盖，修订 Agent 才是调度目标。 */
  loopRole?: "diagnose" | "revise";
  /** 诊断 Agent 专用：验证提升后把模型生成的 promptPatch 持久化到该 Agent 的新版本。 */
  promoteToAgent?: string;
  /** 仅 stub 模式使用的离线契约夹具；live 模式始终以模型输出为准。 */
  stubOutput?: Record<string, unknown>;
  /** 开启后 Agent 可在输出前自主调用已声明的知识库 / MCP 工具，最多消耗有限轮次。 */
  toolCalling?: boolean;
  /** 节点级模型覆盖，优先级高于 Agent 注册记录里的 model；取模型目录中的逻辑 id。 */
  model?: string;
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

export type ClarifyImpact = "high" | "medium" | "low";

export type ClarifyAmbiguity = {
  slot: string;
  question: string;
  impact: ClarifyImpact;
};

/** 意图分析器的结构化产物；平台据此决定是否暂停澄清，并驱动 Prompt 重写。 */
export type IntentAnalysis = {
  taskType: string;
  goal: string;
  audience?: string;
  deliverable: string;
  constraints: string[];
  ambiguities: ClarifyAmbiguity[];
  assumptions: string[];
  needsClarification: boolean;
  confidence: number;
};

export type ClarifyAnswer = {
  questions: string[];
  answer: string;
  actor?: string;
  askedAt: string;
};

/**
 * 意图澄清节点：先理解模糊需求，必要时暂停人工澄清，再输出可执行的结构化 Prompt。
 * 与 llm 节点的区别是它带平台固定的分析/改写协议，不是任意一次模型思考。
 */
export type ClarifyNode = NodeBase & {
  kind: "clarify";
  /** 领域提示或额外约束，支持 ${input.x} 引用；留空时只依据本次运行输入。 */
  prompt?: string;
  model?: string;
  /** high=存在高影响歧义才暂停；any=任何歧义都暂停；never=只改写不暂停。 */
  clarifyOn?: "high" | "any" | "never";
  /** 暂停时展示的问题上限，1–3，默认 2。 */
  maxQuestions?: number;
  assignee?: string;
  /** 暂停等待超时；留空使用平台默认值。 */
  timeoutMs?: number;
  /** 仅 stub 模式使用的离线夹具；可强制 needsClarification 以便演练澄清分支。 */
  stubOutput?: Record<string, unknown>;
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
  /**
   * 指标锚点：只核对产物中「标签后第一个数字」是否与对照数据一致。
   * 留空表示严格模式——产物里的每个数字都必须能在对照数据中找到。
   */
  anchors?: string[];
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
  /** 规则层：正文至少要出现多少条正文引用；设置后引用缺失会成为硬性缺陷。 */
  minCitations?: number;
  /** 规则层：正文必须出现的小节标题（如“总体结论”“引用来源”）。 */
  requiredSections?: string[];
  /** 逐验证器模型覆盖，优先于节点 model；用于给不同验证器分配不同上游模型。 */
  verifierModels?: Record<string, string>;
  /** 证据视图：pool=完整检索池；cited=仅产物实际引用的证据；split=第一名看 pool、其余看 cited。 */
  evidenceView?: "pool" | "cited" | "split";
  checks?: VerifyCheck[];
  /** 验证器独立模型；留空时依次取验证 Agent 的 model、PLATFORM_VERIFY_MODEL、平台默认。 */
  model?: string;
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
  | ClarifyNode
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
  | ClarifyNode
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
  /** 运行前调度模式：planner 为默认打分指派；static 用于消融，直接使用 DSL 声明的 Agent。 */
  schedulerMode?: "planner" | "static";
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

/** 调度租约只记录真实在飞的任务，用于负载、心跳和超时回收，不阻塞执行。 */
export type SchedulerLeaseStatus = "active" | "released" | "expired";

export type SchedulerLease = {
  id: string;
  runId: string;
  stepId?: string;
  /** 队列任务 id；同一个任务同时只允许一条 active 租约。 */
  taskId?: string;
  taskPath: string;
  agentId: string;
  workerId: string;
  status: SchedulerLeaseStatus;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  releasedAt?: string;
  releaseReason?: string;
};

/** 顶层运行时就绪队列：记录优先级、排队时长与最终去向，供监控页解释调度决策。 */
export type SchedulerQueueStatus =
  | "queued"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "expired";

export type SchedulerQueueEntry = {
  id: string;
  runId: string;
  nodeId: string;
  path: string;
  /** 关键路径基础优先级，保留给旧监控页与兼容读取。 */
  priority: number;
  status: SchedulerQueueStatus;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  waitMs?: number;
  reason?: string;
  /** 执行所需能力，例如 model / io / stateful。 */
  requiredCapability?: string;
  /** 运行优先级分层。 */
  priorityClass: number;
  /** 运行时最终排序分（基础分 + 老化 + deadline）。 */
  effectivePriority: number;
  /** 任务画像快照。 */
  profile?: Record<string, unknown>;
  /** 指派到的 Agent。 */
  agentId?: string;
  /** 已领取该任务的 Worker。 */
  claimedBy?: string;
  /** 领取到期时间；到期未开工视为 Worker 失联。 */
  claimExpiresAt?: string;
  attempts: number;
  maxAttempts: number;
  deadlineAt?: string;
};

export type SchedulerWorkerStatus = "starting" | "idle" | "busy" | "draining" | "dead";

export type SchedulerWorker = {
  id: string;
  host: string;
  pid?: number;
  slot?: number;
  /** model / io / stateful / inline。 */
  lane: string;
  capabilities: string[];
  capacity: number;
  status: SchedulerWorkerStatus;
  startedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  stoppedAt?: string;
  stopReason?: string;
  meta?: Record<string, unknown>;
};

export type SchedulerAttemptStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "worker_lost"
  | "expired";

export type SchedulerAttempt = {
  id: string;
  queueId: string;
  attempt: number;
  workerId?: string;
  agentId?: string;
  status: SchedulerAttemptStatus;
  leaseId?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  waitMs?: number;
  error?: string;
  trace?: Record<string, unknown>;
};

export type RunNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled";

export type RunNodeRecord = {
  runId: string;
  nodeId: string;
  path: string;
  status: RunNodeStatus;
  priority: number;
  readyAt?: string;
  startedAt?: string;
  finishedAt?: string;
  attempts: number;
  error?: string;
};

export type RunCheckpoint = {
  id: string;
  runId: string;
  sequence: number;
  state: Record<string, unknown>;
  createdAt: string;
};

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
  /** 本次运行使用的冻结发布；为空表示直接读取实时注册中心。 */
  releaseId?: string;
  /** 演化实验 id（门禁评测 / 金丝雀）。 */
  experimentId?: string;
  /** 实验分组：control 使用基线发布，treatment 使用候选发布。 */
  arm?: string;
  /** 调度优先级分层；0 为默认。 */
  priorityClass?: number;
  /** 截止时间；调度器据此计算 deadline 加成。 */
  deadlineAt?: string;
  /** 取消请求写入数据库，跨进程调度器都能看到。 */
  cancelRequestedAt?: string;
  /** 孤儿恢复次数。 */
  resumeCount?: number;
  /** 调度状态：queued / running / recovering 等。 */
  schedulerState?: string;
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
  /** Self-Loop 换模型时记录切换前后的逻辑模型 id。 */
  modelBefore?: string;
  modelAfter?: string;
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
