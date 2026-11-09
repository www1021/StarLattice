import assert from "node:assert/strict";
import test from "node:test";
import type { RunRecord } from "../types.js";
import { collectMetrics, type MetricsSource } from "./collector.js";

function run(overrides: Partial<RunRecord> & { id: string; workflowId: string }): RunRecord {
  return {
    workflowVersion: 1,
    status: "succeeded",
    mode: "stub",
    input: {},
    stepCount: 10,
    startedAt: "2026-10-31T00:00:00.000Z",
    finishedAt: "2026-10-31T00:00:01.000Z",
    ...overrides
  };
}

function source(runs: RunRecord[], loops: Record<string, number> = {}): MetricsSource {
  return {
    listRunsForMetrics: () => runs,
    countLoopIterationsByRun: (runIds) =>
      new Map(runIds.filter((id) => id in loops).map((id) => [id, loops[id]]))
  };
}

test("returns an empty structure when there is no data", () => {
  const report = collectMetrics(source([]));
  assert.equal(report.overall.runCount, 0);
  assert.equal(report.overall.successRate, 0);
  assert.equal(report.overall.scoreAvg, null);
  assert.equal(report.overall.p50Ms, 0);
  assert.equal(report.overall.tokensTotal, 0);
  assert.deepEqual(report.workflows, []);
});

test("aggregates success, pass, score, latency, steps, loops, tokens and cost", () => {
  const previous = process.env.PLATFORM_COST_PER_1K_TOKENS;
  process.env.PLATFORM_COST_PER_1K_TOKENS = "0.004";
  try {
    const runs = [
      run({
        id: "r1",
        workflowId: "wf-a",
        durationMs: 100,
        stepCount: 8,
        output: { score: 0.8, tokensUsed: 1000, verify: { score: 0.8, passed: true } }
      }),
      run({
        id: "r2",
        workflowId: "wf-a",
        durationMs: 300,
        stepCount: 12,
        output: { score: 0.9, tokensUsed: 3000, verify: { score: 0.9, passed: true } }
      }),
      run({
        id: "r3",
        workflowId: "wf-a",
        status: "failed",
        durationMs: 200,
        stepCount: 4,
        output: { score: 0.5, tokensUsed: 2000, verify: { score: 0.5, passed: false } }
      }),
      run({
        id: "r4",
        workflowId: "wf-b",
        durationMs: 400,
        stepCount: 6,
        output: { score: 0.7, tokensUsed: 4000, verify: { score: 0.7, passed: false } }
      })
    ];
    const report = collectMetrics(source(runs, { r1: 2, r2: 1, r4: 3 }), {
      workflowIds: ["wf-a", "wf-b"]
    });

    assert.equal(report.overall.runCount, 4);
    assert.equal(report.overall.succeeded, 3);
    assert.equal(report.overall.failed, 1);
    assert.equal(report.overall.successRate, 0.75);
    assert.equal(report.overall.taskPassed, 2);
    assert.equal(report.overall.taskRate, 0.5);
    assert.equal(report.overall.scoreAvg, 0.725);
    assert.equal(report.overall.p50Ms, 200);
    assert.equal(report.overall.p95Ms, 400);
    assert.equal(report.overall.stepsAvg, 7.5);
    assert.equal(report.overall.iterationsAvg, 1.5);
    assert.equal(report.overall.tokensTotal, 10000);
    assert.equal(report.overall.tokensAvg, 2500);
    assert.equal(report.overall.estimatedCost, 0.04);
    assert.deepEqual(report.overall.modes, ["stub"]);

    const wfA = report.workflows.find((item) => item.workflowId === "wf-a");
    assert.ok(wfA);
    assert.equal(wfA.runCount, 3);
    assert.equal(wfA.iterationsAvg, 1);
    const wfB = report.workflows.find((item) => item.workflowId === "wf-b");
    assert.equal(wfB?.p95Ms, 400);
  } finally {
    if (previous === undefined) {
      delete process.env.PLATFORM_COST_PER_1K_TOKENS;
    } else {
      process.env.PLATFORM_COST_PER_1K_TOKENS = previous;
    }
  }
});

test("flags failure spikes, latency spikes and score drift", () => {
  const runs = [
    // 最新 5 次里 3 次失败 → failure_spike
    run({ id: "f5", workflowId: "wf-fail", status: "failed" }),
    run({ id: "f4", workflowId: "wf-fail", status: "failed" }),
    run({ id: "f3", workflowId: "wf-fail", status: "failed" }),
    run({ id: "f2", workflowId: "wf-fail" }),
    run({ id: "f1", workflowId: "wf-fail" }),
    // 最近一次 20s，历史中位数 1s → latency_spike
    run({ id: "l4", workflowId: "wf-slow", durationMs: 20_000 }),
    run({ id: "l3", workflowId: "wf-slow", durationMs: 1_000 }),
    run({ id: "l2", workflowId: "wf-slow", durationMs: 1_000 }),
    run({ id: "l1", workflowId: "wf-slow", durationMs: 1_000 }),
    // 最近 5 次 0.60，此前 10 次 0.90 → score_drift
    ...Array.from({ length: 5 }, (_, index) =>
      run({
        id: `s-recent-${index}`,
        workflowId: "wf-drift",
        output: { verify: { score: 0.6, passed: false } }
      })
    ),
    ...Array.from({ length: 10 }, (_, index) =>
      run({
        id: `s-old-${index}`,
        workflowId: "wf-drift",
        output: { verify: { score: 0.9, passed: true } }
      })
    )
  ];

  const report = collectMetrics(source(runs));
  const kinds = new Map(report.alerts.map((alert) => [alert.workflowId, alert.kind]));
  assert.equal(kinds.get("wf-fail"), "failure_spike");
  assert.equal(kinds.get("wf-slow"), "latency_spike");
  assert.equal(kinds.get("wf-drift"), "score_drift");
  const drift = report.alerts.find((alert) => alert.workflowId === "wf-drift");
  assert.equal(drift?.severity, "critical");
  assert.ok((drift?.value ?? 0) >= 0.2);
});

test("keeps the alert list empty when recent runs are healthy", () => {
  const runs = Array.from({ length: 8 }, (_, index) =>
    run({
      id: `ok-${index}`,
      workflowId: "wf-ok",
      durationMs: 1_000,
      output: { verify: { score: 0.9, passed: true } }
    })
  );
  const report = collectMetrics(source(runs));
  assert.deepEqual(report.alerts, []);
});
