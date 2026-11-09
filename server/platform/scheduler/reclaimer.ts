import { hostname } from "node:os";
import type { WorkflowExecutor } from "../runtime/executor.js";
import type { PlatformStateStore } from "../runtime/stateStore.js";

export type ReclaimerOptions = {
  store: PlatformStateStore;
  executor: WorkflowExecutor;
  /** 轮询间隔；0 表示只允许手动触发。 */
  intervalMs?: number;
  /** Leader 租约时长与该轮心跳共用的 TTL。 */
  ttlMs?: number;
  /** queued 运行至少停留多久才视为“落库后未执行”；避免抢跑刚创建的运行。 */
  graceMs?: number;
  /** 启动时被标记 interrupted 的运行的恢复窗口。 */
  recoverWindowMs?: number;
  /** 是否自动从检查点续跑；关闭时只清理租约/队列/Worker 记录。 */
  autoResume?: boolean;
  maxResumesPerTick?: number;
  holder?: string;
  now?: () => number;
};

export type ReclaimerReport = {
  at: string;
  leader: boolean;
  holder: string;
  leadership?: { holder: string; expiresAt: string };
  autoResume: boolean;
  expiredWorkers: number;
  expiredLeases: number;
  requeuedTasks: string[];
  expiredTasks: string[];
  orphanRuns: {
    requeued: Array<{
      previousRunId: string;
      runId: string;
      resumed: boolean;
      checkpointSequence?: number;
    }>;
    skipped: Array<{ runId: string; reason: string }>;
  };
  resumed: Array<{ previousRunId: string; runId: string; reason: string }>;
  skipped: Array<{ runId: string; reason: string }>;
};

const EMPTY_ORPHANS: ReclaimerReport["orphanRuns"] = { requeued: [], skipped: [] };

/**
 * 周期回收器：同一时刻只有获得租约的实例执行清理，避免多实例重复恢复同一批运行。
 * 清理范围包括过期 Worker/租约/队列认领、孤儿运行，以及启动时被中断的可恢复运行。
 */
export class SchedulerReclaimer {
  private readonly store: PlatformStateStore;
  private readonly executor: WorkflowExecutor;
  private readonly intervalMs: number;
  private readonly ttlMs: number;
  private readonly graceMs: number;
  private readonly recoverWindowMs: number;
  private readonly maxResumesPerTick: number;
  private readonly now: () => number;
  readonly autoResume: boolean;
  readonly holder: string;
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private lastReport?: ReclaimerReport;

  constructor(options: ReclaimerOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.intervalMs = Math.max(0, Math.trunc(options.intervalMs ?? 15000));
    this.ttlMs = Math.max(1000, Math.trunc(options.ttlMs ?? 15000));
    this.graceMs = Math.max(0, Math.trunc(options.graceMs ?? 60_000));
    this.recoverWindowMs = Math.max(0, Math.trunc(options.recoverWindowMs ?? 3_600_000));
    this.maxResumesPerTick = Math.max(1, Math.trunc(options.maxResumesPerTick ?? 3));
    this.now = options.now ?? (() => Date.now());
    this.autoResume = options.autoResume ?? false;
    this.holder =
      options.holder ??
      process.env.PLATFORM_WORKER_ID?.trim() ??
      `${hostname()}:${process.pid}:reclaimer`;
  }

  start() {
    if (this.timer || this.intervalMs <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // 单轮失败不影响下一轮；错误会记录在下一份报告里。
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.store.releaseSchedulerLeadership(this.holder);
  }

  status() {
    const leadership = this.store.getSchedulerLeadership();
    return {
      holder: this.holder,
      leader: leadership?.holder === this.holder,
      intervalMs: this.intervalMs,
      autoResume: this.autoResume,
      graceMs: this.graceMs,
      lastTickAt: this.lastReport?.at,
      lastReport: this.lastReport
    };
  }

  async tick(options: { force?: boolean } = {}): Promise<ReclaimerReport> {
    if (this.ticking) {
      return this.lastReport ?? this.emptyReport(false);
    }
    this.ticking = true;
    try {
      const report = await this.runTick(options.force === true);
      this.lastReport = report;
      return report;
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(force: boolean): Promise<ReclaimerReport> {
    const now = this.now();
    if (!force) {
      if (!this.store.acquireSchedulerLeadership(this.holder, this.ttlMs)) {
        return this.emptyReport(false);
      }
      if (!this.store.heartbeatSchedulerLeadership(this.holder, this.ttlMs)) {
        return this.emptyReport(false);
      }
    }
    const leadership = this.store.getSchedulerLeadership();
    const expiredWorkers = this.store.expireSchedulerWorkers(now);
    const expiredLeases = this.store.expireSchedulerLeases(now);
    const tasks = this.executor.reclaimSchedulerTasks();
    const orphanRuns = this.autoResume
      ? await this.executor.requeueOrphanedRuns({ wait: false })
      : EMPTY_ORPHANS;

    const resumed: ReclaimerReport["resumed"] = [];
    const skipped: ReclaimerReport["skipped"] = [];
    if (this.autoResume) {
      const candidates = [
        ...this.store.listQueuedRunsOlderThan(new Date(now - this.graceMs), 10).map((run) => ({
          runId: run.id,
          reason: "queued_timeout"
        })),
        ...this.store
          .listInterruptedRunsSince(new Date(now - this.recoverWindowMs), 10)
          .map((run) => ({ runId: run.id, reason: "interrupted_restart" }))
      ].slice(0, this.maxResumesPerTick);
      for (const candidate of candidates) {
        if (!this.store.hasRunCheckpoint(candidate.runId)) {
          skipped.push({ runId: candidate.runId, reason: "没有检查点，无法续跑。" });
          continue;
        }
        if (this.store.getRun(candidate.runId)?.schedulerState === "recover_queued") {
          continue;
        }
        try {
          const next = this.executor.startResume(candidate.runId);
          this.store.updateRunSchedulerState(candidate.runId, "recover_queued");
          resumed.push({
            previousRunId: candidate.runId,
            runId: next.id,
            reason: candidate.reason
          });
        } catch (error) {
          skipped.push({
            runId: candidate.runId,
            reason: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    return {
      at: new Date(now).toISOString(),
      leader: true,
      holder: this.holder,
      leadership: leadership
        ? { holder: leadership.holder, expiresAt: leadership.expiresAt }
        : undefined,
      autoResume: this.autoResume,
      expiredWorkers,
      expiredLeases,
      requeuedTasks: tasks.requeued,
      expiredTasks: tasks.expired,
      orphanRuns,
      resumed,
      skipped
    };
  }

  private emptyReport(leader: boolean): ReclaimerReport {
    return {
      at: new Date(this.now()).toISOString(),
      leader,
      holder: this.holder,
      autoResume: this.autoResume,
      expiredWorkers: 0,
      expiredLeases: 0,
      requeuedTasks: [],
      expiredTasks: [],
      orphanRuns: EMPTY_ORPHANS,
      resumed: [],
      skipped: []
    };
  }
}
