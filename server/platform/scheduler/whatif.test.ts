import assert from "node:assert/strict";
import test from "node:test";
import type { SchedulerQueueEntry } from "../types.js";
import {
  compareReplayPolicies,
  parseReplayTasks,
  replaySchedule,
  replayTasksFromQueue
} from "./whatif.js";

test("dynamic policy runs the high-priority task first while fifo keeps arrival order", () => {
  const tasks = parseReplayTasks([
    { id: "low", durationMs: 100, enqueuedAt: 0, priority: 0.4, priorityClass: 0 },
    {
      id: "high",
      durationMs: 30,
      enqueuedAt: 0,
      priority: 0.9,
      priorityClass: 5,
      deadlineAt: 50
    }
  ]);

  const dynamic = replaySchedule(tasks, { capacity: 1, policy: "dynamic" });
  assert.equal(dynamic.tasks[0]?.id, "high");
  assert.equal(dynamic.metrics.deadlineMisses, 0);
  assert.equal(dynamic.metrics.priorityInversions, 0);

  const fifo = replaySchedule(tasks, { capacity: 1, policy: "fifo" });
  assert.equal(fifo.tasks[0]?.id, "low");
  assert.equal(fifo.metrics.deadlineMisses, 1);
  assert.equal(fifo.metrics.priorityInversions, 1);
});

test("capacity changes makespan but not total work", () => {
  const tasks = parseReplayTasks([
    { id: "a", durationMs: 100, enqueuedAt: 0, priorityClass: 1 },
    { id: "b", durationMs: 100, enqueuedAt: 0, priorityClass: 1 }
  ]);
  const serial = replaySchedule(tasks, { capacity: 1, policy: "dynamic" });
  const parallel = replaySchedule(tasks, { capacity: 2, policy: "dynamic" });

  assert.equal(serial.metrics.makespanMs, 200);
  assert.equal(parallel.metrics.makespanMs, 100);
  assert.equal(serial.metrics.utilization, 1);
  assert.equal(parallel.metrics.utilization, 1);
});

test("recorded baseline uses the actual start times from the trace", () => {
  const tasks = parseReplayTasks([
    { id: "late-start", durationMs: 20, enqueuedAt: 0, startedAt: 80, priorityClass: 0 },
    { id: "early-start", durationMs: 20, enqueuedAt: 0, startedAt: 10, priorityClass: 0 }
  ]);
  const recorded = replaySchedule(tasks, { capacity: 1, policy: "recorded" });
  const byId = new Map(recorded.tasks.map((item) => [item.id, item]));
  assert.equal(byId.get("late-start")?.waitMs, 80);
  assert.equal(byId.get("early-start")?.waitMs, 10);
});

test("builds replay tasks from persisted queue records and skips unfinished entries", () => {
  const entries: SchedulerQueueEntry[] = [
    {
      id: "queue-1",
      runId: "run-1",
      nodeId: "write",
      path: "write",
      priority: 0.7,
      status: "succeeded",
      enqueuedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      finishedAt: "2026-01-01T00:00:03.000Z",
      priorityClass: 2,
      effectivePriority: 0.7,
      attempts: 1,
      maxAttempts: 3,
      profile: { basePriority: 0.7, criticalPathDepth: 1, maxDepth: 2 }
    },
    {
      id: "queue-2",
      runId: "run-1",
      nodeId: "check",
      path: "check",
      priority: 0.5,
      status: "running",
      enqueuedAt: "2026-01-01T00:00:02.000Z",
      priorityClass: 0,
      effectivePriority: 0.5,
      attempts: 1,
      maxAttempts: 3
    }
  ];
  const tasks = replayTasksFromQueue(entries);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.durationMs, 2000);
  assert.equal(tasks[0]?.priorityClass, 2);
  assert.equal(tasks[0]?.criticalPathDepth, 1);
  assert.equal(tasks[0]?.startedAt, Date.parse("2026-01-01T00:00:01.000Z"));
});

test("compares every policy on the same task set", () => {
  const tasks = parseReplayTasks([
    { id: "a", durationMs: 50, enqueuedAt: 0, startedAt: 0, priorityClass: 0 },
    { id: "b", durationMs: 50, enqueuedAt: 10, startedAt: 60, priorityClass: 3 },
    { id: "c", durationMs: 50, enqueuedAt: 20, startedAt: 120, priorityClass: 1 }
  ]);
  const compared = compareReplayPolicies(tasks, { capacity: 1 });
  assert.deepEqual(Object.keys(compared).sort(), [
    "critical-path",
    "dynamic",
    "fifo",
    "recorded",
    "static"
  ]);
  for (const result of Object.values(compared)) {
    assert.equal(result.metrics.tasks, 3);
  }
});
