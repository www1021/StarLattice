import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "./summary.mjs";

function row(label, payload) {
  return {
    provider: { label },
    response: { output: JSON.stringify(payload) },
    latencyMs: 1000
  };
}

function payload(overrides) {
  return {
    taskId: "topic-01",
    scenario: "topic",
    difficulty: "hard",
    category: "选题",
    success: true,
    evalScore: 0.5,
    evalPassed: false,
    ...overrides
  };
}

test("stress arms report loop engagement and initial-to-final verify gain", () => {
  const raw = {
    results: {
      results: [
        row(
          "S-C-弱初稿自循环",
          payload({ evalScore: 0.9, evalPassed: true, iterations: 1, initialVerifyScore: 0.5, finalVerifyScore: 0.9 })
        ),
        row(
          "S-CN-弱初稿无循环",
          payload({ evalScore: 0.6, evalPassed: false, iterations: 0 })
        )
      ]
    }
  };
  const summary = summarize(raw, { startedAt: 1, finishedAt: 2, concurrency: 1 });
  assert.match(summary.markdown, /S-C-弱初稿自循环 触发 Self-Loop：1\/1（100\.0%）/);
  assert.match(summary.markdown, /首次 0\.500 → 末次 0\.900/);
  assert.match(summary.markdown, /S-C-弱初稿自循环 − S-CN-弱初稿无循环 裁判分差 \+0\.300/);
});

test("ablation arms use explicit star comparisons instead of a chain", () => {
  const raw = {
    results: {
      results: [
        row("C-完整平台", payload({ scenario: "education", evalScore: 0.9, evalPassed: true })),
        row("Cstatic-去调度", payload({ scenario: "education", evalScore: 0.8, evalPassed: true })),
        row("C−loop-去自循环", payload({ scenario: "education", evalScore: 0.9, evalPassed: true })),
        row("Csingle-单验证器", payload({ scenario: "education", evalScore: 0.85, evalPassed: true }))
      ]
    }
  };
  const summary = summarize(raw, { startedAt: 1, finishedAt: 2, concurrency: 1 });
  assert.match(summary.markdown, /C-完整平台 − Cstatic-去调度 \| 1 \| \+0\.100/);
  assert.match(summary.markdown, /C−loop-去自循环 − Csingle-单验证器 \| 1 \| \+0\.050/);
});

test("main arms keep the C vs C-minus-loop engagement block", () => {
  const raw = {
    results: {
      results: [
        row("C-完整平台", payload({ scenario: "education", evalScore: 0.9, evalPassed: true, iterations: 0 })),
        row("C−loop-去自循环", payload({ scenario: "education", evalScore: 0.9, evalPassed: true, iterations: 0 }))
      ]
    }
  };
  const summary = summarize(raw, { startedAt: 1, finishedAt: 2, concurrency: 1 });
  assert.match(summary.markdown, /## Self-Loop 触发与增量/);
  assert.match(summary.markdown, /C-完整平台 触发 Self-Loop：0\/1/);
  assert.match(summary.markdown, /本轮 Self-Loop 未触发/);
});
