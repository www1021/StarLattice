import { randomUUID } from "node:crypto";
import { PlatformError, type AgentRecord } from "../types.js";

export type SchedulerWeights = {
  capability: number;
  availability: number;
  priority: number;
};

export const DEFAULT_SCHEDULER_WEIGHTS: SchedulerWeights = {
  capability: 0.5,
  availability: 0.3,
  priority: 0.2
};

export const SCHEDULER_FORMULA = "0.5 × 能力匹配 + 0.3 × 可用度 + 0.2 × 优先级";

export type ScheduleTask = {
  id: string;
  title?: string;
  capabilities: string[];
  priority?: number;
  dependsOn?: string[];
  allowedAgentIds?: string[];
};

export type AgentLoadInput = {
  inFlight?: number;
  capacity?: number;
};

export type SchedulerOptions = {
  completedTaskIds?: string[];
  loads?: Record<string, AgentLoadInput>;
  weights?: Partial<SchedulerWeights>;
  reserve?: boolean;
};

export type CapabilityMatch = {
  tag: string;
  requested: string;
  weight: number;
};

export type ScheduleDecision = {
  taskId: string;
  taskTitle: string;
  agentId: string;
  agentName: string;
  dependsOn: string[];
  score: number;
  breakdown: {
    capability: number;
    availability: number;
    priority: number;
  };
  matchedCapabilities: CapabilityMatch[];
  missingCapabilities: string[];
  load: {
    inFlight: number;
    capacity: number;
    ratio: number;
  };
  reason: string;
  alternatives: Array<{
    agentId: string;
    agentName: string;
    score: number;
    capability: number;
  }>;
};

export type BlockedTask = {
  taskId: string;
  taskTitle: string;
  blockedBy: string[];
  reason: string;
};

export type UnassignedTask = {
  taskId: string;
  taskTitle: string;
  reason: string;
  candidates: Array<{
    agentId: string;
    agentName: string;
    capability: number;
    missingCapabilities: string[];
  }>;
};

export type SchedulePlan = {
  batchId: string;
  formula: string;
  weights: SchedulerWeights;
  decisions: ScheduleDecision[];
  blocked: BlockedTask[];
  unassigned: UnassignedTask[];
  stats: {
    taskCount: number;
    scheduledCount: number;
    blockedCount: number;
    unassignedCount: number;
  };
};

type Candidate = {
  agent: AgentRecord;
  capability: number;
  matched: CapabilityMatch[];
  missing: string[];
  availability: number;
  priority: number;
  score: number;
  load: {
    inFlight: number;
    capacity: number;
    ratio: number;
  };
};

type AgentLoad = {
  inFlight: number;
  capacity: number;
};

export function createSchedule(
  tasks: ScheduleTask[],
  agents: AgentRecord[],
  options: SchedulerOptions = {}
): SchedulePlan {
  const weights = resolveWeights(options.weights);
  const completed = new Set(options.completedTaskIds ?? []);
  const taskMap = new Map<string, ScheduleTask>();
  for (const task of tasks) {
    if (taskMap.has(task.id)) {
      throw new PlatformError(`任务 id 重复：${task.id}`, 400);
    }
    taskMap.set(task.id, task);
  }

  const loads = new Map<string, AgentLoad>();
  for (const agent of agents) {
    const input = options.loads?.[agent.id];
    loads.set(agent.id, {
      inFlight: Math.max(0, Math.trunc(input?.inFlight ?? 0)),
      capacity: Math.max(1, Math.trunc(input?.capacity ?? 1))
    });
  }

  const scheduled = new Set(completed);
  const decisions: ScheduleDecision[] = [];
  const unassigned: UnassignedTask[] = [];
  const pending = [...tasks];
  let progressed = true;

  while (pending.length > 0 && progressed) {
    progressed = false;
    pending.sort((left, right) => priorityOf(right) - priorityOf(left));
    for (let index = 0; index < pending.length; index += 1) {
      const task = pending[index];
      const unmet = unmetDependencies(task, scheduled);
      if (unmet.length > 0) {
        continue;
      }

      const candidates = evaluateCandidates(task, agents, loads, weights);
      const eligible = candidates.filter(
        (candidate) => task.capabilities.length === 0 || candidate.capability > 0
      );
      if (eligible.length === 0) {
        unassigned.push(buildUnassigned(task, candidates));
      } else {
        const best = eligible[0];
        const alternatives = eligible.slice(1).map((candidate) => ({
          agentId: candidate.agent.id,
          agentName: candidate.agent.name,
          score: candidate.score,
          capability: candidate.capability
        }));
        decisions.push({
          taskId: task.id,
          taskTitle: task.title ?? task.id,
          agentId: best.agent.id,
          agentName: best.agent.name,
          dependsOn: task.dependsOn ?? [],
          score: best.score,
          breakdown: {
            capability: best.capability,
            availability: best.availability,
            priority: best.priority
          },
          matchedCapabilities: best.matched,
          missingCapabilities: best.missing,
          load: best.load,
          reason: buildReason(best, eligible.slice(1)),
          alternatives
        });
        scheduled.add(task.id);
        if (options.reserve !== false) {
          const load = loads.get(best.agent.id)!;
          load.inFlight += 1;
        }
      }

      pending.splice(index, 1);
      index -= 1;
      progressed = true;
    }
  }

  const blocked = pending.map((task) => {
    const blockedBy = unmetDependencies(task, scheduled);
    return {
      taskId: task.id,
      taskTitle: task.title ?? task.id,
      blockedBy,
      reason: `依赖 ${blockedBy.join("、") || "未知任务"} 尚未完成，也未排入本批次。`
    };
  });

  return {
    batchId: `batch_${randomUUID()}`,
    formula: SCHEDULER_FORMULA,
    weights,
    decisions,
    blocked,
    unassigned,
    stats: {
      taskCount: tasks.length,
      scheduledCount: decisions.length,
      blockedCount: blocked.length,
      unassignedCount: unassigned.length
    }
  };
}

function evaluateCandidates(
  task: ScheduleTask,
  agents: AgentRecord[],
  loads: Map<string, AgentLoad>,
  weights: SchedulerWeights
): Candidate[] {
  const allowed =
    task.allowedAgentIds && task.allowedAgentIds.length > 0
      ? new Set(task.allowedAgentIds)
      : undefined;
  const priority = priorityOf(task);
  const candidates: Candidate[] = [];

  for (const agent of agents) {
    if (!agent.enabled || (allowed && !allowed.has(agent.id))) {
      continue;
    }
    const match = matchCapabilities(agent, task.capabilities);
    const load = loads.get(agent.id) ?? { inFlight: 0, capacity: 1 };
    const ratio = Math.min(1, load.inFlight / load.capacity);
    const availability = round4(1 - ratio);
    const score = round4(
      weights.capability * match.capability +
        weights.availability * availability +
        weights.priority * priority
    );
    candidates.push({
      agent,
      capability: match.capability,
      matched: match.matched,
      missing: match.missing,
      availability,
      priority,
      score,
      load: { ...load, ratio: round4(ratio) }
    });
  }

  return candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.capability - left.capability ||
      left.agent.id.localeCompare(right.agent.id)
  );
}

function matchCapabilities(agent: AgentRecord, required: string[]) {
  const matched: CapabilityMatch[] = [];
  const missing: string[] = [];

  for (const requested of required) {
    const found = agent.capabilities
      .filter((capability) => overlaps(capability.tag, requested))
      .sort((left, right) => right.weight - left.weight)[0];
    if (found) {
      matched.push({ tag: found.tag, requested, weight: found.weight });
    } else {
      missing.push(requested);
    }
  }

  const capability =
    required.length === 0
      ? 0.5
      : matched.reduce((sum, item) => sum + item.weight, 0) / required.length;
  return { matched, missing, capability: round4(capability) };
}

function overlaps(capabilityTag: string, requested: string) {
  const left = capabilityTag.trim().toLowerCase();
  const right = requested.trim().toLowerCase();
  return left === right || left.includes(right) || right.includes(left);
}

function buildReason(best: Candidate, alternatives: Candidate[]) {
  const capabilityText =
    best.matched.length > 0
      ? best.matched.map((item) => `${item.tag} ${item.weight.toFixed(2)}`).join("、")
      : "通用任务，无指定能力标签";
  const alternativeText =
    alternatives.length > 0
      ? `；次选 ${alternatives
          .slice(0, 2)
          .map((item) => `${item.agent.name}（${item.score.toFixed(2)}）`)
          .join("、")}`
      : "；无其他候选";
  return `选择 ${best.agent.name}：能力匹配 ${best.capability.toFixed(2)}（${capabilityText}），可用度 ${best.availability.toFixed(2)}（负载 ${best.load.inFlight}/${best.load.capacity}），优先级 ${best.priority.toFixed(2)}，综合得分 ${best.score.toFixed(2)}${alternativeText}。`;
}

function buildUnassigned(task: ScheduleTask, candidates: Candidate[]): UnassignedTask {
  const capabilityText =
    task.capabilities.length > 0
      ? `「${task.capabilities.join("、")}」`
      : "任务所需";
  return {
    taskId: task.id,
    taskTitle: task.title ?? task.id,
    reason: `没有具备 ${capabilityText} 能力且启用的 Agent，未分配。`,
    candidates: candidates.slice(0, 3).map((candidate) => ({
      agentId: candidate.agent.id,
      agentName: candidate.agent.name,
      capability: candidate.capability,
      missingCapabilities: candidate.missing
    }))
  };
}

function unmetDependencies(task: ScheduleTask, scheduled: Set<string>) {
  return (task.dependsOn ?? []).filter((dependency) => !scheduled.has(dependency));
}

function priorityOf(task: ScheduleTask) {
  return clampNumber(task.priority ?? 0.5, 0, 1);
}

function resolveWeights(weights?: Partial<SchedulerWeights>): SchedulerWeights {
  return {
    capability: clampNumber(weights?.capability ?? DEFAULT_SCHEDULER_WEIGHTS.capability, 0, 1),
    availability: clampNumber(
      weights?.availability ?? DEFAULT_SCHEDULER_WEIGHTS.availability,
      0,
      1
    ),
    priority: clampNumber(weights?.priority ?? DEFAULT_SCHEDULER_WEIGHTS.priority, 0, 1)
  };
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function round4(value: number) {
  return Number(value.toFixed(4));
}

export function parseScheduleRequest(body: unknown): {
  tasks: ScheduleTask[];
  options: SchedulerOptions;
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PlatformError("请求体必须是 JSON 对象。", 400);
  }
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.tasks) || record.tasks.length === 0) {
    throw new PlatformError("tasks 必须是非空数组。", 400);
  }
  const tasks = record.tasks.map((item, index) => parseTask(item, index));
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      throw new PlatformError(`任务 id 重复：${task.id}`, 400);
    }
    seen.add(task.id);
  }

  return {
    tasks,
    options: {
      completedTaskIds: parseStringArray(record.completedTaskIds, "completedTaskIds"),
      loads: parseLoads(record.loads),
      reserve: typeof record.reserve === "boolean" ? record.reserve : true,
      weights:
        record.weights === undefined
          ? undefined
          : {
              capability: parseWeight(record.weights, "capability"),
              availability: parseWeight(record.weights, "availability"),
              priority: parseWeight(record.weights, "priority")
            }
    }
  };
}

function parseTask(value: unknown, index: number): ScheduleTask {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformError(`tasks[${index}] 必须是对象。`, 400);
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) {
    throw new PlatformError(`tasks[${index}].id 不能为空。`, 400);
  }
  if (!Array.isArray(record.capabilities) || record.capabilities.length === 0) {
    throw new PlatformError(`tasks[${index}].capabilities 至少需要一个能力标签。`, 400);
  }
  const capabilities = parseStringArray(record.capabilities, `tasks[${index}].capabilities`);
  if (record.priority !== undefined) {
    if (
      typeof record.priority !== "number" ||
      !Number.isFinite(record.priority) ||
      record.priority < 0 ||
      record.priority > 1
    ) {
      throw new PlatformError(`tasks[${index}].priority 必须是 0 到 1 之间的数字。`, 400);
    }
  }
  return {
    id,
    title: typeof record.title === "string" ? record.title : undefined,
    capabilities,
    priority: record.priority as number | undefined,
    dependsOn: parseStringArray(record.dependsOn, `tasks[${index}].dependsOn`),
    allowedAgentIds: parseStringArray(record.allowedAgentIds, `tasks[${index}].allowedAgentIds`)
  };
}

function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new PlatformError(`${field} 必须是非空字符串数组。`, 400);
  }
  return value.map((item) => (item as string).trim());
}

function parseLoads(value: unknown): Record<string, AgentLoadInput> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PlatformError("loads 必须是对象。", 400);
  }
  const loads: Record<string, AgentLoadInput> = {};
  for (const [agentId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new PlatformError(`loads.${agentId} 必须是对象。`, 400);
    }
    const record = raw as Record<string, unknown>;
    if (record.inFlight !== undefined && (typeof record.inFlight !== "number" || record.inFlight < 0)) {
      throw new PlatformError(`loads.${agentId}.inFlight 必须是非负数字。`, 400);
    }
    if (record.capacity !== undefined && (typeof record.capacity !== "number" || record.capacity < 1)) {
      throw new PlatformError(`loads.${agentId}.capacity 必须是不小于 1 的数字。`, 400);
    }
    loads[agentId] = {
      inFlight: record.inFlight as number | undefined,
      capacity: record.capacity as number | undefined
    };
  }
  return loads;
}

function parseWeight(weights: unknown, key: keyof SchedulerWeights): number | undefined {
  if (typeof weights !== "object" || weights === null || Array.isArray(weights)) {
    throw new PlatformError("weights 必须是对象。", 400);
  }
  const value = (weights as Record<string, unknown>)[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new PlatformError(`weights.${key} 必须是 0 到 1 之间的数字。`, 400);
  }
  return value;
}
