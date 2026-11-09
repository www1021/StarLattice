import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRecord, WorkflowDefinition } from "../types.js";
import { WorkflowExecutor, type ExecutionContext } from "./executor.js";
import {
  deserializeExecutionContext,
  serializeExecutionContext
} from "./invoker.js";
import { PlatformStateStore } from "./stateStore.js";

function createStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-invoker-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  return {
    store,
    dispose() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function agentRecord(id: string, name: string): AgentRecord {
  return {
    id,
    name,
    version: 1,
    role: "writer",
    prompt: "写一段话",
    tools: [],
    model: "qwen-plus",
    capabilities: [{ tag: "writing", weight: 1 }],
    memory: {},
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

test("routes leaf steps through the configured invoker", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "invoker-probe",
    name: "Invoker 探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "write", kind: "agent", agent: "planner", prompt: "写一段话" }],
    edges: []
  };
  const calls: Array<{ nodeId: string; runId: string; tokens: number }> = [];

  try {
    const { run, steps } = await new WorkflowExecutor(store, {}, {
      invoker: {
        invoke: async (step, _input, state) => {
          calls.push({ nodeId: step.nodeId, runId: state.runId, tokens: state.tokensUsed });
          return {
            mode: "stub",
            kind: "agent",
            summary: "由自定义 invoker 执行",
            output: "来自 invoker"
          };
        }
      }
    }).run(workflow, {});

    assert.equal(run.status, "succeeded");
    assert.deepEqual(calls.map((call) => call.nodeId), ["write"]);
    assert.equal(calls[0]!.runId, run.id);
    const step = steps.find((item) => item.nodeId === "write");
    assert.equal((step?.output as Record<string, unknown> | undefined)?.output, "来自 invoker");
  } finally {
    dispose();
  }
});

test("serializes execution context across a JSON boundary without losing maps", () => {
  const context: ExecutionContext = {
    runId: "run_1",
    workflowId: "workflow_1",
    iteration: 2,
    tokensUsed: 123,
    tokenBudget: 5000,
    knowledgeBaseIds: ["kb-1"],
    agentSnapshots: new Map([["planner", agentRecord("planner", "规划者")]]),
    release: { releaseId: "rel_1", experimentId: "exp_1", arm: "treatment" },
    loop: {
      artifact: { draft: "初稿" },
      issues: ["缺少证据"],
      score: 0.7,
      iteration: 2,
      retrievalQuery: "分数的意义"
    },
    scope: {
      input: { topic: "分数的意义" },
      outputs: new Map<string, unknown>([
        ["draft", { text: "初稿" }],
        ["verify", { score: 0.9 }]
      ]),
      evidence: ["[1] 义务教育数学课程标准"],
      verifyRounds: 1,
      lastVerifyScore: 0.9,
      lastVerifyIssues: ["补充证据"],
      lastVerifyConfidence: 0.8,
      lastVerifyPassed: true,
      lastArtifact: { text: "初稿" },
      lastArtifactNodeId: "draft"
    }
  };

  const serialized = serializeExecutionContext(context);
  // Worker IPC 与 checkpoint 都走 JSON，这里显式验证 Map 不会退化成空对象。
  const overWire = JSON.parse(JSON.stringify(serialized));
  const restored = deserializeExecutionContext(overWire);

  assert.equal(restored.runId, context.runId);
  assert.deepEqual(restored.scope.input, context.scope.input);
  assert.deepEqual(
    [...restored.scope.outputs.entries()],
    [...context.scope.outputs.entries()]
  );
  assert.deepEqual(restored.scope.evidence, context.scope.evidence);
  assert.equal(restored.scope.lastVerifyScore, 0.9);
  assert.equal(restored.scope.lastVerifyPassed, true);
  assert.equal(restored.agentSnapshots?.get("planner")?.name, "规划者");
  assert.deepEqual(restored.release, context.release);
  assert.deepEqual(restored.loop, context.loop);
});
