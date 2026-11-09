import { PlatformError, type SchedulerQueueEntry } from "../types.js";
import { effectivePriorityOf, type TaskProfile } from "./profiler.js";

export type ReplayPolicy = "dynamic" | "static" | "critical-path" | "fifo" | "recorded";

export const REPLAY_POLICIES: ReplayPolicy[] = [
  "dynamic",
  "static",
  "critical-path",
  "fifo",
  "recorded"
];

export type ReplayTask = {
  id: string;
  runId: string;
  nodeId: string;
  path: string;
  /** 进入就绪队列的时间（毫秒时间戳）。 */
  enqueuedAt: number;
  /** 实际执行耗时；<=0 时按 1ms 计，避免零时长事件循环。 */
  durationMs: number;
  /** 关键路径基础分 0.5–1。 */
  priority: number;
  priorityClass: number;
  criticalPathDepth: number;
  maxDepth: number;
  deadlineAt?: number;
  /** 原 trace 里的实际开工时间，用于 recorded 基线。 */
  startedAt?: number;
  /** 稳定排序用的入队序号。 */
  sequence: number;
};

export type ReplayTaskResult = {
  id: string;
  runId: string;
  path: string;
  startAt: number;
  finishAt: number;
  waitMs: number;
  durationMs: number;
  late: boolean;
};

export type ReplayMetrics = {
  policy: ReplayPolicy;
  capacity: number;
  tasks: number;
  makespanMs: number;
  waitP50Ms: number;
  waitP95Ms: number;
  waitMaxMs: number;
  avgWaitMs: number;
  deadlineMisses: number;
  priorityInversions: number;
  utilization: number;
};

export type ReplayResult = {
  metrics: ReplayMetrics;
  tasks: ReplayTaskResult[];
};

type RunningTask = {
  task: ReplayTask;
  result: ReplayTaskResult;
};

/** 把调度队列记录转成可回放任务；未完成的条目没有真实耗时，直接跳过。 */
export function replayTasksFromQueue(entries: SchedulerQueueEntry[]): ReplayTask[] {
  const tasks: ReplayTask[] = [];
  entries.forEach((entry, index) => {
    if (!entry.startedAt || !entry.finishedAt) {
      return;
    }
    const started = Date.parse(entry.startedAt);
    const finished = Date.parse(entry.finishedAt);
    const enqueued = Date.parse(entry.enqueuedAt);
    if (!Number.isFinite(started) || !Number.isFinite(finished) || !Number.isFinite(enqueued)) {
      return;
    }
    const profile = (entry.profile ?? {}) as Partial<TaskProfile>;
    tasks.push({
      id: entry.id,
      runId: entry.runId,
      nodeId: entry.nodeId,
      path: entry.path,
      enqueuedAt: enqueued,
      durationMs: Math.max(1, finished - started),
      priority: Number(profile.basePriority ?? entry.priority ?? 0.5),
      priorityClass: Number(entry.priorityClass ?? 0),
      criticalPathDepth: Number(profile.criticalPathDepth ?? 0),
      maxDepth: Number(profile.maxDepth ?? 0),
      ...(entry.deadlineAt ? { deadlineAt: Date.parse(entry.deadlineAt) } : {}),
      startedAt: started,
      sequence: index
    });
  });
  return tasks;
}

/**
 * 离线回放：同一批任务与并发容量下，按不同出队策略重新模拟。
 * 任务的实际耗时取自历史 trace，因此比较的是“同样工作量下排队顺序”的差异。
 */
export function replaySchedule(
  tasks: ReplayTask[],
  options: { capacity: number; policy: ReplayPolicy }
): ReplayResult {
  const capacity = Math.max(1, Math.trunc(options.capacity));
  if (options.policy === "recorded") {
    const results = tasks
      .filter((task) => task.startedAt !== undefined)
      .map((task) => {
        const startAt = task.startedAt!;
        const finishAt = startAt + Math.max(1, task.durationMs);
        return {
          id: task.id,
          runId: task.runId,
          path: task.path,
          startAt,
          finishAt,
          waitMs: Math.max(0, startAt - task.enqueuedAt),
          durationMs: Math.max(1, task.durationMs),
          late: task.deadlineAt !== undefined && finishAt > task.deadlineAt
        };
      });
    return { metrics: metricsOf("recorded", capacity, tasks, results), tasks: results };
  }

  const arrivals = [...tasks].sort(
    (left, right) => left.enqueuedAt - right.enqueuedAt || left.sequence - right.sequence
  );
  const results: ReplayTaskResult[] = [];
  const pending: ReplayTask[] = [];
  const running: RunningTask[] = [];
  let arrivalIndex = 0;
  let cursor = arrivals[0]?.enqueuedAt ?? 0;
  let guard = 0;

  while (arrivalIndex < arrivals.length || pending.length > 0 || running.length > 0) {
    if (++guard > tasks.length * 4 + 1000) {
      break;
    }
    if (running.length === 0 && pending.length === 0 && arrivalIndex < arrivals.length) {
      cursor = Math.max(cursor, arrivals[arrivalIndex].enqueuedAt);
    }

    // 先结算已经完成的运行，再放入已到达的任务。
    for (let index = running.length - 1; index >= 0; index -= 1) {
      if (running[index].result.finishAt <= cursor) {
        results.push(running[index].result);
        running.splice(index, 1);
      }
    }
    while (arrivalIndex < arrivals.length && arrivals[arrivalIndex].enqueuedAt <= cursor) {
      pending.push(arrivals[arrivalIndex]);
      arrivalIndex += 1;
    }

    while (running.length < capacity && pending.length > 0) {
      const next = takeNext(pending, options.policy, cursor);
      const startAt = cursor;
      const duration = Math.max(1, next.durationMs);
      const finishAt = startAt + duration;
      running.push({
        task: next,
        result: {
          id: next.id,
          runId: next.runId,
          path: next.path,
          startAt,
          finishAt,
          waitMs: Math.max(0, startAt - next.enqueuedAt),
          durationMs: duration,
          late: next.deadlineAt !== undefined && finishAt > next.deadlineAt
        }
      });
    }

    if (running.length > 0) {
      const nextFinish = Math.min(...running.map((item) => item.result.finishAt));
      const nextArrival =
        arrivalIndex < arrivals.length ? arrivals[arrivalIndex].enqueuedAt : Number.POSITIVE_INFINITY;
      cursor = Math.min(nextFinish, nextArrival);
    } else if (arrivalIndex < arrivals.length) {
      cursor = arrivals[arrivalIndex].enqueuedAt;
    }
  }

  return { metrics: metricsOf(options.policy, capacity, tasks, results), tasks: results };
}

export function compareReplayPolicies(
  tasks: ReplayTask[],
  options: { capacity: number; policies?: ReplayPolicy[] }
): Record<string, ReplayResult> {
  const policies = options.policies?.length ? options.policies : REPLAY_POLICIES;
  const results: Record<string, ReplayResult> = {};
  for (const policy of policies) {
    results[policy] = replaySchedule(tasks, { capacity: options.capacity, policy });
  }
  return results;
}

export function isReplayPolicy(value: unknown): value is ReplayPolicy {
  return typeof value === "string" && (REPLAY_POLICIES as string[]).includes(value);
}

/** 请求体里的内联任务：供策略沙盒在没有历史运行时手工构造场景。 */
export function parseReplayTasks(raw: unknown): ReplayTask[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new PlatformError("tasks 必须是非空数组。", 400);
  }
  return raw.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new PlatformError(`tasks[${index}] 必须是对象。`, 400);
    }
    const record = item as Record<string, unknown>;
    const duration = Number(record.durationMs);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new PlatformError(`tasks[${index}].durationMs 必须是正数。`, 400);
    }
    const enqueued = Number(record.enqueuedAt ?? 0);
    const priority = Number(record.priority ?? 0.5);
    const priorityClass = Number(record.priorityClass ?? 0);
    const criticalPathDepth = Number(record.criticalPathDepth ?? 0);
    const maxDepth = Number(record.maxDepth ?? criticalPathDepth);
    const path = typeof record.path === "string" ? record.path : `task-${index}`;
    const startedAt = Number(record.startedAt);
    return {
      id: typeof record.id === "string" ? record.id : `replay-${index}-${path}`,
      runId: typeof record.runId === "string" ? record.runId : "sandbox",
      nodeId: typeof record.nodeId === "string" ? record.nodeId : path,
      path,
      enqueuedAt: Number.isFinite(enqueued) ? enqueued : 0,
      durationMs: duration,
      priority: Number.isFinite(priority) ? Math.min(1, Math.max(0, priority)) : 0.5,
      priorityClass: Number.isFinite(priorityClass) ? Math.trunc(priorityClass) : 0,
      criticalPathDepth: Number.isFinite(criticalPathDepth) ? criticalPathDepth : 0,
      maxDepth: Number.isFinite(maxDepth) ? maxDepth : criticalPathDepth,
      ...(record.deadlineAt === undefined
        ? {}
        : {
            deadlineAt:
              typeof record.deadlineAt === "string"
                ? Date.parse(record.deadlineAt)
                : Number(record.deadlineAt)
          }),
      ...(Number.isFinite(startedAt) ? { startedAt } : {}),
      sequence: index
    };
  });
}

function takeNext(pending: ReplayTask[], policy: ReplayPolicy, now: number): ReplayTask {
  let bestIndex = 0;
  let best = pending[0];
  for (let index = 1; index < pending.length; index += 1) {
    const candidate = pending[index];
    if (compareTasks(candidate, best, policy, now) < 0) {
      best = candidate;
      bestIndex = index;
    }
  }
  pending.splice(bestIndex, 1);
  return best;
}

/** 返回负数表示 left 应先执行。 */
function compareTasks(left: ReplayTask, right: ReplayTask, policy: ReplayPolicy, now: number): number {
  if (policy === "fifo") {
    return left.enqueuedAt - right.enqueuedAt || left.sequence - right.sequence;
  }
  if (policy === "critical-path") {
    return (
      right.criticalPathDepth - left.criticalPathDepth ||
      right.priorityClass - left.priorityClass ||
      left.enqueuedAt - right.enqueuedAt ||
      left.sequence - right.sequence
    );
  }
  if (policy === "static") {
    return (
      right.priorityClass - left.priorityClass ||
      right.priority - left.priority ||
      left.enqueuedAt - right.enqueuedAt ||
      left.sequence - right.sequence
    );
  }
  // dynamic：与运行时 SchedulerService 同口径，叠加等待老化与截止时间加成。
  const leftEffective = effectivePriorityOf(profileOf(left), now);
  const rightEffective = effectivePriorityOf(profileOf(right), now);
  return (
    rightEffective - leftEffective ||
    left.enqueuedAt - right.enqueuedAt ||
    left.sequence - right.sequence
  );
}

function profileOf(task: ReplayTask): TaskProfile {
  return {
    class: "tool",
    lane: "tool",
    base: task.priorityClass * 100 + task.priority * 10,
    basePriority: task.priority,
    criticalPathDepth: task.criticalPathDepth,
    maxDepth: task.maxDepth,
    inputTokens: 0,
    estimatedTokens: 0,
    enqueuedAt: task.enqueuedAt,
    ...(task.deadlineAt !== undefined ? { deadlineAt: task.deadlineAt } : {})
  };
}

function metricsOf(
  policy: ReplayPolicy,
  capacity: number,
  tasks: ReplayTask[],
  results: ReplayTaskResult[]
): ReplayMetrics {
  const waits = results.map((item) => item.waitMs).sort((left, right) => left - right);
  const startAt = results.length > 0 ? Math.min(...results.map((item) => item.startAt)) : 0;
  const finishAt = results.length > 0 ? Math.max(...results.map((item) => item.finishAt)) : 0;
  const makespanMs = Math.max(0, finishAt - startAt);
  const busyMs = results.reduce((sum, item) => sum + item.durationMs, 0);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  let inversions = 0;
  for (let left = 0; left < results.length; left += 1) {
    for (let right = left + 1; right < results.length; right += 1) {
      const a = results[left];
      const b = results[right];
      const taskA = byId.get(a.id);
      const taskB = byId.get(b.id);
      if (!taskA || !taskB) {
        continue;
      }
      const priorityA = taskA.priorityClass * 100 + taskA.priority * 10;
      const priorityB = taskB.priorityClass * 100 + taskB.priority * 10;
      if (priorityA === priorityB) {
        continue;
      }
      const lower = priorityA < priorityB ? a : b;
      const higher = priorityA < priorityB ? b : a;
      const lowerTask = priorityA < priorityB ? taskA : taskB;
      const higherTask = priorityA < priorityB ? taskB : taskA;
      // 高优任务在低优任务开工时已经就绪，却排在后面，记为一次倒挂。
      if (higher.startAt > lower.startAt && higherTask.enqueuedAt <= lower.startAt) {
        inversions += 1;
      }
    }
  }
  return {
    policy,
    capacity,
    tasks: results.length,
    makespanMs,
    waitP50Ms: percentile(waits, 0.5),
    waitP95Ms: percentile(waits, 0.95),
    waitMaxMs: waits[waits.length - 1] ?? 0,
    avgWaitMs: waits.length > 0 ? Number((waits.reduce((sum, item) => sum + item, 0) / waits.length).toFixed(1)) : 0,
    deadlineMisses: results.filter((item) => item.late).length,
    priorityInversions: inversions,
    utilization:
      makespanMs > 0 ? Number(Math.min(1, busyMs / (makespanMs * capacity)).toFixed(4)) : 0
  };
}

function percentile(sorted: number[], ratio: number) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}
