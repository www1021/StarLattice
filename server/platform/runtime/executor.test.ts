import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkflowDefinition } from "../types.js";
import { loadBuiltinWorkflows } from "../workflow/dsl.js";
import { WorkflowExecutor } from "./executor.js";
import { PlatformStateStore } from "./stateStore.js";

function createStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-platform-run-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  return {
    store,
    dispose() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("runs classroom-v1 end to end and records the 0.62 → 0.86 loop", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
  assert.ok(workflow);
  try {
    const { run, steps } = await new WorkflowExecutor(store).run(workflow, {
      topic: "分数的意义",
      subject: "数学",
      grade: "五年级"
    });

    assert.equal(run.status, "succeeded");
    assert.equal(run.mode, "stub");
    // 10 个节点，循环体 2 个节点跑 2 轮 → 12 条执行记录
    assert.equal(steps.length, 12);
    assert.ok(steps.every((step) => step.status === "succeeded"));

    const scores = store.listVerifyResults(run.id).map((result) => result.score);
    assert.deepEqual(scores, [0.62, 0.74, 0.86]);

    const iterations = store.listLoopIterations(run.id);
    assert.equal(iterations.length, 2);
    assert.equal(iterations[0]?.scoreBefore, 0.62);
    assert.equal(iterations[1]?.scoreAfter, 0.86);
    assert.equal(store.getRun(run.id)?.output?.score, 0.86);
  } finally {
    dispose();
  }
});

test("follows the branch selected by a condition", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "condition-probe",
    name: "条件分支探针",
    version: 1,
    inputs: [{ name: "pass", type: "boolean", required: true }],
    nodes: [
      {
        id: "gate",
        kind: "condition",
        when: "${input.pass} == true",
        then: [{ id: "advance", kind: "agent", agent: "reviewer-agent" }],
        else: [{ id: "rework", kind: "agent", agent: "coach-agent" }]
      }
    ],
    edges: []
  };
  try {
    const passed = await new WorkflowExecutor(store).run(workflow, { pass: true });
    assert.deepEqual(
      passed.steps.map((step) => step.nodeId),
      ["advance"]
    );

    const failed = await new WorkflowExecutor(store).run(workflow, { pass: false });
    assert.deepEqual(
      failed.steps.map((step) => step.nodeId),
      ["rework"]
    );
  } finally {
    dispose();
  }
});

test("start returns a running record while execution continues in the background", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
  assert.ok(workflow);
  try {
    const started = new WorkflowExecutor(store).start(workflow, {
      topic: "分数的意义",
      subject: "数学",
      grade: "五年级"
    });
    assert.equal(started.workflowId, "classroom-v1");
    assert.equal(started.stepCount, 0);

    let current = store.getRun(started.id)!;
    for (let attempt = 0; attempt < 100 && current.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = store.getRun(started.id)!;
    }
    assert.equal(current.status, "succeeded");
    assert.equal(store.listSteps(started.id).length, 12);
  } finally {
    dispose();
  }
});

test("retryStep appends a step without changing the original run status", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "retry-probe",
    name: "单步重跑探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "boom", kind: "agent", agent: "broken-agent" }],
    edges: []
  };
  try {
    store.saveWorkflow(workflow);
    const failing = new WorkflowExecutor(store, {
      agent: () => {
        throw new Error("模型不可用");
      }
    });
    const { run, steps } = await failing.run(workflow);
    assert.equal(run.status, "failed");
    const original = steps[0];
    assert.ok(original);

    const recovered = new WorkflowExecutor(store, {
      agent: () => ({ mode: "live", output: "recovered" })
    });
    const retried = await recovered.retryStep(run.id, original.id);
    assert.equal(retried.status, "succeeded");
    assert.equal(retried.sequence, 2);
    assert.equal(retried.path, original.path);
    assert.deepEqual(retried.input, original.input);
    assert.equal(store.getRun(run.id)?.status, "failed");
    assert.equal(store.listSteps(run.id).length, 2);
  } finally {
    dispose();
  }
});

test("records a failed step and marks the run failed when a node throws", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "failure-probe",
    name: "失败探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "boom", kind: "agent", agent: "broken-agent" }],
    edges: []
  };
  try {
    const executor = new WorkflowExecutor(store, {
      agent: () => {
        throw new Error("模型不可用");
      }
    });
    const { run, steps } = await executor.run(workflow);
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /模型不可用/);
    assert.equal(steps[0]?.status, "failed");
    assert.match(steps[0]?.error ?? "", /模型不可用/);
  } finally {
    dispose();
  }
});
