import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PlatformStateStore } from "../runtime/stateStore.js";
import { SchedulerService, SchedulerTaskCancelledError } from "./service.js";

function createStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-scheduler-service-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  return {
    store,
    dispose() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function createRun(store: PlatformStateStore, priorityClass?: number) {
  return store.createRun({
    workflowId: "scheduler-probe",
    workflowVersion: 1,
    workflowInput: {},
    mode: "stub",
    priorityClass
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("serves the highest effective priority across runs with one shared capacity slot", async () => {
  const { store, dispose } = createStore();
  try {
    const service = new SchedulerService(store, { capacity: 1, workerId: "test-inline" });
    const low = createRun(store, 0);
    const high = createRun(store, 5);
    for (const run of [low, high]) {
      store.insertRunNodes(run.id, [{ nodeId: "work", path: "work" }]);
    }
    const seen: string[] = [];
    const submit = (runId: string, tag: string, priorityClass: number) =>
      service.submit({
        runId,
        nodeId: "work",
        path: "work",
        kind: "agent",
        criticalPathDepth: 0,
        maxDepth: 0,
        priorityClass,
        execute: async () => {
          seen.push(tag);
        }
      });
    await Promise.all([
      submit(low.id, "low", 0),
      submit(high.id, "high", 5)
    ]);

    // 同一批提交必须一起比较后再出队，容量为 1 时高优运行会整体先跑。
    assert.deepEqual(seen, ["high", "low"]);
    const highQueue = store.listSchedulerQueue(high.id)[0]!;
    const lowQueue = store.listSchedulerQueue(low.id)[0]!;
    assert.equal(highQueue.status, "succeeded");
    assert.equal(highQueue.priorityClass, 5);
    assert.equal(lowQueue.status, "succeeded");
    assert.equal(lowQueue.priorityClass, 0);
    assert.ok((lowQueue.waitMs ?? 0) >= 0);
    assert.equal(store.getRunNode(high.id, "work")?.status, "succeeded");
    const attempt = store.listSchedulerAttempts({ runId: high.id })[0];
    assert.equal(attempt?.status, "succeeded");
    assert.equal(attempt?.workerId, "test-inline");

    const snapshot = service.snapshot();
    assert.equal(snapshot.pending, 0);
    assert.equal(snapshot.running, 0);
    assert.equal(snapshot.capacity, 1);
  } finally {
    dispose();
  }
});

test("never exceeds shared capacity when runs arrive concurrently", async () => {
  const { store, dispose } = createStore();
  try {
    const service = new SchedulerService(store, { capacity: 2, workerId: "test-capacity" });
    const runs = [createRun(store), createRun(store), createRun(store), createRun(store)];
    let active = 0;
    let peak = 0;
    const submit = (run: ReturnType<typeof createRun>, index: number) =>
      service.submit({
        runId: run.id,
        nodeId: `work-${index}`,
        path: `work-${index}`,
        kind: "http",
        criticalPathDepth: 0,
        maxDepth: 0,
        execute: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
        }
      });
    await Promise.all(runs.map((run, index) => submit(run, index)));
    assert.equal(peak, 2);
    assert.equal(service.snapshot().pending, 0);
  } finally {
    dispose();
  }
});

test("aging lets an older queued task overtake a later one in the same class", async () => {
  const { store, dispose } = createStore();
  try {
    let now = 1_000_000;
    const service = new SchedulerService(store, {
      capacity: 1,
      workerId: "test-aging",
      now: () => now
    });
    const run = createRun(store);
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const seen: string[] = [];
    const submit = (nodeId: string, criticalPathDepth: number, execute: () => Promise<void>) =>
      service.submit({
        runId: run.id,
        nodeId,
        path: nodeId,
        kind: "template",
        criticalPathDepth,
        maxDepth: 1,
        execute
      });

    const blockerDone = submit("blocker", 0, () => blocker.then(() => void seen.push("blocker")));
    await tick();
    const older = submit("older", 0, async () => {
      seen.push("older");
    });
    now += 11_000;
    const newer = submit("newer", 1, async () => {
      seen.push("newer");
    });
    releaseBlocker();
    await Promise.all([blockerDone, older, newer]);

    // newer 的关键路径分更高，但 older 等待 11 秒获得封顶老化，仍先出队。
    assert.deepEqual(seen, ["blocker", "older", "newer"]);
  } finally {
    dispose();
  }
});

test("cancelling a run rejects queued tasks and marks run nodes cancelled", async () => {
  const { store, dispose } = createStore();
  try {
    const service = new SchedulerService(store, { capacity: 1, workerId: "test-cancel" });
    const run = createRun(store);
    store.insertRunNodes(run.id, [{ nodeId: "queued", path: "queued" }]);
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const blockerDone = service.submit({
      runId: run.id,
      nodeId: "blocker",
      path: "blocker",
      kind: "template",
      criticalPathDepth: 0,
      maxDepth: 0,
      execute: () => blocker
    });
    await tick();
    const queued = service.submit({
      runId: run.id,
      nodeId: "queued",
      path: "queued",
      kind: "template",
      criticalPathDepth: 0,
      maxDepth: 0,
      execute: async () => {
        assert.fail("被撤销的任务不应执行");
      }
    });
    const cancelled = assert.rejects(queued, SchedulerTaskCancelledError);
    assert.equal(service.cancelRun(run.id, "测试撤销"), 1);
    await cancelled;
    releaseBlocker();
    await blockerDone;

    assert.equal(store.listSchedulerQueue(run.id).find((item) => item.nodeId === "queued")?.status, "cancelled");
    assert.equal(store.getRunNode(run.id, "queued")?.status, "cancelled");
    assert.equal(service.snapshot().pending, 0);

    // 同一运行后续重试不应因为撤销标记被永久拒绝。
    service.completeRun(run.id);
    await service.submit({
      runId: run.id,
      nodeId: "retry",
      path: "retry",
      kind: "template",
      criticalPathDepth: 0,
      maxDepth: 0,
      execute: async () => undefined
    });
  } finally {
    dispose();
  }
});

test("reclaims expired claims and requeues until attempts are exhausted", () => {
  const { store, dispose } = createStore();
  try {
    const run = createRun(store);
    const queueId = store.enqueueSchedulerTask({
      runId: run.id,
      nodeId: "work",
      path: "work",
      priority: 1,
      maxAttempts: 2
    });
    const claimed = store.claimSchedulerTask(queueId, "dead-worker", 1000);
    assert.equal(claimed?.status, "claimed");
    assert.equal(claimed?.attempts, 1);

    const reclaimed = store.reclaimExpiredSchedulerTasks(Date.now() + 5000);
    assert.deepEqual(reclaimed.requeued, [queueId]);
    assert.equal(store.getSchedulerQueueEntry(queueId)?.status, "queued");

    store.claimSchedulerTask(queueId, "dead-worker", 1000);
    const expired = store.reclaimExpiredSchedulerTasks(Date.now() + 10_000);
    assert.deepEqual(expired.expired, [queueId]);
    assert.equal(store.getSchedulerQueueEntry(queueId)?.status, "expired");
    assert.equal(store.getSchedulerQueueEntry(queueId)?.reason, "claim_timeout");
  } finally {
    dispose();
  }
});
