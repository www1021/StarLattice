import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBuiltinWorkflows } from "../workflow/dsl.js";
import { BUILTIN_AGENTS } from "../registry/agents.js";
import { BUILTIN_TOOLS } from "../registry/tools.js";
import { PLATFORM_TABLES, PlatformStateStore } from "./stateStore.js";

test("creates the eight platform tables and round-trips a run", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-platform-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  try {
    const health = store.health();
    assert.equal(health.tableCount, PLATFORM_TABLES.length);
    assert.deepEqual([...health.tables].sort(), [...PLATFORM_TABLES].sort());

    const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
    assert.ok(workflow);
    store.saveWorkflow(workflow);
    assert.equal(store.getWorkflow("classroom-v1")?.definition.nodes.length, workflow.nodes.length);
    assert.equal(store.listWorkflows()[0]?.id, "classroom-v1");

    const run = store.createRun({
      workflowId: "classroom-v1",
      workflowVersion: 1,
      workflowInput: { topic: "分数的意义" },
      mode: "stub"
    });
    assert.equal(run.status, "running");

    const stepId = store.beginStep({
      runId: run.id,
      sequence: 1,
      path: "retrieve",
      nodeId: "retrieve",
      nodeKind: "tool",
      input: { query: "分数的意义" }
    });
    store.completeStep(stepId, "succeeded", { output: "ok" });
    store.recordVerifyResult({
      runId: run.id,
      stepId,
      verifier: "observer-verifier",
      score: 0.62,
      confidence: 0.6,
      dimensions: [{ name: "目标达成", score: 0.62 }],
      issues: ["互动覆盖不足"],
      evidence: ["证据 1"]
    });
    store.recordLoopIteration({
      runId: run.id,
      loopNodeId: "revise-loop",
      iteration: 1,
      scoreBefore: 0.62,
      scoreAfter: 0.74,
      action: "revise",
      changes: ["重写导语"]
    });
    store.finishRun(run.id, "succeeded", { mode: "stub" });

    const stored = store.getRun(run.id);
    assert.equal(stored?.status, "succeeded");
    assert.equal(stored?.stepCount, 1);
    assert.equal(typeof stored?.durationMs, "number");
    assert.deepEqual(store.listSteps(run.id)[0]?.output, { output: "ok" });
    assert.equal(store.listVerifyResults(run.id)[0]?.score, 0.62);
    assert.equal(store.listLoopIterations(run.id)[0]?.scoreAfter, 0.74);
    assert.equal(store.listRuns()[0]?.id, run.id);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("seeds the registry once and persists agent/tool edits", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-registry-"));
  const dbPath = path.join(directory, "platform.db");
  let store = new PlatformStateStore(dbPath);
  try {
    assert.equal(store.seedAgents(BUILTIN_AGENTS), BUILTIN_AGENTS.length);
    assert.equal(store.seedTools(BUILTIN_TOOLS), BUILTIN_TOOLS.length);
    assert.equal(store.seedAgents(BUILTIN_AGENTS), 0);
    assert.equal(store.seedTools(BUILTIN_TOOLS), 0);

    assert.ok(store.listAgents().length >= 8);
    assert.ok(store.listTools().length >= 5);
    assert.equal(store.registrySummary().agentCount, BUILTIN_AGENTS.length);
    assert.equal(store.registrySummary().toolsByType.http, 1);

    const original = store.getAgent("lesson-plan-agent");
    assert.ok(original);
    assert.equal(original.tools.includes("knowledge.search"), true);

    const updated = store.saveAgent({
      ...original,
      name: "教案生成 Agent（定制）",
      version: original.version + 1,
      capabilities: [{ tag: "教学设计", weight: 0.95 }]
    });
    assert.equal(updated.name, "教案生成 Agent（定制）");
    assert.equal(updated.version, original.version + 1);
    assert.equal(updated.createdAt, original.createdAt);
    assert.deepEqual(updated.capabilities, [{ tag: "教学设计", weight: 0.95 }]);

    const tool = store.getTool("knowledge.search");
    assert.ok(tool);
    const updatedTool = store.saveTool({
      ...tool,
      description: "定制后的检索说明",
      enabled: false
    });
    assert.equal(updatedTool.description, "定制后的检索说明");
    assert.equal(updatedTool.enabled, false);

    store.close();
    store = new PlatformStateStore(dbPath);
    assert.equal(store.getAgent("lesson-plan-agent")?.name, "教案生成 Agent（定制）");
    assert.equal(store.getTool("knowledge.search")?.enabled, false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
