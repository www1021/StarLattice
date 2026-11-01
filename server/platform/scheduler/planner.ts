import type { AgentNode, AgentRecord, CompiledPlan } from "../types.js";
import { createSchedule, type SchedulePlan } from "./scheduler.js";

/**
 * 运行前调度计划：把 DSL 中所有 agent 节点转成调度任务，
 * 能力标签取自节点原本声明的 Agent，DSL 的 agent 字段保留为首选/回退。
 * 任务 id 使用编译后的 step.path，保证子工作流内的同名节点与父流程互不覆盖。
 */
export type WorkflowSchedulePlan = SchedulePlan & {
  requestedAgentIds: Record<string, string>;
};

export function buildWorkflowSchedule(
  plan: CompiledPlan,
  agents: AgentRecord[]
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
  const tasks = agentSteps.map((step, index) => {
    const node = step.node as AgentNode;
    const authored = byId.get(node.agent);
    requestedAgentIds[step.path] = node.agent;
    return {
      id: step.path,
      title: node.title ?? node.id,
      capabilities: authored?.capabilities.map((capability) => capability.tag) ?? [],
      priority: priorityFor(index, agentSteps.length),
      dependsOn: dependencies.get(step.path) ?? [],
      // 声明的 Agent 不在注册中心时限制候选，避免被分给无关 Agent；执行器仍会回退到 DSL 声明值。
      ...(authored ? {} : { allowedAgentIds: [node.agent] })
    };
  });

  return {
    ...createSchedule(tasks, agents, { reserve: true }),
    requestedAgentIds
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

function priorityFor(index: number, total: number) {
  if (total <= 1) {
    return 0.9;
  }
  return round4(0.9 - (0.4 * index) / (total - 1));
}

function round4(value: number) {
  return Number(value.toFixed(4));
}
