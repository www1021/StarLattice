import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
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

test("scheduler leases track real in-flight load, heartbeat and expiry", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-platform-lease-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  try {
    const lease = store.acquireSchedulerLease({
      runId: "run_probe",
      stepId: "step_probe",
      taskPath: "write",
      agentId: "lease-agent",
      workerId: "worker-1",
      ttlMs: 5000
    });
    assert.equal(lease.status, "active");
    assert.deepEqual(store.activeLeaseLoads(), { "lease-agent": { inFlight: 1 } });
    assert.deepEqual(
      store.listSchedulerLeases({ active: true, agentId: "lease-agent" }).map((item) => item.id),
      [lease.id]
    );

    const heartbeat = store.heartbeatSchedulerLease(lease.id, 6000);
    assert.ok(heartbeat);
    assert.ok(Date.parse(heartbeat.expiresAt) > Date.parse(lease.expiresAt));

    assert.equal(store.releaseSchedulerLease(lease.id, "completed"), true);
    assert.equal(store.releaseSchedulerLease(lease.id, "completed"), false);
    assert.deepEqual(store.activeLeaseLoads(), {});
    assert.equal(store.getSchedulerLease(lease.id)?.releaseReason, "completed");
    // 已释放的租约不能被心跳复活。
    assert.equal(store.heartbeatSchedulerLease(lease.id, 6000), undefined);

    const stale = store.acquireSchedulerLease({
      runId: "run_probe",
      taskPath: "write",
      agentId: "lease-agent",
      workerId: "worker-2",
      ttlMs: 1000
    });
    assert.equal(store.expireSchedulerLeases(Date.now() + 5000), 1);
    assert.equal(store.getSchedulerLease(stale.id)?.status, "expired");
    assert.equal(store.getSchedulerLease(stale.id)?.releaseReason, "heartbeat_timeout");
    assert.deepEqual(store.activeLeaseLoads(), {});
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scheduler workers register, heartbeat, filter by capability and expire", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-platform-worker-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  try {
    const worker = store.upsertSchedulerWorker({
      id: "worker-model-1",
      host: "localhost",
      pid: 1234,
      slot: 1,
      lane: "model",
      capabilities: ["agent", "llm"],
      capacity: 2,
      status: "idle",
      ttlMs: 5000
    });
    assert.equal(worker.status, "idle");
    assert.equal(worker.capacity, 2);
    assert.deepEqual(worker.capabilities, ["agent", "llm"]);
    assert.equal(store.listSchedulerWorkers({ capability: "llm" }).length, 1);
    assert.equal(store.listSchedulerWorkers({ capability: "mcp" }).length, 0);

    assert.equal(store.heartbeatSchedulerWorker(worker.id, 8000), true);
    assert.ok(
      Date.parse(store.getSchedulerWorker(worker.id)!.expiresAt) > Date.parse(worker.expiresAt)
    );

    assert.equal(store.expireSchedulerWorkers(Date.now() + 10000), 1);
    assert.equal(store.getSchedulerWorker(worker.id)?.status, "dead");
    assert.equal(store.getSchedulerWorker(worker.id)?.stopReason, "heartbeat_timeout");
    // 已死亡的 Worker 不再接受心跳复活。
    assert.equal(store.heartbeatSchedulerWorker(worker.id, 8000), false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scheduler leadership is exclusive until the holder releases it", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-platform-leader-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  try {
    assert.equal(store.acquireSchedulerLeadership("node-a", 5000), true);
    assert.equal(store.acquireSchedulerLeadership("node-b", 5000), false);
    assert.equal(store.heartbeatSchedulerLeadership("node-b", 5000), false);
    assert.equal(store.heartbeatSchedulerLeadership("node-a", 5000), true);
    assert.equal(store.getSchedulerLeadership()?.holder, "node-a");

    assert.equal(store.releaseSchedulerLeadership("node-b"), false);
    assert.equal(store.releaseSchedulerLeadership("node-a"), true);
    assert.equal(store.acquireSchedulerLeadership("node-b", 5000), true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("run nodes, queue claims, attempts and checkpoints round-trip", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-platform-scheduler-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  try {
    const run = store.createRun({
      workflowId: "scheduler-probe",
      workflowVersion: 1,
      workflowInput: {},
      mode: "stub",
      priorityClass: 2,
      deadlineAt: "2026-11-20T23:59:00.000Z",
      schedulerState: "queued"
    });
    assert.equal(run.priorityClass, 2);
    assert.equal(run.schedulerState, "queued");

    store.insertRunNodes(run.id, [
      { nodeId: "write", path: "write", priority: 0.8 },
      { nodeId: "verify", path: "verify", priority: 0.4 }
    ]);
    // 重复登记不能把已有进度重置回 pending。
    store.setRunNodeStatus(run.id, "write", "ready");
    store.insertRunNodes(run.id, [{ nodeId: "write", path: "write" }]);
    assert.equal(store.getRunNode(run.id, "write")?.status, "ready");
    assert.equal(store.listRunNodes(run.id).length, 2);

    store.setRunNodeStatus(run.id, "write", "running");
    store.setRunNodeStatus(run.id, "write", "succeeded", { attempts: 1 });
    const node = store.getRunNode(run.id, "write")!;
    assert.equal(node.status, "succeeded");
    assert.ok(node.readyAt && node.startedAt && node.finishedAt);
    assert.equal(node.attempts, 1);

    const queueId = store.enqueueSchedulerTask({
      runId: run.id,
      nodeId: "write",
      path: "write",
      priority: 0.8,
      reason: "关键路径",
      requiredCapability: "model",
      priorityClass: 2,
      effectivePriority: 0.87,
      profile: { estimatedTokens: 1200 },
      agentId: "planner",
      maxAttempts: 3,
      deadlineAt: "2026-11-20T23:59:00.000Z"
    });
    const entry = store.getSchedulerQueueEntry(queueId)!;
    assert.equal(entry.requiredCapability, "model");
    assert.equal(entry.priorityClass, 2);
    assert.equal(entry.effectivePriority, 0.87);
    assert.deepEqual(entry.profile, { estimatedTokens: 1200 });
    assert.equal(entry.agentId, "planner");
    assert.equal(entry.maxAttempts, 3);

    store.startSchedulerTask(queueId);
    assert.equal(store.getSchedulerQueueEntry(queueId)?.status, "running");

    const attempt = store.startSchedulerAttempt({
      queueId,
      attempt: 1,
      workerId: "worker-model-1",
      agentId: "planner",
      waitMs: 12
    });
    assert.equal(attempt.status, "running");
    assert.equal(store.finishSchedulerAttempt(attempt.id, "succeeded"), true);
    const finished = store.getSchedulerAttempt(attempt.id)!;
    assert.equal(finished.status, "succeeded");
    assert.ok(finished.finishedAt);
    assert.equal(store.listSchedulerAttempts({ queueId }).length, 1);
    assert.equal(store.listSchedulerAttempts({ runId: run.id }).length, 1);

    store.finishSchedulerTask(queueId, "succeeded");
    assert.equal(store.getSchedulerQueueEntry(queueId)?.status, "succeeded");

    store.saveRunCheckpoint({ runId: run.id, sequence: 1, state: { step: "write" } });
    store.saveRunCheckpoint({ runId: run.id, sequence: 2, state: { step: "verify" } });
    assert.deepEqual(store.latestRunCheckpoint(run.id)?.state, { step: "verify" });
    assert.equal(store.listRunCheckpoints(run.id).length, 2);

    assert.equal(store.requestRunCancel(run.id), true);
    assert.ok(store.getRun(run.id)?.cancelRequestedAt);
    assert.equal(store.updateRunSchedulerState(run.id, "cancelled"), true);
    assert.equal(store.getRun(run.id)?.schedulerState, "cancelled");
    assert.equal(store.incrementRunResumeCount(run.id), true);
    assert.equal(store.getRun(run.id)?.resumeCount, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a task can only hold one active lease at a time", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-platform-lease-task-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  try {
    const lease = store.acquireSchedulerLease({
      runId: "run_task",
      taskId: "queue_task",
      taskPath: "write",
      agentId: "planner",
      workerId: "worker-1",
      ttlMs: 5000
    });
    assert.equal(lease.taskId, "queue_task");
    assert.throws(
      () =>
        store.acquireSchedulerLease({
          runId: "run_task",
          taskId: "queue_task",
          taskPath: "write",
          agentId: "planner",
          workerId: "worker-2",
          ttlMs: 5000
        }),
      /UNIQUE/
    );
    store.releaseSchedulerLease(lease.id, "completed");
    const next = store.acquireSchedulerLease({
      runId: "run_task",
      taskId: "queue_task",
      taskPath: "write",
      agentId: "planner",
      workerId: "worker-2",
      ttlMs: 5000
    });
    assert.equal(next.workerId, "worker-2");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates a legacy scheduler queue without losing rows or blocking new statuses", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-platform-migrate-"));
  const dbPath = path.join(directory, "platform.db");
  // 复刻 Phase 0 之前的旧表结构，验证启动迁移而不是删库重建。
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE platform_scheduler_queue (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      path TEXT NOT NULL,
      priority REAL NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'skipped')),
      enqueued_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      wait_ms INTEGER,
      reason TEXT
    );
    CREATE TABLE platform_scheduler_leases (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT,
      task_path TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired')),
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      released_at TEXT,
      release_reason TEXT
    );
    INSERT INTO platform_scheduler_queue
      (id, run_id, node_id, path, priority, status, enqueued_at, reason)
    VALUES ('queue_old', 'run_old', 'write', 'write', 0.5, 'queued', '2026-01-01T00:00:00.000Z', 'legacy');
  `);
  legacy.close();

  const store = new PlatformStateStore(dbPath);
  try {
    const entry = store.getSchedulerQueueEntry("queue_old")!;
    assert.equal(entry.status, "queued");
    assert.equal(entry.priorityClass, 0);
    assert.equal(entry.effectivePriority, 0.5);
    assert.equal(entry.maxAttempts, 1);

    store.finishSchedulerTask("queue_old", "cancelled", "迁移后允许新状态");
    assert.equal(store.getSchedulerQueueEntry("queue_old")?.status, "cancelled");

    const lease = store.acquireSchedulerLease({
      runId: "run_old",
      taskId: "queue_old",
      taskPath: "write",
      agentId: "planner",
      workerId: "worker-1",
      ttlMs: 5000
    });
    assert.equal(lease.taskId, "queue_old");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
