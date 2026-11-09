import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { registerEvolutionRoutes } from "./routes.js";
import { EvolutionService } from "./service.js";
import { PlatformStateStore } from "../runtime/stateStore.js";
import type { WorkflowExecutor } from "../runtime/executor.js";
import type { AgentRecord, WorkflowDefinition } from "../types.js";

const AGENT_ID = "evolution-route-agent";
const WORKFLOW_ID = "evolution-route-probe";

type Harness = {
  base: string;
  store: PlatformStateStore;
  service: EvolutionService;
  agent: AgentRecord;
  workflow: WorkflowDefinition;
  close: () => Promise<void>;
};

async function makeHarness(): Promise<Harness> {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-evolution-routes-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  const service = new EvolutionService({ store });
  const agent = store.saveAgent({
    id: AGENT_ID,
    name: "演化路由探针",
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
    id: WORKFLOW_ID,
    name: "演化路由探针工作流",
    version: 1,
    inputs: [],
    nodes: [{ id: "writer", kind: "agent", agent: AGENT_ID, title: "写手" }],
    edges: []
  };
  store.saveWorkflow(workflow);

  const app = express();
  app.use(express.json());
  registerEvolutionRoutes(app, service);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/evolution`;

  return {
    base,
    store,
    service,
    agent,
    workflow,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

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

function request(base: string) {
  return async (
    method: "GET" | "POST",
    url: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
}

test("evolution routes return 400 for bad input and 404 for unknown entities", async () => {
  const harness = await makeHarness();
  const call = request(harness.base);
  try {
    const missingWorkflow = await call("POST", "/releases", {});
    assert.equal(missingWorkflow.status, 400);
    assert.match(missingWorkflow.body.message, /workflowId/);

    assert.equal((await call("GET", "/releases/rel_missing")).status, 404);
    assert.equal((await call("GET", "/candidates/cand_missing")).status, 404);
    assert.equal((await call("GET", "/rollouts/rollout_missing")).status, 404);
    assert.equal((await call("POST", "/alerts/alert_missing/ack", {})).status, 404);
  } finally {
    await harness.close();
  }
});

test("baseline, security rejection and ledger are visible through the control plane", async () => {
  const harness = await makeHarness();
  const call = request(harness.base);
  try {
    const created = await call("POST", "/releases", { workflowId: WORKFLOW_ID });
    assert.equal(created.status, 201);
    assert.equal(created.body.release.status, "active");
    assert.equal(created.body.release.artifactHash.length, 64);

    const candidate = await call("POST", "/candidates", {
      workflowId: WORKFLOW_ID,
      baseReleaseId: created.body.release.id,
      title: "试图自动改写拓扑",
      changes: [
        { kind: "workflow_path", target: WORKFLOW_ID, after: "writer -> verify" }
      ]
    });
    assert.equal(candidate.status, 201);
    assert.equal(candidate.body.candidate.status, "gate_failed");
    assert.equal(candidate.body.candidate.security.passed, false);
    assert.ok(
      candidate.body.candidate.security.findings.some(
        (item: { rule: string }) => item.rule === "workflow-path-unsupported"
      )
    );

    const list = await call("GET", `/candidates?workflowId=${WORKFLOW_ID}`);
    assert.equal(list.body.candidates.length, 1);

    const alerts = await call("GET", "/alerts?acknowledged=false");
    assert.ok(alerts.body.alerts.some((item: { kind: string }) => item.kind === "security"));

    const ledger = await call("GET", "/ledger");
    assert.equal(ledger.body.integrity.valid, true);
    assert.ok(ledger.body.events.length >= 2);

    const overview = await call("GET", "/overview");
    assert.equal(overview.body.enabled, true);
    assert.equal(overview.body.candidates.total, 1);
    assert.equal(overview.body.alerts.open, 1);
    assert.equal(overview.body.ledger.valid, true);

    const dataset = await call("POST", "/datasets", {
      workflowId: WORKFLOW_ID,
      name: "路由回归集",
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
    assert.equal(dataset.status, 201);
    assert.equal(dataset.body.dataset.cases.length, 1);
    assert.equal(dataset.body.dataset.cases[0].datasetId, dataset.body.dataset.id);

    const datasets = await call("GET", `/datasets?workflowId=${WORKFLOW_ID}`);
    assert.equal(datasets.body.datasets.length, 1);
  } finally {
    await harness.close();
  }
});

test("gate, approval, canary promotion and rollback stay enforced over HTTP", async () => {
  const previousMinSamples = process.env.PLATFORM_EVOLUTION_MIN_SAMPLES;
  process.env.PLATFORM_EVOLUTION_MIN_SAMPLES = "1";
  const harness = await makeHarness();
  const call = request(harness.base);
  try {
    const baseRelease = await call("POST", "/releases", { workflowId: WORKFLOW_ID });
    const baseId: string = baseRelease.body.release.id;
    const scores = new Map<string, number>([[baseId, 0.8]]);
    harness.service.attachExecutors({ stub: fakeExecutor(harness.store, scores) });

    await call("POST", "/datasets", {
      workflowId: WORKFLOW_ID,
      name: "路由门禁回归集",
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

    const created = await call("POST", "/candidates", {
      workflowId: WORKFLOW_ID,
      baseReleaseId: baseId,
      title: "稳定提分补丁",
      changes: [
        {
          kind: "prompt_patch",
          target: AGENT_ID,
          before: harness.agent.prompt,
          after: "补充：先核对口径与证据，再给出结论和可执行建议，并保留交叉核对。",
          rationale: "路由验收"
        }
      ]
    });
    assert.equal(created.status, 201);
    const candidateId: string = created.body.candidate.id;
    scores.set(created.body.candidate.draftReleaseId, 0.9);

    const badPolicy = await call("POST", `/candidates/${candidateId}/gate`, {
      mode: "stub",
      policy: { minTargetDelta: "高" }
    });
    assert.equal(badPolicy.status, 400);

    const gate = await call("POST", `/candidates/${candidateId}/gate`, {
      mode: "stub",
      maxCases: 1,
      policy: { minCases: 1, minCompletedPerArm: 1 }
    });
    assert.equal(gate.status, 200);
    assert.equal(gate.body.decision.passed, true);
    assert.equal(gate.body.candidate.status, "gate_passed");

    assert.equal((await call("POST", `/candidates/${candidateId}/approve`, {})).status, 400);

    const approved = await call("POST", `/candidates/${candidateId}/approve`, {
      reviewer: "验收老师",
      comment: "门禁通过"
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.candidate.status, "approved");

    const promoted = await call("POST", `/candidates/${candidateId}/promote`, {
      reviewer: "验收老师",
      canaryPercent: 50
    });
    assert.equal(promoted.status, 202);
    assert.equal(promoted.body.release.status, "canary");

    const rollouts = await call("GET", `/rollouts?workflowId=${WORKFLOW_ID}`);
    assert.equal(rollouts.body.rollouts.length, 1);
    assert.equal(rollouts.body.rollouts[0].status, "canary");
    const rolloutId: string = rollouts.body.rollouts[0].id;

    let pick = harness.service.pickRelease(WORKFLOW_ID, "route-key");
    for (let index = 0; index < 200 && pick?.arm !== "treatment"; index += 1) {
      pick = harness.service.pickRelease(WORKFLOW_ID, `route-key-${index}`);
    }
    assert.ok(pick && pick.arm === "treatment");
    const run = harness.store.createRun({
      workflowId: WORKFLOW_ID,
      workflowVersion: 1,
      workflowInput: {},
      mode: "stub",
      status: "succeeded"
    });
    harness.store.recordVerifyResult({
      runId: run.id,
      stepId: "simulated",
      verifier: "probe",
      score: 0.9,
      confidence: 1,
      dimensions: [],
      issues: [],
      evidence: []
    });
    harness.service.recordAssignment(run.id, pick, WORKFLOW_ID);
    harness.service.observeRun(run.id);

    const finished = await call("POST", `/rollouts/${rolloutId}/promote`, {
      reviewer: "验收老师"
    });
    assert.equal(finished.status, 202);

    const rollback = await call("POST", `/releases/${promoted.body.release.id}/rollback`, {
      reviewer: "验收老师",
      reason: "验收回滚"
    });
    assert.equal(rollback.status, 202);

    const releases = await call("GET", `/releases?workflowId=${WORKFLOW_ID}`);
    const byId = new Map(
      releases.body.releases.map((item: { id: string; status: string }) => [item.id, item.status])
    );
    assert.equal(byId.get(baseId), "active");
    assert.equal(byId.get(promoted.body.release.id), "rolled_back");
  } finally {
    if (previousMinSamples === undefined) {
      delete process.env.PLATFORM_EVOLUTION_MIN_SAMPLES;
    } else {
      process.env.PLATFORM_EVOLUTION_MIN_SAMPLES = previousMinSamples;
    }
    await harness.close();
  }
});
