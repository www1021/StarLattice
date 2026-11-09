import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTaskProfile,
  classifyNode,
  effectivePriorityOf,
  explainPriority
} from "./profiler.js";

test("classifies node kinds into scheduling lanes", () => {
  assert.equal(classifyNode("agent").class, "reasoning");
  assert.equal(classifyNode("verify").class, "reasoning");
  assert.equal(classifyNode("tool").class, "tool");
  assert.equal(classifyNode("knowledge").class, "io");
  assert.equal(classifyNode("http").class, "io");
  assert.equal(classifyNode("approve").class, "gate");
  assert.equal(classifyNode("human").class, "gate");
  assert.equal(classifyNode("start").class, "inline");
});

test("ranks deeper tasks first within the same class", () => {
  const input = { kind: "agent" as const, maxDepth: 2, enqueuedAt: 0 };
  const shallow = buildTaskProfile({ ...input, criticalPathDepth: 0 });
  const deep = buildTaskProfile({ ...input, criticalPathDepth: 2 });
  assert.ok(deep.base > shallow.base);
  // 关键路径基础分落在 0.5–1 区间。
  assert.equal(shallow.basePriority, 0.5);
  assert.equal(deep.basePriority, 1);
  assert.ok(deep.base - shallow.base <= 5);
});

test("run-level priority class overrides the kind class", () => {
  const base = buildTaskProfile({
    kind: "template",
    criticalPathDepth: 0,
    maxDepth: 0,
    priorityClass: 5
  });
  const gate = buildTaskProfile({ kind: "approve", criticalPathDepth: 0, maxDepth: 0 });
  assert.ok(base.base > gate.base);
  assert.ok(explainPriority(base, base.enqueuedAt).includes("inline"));
});

test("aging lifts long-waiting tasks within one class but stays capped", () => {
  const profile = buildTaskProfile({
    kind: "agent",
    criticalPathDepth: 0,
    maxDepth: 1,
    enqueuedAt: 1_000_000
  });
  assert.equal(effectivePriorityOf(profile, 1_000_000), profile.base);
  assert.ok(effectivePriorityOf(profile, 1_002_000) > profile.base);
  // 老化封顶 50，避免老任务压过所有静态高分任务。
  assert.equal(effectivePriorityOf(profile, 1_100_000) - profile.base, 50);
});

test("deadline proximity and overdue add a bounded boost", () => {
  const enqueuedAt = 1_000_000;
  const far = buildTaskProfile({
    kind: "knowledge",
    criticalPathDepth: 0,
    maxDepth: 0,
    enqueuedAt,
    deadlineAt: enqueuedAt + 300_000
  });
  const near = buildTaskProfile({
    kind: "http",
    criticalPathDepth: 0,
    maxDepth: 0,
    enqueuedAt,
    deadlineAt: enqueuedAt + 30_000
  });
  const overdue = buildTaskProfile({
    kind: "http",
    criticalPathDepth: 0,
    maxDepth: 0,
    enqueuedAt,
    deadlineAt: enqueuedAt - 1
  });
  assert.equal(effectivePriorityOf(far, enqueuedAt), far.base);
  assert.equal(effectivePriorityOf(near, enqueuedAt), near.base + 20);
  assert.equal(effectivePriorityOf(overdue, enqueuedAt), overdue.base + 40);
});
