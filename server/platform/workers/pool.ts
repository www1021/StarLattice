import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import type { SchedulerWorkerStatus, ToolRecord } from "../types.js";
import type { PlatformStateStore } from "../runtime/stateStore.js";
import { WorkerLostError } from "./errors.js";
import {
  errorFromPayload,
  type ParentToWorkerMessage,
  type WorkerInvocation,
  type WorkerLease,
  type WorkerPoolLike,
  type WorkerServiceCall,
  type WorkerServiceReply,
  type WorkerSnapshot,
  type WorkerToParentMessage
} from "./protocol.js";

type KnowledgeRequest = {
  query: string;
  knowledgeBaseIds: string[];
  topK?: number;
};

export type ProcessWorkerPoolOptions = {
  size: number;
  store: PlatformStateStore;
  services: {
    searchKnowledge: (options: KnowledgeRequest) => Promise<unknown>;
    callMcpTool: (tool: ToolRecord, args: Record<string, unknown>) => Promise<unknown>;
    trainingTool: (tool: string, input: Record<string, unknown>) => unknown | Promise<unknown>;
  };
  lane?: string;
  idPrefix?: string;
  /** 默认按源码/编译产物自动解析到 stepWorker.ts / stepWorker.js。 */
  entry?: string;
  /** 传给子进程的环境变量覆盖；默认继承父进程。 */
  env?: NodeJS.ProcessEnv;
  heartbeatMs?: number;
  /** 优雅关闭时等待在飞步骤结束的上限。 */
  drainTimeoutMs?: number;
  debug?: boolean;
  onHeartbeat?: (workerId: string) => void;
  onWorkerExit?: (workerId: string) => void;
};

type PendingInvocation = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type Assignment = {
  taskKey: string;
  pending: Map<string, PendingInvocation>;
  abort: { promise: Promise<never>; reject: (error: Error) => void };
};

type WorkerProcess = {
  id: string;
  slot: number;
  pid?: number;
  child: ChildProcess;
  alive: boolean;
  ready: boolean;
  startedAt: number;
  lastHeartbeatAt: number;
  current?: Assignment;
  exited: boolean;
};

type Waiter = {
  taskKey: string;
  resolve: (lease: WorkerLease) => void;
  reject: (error: Error) => void;
};

/**
 * 真实 Worker 进程池：每个槽位一个长期存活的子进程，一次只执行一个叶子步骤。
 * 父进程按槽位发放租约；子进程被终止或心跳超时时，当前步骤以 WorkerLostError 失败，
 * 由调度器/执行器的重试逻辑重新派发，同时补起一个新进程顶替该槽位。
 */
export class ProcessWorkerPool implements WorkerPoolLike {
  readonly size: number;
  readonly lane: string;
  private readonly store: PlatformStateStore;
  private readonly services: ProcessWorkerPoolOptions["services"];
  private readonly idPrefix: string;
  private readonly entry: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly heartbeatMs: number;
  private readonly drainTimeoutMs: number;
  private readonly debug: boolean;
  private readonly onHeartbeat?: (workerId: string) => void;
  private readonly onWorkerExit?: (workerId: string) => void;
  private workers: WorkerProcess[] = [];
  private waiters: Waiter[] = [];
  private stopping = false;
  private sequence = 0;
  private cursor = 0;
  private consecutiveCrashes = 0;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(options: ProcessWorkerPoolOptions) {
    this.size = Math.max(1, Math.min(64, Math.trunc(options.size)));
    this.lane = options.lane ?? "process";
    this.store = options.store;
    this.services = options.services;
    this.idPrefix = options.idPrefix ?? `${hostname()}:${process.pid}`;
    this.entry = options.entry ?? resolveWorkerEntry();
    this.env = options.env ?? {};
    this.heartbeatMs = Math.max(250, Math.trunc(options.heartbeatMs ?? 5000));
    this.drainTimeoutMs = Math.max(1000, Math.trunc(options.drainTimeoutMs ?? 10_000));
    this.debug = options.debug ?? process.env.PLATFORM_WORKER_DEBUG === "1";
    this.onHeartbeat = options.onHeartbeat;
    this.onWorkerExit = options.onWorkerExit;
    for (let slot = 0; slot < this.size; slot += 1) {
      this.spawn(slot);
    }
    this.heartbeatTimer = setInterval(
      () => this.checkHeartbeats(),
      Math.max(500, Math.floor(this.heartbeatMs / 2))
    );
    this.heartbeatTimer.unref?.();
  }

  private get ttlMs() {
    return Math.max(15_000, this.heartbeatMs * 4);
  }

  async acquire(taskKey: string): Promise<WorkerLease> {
    if (this.stopping) {
      throw new WorkerLostError("Worker 进程池已关闭，步骤未能派发。");
    }
    const idle = this.pickIdle();
    if (idle) {
      return this.assign(idle, taskKey);
    }
    return new Promise<WorkerLease>((resolve, reject) => {
      this.waiters.push({ taskKey, resolve, reject });
    });
  }

  listWorkers(): WorkerSnapshot[] {
    return this.workers.map((worker) => ({
      id: worker.id,
      pid: worker.pid,
      slot: worker.slot,
      status: this.statusOf(worker),
      killed: !worker.alive,
      activeTasks: worker.current ? [worker.current.taskKey] : []
    }));
  }

  killWorker(workerId: string) {
    const worker = this.workers.find((item) => item.id === workerId);
    if (!worker || !worker.alive) {
      return { workerId, killed: false, aborted: 0 };
    }
    const aborted = this.terminate(
      worker,
      new WorkerLostError(`Worker ${workerId} 被终止，任务将重新调度。`),
      "manual_kill"
    );
    try {
      worker.child.kill("SIGKILL");
    } catch {
      // 进程可能刚好自行退出，交给 exit 事件统一收尾。
    }
    return { workerId, killed: true, aborted };
  }

  async drain(reason = "Worker 进程池关闭。") {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    const rejection = new WorkerLostError(reason);
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(rejection);
    }
    // 先等当前步骤自然结束，避免关服务时把正常在飞的运行切成失败。
    const deadline = Date.now() + this.drainTimeoutMs;
    while (Date.now() < deadline && this.workers.some((worker) => worker.alive && worker.current)) {
      await sleep(25);
    }
    await Promise.all(this.workers.filter((worker) => worker.alive).map((worker) => this.stop(worker, reason)));
  }

  private spawn(slot: number) {
    const id = `${this.idPrefix}#w${(this.sequence += 1)}`;
    const child = fork(this.entry, [], {
      execArgv: this.entry.endsWith(".ts") ? ["--import", "tsx"] : [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "advanced",
      env: {
        ...process.env,
        PLATFORM_WORKER_HEARTBEAT_MS: String(this.heartbeatMs),
        ...this.env
      }
    });
    const worker: WorkerProcess = {
      id,
      slot,
      pid: child.pid,
      child,
      alive: true,
      ready: false,
      startedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
      exited: false
    };
    this.workers = [...this.workers.filter((item) => item.slot !== slot), worker];
    this.store.upsertSchedulerWorker({
      id,
      host: hostname(),
      pid: child.pid,
      slot,
      lane: this.lane,
      capabilities: ["leaf", "agent", "llm", "tool", "http", "knowledge", "verify"],
      capacity: 1,
      status: "starting",
      ttlMs: this.ttlMs,
      meta: { mode: "process", entry: path.basename(this.entry) }
    });

    consumeStream(child.stdout);
    consumeStream(child.stderr, this.debug, id);
    child.on("message", (message: WorkerToParentMessage) => this.handleMessage(worker, message));
    child.on("error", (error) => {
      this.log(`worker ${id} 进程错误：${error.message}`);
      this.handleExit(worker, `spawn_error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.handleExit(worker, signal ? `signal:${signal}` : `exit:${code}`);
    });
  }

  private handleMessage(worker: WorkerProcess, message: WorkerToParentMessage) {
    if (!worker.alive) {
      return;
    }
    switch (message.type) {
      case "ready": {
        worker.pid = message.pid;
        worker.ready = true;
        worker.lastHeartbeatAt = Date.now();
        this.consecutiveCrashes = 0;
        this.store.setSchedulerWorkerStatus(worker.id, "idle");
        this.dispatchWaiter();
        return;
      }
      case "heartbeat": {
        worker.lastHeartbeatAt = Date.now();
        this.store.heartbeatSchedulerWorker(worker.id, this.ttlMs);
        this.onHeartbeat?.(worker.id);
        return;
      }
      case "result": {
        const pending = worker.current?.pending.get(message.id);
        if (!pending) {
          return;
        }
        worker.current?.pending.delete(message.id);
        if (message.ok) {
          pending.resolve(message.output);
        } else {
          pending.reject(errorFromPayload(message.error));
        }
        return;
      }
      case "service": {
        void this.handleService(worker, message.request);
        return;
      }
      case "fatal": {
        this.log(`worker ${worker.id} 致命错误：${message.error.message}`);
        return;
      }
    }
  }

  private async handleService(worker: WorkerProcess, request: WorkerServiceCall) {
    let reply: WorkerServiceReply;
    try {
      const result = await this.callService(request);
      reply = { id: request.id, ok: true, result };
    } catch (error) {
      reply = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
    if (!worker.alive || !worker.child.connected) {
      return;
    }
    worker.child.send({ type: "service-reply", reply } satisfies ParentToWorkerMessage);
  }

  private async callService(request: WorkerServiceCall): Promise<unknown> {
    const payload = request.payload ?? {};
    if (request.service === "knowledge.search") {
      const query = typeof payload.query === "string" ? payload.query : "";
      const knowledgeBaseIds = Array.isArray(payload.knowledgeBaseIds)
        ? payload.knowledgeBaseIds.filter((item): item is string => typeof item === "string")
        : [];
      const topK = typeof payload.topK === "number" ? payload.topK : undefined;
      return this.services.searchKnowledge({ query, knowledgeBaseIds, topK });
    }
    if (request.service === "mcp.call") {
      const toolId = typeof payload.toolId === "string" ? payload.toolId : "";
      const tool = this.store.getTool(toolId);
      if (!tool) {
        throw new Error(`工具「${toolId}」不存在。`);
      }
      const args = isRecord(payload.args) ? payload.args : {};
      return this.services.callMcpTool(tool, args);
    }
    const tool = typeof payload.tool === "string" ? payload.tool : "";
    const input = isRecord(payload.input) ? payload.input : {};
    return this.services.trainingTool(tool, input);
  }

  private assign(worker: WorkerProcess, taskKey: string): WorkerLease {
    let rejectAbort: (error: Error) => void = () => {};
    const abort = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    // 步骤正常完成时 abort 不会被消费，避免未处理拒绝告警。
    abort.catch(() => {});
    const assignment: Assignment = {
      taskKey,
      pending: new Map(),
      abort: { promise: abort, reject: rejectAbort }
    };
    worker.current = assignment;
    this.store.setSchedulerWorkerStatus(worker.id, "busy");
    return {
      workerId: worker.id,
      abort,
      invoke: (invocation: WorkerInvocation) =>
        new Promise<unknown>((resolve, reject) => {
          if (!worker.alive || !worker.child.connected) {
            reject(new WorkerLostError(`Worker ${worker.id} 已失联，任务将重新调度。`));
            return;
          }
          assignment.pending.set(invocation.id, { resolve, reject });
          try {
            worker.child.send({ type: "invoke", invocation } satisfies ParentToWorkerMessage);
          } catch (error) {
            assignment.pending.delete(invocation.id);
            reject(new WorkerLostError(`无法向 Worker ${worker.id} 派发任务：${errorMessage(error)}`));
          }
        }),
      release: () => this.release(worker, assignment)
    };
  }

  private release(worker: WorkerProcess, assignment: Assignment) {
    if (worker.current !== assignment) {
      return;
    }
    worker.current = undefined;
    assignment.pending.clear();
    if (worker.alive) {
      this.store.setSchedulerWorkerStatus(worker.id, "idle");
    }
    this.dispatchWaiter();
  }

  private dispatchWaiter() {
    if (this.stopping) {
      return;
    }
    while (this.waiters.length > 0) {
      const worker = this.pickIdle();
      if (!worker) {
        return;
      }
      const waiter = this.waiters.shift()!;
      waiter.resolve(this.assign(worker, waiter.taskKey));
    }
  }

  /** 轮转领取空闲槽位，避免所有任务都压到 slot 0。 */
  private pickIdle() {
    const idle = this.workers
      .filter((worker) => worker.alive && worker.ready && !worker.current)
      .sort((left, right) => left.slot - right.slot);
    if (idle.length === 0) {
      return undefined;
    }
    const worker = idle[this.cursor % idle.length];
    this.cursor = (this.cursor + 1) % Math.max(1, this.size);
    return worker;
  }

  private checkHeartbeats() {
    const now = Date.now();
    for (const worker of [...this.workers]) {
      if (!worker.alive) {
        continue;
      }
      // 启动后迟迟不 ready 说明入口/依赖有问题，按失联处理并由补位逻辑限次重试。
      const stuckStarting = !worker.ready && now - worker.startedAt > 30_000;
      const missedHeartbeat = now - worker.lastHeartbeatAt > this.ttlMs;
      if (!stuckStarting && !missedHeartbeat) {
        continue;
      }
      this.log(`worker ${worker.id} ${stuckStarting ? "启动超时" : "心跳超时"}，按失联处理。`);
      this.terminate(
        worker,
        new WorkerLostError(
          `Worker ${worker.id} ${stuckStarting ? "启动超时" : "心跳超时"}，任务将重新调度。`
        ),
        stuckStarting ? "start_timeout" : "heartbeat_timeout"
      );
      try {
        worker.child.kill("SIGKILL");
      } catch {
        // 交给 exit 事件。
      }
    }
  }

  /** 立即判定失联：拒绝在飞调用与排队等待，但保留进程对象等待 exit 事件补位。 */
  private terminate(worker: WorkerProcess, error: WorkerLostError, reason: string) {
    if (!worker.alive) {
      return 0;
    }
    worker.alive = false;
    const aborted = worker.current?.pending.size ?? 0;
    const assignment = worker.current;
    if (assignment) {
      for (const pending of assignment.pending.values()) {
        pending.reject(error);
      }
      assignment.pending.clear();
      assignment.abort.reject(error);
    }
    this.store.setSchedulerWorkerStatus(worker.id, "dead", reason);
    return aborted;
  }

  private handleExit(worker: WorkerProcess, reason: string) {
    if (worker.exited) {
      return;
    }
    worker.exited = true;
    const failedToStart = !worker.ready;
    this.terminate(worker, new WorkerLostError(`Worker ${worker.id} 已退出，任务将重新调度。`), reason);
    this.workers = this.workers.filter((item) => item !== worker);
    this.store.setSchedulerWorkerStatus(worker.id, "dead", reason);
    this.onWorkerExit?.(worker.id);
    if (this.stopping) {
      return;
    }
    if (failedToStart) {
      this.consecutiveCrashes += 1;
      if (this.consecutiveCrashes > 3) {
        // 入口持续启动失败时不再无限 fork，排队的步骤改为失败由执行器决定是否重派。
        this.failWaiters(new WorkerLostError("Worker 进程连续启动失败，进程池暂不可用。"));
        return;
      }
    }
    setTimeout(() => {
      if (this.stopping || this.consecutiveCrashes > 3) {
        return;
      }
      if (this.workers.some((item) => item.alive && item.slot === worker.slot)) {
        return;
      }
      this.spawn(worker.slot);
    }, 100);
  }

  private async stop(worker: WorkerProcess, reason: string) {
    if (!worker.alive) {
      return;
    }
    const exit = new Promise<void>((resolve) => {
      worker.child.once("exit", () => resolve());
    });
    try {
      worker.child.send({ type: "shutdown", reason } satisfies ParentToWorkerMessage);
    } catch {
      worker.child.kill("SIGTERM");
    }
    const timedOut = await Promise.race([
      exit.then(() => false),
      sleep(2000).then(() => true)
    ]);
    if (timedOut && worker.alive) {
      worker.child.kill("SIGKILL");
      await Promise.race([exit, sleep(1000)]);
    }
  }

  private failWaiters(error: Error) {
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  private statusOf(worker: WorkerProcess): SchedulerWorkerStatus {
    if (!worker.alive) {
      return "dead";
    }
    if (!worker.ready) {
      return "starting";
    }
    return worker.current ? "busy" : "idle";
  }

  private log(message: string) {
    if (this.debug) {
      console.warn(`[worker-pool] ${message}`);
    }
  }
}

function resolveWorkerEntry() {
  const override = process.env.PLATFORM_WORKER_ENTRY?.trim();
  if (override) {
    return override;
  }
  const directory = __dirname;
  const compiled = path.join(directory, "stepWorker.js");
  return existsSync(compiled) ? compiled : path.join(directory, "stepWorker.ts");
}

function consumeStream(
  stream: NodeJS.ReadableStream | null | undefined,
  forward = false,
  prefix = "worker"
) {
  if (!stream) {
    return;
  }
  stream.on("data", (chunk: Buffer | string) => {
    if (forward) {
      process.stderr.write(`[${prefix}] ${String(chunk)}`);
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
