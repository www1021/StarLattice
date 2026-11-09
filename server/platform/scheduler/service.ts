import type { NodeKind } from "../types.js";
import type { PlatformStateStore } from "../runtime/stateStore.js";
import { buildTaskProfile, effectivePriorityOf, explainPriority, type TaskProfile } from "./profiler.js";

/** 任务在真正开始前被调度层撤销（运行停止/失败/取消），执行器按“未执行”处理。 */
export class SchedulerTaskCancelledError extends Error {
  constructor(message = "任务在调度队列中被撤销。") {
    super(message);
    this.name = "SchedulerTaskCancelledError";
  }
}

export type SchedulerTaskRequest = {
  runId: string;
  nodeId: string;
  path: string;
  kind: NodeKind;
  criticalPathDepth: number;
  maxDepth: number;
  agentId?: string;
  maxAttempts?: number;
  /** 运行级优先档覆盖节点类别档；不传时用节点类别。 */
  priorityClass?: number;
  deadlineAt?: string;
  inputTokens?: number;
  execute: () => Promise<void>;
};

export type SchedulerServiceOptions = {
  capacity?: number;
  workerId?: string;
  claimTtlMs?: number;
  now?: () => number;
  /** priority（默认，运行中动态排序）或 fifo（固定先到先得，用于静态基线对照）。 */
  selection?: "priority" | "fifo";
};

export type SchedulerServiceSnapshot = {
  workerId: string;
  capacity: number;
  running: number;
  pending: number;
  tasks: Array<{
    queueId: string;
    runId: string;
    nodeId: string;
    path: string;
    state: "pending" | "running";
    effectivePriority: number;
    reason: string;
  }>;
};

type PendingTask = {
  queueId: string;
  request: SchedulerTaskRequest;
  profile: TaskProfile;
  resolve: () => void;
  reject: (error: unknown) => void;
};

/**
 * 运行中全局调度：同一执行器内的所有运行共享一个队列和一组并发槽位。
 * 排序依据是任务画像（类别、关键路径、等待老化、截止时间），而不是提交顺序，
 * 因此高优运行可以在低优运行的任务之间抢先获得下一个空槽。
 *
 * 本阶段仍是进程内执行：认领、尝试与队列状态落库，真正的 Worker 进程在后续阶段接入。
 */
export class SchedulerService {
  private readonly pending = new Map<string, PendingTask>();
  private readonly running = new Map<string, PendingTask>();
  private readonly cancelledRuns = new Set<string>();
  private readonly capacity: number;
  private readonly claimTtlMs: number;
  private readonly now: () => number;
  private readonly selection: "priority" | "fifo";
  readonly workerId: string;
  private pumpScheduled = false;
  private registered = false;

  constructor(
    private readonly store: PlatformStateStore,
    options: SchedulerServiceOptions = {}
  ) {
    this.capacity = Math.max(1, Math.trunc(options.capacity ?? 1));
    this.claimTtlMs = Math.max(1000, Math.trunc(options.claimTtlMs ?? 15000));
    this.now = options.now ?? (() => Date.now());
    this.selection = options.selection ?? "priority";
    this.workerId = options.workerId ?? `inline-worker-${process.pid}`;
  }

  /**
   * 首次真正参与调度时才登记进程内 Worker：Worker 子进程也会构造执行器，
   * 若不懒注册，每个子进程都会在库里留下一条并不接管队列的 inline Worker。
   */
  private ensureWorker() {
    if (this.registered) {
      return;
    }
    this.registered = true;
    this.store.upsertSchedulerWorker({
      id: this.workerId,
      host: "local",
      pid: process.pid,
      lane: "inline",
      capabilities: ["*"],
      capacity: this.capacity,
      status: "idle",
      // 进程内 Worker 由构造它的执行器持有；长 TTL 避免空闲期被误判失联。
      ttlMs: 10 * 60_000,
      meta: { mode: "inline" }
    });
  }

  get capacityValue() {
    return this.capacity;
  }

  /**
   * 提交一个可运行任务。返回的 Promise 在执行成功时完成、失败时拒绝；
   * 任务进入队列后即按有效优先级参与全局排序，不保证先进先出。
   */
  submit(request: SchedulerTaskRequest): Promise<void> {
    if (this.cancelledRuns.has(request.runId)) {
      return Promise.reject(new SchedulerTaskCancelledError("运行已停止，任务未入队。"));
    }
    const profile = buildTaskProfile({
      kind: request.kind,
      criticalPathDepth: request.criticalPathDepth,
      maxDepth: request.maxDepth,
      inputTokens: request.inputTokens,
      priorityClass: request.priorityClass,
      deadlineAt: request.deadlineAt,
      enqueuedAt: this.now()
    });
    const priorityClass = Math.floor(profile.base / 100);
    this.ensureWorker();
    const queueId = this.store.enqueueSchedulerTask({
      runId: request.runId,
      nodeId: request.nodeId,
      path: request.path,
      priority: profile.basePriority,
      reason: explainPriority(profile, this.now()),
      priorityClass,
      effectivePriority: effectivePriorityOf(profile, this.now()),
      profile: { ...profile },
      agentId: request.agentId,
      maxAttempts: request.maxAttempts ?? 1,
      deadlineAt: request.deadlineAt
    });
    return new Promise<void>((resolve, reject) => {
      this.pending.set(queueId, { queueId, request, profile, resolve, reject });
      this.schedulePump();
    });
  }

  /** 撤销某个运行尚未开始的任务；已在执行的任务由执行器自行收尾。 */
  cancelRun(runId: string, reason = "运行已停止，未再调度。"): number {
    this.cancelledRuns.add(runId);
    const persisted = this.store.cancelQueuedSchedulerTasks(runId, reason);
    for (const [queueId, task] of [...this.pending]) {
      if (task.request.runId !== runId) {
        continue;
      }
      this.pending.delete(queueId);
      this.store.setRunNodeStatus(runId, task.request.nodeId, "cancelled", { error: reason });
      task.reject(new SchedulerTaskCancelledError(reason));
    }
    return persisted;
  }

  /** 运行进入终态后解除撤销标记，避免同一 runId 后续重试被误拒。 */
  completeRun(runId: string) {
    this.cancelledRuns.delete(runId);
  }

  /** 回收认领超时任务；进程内正常路径下认领与执行几乎连续，主要面向异常退出的残留。 */
  reclaim(): { requeued: string[]; expired: string[] } {
    const result = this.store.reclaimExpiredSchedulerTasks(this.now());
    if (result.requeued.length > 0) {
      // 被回收的多是其他执行器留下的认领，本进程没有对应回调，只能保留在库中供恢复阶段处理。
      this.schedulePump();
    }
    return result;
  }

  snapshot(): SchedulerServiceSnapshot {
    const now = this.now();
    const tasks: SchedulerServiceSnapshot["tasks"] = [];
    for (const task of this.pending.values()) {
      tasks.push({
        queueId: task.queueId,
        runId: task.request.runId,
        nodeId: task.request.nodeId,
        path: task.request.path,
        state: "pending",
        effectivePriority: effectivePriorityOf(task.profile, now),
        reason: explainPriority(task.profile, now)
      });
    }
    for (const task of this.running.values()) {
      tasks.push({
        queueId: task.queueId,
        runId: task.request.runId,
        nodeId: task.request.nodeId,
        path: task.request.path,
        state: "running",
        effectivePriority: effectivePriorityOf(task.profile, now),
        reason: explainPriority(task.profile, now)
      });
    }
    return {
      workerId: this.workerId,
      capacity: this.capacity,
      running: this.running.size,
      pending: this.pending.size,
      tasks
    };
  }

  /** 关闭服务：撤销所有未开始任务并把 Worker 标记为 draining，不影响已在执行的步骤。 */
  shutdown(reason = "调度服务已关闭。") {
    for (const runId of new Set([...this.pending.values()].map((task) => task.request.runId))) {
      this.cancelRun(runId, reason);
    }
    if (this.registered) {
      this.store.setSchedulerWorkerStatus(this.workerId, "draining", reason);
    }
  }

  /**
   * 同一轮提交通常来自一个就绪批次；延迟到微任务再出队，
   * 才能把批次内所有候选放在一起按有效优先级比较，而不是先到先跑。
   */
  private schedulePump() {
    if (this.pumpScheduled) {
      return;
    }
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump() {
    while (this.running.size < this.capacity && this.pending.size > 0) {
      const now = this.now();
      const next = this.selectNext(now);
      if (!next) {
        return;
      }
      this.pending.delete(next.queueId);
      const claimed = this.store.claimSchedulerTask(next.queueId, this.workerId, this.claimTtlMs);
      if (!claimed) {
        next.reject(new Error("任务已被其他调度器认领或撤销。"));
        continue;
      }
      this.running.set(next.queueId, next);
      this.store.startSchedulerTask(next.queueId);
      const attempt = this.store.startSchedulerAttempt({
        queueId: next.queueId,
        attempt: claimed.attempts,
        workerId: this.workerId,
        agentId: next.request.agentId,
        trace: {
          profile: next.profile,
          priority: effectivePriorityOf(next.profile, now),
          reason: explainPriority(next.profile, now)
        }
      });
      this.store.setRunNodeStatus(next.request.runId, next.request.nodeId, "running", {
        attempts: claimed.attempts
      });
      this.store.setSchedulerWorkerStatus(this.workerId, "busy");
      void this.dispatch(next, attempt.id);
    }
  }

  private selectNext(now: number): PendingTask | undefined {
    let best: PendingTask | undefined;
    let bestPriority = Number.NEGATIVE_INFINITY;
    for (const task of this.pending.values()) {
      const priority = effectivePriorityOf(task.profile, now);
      // 静态基线只认提交顺序，忽略类别/关键路径/老化/截止时间。
      const better =
        !best ||
        (this.selection === "fifo"
          ? task.profile.enqueuedAt < best.profile.enqueuedAt ||
            (task.profile.enqueuedAt === best.profile.enqueuedAt && task.queueId < best.queueId)
          : priority > bestPriority ||
            (priority === bestPriority && task.profile.enqueuedAt < best.profile.enqueuedAt) ||
            (priority === bestPriority &&
              task.profile.enqueuedAt === best.profile.enqueuedAt &&
              task.queueId < best.queueId));
      if (better) {
        best = task;
        bestPriority = priority;
      }
    }
    return best;
  }

  private async dispatch(task: PendingTask, attemptId: string) {
    try {
      await task.request.execute();
      this.store.finishSchedulerAttempt(attemptId, "succeeded");
      this.store.finishSchedulerTask(task.queueId, "succeeded");
      this.store.setRunNodeStatus(task.request.runId, task.request.nodeId, "succeeded");
      task.resolve();
    } catch (error) {
      const cancelled =
        error instanceof SchedulerTaskCancelledError ||
        (error instanceof Error && error.name === "RunCancelledError");
      const message = error instanceof Error ? error.message : String(error);
      this.store.finishSchedulerAttempt(attemptId, cancelled ? "cancelled" : "failed", message);
      this.store.finishSchedulerTask(task.queueId, cancelled ? "cancelled" : "failed", message);
      this.store.setRunNodeStatus(
        task.request.runId,
        task.request.nodeId,
        cancelled ? "cancelled" : "failed",
        { error: message }
      );
      task.reject(error);
    } finally {
      this.running.delete(task.queueId);
      if (this.running.size === 0) {
        this.store.setSchedulerWorkerStatus(this.workerId, "idle");
      }
      this.schedulePump();
    }
  }
}
