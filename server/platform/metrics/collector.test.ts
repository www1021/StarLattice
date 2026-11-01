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
