import {
  PlatformError,
  type AgentNode,
  type CompiledBlock,
  type CompiledExpression,
  type CompiledStatement,
  type CompiledStep,
  type PlatformRunView,
  type RunMode,
  type StepRecord,
  type ToolNode,
  type VerifyDimension,
  type VerifyNode,
  type WorkflowDefinition
} from "../types.js";
import { compileWorkflow } from "../workflow/compiler.js";
import type { PlatformStateStore } from "./stateStore.js";

const REF_PATTERN = /^\$\{([^}\s]+)\}$/;
const EMBEDDED_REF_PATTERN = /\$\{([^}\s]+)\}/g;

type RunScope = {
  input: Record<string, unknown>;
  outputs: Map<string, unknown>;
  verifyRounds: number;
  lastVerifyScore?: number;
};

export type ExecutionContext = {
  runId: string;
  workflowId: string;
  iteration: number;
  scope: RunScope;
};

export type ExecutorHandlers = {
  agent?: (node: AgentNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  tool?: (node: ToolNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
  verify?: (node: VerifyNode, input: Record<string, unknown>, context: ExecutionContext) => unknown | Promise<unknown>;
};

export type VerifyOutput = {
  score: number;
  confidence: number;
  passed?: boolean;
  dimensions: VerifyDimension[];
  issues: string[];
  evidence: string[];
};

type RunState = ExecutionContext & { sequence: number };

/**
 * 运行时骨架：负责按编译计划执行、落库 trace 和验证/迭代记录。
 * 未注入 handler 时使用确定性 stub，输出带 mode: "stub"，供联调主链路；真实 Agent 由 T1.3 接入。
 */
export class WorkflowExecutor {
  private readonly mode: RunMode;

  constructor(private readonly store: PlatformStateStore, private readonly handlers: ExecutorHandlers = {}) {
    this.mode = handlers.agent || handlers.tool || handlers.verify ? "live" : "stub";
  }

  async run(workflow: WorkflowDefinition, input: Record<string, unknown> = {}): Promise<PlatformRunView> {
    const { run, plan } = this.prepare(workflow, input);
    await this.execute(plan, run.id, input);
    return { run: this.store.getRun(run.id)!, steps: this.store.listSteps(run.id) };
  }

  /**
   * 异步启动：返回刚落库的 running 记录，执行在后台继续，供监控台轮询 trace。
   * 同步调用方仍可用 run() 拿完整结果。
   */
  start(workflow: WorkflowDefinition, input: Record<string, unknown> = {}) {
    const { run, plan } = this.prepare(workflow, input);
    void this.execute(plan, run.id, input).catch(() => {
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
    if (!stored) {
      throw new PlatformError("运行对应的工作流版本不存在。", 404);
    }
    const plan = compileWorkflow(stored.definition);
    const compiled =
      plan.steps.find((step) => step.path === original.path) ??
      plan.steps.find((step) => step.nodeId === original.nodeId);
    if (!compiled) {
      throw new PlatformError("该步骤不在工作流编译计划中，无法单步重跑。", 400);
    }

    const input = isRecord(original.input) ? original.input : {};
    const previousVerifications = this.store.listVerifyResults(runId);
    const state: RunState = {
      runId,
      workflowId: run.workflowId,
      iteration: 0,
      sequence: this.store.nextSequence(runId),
      scope: {
        input: run.input,
        outputs: new Map(),
        verifyRounds: previousVerifications.length,
        lastVerifyScore: previousVerifications[previousVerifications.length - 1]?.score
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
    const plan = compileWorkflow(workflow);
    const missing = workflow.inputs
      .filter((variable) => variable.required && input[variable.name] === undefined)
      .map((variable) => variable.name);
    if (missing.length > 0) {
      throw new PlatformError(`缺少必填输入：${missing.join("、")}`, 400);
    }

    const run = this.store.createRun({
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      workflowInput: input,
      mode: this.mode
    });
    return { run, plan };
  }

  private async execute(plan: ReturnType<typeof compileWorkflow>, runId: string, input: Record<string, unknown>) {
    const state: RunState = {
      runId,
      workflowId: plan.workflow.id,
      iteration: 0,
      sequence: 0,
      scope: { input, outputs: new Map(), verifyRounds: 0 }
    };

    try {
      await this.executeBlock(plan.program, state);
      this.store.finishRun(runId, "succeeded", {
        mode: this.mode,
        score: state.scope.lastVerifyScore,
        stepCount: state.sequence
      });
    } catch (error) {
      this.store.finishRun(runId, "failed", undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private async executeBlock(block: CompiledBlock, state: RunState) {
    for (const statement of block) {
      await this.executeStatement(statement, state);
    }
  }

  private async executeStatement(statement: CompiledStatement, state: RunState) {
    if (statement.type === "step") {
      await this.executeStep(statement.step, state);
      return;
    }
    if (statement.type === "parallel") {
      await Promise.all(statement.branches.map((branch) => this.executeBlock(branch, state)));
      return;
    }
    if (statement.type === "condition") {
      const branch = evaluateExpression(statement.when, state.scope) ? statement.then : statement.otherwise;
      await this.executeBlock(branch, state);
      return;
    }

    for (let iteration = 1; iteration <= statement.maxIterations; iteration += 1) {
      // 首轮必跑；while 从第二轮起在每轮开始前判断，读得到上一轮 body 的验证分数。
      if (iteration > 1 && statement.while && !evaluateExpression(statement.while, state.scope)) {
        break;
      }
      const scoreBefore = state.scope.lastVerifyScore;
      state.iteration = iteration;
      await this.executeBlock(statement.body, state);
      const scoreAfter = state.scope.lastVerifyScore;
      this.store.recordLoopIteration({
        runId: state.runId,
        loopNodeId: statement.nodeId,
        iteration,
        scoreBefore,
        scoreAfter,
        action: "revise",
        changes: [`${statement.title} 第 ${iteration} 轮执行完成`]
      });
    }
  }

  private async executeStep(step: CompiledStep, state: RunState) {
    const node = step.node;
    const rawInput = node.kind === "tool" ? node.args ?? {} : node.inputs ?? {};
    const input = resolveValue(rawInput, state.scope) as Record<string, unknown>;
    const stepId = this.store.beginStep({
      runId: state.runId,
      sequence: (state.sequence += 1),
      path: step.path,
      nodeId: step.nodeId,
      nodeKind: node.kind,
      input
    });

    await this.runStepBody(step, input, state, stepId);
  }

  private async runStepBody(step: CompiledStep, input: Record<string, unknown>, state: RunState, stepId: string) {
    await this.stubDelay();
    try {
      const rawOutput = await this.invoke(step, input, state);
      let output: unknown = rawOutput;
      if (step.node.kind === "verify") {
        const verification = normalizeVerifyOutput(rawOutput);
        state.scope.verifyRounds += 1;
        state.scope.lastVerifyScore = verification.score;
        this.store.recordVerifyResult({
          runId: state.runId,
          stepId,
          verifier: step.node.verifier,
          score: verification.score,
          confidence: verification.confidence,
          dimensions: verification.dimensions,
          issues: verification.issues,
          evidence: verification.evidence
        });
        output = verification;
      }
      this.store.completeStep(stepId, "succeeded", output);
      state.scope.outputs.set(step.nodeId, output);
    } catch (error) {
      this.store.completeStep(stepId, "failed", undefined, errorDetail(error));
      throw error;
    }
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
    const context: ExecutionContext = {
      runId: state.runId,
      workflowId: state.workflowId,
      iteration: state.iteration,
      scope: state.scope
    };
    const node = step.node;
    if (node.kind === "agent") {
      return this.handlers.agent ? await this.handlers.agent(node, input, context) : stubAgent(node, input);
    }
    if (node.kind === "tool") {
      return this.handlers.tool ? await this.handlers.tool(node, input, context) : stubTool(node, input);
    }
    return this.handlers.verify ? await this.handlers.verify(node, input, context) : stubVerify(node, state.scope);
  }
}

function stubAgent(node: AgentNode, input: Record<string, unknown>) {
  return {
    mode: "stub",
    agent: node.agent,
    summary: `[stub] ${node.title ?? node.id} 已执行`,
    output: `[stub:${node.agent}] ${node.title ?? node.id} 的输出`,
    inputs: input
  };
}

function stubTool(node: ToolNode, input: Record<string, unknown>) {
  return {
    mode: "stub",
    tool: node.tool,
    summary: `[stub] ${node.title ?? node.id} 已执行`,
    output: `[stub:${node.tool}] ${node.title ?? node.id} 的输出`,
    citations: [{ id: "stub-citation-1", title: "骨架占位引用", source: "stub" }],
    args: input
  };
}

function stubVerify(node: VerifyNode, scope: RunScope) {
  const round = scope.verifyRounds + 1;
  const score = round4(Math.min(0.95, 0.62 + 0.12 * (round - 1)));
  const confidence = round4(Math.min(0.9, 0.6 + 0.08 * (round - 1)));
  const threshold = node.threshold ?? 0.8;
  const passed = score >= threshold;
  const rubric = node.rubric && node.rubric.length > 0 ? node.rubric : ["目标达成", "互动覆盖", "证据支撑"];
  return {
    mode: "stub",
    score,
    confidence,
    passed,
    dimensions: rubric.map((name, index) => ({
      name,
      score: round4(Math.max(0, Math.min(1, score - index * 0.05))),
      comment: passed ? "达标" : "待改进"
    })),
    issues: passed ? [] : [`[stub] 第 ${round} 轮验证未达标：互动覆盖不足，沉默学生未参与`],
    evidence: ["[stub] 骨架运行产生的占位证据；接入真实 Verifier 后由交叉验证生成。"]
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function resolveValue(value: unknown, scope: RunScope): unknown {
  if (typeof value === "string") {
    const whole = value.match(REF_PATTERN);
    if (whole) {
      return resolveRef(whole[1], scope);
    }
    if (value.includes("${")) {
      return value.replace(EMBEDDED_REF_PATTERN, (_match, ref: string) => stringify(resolveRef(ref, scope)));
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, scope));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, scope)]));
  }
  return value;
}

function resolveRef(ref: string, scope: RunScope): unknown {
  const [head, ...rest] = ref.split(".");
  let current: unknown = head === "input" ? scope.input : scope.outputs.get(head);
  for (const segment of rest) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function evaluateExpression(expression: CompiledExpression, scope: RunScope): boolean {
  const actual = resolveRef(expression.ref, scope);
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
