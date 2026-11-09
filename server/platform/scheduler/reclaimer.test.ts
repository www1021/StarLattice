import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkflowDefinition } from "../types.js";
import { BUILTIN_AGENTS } from "../registry/agents.js";
import { WorkflowExecutor } from "../runtime/executor.js";
import { PlatformStateStore } from "../runtime/stateStore.js";
import { SchedulerReclaimer } from "./reclaimer.js";

function createStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-reclaimer-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  return {
    store,
    dispose() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function probeWorkflow(): WorkflowDefinition {
  return {
    id: "reclaimer-probe",
    name: "回收器探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "first", kind: "agent", agent: "topic-innovation-agent" },
      { id: "second", kind: "agent", agent: "topic-innovation-agent" }
    ],
    edges: [{ from: "first", to: "second" }]
  };
}

async function waitForRun(store: PlatformStateStore, runId: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.getRun(runId);
    if (run && !["queued", "running", "verifying", "revising"].includes(run.status)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待运行 ${runId} 结束超时`);
}

test("only the leadership holder performs periodic reclamation", async () => {
  const { store, dispose } = createStore();
  const executor = new WorkflowExecutor(store);
  const first = new SchedulerReclaimer({
    store,
    executor,
    intervalMs: 0,
    holder: "instance-a",
    autoResume: false
  });
  const second = new SchedulerReclaimer({
    store,
    executor,
    intervalMs: 0,
    holder: "instance-b",
    autoResume: false
  });
  try {
    const held = await first.tick();
    assert.equal(held.leader, true);
    assert.equal(store.getSchedulerLeadership()?.holder, "instance-a");

    const standby = await second.tick();
    assert.equal(standby.leader, false);
    assert.equal(standby.orphanRuns.requeued.length, 0);

    first.stop();
    assert.equal(store.getSchedulerLeadership(), undefined);

    const promoted = await second.tick();
    assert.equal(promoted.leader, true);
    assert.equal(store.getSchedulerLeadership()?.holder, "instance-b");
  } finally {
    first.stop();
    second.stop();
    dispose();
  }
});

test("auto-resumes an interrupted run from its checkpoint and marks the source run", async () => {
  const { store, dispose } = createStore();
  store.seedAgents(BUILTIN_AGENTS);
  const workflow = probeWorkflow();
  try {
    store.saveWorkflow(workflow);
    let failSecond = true;
    const failingExecutor = new WorkflowExecutor(
      store,
      {
        agent: async (node) => {
          if (node.id === "second" && failSecond) {
            failSecond = false;
            throw new Error("模拟进程退出前的节点失败");
          }
          return { mode: "stub", output: `${node.id}:ok` };
        }
      },
      { maxAttempts: 1 }
    );
    const original = await failingExecutor.run(workflow, {});
    assert.equal(original.run.status, "failed");
    assert.ok(store.hasRunCheckpoint(original.run.id));

    // 模拟父进程重启时的统一标记：运行已是 failed，但带检查点、仍在恢复窗口内。
    store.updateRunSchedulerState(original.run.id, "interrupted");

    const healthyExecutor = new WorkflowExecutor(store);
    const reclaimer = new SchedulerReclaimer({
      store,
      executor: healthyExecutor,
      intervalMs: 0,
      holder: "reclaimer-test",
      autoResume: true,
      graceMs: 0,
      recoverWindowMs: 3_600_000
    });
    try {
      const report = await reclaimer.tick({ force: true });
      assert.equal(report.resumed.length, 1);
      assert.equal(report.resumed[0]?.previousRunId, original.run.id);
      assert.equal(store.getRun(original.run.id)?.schedulerState, "recover_queued");

      const resumed = await waitForRun(store, report.resumed[0]!.runId);
      assert.equal(resumed.status, "succeeded");
      assert.equal(resumed.resumeCount, 1);
      assert.deepEqual(
        store.listSteps(resumed.id).map((step) => step.nodeId),
        ["second"]
      );
    } finally {
      reclaimer.stop();
    }
  } finally {
    dispose();
  }
});

test("skips interrupted runs without a checkpoint instead of guessing", async () => {
  const { store, dispose } = createStore();
  const workflow = probeWorkflow();
  try {
    store.saveWorkflow(workflow);
    const orphan = store.createRun({
      workflowId: workflow.id,
      workflowVersion: 1,
      workflowInput: {},
      mode: "stub",
      status: "failed",
      definition: workflow
    });
    store.updateRunSchedulerState(orphan.id, "interrupted");

    const reclaimer = new SchedulerReclaimer({
      store,
      executor: new WorkflowExecutor(store),
      intervalMs: 0,
      holder: "reclaimer-skip",
      autoResume: true,
      graceMs: 0,
      recoverWindowMs: 3_600_000
    });
    try {
      const report = await reclaimer.tick({ force: true });
      assert.equal(report.resumed.length, 0);
      assert.equal(report.skipped[0]?.runId, orphan.id);
      assert.match(report.skipped[0]?.reason ?? "", /检查点/);
    } finally {
      reclaimer.stop();
    }
  } finally {
    dispose();
  }
});
