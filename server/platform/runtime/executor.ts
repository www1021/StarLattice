import {
  PlatformError,
  type AgentNode,
  type ApprovalDecision,
  type ApprovalRecord,
  type ApproveNode,
  type CompiledBlock,
  type CompiledExpression,
  type CompiledStatement,
  type CompiledStep,
  type LlmNode,
  type PlatformRunView,
  type RunMode,
  type RunRecord,
  type RunStatus,
  type StepRecord,
  type SubWorkflowNode,
  type TemplateNode,
  type ToolNode,
  type VerifyDimension,
  type VerifyNode,
  type WorkflowDefinition
} from "../types.js";
import { ApprovalGate, type ApprovalOutcome } from "./approvalGate.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { assignmentsOf, buildWorkflowSchedule } from "../scheduler/planner.js";
import {
  actionLabel,
  estimateTokens,
  SelfLoopController,
  type SelfLoopAction,
  type SelfLoopStopReason,
  type SelfLoopSummary
} from "../selfLoop/controller.js";
import {
  heuristicDimensionScorer,
  LayeredVerifier,
  normalizeEvidence,
  stubDimensionScorer,
  type DimensionScorer,
  type VerifyLayers,
  type VerifyReport
} from "../verify/verifier.js";
import type { PlatformStateStore } from "./stateStore.js";

const REF_PATTERN = /^\$\{([^}\s]+)\}$/;
const EMBEDDED_REF_PATTERN = /\$\{([^}\s]+)\}/g;

type RunScope = {
  input: Record<string, unknown>;
  outputs: Map<string, unknown>;
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

export type ExecutionContext = {
  runId: string;
  workflowId: string;
  iteration: number;
  scope: RunScope;
  loop?: LoopScope;
};

export type ExecutorHandlers = {
  agent?: (node: AgentNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  llm?: (node: LlmNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  tool?: (node: ToolNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  /** 仅处理已注册的 MCP 工具；返回 undefined 时回落到内置 stub，因此不会把整个执行器标记为 live。 */
  mcpTool?: (node: ToolNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  /** 确定性内置工具（如 knowledge.search）；stub 模式也可接真实服务，且不改变 live 判定。 */
  knowledgeTool?: (node: ToolNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
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
  artifactNodeId?: string;
};

export type ExecutorOptions = {
  maxAttempts?: number;
  timeoutMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  rollbackOnFailure?: boolean;
  dimensionScorer?: DimensionScorer;
  approvalTimeoutMs?: number;
  onStatusChange?: (runId: string, status: RunStatus) => void;
};

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

type ResolvedExecutorOptions = Required<
  Omit<ExecutorOptions, "onStatusChange" | "dimensionScorer">
> &
  Pick<ExecutorOptions, "onStatusChange">;

type LoopFrame = {
  path: string;
  controller: SelfLoopController;
  action: SelfLoopAction;
  actionReason: string;
  issues: string[];
  retrievalQuery?: string;
  directive: Record<string, unknown>;
  agentOverrides: Map<string, string>;
  currentAgentId?: string;
  previousAgentId?: string;
  /** 循环体内首个 Agent 节点的编译路径；分配与换 Agent 都以 path 为键。 */
  primaryAgentPath?: string;
  /** 进入本轮前的产物、验证分与轮次，供循环体内的 ${loop.*} 引用。 */
  artifact?: unknown;
  score?: number;
  iteration: number;
  startedAt: number;
  tokensAtStart: number;
};

type RunState = ExecutionContext & {
  sequence: number;
  tokensUsed: number;
  loops: LoopFrame[];
  loopSummaries: SelfLoopSummary[];
  assignments: Map<string, string>;
  /** 工作流级知识库绑定，工具节点未显式配置检索范围时使用。 */
  workflowKnowledgeBaseIds: string[];
};

type ScopeSnapshot = {
  iteration: number;
  score?: number;
  artifact?: unknown;
  artifactNodeId?: string;
  issues?: string[];
  confidence?: number;
  passed?: boolean;
  layers?: VerifyLayers;
  outputs: Map<string, unknown>;
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
  private readonly cancelledRuns = new Set<string>();

  constructor(
    private readonly store: PlatformStateStore,
    private readonly handlers: ExecutorHandlers = {},
    options: ExecutorOptions = {}
  ) {
    this.mode = handlers.agent || handlers.llm || handlers.tool || handlers.verify ? "live" : "stub";
    this.options = resolveExecutorOptions(options);
    this.injectedFailures = new Set(
      (process.env.PLATFORM_FAIL_NODE_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    );
    // stub 模式用模拟打分器保留“修订后提升”的演示曲线；接入真实 Agent 后使用注入的验证打分器。
    this.verifier = new LayeredVerifier(
      this.mode === "stub"
        ? stubDimensionScorer
        : (options.dimensionScorer ?? heuristicDimensionScorer)
    );
  }

  runtimeConfig() {
    return {
      mode: this.mode,
      maxAttempts: this.options.maxAttempts,
      timeoutMs: this.options.timeoutMs,
      retryBaseDelayMs: this.options.retryBaseDelayMs,
      retryMaxDelayMs: this.options.retryMaxDelayMs,
      rollbackOnFailure: this.options.rollbackOnFailure,
      approvalTimeoutMs: this.options.approvalTimeoutMs
    };
  }

  /** 子流程定义从平台台账读取，保证保存/运行/重跑使用同一套引用解析。 */
  private compile(workflow: WorkflowDefinition) {
    return compileWorkflow(workflow, {
      resolveWorkflow: (id, version) => this.store.getWorkflow(id, version)?.definition
    });
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
    this.cancelledRuns.add(runId);
    if (run.status === "waiting_approval") {
      for (const approval of this.store.listApprovals({ runId, status: "pending" })) {
        if (this.approvals.has(approval.id)) {
          this.approvals.decide(approval.id, "rejected", "system", "运行已取消。");
        }
      }
    }
    return this.store.getRun(runId)!;
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

  async run(workflow: WorkflowDefinition, input: Record<string, unknown> = {}): Promise<PlatformRunView> {
    const { run, plan, schedule } = this.prepare(workflow, input);
    await this.execute(plan, run.id, input, assignmentsOf(schedule));
    return { run: this.store.getRun(run.id)!, steps: this.store.listSteps(run.id) };
  }

  /**
   * 异步启动：返回刚落库的 running 记录，执行在后台继续，供监控台轮询 trace。
   * 同步调用方仍可用 run() 拿完整结果。
   */
  start(workflow: WorkflowDefinition, input: Record<string, unknown> = {}) {
    const { run, plan, schedule } = this.prepare(workflow, input);
    void this.execute(plan, run.id, input, assignmentsOf(schedule)).catch(() => {
      // execute 内部已把失败写回 run，这里只负责吞掉 fire-and-forget 的 rejection。
    });
    return run;
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
    const plan = this.compile(definition);
    const compiled =
      plan.steps.find((step) => step.path === original.path) ??
      plan.steps.find((step) => step.nodeId === original.nodeId);
    if (!compiled) {
      throw new PlatformError("该步骤不在工作流编译计划中，无法单步重跑。", 400);
    }
    if (compiled.node.kind === "approve") {
      throw new PlatformError("人工审批步骤不支持单步重跑，请整单重跑后重新审批。", 400);
    }

    const input = isRecord(original.input) ? original.input : {};
    const previousVerifications = this.store.listVerifyResults(runId);
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
      scope: {
        input: run.input,
        outputs: new Map(),
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

  private prepare(workflow: WorkflowDefinition, input: Record<string, unknown>) {
    const plan = this.compile(workflow);
    const missing = workflow.inputs
      .filter((variable) => variable.required && input[variable.name] === undefined)
      .map((variable) => variable.name);
    if (missing.length > 0) {
      throw new PlatformError(`缺少必填输入：${missing.join("、")}`, 400);
    }

    const agents = this.scopedAgents(workflow);
    const schedule = buildWorkflowSchedule(plan, agents, this.store.activeAgentLoads());
    const run = this.store.createRun({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      workflowInput: input,
      mode: this.mode,
      status: "queued",
      plan: schedule,
      definition: workflow
    });
    this.options.onStatusChange?.(run.id, "queued");
    return { run, plan, schedule };
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
    assignments: Map<string, string>
  ) {
    const state: RunState = {
      runId,
      workflowId: plan.workflow.id,
      iteration: 0,
      sequence: 0,
      tokensUsed: 0,
      loops: [],
      loopSummaries: [],
      assignments,
      workflowKnowledgeBaseIds: plan.workflow.knowledgeBaseIds ?? [],
      scope: { input, outputs: new Map(), verifyRounds: 0 }
    };

    this.setStatus(runId, "running");
    try {
      await this.executeBlock(plan.program, state);
      this.throwIfCancelled(runId);
      this.finish(runId, "succeeded", {
        mode: this.mode,
        score: state.scope.lastVerifyScore,
        stepCount: state.sequence,
        tokensUsed: state.tokensUsed,
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
      // 审批驳回/超时是明确终态，不应被失败快照回滚成 rolled_back。
      if (error instanceof ApprovalRejectedError) {
        this.finish(runId, "failed", undefined, message);
        return;
      }
      if (this.rollbackToSnapshot(runId, state, message)) {
        return;
      }
      this.finish(runId, "failed", undefined, message);
    }
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
        agents: this.store.listAgents()
      }),
      action: "rewrite",
      actionReason: "首轮修正：根据初始验证问题重写输出。",
      issues: state.scope.lastVerifyIssues ?? [],
      directive: {},
      agentOverrides: new Map(),
      currentAgentId: primaryAgentId,
      primaryAgentPath: primaryAgent?.path,
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
        await this.executeBlock(statement.body, state);

        const scoreAfter = state.scope.lastVerifyScore;
        const issues = state.scope.lastVerifyIssues ?? [];
        const snapshot = snapshotScope(state.scope, iteration);
        frame.artifact = snapshot.artifact;
        frame.score = scoreAfter;
        frame.iteration = iteration;
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
          currentAgentId: frame.currentAgentId
        });

        iterations += 1;
        if (!decision.continue) {
          stopReason = decision.stopReason;
          decision.changes.push(retentionNote(best, iteration));
        }
        this.store.recordLoopIteration({
          runId: state.runId,
          loopNodeId: statement.nodeId,
          iteration,
          scoreBefore,
          scoreAfter,
          action: frame.action,
          changes: decision.changes
        });

        if (!decision.continue) {
          break;
        }

        if (decision.nextAgentId && frame.primaryAgentPath) {
          frame.previousAgentId = frame.currentAgentId;
          frame.currentAgentId = decision.nextAgentId;
          frame.agentOverrides.set(frame.primaryAgentPath, decision.nextAgentId);
        }
        frame.action = decision.action;
        frame.actionReason = decision.reason;
        frame.issues = issues;
        frame.retrievalQuery = decision.retrievalQuery;
      }
    } finally {
      state.loops.pop();
      if (best && iterations > 0) {
        restoreScope(state.scope, best, collectLeafSteps(statement.body));
      }
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
        elapsedMs: Date.now() - frame.startedAt
      });
      this.setStatus(state.runId, "running");
    }
  }

  private async executeStep(step: CompiledStep, state: RunState) {
    const node = step.node;
    const frame = findLoopFrame(state, step.path);
    const rawInput = node.kind === "tool" ? node.args ?? {} : node.inputs ?? {};
    let input = resolveValue(rawInput, state.scope, frame) as Record<string, unknown>;
    if (node.kind === "verify") {
      // 未显式映射时，默认验证最近一个非验证节点的输出，证据取整个运行里收集到的引用。
      input = {
        ...input,
        ...(input.artifact === undefined ? { artifact: state.scope.lastArtifact } : {}),
        ...(input.evidence === undefined ? { evidence: collectEvidence(state.scope.outputs) } : {}),
        ...(input.targetNodeId === undefined && state.scope.lastArtifactNodeId
          ? { targetNodeId: state.scope.lastArtifactNodeId }
          : {})
      };
    }
    if (
      node.kind === "tool" &&
      node.tool === "knowledge.search" &&
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
      if (effectiveAgent !== node.agent) {
        // 换 Agent 后原节点的版本钉子失效，否则可能钉到新 Agent 不存在的版本。
        effectiveStep = { ...step, node: { ...node, agent: effectiveAgent, agentVersion: undefined } };
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

    if (node.kind === "approve") {
      await this.executeApprovalStep(effectiveStep, input, state, stepId);
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
    const parentScope = state.scope;
    const parentLoops = state.loops;
    const parentIteration = state.iteration;
    const parentKnowledgeBaseIds = state.workflowKnowledgeBaseIds;
    // 验证轮次按整条运行计数：子流程里的验证也算一轮，否则父流程的最终验证会退回首轮基准分。
    const childScope: RunScope = { input, outputs: new Map(), verifyRounds: parentScope.verifyRounds };

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
    state.scope.lastArtifact = payload;
    state.scope.lastArtifactNodeId = node.id;
    state.tokensUsed += estimateTokens(input) + estimateTokens(payload);
    this.store.completeStep(stepId, "succeeded", payload, undefined, {
      attempts: 1,
      snapshot: serializeScope(state.scope)
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
    const context: Record<string, unknown> = {
      artifact: state.scope.lastArtifact,
      artifactNodeId: state.scope.lastArtifactNodeId,
      score: state.scope.lastVerifyScore,
      confidence: state.scope.lastVerifyConfidence,
      issues: state.scope.lastVerifyIssues ?? [],
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
      artifact: state.scope.lastArtifact,
      score: state.scope.lastVerifyScore,
      issues: state.scope.lastVerifyIssues ?? [],
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

    state.scope.outputs.set(node.id, payload);
    state.tokensUsed += estimateTokens(input) + estimateTokens(payload);
    this.store.completeStep(stepId, "succeeded", payload, undefined, { attempts: 1 });
  }

  private async runStepBody(
    step: CompiledStep,
    input: Record<string, unknown>,
    state: RunState,
    stepId: string
  ) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      this.throwIfCancelled(state.runId);
      if (attempt > 1) {
        await sleep(this.retryDelay(attempt));
      }
      await this.stubDelay();
      try {
        const rawOutput = await this.invokeWithTimeout(step, input, state);
        let output: unknown = rawOutput;
        if (step.node.kind === "verify") {
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
            verifier: step.node.verifier,
            score: verification.score,
            confidence: verification.confidence,
            dimensions: verification.dimensions,
            issues: verification.issues,
            evidence: verification.evidence,
            detail: verifyDetail(verification)
          });
          output = verification;
        } else {
          state.scope.lastArtifact = output;
          state.scope.lastArtifactNodeId = step.nodeId;
        }
        state.scope.outputs.set(step.nodeId, output);
        state.tokensUsed += estimateTokens(input) + estimateTokens(output);
        this.store.completeStep(stepId, "succeeded", output, undefined, {
          attempts: attempt,
          snapshot: serializeScope(state.scope)
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }

    this.store.completeStep(stepId, "failed", undefined, errorDetail(lastError), {
      attempts: this.options.maxAttempts
    });
    throw lastError;
  }

  private async invokeWithTimeout(
    step: CompiledStep,
    input: Record<string, unknown>,
    state: RunState
  ): Promise<unknown> {
    if (this.options.timeoutMs <= 0) {
      return this.invoke(step, input, state);
    }
    const timeoutMs = this.options.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.invoke(step, input, state),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`步骤执行超时（>${timeoutMs}ms）`)),
            timeoutMs
          );
        })
      ]);
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

  private async invoke(step: CompiledStep, input: Record<string, unknown>, state: RunState): Promise<unknown> {
    const frame = findLoopFrame(state, step.path);
    const context: ExecutionContext = {
      runId: state.runId,
      workflowId: state.workflowId,
      iteration: state.iteration,
      scope: state.scope,
      loop: frame ? loopScopeOf(frame) : undefined
    };
    const node = step.node;
    // 演示/演练用：PLATFORM_FAIL_NODE_IDS 让 stub 在指定节点抛错，用于验证重试与回滚。
    if (this.mode === "stub" && this.injectedFailures.has(node.id)) {
      throw new Error(`[stub] 注入失败：节点 ${node.id}`);
    }
    if (node.kind === "agent") {
      return this.handlers.agent ? await this.handlers.agent(node, input, context) : stubAgent(node, input);
    }
    if (node.kind === "llm") {
      return this.handlers.llm ? await this.handlers.llm(node, input, context) : stubLlm(node, input);
    }
    if (node.kind === "template") {
      const rendered = resolveValue(node.template, state.scope, frame);
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
      attempt: state.scope.verifyRounds + 1,
      mode: this.mode,
      agents: this.store.listAgents()
    });
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
    outputs: new Map(scope.outputs)
  };
}

/**
 * 恢复最优轮的工作状态。最优轮是初始轮时，循环体节点没有自身输出，
 * 用保留的产物与验证分补位，保证下游 ${revise.output} / ${verify-loop.score} 仍可解析。
 */
function restoreScope(scope: RunScope, snapshot: ScopeSnapshot, bodySteps: CompiledStep[]) {
  scope.outputs = new Map(snapshot.outputs);
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
    status === "waiting_approval"
  );
}

function stubAgent(node: AgentNode, input: Record<string, unknown>) {
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
    model: node.model ?? "classroom-llm",
    summary: `[stub] ${node.title ?? node.id} 已完成模型思考`,
    thinking: node.thinking === false ? undefined : thinking,
    output: `[stub:llm] ${node.title ?? node.id} 的输出`,
    inputs: input
  };
}

function stubTool(node: ToolNode, input: Record<string, unknown>) {
  return {
    mode: "stub",
    tool: node.tool,
    summary: `[stub] ${node.title ?? node.id} 已执行`,
    output: `[stub:${node.tool}] ${node.title ?? node.id} 的输出`,
    citations: [{ id: "stub-citation-1", title: "示例知识片段", source: "stub" }],
    args: input
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

function collectEvidence(outputs: Map<string, unknown>): string[] {
  const evidence: string[] = [];
  for (const output of outputs.values()) {
    if (!isRecord(output) || !Array.isArray(output.citations)) {
      continue;
    }
    for (const citation of output.citations) {
      if (typeof citation === "string") {
        evidence.push(citation);
      } else if (isRecord(citation)) {
        const title = typeof citation.title === "string" ? citation.title : "";
        const source = typeof citation.source === "string" ? citation.source : "";
        const text = [title, source].filter(Boolean).join(" · ");
        if (text) {
          evidence.push(text);
        }
      }
    }
  }
  return [...new Set(evidence)].slice(0, 8);
}

function verifyDetail(verification: VerifyOutput): Record<string, unknown> | undefined {
  const detail: Record<string, unknown> = {};
  if (verification.layers) {
    detail.layers = verification.layers;
  }
  if (verification.verifiers) {
    detail.verifiers = verification.verifiers;
  }
  if (verification.artifactNodeId) {
    detail.artifactNodeId = verification.artifactNodeId;
  }
  return Object.keys(detail).length > 0 ? detail : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    ...(frame.retrievalQuery ? { retrievalQuery: frame.retrievalQuery } : {})
  };
}

function findFirstAgentStep(block: CompiledBlock): CompiledStep | undefined {
  for (const statement of block) {
    if (statement.type === "step" && statement.step.node.kind === "agent") {
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
    rollbackOnFailure:
      options.rollbackOnFailure ?? process.env.PLATFORM_ROLLBACK_ON_FAILURE === "true",
    approvalTimeoutMs: clampInt(
      options.approvalTimeoutMs ?? envInt("PLATFORM_APPROVAL_TIMEOUT_MS", 600000),
      1000,
      86_400_000
    ),
    onStatusChange: options.onStatusChange
  };
}

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function resolveValue(value: unknown, scope: RunScope, frame?: LoopFrame): unknown {
  if (typeof value === "string") {
    const whole = value.match(REF_PATTERN);
    if (whole) {
      return resolveRef(whole[1], scope, frame);
    }
    if (value.includes("${")) {
      return value.replace(EMBEDDED_REF_PATTERN, (_match, ref: string) =>
        stringify(resolveRef(ref, scope, frame))
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, scope, frame));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveValue(item, scope, frame)])
    );
  }
  return value;
}

function resolveRef(ref: string, scope: RunScope, frame?: LoopFrame): unknown {
  const [head, ...rest] = ref.split(".");
  if (head === "loop") {
    return resolveLoopRef(rest, frame);
  }
  let current: unknown = head === "input" ? scope.input : scope.outputs.get(head);
  for (const segment of rest) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 循环作用域：artifact/issues/score/iteration/retrievalQuery 均指向进入本轮前的状态。 */
function resolveLoopRef(path: string[], frame?: LoopFrame): unknown {
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

function loopScopeOf(frame: LoopFrame): LoopScope {
  return {
    artifact: frame.artifact,
    issues: frame.issues,
    score: frame.score,
    iteration: frame.iteration,
    retrievalQuery: frame.retrievalQuery
  };
}

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

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "number") {
    return Number(actual) === expected;
  }
  if (typeof expected === "boolean") {
    return Boolean(actual) === expected;
  }
  return String(actual) === String(expected);
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
