import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCapability, AgentRecord } from "../types.js";
import { SelfLoopController } from "./controller.js";

function agent(id: string, name: string, capabilities: AgentCapability[]): AgentRecord {
  return {
    id,
    name,
    version: 1,
    role: "测试 Agent",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities,
    memory: {},
    enabled: true,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z"
  };
}

function controller(options: { threshold?: number; maxIterations?: number; agents?: AgentRecord[] }) {
  return new SelfLoopController({
    threshold: options.threshold ?? 0.85,
    maxIterations: options.maxIterations ?? 3,
    policy: { patience: 2, minGain: 0.01, budget: { maxDurationMs: 0, maxTokens: 0 } },
    agents: options.agents
  });
}

test("continues below the threshold and stops when the score passes", () => {
  const loop = controller({});
  const first = loop.evaluate({
    iteration: 1,
    score: 0.74,
    previousScore: 0.62,
    issues: ["互动覆盖不足，沉默学生未参与"],
    whilePassed: true,
    elapsedMs: 10,
    tokensUsed: 120
  });
  assert.equal(first.continue, true);
  assert.equal(first.action, "rewrite");
  assert.equal(first.delta, 0.12);
  assert.ok(first.changes.some((change) => change.includes("得分 0.62 → 0.74")));
  assert.ok(first.changes.some((change) => change.includes("下一轮动作：重写输出")));

  const second = loop.evaluate({
    iteration: 2,
    score: 0.86,
    previousScore: 0.74,
    issues: [],
    whilePassed: true,
    elapsedMs: 20,
    tokensUsed: 240
  });
  assert.equal(second.continue, false);
  assert.equal(second.stopReason, "passed");
  assert.equal(second.bestScore, 0.86);
  assert.ok(second.changes.some((change) => change.includes("停止原因：达到验证阈值")));
});

test("chooses retrieval when issues point at evidence gaps", () => {
  const loop = controller({});
  const decision = loop.evaluate({
    iteration: 1,
    score: 0.7,
    previousScore: 0.62,
    issues: ["引用来源缺失", "维度「证据支撑」未达标（0.7 < 0.85）"],
    whilePassed: true,
    elapsedMs: 10,
    tokensUsed: 100
  });
  assert.equal(decision.continue, true);
  assert.equal(decision.action, "retrieve");
  // 有维度名时只取短词，避免把整段问题清单当成检索词。
  assert.equal(decision.retrievalQuery, "证据支撑");
  assert.match(decision.reason, /补充检索/);
});

test("swaps to a capable alternative after a stalled round", () => {
  const weak = agent("weak-agent", "普通教案 Agent", [{ tag: "教案设计", weight: 0.7 }]);
  const strong = agent("strong-agent", "资深教案 Agent", [{ tag: "教案设计", weight: 0.92 }]);
  const loop = controller({ threshold: 0.9, maxIterations: 5, agents: [weak, strong] });

  const first = loop.evaluate({
    iteration: 1,
    score: 0.6,
    previousScore: 0.6,
    issues: ["目标表述不可测"],
    whilePassed: true,
    elapsedMs: 10,
    tokensUsed: 100,
    currentAgentId: weak.id
  });
  assert.equal(first.action, "rewrite");

  const second = loop.evaluate({
    iteration: 2,
    score: 0.6,
    previousScore: 0.6,
    issues: ["目标表述不可测"],
    whilePassed: true,
    elapsedMs: 20,
    tokensUsed: 200,
    currentAgentId: weak.id
  });
  assert.equal(second.continue, true);
  assert.equal(second.action, "swap_agent");
  assert.equal(second.nextAgentId, "strong-agent");
  assert.match(second.reason, /连续 1 轮没有提升/);
});

test("stops after the configured patience without improvement", () => {
  const loop = controller({ threshold: 0.9, maxIterations: 5 });
  const scores = [0.6, 0.6, 0.6];
  let decision;
  for (let index = 0; index < scores.length; index += 1) {
    decision = loop.evaluate({
      iteration: index + 1,
      score: scores[index],
      previousScore: index === 0 ? 0.6 : scores[index - 1],
      issues: ["互动覆盖不足"],
      whilePassed: true,
      elapsedMs: (index + 1) * 10,
      tokensUsed: (index + 1) * 100
    });
  }
  assert.ok(decision);
  assert.equal(decision.continue, false);
  assert.equal(decision.stopReason, "no_improvement");
  assert.match(decision.reason, /连续 2 轮没有超过最低增益/);
});

test("respects time and token budgets", () => {
  const timed = new SelfLoopController({
    threshold: 0.9,
    maxIterations: 5,
    policy: { patience: 2, minGain: 0.01, budget: { maxDurationMs: 100, maxTokens: 0 } }
  });
  timed.evaluate({
    iteration: 1,
    score: 0.7,
    previousScore: 0.6,
    issues: [],
    whilePassed: true,
    elapsedMs: 1,
    tokensUsed: 1
  });
  const timeStop = timed.evaluate({
    iteration: 2,
    score: 0.72,
    previousScore: 0.7,
    issues: [],
    whilePassed: true,
    elapsedMs: 120_001,
    tokensUsed: 10
  });
  assert.equal(timeStop.stopReason, "budget_time");

  const tokenLimited = new SelfLoopController({
    threshold: 0.9,
    maxIterations: 5,
    policy: { patience: 2, minGain: 0.01, budget: { maxDurationMs: 0, maxTokens: 100 } }
  });
  const tokenStop = tokenLimited.evaluate({
    iteration: 1,
    score: 0.7,
    previousScore: 0.6,
    issues: [],
    whilePassed: true,
    elapsedMs: 10,
    tokensUsed: 120
  });
  assert.equal(tokenStop.stopReason, "budget_tokens");
});

test("stops when the while condition no longer holds", () => {
  const loop = controller({ threshold: 0.95, maxIterations: 5 });
  const decision = loop.evaluate({
    iteration: 1,
    score: 0.7,
    previousScore: 0.6,
    issues: [],
    whilePassed: false,
    elapsedMs: 10,
    tokensUsed: 100
  });
  assert.equal(decision.continue, false);
  assert.equal(decision.stopReason, "while_false");
});
