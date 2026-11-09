#!/usr/bin/env node
/**
 * 动态调度验收：同一批确定性任务分别跑动态优先级 / 静态 FIFO / 串行三条臂。
 *
 * 任务体是 stub Agent + 固定 sleep，不调用任何模型，因此可以反复运行。
 * 这里验证的是“排队顺序与并发位如何影响等待时间”，不代表真实模型质量。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowDefinition } from "../server/platform/types.js";
import { BUILTIN_AGENTS } from "../server/platform/registry/agents.js";
import { WorkflowExecutor } from "../server/platform/runtime/executor.js";
import { PlatformStateStore } from "../server/platform/runtime/stateStore.js";
import {
  compareReplayPolicies,
  replaySchedule,
  replayTasksFromQueue,
  type ReplayTask
} from "../server/platform/scheduler/whatif.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, "results");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const CASE_COUNT = Math.max(1, Number(process.env.BENCH_SCHEDULER_CASES) || 30);
const CAPACITY = Math.max(1, Number(process.env.BENCH_SCHEDULER_CAPACITY) || 4);
const NODES_PER_CASE = 3;
const PRIORITY_CLASSES = [5, 0, 3, 0, 2, 1];

type Case = {
  id: string;
  priorityClass: number;
  durations: number[];
  totalMs: number;
  arrivalDelayMs: number;
};

type ArmResult = {
  name: "dynamic" | "static" | "serial";
  capacity: number;
  policy: "priority" | "fifo";
  wallMs: number;
  succeeded: number;
  failed: number;
  metrics: ReturnType<typeof replaySchedule>["metrics"];
  highPriorityWaitMs: number;
  lowPriorityWaitMs: number;
  perRun: Array<{ id: string; status: string; durationMs?: number }>;
};

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** 固定种子生成 30 个用例：优先级分层、每节点 30–140ms、到达时间错开。 */
function buildCases(count: number): Case[] {
  const next = rng(20261108);
  return Array.from({ length: count }, (_, index) => {
    const durations = Array.from({ length: NODES_PER_CASE }, () =>
      Math.round(30 + next() * 110)
    );
    const totalMs = durations.reduce((sum, value) => sum + value, 0);
    return {
      id: `case-${String(index + 1).padStart(2, "0")}`,
      priorityClass: PRIORITY_CLASSES[index % PRIORITY_CLASSES.length],
      durations,
      totalMs,
      arrivalDelayMs: index * 8
    };
  });
}

function workflowOf(item: Case): WorkflowDefinition {
  const nodes = item.durations.map((duration, index) => ({
    id: `${item.id}-n${index + 1}-${duration}`,
    kind: "agent" as const,
    agent: "topic-innovation-agent"
  }));
  return {
    id: `bench-${item.id}`,
    name: `调度验收 ${item.id}`,
    version: 1,
    inputs: [],
    nodes,
    edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id }))
  };
}

function durationOf(nodeId: string): number {
  const value = Number(nodeId.split("-").at(-1));
  return Number.isFinite(value) && value > 0 ? value : 50;
}

function createStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-scheduler-arm-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  store.seedAgents(BUILTIN_AGENTS);
  return {
    store,
    dispose() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runArm(
  name: ArmResult["name"],
  cases: Case[],
  options: { policy: "dynamic" | "static"; capacity: number; serial: boolean }
): Promise<{ result: ArmResult; tasks: ReplayTask[] }> {
  const { store, dispose } = createStore();
  try {
    const workflows = new Map(cases.map((item) => [item.id, workflowOf(item)]));
    for (const workflow of workflows.values()) {
      store.saveWorkflow(workflow);
    }
    const executor = new WorkflowExecutor(
      store,
      {
        agent: async (node) => {
          await delay(durationOf(node.id));
          return { mode: "stub", output: `${node.id}:ok` };
        }
      },
      {
        schedulerCapacity: options.capacity,
        schedulerPolicy: options.policy,
        maxAttempts: 1
      }
    );
    const startedAt = Date.now();
    // 三条臂共用同一绝对截止时间：串行臂不会因为逐单运行而“重置”截止时间。
    const deadlineOf = (item: Case) =>
      new Date(startedAt + item.arrivalDelayMs + item.totalMs + 300).toISOString();
    const runOne = async (item: Case) => {
      const run = await executor.run(workflows.get(item.id)!, {}, {
        priorityClass: item.priorityClass,
        deadlineAt: deadlineOf(item)
      });
      return { id: run.run.id, status: run.run.status, durationMs: run.run.durationMs };
    };
    const perRun: ArmResult["perRun"] = [];
    if (options.serial) {
      for (const item of cases) {
        perRun.push(await runOne(item));
      }
    } else {
      const pending = cases.map(async (item) => {
        await delay(item.arrivalDelayMs);
        return runOne(item);
      });
      perRun.push(...(await Promise.all(pending)));
    }
    const wallMs = Date.now() - startedAt;

    const tasks = perRun
      .filter((item) => item.id)
      .flatMap((item) => replayTasksFromQueue(store.listSchedulerQueue(item.id, 200)));
    const recordedResult = replaySchedule(tasks, {
      capacity: options.capacity,
      policy: "recorded"
    });
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const waitsOf = (high: boolean) => {
      const waits = recordedResult.tasks
        .filter((task) => {
          const priorityClass = byId.get(task.id)?.priorityClass ?? 0;
          return high ? priorityClass >= 3 : priorityClass < 3;
        })
        .map((task) => task.waitMs);
      return waits.length > 0
        ? Number((waits.reduce((sum, value) => sum + value, 0) / waits.length).toFixed(1))
        : 0;
    };
    return {
      result: {
        name,
        capacity: options.capacity,
        policy: options.policy === "static" ? "fifo" : "priority",
        wallMs,
        succeeded: perRun.filter((item) => item.status === "succeeded").length,
        failed: perRun.filter((item) => item.status !== "succeeded").length,
        metrics: recordedResult.metrics,
        highPriorityWaitMs: waitsOf(true),
        lowPriorityWaitMs: waitsOf(false),
        perRun
      },
      tasks
    };
  } finally {
    dispose();
  }
}

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

/** 用实测数字生成观察，避免把一次实验写死成结论。 */
function observationOf(arms: ArmResult[]): string {
  const dynamic = arms.find((arm) => arm.name === "dynamic");
  const staticArm = arms.find((arm) => arm.name === "static");
  const serial = arms.find((arm) => arm.name === "serial");
  if (!dynamic || !staticArm || !serial) {
    return "缺少对照臂，未生成观察。";
  }
  const highDelta = dynamic.highPriorityWaitMs - staticArm.highPriorityWaitMs;
  const lowDelta = dynamic.lowPriorityWaitMs - staticArm.lowPriorityWaitMs;
  const speedup = serial.wallMs / Math.max(1, dynamic.wallMs);
  const priorityLine =
    highDelta < 0
      ? `动态策略把高优任务平均等待从 ${staticArm.highPriorityWaitMs} ms 降到 ${dynamic.highPriorityWaitMs} ms，` +
        (lowDelta > 0
          ? `代价是低优等待从 ${staticArm.lowPriorityWaitMs} ms 升到 ${dynamic.lowPriorityWaitMs} ms。`
          : `低优等待没有恶化（${staticArm.lowPriorityWaitMs} → ${dynamic.lowPriorityWaitMs} ms），但整体 P95 仍为 ${dynamic.metrics.waitP95Ms} ms。`)
      : `本次实验中动态策略没有缩短高优等待（${staticArm.highPriorityWaitMs} → ${dynamic.highPriorityWaitMs} ms），` +
        `低优等待为 ${dynamic.lowPriorityWaitMs} ms；高优收益未被证实，需要更多负载点复核。`;
  return [
    priorityLine,
    `并发 ${dynamic.capacity} 槽相比逐单串行，墙钟耗时从 ${serial.wallMs} ms 降到 ${dynamic.wallMs} ms（约 ${speedup.toFixed(1)}×）。`,
    `动态与静态的截止违约分别为 ${dynamic.metrics.deadlineMisses} 与 ${staticArm.metrics.deadlineMisses}，` +
      `串行为 ${serial.metrics.deadlineMisses}；绝对违约数受固定截止时刻影响，只看相对差。`
  ].join("\n\n");
}

function renderReport(arms: ArmResult[], replay: Record<string, ReturnType<typeof replaySchedule>["metrics"]>) {
  const lines = [
    "# 调度验收：动态优先级 vs 静态 FIFO vs 串行",
    "",
    `- 用例数：${CASE_COUNT}，每例 ${NODES_PER_CASE} 个 Agent 节点，stub 固定耗时，不消耗 token。`,
    `- 并发容量：动态/静态 ${CAPACITY} 槽；串行 1 槽且逐单提交。`,
    "- 指标口径：记录回放（recorded）基于实际入队/开工/完成时间；跨策略对比另给离线回放。",
    "",
    "## 三条臂",
    "",
    "高优/低优等待按优先级分层 ≥3 与 <3 分别求平均；截止时间在三条臂之间共用同一绝对时刻。",
    "",
    "| 臂 | 容量 | 策略 | 墙钟耗时 | 成功 | 等待 P50 | 等待 P95 | 高优等待 | 低优等待 | 截止违约 | 优先级倒挂 | 利用率 |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const arm of arms) {
    lines.push(
      `| ${arm.name} | ${arm.capacity} | ${arm.policy} | ${arm.wallMs} ms | ${arm.succeeded}/${arm.succeeded + arm.failed} | ` +
        `${arm.metrics.waitP50Ms} ms | ${arm.metrics.waitP95Ms} ms | ${arm.highPriorityWaitMs} ms | ` +
        `${arm.lowPriorityWaitMs} ms | ${arm.metrics.deadlineMisses} | ` +
        `${arm.metrics.priorityInversions} | ${pct(arm.metrics.utilization)} |`
    );
  }
  lines.push(
    "",
    "## 同一批任务离线回放",
    "",
    `把动态臂实际记录的任务集放回 ${CAPACITY} 槽，比较不同出队策略：`,
    "",
    "| 策略 | 完工跨度 | 等待 P50 | 等待 P95 | 截止违约 | 优先级倒挂 | 利用率 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const [policy, metrics] of Object.entries(replay)) {
    lines.push(
      `| ${policy} | ${metrics.makespanMs} ms | ${metrics.waitP50Ms} ms | ${metrics.waitP95Ms} ms | ` +
        `${metrics.deadlineMisses} | ${metrics.priorityInversions} | ${pct(metrics.utilization)} |`
    );
  }
  lines.push(
    "",
    "## 观察",
    "",
    observationOf(arms),
    "",
    "## 边界",
    "",
    "- 这是 stub + 固定 sleep 的调度吞吐实验，只证明排队与并发行为，不证明模型回答质量。",
    "- 串行臂同时限制为 1 槽并逐单提交，衡量的是“完全不重叠”的基线；真实串行 Agent 还会叠加模型延迟。",
    "- 离线回放复用实际耗时，不含网络抖动与模型方差；结论以趋势和相对差为准。",
    ""
  );
  return lines.join("\n");
}

async function main() {
  mkdirSync(resultsDir, { recursive: true });
  const cases = buildCases(CASE_COUNT);
  console.log(`调度验收：${cases.length} 个用例，容量 ${CAPACITY}，stub 执行。`);

  const dynamic = await runArm("dynamic", cases, {
    policy: "dynamic",
    capacity: CAPACITY,
    serial: false
  });
  const staticArm = await runArm("static", cases, {
    policy: "static",
    capacity: CAPACITY,
    serial: false
  });
  const serial = await runArm("serial", cases, {
    policy: "dynamic",
    capacity: 1,
    serial: true
  });

  const compared = compareReplayPolicies(dynamic.tasks, { capacity: CAPACITY });
  const replayMetrics = Object.fromEntries(
    Object.entries(compared).map(([policy, result]) => [policy, result.metrics])
  );
  const report = renderReport(
    [dynamic.result, staticArm.result, serial.result],
    replayMetrics
  );
  const json = {
    generatedAt: new Date().toISOString(),
    cases: cases.length,
    nodesPerCase: NODES_PER_CASE,
    capacity: CAPACITY,
    arms: [dynamic.result, staticArm.result, serial.result],
    replay: replayMetrics,
    boundary: "stub 固定 sleep；只说明排队与并发行为，不代表模型质量。"
  };
  const base = path.join(resultsDir, `scheduler-arms-${stamp}`);
  writeFileSync(`${base}.json`, JSON.stringify(json, null, 2));
  writeFileSync(`${base}.md`, report);
  writeFileSync(path.join(resultsDir, "scheduler-arms-latest.json"), JSON.stringify(json, null, 2));
  writeFileSync(path.join(resultsDir, "scheduler-arms-latest.md"), report);
  console.log(report);
  console.log(`报告：${base}.md`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
