import { hostname } from "node:os";
import {
  PlatformError,
  type AgentNode,
  type AgentRecord,
  type ApprovalDecision,
  type ApprovalRecord,
  type ApproveNode,
  type ClarifyAmbiguity,
  type ClarifyAnswer,
  type ClarifyNode,
  type ExtractNode,
  type ExtractParam,
  type IntentAnalysis,
  type CompiledBlock,
  type CompiledEdge,
  type CompiledExpression,
  type CompiledPlan,
  type CompiledStatement,
  type CompiledStep,
  type HttpNode,
  type HumanField,
  type HumanNode,
  type InteractionRecord,
  type KnowledgeNode,
  type LlmNode,
  type NodeKind,
  type PlatformRunView,
  type RunMode,
  type RunRecord,
  type RunStatus,
  type SchedulerLease,
  type SchedulerWorkerStatus,
  type StepRecord,
  type SubWorkflowNode,
  type TemplateNode,
  type ToolNode,
  type VerifyDimension,
  type VerifyNode,
  type WorkflowDefinition,
  type WorkflowNode
} from "../types.js";
import { ApprovalGate, type ApprovalOutcome } from "./approvalGate.js";
import { HumanGate } from "./humanGate.js";
import { CHOICE_FIELD_KEY, normalizeChoices, withChoiceField } from "./humanChoices.js";
import { CHOICE_OTHER_PORT, choicePortOf, inferChoicePorts, type ChoicePortEdge } from "../workflow/choicePorts.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { assignmentsOf, buildWorkflowSchedule, replanForTask } from "../scheduler/planner.js";
import {
  actionLabel,
  estimateTokens,
  SelfLoopController,
  type SelfLoopAction,
  type SelfLoopPromotion,
  type SelfLoopStopReason,
  type SelfLoopSummary
} from "../selfLoop/controller.js";
import {
  collectCitations,
  heuristicDimensionScorer,
  LayeredVerifier,
  normalizeEvidence,
  stubDimensionScorer,
  type DimensionScorer,
  type VerifyLayers,
  type VerifyReport
} from "../verify/verifier.js";
import type { PlatformStateStore } from "./stateStore.js";
import type { ResolvedRelease } from "../evolution/types.js";
import { InlineStepInvoker, type StepInvoker } from "./invoker.js";
import { SchedulerService, SchedulerTaskCancelledError } from "../scheduler/service.js";
import { WorkerLostError } from "../workers/errors.js";
import {
  buildWorkerInvocation,
  type WorkerLease,
  type WorkerPoolLike
} from "../workers/protocol.js";

const REF_PATTERN = /^\$\{([^}\s]+)\}$/;
const EMBEDDED_REF_PATTERN = /\$\{([^}\s]+)\}/g;
/** 节点级重试的硬上限，防止单节点把整条流程的时延拖穿。 */
const MAX_NODE_ATTEMPTS = 6;

export type WorkflowNodeProgress = {
  nodeId: string;
  title: string;
  kind: string;
  status: "running" | "succeeded" | "failed";
  sequence: number;
  workflowId: string;
  /** 子流程节点带路径前缀，界面可据此缩进显示。 */
  path?: string;
  durationMs?: number;
};

export type RunOptions = {
  /** 试跑：执行到该顶层节点完成后停下，后续节点保持未执行。 */
  stopAfter?: string;
  /** 使用冻结发布运行；为空时直接读取实时注册中心。 */
  releaseId?: string;
  /** 演化实验 id，写入运行记录用于门禁与金丝雀对比。 */
  experimentId?: string;
  /** 实验分组。 */
  arm?: "control" | "treatment";
  /** 运行落库后的回调，供控制面在真正执行前写入分流归属。 */
  onCreated?: (run: RunRecord) => void;
  /** 每个节点结算后的进度回调，供聊天界面实时显示工作流走到哪一步。 */
  onNodeProgress?: (event: WorkflowNodeProgress) => void;
  /** 运行级优先档，覆盖节点类别分档；数值越大越先出队。 */
  priorityClass?: number;
  /** 运行截止时间；临近或超时的任务在全局队列中获得加成。 */
  deadlineAt?: string;
};

export type RunScope = {
  input: Record<string, unknown>;
  outputs: Map<string, unknown>;
  /** 运行时证据池：任一节点产生的 citation 都会进入这里，并跨子流程继承。 */
  evidence: string[];
  verifyRounds: number;
  lastVerifyScore?: number;
  lastVerifyIssues?: string[];
  lastVerifyConfidence?: number;
  lastVerifyPassed?: boolean;
  lastVerifyLayers?: VerifyLayers;
  lastArtifact?: unknown;
  lastArtifactNodeId?: string;
};

export type LoopScope = {
  artifact?: unknown;
  issues: string[];
  score?: number;
  iteration: number;
  retrievalQuery?: string;
};

/** 循环帧里参与 ${loop.*} 解析的字段；Worker 进程只需这一部分。 */
export type LoopProfile = LoopScope & { path: string };

/**
 * 叶子步骤执行所需的最小状态。父进程的完整 RunState 与 Worker 进程按 IPC
 * 重建的状态都满足该形状，因此同一个 invoke 实现可以两端复用。
 */
export type LeafExecutionState = {
  runId: string;
  workflowId: string;
  iteration: number;
  scope: RunScope;
  loops: LoopProfile[];
  workflowKnowledgeBaseIds: string[];
  tokensUsed: number;
  tokenBudget?: number;
  agentSnapshots?: Map<string, AgentRecord>;
};

export type ExecutionContext = {
  runId: string;
  workflowId: string;
  iteration: number;
  scope: RunScope;
  loop?: LoopScope;
  /**
   * 当前节点自己声明的输入变量（name → 已解析的值）。
   * 正文里 ${template} 这类引用优先按它解析，取不到再回落到节点输出与运行输入。
   */
  locals?: Record<string, unknown>;
  /** 工作流级知识库范围，供 Agent 自主调用 knowledge.search 时使用。 */
  knowledgeBaseIds?: string[];
  /** 当前运行已消耗的估算 token，供模型解析做预算降级。 */
  tokensUsed?: number;
  /** 运行级 token 预算；0 或未设置表示不限制。 */
  tokenBudget?: number;
  /** 冻结发布中的 Agent 快照；存在时替换实时注册表。 */
  agentSnapshots?: Map<string, AgentRecord>;
  /** 本次运行的发布与实验标记。 */
  release?: { releaseId: string; experimentId?: string; arm?: string };
  /**
   * 当前步骤的台账 path（容器内是 loopId/childId）。live handler 用它把模型
   * token 推给调试 SSE（runStreamBus 按 runId + path 开流式消息），与
   * platform_run_steps.path 同源，前端才能把流式正文对到画布节点上。
   */
  stepPath?: string;
};

/** clarify 节点分两阶段调用模型：先分析意图，再按澄清结果改写 Prompt。 */
export type ClarifyPhase =
  | { phase: "analyze" }
  | { phase: "rewrite"; analysis: IntentAnalysis; clarification?: ClarifyAnswer };

export type ExecutorHandlers = {
  agent?: (node: AgentNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  llm?: (node: LlmNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  clarify?: (
    node: ClarifyNode,
    input: Record<string, unknown>,
    context: ExecutionContext,
    phase: ClarifyPhase
  ) => unknown | Promise<unknown>;
  tool?: (node: ToolNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  /** 仅处理已注册的 MCP 工具；返回 undefined 时回落到内置 stub，因此不会把整个执行器标记为 live。 */
  mcpTool?: (node: ToolNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  /** 确定性内置工具（如 knowledge.search）；stub 模式也可接真实服务，且不改变 live 判定。 */
  knowledgeTool?: (node: ToolNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  /** 确定性训练工具（课堂 / 谈心谈话）；返回 undefined 时继续走后续工具处理，不影响 live 判定。 */
  trainingTool?: (node: ToolNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  /** 独立的 knowledge 节点；与工具节点共用同一检索服务，但语义更清晰。 */
  knowledgeNode?: (node: KnowledgeNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  /** 参数提取：只做「从文本里抽参数」这一步；返回 undefined 时执行器回落规则抽取。 */
  extract?: (node: ExtractNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  /** HTTP 节点；实现方必须负责 SSRF 防护与响应大小限制。 */
  http?: (node: HttpNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  verify?: (node: VerifyNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
};

export type VerifyOutput = {
  score: number;
  confidence: number;
  passed?: boolean;
  dimensions: VerifyDimension[];
  issues: string[];
  evidence: string[];
  layers?: VerifyLayers;
  verifiers?: VerifyReport["layers"]["crossCheck"]["verifiers"];
  citations?: VerifyReport["citations"];
  independence?: VerifyReport["independence"];
  artifactNodeId?: string;
};

export type ExecutorOptions = {
  maxAttempts?: number;
  timeoutMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** 顶层 DAG 同时执行的节点数；容器、人工交互与验证节点仍独占执行。 */
  maxConcurrency?: number;
  rollbackOnFailure?: boolean;
  dimensionScorer?: DimensionScorer;
  approvalTimeoutMs?: number;
  /** human 节点未显式声明超时时的默认等待时长。 */
  humanTimeoutMs?: number;
  /** 运行级 token 预算；超出后模型解析自动降级到低成本档。 */
  tokenBudget?: number;
  /** 冻结发布解析器；由演化控制面注入。 */
  releaseProvider?: { resolveRelease(id: string): ResolvedRelease | undefined };
  /** 运行进入终态后的回调，用于金丝雀观测与护栏判定。 */
  onRunFinished?: (runId: string) => void;
  /** 发布运行中自循环补丁不直接写注册表，改为登记演化候选。 */
  onPromptCandidate?: (signal: PromptCandidateSignal) => void;
  onStatusChange?: (runId: string, status: RunStatus) => void;
  /** 叶子步骤执行边界；默认在本进程内执行，替换后可将步骤派发到 Worker 进程。 */
  invoker?: StepInvoker;
  /** 全局调度服务；多运行共享时注入同一实例，缺省按本执行器并发建一个进程内服务。 */
  scheduler?: SchedulerService;
  /** 全局并发槽位数；缺省沿用 maxConcurrency，可用 PLATFORM_SCHEDULER_CAPACITY 覆盖。 */
  schedulerCapacity?: number;
  /** 队列选择策略：dynamic 按有效优先级；static 固定 FIFO，用于对照实验。 */
  schedulerPolicy?: SchedulerPolicy;
  /** 跨进程取消的数据库轮询间隔；0 关闭。 */
  cancelPollMs?: number;
  /** 同一恢复链允许的最大续跑次数。 */
  maxResumes?: number;
  /** 叶子步骤的进程池；注入后叶子步骤在 Worker 子进程执行，缺省留在本进程。 */
  workerPool?: WorkerPoolLike;
};

export type SchedulerPolicy = "dynamic" | "static";

export type PromptCandidateSignal = {
  workflowId: string;
  runId: string;
  agentId: string;
  patch: string;
  iteration: number;
  scoreBefore?: number;
  scoreAfter?: number;
  source: "model" | "stub";
  baseReleaseId?: string;
};

export class HumanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HumanInputError";
  }
}

export class ApprovalRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRejectedError";
  }
}

export class RunCancelledError extends Error {
  constructor(message = "运行已取消。") {
    super(message);
    this.name = "RunCancelledError";
  }
}

/** 步骤超时。Worker 进程按超时直接终止，避免陈旧调用与新任务在同一进程内并发。 */
class StepTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepTimeoutError";
  }
}

/** 模拟 Worker 被终止：步骤立即失败并进入重试/重派，而不是整单取消。 */
export { WorkerLostError } from "../workers/errors.js";

const ACTIVE_RUN_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "verifying",
  "revising",
  "waiting_approval",
  "waiting_input"
]);

type ResolvedExecutorOptions = Required<
  Omit<
    ExecutorOptions,
    | "onStatusChange"
    | "dimensionScorer"
    | "releaseProvider"
    | "onRunFinished"
    | "onPromptCandidate"
    | "invoker"
    | "scheduler"
    | "workerPool"
  >
> &
  Pick<
    ExecutorOptions,
    "onStatusChange" | "releaseProvider" | "onRunFinished" | "onPromptCandidate"
  >;

type LoopFrame = {  path: string;
  controller: SelfLoopController;
  action: SelfLoopAction;
  actionReason: string;
  issues: string[];
  retrievalQuery?: string;
  directive: Record<string, unknown>;
  agentOverrides: Map<string, string>;
  /** 循环体内的模型覆盖：与 agentOverrides 一样按编译路径生效。 */
  modelOverrides: Map<string, string>;
  currentAgentId?: string;
  previousAgentId?: string;
  currentModelId?: string;
  previousModelId?: string;
  modelSwitches: NonNullable<SelfLoopSummary["modelSwitches"]>;
  /** 循环体内首个 Agent 节点的编译路径；分配与换 Agent 都以 path 为键。 */
  primaryAgentPath?: string;
  /** 进入本轮前的产物、验证分与轮次，供循环体内的 ${loop.*} 引用。 */
  artifact?: unknown;
  score?: number;
  iteration: number;
  startedAt: number;
  tokensAtStart: number;
  /** 最近一次诊断 Agent 的结构化输出；由控制器消费，不作为产物直接暴露给验证器。 */
  diagnosis?: Record<string, unknown>;
  diagnosisSource?: "model" | "stub";
  promptPatch?: string;
  promotionTarget?: string;
  lastPatch?: {
    patch: string;
    source: "model" | "stub";
    iteration: number;
    scoreBefore?: number;
    scoreAfter?: number;
    targetAgentId?: string;
  };
  patchHistory: Array<{
    patch: string;
    source: "model" | "stub";
    iteration: number;
    scoreBefore?: number;
    scoreAfter?: number;
    targetAgentId?: string;
  }>;
};

export type RunState = ExecutionContext & {
  sequence: number;
  tokensUsed: number;
  loops: LoopFrame[];
  loopSummaries: SelfLoopSummary[];
  assignments: Map<string, string>;
  /** 工作流级知识库绑定，工具节点未显式配置检索范围时使用。 */
  workflowKnowledgeBaseIds: string[];
  /** 运行中重调度：给定失败任务与已尝试 Agent，返回下一候选。 */
  reschedule?: (
    taskId: string,
    attemptedAgentIds: string[]
  ) => { agentId: string; agentName: string; score: number; reason: string } | undefined;
  /** 全局队列排序使用的运行级优先档与截止时间。 */
  priorityClass?: number;
  deadlineAt?: string;
  /** 节点结算进度回调，由 run() 注入，子流程共用同一条通道。 */
  onNodeProgress?: (event: WorkflowNodeProgress) => void;
};

/** 检查点里保存的可恢复状态：已结算的顶层节点 + 作用域。 */
type ResumeData = {
  sequence: number;
  iteration: number;
  tokensUsed: number;
  loopSummaries: SelfLoopSummary[];
  assignments: Map<string, string>;
  nodes: Map<string, { status: "succeeded" | "skipped"; output?: unknown }>;
  scope: RunScope;
};

type SimulatedWorker = {
  id: string;
  killed: boolean;
  tasks: Map<string, (error: Error) => void>;
};

type StepWorkerHandle = {
  workerId: string;
  abort: Promise<never>;
  release: () => void;
  /** 进程池句柄才有远程调用；模拟 Worker 为 undefined，仍走本进程 invoker。 */
  invoke?: (step: CompiledStep, input: Record<string, unknown>, state: LeafExecutionState) => Promise<unknown>;
};

type ScopeSnapshot = {  iteration: number;
  score?: number;
  artifact?: unknown;
  artifactNodeId?: string;
  issues?: string[];
  confidence?: number;
  passed?: boolean;
  layers?: VerifyLayers;
  outputs: Map<string, unknown>;
  evidence: string[];
};

/**
 * 运行时骨架：按编译计划执行、落库 trace，并负责状态机、单步超时、指数退避重试与失败快照回滚。
 * 未注入 handler 时使用确定性 stub，输出带 mode: "stub"，供联调主链路；真实 Agent 由 T1.3 注册中心接入。
 */
export class WorkflowExecutor {
  private readonly mode: RunMode;
  private readonly options: ResolvedExecutorOptions;
  private readonly injectedFailures: Set<string>;
  private readonly verifier: LayeredVerifier;
  private readonly approvals = new ApprovalGate();
  private readonly humans = new HumanGate();
  private readonly cancelledRuns = new Set<string>();
  /** 本进程内正在执行的运行，孤儿回收据此避免重复入队。 */
  private readonly activeRuns = new Set<string>();
  /** 每个运行当前占用的 Worker；跨进程取消时用于终止在飞执行。 */
  private readonly runWorkers = new Map<string, Set<string>>();
  private cancelWatcher?: ReturnType<typeof setInterval>;
  private readonly simulatedWorkers = new Map<string, SimulatedWorker>();
  private workerSequence = 0;
  /** 当前进程的执行者标识；多 Worker 部署时用 PLATFORM_WORKER_ID 覆盖。 */
  private readonly workerId = process.env.PLATFORM_WORKER_ID?.trim() || `${hostname()}:${process.pid}`;
  private readonly leaseTtlMs = clampInt(envInt("PLATFORM_LEASE_TTL_MS", 30000), 1000, 600000);
  /** Agent 并发容量只用于调度打分；租约是观测性的，不会因超容量而阻塞。 */
  private readonly agentCapacity = clampInt(envInt("PLATFORM_AGENT_CAPACITY", 1), 1, 64);
  /** 叶子步骤执行边界；默认进程内执行，Worker Pool 接入后替换为远程实现。 */
  private readonly invoker: StepInvoker;
  /** 全局调度：同一执行器内的多个运行共享队列与并发槽位。 */
  private readonly scheduler: SchedulerService;
  /** 叶子步骤的真实 Worker 进程池；为空时留在本进程执行。 */
  private readonly workerPool?: WorkerPoolLike;

  constructor(
    private readonly store: PlatformStateStore,
    private readonly handlers: ExecutorHandlers = {},
    options: ExecutorOptions = {}
  ) {
    this.mode = handlers.agent || handlers.llm || handlers.tool || handlers.verify ? "live" : "stub";
    this.options = resolveExecutorOptions(options);
    this.invoker =
      options.invoker ?? new InlineStepInvoker((step, input, state) => this.invoke(step, input, state));
    this.workerPool = options.workerPool;
    this.scheduler =
      options.scheduler ??
      new SchedulerService(this.store, {
        capacity: this.options.schedulerCapacity,
        workerId: `${this.workerId}:inline`,
        selection: this.options.schedulerPolicy === "static" ? "fifo" : "priority"
      });
    this.injectedFailures = new Set(
      (process.env.PLATFORM_FAIL_NODE_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    );
    // stub 模式只按产物内容打分，不按轮次抬分；接入真实 Agent 后使用注入的验证打分器。
    this.verifier = new LayeredVerifier(
      this.mode === "stub"
        ? stubDimensionScorer
        : (options.dimensionScorer ?? heuristicDimensionScorer)
    );
    this.startCancelWatcher();
  }

  /**
   * 取消请求落库后由本进程轮询；跨实例部署时，执行进程不是接收 API 的进程，
   * 只能靠数据库标志发现取消。定时器 unref，不阻塞进程退出。
   */
  private startCancelWatcher() {
    if (this.options.cancelPollMs <= 0 || this.cancelWatcher) {
      return;
    }
    this.cancelWatcher = setInterval(() => this.pollCrossProcessCancels(), this.options.cancelPollMs);
    this.cancelWatcher.unref?.();
  }

  private pollCrossProcessCancels() {
    for (const runId of this.activeRuns) {
      if (this.cancelledRuns.has(runId)) {
        continue;
      }
      if (!this.store.isRunCancelRequested(runId)) {
        continue;
      }
      this.interruptRun(runId, "检测到跨进程取消请求。");
    }
  }

  /** 标记取消、撤销队列任务，并终止该运行正在使用的 Worker。 */
  private interruptRun(runId: string, reason: string) {
    if (this.cancelledRuns.has(runId)) {
      return;
    }
    this.cancelledRuns.add(runId);
    this.scheduler.cancelRun(runId, reason);
    for (const workerId of this.runWorkers.get(runId) ?? []) {
      this.killWorker(workerId);
    }
    const run = this.store.getRun(runId);
    if (run?.status === "waiting_approval") {
      for (const approval of this.store.listApprovals({ runId, status: "pending" })) {
        if (this.approvals.has(approval.id)) {
          this.approvals.decide(approval.id, "rejected", "system", "运行已取消。");
        }
      }
    }
    if (run?.status === "waiting_input") {
      for (const interaction of this.store.listInteractions({ runId, status: "pending" })) {
        if (this.humans.has(interaction.id)) {
          this.humans.cancel(interaction.id);
        }
      }
    }
  }

  runtimeConfig() {
    return {
      mode: this.mode,
      maxAttempts: this.options.maxAttempts,
      timeoutMs: this.options.timeoutMs,
      retryBaseDelayMs: this.options.retryBaseDelayMs,
      retryMaxDelayMs: this.options.retryMaxDelayMs,
      maxConcurrency: this.options.maxConcurrency,
      schedulerCapacity: this.options.schedulerCapacity,
      schedulerPolicy: this.options.schedulerPolicy,
      cancelPollMs: this.options.cancelPollMs,
      maxResumes: this.options.maxResumes,
      workerPoolSize: this.workerPool?.size ?? 0,
      workerPoolLane: this.workerPool?.lane,
      rollbackOnFailure: this.options.rollbackOnFailure,
      approvalTimeoutMs: this.options.approvalTimeoutMs,
      humanTimeoutMs: this.options.humanTimeoutMs,
      workerId: this.workerId,
      leaseTtlMs: this.leaseTtlMs,
      agentCapacity: this.agentCapacity
    };
  }

  /**
   * 子流程定义优先取冻结发布里的副本；没有发布时回落到平台台账，
   * 保证保存/运行/重跑使用同一套引用解析。
   */
  private compile(workflow: WorkflowDefinition, frozen?: Map<string, WorkflowDefinition>) {
    return compileWorkflow(workflow, {
      resolveWorkflow: (id, version) => {
        const released = frozen?.get(id);
        if (released && (version === undefined || released.version === version)) {
          return released;
        }
        return this.store.getWorkflow(id, version)?.definition;
      }
    });
  }

  /** 发布快照里的 Agent 优先；缺失时回落到实时注册中心。 */
  private releaseAgents(
    state: Pick<ExecutionContext, "agentSnapshots">,
    fallback: AgentRecord[]
  ): AgentRecord[] {
    return state.agentSnapshots ? [...state.agentSnapshots.values()] : fallback;
  }

  private resolveRelease(releaseId: string | undefined, workflowId: string): ResolvedRelease | undefined {
    if (!releaseId) {
      return undefined;
    }
    const release = this.options.releaseProvider?.resolveRelease(releaseId);
    if (!release) {
      throw new PlatformError(`发布「${releaseId}」不存在或不可用于运行。`, 404);
    }
    if (release.workflow.id !== workflowId) {
      throw new PlatformError(
        `发布「${releaseId}」属于工作流「${release.workflow.id}」，不能用于「${workflowId}」。`,
        400
      );
    }
    return release;
  }

  /**
   * 取消运行：标记后在下一条语句边界停止；审批等待点会被立即唤醒。
   * 无法中断已经发出的单步调用，但不会再继续执行后续节点。
   */
  cancelRun(runId: string): RunRecord {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new PlatformError("运行记录不存在。", 404);
    }
    if (!isActiveStatus(run.status)) {
      throw new PlatformError(`运行已结束（${run.status}），不能取消。`, 409);
    }
    this.store.requestRunCancel(runId);
    // 尚未开始的任务立即退出队列；已在执行的步骤在下一条语句边界停止。
    this.interruptRun(runId, "运行已取消，未再调度。");
    return this.store.getRun(runId)!;
  }

  /**
   * 人工输入 API 入口：校验待输入状态与字段，唤醒挂起的运行。
   * 提交后运行继续执行，调用方可轮询 trace 等待下一次暂停或终态。
   */
  respondInteraction(
    interactionId: string,
    input: { values: Record<string, unknown>; actor?: string }
  ): InteractionRecord {
    const interaction = this.store.getInteraction(interactionId);
    if (!interaction) {
      throw new PlatformError("人工输入任务不存在。", 404);
    }
    if (interaction.status !== "pending") {
      throw new PlatformError(`该输入任务已处理（${interaction.status}），不能重复提交。`, 409);
    }
    if (!this.humans.has(interactionId)) {
      throw new PlatformError("人工输入等待点已失效（服务可能已重启），请重新运行工作流。", 409);
    }
    const values = normalizeHumanResponse(interaction.fields, input.values);
    this.humans.answer(interactionId, values, input.actor?.trim());
    return interaction;
  }

  /** 审批 API 入口：校验待审状态后唤醒挂起的运行；驳回必须带意见。 */
  decideApproval(
    approvalId: string,
    input: { decision: ApprovalDecision; reviewer?: string; comment?: string }
  ): ApprovalRecord {
    const approval = this.store.getApproval(approvalId);
    if (!approval) {
      throw new PlatformError("审批记录不存在。", 404);
    }
    if (approval.status !== "pending") {
      throw new PlatformError(`该审批已处理（${approval.status}），不能重复提交。`, 409);
    }
    const comment = input.comment?.trim();
    if (input.decision === "rejected" && !comment) {
      throw new PlatformError("驳回时必须填写审批意见。", 400);
    }
    if (!this.approvals.has(approvalId)) {
      throw new PlatformError("审批等待点已失效（服务可能已重启），请重新运行工作流。", 409);
    }
    this.approvals.decide(approvalId, input.decision, input.reviewer?.trim(), comment);
    return approval;
  }

  async run(
    workflow: WorkflowDefinition,
    input: Record<string, unknown> = {},
    options: RunOptions = {}
  ): Promise<PlatformRunView> {
    const { run, plan, schedule, release, agents } = this.prepare(workflow, input, options);
    await this.execute(
      plan,
      run.id,
      input,
      assignmentsOf(schedule),
      options.stopAfter,
      (taskId, attempted) =>
        replanForTask(schedule, taskId, attempted, agents, this.schedulerLoads()),
      {
        release,
        agents,
        experimentId: options.experimentId,
        arm: options.arm,
        onNodeProgress: options.onNodeProgress
      }
    );
    return { run: this.store.getRun(run.id)!, steps: this.store.listSteps(run.id) };
  }

  /**
   * 异步启动：返回刚落库的 running 记录，执行在后台继续，供监控台轮询 trace。
   * 同步调用方仍可用 run() 拿完整结果。
   */
  start(workflow: WorkflowDefinition, input: Record<string, unknown> = {}, options: RunOptions = {}) {
    const { run, plan, schedule, release, agents } = this.prepare(workflow, input, options);
    void this.execute(
      plan,
      run.id,
      input,
      assignmentsOf(schedule),
      options.stopAfter,
      (taskId, attempted) =>
        replanForTask(schedule, taskId, attempted, agents, this.schedulerLoads()),
      {
        release,
        agents,
        experimentId: options.experimentId,
        arm: options.arm,
        onNodeProgress: options.onNodeProgress
      }
    ).catch(() => {
      // execute 内部已把失败写回 run，这里只负责吞掉 fire-and-forget 的 rejection。
    });
    return run;
  }

  /**
   * 从最新检查点续跑：原运行（若仍在执行）标记失败，新建一条运行只执行未完成节点。
   * 已完成的顶层节点直接回放产物，不会重复调用 Agent 或工具。
   */
  async resumeRun(runId: string, options: RunOptions = {}): Promise<PlatformRunView> {
    const started = this.beginResume(runId, options);
    await started.done;
    return {
      run: this.store.getRun(started.run.id)!,
      steps: this.store.listSteps(started.run.id)
    };
  }

  /** 异步续跑：返回新运行记录，执行在后台继续。 */
  startResume(runId: string, options: RunOptions = {}) {
    return this.beginResume(runId, options).run;
  }

  private beginResume(runId: string, options: RunOptions) {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new PlatformError("运行记录不存在。", 404);
    }
    const checkpoint = this.store.latestRunCheckpoint(runId);
    if (!checkpoint) {
      throw new PlatformError("该运行没有可恢复的检查点。", 409);
    }
    const resume = parseCheckpointState(checkpoint.state);
    if (!resume) {
      throw new PlatformError("检查点格式不受支持，无法恢复。", 409);
    }
    const runNodes = this.store.listRunNodes(runId);
    if (
      runNodes.length > 0 &&
      runNodes.every((node) => node.status === "succeeded" || node.status === "skipped")
    ) {
      throw new PlatformError("该运行的所有节点都已完成，无需从检查点恢复。", 409);
    }
    const resumeCount = (run.resumeCount ?? 0) + 1;
    if (resumeCount > this.options.maxResumes) {
      throw new PlatformError(`同一恢复链的续跑次数已达上限（${this.options.maxResumes}）。`, 409);
    }
    const definition =
      run.definition ?? this.store.getWorkflow(run.workflowId, run.workflowVersion)?.definition;
    if (!definition) {
      throw new PlatformError("运行缺少 DSL 快照，无法恢复。", 409);
    }
    if (ACTIVE_RUN_STATUSES.has(run.status)) {
      for (const approval of this.store.listApprovals({ runId, status: "pending" })) {
        this.store.decideApproval(approval.id, "rejected", "system", "运行已从检查点恢复。");
      }
      for (const interaction of this.store.listInteractions({ runId, status: "pending" })) {
        this.store.decideInteraction(interaction.id, "cancelled");
      }
      for (const step of this.store.listSteps(runId)) {
        if (step.status === "running" || step.status === "waiting") {
          this.store.completeStep(step.id, "failed", undefined, "运行已从检查点恢复。", {
            attempts: step.attempts
          });
        }
      }
      this.store.finishRun(runId, "failed", undefined, `已从检查点 #${checkpoint.sequence} 恢复。`);
    }
    const prepared = this.prepare(definition, run.input, {
      ...options,
      releaseId: options.releaseId ?? run.releaseId,
      experimentId: options.experimentId ?? run.experimentId,
      arm: (options.arm ?? run.arm) as RunOptions["arm"],
      priorityClass: options.priorityClass ?? run.priorityClass,
      deadlineAt: options.deadlineAt ?? run.deadlineAt
    });
    this.store.setRunResumeCount(prepared.run.id, resumeCount);
    this.store.updateRunSchedulerState(prepared.run.id, "resumed");
    const done = this.execute(
      prepared.plan,
      prepared.run.id,
      run.input,
      assignmentsOf(prepared.schedule),
      options.stopAfter,
      (taskId, attempted) =>
        replanForTask(prepared.schedule, taskId, attempted, prepared.agents, this.schedulerLoads()),
      {
        release: prepared.release,
        agents: prepared.agents,
        experimentId: prepared.run.experimentId,
        arm: prepared.run.arm,
        onNodeProgress: options.onNodeProgress
      },
      resume
    );
    void done.catch(() => {
      // execute 已把失败写回运行记录，避免后台续跑的 rejection 变成未处理异常。
    });
    return { run: prepared.run, done };
  }

  /**
   * 单步重跑：用同一路径与已解析输入重新执行一次，追加新的步骤记录。
   * 不改变原运行的最终状态，也不向下游传播结果——监控台已标注这一点。
   */
  async retryStep(runId: string, stepId: string): Promise<StepRecord> {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new PlatformError("运行记录不存在。", 404);
    }
    const original = this.store.getStep(stepId);
    if (!original || original.runId !== runId) {
      throw new PlatformError("执行步骤不存在。", 404);
    }
    const stored = this.store.getWorkflow(run.workflowId, run.workflowVersion);
    // 新运行带 DSL 快照，重跑必须按当时的定义执行；旧运行才回落到版本表。
    const definition = run.definition ?? stored?.definition;
    if (!definition) {
      throw new PlatformError("运行对应的工作流版本不存在。", 404);
    }
    const release = this.resolveRelease(run.releaseId, run.workflowId);
    const frozenWorkflows = release?.workflows;
    const plan = this.compile(release?.workflow ?? definition, frozenWorkflows);
    const compiled =
      plan.steps.find((step) => step.path === original.path) ??
      plan.steps.find((step) => step.nodeId === original.nodeId);
    if (!compiled) {
      throw new PlatformError("该步骤不在工作流编译计划中，无法单步重跑。", 400);
    }
    if (compiled.node.kind === "approve") {
      throw new PlatformError("人工审批步骤不支持单步重跑，请整单重跑后重新审批。", 400);
    }
    if (compiled.node.kind === "human") {
      throw new PlatformError("人工交互步骤不支持单步重跑，请重新发起训练。", 400);
    }
    if (compiled.node.kind === "extract") {
      throw new PlatformError("参数提取步骤会等待用户补充参数，不支持单步重跑，请重新发起运行。", 400);
    }

    const input = isRecord(original.input) ? original.input : {};
    const previousVerifications = this.store.listVerifyResults(runId);
    // 单步重跑不重放上游，从已完成步骤的产物里恢复证据池，避免 verify 重跑时证据丢失。
    const previousSteps = this.store.listSteps(runId);
    const state: RunState = {
      runId,
      workflowId: run.workflowId,
      iteration: 0,
      sequence: this.store.nextSequence(runId),
      tokensUsed: 0,
      loops: [],
      loopSummaries: [],
      assignments: assignmentsOf(run.plan),
      workflowKnowledgeBaseIds: definition.knowledgeBaseIds ?? [],
      ...(release
        ? {
            agentSnapshots: new Map(release.agents.map((agent) => [agent.id, agent])),
            release: {
              releaseId: release.manifest.id,
              experimentId: run.experimentId,
              arm: run.arm
            }
          }
        : {}),
      scope: {
        input: run.input,
        outputs: new Map(),
        evidence: mergeEvidence(previousSteps.flatMap((step) => collectCitations(step.output))),
        verifyRounds: previousVerifications.length,
        lastVerifyScore: previousVerifications[previousVerifications.length - 1]?.score,
        lastVerifyIssues: previousVerifications[previousVerifications.length - 1]?.issues
      }
    };
    const retryStepId = this.store.beginStep({
      runId,
      sequence: state.sequence,
      path: original.path,
      nodeId: original.nodeId,
      nodeKind: original.nodeKind,
      input
    });

    await this.runStepBody(compiled, input, state, retryStepId);
    return this.store.getStep(retryStepId)!;
  }

  /** 真实在飞租约 + 可配置容量，供运行前规划与失败重调度共用。 */
  private schedulerLoads(): Record<string, { inFlight: number; capacity: number }> {
    const loads = this.store.activeLeaseLoads();
    return Object.fromEntries(
      Object.entries(loads).map(([agentId, load]) => [
        agentId,
        { inFlight: load.inFlight, capacity: this.agentCapacity }
      ])
    );
  }

  /** 执行叶子步骤的 Worker 池：接进程池时返回真实子进程，否则返回本进程模拟 Worker。 */
  listWorkers(): Array<{
    id: string;
    killed: boolean;
    activeTasks: string[];
    pid?: number;
    slot?: number;
    status?: SchedulerWorkerStatus;
  }> {
    if (this.workerPool) {
      return this.workerPool.listWorkers();
    }
    return [...this.simulatedWorkers.values()].map((worker) => ({
      id: worker.id,
      killed: worker.killed,
      activeTasks: [...worker.tasks.keys()]
    }));
  }

  /** 全局调度快照：跨运行队列、当前在飞任务与有效优先级，供监控台展示。 */
  schedulerSnapshot() {
    return this.scheduler.snapshot();
  }

  killWorker(workerId: string) {
    if (this.workerPool) {
      return this.workerPool.killWorker(workerId);
    }
    const worker = this.simulatedWorkers.get(workerId);
    if (!worker || worker.killed) {
      return { workerId, killed: false, aborted: 0 };
    }
    worker.killed = true;
    const tasks = [...worker.tasks.entries()];
    worker.tasks.clear();
    for (const [taskKey, reject] of tasks) {
      reject(new WorkerLostError(`Worker ${workerId} 被终止，${taskKey} 将重新调度。`));
    }
    return { workerId, killed: true, aborted: tasks.length };
  }

  /**
   * 孤儿回收：租约过期说明 Worker 已失联。单进程内不会发生“本进程还活着但租约过期”，
   * 因此把非本进程执行的运行标记失败，并用 DSL 快照重新入队。
   */
  /** 由周期回收器调用：清掉本进程队列里已过期的认领并放回待调度。 */
  reclaimSchedulerTasks() {
    return this.scheduler.reclaim();
  }

  async requeueOrphanedRuns(options: { wait?: boolean } = {}) {
    const expired = this.store.expireSchedulerLeases();
    const leases = this.store.listSchedulerLeases({ status: "expired", limit: 200 });
    const runIds = [...new Set(leases.map((lease) => lease.runId))];
    const requeued: Array<{
      previousRunId: string;
      runId: string;
      resumed: boolean;
      checkpointSequence?: number;
    }> = [];
    const skipped: Array<{ runId: string; reason: string }> = [];
    for (const runId of runIds) {
      if (this.activeRuns.has(runId)) {
        skipped.push({ runId, reason: "本进程仍在执行该运行。" });
        continue;
      }
      const run = this.store.getRun(runId);
      if (!run) {
        skipped.push({ runId, reason: "运行记录不存在。" });
        continue;
      }
      if (!ACTIVE_RUN_STATUSES.has(run.status)) {
        skipped.push({ runId, reason: `运行已是终态（${run.status}）。` });
        continue;
      }
      if (!run.definition) {
        skipped.push({ runId, reason: "缺少 DSL 快照，无法自动重建。" });
        continue;
      }
      const checkpoint = this.store.latestRunCheckpoint(runId);
      const message = checkpoint
        ? `Worker 失联：租约过期，运行从检查点 #${checkpoint.sequence} 恢复。`
        : "Worker 失联：租约过期，运行已重新入队。";
      for (const step of this.store.listSteps(runId)) {
        if (step.status === "running") {
          this.store.completeStep(step.id, "failed", undefined, message, { attempts: step.attempts });
        }
      }
      this.store.finishRun(runId, "failed", undefined, message);
      const runOptions: RunOptions = {
        releaseId: run.releaseId,
        experimentId: run.experimentId,
        arm: run.arm as RunOptions["arm"],
        priorityClass: run.priorityClass,
        deadlineAt: run.deadlineAt
      };
      if (checkpoint) {
        const started = this.startResume(runId, runOptions);
        if (options.wait !== false) {
          await this.waitForRun(started.id);
        }
        requeued.push({
          previousRunId: runId,
          runId: started.id,
          resumed: true,
          checkpointSequence: checkpoint.sequence
        });
      } else if (options.wait === false) {
        const started = this.start(run.definition, run.input, runOptions);
        requeued.push({ previousRunId: runId, runId: started.id, resumed: false });
      } else {
        const next = await this.run(run.definition, run.input, runOptions);
        requeued.push({ previousRunId: runId, runId: next.run.id, resumed: false });
      }
    }
    return { expired, requeued, skipped };
  }

  /** 测试与恢复器等待后台运行到终态；0 间隔轮询，避免引入额外依赖。 */
  async waitForRun(runId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = this.store.getRun(runId);
      if (!run) {
        return undefined;
      }
      if (!ACTIVE_RUN_STATUSES.has(run.status)) {
        return run;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.store.getRun(runId);
  }

  private acquireWorker(taskKey: string) {
    let worker = [...this.simulatedWorkers.values()]
      .filter((item) => !item.killed)
      .sort((left, right) => left.tasks.size - right.tasks.size || left.id.localeCompare(right.id))[0];
    if (!worker) {
      worker = {
        id: `${this.workerId}#w${(this.workerSequence += 1)}`,
        killed: false,
        tasks: new Map()
      };
      this.simulatedWorkers.set(worker.id, worker);
    }
    let rejectTask: (error: Error) => void = () => {};
    const abort = new Promise<never>((_resolve, reject) => {
      rejectTask = reject;
    });
    worker.tasks.set(taskKey, rejectTask);
    return {
      workerId: worker.id,
      abort,
      release: () => {
        worker!.tasks.delete(taskKey);
      }
    };
  }

  private prepare(workflow: WorkflowDefinition, input: Record<string, unknown>, options: RunOptions = {}) {
    const release = this.resolveRelease(options.releaseId, workflow.id);
    const effectiveWorkflow = release?.workflow ?? workflow;
    const frozenWorkflows = release?.workflows;
    const plan = this.compile(effectiveWorkflow, frozenWorkflows);
    const missing = effectiveWorkflow.inputs
      .filter((variable) => variable.required && input[variable.name] === undefined)
      .map((variable) => variable.name);
    if (missing.length > 0) {
      throw new PlatformError(`缺少必填输入：${missing.join("、")}`, 400);
    }
    if (options.stopAfter && !effectiveWorkflow.nodes.some((node) => node.id === options.stopAfter)) {
      throw new PlatformError(`stopAfter 只能指向顶层节点：${options.stopAfter}`, 400);
    }

    const agents = release
      ? this.scopeReleasedAgents(effectiveWorkflow, release.agents)
      : this.scopedAgents(effectiveWorkflow);
    const schedule = buildWorkflowSchedule(plan, agents, this.schedulerLoads());
    const run = this.store.createRun({
      workflowId: effectiveWorkflow.id,
      workflowVersion: effectiveWorkflow.version,
      workflowInput: input,
      mode: this.mode,
      status: "queued",
      plan: schedule,
      definition: effectiveWorkflow,
      releaseId: release?.manifest.id,
      experimentId: options.experimentId,
      arm: options.arm,
      priorityClass: options.priorityClass,
      deadlineAt: options.deadlineAt
    });
    this.options.onStatusChange?.(run.id, "queued");
    options.onCreated?.(run);
    return { run, plan, schedule, release, agents };
  }

  /** 发布运行仍遵守工作流声明的团队范围，但候选池来自冻结快照。 */
  private scopeReleasedAgents(workflow: WorkflowDefinition, agents: AgentRecord[]): AgentRecord[] {
    if (!workflow.teamId) {
      return agents;
    }
    const team = this.store.getTeam(workflow.teamId);
    if (!team) {
      throw new PlatformError(`工作流绑定的团队「${workflow.teamId}」不存在。`, 400);
    }
    const allowed = new Set(team.agentIds);
    return agents.filter((agent) => allowed.has(agent.id));
  }

  /**
   * 跨运行记忆只在 Agent 显式配置 memory.persist=true 时启用；
   * retain 指定要保留的输出字段，recall 控制注入条数。
   */
  private memoryConfigOf(agentId: string, state?: Pick<ExecutionContext, "agentSnapshots">) {
    const memory = (state?.agentSnapshots?.get(agentId) ?? this.store.getAgent(agentId))?.memory;
    if (!isRecord(memory) || memory.persist !== true) {
      return undefined;
    }
    const retain = Array.isArray(memory.retain)
      ? memory.retain.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [];
    if (retain.length === 0) {
      return undefined;
    }
    const recall = Number(memory.recall ?? 5);
    const maxEntries = Number(memory.maxEntries ?? 3);
    return {
      retain,
      recall: Number.isFinite(recall) ? Math.max(1, Math.trunc(recall)) : 5,
      maxEntries: Number.isFinite(maxEntries) ? Math.max(1, Math.trunc(maxEntries)) : 3
    };
  }

  private persistAgentMemory(
    step: CompiledStep,
    workflowId: string,
    output: unknown,
    state?: Pick<ExecutionContext, "agentSnapshots">
  ) {
    if (step.node.kind !== "agent") {
      return;
    }
    const config = this.memoryConfigOf(step.node.agent, state);
    if (!config) {
      return;
    }
    const source = isRecord(output) && isRecord(output.output) ? output.output : output;
    if (!isRecord(source)) {
      return;
    }
    for (const key of config.retain) {
      const value = source[key];
      if (value === undefined || value === null) {
        continue;
      }
      const text = (typeof value === "string" ? value : JSON.stringify(value)).trim();
      if (!text) {
        continue;
      }
      this.store.appendAgentMemory({
        agentId: step.node.agent,
        workflowId,
        key,
        value: text.slice(0, 2000),
        maxEntries: config.maxEntries
      });
    }
  }

  /** 工作流声明 teamId 时只允许该团队的 Agent 参与调度；未声明的流程保持全局池。 */
  private scopedAgents(workflow: WorkflowDefinition) {
    const agents = this.store.listAgents();
    if (!workflow.teamId) {
      return agents;
    }
    const team = this.store.getTeam(workflow.teamId);
    if (!team) {
      throw new PlatformError(`工作流绑定的团队「${workflow.teamId}」不存在。`, 400);
    }
    const allowed = new Set(team.agentIds);
    return agents.filter((agent) => allowed.has(agent.id));
  }

  private async execute(
    plan: ReturnType<typeof compileWorkflow>,
    runId: string,
    input: Record<string, unknown>,
    assignments: Map<string, string>,
    stopAfter?: string,
    reschedule?: RunState["reschedule"],
    release?: {
      release?: ResolvedRelease;
      agents: AgentRecord[];
      experimentId?: string;
      arm?: string;
      onNodeProgress?: (event: WorkflowNodeProgress) => void;
    },
    resume?: ResumeData
  ) {
    const runRecord = this.store.getRun(runId);
    const state: RunState = {
      runId,
      workflowId: plan.workflow.id,
      iteration: resume?.iteration ?? 0,
      sequence: resume?.sequence ?? 0,
      tokensUsed: resume?.tokensUsed ?? 0,
      loops: [],
      loopSummaries: resume?.loopSummaries ?? [],
      assignments: resume?.assignments ?? assignments,
      reschedule,
      workflowKnowledgeBaseIds: plan.workflow.knowledgeBaseIds ?? [],
      ...(runRecord?.priorityClass !== undefined ? { priorityClass: runRecord.priorityClass } : {}),
      ...(runRecord?.deadlineAt !== undefined ? { deadlineAt: runRecord.deadlineAt } : {}),
      onNodeProgress: release?.onNodeProgress,
      scope: resume?.scope ?? { input, outputs: new Map(), evidence: [], verifyRounds: 0 },
      ...(release?.release
        ? {
            agentSnapshots: new Map(release.agents.map((agent) => [agent.id, agent])),
            release: {
              releaseId: release.release.manifest.id,
              experimentId: release.experimentId,
              arm: release.arm
            }
          }
        : {})
    };
    // 恢复运行的作用域输入以本次运行的输入为准，其余产物来自检查点。
    state.scope.input = input;

    this.activeRuns.add(runId);
    this.setStatus(runId, "running");
    this.store.updateRunSchedulerState(runId, "running");
    try {
      await this.executeRoot(plan, state, stopAfter, resume);
      this.throwIfCancelled(runId);
      this.finish(runId, "succeeded", {
        mode: this.mode,
        score: state.scope.lastVerifyScore,
        stepCount: state.sequence,
        tokensUsed: state.tokensUsed,
        tokenBudget: this.options.tokenBudget,
        budgetExceeded:
          this.options.tokenBudget > 0 && state.tokensUsed >= this.options.tokenBudget,
        ...(stopAfter ? { stoppedAfter: stopAfter } : {}),
        verify: {
          score: state.scope.lastVerifyScore,
          confidence: state.scope.lastVerifyConfidence,
          passed: state.scope.lastVerifyPassed,
          layers: state.scope.lastVerifyLayers
        },
        selfLoop: state.loopSummaries
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 取消优先于其他异常：即使取消正好落在审批驳回路径上，终态也应是 cancelled。
      if (error instanceof RunCancelledError || this.cancelledRuns.has(runId)) {
        this.finish(runId, "cancelled", undefined, message);
        return;
      }
      // 审批驳回/超时、人工输入超时是明确终态，不应被失败快照回滚成 rolled_back。
      if (error instanceof ApprovalRejectedError || error instanceof HumanInputError) {
        this.finish(runId, "failed", undefined, message);
        return;
      }
      if (this.rollbackToSnapshot(runId, state, message)) {
        return;
      }
      this.finish(runId, "failed", undefined, message);
    } finally {
      this.activeRuns.delete(runId);
      this.runWorkers.delete(runId);
      this.scheduler.completeRun(runId);
      // 兜底回收：正常路径逐步骤释放租约，这里清掉异常退出可能遗留的整单租约。
      this.store.releaseRunSchedulerLeases(runId, "run_finished");
    }
  }

  /**
   * 顶层按依赖就绪度调度：无入边或所有上游已解析的节点进入就绪队列，最多并发 maxConcurrency 个。
   * 边条件在汇合点求值；所有入边都未激活时节点标记 skipped 并继续向下游传播。
   * 容器、审批与验证会改写共享运行态，通过读写锁独占执行，避免与并发分支交错。
   */
  private async executeRoot(plan: CompiledPlan, state: RunState, stopAfter?: string, resume?: ResumeData) {
    const statements = new Map<string, CompiledStatement>();
    for (const statement of plan.program) {
      statements.set(statementNodeId(statement), statement);
    }

    const nodeIds = plan.graph.nodes.length > 0 ? plan.graph.nodes : plan.order;
    const nodeSet = new Set(nodeIds);
    const incoming = new Map<string, number[]>();
    const outgoing = new Map<string, number[]>();
    for (const nodeId of nodeIds) {
      incoming.set(nodeId, []);
      outgoing.set(nodeId, []);
    }
    plan.graph.edges.forEach((edge, index) => {
      if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) {
        return;
      }
      incoming.get(edge.to)!.push(index);
      outgoing.get(edge.from)!.push(index);
    });

    const pending = new Map<string, number>(
      nodeIds.map((nodeId) => [nodeId, incoming.get(nodeId)!.length])
    );
    const edgeResolved = new Array<boolean>(plan.graph.edges.length).fill(false);
    const edgeSourceSucceeded = new Array<boolean>(plan.graph.edges.length).fill(false);
    // 选项卡这类「一个选项一个端口」的节点：一旦有端口连线，未绑端口的出边就不再无条件放行。
    // 老流程的边没有端口（都从卡片同一个点拉出来），先看边上的「选项 == 文本」条件落位，
    // 条件也没写的才按数量顺序补，具体规则见 workflow/choicePorts.ts。
    const choiceOptions = new Map<string, string[]>();
    for (const node of plan.workflow.nodes) {
      if (node.kind !== "human" || node.optionsFrom) {
        continue;
      }
      const options = normalizeChoices(node.options ?? []);
      if (options.length > 0) {
        choiceOptions.set(node.id, options);
      }
    }
    const inferredPorts = inferChoicePorts(
      plan.graph.edges.map((edge, index) => ({
        from: edge.from,
        fromPort: edge.fromPort,
        choiceValue: choiceConditionValue(plan.graph.edges[index])
      })),
      choiceOptions
    );
    // 记下每个节点「哪些端口真的接了线」：命中项的端口没接线时要回落到兜底口，
    // 只看「有没有端口」不够，得知道具体接了哪几个。
    const wiredPorts = new Map<string, Set<string>>();
    plan.graph.edges.forEach((edge, index) => {
      const port = edge.fromPort ?? inferredPorts.get(index);
      if (!port || !nodeSet.has(edge.from)) {
        return;
      }
      const ports = wiredPorts.get(edge.from) ?? new Set<string>();
      ports.add(port);
      wiredPorts.set(edge.from, ports);
    });
    const outgoingNodes = new Map<string, string[]>(nodeIds.map((nodeId) => [nodeId, []]));
    for (const edge of plan.graph.edges) {
      if (nodeSet.has(edge.from) && nodeSet.has(edge.to)) {
        outgoingNodes.get(edge.from)!.push(edge.to);
      }
    }
    // 队列优先级取“到汇点的最长剩余路径”，比单纯节点顺序更接近关键路径。
    const depthMemo = new Map<string, number>();
    const remainingDepth = (nodeId: string): number => {
      const cached = depthMemo.get(nodeId);
      if (cached !== undefined) {
        return cached;
      }
      const children = outgoingNodes.get(nodeId) ?? [];
      const depth = children.length === 0 ? 0 : 1 + Math.max(...children.map(remainingDepth));
      depthMemo.set(nodeId, depth);
      return depth;
    };
    const maxDepth = Math.max(0, ...nodeIds.map(remainingDepth));
    const priorityOf = (nodeId: string) => {
      const depth = remainingDepth(nodeId);
      return Number((maxDepth === 0 ? 1 : 0.5 + (0.5 * depth) / maxDepth).toFixed(4));
    };

    const launched = new Set<string>();
    const inFlight = new Map<string, Promise<void>>();
    const lock = new AsyncReadWriteLock();
    const runInputTokens = estimateTokens(state.scope.input);
    let failure: unknown;
    let stopped = false;

    // 先幂等登记 DAG 节点：监控与恢复阶段直接读这张表，不必从步骤 trace 反推进度。
    this.store.insertRunNodes(
      state.runId,
      nodeIds.map((nodeId) => {
        const statement = statements.get(nodeId);
        return {
          nodeId,
          path: statement ? statementPath(statement) : nodeId,
          status: "pending" as const,
          priority: priorityOf(nodeId)
        };
      })
    );

    const cancelPending = (reason: string) => {
      this.scheduler.cancelRun(state.runId, reason);
    };

    /**
     * 被「条件兄弟」压住的兜底边。
     *
     * 一个节点同时连出「带条件的分支」和「不带条件的主线」时，直觉上应该是二选一：
     * 条件成立走分支，不成立走主线。按边各判各的会变成两条一起跑——
     * 用户画的是分支，看到的是并行，于是后面两条链全亮了。
     * 所以这里统一按「条件优先、无条件兜底」处理，只有所有条件分支都没走通才放行无条件那条。
     * 全都是无条件边、或全都有条件时不干预，正常的并行编排照旧。
     */
    const suppressedEdges = new Set<number>();

    /**
     * 节点被跳过时给一句能对上号的原因。
     * 以前几乎全是「条件未满足」，端口没绑、选项没接线、走了兜底都糊成同一句，
     * 用户看到分支没跑也查不出是连线问题还是选择问题。
     */
    const explainBranchBlock = (candidates: number[]): string => {
      if (candidates.length === 0) {
        return "上游分支未执行。";
      }
      if (candidates.some((index) => suppressedEdges.has(index))) {
        return "同一条分支上已有条件成立，这条兜底线让位了。";
      }
      for (const index of candidates) {
        const candidate = plan.graph.edges[index];
        const port = candidate.fromPort ?? inferredPorts.get(index);
        if (branchAllows(candidate, state.scope, wiredPorts, port)) {
          continue;
        }
        const picked = choiceIndexOf(state.scope, candidate.from);
        if (picked < 0) {
          return "选项卡走了「其他」兜底分支，这条选项分支没有激活。";
        }
        if (!wiredPorts.get(candidate.from)?.has(choicePortOf(picked))) {
          return `选项卡选中的是第 ${picked + 1} 项，但那个选项没有连线，这条分支不会被触发。`;
        }
        if (port === undefined) {
          return "这条连线没有落在选项卡的选项端口上，运行期不会激活它，请在画布上重新从对应选项拉一次线。";
        }
        return "上游选项卡选的是别的选项，这条分支没有激活。";
      }
      return "上游边条件未满足。";
    };

    const resolveOutgoing = (nodeId: string, succeeded: boolean) => {
      const outIndexes = outgoing.get(nodeId) ?? [];
      if (succeeded) {
        const open = outIndexes.map((index) => {
          const edge = plan.graph.edges[index];
          const port = edge.fromPort ?? inferredPorts.get(index);
          return (
            branchAllows(edge, state.scope, wiredPorts, port) &&
            (!edge.when || evaluateExpression(edge.when, state.scope))
          );
        });
        const localSuppressed = suppressedFallbacks(
          outIndexes.map((index) => plan.graph.edges[index]),
          open
        );
        for (const offset of localSuppressed) {
          suppressedEdges.add(outIndexes[offset]);
        }
      }
      for (const edgeIndex of outIndexes) {
        if (edgeResolved[edgeIndex]) {
          continue;
        }
        edgeResolved[edgeIndex] = true;
        edgeSourceSucceeded[edgeIndex] = succeeded;
        const edge = plan.graph.edges[edgeIndex];
        const remaining = (pending.get(edge.to) ?? 1) - 1;
        pending.set(edge.to, remaining);
        if (remaining === 0 && !launched.has(edge.to)) {
          const candidates = (incoming.get(edge.to) ?? []).filter(
            (index) => edgeResolved[index] && edgeSourceSucceeded[index]
          );
          const selected = candidates.filter((index) => {
            const candidate = plan.graph.edges[index];
            const port = candidate.fromPort ?? inferredPorts.get(index);
            if (!branchAllows(candidate, state.scope, wiredPorts, port)) {
              return false;
            }
            if (suppressedEdges.has(index)) {
              return false;
            }
            const condition = candidate.when;
            return !condition || evaluateExpression(condition, state.scope);
          });
          if (selected.length > 0) {
            enqueueNode(edge.to);
          } else {
            skipNode(edge.to, explainBranchBlock(candidates));
          }
        }
      }
    };

    const skipNode = (nodeId: string, reason: string) => {
      if (launched.has(nodeId)) {
        return;
      }
      launched.add(nodeId);
      this.store.setRunNodeStatus(state.runId, nodeId, "skipped", { error: reason });
      this.saveRunCheckpoint(state);
      const statement = statements.get(nodeId);
      if (statement) {
        const stepId = this.store.beginStep({
          runId: state.runId,
          sequence: (state.sequence += 1),
          path: statementPath(statement),
          nodeId,
          nodeKind: statementKind(statement),
          input: { skipped: true, reason }
        });
        this.store.completeStep(stepId, "skipped", { skipped: true, reason }, reason, {
          attempts: 0
        });
      }
      if (stopAfter === nodeId) {
        stopped = true;
      }
      resolveOutgoing(nodeId, false);
    };

    /**
     * 就绪节点交给全局调度服务排队：本方法的 DAG 循环只负责依赖传播，
     * 出队顺序与并发槽位由 SchedulerService 跨运行统一裁决。
     */
    const enqueueNode = (nodeId: string) => {
      if (launched.has(nodeId) || stopped || failure !== undefined) {
        return;
      }
      const statement = statements.get(nodeId);
      if (!statement) {
        skipNode(nodeId, "编译计划缺少该节点。");
        return;
      }
      launched.add(nodeId);
      this.store.setRunNodeStatus(state.runId, nodeId, "ready");
      const node = statement.type === "step" ? statement.step.node : undefined;
      const task = this.scheduler.submit({
        runId: state.runId,
        nodeId,
        path: statementPath(statement),
        kind: statementKind(statement),
        criticalPathDepth: remainingDepth(nodeId),
        maxDepth,
        agentId: node?.kind === "agent" ? node.agent : undefined,
        maxAttempts: this.options.maxAttempts,
        priorityClass: state.priorityClass,
        deadlineAt: state.deadlineAt,
        inputTokens: runInputTokens,
        execute: async () => {
          const lockMode = lockModeForStatement(statement);
          const release = lockMode ? await lock.acquire(lockMode) : undefined;
          try {
            await this.executeStatement(statement, state);
          } finally {
            release?.();
          }
        }
      });
      const settled = task.then(
        () => {
          inFlight.delete(nodeId);
          this.saveRunCheckpoint(state);
          if (stopAfter === nodeId) {
            stopped = true;
            cancelPending("试运行已在目标节点停止。");
            return;
          }
          if (!stopped && failure === undefined) {
            resolveOutgoing(nodeId, true);
          }
        },
        (error) => {
          inFlight.delete(nodeId);
          // 队列层撤销的任务从未开始执行，不构成运行失败。
          if (error instanceof SchedulerTaskCancelledError) {
            return;
          }
          if (failure === undefined) {
            failure = error;
          }
          stopped = true;
          cancelPending(
            error instanceof RunCancelledError || this.cancelledRuns.has(state.runId)
              ? "运行已取消。"
              : "运行失败，未再调度。"
          );
        }
      );
      inFlight.set(nodeId, settled);
    };

    if (resume) {
      // 已结算节点直接恢复为完成态并回放产物，只重新调度检查点之后的节点。
      for (const [nodeId, node] of resume.nodes) {
        if (!nodeSet.has(nodeId)) {
          continue;
        }
        this.store.setRunNodeStatus(state.runId, nodeId, node.status);
        if (node.output !== undefined) {
          state.scope.outputs.set(nodeId, node.output);
        }
        launched.add(nodeId);
      }
      if (stopAfter && resume.nodes.has(stopAfter)) {
        stopped = true;
      }
      if (!stopped) {
        for (const [nodeId, node] of resume.nodes) {
          if (!nodeSet.has(nodeId)) {
            continue;
          }
          resolveOutgoing(nodeId, node.status === "succeeded");
        }
      }
    }

    for (const nodeId of nodeIds) {
      if (pending.get(nodeId) === 0) {
        enqueueNode(nodeId);
      }
    }

    while (inFlight.size > 0) {
      await Promise.race([...inFlight.values()]);
      if (failure !== undefined || stopped || this.cancelledRuns.has(state.runId)) {
        cancelPending(
          this.cancelledRuns.has(state.runId)
            ? "运行已取消。"
            : failure !== undefined
              ? "运行失败，未再调度。"
              : "运行已停止，未再调度。"
        );
      }
    }

    // 取消优先于其他异常：终态由 execute() 统一判定。
    this.throwIfCancelled(state.runId);
    if (failure !== undefined) {
      throw failure;
    }
  }

  /** 每个顶层节点结算后写一份检查点；恢复时只重跑检查点之后的节点。 */
  private saveRunCheckpoint(state: RunState) {
    const settled = this.store
      .listRunNodes(state.runId)
      .filter((node) => node.status === "succeeded" || node.status === "skipped");
    if (settled.length === 0) {
      return;
    }
    const nodes: Record<string, { status: "succeeded" | "skipped"; output?: unknown }> = {};
    for (const node of settled) {
      nodes[node.nodeId] = {
        status: node.status as "succeeded" | "skipped",
        ...(state.scope.outputs.has(node.nodeId)
          ? { output: state.scope.outputs.get(node.nodeId) }
          : {})
      };
    }
    this.store.saveRunCheckpoint({
      runId: state.runId,
      sequence: state.sequence,
      state: {
        version: 1,
        workflowId: state.workflowId,
        sequence: state.sequence,
        iteration: state.iteration,
        tokensUsed: state.tokensUsed,
        loopSummaries: state.loopSummaries,
        assignments: [...state.assignments.entries()],
        nodes,
        scope: serializeRunScope(state.scope)
      }
    });
  }

  private async executeBlock(block: CompiledBlock, state: RunState) {
    for (const statement of block) {
      await this.executeStatement(statement, state);
    }
  }

  private async executeStatement(statement: CompiledStatement, state: RunState) {
    this.throwIfCancelled(state.runId);
    if (statement.type === "step") {
      await this.executeStep(statement.step, state);
      return;
    }
    if (statement.type === "subworkflow") {
      await this.executeSubWorkflow(statement, state);
      return;
    }
    if (statement.type === "parallel") {
      // 等所有分支收敛再抛错，避免失败后仍有分支在后台写 trace。
      const results = await Promise.allSettled(
        statement.branches.map((branch) => this.executeBlock(branch, state))
      );
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      if (rejected) {
        throw rejected.reason;
      }
      return;
    }
    if (statement.type === "condition") {
      const frame = findLoopFrame(state, statement.path);
      const branch = evaluateExpression(statement.when, state.scope, frame)
        ? statement.then
        : statement.otherwise;
      await this.executeBlock(branch, state);
      return;
    }

    await this.executeLoop(statement, state);
  }

  private async executeLoop(
    statement: Extract<CompiledStatement, { type: "loop" }>,
    state: RunState
  ) {
    const threshold = findVerifyThreshold(statement.body) ?? 0.8;
    const primaryAgent = findFirstAgentStep(statement.body);
    const initialScore = state.scope.lastVerifyScore;
    const primaryAgentId =
      primaryAgent && primaryAgent.node.kind === "agent"
        ? (state.assignments.get(primaryAgent.path) ?? primaryAgent.node.agent)
        : undefined;
    // 循环的“当前模型”取节点覆盖优先，其次 Agent 注册记录，最后平台默认。
    const primaryModelId =
      primaryAgent && primaryAgent.node.kind === "agent"
        ? primaryAgent.node.model?.trim() ||
          (primaryAgentId
            ? (state.agentSnapshots?.get(primaryAgentId) ?? this.store.getAgent(primaryAgentId))?.model?.trim()
            : undefined) ||
          "platform-default"
        : undefined;

    // 初始验证已达标时不进入修正，避免为了用掉轮次而重写合格产物。
    if (initialScore !== undefined && initialScore >= threshold) {
      state.loopSummaries.push({
        loopNodeId: statement.nodeId,
        iterations: 0,
        threshold,
        initialScore,
        finalScore: initialScore,
        bestScore: initialScore,
        bestIteration: 0,
        stopReason: "passed",
        tokensUsed: 0,
        elapsedMs: 0
      });
      return;
    }

    const initialSnapshot = snapshotScope(state.scope, 0);
    let best = initialSnapshot.score === undefined ? undefined : initialSnapshot;

    const frame: LoopFrame = {
      path: statement.path,
      controller: new SelfLoopController({
        threshold,
        maxIterations: statement.maxIterations,
        policy: {
          patience: statement.patience,
          budget: {
            maxDurationMs: statement.budget?.maxDurationMs,
            maxTokens: statement.budget?.maxTokens
          }
        },
        agents: this.releaseAgents(state, this.store.listAgents())
      }),
      action: "rewrite",
      actionReason: "首轮修正：根据初始验证问题重写输出。",
      issues: state.scope.lastVerifyIssues ?? [],
      directive: {},
      agentOverrides: new Map(),
      modelOverrides: new Map(),
      currentAgentId: primaryAgentId,
      currentModelId: primaryModelId,
      modelSwitches: [],
      primaryAgentPath: primaryAgent?.path,
      patchHistory: [],
      artifact: state.scope.lastArtifact,
      score: initialScore,
      iteration: 0,
      startedAt: Date.now(),
      tokensAtStart: state.tokensUsed
    };

    state.loops.push(frame);
    this.setStatus(state.runId, "revising");
    let iterations = 0;
    let stopReason: SelfLoopStopReason | undefined;

    try {
      for (let iteration = 1; iteration <= statement.maxIterations; iteration += 1) {
        const scoreBefore = state.scope.lastVerifyScore;
        state.iteration = iteration;
        frame.directive = buildLoopDirective(frame, iteration, scoreBefore, threshold);
        frame.diagnosis = undefined;
        frame.diagnosisSource = undefined;
        frame.promptPatch = undefined;
        await this.executeBlock(statement.body, state);

        const scoreAfter = state.scope.lastVerifyScore;
        // 补上一轮换模型后的验证分，便于报告对比“换模型前后的提升”。
        const lastSwitch = frame.modelSwitches[frame.modelSwitches.length - 1];
        if (lastSwitch && lastSwitch.scoreAfter === undefined && lastSwitch.iteration < iteration) {
          lastSwitch.scoreAfter = scoreAfter;
        }
        const issues = state.scope.lastVerifyIssues ?? [];
        const snapshot = snapshotScope(state.scope, iteration);
        frame.artifact = snapshot.artifact;
        frame.score = scoreAfter;
        frame.iteration = iteration;
        if (frame.promptPatch && frame.diagnosisSource) {
          const patchRecord = {
            patch: frame.promptPatch,
            source: frame.diagnosisSource,
            iteration,
            scoreBefore,
            scoreAfter,
            targetAgentId: frame.promotionTarget ?? frame.currentAgentId
          };
          frame.lastPatch = patchRecord;
          frame.patchHistory.push(patchRecord);
        }
        if (
          snapshot.score !== undefined &&
          (best === undefined || snapshot.score > (best.score ?? Number.NEGATIVE_INFINITY))
        ) {
          best = snapshot;
        }
        const decision = frame.controller.evaluate({
          iteration,
          score: scoreAfter,
          previousScore: scoreBefore,
          issues,
          whilePassed: !statement.while || evaluateExpression(statement.while, state.scope, frame),
          elapsedMs: Date.now() - frame.startedAt,
          tokensUsed: state.tokensUsed - frame.tokensAtStart,
          currentAgentId: frame.currentAgentId,
          currentModelId: frame.currentModelId,
          modelDecision: frame.diagnosis
        });

        iterations += 1;
        if (!decision.continue) {
          stopReason = decision.stopReason;
          decision.changes.push(retentionNote(best, iteration));
        }
        // 切换在上一轮结束时决定、本轮生效；本轮记录 from → to，然后清空以免重复。
        this.store.recordLoopIteration({
          runId: state.runId,
          loopNodeId: statement.nodeId,
          iteration,
          scoreBefore,
          scoreAfter,
          action: frame.action,
          modelBefore: frame.previousModelId ?? frame.currentModelId,
          modelAfter: frame.currentModelId,
          changes: decision.changes
        });
        frame.previousModelId = undefined;

        if (!decision.continue) {
          break;
        }

        if (decision.nextAgentId && frame.primaryAgentPath) {
          frame.previousAgentId = frame.currentAgentId;
          frame.currentAgentId = decision.nextAgentId;
          frame.agentOverrides.set(frame.primaryAgentPath, decision.nextAgentId);
        }
        if (decision.action === "swap_model" && decision.nextModelId && frame.primaryAgentPath) {
          const fromModel = frame.currentModelId ?? "platform-default";
          frame.previousModelId = fromModel;
          frame.currentModelId = decision.nextModelId;
          frame.modelOverrides.set(frame.primaryAgentPath, decision.nextModelId);
          frame.modelSwitches.push({
            iteration,
            fromModel,
            toModel: decision.nextModelId,
            reason: decision.reason,
            scoreBefore: scoreAfter
          });
        }
        frame.action = decision.action;
        frame.actionReason = decision.reason;
        frame.issues = issues;
        frame.retrievalQuery = decision.retrievalQuery;
        frame.promptPatch = decision.promptPatch ?? frame.promptPatch;
      }
    } finally {
      state.loops.pop();
      if (best && iterations > 0) {
        restoreScope(state.scope, best, collectLeafSteps(statement.body));
      }
      const promotion = this.promoteSelfLoopPatch({
        frame,
        runId: state.runId,
        initialScore,
        best,
        minGain: frame.controller.policy.minGain,
        state
      });
      state.loopSummaries.push({
        loopNodeId: statement.nodeId,
        iterations,
        threshold,
        initialScore,
        finalScore: state.scope.lastVerifyScore,
        bestScore: best?.score ?? frame.controller.bestScore,
        bestIteration: best?.iteration,
        stopReason,
        tokensUsed: state.tokensUsed - frame.tokensAtStart,
        elapsedMs: Date.now() - frame.startedAt,
        ...(frame.modelSwitches.length > 0 ? { modelSwitches: frame.modelSwitches } : {}),
        promotion
      });
      this.setStatus(state.runId, "running");
    }
  }

  private promoteSelfLoopPatch(input: {
    frame: LoopFrame;
    runId: string;
    initialScore?: number;
    best?: ScopeSnapshot;
    minGain: number;
    state?: RunState;
  }): SelfLoopPromotion {
    const { frame, initialScore, best, minGain } = input;
    if (this.mode !== "live") {
      return { status: "skipped", reason: "stub 模式只做契约演练，不写入 Agent 版本。" };
    }
    if (!best || initialScore === undefined || best.iteration === undefined || best.iteration === 0) {
      return { status: "skipped", reason: "没有超过初始产物的更优轮次，不晋升补丁。" };
    }
    if ((best.score ?? Number.NEGATIVE_INFINITY) <= initialScore + minGain) {
      return {
        status: "skipped",
        reason: `最佳轮得分未超过初始分 + ${minGain.toFixed(2)}，不晋升补丁。`,
        scoreBefore: initialScore,
        scoreAfter: best.score
      };
    }
    const patch = frame.patchHistory.find((item) => item.iteration === best.iteration);
    if (!patch || patch.source !== "model") {
      return {
        status: "skipped",
        reason: "最佳轮没有可复用的模型诊断补丁。",
        scoreBefore: initialScore,
        scoreAfter: best.score
      };
    }
    const agentId = patch.targetAgentId;
    if (!agentId) {
      return {
        status: "skipped",
        reason: "诊断节点未声明补丁晋升目标。",
        scoreBefore: initialScore,
        scoreAfter: best.score
      };
    }
    const rejection = validatePromptPatch(patch.patch);
    if (rejection) {
      return {
        status: "rejected",
        reason: rejection,
        agentId,
        patchPreview: previewPatch(patch.patch),
        scoreBefore: initialScore,
        scoreAfter: best.score
      };
    }
    const agent = input.state?.agentSnapshots?.get(agentId) ?? this.store.getAgent(agentId);
    if (!agent) {
      return {
        status: "rejected",
        reason: `晋升目标 Agent「${agentId}」不在注册中心。`,
        agentId,
        patchPreview: previewPatch(patch.patch),
        scoreBefore: initialScore,
        scoreAfter: best.score
      };
    }
    if (agent.prompt.includes(patch.patch)) {
      return {
        status: "skipped",
        reason: "该补丁已经存在于目标 Agent 的提示词中。",
        agentId,
        fromVersion: agent.version,
        toVersion: agent.version,
        patchPreview: previewPatch(patch.patch),
        scoreBefore: initialScore,
        scoreAfter: best.score
      };
    }
    if (input.state?.release) {
      // 发布运行不允许直接改注册表：补丁进入演化候选，必须通过离线门禁与人工批准。
      this.options.onPromptCandidate?.({
        workflowId: input.state.workflowId,
        runId: input.runId,
        agentId,
        patch: patch.patch,
        iteration: patch.iteration,
        scoreBefore: initialScore,
        scoreAfter: best.score,
        source: patch.source,
        baseReleaseId: input.state.release.releaseId
      });
      return {
        status: "skipped",
        reason: "发布运行不直接写注册表：补丁已登记为演化候选，需通过离线门禁与人工批准。",
        agentId,
        patchPreview: previewPatch(patch.patch),
        scoreBefore: initialScore,
        scoreAfter: best.score
      };
    }
    const saved = this.store.saveAgent({
      id: agent.id,
      name: agent.name,
      version: agent.version + 1,
      role: agent.role,
      prompt: `${agent.prompt}\n\n## 自循环补丁（来源运行 ${input.runId} / 第 ${patch.iteration} 轮）\n${patch.patch}`,
      tools: agent.tools,
      model: agent.model,
      capabilities: agent.capabilities,
      memory: agent.memory,
      enabled: agent.enabled
    });
    return {
      status: "promoted",
      reason: `第 ${best.iteration} 轮提升 ${(initialScore ?? 0).toFixed(3)} → ${(best.score ?? 0).toFixed(3)}，补丁写入 Agent v${saved.version}。`,
      agentId: saved.id,
      fromVersion: agent.version,
      toVersion: saved.version,
      patchPreview: previewPatch(patch.patch),
      scoreBefore: initialScore,
      scoreAfter: best.score
    };
  }

  private async executeStep(step: CompiledStep, state: RunState) {
    const node = step.node;
    const frame = findLoopFrame(state, step.path);
    const rawInput =
      node.kind === "tool"
        ? node.args ?? {}
        : node.kind === "start"
          ? state.scope.input
          : node.kind === "knowledge"
            ? {
                query: node.query,
                knowledgeBaseIds: node.knowledgeBaseIds,
                topK: node.topK,
                ...(node.inputs ?? {})
              }
            : node.kind === "http"
              ? {
                  method: node.method,
                  url: node.url,
                  headers: node.headers,
                  body: node.requestBody,
                  ...(node.inputs ?? {})
                }
                : node.kind === "clarify"
                ? {
                    // 澄清读的是本次运行的原始需求；inputs 可覆盖 request 或补充领域上下文。
                    ...state.scope.input,
                    ...(node.inputs ?? {}),
                    ...(node.prompt ? { hint: node.prompt } : {})
                  }
                : node.kind === "extract"
                  ? {
                      // 参数提取默认就看用户这句话；映射了 inputs 就在其上覆盖 / 追加变量。
                      ...state.scope.input,
                      ...(node.inputs ?? {})
                    }
                  : node.inputs ?? {};
    let input = resolveValue(rawInput, state.scope, frame) as Record<string, unknown>;
    if (node.kind === "verify") {
      // 未显式映射时，默认验证最近一个非验证节点的输出，证据取当前运行已收集的引用池。
      input = {
        ...input,
        ...(input.artifact === undefined ? { artifact: state.scope.lastArtifact } : {}),
        ...(input.evidence === undefined ? { evidence: [...state.scope.evidence] } : {}),
        ...(input.targetNodeId === undefined && state.scope.lastArtifactNodeId
          ? { targetNodeId: state.scope.lastArtifactNodeId }
          : {})
      };
    }
    if (
      (node.kind === "knowledge" ||
        (node.kind === "tool" && node.tool === "knowledge.search")) &&
      state.workflowKnowledgeBaseIds.length > 0
    ) {
      // 只给知识库检索补默认范围；其他工具（如 report.build）不该收到无关参数。
      const explicit = Array.isArray(input.knowledgeBaseIds)
        ? input.knowledgeBaseIds.filter((item) => typeof item === "string" && item.trim() !== "")
        : [];
      if (explicit.length === 0) {
        input = { ...input, knowledgeBaseIds: state.workflowKnowledgeBaseIds };
      }
    }
    let effectiveStep = step;

    if (node.kind === "agent") {
      if (frame) {
        const authored = isRecord(input.selfLoop) ? input.selfLoop : {};
        input = { ...input, selfLoop: { ...authored, ...frame.directive } };
      }
      const loopOverride = frame?.agentOverrides.get(step.path);
      const scheduled = state.assignments.get(step.path);
      const effectiveAgent = loopOverride ?? scheduled ?? node.agent;
      const modelOverride = frame?.modelOverrides.get(step.path);
      if (effectiveAgent !== node.agent || modelOverride) {
        // 换 Agent 后原节点的版本钉子失效，否则可能钉到新 Agent 不存在的版本。
        effectiveStep = {
          ...step,
          node: {
            ...node,
            agent: effectiveAgent,
            ...(effectiveAgent !== node.agent ? { agentVersion: undefined } : {}),
            ...(modelOverride ? { model: modelOverride } : {})
          }
        };
      }
      const memory = this.memoryConfigOf(effectiveAgent, state);
      if (memory) {
        const entries = this.store.listAgentMemory(effectiveAgent, state.workflowId, memory.recall);
        if (entries.length > 0) {
          input = {
            ...input,
            memoryHistory: entries.map((entry) => ({
              key: entry.key,
              value: entry.value,
              at: entry.created_at
            }))
          };
        }
      }
    }

    const stepId = this.store.beginStep({
      runId: state.runId,
      sequence: (state.sequence += 1),
      path: step.path,
      nodeId: step.nodeId,
      nodeKind: node.kind,
      input
    });
    const stepStartedAt = Date.now();
    state.onNodeProgress?.({
      nodeId: step.nodeId,
      title: node.title || step.nodeId,
      kind: node.kind,
      status: "running",
      sequence: state.sequence,
      workflowId: state.workflowId,
      ...(step.path ? { path: step.path } : {})
    });

    if (node.kind === "approve") {
      await this.executeApprovalStep(effectiveStep, input, state, stepId);
      return;
    }
    if (node.kind === "human") {
      await this.executeHumanStep(effectiveStep, input, state, stepId);
      return;
    }
    if (node.kind === "clarify") {
      await this.executeClarifyStep(effectiveStep, input, state, stepId);
      return;
    }
    if (node.kind === "extract") {
      await this.executeExtractStep(effectiveStep, input, state, stepId);
      return;
    }
    if (node.kind !== "verify") {
      await this.runStepBody(effectiveStep, input, state, stepId);
      return;
    }
    this.setStatus(state.runId, "verifying");
    try {
      await this.runStepBody(effectiveStep, input, state, stepId);
    } finally {
      if (this.store.getRun(state.runId)?.status === "verifying") {
        this.setStatus(state.runId, "running");
      }
    }
  }

  /**
   * 子工作流：编译期已展开，运行时临时切换到子作用域复用同一执行器。
   * 子步骤 trace 路径带父节点前缀；子流程结束后把映射输出挂回父节点。
   */
  private async executeSubWorkflow(
    statement: Extract<CompiledStatement, { type: "subworkflow" }>,
    state: RunState
  ) {
    const node = statement.node;
    const definition = statement.definition;
    if (!definition) {
      throw new PlatformError(`子工作流「${node.workflowId}」未解析，请检查 DSL 引用。`, 500);
    }
    const frame = findLoopFrame(state, statement.path);
    const input = resolveValue(node.inputs ?? {}, state.scope, frame) as Record<string, unknown>;
    const missing = definition.inputs
      .filter((variable) => variable.required && input[variable.name] === undefined)
      .map((variable) => variable.name);
    if (missing.length > 0) {
      throw new PlatformError(`子工作流「${definition.id}」缺少必填输入：${missing.join("、")}`, 400);
    }

    const stepId = this.store.beginStep({
      runId: state.runId,
      sequence: (state.sequence += 1),
      path: statement.path,
      nodeId: node.id,
      nodeKind: node.kind,
      input
    });
    const startedAt = Date.now();
    state.onNodeProgress?.({
      nodeId: node.id,
      title: node.title || node.id,
      kind: node.kind,
      status: "running",
      sequence: state.sequence,
      workflowId: state.workflowId,
      ...(statement.path ? { path: statement.path } : {})
    });
    const parentScope = state.scope;
    const parentLoops = state.loops;
    const parentIteration = state.iteration;
    const parentKnowledgeBaseIds = state.workflowKnowledgeBaseIds;
    // 验证轮次按整条运行计数：子流程里的验证也算一轮，否则父流程的最终验证会退回首轮基准分。
    // 证据池随进入子流程继承，子流程内也可继续补充引用。
    const childScope: RunScope = {
      input,
      outputs: new Map(),
      evidence: [...parentScope.evidence],
      verifyRounds: parentScope.verifyRounds
    };

    try {
      state.scope = childScope;
      state.loops = [];
      state.iteration = 0;
      state.workflowKnowledgeBaseIds = definition.knowledgeBaseIds ?? parentKnowledgeBaseIds;
      await this.executeBlock(statement.program, state);
    } catch (error) {
      this.store.completeStep(stepId, "failed", undefined, errorDetail(error), { attempts: 1 });
      throw error;
    } finally {
      state.scope = parentScope;
      parentScope.verifyRounds = childScope.verifyRounds;
      parentScope.evidence = mergeEvidence(parentScope.evidence, childScope.evidence);
      state.loops = parentLoops;
      state.iteration = parentIteration;
      state.workflowKnowledgeBaseIds = parentKnowledgeBaseIds;
    }

    const mapped = Object.fromEntries(
      Object.entries(node.outputs ?? {}).map(([key, expression]) => [
        key,
        resolveValue(expression, childScope)
      ])
    );
    const payload: Record<string, unknown> = {
      mode: this.mode,
      kind: "subworkflow",
      workflowId: definition.id,
      workflowVersion: definition.version,
      inputs: input,
      outputs: Object.fromEntries(childScope.outputs),
      mappedOutputs: mapped,
      artifact: childScope.lastArtifact,
      score: childScope.lastVerifyScore,
      confidence: childScope.lastVerifyConfidence,
      issues: childScope.lastVerifyIssues ?? [],
      verifyRounds: childScope.verifyRounds,
      durationMs: Date.now() - startedAt,
      ...mapped
    };
    state.scope.outputs.set(node.id, payload);
    absorbEvidence(state.scope, payload);
    state.scope.lastArtifact = payload;
    state.scope.lastArtifactNodeId = node.id;
    state.tokensUsed += estimateTokens(input) + estimateTokens(payload);
    this.store.completeStep(stepId, "succeeded", payload, undefined, {
      attempts: 1,
      snapshot: serializeScope(state.scope)
    });
    state.onNodeProgress?.({
      nodeId: node.id,
      title: node.title || node.id,
      kind: node.kind,
      status: "succeeded",
      sequence: state.sequence,
      workflowId: state.workflowId,
      ...(statement.path ? { path: statement.path } : {}),
      durationMs: Math.max(0, Date.now() - startedAt)
    });
  }

  /**
   * 人工审批：落待审记录 → 运行挂起 → API 决策唤醒。
   * 通过后把审批结果写入节点输出并继续；驳回/超时以失败终态结束，不走重试。
   */
  private async executeApprovalStep(
    step: CompiledStep,
    input: Record<string, unknown>,
    state: RunState,
    stepId: string
  ) {
    const node = step.node as ApproveNode;
    const timeoutMs = node.timeoutMs ?? this.options.approvalTimeoutMs;
    // 审批不占运行锁；等待期间其他分支可能继续执行，因此以提交审批时的快照为准。
    const scope = state.scope;
    const context: Record<string, unknown> = {
      artifact: scope.lastArtifact,
      artifactNodeId: scope.lastArtifactNodeId,
      score: scope.lastVerifyScore,
      confidence: scope.lastVerifyConfidence,
      issues: scope.lastVerifyIssues ?? [],
      input
    };
    const approval = this.store.createApproval({
      runId: state.runId,
      stepId,
      nodeId: node.id,
      title: node.title ?? node.id,
      instructions: node.instructions,
      assignee: node.assignee,
      context,
      expiresAt: new Date(Date.now() + timeoutMs).toISOString()
    });

    this.store.updateStepStatus(stepId, "waiting");
    this.setStatus(state.runId, "waiting_approval");

    let outcome: ApprovalOutcome;
    try {
      outcome = await this.approvals.wait(approval.id, timeoutMs);
    } finally {
      if (this.store.getRun(state.runId)?.status === "waiting_approval") {
        this.setStatus(state.runId, "running");
      }
    }

    const decided = this.store.decideApproval(
      approval.id,
      outcome.decision,
      outcome.reviewer,
      outcome.comment
    );
    const payload: Record<string, unknown> = {
      mode: this.mode,
      approval: approval.id,
      nodeId: node.id,
      assignee: node.assignee,
      decision: outcome.decision,
      reviewer: outcome.reviewer,
      comment: outcome.comment,
      decidedAt: decided?.decidedAt,
      artifact: context.artifact,
      score: context.score,
      issues: context.issues,
      input
    };

    if (outcome.decision !== "approved") {
      const message =
        outcome.decision === "expired"
          ? `人工审批超时（${timeoutMs}ms），运行已终止。`
          : `人工审批未通过${outcome.comment ? `：${outcome.comment}` : ""}`;
      this.store.completeStep(stepId, "failed", payload, message, { attempts: 1 });
      throw new ApprovalRejectedError(message);
    }

    scope.outputs.set(node.id, payload);
    state.tokensUsed += estimateTokens(input) + estimateTokens(payload);
    this.store.completeStep(stepId, "succeeded", payload, undefined, { attempts: 1 });
  }

  /**
   * 人工交互：落待输入记录 → 运行挂起 → API 提交后唤醒。
   * 提交值同时成为节点输出（扁平字段 + values 副本），供下游模板与条件直接引用。
   *
   * 配了选项时它就是「选项卡」：表单里多一个 choice 字段，前端渲染成可点按钮；
   * 提交后若还写了提示词，再按「用户选了什么」调一次模型，把生成的回复写回 output。
   */
  private async executeHumanStep(
    step: CompiledStep,
    input: Record<string, unknown>,
    state: RunState,
    stepId: string
  ) {
    const node = step.node as HumanNode;
    const timeoutMs = node.timeoutMs ?? this.options.humanTimeoutMs;
    const locals = nodeLocals(node, input, state.scope);
    const frame = findLoopFrame(state, step.path);
    const choices = humanChoices(node, state.scope, locals);
    // 追问文案支持 ${节点.output} 引用：让“导师提问”这类内容随上游生成结果走，
    // 而不是写死一句没有上下文的“请输入回答”。
    const resolvedPrompt = node.prompt?.trim()
      ? String(resolveValue(node.prompt, state.scope, frame, locals))
      : "";
    const interaction = this.store.createInteraction({
      runId: state.runId,
      stepId,
      nodeId: node.id,
      path: step.path,
      title: node.title ?? node.id,
      prompt: resolvedPrompt,
      fields: withChoiceField(node.fields ?? [], choices),
      context: input,
      expiresAt: timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : undefined
    });

    this.store.updateStepStatus(stepId, "waiting");
    this.setStatus(state.runId, "waiting_input");

    let outcome;
    try {
      outcome = await this.humans.wait(interaction.id, timeoutMs);
    } finally {
      if (this.store.getRun(state.runId)?.status === "waiting_input") {
        this.setStatus(state.runId, "running");
      }
    }

    if (outcome.status === "cancelled") {
      this.store.decideInteraction(interaction.id, "cancelled");
      this.store.completeStep(stepId, "failed", undefined, "运行已取消。", { attempts: 1 });
      throw new RunCancelledError();
    }
    if (outcome.status === "expired") {
      this.store.decideInteraction(interaction.id, "expired");
      const message = `人工输入超时（${timeoutMs}ms），运行已终止。`;
      this.store.completeStep(stepId, "failed", undefined, message, { attempts: 1 });
      throw new HumanInputError(message);
    }

    const decided = this.store.decideInteraction(
      interaction.id,
      "answered",
      outcome.values,
      outcome.actor
    );
    const payload: Record<string, unknown> = {
      ...outcome.values,
      values: outcome.values,
      interaction: interaction.id,
      nodeId: node.id,
      submittedAt: decided?.decidedAt,
      actor: outcome.actor,
      input
    };
    if (choices.length > 0) {
      payload.choices = choices;
    }

    const picked = outcome.values[CHOICE_FIELD_KEY];
    const choice = typeof picked === "string" ? picked.trim() : "";
    if (choice) {
      payload.choice = choice;
      // 序号决定走哪条出边；-1 表示没命中预置选项（自由输入或「其他」），这条路走兜底出口。
      const index = matchChoiceIndex(choices, choice);
      payload.choiceIndex = index;
      if (index < 0) {
        payload.choiceOther = true;
      }
      const reply = await this.generateChoiceReply(node, choice, outcome.values, input, state);
      if (reply) {
        payload.reply = reply.text;
        payload.output = reply.text;
        payload.summary = `已选择「${choice}」并生成回复`;
        payload.generation = {
          mode: reply.mode,
          model: reply.model,
          thinking: reply.thinking
        };
      }
    }

    state.scope.outputs.set(node.id, payload);
    state.tokensUsed += estimateTokens(input) + estimateTokens(payload);
    this.store.completeStep(stepId, "succeeded", payload, undefined, { attempts: 1 });
  }

  /**
   * 选项卡选完后的那次模型调用。
   * 提示词和模型都没配就完全不调模型——只把选择结果交给下游，避免用户没打算花钱却产生调用。
   * 只配了模型、没写提示词时用一句默认指令兜底，否则「选了模型却没有回复」会让人以为坏了。
   */
  private async generateChoiceReply(
    node: HumanNode,
    choice: string,
    values: Record<string, unknown>,
    input: Record<string, unknown>,
    state: RunState
  ): Promise<{ text: string; mode: RunMode; model?: string; thinking?: string } | undefined> {
    const configured = node.generatePrompt?.trim();
    if (!configured && !node.model) {
      return undefined;
    }
    const instruction =
      configured ||
      `用户在上一步选择了「${choice}」。请按这个方向继续推进任务，直接输出要回复给用户的内容，不要复述选项、不要解释流程。`;
    // 提示词里 ${choice} 取选中项，${某字段} 取用户同时填的其它输入。
    const context: ExecutionContext = {
      runId: state.runId,
      workflowId: state.workflowId,
      iteration: state.iteration,
      scope: state.scope,
      knowledgeBaseIds: state.workflowKnowledgeBaseIds,
      tokensUsed: state.tokensUsed,
      tokenBudget: state.tokenBudget,
      locals: { ...nodeLocals(node, input, state.scope), ...values, choice, values }
    };
    const synthetic: LlmNode = {
      ...(node as unknown as LlmNode),
      kind: "llm",
      // 不是画布上的节点，id 只用来在 trace 里区分是哪一次选项卡生成。
      id: `${node.id}__choice`,
      prompt: instruction,
      inputs: { ...input, choice, values }
    };
    const raw = this.handlers.llm
      ? await this.handlers.llm(synthetic, { ...input, choice, values }, context)
      : stubLlm(synthetic, { ...input, choice, values });
    const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const text =
      typeof record.output === "string"
        ? record.output
        : typeof record.value === "string"
          ? record.value
          : typeof record.content === "string"
            ? record.content
            : "";
    return {
      text,
      mode: (record.mode === "live" ? "live" : this.mode) as RunMode,
      model: typeof record.model === "string" ? record.model : node.model,
      thinking: typeof record.thinking === "string" ? record.thinking : undefined
    };
  }

  /**
   * 参数提取：先把「已经能拿到」的值收齐（输入变量直给 → 模型抽取 → 默认值），
   * 还缺必填参数就挂一张待输入卡片追问；用户答完重新抽一次，抽到才继续往下走。
   *
   * 和「在提示词里让模型顺嘴问一句」的区别就在这里：模型节点问完也会继续往下跑，
   * 下游拿到的是空参数；这里拿不到就停在原地，下游只会收到抽好的值。
   */
  private async executeExtractStep(
    step: CompiledStep,
    input: Record<string, unknown>,
    state: RunState,
    stepId: string
  ) {
    const node = step.node as ExtractNode;
    const frame = findLoopFrame(state, step.path);
    const params = normalizeExtractParams(node.params);
    const timeoutMs = node.timeoutMs ?? this.options.humanTimeoutMs;
    // 一轮只问一个参数：调试面板的回答走底部单输入框，一次弹多行必填表单会提交失败。
    // 默认轮次按参数个数放宽，保证每个参数至少有一次被问到的机会。
    const maxRounds = clampExtractRounds(node.maxRounds, params.length);
    const collected: Record<string, unknown> = {};
    const sources: Record<string, string> = {};
    let transcript = extractTranscriptOf(input);
    let rounds = 0;

    // 输入变量里已经有同名变量就等于已经拿到：用户给过的东西不该再问一遍。
    for (const param of params) {
      const direct = directParamValue(input, param.name);
      if (direct !== undefined) {
        collected[param.name] = coerceExtractValue(direct, param);
        sources[param.name] = "input";
      }
    }

    const applyExtraction = (raw: unknown) => {
      const record = extractRecordOf(raw);
      for (const param of params) {
        if (isFilledValue(collected[param.name])) {
          continue;
        }
        const value = record[param.name];
        if (!isFilledValue(value)) {
          continue;
        }
        collected[param.name] = coerceExtractValue(value, param);
        sources[param.name] = "extract";
      }
    };

    let missing = missingExtractParams(params, collected);
    if (missing.length > 0) {
      this.throwIfCancelled(state.runId);
      applyExtraction(
        await this.runExtractHandler(node, input, transcript, state, frame)
      );
      // 模型也没抽到、但参数表给了默认值：算作已拿到，不再追问。
      for (const param of params) {
        if (!isFilledValue(collected[param.name]) && param.defaultValue !== undefined) {
          collected[param.name] = coerceExtractValue(param.defaultValue, param);
          sources[param.name] = "default";
        }
      }
      missing = missingExtractParams(params, collected);
    }

    while (missing.length > 0 && rounds < maxRounds) {
      rounds += 1;
      // 一轮只问一个：用户答完这句常常顺带写了别的参数，整段并回正文重新抽一次，
      // 下一轮往往就不用再问了。这样底部一句话输入框永远只需要收一个字段。
      const focus = missing[0];
      const ask = buildExtractAskPrompt(node, [focus], input, state, frame);
      const interaction = this.store.createInteraction({
        runId: state.runId,
        stepId,
        nodeId: node.id,
        path: step.path,
        title: node.title ?? "参数提取",
        prompt: ask,
        fields: [extractFieldOf(focus)],
        context: {
          params: params.map((param) => param.name),
          collected,
          missing: missing.map((p) => p.name),
          asking: focus.name
        },
        expiresAt: timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : undefined
      });

      this.store.updateStepStatus(stepId, "waiting");
      this.setStatus(state.runId, "waiting_input");

      let outcome;
      try {
        outcome = await this.humans.wait(interaction.id, timeoutMs);
      } finally {
        if (this.store.getRun(state.runId)?.status === "waiting_input") {
          this.setStatus(state.runId, "running");
        }
      }

      if (outcome.status === "cancelled") {
        this.store.decideInteraction(interaction.id, "cancelled");
        this.store.completeStep(stepId, "failed", undefined, "运行已取消。", { attempts: 1 });
        throw new RunCancelledError();
      }
      if (outcome.status === "expired") {
        this.store.decideInteraction(interaction.id, "expired");
        const message = `参数提取追问超时（${timeoutMs}ms），运行已终止。`;
        this.store.completeStep(stepId, "failed", undefined, message, { attempts: 1 });
        throw new HumanInputError(message);
      }

      this.store.decideInteraction(interaction.id, "answered", outcome.values, outcome.actor);
      // 回答里经常顺带写了别的参数（「题目是《X》，帮我练答辩」），所以整段并回正文再抽一次，
      // 而不是只认这一个字段。
      const answerText = missing
        .map((param) => stringify(outcome.values[param.name] ?? ""))
        .filter((value) => value.trim() !== "")
        .join("\n");
      for (const param of missing) {
        const value = outcome.values[param.name];
        if (isFilledValue(value)) {
          collected[param.name] = coerceExtractValue(value, param);
          sources[param.name] = "answer";
        }
      }
      if (answerText) {
        transcript = `${transcript}\n${answerText}`.trim();
      }
      this.throwIfCancelled(state.runId);
      applyExtraction(await this.runExtractHandler(node, input, transcript, state, frame));
      missing = missingExtractParams(params, collected);
    }

    if (missing.length > 0 && node.onMissing !== "continue") {
      const message = `参数提取未完成：还没有拿到 ${missing
        .map((param) => extractLabelOf(param))
        .join("、")}，请补充后重新运行。`;
      this.store.completeStep(stepId, "failed", undefined, message, { attempts: 1 });
      throw new HumanInputError(message);
    }

    const filled = params.filter((param) => isFilledValue(collected[param.name]));
    const text = filled
      .map((param) => `${extractLabelOf(param)}：${stringify(collected[param.name])}`)
      .join("\n");
    const payload: Record<string, unknown> = {
      kind: "extract",
      // 扁平写入，下游可以直接 ${节点.论文题目}；params 保留一份结构化副本。
      ...collected,
      params: collected,
      missing: missing.map((param) => param.name),
      complete: missing.length === 0,
      rounds,
      sources,
      output: text,
      text,
      summary:
        missing.length === 0
          ? `已提取 ${filled.length} 个参数`
          : `已提取 ${filled.length} 个参数，仍缺 ${missing.length} 个`
    };

    state.scope.outputs.set(node.id, payload);
    state.tokensUsed += estimateTokens(input) + estimateTokens(payload);
    this.store.completeStep(stepId, "succeeded", payload, undefined, { attempts: 1 });
  }

  /** 调一次抽取：live 走模型，离线走规则；返回原始结果交给上层合并。 */
  private async runExtractHandler(
    node: ExtractNode,
    input: Record<string, unknown>,
    transcript: string,
    state: RunState,
    frame?: LoopProfile
  ): Promise<unknown> {
    const context: ExecutionContext = {
      runId: state.runId,
      workflowId: state.workflowId,
      iteration: state.iteration,
      scope: state.scope,
      loop: frame ? loopScopeOf(frame) : undefined,
      locals: nodeLocals(node, input, state.scope, frame),
      knowledgeBaseIds: state.workflowKnowledgeBaseIds,
      tokensUsed: state.tokensUsed,
      tokenBudget: state.tokenBudget
    };
    const payload = { ...input, text: transcript };
    if (!this.handlers.extract) {
      return stubExtract(node, normalizeExtractParams(node.params), transcript);
    }
    return this.handlers.extract(node, payload, context);
  }

  /**
   * 意图澄清：先分析原始需求，只有缺失信息会改变交付结果时才暂停人工补充，
   * 再按澄清结果改写 Prompt。产物同时保留原文、意图、假设与改写后文本，供对比与追溯。
   */
  private async executeClarifyStep(
    step: CompiledStep,
    input: Record<string, unknown>,
    state: RunState,
    stepId: string
  ) {
    const node = step.node as ClarifyNode;
    const frame = findLoopFrame(state, step.path);
    const context: ExecutionContext = {
      runId: state.runId,
      workflowId: state.workflowId,
      iteration: state.iteration,
      scope: state.scope,
      loop: frame ? loopScopeOf(frame) : undefined,
      locals: nodeLocals(node, input, state.scope, frame),
      knowledgeBaseIds: state.workflowKnowledgeBaseIds,
      tokensUsed: state.tokensUsed,
      tokenBudget: this.options.tokenBudget
    };
    const rawPrompt = extractClarifyRequest(input);

    try {
      this.throwIfCancelled(state.runId);
      const analysis = normalizeClarifyAnalysis(
        this.handlers.clarify
          ? await this.handlers.clarify(node, input, context, { phase: "analyze" })
          : stubClarifyAnalysis(node, input, this.mode),
        rawPrompt
      );
      const questions = clarifyQuestionsOf(analysis, node);
      let clarification: ClarifyAnswer | undefined;

      if (shouldPauseForClarification(node, analysis)) {
        const timeoutMs = node.timeoutMs ?? this.options.humanTimeoutMs;
        const interaction = this.store.createInteraction({
          runId: state.runId,
          stepId,
          nodeId: node.id,
          path: step.path,
          title: node.title ?? "意图澄清",
          prompt: buildClarifyInteractionPrompt(questions),
          fields: [
            {
              key: "answer",
              label: "补充说明",
              type: "textarea",
              required: false,
              placeholder: "可直接回答上面的问题；没有补充可留空。"
            }
          ],
          context: { rawPrompt, intent: analysis },
          expiresAt: timeoutMs > 0 ? new Date(Date.now() + timeoutMs).toISOString() : undefined
        });

        this.store.updateStepStatus(stepId, "waiting");
        this.setStatus(state.runId, "waiting_input");

        let outcome;
        try {
          outcome = await this.humans.wait(interaction.id, timeoutMs);
        } finally {
          if (this.store.getRun(state.runId)?.status === "waiting_input") {
            this.setStatus(state.runId, "running");
          }
        }

        if (outcome.status === "cancelled") {
          this.store.decideInteraction(interaction.id, "cancelled");
          this.store.completeStep(stepId, "failed", undefined, "运行已取消。", { attempts: 1 });
          throw new RunCancelledError();
        }
        if (outcome.status === "expired") {
          this.store.decideInteraction(interaction.id, "expired");
          const message = `意图澄清超时（${timeoutMs}ms），运行已终止。`;
          this.store.completeStep(stepId, "failed", undefined, message, { attempts: 1 });
          throw new HumanInputError(message);
        }

        const decided = this.store.decideInteraction(
          interaction.id,
          "answered",
          outcome.values,
          outcome.actor
        );
        clarification = {
          questions,
          answer: typeof outcome.values.answer === "string" ? outcome.values.answer.trim() : "",
          actor: outcome.actor,
          askedAt: decided?.decidedAt ?? new Date().toISOString()
        };
        this.throwIfCancelled(state.runId);
      }

      const rewrite = normalizeClarifyRewrite(
        this.handlers.clarify
          ? await this.handlers.clarify(node, input, context, {
              phase: "rewrite",
              analysis,
              clarification
            })
          : stubClarifyRewrite(node, analysis, clarification)
      );
      const payload: Record<string, unknown> = {
        mode: this.mode,
        kind: "clarify",
        summary: `意图「${analysis.taskType}」· 置信度 ${analysis.confidence.toFixed(2)}${
          clarification ? " · 已人工澄清" : ""
        }`,
        rawPrompt,
        intent: analysis,
        ...analysis,
        clarification,
        ...rewrite,
        inputs: input
      };
      state.scope.outputs.set(node.id, payload);
      state.scope.lastArtifact = payload;
      state.scope.lastArtifactNodeId = node.id;
      state.tokensUsed += estimateTokens(input) + estimateTokens(payload);
      this.store.completeStep(stepId, "succeeded", payload, undefined, {
        attempts: 1,
        snapshot: serializeScope(state.scope)
      });
    } catch (error) {
      if (error instanceof RunCancelledError || error instanceof HumanInputError) {
        throw error;
      }
      this.store.completeStep(stepId, "failed", undefined, errorDetail(error), { attempts: 1 });
      throw error;
    }
  }

  private async runStepBody(
    step: CompiledStep,
    input: Record<string, unknown>,
    state: RunState,
    stepId: string
  ) {
    const stepStartedAt = Date.now();
    let lastError: unknown;
    let currentStep = step;
    const attemptedAgents: string[] = [];
    // 节点级异常处理优先：配置了重试次数就按节点的来，否则沿用平台全局策略。
    const policy = step.node.errorPolicy;
    const maxAttempts =
      policy?.retries !== undefined
        ? Math.max(1, Math.min(policy.retries + 1, MAX_NODE_ATTEMPTS))
        : this.options.maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.throwIfCancelled(state.runId);
      if (attempt > 1) {
        await sleep(policy?.retryIntervalMs ?? this.retryDelay(attempt));
      }
      await this.stubDelay();
      // 租约只观测真实在飞任务：不阻塞并发分支，但让调度器看到当前负载。
      let lease: SchedulerLease | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let worker: StepWorkerHandle | undefined;
      let releaseReason = "completed";
      try {
        if (this.workerPool && isPoolLeafKind(currentStep.node.kind)) {
          const invocationId = `${state.runId}:${stepId}:${attempt}`;
          const slot = await this.workerPool.acquire(`${state.runId}:${stepId}`);
          worker = {
            workerId: slot.workerId,
            abort: slot.abort,
            release: slot.release,
            invoke: (invokeStep, invokeInput, invokeState) =>
              slot.invoke(
                buildWorkerInvocation({
                  id: invocationId,
                  stepId,
                  step: invokeStep,
                  input: invokeInput,
                  state: invokeState,
                  tokenBudget: this.options.tokenBudget
                })
              )
          };
        } else if (currentStep.node.kind === "agent") {
          worker = this.acquireWorker(`${state.runId}:${stepId}`);
        }
        if (worker) {
          let owned = this.runWorkers.get(state.runId);
          if (!owned) {
            owned = new Set();
            this.runWorkers.set(state.runId, owned);
          }
          owned.add(worker.workerId);
        }
        if (currentStep.node.kind === "agent") {
          lease = this.store.acquireSchedulerLease({
            runId: state.runId,
            stepId,
            taskPath: currentStep.path,
            agentId: currentStep.node.agent,
            workerId: worker!.workerId,
            ttlMs: this.leaseTtlMs
          });
          heartbeat = setInterval(() => {
            this.store.heartbeatSchedulerLease(lease!.id, this.leaseTtlMs);
          }, Math.max(250, Math.floor(this.leaseTtlMs / 3)));
          heartbeat.unref?.();
        }
        const rawOutput = await this.invokeWithTimeout(
          currentStep,
          input,
          state,
          worker?.abort,
          worker?.invoke
        );
        const normalizedOutput =
          currentStep.node.kind === "agent" ? normalizeAgentJsonOutput(currentStep.node, rawOutput) : rawOutput;
        let output: unknown = normalizedOutput;
        if (currentStep.node.kind === "verify") {
          const verification = normalizeVerifyOutput(rawOutput);
          state.scope.verifyRounds += 1;
          state.scope.lastVerifyScore = verification.score;
          state.scope.lastVerifyIssues = verification.issues;
          state.scope.lastVerifyConfidence = verification.confidence;
          state.scope.lastVerifyPassed = verification.passed;
          state.scope.lastVerifyLayers = verification.layers;
          this.store.recordVerifyResult({
            runId: state.runId,
            stepId,
            verifier: currentStep.node.verifier,
            score: verification.score,
            confidence: verification.confidence,
            dimensions: verification.dimensions,
            issues: verification.issues,
            evidence: verification.evidence,
            detail: verifyDetail(verification)
          });
          output = verification;
        } else {
          // 开始节点只转发输入；若把它记成最近产物，后续验证会把原始输入误当成待验证产物。
          if (currentStep.node.kind !== "start") {
            state.scope.lastArtifact = output;
            state.scope.lastArtifactNodeId = currentStep.nodeId;
          }
        }
        state.scope.outputs.set(currentStep.nodeId, output);
        absorbEvidence(state.scope, output);
        if (currentStep.node.kind === "agent" && currentStep.node.loopRole === "diagnose") {
          const frame = findLoopFrame(state, currentStep.path);
          const diagnosis = isRecord(output) && isRecord(output.output) ? output.output : undefined;
          if (frame && diagnosis) {
            frame.diagnosis = diagnosis;
            frame.diagnosisSource =
              this.mode === "live" && !(isRecord(output) && output.stubFixture === true)
                ? "model"
                : "stub";
            frame.promptPatch =
              typeof diagnosis.promptPatch === "string" ? diagnosis.promptPatch.trim() : undefined;
            frame.promotionTarget = currentStep.node.promoteToAgent;
          }
        }
        state.tokensUsed += estimateTokens(input) + estimateTokens(output);
        this.persistAgentMemory(currentStep, state.workflowId, output, state);
        this.store.completeStep(stepId, "succeeded", output, undefined, {
          attempts: attempt,
          snapshot: serializeScope(state.scope)
        });
        state.onNodeProgress?.({
          nodeId: step.nodeId,
          title: step.node.title || step.nodeId,
          kind: step.node.kind,
          status: "succeeded",
          sequence: state.sequence,
          workflowId: state.workflowId,
          ...(step.path ? { path: step.path } : {}),
          durationMs: Math.max(0, Date.now() - stepStartedAt)
        });
        return;
      } catch (error) {
        releaseReason =
          error instanceof WorkerLostError
            ? "worker_lost"
            : error instanceof RunCancelledError
              ? "cancelled"
              : "failed";
        if (error instanceof RunCancelledError || error instanceof HumanInputError) {
          throw error;
        }
        // 超时的子进程可能还卡在原调用上；终止它，让下一个重试拿到干净槽位。
        if (error instanceof StepTimeoutError && this.workerPool && worker) {
          this.workerPool.killWorker(worker.workerId);
        }
        lastError = error;
        if (currentStep.node.kind === "agent" && attempt < maxAttempts) {
          attemptedAgents.push(currentStep.node.agent);
          const next = state.reschedule?.(currentStep.path, attemptedAgents);
          const swapped =
            Boolean(next) &&
            next!.agentId !== currentStep.node.agent &&
            !attemptedAgents.includes(next!.agentId);
          if (swapped) {
            const previousAgent = currentStep.node.agent;
            currentStep = {
              ...currentStep,
              node: { ...currentStep.node, agent: next!.agentId, agentVersion: undefined }
            };
            releaseReason = error instanceof WorkerLostError ? "worker_lost" : "rescheduled";
            this.store.annotateStepInput(stepId, {
              reschedule: {
                attempt,
                from: previousAgent,
                to: next!.agentId,
                reason: next!.reason,
                at: new Date().toISOString()
              }
            });
          } else if (error instanceof WorkerLostError) {
            // 没有可换的 Agent 时也记录 Worker 终止，下一轮会换一个模拟 Worker 重试。
            this.store.annotateStepInput(stepId, {
              reschedule: {
                attempt,
                from: currentStep.node.agent,
                to: currentStep.node.agent,
                reason: error.message,
                at: new Date().toISOString()
              }
            });
          }
        }
      } finally {
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        if (lease) {
          this.store.releaseSchedulerLease(lease.id, releaseReason);
        }
        worker?.release();
        if (worker) {
          const owned = this.runWorkers.get(state.runId);
          owned?.delete(worker.workerId);
          if (owned && owned.size === 0) {
            this.runWorkers.delete(state.runId);
          }
        }
      }
    }

    // 走到这里说明重试已用尽。打开异常处理（或显式配了跳过 / 兜底）的节点不再卡住整条流程：
    // 错误写进产物的 Error 分支，下游按 ${节点.Error.FailMessage} 就能取到原因。
    const guarded =
      policy?.enabled === true || policy?.strategy === "continue" || policy?.strategy === "fallback";
    if (guarded) {
      const message = errorDetail(lastError);
      const degraded =
        policy?.strategy === "fallback"
          ? policy.fallbackValue
          : { Error: { FailCode: "runtime_error", FailMessage: message } };
      state.scope.outputs.set(step.nodeId, degraded);
      this.store.completeStep(
        stepId,
        "succeeded",
        degraded,
        policy?.strategy === "fallback"
          ? `已降级：使用兜底产物继续。原因：${message}`
          : `已降级：跳过该节点继续。原因：${message}`,
        { attempts: maxAttempts }
      );
      return;
    }

    this.store.completeStep(stepId, "failed", undefined, errorDetail(lastError), {
      attempts: maxAttempts
    });
    state.onNodeProgress?.({
      nodeId: step.nodeId,
      title: step.node.title || step.nodeId,
      kind: step.node.kind,
      status: "failed",
      sequence: state.sequence,
      workflowId: state.workflowId,
      ...(step.path ? { path: step.path } : {}),
      durationMs: Math.max(0, Date.now() - stepStartedAt)
    });
    throw lastError;
  }

  private async invokeWithTimeout(
    step: CompiledStep,
    input: Record<string, unknown>,
    state: RunState,
    abort?: Promise<never>,
    remote?: (step: CompiledStep, input: Record<string, unknown>, state: LeafExecutionState) => Promise<unknown>
  ): Promise<unknown> {
    const timeoutMs = step.node.errorPolicy?.timeoutMs ?? this.options.timeoutMs;
    const start = () => (remote ? remote(step, input, state) : this.invoker.invoke(step, input, state));
    if (timeoutMs <= 0 && !abort) {
      return start();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const invocation = start();
    // 超时/终止先返回时，原调用仍可能在后台结束；挂一个空 catch 避免未处理拒绝。
    void invocation.catch(() => {});
    const racers: Array<Promise<unknown>> = [invocation];
    if (timeoutMs > 0) {
      racers.push(
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new StepTimeoutError(`步骤执行超时（>${timeoutMs}ms）`)),
            timeoutMs
          );
        })
      );
    }
    if (abort) {
      racers.push(abort);
    }
    try {
      return await Promise.race(racers);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private retryDelay(attempt: number) {
    const delay = this.options.retryBaseDelayMs * 2 ** (attempt - 2);
    return Math.min(Math.max(0, delay), this.options.retryMaxDelayMs);
  }

  private throwIfCancelled(runId: string) {
    if (this.cancelledRuns.has(runId)) {
      throw new RunCancelledError();
    }
  }

  private setStatus(runId: string, status: RunStatus) {
    this.store.updateRunStatus(runId, status);
    this.options.onStatusChange?.(runId, status);
  }

  private finish(
    runId: string,
    status: RunStatus,
    output?: Record<string, unknown>,
    error?: string
  ) {
    this.cancelledRuns.delete(runId);
    this.store.finishRun(runId, status, output, error);
    this.options.onStatusChange?.(runId, status);
    this.options.onRunFinished?.(runId);
  }

  private rollbackToSnapshot(runId: string, state: RunState, error: string): boolean {
    if (!this.options.rollbackOnFailure) {
      return false;
    }
    const snapshot = this.store.latestSnapshot(runId);
    if (!snapshot) {
      return false;
    }
    state.scope.outputs = new Map(Object.entries(snapshot.data.outputs));
    state.scope.verifyRounds = snapshot.data.verifyRounds;
    state.scope.lastVerifyScore = snapshot.data.lastVerifyScore;
    this.finish(
      runId,
      "rolled_back",
      {
        mode: this.mode,
        rolledBackTo: snapshot.path,
        stepId: snapshot.stepId,
        score: snapshot.data.lastVerifyScore
      },
      error
    );
    return true;
  }

  // 仅 stub 模式生效：放慢单步落库节奏，方便演示监控台的实时刷新。
  private async stubDelay() {
    if (this.mode !== "stub") {
      return;
    }
    const ms = Number(process.env.PLATFORM_STUB_DELAY_MS ?? 0);
    if (!Number.isFinite(ms) || ms <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5000)));
  }

  /** Worker 进程的执行入口：接收父进程重建的最小状态，复用同一套 handler 与 stub。 */
  async invokeLeaf(
    step: CompiledStep,
    input: Record<string, unknown>,
    state: LeafExecutionState
  ): Promise<unknown> {
    return this.invoke(step, input, state);
  }

  private async invoke(
    step: CompiledStep,
    input: Record<string, unknown>,
    state: LeafExecutionState
  ): Promise<unknown> {
    const profile = findLoopProfile(state.loops, step.path);
    const tokenBudget = this.tokenBudgetOf(state);
    const context: ExecutionContext = {
      runId: state.runId,
      workflowId: state.workflowId,
      iteration: state.iteration,
      scope: state.scope,
      loop: profile ? loopScopeOf(profile) : undefined,
      locals: nodeLocals(step.node, input, state.scope, profile),
      knowledgeBaseIds: state.workflowKnowledgeBaseIds,
      tokensUsed: state.tokensUsed,
      tokenBudget,
      stepPath: step.path
    };
    const node = step.node;
    // 演示/演练用：PLATFORM_FAIL_NODE_IDS 让 stub 在指定节点抛错，用于验证重试与回滚。
    if (this.mode === "stub" && this.injectedFailures.has(node.id)) {
      throw new Error(`[stub] 注入失败：节点 ${node.id}`);
    }
    if (node.kind === "start") {
      return {
        mode: this.mode,
        kind: "start",
        summary: `流程开始 · ${Object.keys(state.scope.input).length} 个输入`,
        input: state.scope.input,
        output: state.scope.input
      };
    }
    if (node.kind === "end") {
      return {
        mode: this.mode,
        kind: "end",
        summary: `流程结束 · ${Object.keys(input).length} 个输出字段`,
        outputs: input,
        ...input
      };
    }
    if (node.kind === "knowledge") {
      if (this.handlers.knowledgeNode) {
        return await this.handlers.knowledgeNode(node, input, context);
      }
      return stubKnowledgeNode(node, input, this.mode);
    }
    if (node.kind === "http") {
      if (this.handlers.http) {
        return await this.handlers.http(node, input, context);
      }
      return stubHttpNode(node, input, this.mode);
    }
    if (node.kind === "agent") {
      return this.handlers.agent ? await this.handlers.agent(node, input, context) : stubAgent(node, input);
    }
    if (node.kind === "llm") {
      return this.handlers.llm ? await this.handlers.llm(node, input, context) : stubLlm(node, input);
    }
    if (node.kind === "template") {
      const rendered = resolveValue(node.template, state.scope, profile, context.locals);
      return {
        mode: this.mode,
        kind: "template",
        template: node.template,
        summary: `[${this.mode}] 模板渲染 ${node.title ?? node.id}`,
        output: stringify(rendered),
        value: rendered,
        inputs: input
      };
    }
    if (node.kind === "tool") {
      if (this.handlers.trainingTool) {
        const handled = await this.handlers.trainingTool(node, input, context);
        if (handled !== undefined) {
          return handled;
        }
      }
      if (this.handlers.knowledgeTool) {
        const handled = await this.handlers.knowledgeTool(node, input, context);
        if (handled !== undefined) {
          return handled;
        }
      }
      if (this.handlers.tool) {
        return await this.handlers.tool(node, input, context);
      }
      if (this.handlers.mcpTool) {
        const handled = await this.handlers.mcpTool(node, input, context);
        if (handled !== undefined) {
          return handled;
        }
      }
      return stubTool(node, input);
    }
    if (node.kind !== "verify") {
      throw new PlatformError(`${node.kind} 节点必须走专用执行路径。`, 500);
    }
    if (this.handlers.verify) {
      return this.handlers.verify(node, input, context);
    }
    return this.verifier.evaluateAsync({
      node,
      artifact: input.artifact,
      artifactNodeId: typeof input.targetNodeId === "string" ? input.targetNodeId : undefined,
      evidence: normalizeEvidence(input.evidence),
      reference: input.reference,
      attempt: state.scope.verifyRounds + 1,
      mode: this.mode,
      agents: this.releaseAgents(state, this.store.listAgents()),
      budgetExceeded: tokenBudget > 0 && state.tokensUsed >= tokenBudget
    });
  }

  /** 父进程按执行器配置；Worker 进程按调用方随消息带来的预算，两者保持同口径。 */
  private tokenBudgetOf(state: LeafExecutionState) {
    return state.tokenBudget ?? this.options.tokenBudget;
  }
}

function snapshotScope(scope: RunScope, iteration: number): ScopeSnapshot {
  return {
    iteration,
    score: scope.lastVerifyScore,
    artifact: scope.lastArtifact,
    artifactNodeId: scope.lastArtifactNodeId,
    issues: scope.lastVerifyIssues ? [...scope.lastVerifyIssues] : undefined,
    confidence: scope.lastVerifyConfidence,
    passed: scope.lastVerifyPassed,
    layers: scope.lastVerifyLayers,
    outputs: new Map(scope.outputs),
    evidence: [...scope.evidence]
  };
}

/**
 * 恢复最优轮的工作状态。最优轮是初始轮时，循环体节点没有自身输出，
 * 用保留的产物与验证分补位，保证下游 ${revise.output} / ${verify-loop.score} 仍可解析。
 */
function restoreScope(scope: RunScope, snapshot: ScopeSnapshot, bodySteps: CompiledStep[]) {
  scope.outputs = new Map(snapshot.outputs);
  scope.evidence = [...snapshot.evidence];
  scope.lastVerifyScore = snapshot.score;
  scope.lastVerifyIssues = snapshot.issues;
  scope.lastVerifyConfidence = snapshot.confidence;
  scope.lastVerifyPassed = snapshot.passed;
  scope.lastVerifyLayers = snapshot.layers;
  scope.lastArtifact = snapshot.artifact;
  scope.lastArtifactNodeId = snapshot.artifactNodeId;

  for (const step of bodySteps) {
    if (scope.outputs.has(step.nodeId)) {
      continue;
    }
    if (step.node.kind === "verify") {
      scope.outputs.set(step.nodeId, retainedVerifyOutput(snapshot));
    } else if (snapshot.artifact !== undefined) {
      scope.outputs.set(step.nodeId, snapshot.artifact);
    }
  }
}

function retainedVerifyOutput(snapshot: ScopeSnapshot): VerifyOutput {
  return {
    score: snapshot.score ?? 0,
    confidence: snapshot.confidence ?? 0,
    passed: snapshot.passed,
    dimensions: [],
    issues: snapshot.issues ?? [],
    evidence: [],
    layers: snapshot.layers
  };
}

function collectLeafSteps(block: CompiledBlock, acc: CompiledStep[] = []): CompiledStep[] {
  for (const statement of block) {
    if (statement.type === "step") {
      acc.push(statement.step);
    } else if (statement.type === "parallel") {
      for (const branch of statement.branches) {
        collectLeafSteps(branch, acc);
      }
    } else if (statement.type === "condition") {
      collectLeafSteps(statement.then, acc);
      collectLeafSteps(statement.otherwise, acc);
    } else if (statement.type === "subworkflow") {
      collectLeafSteps(statement.program, acc);
    } else {
      collectLeafSteps(statement.body, acc);
    }
  }
  return acc;
}

function retentionNote(best: ScopeSnapshot | undefined, iteration: number): string {
  if (!best) {
    return `循环结束：没有有效验证分，保留第 ${iteration} 轮产物。`;
  }
  if (best.iteration === iteration) {
    return `循环结束：第 ${iteration} 轮为最优，保留该轮产物。`;
  }
  if (best.iteration === 0) {
    return `循环结束：保留初始产物，丢弃第 ${iteration} 轮。`;
  }
  return `循环结束：保留第 ${best.iteration} 轮产物，丢弃第 ${iteration} 轮。`;
}

function isActiveStatus(status: RunStatus): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "verifying" ||
    status === "revising" ||
    status === "waiting_approval" ||
    status === "waiting_input"
  );
}

function stubAgent(node: AgentNode, input: Record<string, unknown>) {
  if (node.outputFormat === "json") {
    if (!node.stubOutput) {
      throw new Error(
        `[stub] 节点「${node.title ?? node.id}」声明 JSON 输出但未配置 stubOutput；请切换到 live 模式或提供离线夹具。`
      );
    }
    return {
      mode: "stub",
      agent: node.agent,
      ...(node.agentVersion === undefined ? {} : { agentVersion: node.agentVersion }),
      summary: `[stub] ${node.title ?? node.id} 已执行（契约夹具）`,
      output: node.stubOutput,
      rawOutput: JSON.stringify(node.stubOutput),
      inputs: input,
      stubFixture: true
    };
  }
  return {
    mode: "stub",
    agent: node.agent,
    ...(node.agentVersion === undefined ? {} : { agentVersion: node.agentVersion }),
    summary: `[stub] ${node.title ?? node.id} 已执行`,
    output: `[stub:${node.agent}] ${node.title ?? node.id} 的输出`,
    inputs: input
  };
}

/** stub 模式下的模型思考：输出稳定的推理摘要，便于离线演示“思考链”与前端折叠展示。 */
function stubLlm(node: LlmNode, input: Record<string, unknown>) {
  const fields = Object.keys(input);
  const thinking = [
    `目标：${node.title ?? node.id}`,
    `输入：${fields.length > 0 ? fields.join("、") : "无显式字段"}`,
    "步骤：① 识别任务约束与输出格式 → ② 从上游产物提取关键事实 → ③ 组织结构化答复 → ④ 自查遗漏与风险。",
    "自查：结论需与输入一致，不确定信息显式标注，不编造数字与引用。"
  ].join("\n");
  return {
    mode: "stub",
    kind: "llm",
    model: node.model ?? "platform-default",
    summary: `[stub] ${node.title ?? node.id} 已完成模型思考`,
    thinking: node.thinking === false ? undefined : thinking,
    output: `[stub:llm] ${node.title ?? node.id} 的输出`,
    inputs: input
  };
}

/** 原始需求通常来自运行输入里的 request / topic / question 等字段；优先取最像“任务描述”的那个。 */
function extractClarifyRequest(input: Record<string, unknown>): string {
  for (const key of ["request", "topic", "question", "text", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  const strings = Object.entries(input)
    .filter(([key, value]) => key !== "hint" && key !== "selfLoop" && typeof value === "string" && value.trim() !== "")
    .map(([, value]) => (value as string).trim());
  if (strings.length > 0) {
    return strings.join("\n");
  }
  return "（运行输入未提供可读的任务描述）";
}

function normalizeClarifyAnalysis(raw: unknown, rawPrompt: string): IntentAnalysis {
  const record = isRecord(raw) && isRecord(raw.output) ? raw.output : isRecord(raw) ? raw : {};
  const ambiguities: ClarifyAmbiguity[] = Array.isArray(record.ambiguities)
    ? record.ambiguities
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          slot: clarifyText(item.slot) || "未命名",
          question: clarifyText(item.question),
          impact: clarifyImpact(item.impact)
        }))
        .filter((item) => item.question !== "")
        .slice(0, 5)
    : [];
  const confidence = clarifyNumber(record.confidence);
  return {
    taskType: clarifyText(record.taskType) || "通用任务",
    goal: clarifyText(record.goal) || rawPrompt.slice(0, 120),
    audience: clarifyText(record.audience) || undefined,
    deliverable: clarifyText(record.deliverable) || "可执行交付物",
    constraints: stringList(record.constraints),
    ambiguities,
    assumptions: stringList(record.assumptions),
    needsClarification:
      typeof record.needsClarification === "boolean"
        ? record.needsClarification
        : ambiguities.some((item) => item.impact === "high"),
    confidence: confidence ?? 0.6
  };
}

function normalizeClarifyRewrite(raw: unknown): {
  rewrittenPrompt: string;
  changes: string[];
  guardrail: { ok: boolean; unexpected: string[] };
} {
  const record = isRecord(raw) && isRecord(raw.output) ? raw.output : isRecord(raw) ? raw : {};
  const rewrittenPrompt = clarifyText(record.rewrittenPrompt);
  if (rewrittenPrompt === "") {
    throw new Error("意图澄清节点未返回改写后的 Prompt。");
  }
  const guardrail = isRecord(record.guardrail) ? record.guardrail : {};
  return {
    rewrittenPrompt,
    changes: stringList(record.changes),
    guardrail: {
      ok: guardrail.ok !== false,
      unexpected: stringList(guardrail.unexpected)
    }
  };
}

function shouldPauseForClarification(node: ClarifyNode, analysis: IntentAnalysis): boolean {
  const mode = node.clarifyOn ?? "high";
  if (mode === "never" || !analysis.needsClarification) {
    return false;
  }
  return mode === "any" || analysis.ambiguities.some((item) => item.impact === "high");
}

function clarifyQuestionsOf(analysis: IntentAnalysis, node: ClarifyNode): string[] {
  const limit = Math.min(3, Math.max(1, node.maxQuestions ?? 2));
  // 默认只追问会改变交付结果的 high 歧义；clarifyOn=any 时才把中低影响项一并列出。
  const byMode =
    (node.clarifyOn ?? "high") === "any"
      ? analysis.ambiguities
      : analysis.ambiguities.filter((item) => item.impact === "high");
  const relevant = byMode.length > 0 ? byMode : analysis.ambiguities;
  const ordered = [...relevant].sort(
    (left, right) => clarifyImpactWeight(right.impact) - clarifyImpactWeight(left.impact)
  );
  const questions = ordered.map((item) => item.question).filter(Boolean).slice(0, limit);
  return questions.length > 0
    ? questions
    : ["请补充交付对象、范围与验收标准，平台会据此改写任务。"];
}

function buildClarifyInteractionPrompt(questions: string[]): string {
  return [
    "以下信息会影响交付结果，请补充确认：",
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    "可直接回答，也可以补充其他约束；没有补充可留空。"
  ].join("\n");
}

function stubClarifyAnalysis(
  node: ClarifyNode,
  input: Record<string, unknown>,
  mode: string
): Record<string, unknown> {
  const stub = isRecord(node.stubOutput) ? node.stubOutput : {};
  const rawPrompt = extractClarifyRequest(input);
  const base = {
    taskType: "通用任务",
    goal: rawPrompt.slice(0, 120),
    deliverable: "结构化交付物",
    constraints: [],
    ambiguities: [],
    assumptions: [],
    needsClarification: false,
    confidence: 0.8
  };
  return {
    ...base,
    ...stub,
    mode,
    output: stub
  };
}

function stubClarifyRewrite(
  node: ClarifyNode,
  analysis: IntentAnalysis,
  clarification?: ClarifyAnswer
): Record<string, unknown> {
  const stub = isRecord(node.stubOutput) ? node.stubOutput : {};
  if (typeof stub.rewrittenPrompt === "string" && stub.rewrittenPrompt.trim() !== "") {
    return {
      rewrittenPrompt: stub.rewrittenPrompt.trim(),
      changes: stringList(stub.changes),
      guardrail: { ok: true, unexpected: [] as string[] }
    };
  }
  const sections = [
    `# 目标\n${analysis.goal}`,
    `# 已知条件\n- 原始需求：${analysis.goal}\n${
      analysis.constraints.length > 0 ? analysis.constraints.map((item) => `- 约束：${item}`).join("\n") : "- 无显式约束"
    }`,
    `# 待确认假设\n${
      analysis.assumptions.length > 0
        ? analysis.assumptions.map((item) => `- ${item}`).join("\n")
        : "- 无额外假设"
    }${clarification?.answer ? `\n- 人工补充：${clarification.answer}` : ""}`,
    `# 交付格式\n${analysis.deliverable}`,
    "# 验收标准\n- 结论可追溯到原始需求\n- 不引入原始输入与澄清回答之外的事实或数字"
  ];
  return {
    rewrittenPrompt: sections.join("\n\n"),
    changes: ["补充了目标、交付格式与验收标准"],
    guardrail: { ok: true, unexpected: [] as string[] }
  };
}

function clarifyText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clarifyNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : undefined;
}

function clarifyImpact(value: unknown): ClarifyAmbiguity["impact"] {
  const text = clarifyText(value).toLowerCase();
  return text === "high" || text === "low" ? text : "medium";
}

function clarifyImpactWeight(impact: ClarifyAmbiguity["impact"]): number {
  return impact === "high" ? 3 : impact === "medium" ? 2 : 1;
}

function stubTool(node: ToolNode, input: Record<string, unknown>) {
  // 只有真实知识库检索才能产生 citation；普通 stub 工具不伪造引用，避免证据检查假通过。
  return {
    mode: "stub",
    tool: node.tool,
    summary: `[stub] ${node.title ?? node.id} 已执行`,
    output: `[stub:${node.tool}] ${node.title ?? node.id} 的输出`,
    args: input
  };
}

/** stub 知识检索不伪造引用，只返回明确的“无可引用片段”提示。 */
function stubKnowledgeNode(node: KnowledgeNode, input: Record<string, unknown>, mode: string) {
  const query = typeof input.query === "string" ? input.query : "";
  return {
    mode,
    kind: "knowledge",
    tool: "knowledge.search",
    summary: `[${mode}] 知识库检索「${query || node.title || node.id}」`,
    query,
    knowledgeBaseIds: stringList(input.knowledgeBaseIds),
    citations: [],
    output: "知识库未召回可引用片段，请基于学科常识作答并说明缺少资料支撑。",
    args: input
  };
}

/** stub HTTP 不发起网络请求，避免默认演示产生外呼与不可控延迟。 */
function stubHttpNode(node: HttpNode, input: Record<string, unknown>, mode: string) {
  const method = typeof input.method === "string" ? input.method : node.method;
  const url = typeof input.url === "string" ? input.url : node.url;
  return {
    mode,
    kind: "http",
    method,
    url,
    status: 0,
    ok: false,
    summary: `[${mode}] 未发起 HTTP 请求 ${method} ${url}`,
    output: `[${mode}:http] ${method} ${url} 未实际发送；配置 live 执行器后才会调用外部 API。`,
    headers: Object.keys(node.headers ?? {}),
    requestBody: input.body
  };
}

function normalizeVerifyOutput(value: unknown): VerifyOutput {
  if (typeof value !== "object" || value === null) {
    throw new PlatformError("verify 节点必须返回对象结果", 500);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.score !== "number" || Number.isNaN(record.score)) {
    throw new PlatformError("verify 节点返回值缺少 score 数值", 500);
  }
  return {
    ...record,
    score: Math.min(1, Math.max(0, record.score)),
    confidence: typeof record.confidence === "number" ? Math.min(1, Math.max(0, record.confidence)) : 0.5,
    dimensions: Array.isArray(record.dimensions) ? (record.dimensions as VerifyDimension[]) : [],
    issues: stringList(record.issues),
    evidence: stringList(record.evidence)
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

const MAX_EVIDENCE = 32;

/** 吸收任一节点产物里的 citation（含嵌套在 inputs/outputs 中的对象），写入当前作用域证据池。 */
function statementNodeId(statement: CompiledStatement): string {
  return statement.type === "step" ? statement.step.nodeId : statement.nodeId;
}

function statementPath(statement: CompiledStatement): string {
  return statement.type === "step" ? statement.step.path : statement.path;
}

function statementKind(statement: CompiledStatement): NodeKind {
  return statement.type === "step" ? statement.step.node.kind : statement.type;
}

/**
 * 会改写共享运行态的语句独占执行：容器会切换作用域/循环栈，验证会改写验证态。
 * 普通步骤共享执行；审批只等待外部决策，不占锁，避免一个待审节点冻结其他分支。
 */
function lockModeForStatement(statement: CompiledStatement): "read" | "write" | undefined {
  if (statement.type !== "step") {
    return "write";
  }
  if (statement.step.node.kind === "verify") {
    return "write";
  }
  if (statement.step.node.kind === "approve") {
    return undefined;
  }
  if (statement.step.node.kind === "human" || statement.step.node.kind === "clarify") {
    return undefined;
  }
  // 参数提取可能在等用户补参数，占着锁会把别的分支一起冻住。
  if (statement.step.node.kind === "extract") {
    return undefined;
  }
  return "read";
}

/**
 * 顶层 DAG 的读写锁：普通步骤共享执行；容器/审批/验证独占执行。
 * 队列按 FIFO 放行，写锁等待时后来的读请求不能插队，避免独占节点被并发分支长期饿死。
 */
class AsyncReadWriteLock {
  private readers = 0;
  private writer = false;
  private readonly queue: Array<{
    mode: "read" | "write";
    resolve: (release: () => void) => void;
  }> = [];

  acquire(mode: "read" | "write"): Promise<() => void> {
    return new Promise((resolve) => {
      this.queue.push({ mode, resolve });
      this.drain();
    });
  }

  private drain() {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (next.mode === "write") {
        if (this.writer || this.readers > 0) {
          return;
        }
        this.writer = true;
        this.queue.shift();
        next.resolve(() => {
          this.writer = false;
          this.drain();
        });
        return;
      }
      if (this.writer) {
        return;
      }
      this.readers += 1;
      this.queue.shift();
      next.resolve(() => {
        this.readers -= 1;
        this.drain();
      });
    }
  }
}

function absorbEvidence(scope: RunScope, output: unknown) {
  const incoming = collectCitations(output);
  if (incoming.length > 0) {
    scope.evidence = mergeEvidence(scope.evidence, incoming);
  }
}

function mergeEvidence(...pools: string[][]): string[] {
  const merged = pools
    .flat()
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(merged)].slice(0, MAX_EVIDENCE);
}

function verifyDetail(verification: VerifyOutput): Record<string, unknown> | undefined {
  const detail: Record<string, unknown> = {};
  if (verification.layers) {
    detail.layers = verification.layers;
  }
  if (verification.verifiers) {
    detail.verifiers = verification.verifiers;
  }
  if (verification.citations) {
    detail.citations = verification.citations;
  }
  if (verification.independence) {
    detail.independence = verification.independence;
  }
  if (verification.artifactNodeId) {
    detail.artifactNodeId = verification.artifactNodeId;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAgentJsonOutput(node: AgentNode, raw: unknown): unknown {
  if (node.outputFormat !== "json") {
    return raw;
  }
  const record = isRecord(raw) ? raw : undefined;
  const text =
    typeof raw === "string"
      ? raw
      : typeof record?.output === "string"
        ? record.output
        : undefined;
  const candidate =
    text !== undefined
      ? parseJsonPayload(text, node)
      : isRecord(record?.output)
        ? record.output
        : undefined;
  if (!candidate) {
    throw new Error(
      `Agent「${node.agent}」在节点「${node.title ?? node.id}」未返回可解析的 JSON 对象。`
    );
  }
  const parsed = candidate;
  const required = node.outputContract?.required ?? [];
  const missing = required.filter((key) => parsed[key] === undefined || parsed[key] === null || parsed[key] === "");
  if (missing.length > 0) {
    throw new Error(
      `Agent「${node.agent}」的 JSON 输出缺少必填字段：${missing.join("、")}。`
    );
  }
  for (const [key, allowed] of Object.entries(node.outputContract?.enums ?? {})) {
    const value = parsed[key];
    if (value !== undefined && !allowed.includes(String(value))) {
      throw new Error(
        `Agent「${node.agent}」的字段「${key}」取值「${String(value)}」不在允许范围：${allowed.join(" / ")}。`
      );
    }
  }
  return {
    ...(record ?? { mode: "live", agent: node.agent }),
    output: parsed,
    rawOutput: text ?? JSON.stringify(parsed)
  };
}

function parseJsonPayload(text: string, node: AgentNode): Record<string, unknown> | undefined {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const body = (fenced?.[1] ?? trimmed).trim();
  for (const candidate of [body, body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)]) {
    if (!candidate || !candidate.startsWith("{") || !candidate.endsWith("}")) {
      continue;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // 继续尝试下一个候选片段。
    }
  }
  throw new Error(
    `Agent「${node.agent}」在节点「${node.title ?? node.id}」返回的 JSON 无法解析：${trimmed.slice(0, 160)}`
  );
}

function validatePromptPatch(patch: string): string | undefined {
  const text = patch.trim();
  if (text.length < 20) {
    return "补丁少于 20 个字符，信息量不足。";
  }
  if (text.length > 800) {
    return "补丁超过 800 个字符，拒绝整段重写。";
  }
  if (/参考答案|reference\s*answer/i.test(text)) {
    return "补丁引用了参考答案，拒绝泄漏验证基准。";
  }
  for (const match of text.matchAll(/(?<![\d.])(\d{4,})(?![\d.])/g)) {
    const value = Number(match[1]);
    if (!(value >= 1900 && value <= 2099)) {
      return `补丁包含疑似答案数字 ${match[1]}，拒绝把具体结果写进提示词。`;
    }
  }
  return undefined;
}

function previewPatch(patch: string) {
  const text = patch.trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findLoopFrame(state: RunState, path: string): LoopFrame | undefined {
  for (let index = state.loops.length - 1; index >= 0; index -= 1) {
    const frame = state.loops[index];
    if (path === frame.path || path.startsWith(`${frame.path}/`)) {
      return frame;
    }
  }
  return undefined;
}

/** 与 findLoopFrame 相同的匹配规则，但只要求 ${loop.*} 需要的字段，供 Worker 重建状态使用。 */
function findLoopProfile(loops: LoopProfile[], path: string): LoopProfile | undefined {
  for (let index = loops.length - 1; index >= 0; index -= 1) {
    const frame = loops[index];
    if (path === frame.path || path.startsWith(`${frame.path}/`)) {
      return frame;
    }
  }
  return undefined;
}

/** 会走 invoke 的叶子节点；approve/human/clarify 由父进程专用路径处理。 */
function isPoolLeafKind(kind: NodeKind) {
  return (
    kind === "start" ||
    kind === "end" ||
    kind === "agent" ||
    kind === "llm" ||
    kind === "template" ||
    kind === "tool" ||
    kind === "knowledge" ||
    kind === "http" ||
    kind === "verify"
  );
}

function buildLoopDirective(
  frame: LoopFrame,
  iteration: number,
  previousScore: number | undefined,
  threshold: number
): Record<string, unknown> {
  return {
    iteration,
    action: frame.action,
    actionLabel: actionLabel(frame.action),
    targetScore: threshold,
    previousScore,
    issues: frame.issues,
    reason: frame.actionReason,
    budget: {
      maxDurationMs: frame.controller.policy.budget.maxDurationMs,
      maxTokens: frame.controller.policy.budget.maxTokens
    },
    ...(frame.currentAgentId ? { agentId: frame.currentAgentId } : {}),
    ...(frame.previousAgentId ? { previousAgentId: frame.previousAgentId } : {}),
    ...(frame.currentModelId ? { modelId: frame.currentModelId } : {}),
    ...(frame.previousModelId ? { previousModelId: frame.previousModelId } : {}),
    ...(frame.retrievalQuery ? { retrievalQuery: frame.retrievalQuery } : {}),
    ...(frame.promptPatch ? { promptPatch: frame.promptPatch } : {})
  };
}

function findFirstAgentStep(block: CompiledBlock): CompiledStep | undefined {
  for (const statement of block) {
    if (
      statement.type === "step" &&
      statement.step.node.kind === "agent" &&
      statement.step.node.loopRole !== "diagnose"
    ) {
      return statement.step;
    }
    if (statement.type === "parallel") {
      for (const branch of statement.branches) {
        const found = findFirstAgentStep(branch);
        if (found) {
          return found;
        }
      }
    }
    if (statement.type === "condition") {
      const found = findFirstAgentStep(statement.then) ?? findFirstAgentStep(statement.otherwise);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function findVerifyThreshold(block: CompiledBlock): number | undefined {
  for (const statement of block) {
    if (statement.type === "step" && statement.step.node.kind === "verify") {
      return statement.step.node.threshold ?? 0.8;
    }
    if (statement.type === "parallel") {
      for (const branch of statement.branches) {
        const found = findVerifyThreshold(branch);
        if (found !== undefined) {
          return found;
        }
      }
    }
    if (statement.type === "condition") {
      const found =
        findVerifyThreshold(statement.then) ?? findVerifyThreshold(statement.otherwise);
      if (found !== undefined) {
        return found;
      }
    }
    if (statement.type === "loop") {
      const found = findVerifyThreshold(statement.body);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

function serializeRunScope(scope: RunScope): Record<string, unknown> {
  return {
    input: scope.input,
    outputs: [...scope.outputs.entries()],
    evidence: scope.evidence,
    verifyRounds: scope.verifyRounds,
    lastVerifyScore: scope.lastVerifyScore,
    lastVerifyIssues: scope.lastVerifyIssues,
    lastVerifyConfidence: scope.lastVerifyConfidence,
    lastVerifyPassed: scope.lastVerifyPassed,
    lastVerifyLayers: scope.lastVerifyLayers,
    lastArtifact: scope.lastArtifact,
    lastArtifactNodeId: scope.lastArtifactNodeId
  };
}

/** 解析检查点；格式不符时返回 undefined，由调用方给出可读错误。 */
function parseCheckpointState(raw: Record<string, unknown>): ResumeData | undefined {
  if (raw.version !== 1 || !isRecord(raw.scope) || !isRecord(raw.nodes)) {
    return undefined;
  }
  const scopeRaw = raw.scope;
  const outputsRaw = Array.isArray(scopeRaw.outputs) ? scopeRaw.outputs : [];
  const outputs = new Map<string, unknown>();
  for (const entry of outputsRaw) {
    if (Array.isArray(entry) && typeof entry[0] === "string") {
      outputs.set(entry[0], entry[1]);
    }
  }
  const scope: RunScope = {
    input: isRecord(scopeRaw.input) ? scopeRaw.input : {},
    outputs,
    evidence: Array.isArray(scopeRaw.evidence)
      ? scopeRaw.evidence.filter((item): item is string => typeof item === "string")
      : [],
    verifyRounds: Number(scopeRaw.verifyRounds) || 0,
    ...(typeof scopeRaw.lastVerifyScore === "number"
      ? { lastVerifyScore: scopeRaw.lastVerifyScore }
      : {}),
    ...(Array.isArray(scopeRaw.lastVerifyIssues)
      ? {
          lastVerifyIssues: scopeRaw.lastVerifyIssues.filter(
            (item): item is string => typeof item === "string"
          )
        }
      : {}),
    ...(typeof scopeRaw.lastVerifyConfidence === "number"
      ? { lastVerifyConfidence: scopeRaw.lastVerifyConfidence }
      : {}),
    ...(typeof scopeRaw.lastVerifyPassed === "boolean"
      ? { lastVerifyPassed: scopeRaw.lastVerifyPassed }
      : {}),
    ...(isRecord(scopeRaw.lastVerifyLayers)
      ? { lastVerifyLayers: scopeRaw.lastVerifyLayers as VerifyLayers }
      : {}),
    ...(scopeRaw.lastArtifact !== undefined ? { lastArtifact: scopeRaw.lastArtifact } : {}),
    ...(typeof scopeRaw.lastArtifactNodeId === "string"
      ? { lastArtifactNodeId: scopeRaw.lastArtifactNodeId }
      : {})
  };
  const nodes = new Map<string, { status: "succeeded" | "skipped"; output?: unknown }>();
  for (const [nodeId, value] of Object.entries(raw.nodes)) {
    if (!isRecord(value) || (value.status !== "succeeded" && value.status !== "skipped")) {
      continue;
    }
    nodes.set(nodeId, {
      status: value.status,
      ...(value.output !== undefined ? { output: value.output } : {})
    });
  }
  const assignments = new Map<string, string>();
  if (Array.isArray(raw.assignments)) {
    for (const entry of raw.assignments) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
        assignments.set(entry[0], entry[1]);
      }
    }
  }
  return {
    sequence: Number(raw.sequence) || 0,
    iteration: Number(raw.iteration) || 0,
    tokensUsed: Number(raw.tokensUsed) || 0,
    loopSummaries: Array.isArray(raw.loopSummaries)
      ? (raw.loopSummaries as SelfLoopSummary[])
      : [],
    assignments,
    nodes,
    scope
  };
}

function serializeScope(scope: RunScope): string {
  return JSON.stringify({
    outputs: Object.fromEntries(scope.outputs),
    verifyRounds: scope.verifyRounds,
    lastVerifyScore: scope.lastVerifyScore
  });
}

function resolveExecutorOptions(options: ExecutorOptions): ResolvedExecutorOptions {
  return {
    maxAttempts: clampInt(
      options.maxAttempts ?? envInt("PLATFORM_STEP_MAX_ATTEMPTS", 3),
      1,
      10
    ),
    timeoutMs: clampInt(
      options.timeoutMs ?? envInt("PLATFORM_STEP_TIMEOUT_MS", 30000),
      0,
      600000
    ),
    retryBaseDelayMs: clampInt(
      options.retryBaseDelayMs ?? envInt("PLATFORM_RETRY_BASE_MS", 200),
      0,
      10000
    ),
    retryMaxDelayMs: clampInt(
      options.retryMaxDelayMs ?? envInt("PLATFORM_RETRY_MAX_DELAY_MS", 2000),
      0,
      60000
    ),
    maxConcurrency: clampInt(
      options.maxConcurrency ?? envInt("PLATFORM_MAX_CONCURRENCY", 4),
      1,
      16
    ),
    schedulerCapacity: clampInt(
      options.schedulerCapacity ??
        envInt("PLATFORM_SCHEDULER_CAPACITY", options.maxConcurrency ?? envInt("PLATFORM_MAX_CONCURRENCY", 4)),
      1,
      64
    ),
    schedulerPolicy: options.schedulerPolicy ?? "dynamic",
    cancelPollMs: clampInt(
      options.cancelPollMs ?? envInt("PLATFORM_CANCEL_POLL_MS", 500),
      0,
      60000
    ),
    maxResumes: clampInt(options.maxResumes ?? envInt("PLATFORM_MAX_RESUMES", 3), 0, 20),
    rollbackOnFailure:
      options.rollbackOnFailure ?? process.env.PLATFORM_ROLLBACK_ON_FAILURE === "true",
    approvalTimeoutMs: clampInt(
      options.approvalTimeoutMs ?? envInt("PLATFORM_APPROVAL_TIMEOUT_MS", 600000),
      1000,
      86_400_000
    ),
    humanTimeoutMs: clampInt(
      options.humanTimeoutMs ?? envInt("PLATFORM_HUMAN_TIMEOUT_MS", 1_800_000),
      1000,
      86_400_000
    ),
    tokenBudget: clampInt(
      options.tokenBudget ?? envInt("PLATFORM_RUN_TOKEN_BUDGET", 0),
      0,
      100_000_000
    ),
    onStatusChange: options.onStatusChange,
    releaseProvider: options.releaseProvider,
    onRunFinished: options.onRunFinished,
    onPromptCandidate: options.onPromptCandidate
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  // .env 里「留空表示用默认」的配置项必须走 fallback：Number("") 是 0，
  // 会被 clampInt 抬到下限（调度容量因此被压成 1，一个人工等待点就堵死全局队列）。
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * 选项来源：手动填的 options，或 optionsFrom 指向的数组（动态拉取）。
 * 引用解析留在这里（要用 scope/locals），收敛与去重交给 humanChoices 模块。
 */
function humanChoices(
  node: HumanNode,
  scope: RunScope,
  locals: Record<string, unknown>
): string[] {
  const raw = node.optionsFrom?.trim()
    ? resolveValue(node.optionsFrom, scope, undefined, locals)
    : node.options;
  return normalizeChoices(raw);
}

/**
 * 节点自己声明的输入变量：name → 已解析的值。
 * 执行器取上游产物一直只认 ${节点id.字段}，入参表因此只能看不能用；
 * 补上这层后，正文里写 ${template} 就能直接拿到「输入变量」里配的那份值。
 */
function nodeLocals(
  node: WorkflowNode,
  input: Record<string, unknown>,
  scope: RunScope,
  frame?: LoopProfile
): Record<string, unknown> {
  const locals: Record<string, unknown> = { ...input };
  for (const binding of node.inputBindings ?? []) {
    const name = typeof binding.name === "string" ? binding.name.trim() : "";
    if (!name) {
      continue;
    }
    if (binding.value !== undefined && binding.value !== null && binding.value !== "") {
      locals[name] = resolveValue(binding.value, scope, frame);
    } else if (locals[name] === undefined && binding.defaultValue !== undefined) {
      locals[name] = binding.defaultValue;
    }
  }
  return locals;
}

/** 追问轮次上限：再多也是在原地打转，重跑一次比无限追问更省事。 */
const EXTRACT_MAX_ROUNDS = 5;

/** 参数表去重、补默认值；名字为空的草稿行直接丢掉，不让它变成空表单。 */
export function normalizeExtractParams(params: ExtractParam[] | undefined): ExtractParam[] {
  const seen = new Set<string>();
  const list: ExtractParam[] = [];
  for (const raw of params ?? []) {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    list.push({ ...raw, name, required: raw.required !== false });
  }
  return list;
}

function clampExtractRounds(value: number | undefined, paramCount = 1): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.min(EXTRACT_MAX_ROUNDS, Math.max(3, paramCount));
  }
  return Math.min(EXTRACT_MAX_ROUNDS, Math.max(1, Math.trunc(value)));
}

/**
 * 待抽取的正文：输入里的字符串值按顺序拼起来。
 * 数组 / 对象不拼——上游整段 JSON 丢给模型只会稀释注意力，反而抽不准。
 */
function extractTranscriptOf(input: Record<string, unknown>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(input)) {
    if (typeof value !== "string") {
      continue;
    }
    const text = value.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    parts.push(text);
  }
  return parts.join("\n");
}

/** 输入变量里同名参数的直接取值；空串、空数组一律当作「没有」。 */
function directParamValue(input: Record<string, unknown>, name: string): unknown {
  const value = input[name];
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function coerceExtractValue(value: unknown, param: ExtractParam): unknown {
  if (param.type === "number") {
    const numeric = typeof value === "number" ? value : Number(String(value).trim());
    return Number.isFinite(numeric) ? numeric : value;
  }
  if (param.type === "boolean") {
    if (typeof value === "boolean") {
      return value;
    }
    const text = String(value).trim().toLowerCase();
    if (["true", "是", "yes", "1"].includes(text)) {
      return true;
    }
    if (["false", "否", "no", "0"].includes(text)) {
      return false;
    }
    return value;
  }
  return typeof value === "string" ? value.trim() : value;
}

function isFilledValue(value: unknown): boolean {
  if (value === undefined || value === null) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim() !== "";
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

function missingExtractParams(
  params: ExtractParam[],
  collected: Record<string, unknown>
): ExtractParam[] {
  return params.filter((param) => param.required !== false && !isFilledValue(collected[param.name]));
}

/**
 * 模型 / 夹具返回的结果统一成「参数名 → 值」。
 * 有的模型会套一层 params / fields / values，这里就地摊平，不要求提示词百分百听话。
 */
function extractRecordOf(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const nested = record.params ?? record.fields ?? record.values;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return { ...record, ...(nested as Record<string, unknown>) };
  }
  return record;
}

function extractLabelOf(param: ExtractParam): string {
  const label = param.label?.trim();
  return label || param.name;
}

/** 追问表单里的一个字段：就是参数本身，名字用参数名，答案才能直接落回变量。 */
function extractFieldOf(param: ExtractParam): HumanField {
  return {
    key: param.name,
    label: extractLabelOf(param),
    type: param.type === "number" ? "number" : "textarea",
    required: true,
    placeholder: param.description?.trim() || `请输入${extractLabelOf(param)}`
  };
}

/**
 * 追问话术：askPrompt 是用户自己写的主句，参数说明补在后面。
 * 两句都空的时候给一句通用说明，总比弹一张没有标题的空表单强。
 */
function buildExtractAskPrompt(
  node: ExtractNode,
  missing: ExtractParam[],
  input: Record<string, unknown>,
  state: RunState,
  frame?: LoopProfile
): string {
  const locals = nodeLocals(node, input, state.scope, frame);
  const configured = node.askPrompt?.trim()
    ? String(resolveValue(node.askPrompt.trim(), state.scope, frame, locals))
    : "";
  const head = configured || "继续之前还需要你补充下面这些信息：";
  const lines = missing.map((param) => {
    // 参数描述只供模型理解「要抽什么」，是内部元数据，不能进回复；
    // 追问话术优先用参数自己的 question，没有才只显示参数名（标签）。
    const hint = param.question?.trim()
      ? String(resolveValue(param.question.trim(), state.scope, frame, locals))
      : "";
    return `· ${extractLabelOf(param)}${hint ? `：${hint}` : ""}`;
  });
  return [head, ...lines].join("\n");
}

/**
 * 离线抽取：只认《》和引号里的内容，抽不到就空着，让追问流程跑起来。
 * 不做花哨猜测——stub 模式下瞎猜一个标题，比明确说「没拿到」更误导人。
 */
export function stubExtract(
  node: ExtractNode,
  params: ExtractParam[],
  transcript: string
): Record<string, unknown> {
  if (node.stubOutput) {
    return node.stubOutput;
  }
  const text = transcript.replace(/\s+/g, " ").trim();
  const quoted = /[《“"]([^》”"]{2,80})[》”"]/.exec(text);
  const result: Record<string, unknown> = {};
  if (!quoted) {
    return result;
  }
  for (const param of params) {
    const probe = `${param.name} ${param.label ?? ""} ${param.description ?? ""}`;
    if (/title|题目|标题|课题/i.test(probe)) {
      result[param.name] = quoted[1].trim();
    }
  }
  return result;
}

function resolveValue(
  value: unknown,
  scope: RunScope,
  frame?: LoopProfile,
  locals?: Record<string, unknown>
): unknown {
  if (typeof value === "string") {
    const whole = value.match(REF_PATTERN);
    if (whole) {
      return resolveRef(whole[1], scope, frame, locals);
    }
    if (value.includes("${")) {
      return value.replace(EMBEDDED_REF_PATTERN, (_match, ref: string) =>
        stringify(resolveRef(ref, scope, frame, locals))
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, scope, frame, locals));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveValue(item, scope, frame, locals)])
    );
  }
  return value;
}

/**
 * 面板上输出契约的预设字段名（Output 分支下的 Answer / Content / Thought）
 * 是展示名，运行时真实产物写在 output / thinking 字段里。
 * 只在原路径完全取不到值时才回退，既有 ${节点.output} 等引用不受影响。
 */
const OUTPUT_CONTRACT_ALIASES: Record<string, string> = {
  Answer: "output",
  Content: "output",
  Thought: "thinking",
  "Output.Answer": "output",
  "Output.Content": "output",
  "Output.Thought": "thinking"
};

function resolveRef(
  ref: string,
  scope: RunScope,
  frame?: LoopProfile,
  locals?: Record<string, unknown>
): unknown {
  const [head, ...rest] = ref.split(".");
  if (head === "loop") {
    return resolveLoopRef(rest, frame);
  }
  const readFrom = (source: unknown, segments: string[]): unknown => {
    let current = source;
    for (const segment of segments) {
      if (current === null || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  };
  // 本节点输入变量优先：${template} 说的是这个节点声明的入参，不是某个同名节点。
  // 取不到（比如变量名下没有这个子字段）再回落到原来的节点输出 / 运行输入。
  if (locals && Object.prototype.hasOwnProperty.call(locals, head)) {
    const local = readFrom(locals[head], rest);
    if (local !== undefined) {
      return local;
    }
  }
  const source: unknown = head === "input" ? scope.input : scope.outputs.get(head);
  const read = (segments: string[]): unknown => readFrom(source, segments);
  const direct = read(rest);
  if (direct !== undefined || head === "input" || rest.length === 0) {
    return direct;
  }
  const alias = OUTPUT_CONTRACT_ALIASES[rest.join(".")];
  if (alias) {
    return read(alias.split("."));
  }
  // ${节点.Output.<自定义字段>}：Output 只是面板里的分组名，运行时字段挂在节点产物根上。
  if (rest[0] === "Output" && rest.length > 1) {
    return read(rest.slice(1));
  }
  return direct;
}

/** 循环作用域：artifact/issues/score/iteration/retrievalQuery 均指向进入本轮前的状态。 */
function resolveLoopRef(path: string[], frame?: LoopProfile): unknown {
  if (!frame || path.length === 0) {
    return undefined;
  }
  const source = loopScopeOf(frame) as unknown as Record<string, unknown>;
  let current: unknown = source[path[0]];
  for (const segment of path.slice(1)) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function loopScopeOf(frame: LoopProfile): LoopScope {
  return {
    artifact: frame.artifact,
    issues: frame.issues,
    score: frame.score,
    iteration: frame.iteration,
    retrievalQuery: frame.retrievalQuery
  };
}

/** 选项卡的兜底端口在这里只做转出，实现在 workflow/choicePorts.ts，诊断也用同一份。 */

/**
 * 同一条出边里，哪些无条件边要给成立的条件分支让位。
 *
 * 「分支节点」在画布上的直觉是二选一：带条件的那条成立就走它，不成立走默认那条。
 * 如果各条边各判各的，两条会一起跑，用户看到的是后面整条链同时亮起来。
 * 所以：只要这个节点存在「带条件的边」，并且其中有条件成立了，
 * 所有「不带条件的边」这一轮都不走。
 * 全无条件（并行编排）或全有条件时完全不干预。
 *
 * @param edges 该节点的出边，只看 when
 * @param open  与 edges 对齐的「这条边本身走不走得通」（端口 + 条件）
 * @returns 被压制的边在 edges 里的下标
 */
export function suppressedFallbacks(
  edges: Array<{ when?: unknown }>,
  open: boolean[]
): Set<number> {
  const suppressed = new Set<number>();
  const gated: number[] = [];
  const plain: number[] = [];
  edges.forEach((edge, index) => {
    (edge.when ? gated : plain).push(index);
  });
  if (gated.length === 0 || plain.length === 0) {
    return suppressed;
  }
  if (!gated.some((index) => open[index])) {
    return suppressed;
  }
  for (const index of plain) {
    suppressed.add(index);
  }
  return suppressed;
}

/**
 * 判断用户选的是第几项。
 *
 * 先精确匹配，再按「忽略空白」匹配一次：选项文本常是从文档里粘过来的，
 * 末尾多个换行、中间夹全角空格都很常见，精确比较会把正常的选择误判成「其他」，
 * 用户点了第一项却走了兜底分支。返回 -1 才是真的没命中。
 */
export function matchChoiceIndex(choices: string[], choice: string): number {
  const exact = choices.indexOf(choice);
  if (exact >= 0) {
    return exact;
  }
  const squash = (value: string) => value.replace(/\s+/g, "");
  const target = squash(choice);
  if (!target) {
    return -1;
  }
  return choices.findIndex((item) => squash(item) === target);
}

/**
 * 出边是否允许激活。
 * 绑了端口的边只认「用户选中的那一项」；没绑端口的边在端口图里一律不放行，
 * 否则一个选项卡连出去的三条分支会同时跑起来。
 *
 * 兜底规则：只有「用户选中的选项压根没画分支、而兜底口确实接了线」时才落到兜底。
 * 以前是命中项没接线就无条件回落，配上一条没绑端口的老连线，就变成
 * 「明明选了第一项、却静悄悄跑去执行兜底分支」——正是这条回落把正常分支顶掉的。
 */
export function branchAllows(
  edge: CompiledEdge,
  scope: RunScope,
  wiredPorts: Map<string, Set<string>>,
  port: string | undefined = edge.fromPort
): boolean {
  const wired = wiredPorts.get(edge.from);
  if (!port) {
    return !wired;
  }
  const index = choiceIndexOf(scope, edge.from);
  const hit = index >= 0 ? choicePortOf(index) : CHOICE_OTHER_PORT;
  if (hit !== CHOICE_OTHER_PORT && !wired?.has(hit)) {
    // 选中的那个选项没有出边：兜底口接了线才算「这一轮走兜底」，没接就什么都不走。
    return port === CHOICE_OTHER_PORT && Boolean(wired?.has(CHOICE_OTHER_PORT));
  }
  return port === hit;
}

/** 选项卡这次选中的是第几项；-1 表示没命中预置选项（走了兜底）。 */
function choiceIndexOf(scope: RunScope, nodeId: string): number {
  const payload = scope.outputs.get(nodeId);
  const record =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
  const index = record?.choiceIndex;
  return typeof index === "number" ? index : -1;
}

/**
 * 边上如果是「源节点的 choice == 某个文本」这种条件，把文本取出来。
 *
 * 这是端口功能上线前表达选项卡分支的唯一办法，升级后这些线没有 fromPort，
 * 只能靠条件里的文本认回对应选项口。认不出或不是这个形状就返回 undefined。
 */
export function choiceConditionValue(edge: CompiledEdge): string | undefined {
  const when = edge.when;
  if (!when || when.operator !== "==") {
    return undefined;
  }
  const [head, ...rest] = when.ref.split(".");
  if (head !== edge.from || rest.join(".") !== CHOICE_FIELD_KEY) {
    return undefined;
  }
  return typeof when.value === "string" ? when.value : undefined;
}

/** 选项端口补位规则在 workflow/choicePorts.ts，运行期与画布共用一份实现。 */
export { CHOICE_OTHER_PORT, choicePortOf, inferChoicePorts, type ChoicePortEdge };

function evaluateExpression(expression: CompiledExpression, scope: RunScope, frame?: LoopFrame): boolean {
  const actual = resolveRef(expression.ref, scope, frame);
  if (!expression.operator) {
    return Boolean(actual);
  }
  const expected = expression.value;
  if (expression.operator === "==") {
    return looseEquals(actual, expected);
  }
  if (expression.operator === "!=") {
    return !looseEquals(actual, expected);
  }
  const left = Number(actual);
  const right = Number(expected);
  if (Number.isNaN(left) || Number.isNaN(right)) {
    return false;
  }
  switch (expression.operator) {
    case "<":
      return left < right;
    case "<=":
      return left <= right;
    case ">":
      return left > right;
    case ">=":
      return left >= right;
  }
}

function normalizeHumanResponse(
  fields: HumanField[],
  raw: Record<string, unknown>
): Record<string, unknown> {
  const declared = new Set(fields.map((field) => field.key));
  const values: Record<string, unknown> = fields.length === 0
    ? { ...raw }
    : Object.fromEntries(
        Object.entries(raw).filter(([key]) => declared.has(key))
      );

  for (const field of fields) {
    let value = values[field.key];
    if (value === undefined || value === "") {
      if (field.defaultValue !== undefined) {
        value = field.defaultValue;
        values[field.key] = value;
      } else if (field.required) {
        throw new PlatformError(`字段「${field.label}」不能为空。`, 400);
      } else {
        continue;
      }
    }

    const type = field.type ?? "text";
    if (type === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new PlatformError(`字段「${field.label}」必须是数字。`, 400);
      }
      values[field.key] = parsed;
      continue;
    }
    if (type === "boolean") {
      if (typeof value !== "boolean") {
        throw new PlatformError(`字段「${field.label}」必须是布尔值。`, 400);
      }
      continue;
    }
    if (typeof value !== "string") {
      throw new PlatformError(`字段「${field.label}」必须是字符串。`, 400);
    }
    if (type === "select") {
      // 选项卡的 choice 字段允许写不在列表里的内容——那就是「其他」兜底口。
      // 其余下拉字段仍然只认预置值。
      if (field.key === CHOICE_FIELD_KEY) {
        values[field.key] = value.trim();
        continue;
      }
      if (!(field.options ?? []).includes(value)) {
        throw new PlatformError(
          `字段「${field.label}」只能是 ${field.options?.join(" / ") ?? "预置选项"}。`,
          400
        );
      }
    }
  }

  return values;
}

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "number") {
    return Number(actual) === expected;
  }
  if (typeof expected === "boolean") {
    return Boolean(actual) === expected;
  }
  // 条件比较前先归一化：推理模型会把答案包在思考块里，分类词后常带句号或引号，
  // 不剥掉的话「分类词 == 科研规划」这种路由条件永远匹配不上，整条流程全部跳过。
  return normalizeConditionText(String(actual)) === normalizeConditionText(String(expected));
}

/**
 * 边条件比较用的文本归一化：
 * 1) 剥掉推理模型的 <think>…</think> 思考块；
 * 2) 去掉包裹整段值的成对引号（中英皆可）；
 * 3) 去掉首尾空白和句末标点。
 * 只做首尾清理，不动中间内容，避免误伤正常比较。
 */
export function normalizeConditionText(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^["'“”「『]+/, "")
    .replace(/["'“”」』]+$/, "")
    .replace(/[。．.!！?？、,，；;：:\s]+$/g, "")
    .trim();
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
