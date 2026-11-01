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
    assert.ok(store.listWorkflows().some((item) => item.id === "classroom-v1"));

    const run = store.createRun({
      workflowId: "classroom-v1",
      workflowVersion: 1,
      workflowInput: { topic: "分数的意义" },
      mode: "stub",
      definition: workflow
    });
    assert.equal(run.status, "queued");
    assert.equal(run.definition?.id, "classroom-v1");

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

test("marks interrupted runs as failed when the service restarts", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-restart-"));
  const dbPath = path.join(directory, "platform.db");
  let store = new PlatformStateStore(dbPath);
  try {
    const run = store.createRun({
      workflowId: "classroom-v1",
      workflowVersion: 1,
      workflowInput: { topic: "分数的意义" },
      mode: "stub",
      status: "running"
    });
    const stepId = store.beginStep({
      runId: run.id,
      sequence: 1,
      path: "retrieve",
      nodeId: "retrieve",
      nodeKind: "tool",
      input: { query: "分数的意义" }
    });

    store.close();
    store = new PlatformStateStore(dbPath);

    const reopened = store.getRun(run.id);
    assert.equal(reopened?.status, "failed");
    assert.match(reopened?.error ?? "", /服务重启/);
    assert.equal(store.getStep(stepId)?.status, "failed");
    assert.equal(store.getStep(stepId)?.error, reopened?.error);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps agent version snapshots and rolls back without losing history", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-versions-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  try {
    store.seedAgents(BUILTIN_AGENTS);
    const v1 = store.getAgent("lesson-plan-agent")!;
    assert.equal(store.listAgentVersions("lesson-plan-agent").length, 1);

    store.saveAgent({ ...v1, version: 2, prompt: "v2 提示词" });
    assert.equal(store.listAgentVersions("lesson-plan-agent").length, 2);
    assert.equal(store.getAgentVersion("lesson-plan-agent", 1)?.prompt, v1.prompt);
    assert.equal(store.getAgentVersion("lesson-plan-agent", 2)?.prompt, "v2 提示词");

    const rolled = store.rollbackAgent("lesson-plan-agent", 1)!;
    assert.equal(rolled.version, 1);
    assert.equal(rolled.prompt, v1.prompt);
    assert.equal(store.getAgent("lesson-plan-agent")?.version, 1);
    assert.equal(store.maxAgentVersion("lesson-plan-agent"), 2);

    const v3 = store.saveAgent({
      ...rolled,
      version: store.maxAgentVersion("lesson-plan-agent") + 1,
      prompt: "v3 提示词"
    });
    assert.equal(v3.version, 3);
    assert.equal(store.getAgentVersion("lesson-plan-agent", 2)?.prompt, "v2 提示词");
    assert.equal(store.getAgentVersion("lesson-plan-agent", 3)?.prompt, "v3 提示词");
    assert.equal(store.rollbackAgent("lesson-plan-agent", 99), undefined);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists teams and counts agent invocations from trace", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-teams-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  try {
    const saved = store.saveTeam({
      id: "lesson-team",
      name: "教案实训团队",
      description: "生成 + 评审 + 验证",
      agentIds: ["lesson-plan-agent", "teaching-expert-agent"],
      workflowId: "classroom-v1",
      knowledgeBaseIds: ["kb-lesson"]
    });
    assert.deepEqual(saved.agentIds, ["lesson-plan-agent", "teaching-expert-agent"]);
    assert.equal(store.listTeams().length, 1);

    const run = store.createRun({
      workflowId: "classroom-v1",
      workflowVersion: 1,
      workflowInput: { topic: "分数的意义" },
      mode: "stub"
    });
    const stepId = store.beginStep({
      runId: run.id,
      sequence: 1,
      path: "plan",
      nodeId: "plan",
      nodeKind: "agent",
      input: {}
    });
    store.completeStep(stepId, "succeeded", {
      agent: "lesson-plan-agent",
      agentVersion: 2
    });
    assert.deepEqual(store.agentCallCounts(), { "lesson-plan-agent": 1 });
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
