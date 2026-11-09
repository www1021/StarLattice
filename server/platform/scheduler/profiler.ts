import type { NodeKind } from "../types.js";

/**
 * 运行中任务画像：在不真正执行前估计任务类别、关键路径位置与等待代价，
 * 供全局队列排序、监控台解释和 What-if 复盘共用同一套口径。
 */
export type TaskClass = "gate" | "reasoning" | "tool" | "io" | "inline";

/** 类别分档直接决定跨运行抢占顺序：人工闸门 > 推理 > 工具 > IO > 结构节点。 */
export const TASK_CLASS_RANK: Record<TaskClass, number> = {
  gate: 4,
  reasoning: 3,
  tool: 2,
  io: 1,
  inline: 0
};

export type TaskProfile = {
  class: TaskClass;
  lane: string;
  /** 类别 × 100 + 关键路径基础分 × 10，等待与截止时间在出队时动态叠加。 */
  base: number;
  /** 关键路径基础分，0.5–1，根/汇点最高。 */
  basePriority: number;
  criticalPathDepth: number;
  maxDepth: number;
  inputTokens: number;
  estimatedTokens: number;
  enqueuedAt: number;
  deadlineAt?: number;
};

export type TaskProfileInput = {
  kind: NodeKind;
  criticalPathDepth: number;
  maxDepth: number;
  inputTokens?: number;
  priorityClass?: number;
  deadlineAt?: number | string;
  enqueuedAt?: number;
};

const BASE_TOKEN_COST: Record<TaskClass, number> = {
  gate: 50,
  reasoning: 800,
  tool: 300,
  io: 200,
  inline: 10
};

const CLASS_BY_KIND: Record<NodeKind, TaskClass> = {
  start: "inline",
  end: "inline",
  agent: "reasoning",
  llm: "reasoning",
  clarify: "reasoning",
  knowledge: "io",
  tool: "tool",
  http: "io",
  template: "inline",
  subworkflow: "inline",
  parallel: "inline",
  condition: "inline",
  loop: "inline",
  verify: "reasoning",
  approve: "gate",
  human: "gate"
};

export function classifyNode(kind: NodeKind): { class: TaskClass; lane: string } {
  const taskClass = CLASS_BY_KIND[kind] ?? "inline";
  return { class: taskClass, lane: taskClass };
}

export function buildTaskProfile(input: TaskProfileInput): TaskProfile {
  const { class: taskClass, lane } = classifyNode(input.kind);
  const maxDepth = Math.max(0, Math.trunc(input.maxDepth));
  const criticalPathDepth = Math.max(0, Math.trunc(input.criticalPathDepth));
  const basePriority =
    maxDepth === 0 ? 1 : Number((0.5 + (0.5 * criticalPathDepth) / maxDepth).toFixed(4));
  const classRank = clampNumber(input.priorityClass ?? TASK_CLASS_RANK[taskClass], 0, 5);
  const inputTokens = Math.max(0, Math.trunc(input.inputTokens ?? 0));
  return {
    class: taskClass,
    lane,
    base: Number((classRank * 100 + basePriority * 10).toFixed(4)),
    basePriority,
    criticalPathDepth,
    maxDepth,
    inputTokens,
    estimatedTokens: inputTokens + BASE_TOKEN_COST[taskClass],
    enqueuedAt: input.enqueuedAt ?? Date.now(),
    ...(input.deadlineAt !== undefined
      ? { deadlineAt: typeof input.deadlineAt === "string" ? Date.parse(input.deadlineAt) : input.deadlineAt }
      : {})
  };
}

/**
 * 出队时的有效优先级：静态画像 + 等待老化 + 截止时间加成。
 * 老化封顶 50，保证长时间排队的低优任务最终能越过一批静态高分任务，但不会无限膨胀。
 */
export function effectivePriorityOf(profile: TaskProfile, now = Date.now()): number {
  const waitedSec = Math.max(0, (now - profile.enqueuedAt) / 1000);
  const aging = Math.min(50, waitedSec * 5);
  const deadlineRemaining = profile.deadlineAt === undefined ? undefined : profile.deadlineAt - now;
  const deadlineBoost =
    deadlineRemaining === undefined ? 0 : deadlineRemaining <= 0 ? 40 : deadlineRemaining <= 60_000 ? 20 : 0;
  return Number((profile.base + aging + deadlineBoost).toFixed(4));
}

export function explainPriority(profile: TaskProfile, now = Date.now()): string {
  const waitedSec = Math.max(0, Math.round((now - profile.enqueuedAt) / 1000));
  const deadlineText =
    profile.deadlineAt === undefined
      ? ""
      : `，截止剩余 ${Math.round((profile.deadlineAt - now) / 1000)}s`;
  return `${profile.lane} 类，关键路径 ${profile.criticalPathDepth}/${profile.maxDepth}（基础 ${profile.basePriority.toFixed(2)}），等待 ${waitedSec}s${deadlineText}，有效优先级 ${effectivePriorityOf(profile, now).toFixed(2)}`;
}

export function effectivePriority(input: TaskProfileInput, now = Date.now()): number {
  return effectivePriorityOf(buildTaskProfile(input), now);
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
