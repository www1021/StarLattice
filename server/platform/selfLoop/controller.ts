import type { AgentRecord } from "../types.js";
import { createSchedule } from "../scheduler/scheduler.js";

export type SelfLoopAction = "rewrite" | "swap_agent" | "retrieve";

export type SelfLoopStopReason =
  | "passed"
  | "max_iterations"
  | "no_improvement"
  | "budget_time"
  | "budget_tokens"
  | "while_false";

export const SELF_LOOP_CONTRACT = "执行 → 验证 → 定位问题 → 修正 → 再验证";

export const SELF_LOOP_ACTION_SPECS: Array<{
  id: SelfLoopAction;
  label: string;
  description: string;
}> = [
  {
    id: "rewrite",
    label: "重写输出",
    description: "保留当前 Agent，把验证问题作为修正依据重写产物，不自动改写工作流。"
  },
  {
    id: "swap_agent",
    label: "换 Agent",
    description: "同一能力画像下调用调度器选择次优 Agent，由新 Agent 重新生成产物。"
  },
  {
    id: "retrieve",
    label: "补检索",
    description: "验证问题指向引用、证据或知识缺口时，生成检索指令补充材料后再修正。"
  }
];

export const SELF_LOOP_STOP_REASON_SPECS: Array<{
  id: SelfLoopStopReason;
  label: string;
}> = [
  { id: "passed", label: "达到验证阈值" },
  { id: "max_iterations", label: "达到最大轮次" },
  { id: "no_improvement", label: "连续多轮无提升" },
  { id: "budget_time", label: "超出时间预算" },
  { id: "budget_tokens", label: "超出 token 预算" },
  { id: "while_false", label: "while 条件不再满足" }
];

export type SelfLoopBudget = {
  maxDurationMs: number;
  maxTokens: number;
};

export type SelfLoopPolicy = {
  patience: number;
  minGain: number;
  budget: SelfLoopBudget;
};

export type SelfLoopOptions = {
  threshold: number;
  maxIterations: number;
  policy?: Partial<Omit<SelfLoopPolicy, "budget">> & { budget?: Partial<SelfLoopBudget> };
  agents?: AgentRecord[];
};

export type SelfLoopEvaluationInput = {
  iteration: number;
  score?: number;
  previousScore?: number;
  issues: string[];
  whilePassed: boolean;
  elapsedMs: number;
  tokensUsed: number;
  currentAgentId?: string;
};

export type SelfLoopDecision = {
  continue: boolean;
  stopReason?: SelfLoopStopReason;
  action: SelfLoopAction;
  actionLabel: string;
  reason: string;
  score?: number;
  delta?: number;
  bestScore?: number;
  nextAgentId?: string;
  nextAgentName?: string;
  retrievalQuery?: string;
  changes: string[];
};

export type SelfLoopSummary = {
  loopNodeId: string;
  iterations: number;
  threshold: number;
  initialScore?: number;
  finalScore?: number;
  bestScore?: number;
  /** 保留的轮次；0 表示保留循环开始前的初始产物。 */
  bestIteration?: number;
  stopReason?: SelfLoopStopReason;
  tokensUsed: number;
  elapsedMs: number;
};

type ActionChoice = {
  action: SelfLoopAction;
  reason: string;
  nextAgentId?: string;
  nextAgentName?: string;
  retrievalQuery?: string;
};

const EVIDENCE_PATTERN = /证据|引用|来源|检索|知识库|citation|evidence|source|knowledge/i;

export class SelfLoopController {
  readonly threshold: number;
  readonly maxIterations: number;
  readonly policy: SelfLoopPolicy;
  private readonly agents: AgentRecord[];
  private best = Number.NEGATIVE_INFINITY;
  private stalls = 0;

  constructor(options: SelfLoopOptions) {
    const defaults = resolveSelfLoopPolicy();
    this.threshold = clampNumber(options.threshold, 0, 1);
    this.maxIterations = clampInt(options.maxIterations, 1, 20);
    this.policy = {
      patience: clampInt(options.policy?.patience ?? defaults.patience, 1, 10),
      minGain: clampNumber(options.policy?.minGain ?? defaults.minGain, 0, 1),
      budget: {
        maxDurationMs: clampInt(
          options.policy?.budget?.maxDurationMs ?? defaults.budget.maxDurationMs,
          0,
          3_600_000
        ),
        maxTokens: clampInt(
          options.policy?.budget?.maxTokens ?? defaults.budget.maxTokens,
          0,
          10_000_000
        )
      }
    };
    this.agents = options.agents ?? [];
  }

  get bestScore(): number | undefined {
    return this.best === Number.NEGATIVE_INFINITY ? undefined : this.best;
  }

  evaluate(input: SelfLoopEvaluationInput): SelfLoopDecision {
    const score = typeof input.score === "number" ? round4(input.score) : undefined;
    if (score !== undefined) {
      if (score > this.best + this.policy.minGain) {
        this.best = score;
        this.stalls = 0;
      } else {
        this.stalls += 1;
      }
    }

    const delta =
      score !== undefined && typeof input.previousScore === "number"
        ? round4(score - input.previousScore)
        : undefined;
    const stopReason = this.stopReason(input, score);

    if (stopReason) {
      const decision: SelfLoopDecision = {
        continue: false,
        stopReason,
        action: "rewrite",
        actionLabel: actionLabel("rewrite"),
        reason: stopReasonText(stopReason, this, input, score),
        score,
        delta,
        bestScore: this.bestScore,
        changes: []
      };
      decision.changes = buildChanges(input, decision);
      return decision;
    }

    const choice = chooseAction(input.issues, input.currentAgentId, this.agents, this.stalls);
    const decision: SelfLoopDecision = {
      continue: true,
      action: choice.action,
      actionLabel: actionLabel(choice.action),
      reason: choice.reason,
      score,
      delta,
      bestScore: this.bestScore,
      nextAgentId: choice.nextAgentId,
      nextAgentName: choice.nextAgentName,
      retrievalQuery: choice.retrievalQuery,
      changes: []
    };
    decision.changes = buildChanges(input, decision);
    return decision;
  }

  private stopReason(
    input: SelfLoopEvaluationInput,
    score: number | undefined
  ): SelfLoopStopReason | undefined {
    if (score !== undefined && score >= this.threshold) {
      return "passed";
    }
    if (input.iteration >= this.maxIterations) {
      return "max_iterations";
    }
    if (this.stalls >= this.policy.patience) {
      return "no_improvement";
    }
    if (this.policy.budget.maxDurationMs > 0 && input.elapsedMs >= this.policy.budget.maxDurationMs) {
      return "budget_time";
    }
    if (this.policy.budget.maxTokens > 0 && input.tokensUsed >= this.policy.budget.maxTokens) {
      return "budget_tokens";
    }
    if (!input.whilePassed) {
      return "while_false";
    }
    return undefined;
  }
}

export function resolveSelfLoopPolicy(): SelfLoopPolicy {
  return {
    patience: clampInt(envInt("PLATFORM_LOOP_PATIENCE", 2), 1, 10),
    minGain: clampNumber(envNumber("PLATFORM_LOOP_MIN_GAIN", 0.01), 0, 1),
    budget: {
      maxDurationMs: clampInt(envInt("PLATFORM_LOOP_MAX_DURATION_MS", 120_000), 0, 3_600_000),
      maxTokens: clampInt(envInt("PLATFORM_LOOP_MAX_TOKENS", 0), 0, 10_000_000)
    }
  };
}

export function actionLabel(action: SelfLoopAction): string {
  return SELF_LOOP_ACTION_SPECS.find((spec) => spec.id === action)?.label ?? action;
}

export function stopReasonLabel(reason: SelfLoopStopReason): string {
  return SELF_LOOP_STOP_REASON_SPECS.find((spec) => spec.id === reason)?.label ?? reason;
}

export function estimateTokens(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(text.length / 2);
}

function buildRetrievalQuery(issues: string[]): string {
  const quoted = issues.flatMap((issue) =>
    [...issue.matchAll(/「([^」]{1,20})」/g)].map((match) => match[1].trim())
  );
  const unique = [...new Set(quoted)].slice(0, 5);
  if (unique.length > 0) {
    return unique.join(" ");
  }
  return issues.join("；").slice(0, 60);
}

function chooseAction(
  issues: string[],
  currentAgentId: string | undefined,
  agents: AgentRecord[],
  stalls: number
): ActionChoice {
  const issueText = issues.join("；");
  if (EVIDENCE_PATTERN.test(issueText)) {
    return {
      action: "retrieve",
      reason: "验证问题指向证据、引用或知识缺口，先补充检索再修正。",
      retrievalQuery: buildRetrievalQuery(issues)
    };
  }
  if (stalls > 0) {
    const alternative = findAlternative(currentAgentId, agents);
    if (alternative) {
      return {
        action: "swap_agent",
        reason: `连续 ${stalls} 轮没有提升，换用 ${alternative.name} 重新生成。`,
        nextAgentId: alternative.id,
        nextAgentName: alternative.name
      };
    }
  }
  return {
    action: "rewrite",
    reason: issues.length > 0 ? "围绕验证问题重写输出。" : "没有具体问题，重写输出后再验证。"
  };
}

function findAlternative(currentAgentId: string | undefined, agents: AgentRecord[]) {
  const current = agents.find((agent) => agent.id === currentAgentId && agent.enabled);
  if (!current || current.capabilities.length === 0) {
    return undefined;
  }
  const allowedAgentIds = agents
    .filter((agent) => agent.enabled && agent.id !== current.id)
    .map((agent) => agent.id);
  if (allowedAgentIds.length === 0) {
    return undefined;
  }

  const plan = createSchedule(
    [
      {
        id: "self-loop-swap",
        title: "Self-Loop 换 Agent",
        capabilities: current.capabilities.map((capability) => capability.tag),
        priority: 1,
        allowedAgentIds
      }
    ],
    agents,
    { reserve: false }
  );
  const decision = plan.decisions[0];
  if (!decision || decision.breakdown.capability < 0.5) {
    return undefined;
  }
  return { id: decision.agentId, name: decision.agentName };
}

function stopReasonText(
  reason: SelfLoopStopReason,
  controller: SelfLoopController,
  input: SelfLoopEvaluationInput,
  score: number | undefined
) {
  switch (reason) {
    case "passed":
      return `得分 ${format(score)} ≥ 阈值 ${format(controller.threshold)}，停止迭代。`;
    case "max_iterations":
      return `达到最大轮次 ${controller.maxIterations}，停止迭代。`;
    case "no_improvement":
      return `连续 ${controller.policy.patience} 轮没有超过最低增益 ${format(controller.policy.minGain)}，停止迭代。`;
    case "budget_time":
      return `已用 ${input.elapsedMs}ms，达到时间预算 ${controller.policy.budget.maxDurationMs}ms，停止迭代。`;
    case "budget_tokens":
      return `已用约 ${input.tokensUsed} tokens，达到预算 ${controller.policy.budget.maxTokens}，停止迭代。`;
    case "while_false":
      return "while 条件不再满足，停止迭代。";
  }
}

function buildChanges(input: SelfLoopEvaluationInput, decision: SelfLoopDecision): string[] {
  const changes: string[] = [];
  if (decision.score === undefined) {
    changes.push(`第 ${input.iteration} 轮没有验证分数`);
  } else if (input.previousScore === undefined) {
    changes.push(`第 ${input.iteration} 轮得分 ${format(decision.score)}`);
  } else {
    const delta = decision.delta ?? 0;
    changes.push(
      `得分 ${format(input.previousScore)} → ${format(decision.score)}（${delta >= 0 ? "+" : ""}${format(delta)}）`
    );
  }
  if (input.issues.length > 0) {
    changes.push(`验证问题：${input.issues.slice(0, 2).join("；")}`);
  }
  if (decision.stopReason) {
    changes.push(`停止原因：${stopReasonLabel(decision.stopReason)} —— ${decision.reason}`);
  } else {
    const target =
      decision.action === "swap_agent" && decision.nextAgentName
        ? `，改用 ${decision.nextAgentName}`
        : decision.action === "retrieve" && decision.retrievalQuery
          ? `，检索词：${decision.retrievalQuery}`
          : "";
    changes.push(`下一轮动作：${decision.actionLabel}${target} —— ${decision.reason}`);
  }
  changes.push(`预算：${input.elapsedMs}ms / ${input.tokensUsed} tokens`);
  return changes;
}

function format(value: number | undefined) {
  return value === undefined ? "—" : value.toFixed(2);
}

function envInt(name: string, fallback: number): number {
  return Math.trunc(envNumber(name, fallback));
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}
