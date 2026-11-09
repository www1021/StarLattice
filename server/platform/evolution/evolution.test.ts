import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { EvolutionService } from "./service.js";
import { PlatformStateStore } from "../runtime/stateStore.js";
import { WorkflowExecutor } from "../runtime/executor.js";
import { PlatformError, type AgentRecord, type WorkflowDefinition } from "../types.js";

type TestContext = {
  directory: string;
  dbPath: string;
  store: PlatformStateStore;
  service: EvolutionService;
  workflow: WorkflowDefinition;
  agent: AgentRecord;
  close: () => void;
};

const AGENT_ID = "evolution-probe-agent";

function makeContext(): TestContext {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-evolution-"));
  const dbPath = path.join(directory, "platform.db");
  const store = new PlatformStateStore(dbPath);
  const service = new EvolutionService({ store });
  const agent = store.saveAgent({
    id: AGENT_ID,
    name: "演化探针 Agent",
    version: 1,
    role: "writer",
    prompt: "原始提示词：先核对数据口径，再输出结论。",
    tools: [],
    model: "reasoning",
    capabilities: [],
    memory: {},
    enabled: true
  });
  const workflow: WorkflowDefinition = {
    id: "evolution-probe",
    name: "演化探针工作流",
    version: 1,
    inputs: [],
    nodes: [{ id: "writer", kind: "agent", agent: AGENT_ID, title: "写手" }],
    edges: []
  };
  store.saveWorkflow(workflow);
  return {
    directory,
    dbPath,
    store,
    service,
    workflow,
    agent,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** 只负责按发布 id 返回固定验证分；用于隔离门禁逻辑，不模拟真实执行。 */
function fakeExecutor(store: PlatformStateStore, scores: Map<string, number>) {
  return {
    async run(
      workflow: WorkflowDefinition,
      input: Record<string, unknown>,
      options?: { releaseId?: string; experimentId?: string; arm?: string }
    ) {
      const run = store.createRun({
        workflowId: workflow.id,
        workflowVersion: workflow.version,
        workflowInput: input,
        mode: "stub",
        status: "succeeded",
        releaseId: options?.releaseId,
        experimentId: options?.experimentId,
        arm: options?.arm
      });
      store.recordVerifyResult({
        runId: run.id,
        stepId: "verify-probe",
        verifier: "probe",
        score: scores.get(options?.releaseId ?? "") ?? 0.5,
        confidence: 1,
        dimensions: [],
        issues: [],
        evidence: []
      });
      return { run: store.getRun(run.id)!, steps: [] };
    }
  } as unknown as WorkflowExecutor;
}

function installFakeExecutor(context: TestContext, baseScore: number, candidateScore: number) {
  const base = context.service.createBaselineRelease({ workflowId: context.workflow.id });
  const scores = new Map<string, number>([[base.id, baseScore]]);
  const executor = fakeExecutor(context.store, scores);
  context.service.attachExecutors({ stub: executor });
  return { base, scores };
}

function addRegressionDataset(context: TestContext) {
  return context.service.saveDataset({
    workflowId: context.workflow.id,
    name: "演化探针回归集",
    description: "单用例最小回归集",
    cases: [
      {
        id: "case-01",
        datasetId: "",
        title: "口径核对",
        input: {},
        expected: {},
        rubric: [],
        threshold: 0.7,
        tags: []
      }
    ]
  });
}

function promptCandidate(context: TestContext, title: string, after: string) {
  return context.service.createCandidate({
    workflowId: context.workflow.id,
    title,
    changes: [
      {
        id: "chg-probe",
        kind: "prompt_patch",
        target: AGENT_ID,
        before: context.agent.prompt,
        after,
        rationale: "门禁探针"
      }
    ]
  });
}

test("ledger hash chain verifies and detects payload tampering", () => {
  const context = makeContext();
  try {
    context.service.createBaselineRelease({ workflowId: context.workflow.id });
    const healthy = context.service.verifyLedger();
    assert.equal(healthy.valid, true);
    assert.ok(healthy.events >= 1);

    const db = new Database(context.dbPath);
    db.prepare("UPDATE platform_evolution_ledger SET payload = ? WHERE seq = 1").run(
      JSON.stringify({ tampered: true })
    );
    db.close();

    const broken = context.service.verifyLedger();
    assert.equal(broken.valid, false);
    assert.equal(broken.brokenAt, 1);
  } finally {
    context.close();
  }
});

test("security scan rejects workflow path rewriting and records an alert", () => {
  const context = makeContext();
  try {
    const base = context.service.createBaselineRelease({ workflowId: context.workflow.id });
    const candidate = context.service.createCandidate({
      workflowId: context.workflow.id,
      baseReleaseId: base.id,
      title: "试图自动改写拓扑",
      changes: [
        {
          id: "chg-path",
          kind: "workflow_path",
          target: context.workflow.id,
          before: "writer",
          after: "writer -> verify",
          rationale: "绕过离线门禁直接改路径"
        }
      ]
    });
    assert.equal(candidate.status, "gate_failed");
    assert.equal(candidate.security!.passed, false);
    assert.equal(candidate.draftReleaseId, undefined);
    assert.ok(
      candidate.security!.findings.some((item) => item.rule === "workflow-path-unsupported")
    );
    const alerts = context.service.listAlerts();
    assert.ok(alerts.some((item) => item.kind === "security" && item.entityId === candidate.id));
  } finally {
    context.close();
  }
});

test("gate rejects a candidate that regresses the fixed evaluation set", async () => {
  const context = makeContext();
  try {
    const { scores } = installFakeExecutor(context, 0.85, 0.7);
    addRegressionDataset(context);
    const candidate = promptCandidate(
      context,
      "会拖坏其他用例的补丁",
      "补充：先输出结论，再补充口径说明，并省略交叉核对的步骤。"
    );
    assert.ok(candidate.draftReleaseId);
    scores.set(candidate.draftReleaseId!, 0.7);

    const { candidate: decided, decision } = await context.service.runGate(candidate.id, {
      mode: "stub",
      policy: { minCases: 1, minCompletedPerArm: 1 }
    });
    assert.equal(decision.passed, false);
    assert.equal(decided.status, "gate_failed");
    assert.ok(decision.reasons.some((reason) => reason.includes("退化")));
    assert.ok(context.service.listAlerts().some((item) => item.kind === "gate"));
  } finally {
    context.close();
  }
});

test("gate pass still requires human approval before any release is switched", async () => {
  const context = makeContext();
  try {
    const { scores } = installFakeExecutor(context, 0.8, 0.9);
    addRegressionDataset(context);
    const candidate = promptCandidate(
      context,
      "稳定提分补丁",
      "补充：先核对口径与证据，再给出结论和可执行建议，并保留交叉核对。"
    );
    assert.ok(candidate.draftReleaseId);
    scores.set(candidate.draftReleaseId!, 0.9);

    const { candidate: gated } = await context.service.runGate(candidate.id, {
      mode: "stub",
      policy: { minCases: 1, minCompletedPerArm: 1 }
    });
    assert.equal(gated.status, "gate_passed");

    assert.throws(
      () => context.service.approveCandidate(candidate.id, {}),
      (error: unknown) => error instanceof PlatformError && error.status === 400
    );
    assert.throws(
      () => context.service.promoteCandidate(candidate.id, { reviewer: "李老师" }),
      (error: unknown) => error instanceof PlatformError && error.status === 409
    );

    const approved = context.service.approveCandidate(candidate.id, {
      reviewer: "李老师",
      comment: "门禁通过与业务评审均已确认"
    });
    assert.equal(approved.status, "approved");
    assert.throws(
      () => context.service.promoteCandidate(candidate.id, {}),
      (error: unknown) => error instanceof PlatformError && error.status === 400
    );

    const promoted = context.service.promoteCandidate(candidate.id, {
      reviewer: "李老师",
      canaryPercent: 0
    });
    assert.equal(promoted.release.status, "active");
    assert.equal(
      context.store.listReleases(context.workflow.id).filter((item) => item.status === "active").length,
      1
    );

    const rolledBack = context.service.rollbackRelease(promoted.release.id, {
      reviewer: "李老师",
      reason: "演示人工回滚"
    });
    assert.equal(rolledBack.release.status, "rolled_back");
    assert.equal(rolledBack.restored.id, gated.baseReleaseId);
    assert.equal(context.store.getRelease(gated.baseReleaseId)!.status, "active");
  } finally {
    context.close();
  }
});

test("canary guardrail auto-rolls back when the treatment arm degrades", async () => {
  const previousMinSamples = process.env.PLATFORM_EVOLUTION_MIN_SAMPLES;
  process.env.PLATFORM_EVOLUTION_MIN_SAMPLES = "1";
  const context = makeContext();
  try {
    const { scores } = installFakeExecutor(context, 0.8, 0.9);
    addRegressionDataset(context);
    const candidate = promptCandidate(
      context,
      "金丝雀补丁",
      "补充：先核对口径与证据，再给出结论和可执行建议，并保留交叉核对。"
    );
    assert.ok(candidate.draftReleaseId);
    scores.set(candidate.draftReleaseId!, 0.9);
    await context.service.runGate(candidate.id, {
      mode: "stub",
      policy: { minCases: 1, minCompletedPerArm: 1 }
    });
    context.service.approveCandidate(candidate.id, { reviewer: "王老师" });
    const promoted = context.service.promoteCandidate(candidate.id, {
      reviewer: "王老师",
      canaryPercent: 50
    });
    assert.equal(promoted.release.status, "canary");
    assert.ok(promoted.rollout);

    const picks = { control: undefined as ReturnType<EvolutionService["pickRelease"]>, treatment: undefined as ReturnType<EvolutionService["pickRelease"]> };
    for (let index = 0; index < 400; index += 1) {
      const pick = context.service.pickRelease(context.workflow.id, `key-${index}`);
      assert.ok(pick);
      if (pick.arm === "control" && !picks.control) {
        picks.control = pick;
      }
      if (pick.arm === "treatment" && !picks.treatment) {
        picks.treatment = pick;
      }
      if (picks.control && picks.treatment) {
        break;
      }
    }
    assert.ok(picks.control && picks.treatment);

    const simulate = (pick: NonNullable<typeof picks.control>, status: "succeeded" | "failed", score: number) => {
      const run = context.store.createRun({
        workflowId: context.workflow.id,
        workflowVersion: 1,
        workflowInput: {},
        mode: "stub",
        status
      });
      context.store.recordVerifyResult({
        runId: run.id,
        stepId: "simulated",
        verifier: "probe",
        score,
        confidence: 1,
        dimensions: [],
        issues: [],
        evidence: []
      });
      context.service.recordAssignment(run.id, pick, context.workflow.id);
      context.service.observeRun(run.id);
    };

    simulate(picks.control, "succeeded", 0.9);
    simulate(picks.treatment, "failed", 0.4);

    const rollout = context.store.getRollout(promoted.rollout!.id)!;
    assert.equal(rollout.status, "rolled_back");
    assert.equal(context.store.getRelease(promoted.release.id)!.status, "rolled_back");
    assert.equal(context.store.getRelease(promoted.release.parentReleaseId!)!.status, "active");
    assert.ok(
      context.service
        .listAlerts()
        .some((item) => item.kind === "guardrail" && item.severity === "critical")
    );
    assert.equal(context.service.verifyLedger().valid, true);
  } finally {
    if (previousMinSamples === undefined) {
      delete process.env.PLATFORM_EVOLUTION_MIN_SAMPLES;
    } else {
      process.env.PLATFORM_EVOLUTION_MIN_SAMPLES = previousMinSamples;
    }
    context.close();
  }
});

test("released runs are pinned to the immutable agent snapshot", async () => {
  const context = makeContext();
  try {
    const release = context.service.createBaselineRelease({ workflowId: context.workflow.id });
    const executor = new WorkflowExecutor(
      context.store,
      {},
      {
        releaseProvider: {
          resolveRelease: (releaseId) => context.service.resolveRelease(releaseId)
        }
      }
    );

    context.store.saveAgent({
      id: AGENT_ID,
      name: "演化探针 Agent",
      version: 2,
      role: "writer",
      prompt: "注册表里已经被改写的提示词",
      tools: [],
      model: "reasoning",
      capabilities: [],
      memory: {},
      enabled: true
    });

    const view = await executor.run(context.workflow, {}, { releaseId: release.id });
    assert.equal(view.run.releaseId, release.id);
    assert.equal(view.run.status, "succeeded");
    const resolved = context.service.resolveRelease(release.id)!;
    assert.equal(
      resolved.agents.find((agent) => agent.id === AGENT_ID)!.prompt,
      "原始提示词：先核对数据口径，再输出结论。"
    );

    await assert.rejects(
      () => executor.run(context.workflow, {}, { releaseId: "rel_missing" }),
      (error: unknown) => error instanceof PlatformError && error.status === 404
    );
  } finally {
    context.close();
  }
});
