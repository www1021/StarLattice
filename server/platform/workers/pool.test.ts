import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBuiltinWorkflows } from "../workflow/dsl.js";
import { BUILTIN_AGENTS } from "../registry/agents.js";
import type { WorkflowDefinition } from "../types.js";
import { WorkflowExecutor } from "../runtime/executor.js";
import { PlatformStateStore } from "../runtime/stateStore.js";
import { ProcessWorkerPool } from "./pool.js";

function createStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-worker-pool-"));
  const dbPath = path.join(directory, "platform.db");
  const store = new PlatformStateStore(dbPath);
  store.seedAgents(BUILTIN_AGENTS);
  return {
    store,
    dbPath,
    dispose() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function createPool(
  store: PlatformStateStore,
  dbPath: string,
  options: Partial<ConstructorParameters<typeof ProcessWorkerPool>[0]> = {}
) {
  return new ProcessWorkerPool({
    size: 1,
    store,
    heartbeatMs: 100,
    env: { PLATFORM_DB_PATH: dbPath },
    services: {
      searchKnowledge: async () => [],
      callMcpTool: async () => {
        throw new Error("本测试未接入 MCP。");
      },
      trainingTool: (tool) =>
        tool.startsWith("training.")
          ? { mode: "live", kind: "tool", summary: "父进程服务", output: "ok" }
          : undefined
    },
    ...options
  });
}

function toolWorkflow(tool = "training.classroom"): WorkflowDefinition {
  return {
    id: "worker-process-probe",
    name: "Worker 进程探针",
    version: 1,
    inputs: [{ name: "topic", type: "string", required: true }],
    nodes: [
      { id: "render", kind: "template", template: "${input.topic}" },
      { id: "work", kind: "tool", tool, args: { topic: "${render.value}" } }
    ],
    edges: [{ from: "render", to: "work" }]
  };
}

test("executes leaf steps in real child processes and bridges services to the parent", async () => {
  const { store, dbPath, dispose } = createStore();
  const pool = createPool(store, dbPath, {
    services: {
      searchKnowledge: async () => [],
      callMcpTool: async () => {
        throw new Error("本测试未接入 MCP。");
      },
      trainingTool: (tool, input) => ({
        mode: "live",
        kind: "tool",
        summary: "父进程服务",
        output: `${tool}:${String(input.topic)}`
      })
    }
  });
  try {
    const executor = new WorkflowExecutor(store, {}, { workerPool: pool });
    const { run, steps } = await executor.run(toolWorkflow(), { topic: "分数的意义" });

    assert.equal(run.status, "succeeded");
    const output = steps.find((step) => step.nodeId === "work")?.output as
      | Record<string, unknown>
      | undefined;
    // 只有父进程侧的训练工具会返回这个标记；进程内 stub 工具不会。
    assert.equal(output?.mode, "live");
    assert.equal(output?.output, "training.classroom:分数的意义");

    const workers = executor.listWorkers();
    assert.equal(workers.length, 1);
    assert.ok(workers[0]!.pid && workers[0]!.pid > 0);
    assert.equal(workers[0]!.status, "idle");

    const rows = store.listSchedulerWorkers({ lane: "process" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "idle");
    assert.ok(rows[0]!.pid);
  } finally {
    await pool.drain();
    dispose();
  }
});

test("runs a loop workflow end to end with workers", async () => {
  const { store, dbPath, dispose } = createStore();
  const documentName = "义务教育数学课程标准（2022年版）";
  const pool = createPool(store, dbPath, {
    size: 2,
    services: {
      searchKnowledge: async () => [
        {
          id: `${documentName}-1`,
          title: documentName,
          documentName,
          knowledgeBaseName: "课标库",
          snippet: "分数的意义在于把单位“1”平均分。",
          source: "local",
          score: 0.9
        }
      ],
      callMcpTool: async () => {
        throw new Error("本测试未接入 MCP。");
      },
      trainingTool: () => undefined
    }
  });
  try {
    const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
    assert.ok(workflow);
    const executor = new WorkflowExecutor(store, {}, { workerPool: pool });
    const { run, steps } = await executor.run(workflow, {
      topic: "分数的意义",
      subject: "数学",
      grade: "五年级",
      knowledgeBaseIds: ["kb-1"]
    });
    assert.equal(run.status, "succeeded");
    assert.equal(steps.length, 12);
    assert.ok(steps.every((step) => step.status === "succeeded"));
    const scores = store.listVerifyResults(run.id).map((result) => result.score);
    assert.deepEqual(scores, [0.6663, 0.6633, 0.6633]);
  } finally {
    await pool.drain();
    dispose();
  }
});

test("killing a worker fails the step with WorkerLostError and the retry runs on a replacement", async () => {
  const { store, dbPath, dispose } = createStore();
  let calls = 0;
  let firstStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const pool = createPool(store, dbPath, {
    services: {
      searchKnowledge: async () => [],
      callMcpTool: async () => {
        throw new Error("本测试未接入 MCP。");
      },
      trainingTool: (tool) => {
        calls += 1;
        if (calls === 1) {
          firstStarted();
          // 第一次调用故意挂起，让步骤停留在子进程里，便于中途 kill。
          return new Promise(() => {});
        }
        return { mode: "live", kind: "tool", summary: "重派成功", output: `${tool}:retried` };
      }
    }
  });
  try {
    const executor = new WorkflowExecutor(store, {}, {
      workerPool: pool,
      maxAttempts: 2,
      retryBaseDelayMs: 1
    });
    const pending = executor.run(toolWorkflow(), { topic: "重派" });
    await started;
    const before = executor.listWorkers();
    assert.equal(before.length, 1);
    const killed = executor.killWorker(before[0]!.id);
    assert.equal(killed.killed, true);
    assert.equal(killed.aborted, 1);

    const { run, steps } = await pending;
    assert.equal(run.status, "succeeded");
    assert.equal(calls, 2);
    const work = steps.find((step) => step.nodeId === "work");
    assert.equal(work?.status, "succeeded");
    assert.equal(work?.attempts, 2);

    const after = executor.listWorkers();
    assert.equal(after.length, 1);
    assert.notEqual(after[0]!.id, before[0]!.id);
    assert.equal(after[0]!.status, "idle");
  } finally {
    await pool.drain();
    dispose();
  }
});

test("a step timeout terminates the stuck worker before the retry", async () => {
  const { store, dbPath, dispose } = createStore();
  let calls = 0;
  const pool = createPool(store, dbPath, {
    services: {
      searchKnowledge: async () => [],
      callMcpTool: async () => {
        throw new Error("本测试未接入 MCP。");
      },
      trainingTool: (tool) => {
        calls += 1;
        if (calls === 1) {
          return new Promise(() => {});
        }
        return { mode: "live", kind: "tool", summary: "超时重派", output: `${tool}:after-timeout` };
      }
    }
  });
  try {
    const executor = new WorkflowExecutor(store, {}, {
      workerPool: pool,
      maxAttempts: 2,
      retryBaseDelayMs: 1,
      timeoutMs: 150
    });
    const before = executor.listWorkers()[0]!.id;
    const { run, steps } = await executor.run(toolWorkflow(), { topic: "超时" });
    assert.equal(run.status, "succeeded");
    assert.equal(calls, 2);
    const work = steps.find((step) => step.nodeId === "work");
    assert.equal(work?.attempts, 2);
    assert.match(String((work?.output as Record<string, unknown> | undefined)?.output), /after-timeout/);
    const after = executor.listWorkers()[0]!;
    assert.notEqual(after.id, before);
    assert.equal(after.status, "idle");
  } finally {
    await pool.drain();
    dispose();
  }
});

test("read-only worker startup does not touch active runs in the shared ledger", async () => {
  const { store, dbPath, dispose } = createStore();
  const run = store.createRun({
    workflowId: "active-probe",
    workflowVersion: 1,
    workflowInput: {},
    mode: "stub"
  });
  const pool = createPool(store, dbPath);
  try {
    const deadline = Date.now() + 3000;
    while (pool.listWorkers()[0]?.status !== "idle" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Worker 子进程若执行启动清理，会把库里所有非终态运行标失败。
    assert.equal(store.getRun(run.id)?.status, run.status);
    assert.notEqual(run.status, "failed");
  } finally {
    await pool.drain();
    dispose();
  }
});

test("worker heartbeats keep the scheduler worker row fresh and drain stops the pool", async () => {
  const { store, dbPath, dispose } = createStore();
  let heartbeats = 0;
  const pool = createPool(store, dbPath, { onHeartbeat: () => (heartbeats += 1) });
  try {
    const deadline = Date.now() + 3000;
    while (heartbeats === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(heartbeats > 0, "子进程应定期上报心跳");
    const row = store.listSchedulerWorkers({ lane: "process" })[0];
    assert.ok(row);
    assert.ok(Date.parse(row.heartbeatAt) > 0);
    const workerId = row.id;

    await pool.drain("测试结束");
    assert.equal(pool.listWorkers().length, 0);
    const dead = store.getSchedulerWorker(workerId);
    assert.equal(dead?.status, "dead");
    await assert.rejects(() => pool.acquire("after-drain"), /进程池已关闭/);
  } finally {
    await pool.drain();
    dispose();
  }
});
