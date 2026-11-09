import type { AgentNode, AgentRecord, CompiledPlan } from "../types.js";
import { resolveModel, type ModelCostTier } from "../models/catalog.js";
import { createSchedule, type SchedulePlan, type ScheduleTask } from "./scheduler.js";

/**
 * 运行前调度计划：把 DSL 中所有 agent 节点转成调度任务，
 * 能力标签取自节点原本声明的 Agent，DSL 的 agent 字段保留为首选/回退。
 * 任务 id 使用编译后的 step.path，保证子工作流内的同名节点与父流程互不覆盖。
 */
export type WorkflowSchedulePlan = SchedulePlan & {
  requestedAgentIds: Record<string, string>;
  /** 保留任务定义，供运行中失败重调度复用同一组能力/依赖约束。 */
  tasks: ScheduleTask[];
  /** static 消融不参与运行前打分，也不做运行中改派。 */
  staticMode?: boolean;
};

export function buildWorkflowSchedule(
  plan: CompiledPlan,
  agents: AgentRecord[],
  loads?: Record<string, { inFlight?: number; capacity?: number }>
): WorkflowSchedulePlan {
  const agentSteps = plan.steps.filter((step) => step.node.kind === "agent");
  const rootPaths = new Set(agentSteps.map((step) => step.path));
  const dependencies = new Map<string, string[]>();
  for (const edge of plan.workflow.edges) {
    if (!rootPaths.has(edge.from) || !rootPaths.has(edge.to)) {
      continue;
    }
    dependencies.set(edge.to, [...(dependencies.get(edge.to) ?? []), edge.from]);
  }

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const requestedAgentIds: Record<string, string> = {};
  const maxCostTier = scheduledCostCap();
  const tasks = agentSteps.map((step, index) => {
    const node = step.node as AgentNode;
    const authored = byId.get(node.agent);
    requestedAgentIds[step.path] = node.agent;
    const modelTags = authored ? loopModelTags(authored, node) : undefined;
    // 节点声明 capabilities 时以节点为准：同名 Agent 可以承担不同任务，
    // 调度要求应由任务内容决定，而不是永远继承 Agent 的全部标签。
    const requiredCapabilities =
      node.capabilities && node.capabilities.length > 0
        ? node.capabilities
        : authored?.capabilities.map((capability) => capability.tag) ?? [];
    return {
      id: step.path,
      title: node.title ?? node.id,
      capabilities: requiredCapabilities,
      priority: priorityFor(index, agentSteps.length),
      dependsOn: dependencies.get(step.path) ?? [],
      ...(modelTags ? { modelTags } : {}),
      ...(maxCostTier ? { maxCostTier } : {}),
      // 声明的 Agent 不在注册中心时限制候选，避免被分给无关 Agent；执行器仍会回退到 DSL 声明值。
      ...(authored ? {} : { allowedAgentIds: [node.agent] })
    };
  });

  const staticMode = plan.workflow.schedulerMode === "static";
  // 消融臂：把候选集强制收缩到 DSL 声明的 Agent，且清零能力/负载/优先级/模型权重，
  // 使调度器退化为静态指派；运行中失败也不改派，避免重新引入调度收益。
  const scheduleTasks = staticMode
    ? tasks.map((task) => ({ ...task, allowedAgentIds: [requestedAgentIds[task.id]] }))
    : tasks;
  const schedule = createSchedule(scheduleTasks, agents, {
    reserve: true,
    loads: staticMode ? undefined : loads,
    ...(staticMode ? { weights: { capability: 0, availability: 0, priority: 0, model: 0 } } : {})
  });
  if (staticMode) {
    for (const decision of schedule.decisions) {
      decision.reason = `静态消融：直接使用 DSL 声明的 ${decision.agentName}，不参与能力、负载或成本评分。`;
      decision.alternatives = [];
    }
    schedule.formula = "静态消融：DSL 声明 Agent（无运行前调度）";
  }

  return {
    ...schedule,
    requestedAgentIds,
    tasks,
    ...(staticMode ? { staticMode: true } : {})
  };
}

/**
 * 运行中失败重调度：只重算失败任务，保留其他任务的既有分配，
 * 并排除本次已经失败过的 Agent；没有可用替代时返回 undefined，由执行器照常判失败。
 */
export function replanForTask(
  schedule: WorkflowSchedulePlan,
  taskId: string,
  attemptedAgentIds: string[],
  agents: AgentRecord[],
  loads?: Record<string, { inFlight?: number; capacity?: number }>
): { agentId: string; agentName: string; score: number; reason: string } | undefined {
  if (schedule.staticMode) {
    return undefined;
  }
  if (!schedule.tasks.some((task) => task.id === taskId)) {
    return undefined;
  }
  const completed = schedule.decisions
    .filter((decision) => decision.taskId !== taskId)
    .map((decision) => decision.taskId);
  const next = createSchedule(schedule.tasks, agents, {
    completedTaskIds: completed,
    excludeAgentIds: attemptedAgentIds,
    reserve: false,
    loads
  });
  const decision = next.decisions.find((item) => item.taskId === taskId);
  if (!decision) {
    return undefined;
  }
  return {
    agentId: decision.agentId,
    agentName: decision.agentName,
    score: decision.score,
    reason: `运行中重调度：排除已失败的 ${attemptedAgentIds.join("、")}，改派 ${decision.agentName}（${decision.reason}）`
  };
}

export function assignmentsOf(plan: unknown): Map<string, string> {
  const decisions =
    typeof plan === "object" && plan !== null && Array.isArray((plan as { decisions?: unknown }).decisions)
      ? ((plan as { decisions: Array<{ taskId?: unknown; agentId?: unknown }> }).decisions ?? [])
      : [];
  const assignments = new Map<string, string>();
  for (const decision of decisions) {
    if (typeof decision.taskId === "string" && typeof decision.agentId === "string") {
      assignments.set(decision.taskId, decision.agentId);
    }
  }
  return assignments;
}

/**
 * 诊断/修订节点的 Agent 若声明的模型本身带 reasoning 或 verifier 标签，
 * 就把该标签提升为调度约束，避免“诊断角色被分给快速模型”绕开模型分工。
 */
function loopModelTags(agent: AgentRecord, node: AgentNode): string[] | undefined {
  if (node.loopRole !== "diagnose" && node.loopRole !== "revise") {
    return undefined;
  }
  const tags = resolveModel(agent.model, { source: "agent" }).tags;
  if (tags.includes("reasoning")) {
    return ["reasoning"];
  }
  if (tags.includes("verifier")) {
    return ["verifier"];
  }
  return undefined;
}

/** PLATFORM_SCHEDULE_MAX_COST=low/medium/high 时给所有调度任务加成本上限。 */
function scheduledCostCap(): ModelCostTier | undefined {
  const value = process.env.PLATFORM_SCHEDULE_MAX_COST?.trim();
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function priorityFor(index: number, total: number) {
  if (total <= 1) {
    return 0.9;
  }
  return round4(0.9 - (0.4 * index) / (total - 1));
}

function round4(value: number) {
  return Number(value.toFixed(4));
}
