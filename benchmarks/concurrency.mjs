#!/usr/bin/env node
import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedKnowledge, seedWorkflows, startBenchEnv, waitForHealth } from "./lib/harness.mjs";

const ACTIVE_STATUSES = new Set(["queued", "running", "verifying", "revising"]);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const resultsDir = path.join(here, "results");
const port = Number(process.env.BENCH_PORT || 8792);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const taskId = process.env.BENCH_CONCURRENCY_TASK || "edu-01";
const levels = (process.env.BENCH_CONCURRENCY || "1,5,20")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const timeoutMs = Number(process.env.BENCH_RUN_TIMEOUT_MS || 900_000);
const threshold = Number(process.env.BENCH_THRESHOLD || 0.85);

if (levels.length === 0) {
  console.error("BENCH_CONCURRENCY 没有有效并发数");
  process.exit(1);
}

const dataset = JSON.parse(readFileSync(path.join(root, "data", "eval", "tasks.json"), "utf8"));
const task = dataset.tasks.find((item) => item.id === taskId) ?? dataset.tasks[0];
const workflowId =
  process.env.BENCH_CONCURRENCY_WORKFLOW ||
  (task.scenario === "topic" ? "bench-topic-full-platform" : "bench-full-platform");
mkdirSync(resultsDir, { recursive: true });

const env = startBenchEnv({ here, port, stamp });
let report = null;
try {
  const health = await waitForHealth(env);
  const mode = health.runtime?.mode ?? "unknown";
  console.log(`平台就绪：${env.baseUrl} · runtime=${mode}`);
  await seedWorkflows(env.baseUrl, here);
  const knowledge = await seedKnowledge(env.baseUrl, here);
  console.log(`知识库就绪：${knowledge.name} · 文档 ${knowledge.documentCount} 篇`);

  const input = {
    ...task.vars,
    taskId: task.id,
    scenario: task.scenario,
    difficulty: task.difficulty,
    category: task.category,
    knowledgeBaseIds: [knowledge.baseId]
  };
  const batches = [];
  for (const level of levels) {
    if (env.isDead()) {
      throw new Error(`基准服务在压测前退出，code=${env.exitCode()}`);
    }
    const startedAt = Date.now();
    const runs = await runBatch(level, input);
    batches.push({ level, runs, elapsedMs: Date.now() - startedAt });
    const summary = statsOf(runs);
    console.log(
      `并发 ${level}：成功 ${pct(summary.successRate)} · 达标 ${pct(summary.passRate)} · P50 ${ms(summary.p50)} · P95 ${ms(summary.p95)} · 错误 ${summary.errors}`
    );
  }
  report = render({ mode, batches, baseUrl: env.baseUrl });
  writeFileSync(path.join(resultsDir, `concurrency-${stamp}.md`), report.markdown);
  writeFileSync(path.join(resultsDir, `concurrency-${stamp}.csv`), report.csv);
  writeFileSync(path.join(resultsDir, `concurrency-${stamp}.json`), JSON.stringify(report.json, null, 2));
  writeFileSync(path.join(resultsDir, "concurrency-latest.md"), report.markdown);
  writeFileSync(path.join(resultsDir, "concurrency-latest.csv"), report.csv);
  console.log(report.markdown);
  console.log(`并发报告：${path.join(resultsDir, `concurrency-${stamp}.md`)}`);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
} finally {
  env.stop();
}

async function runBatch(level, input) {
  const submissions = [];
  for (let index = 0; index < level; index += 1) {
    submissions.push(submitRun(input));
  }
  const submitted = await Promise.all(submissions);
  const deadline = Date.now() + timeoutMs;
  const done = new Map();
  while (done.size < submitted.length && Date.now() < deadline) {
    const pending = submitted.filter((item) => item.id && !done.has(item.id));
    if (pending.length === 0) {
      break;
    }
    await Promise.all(
      pending.map(async (item) => {
        const response = await fetch(`${env.baseUrl}/api/platform/runs/${encodeURIComponent(item.id)}`);
        if (!response.ok) {
          return;
        }
        const { run } = await response.json();
        if (!ACTIVE_STATUSES.has(run.status)) {
          done.set(item.id, { run, finishedAt: Date.now() });
        }
      })
    );
    if (done.size < submitted.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  return submitted.map((item) => {
    if (!item.id) {
      return { ...item, status: "submit_failed", error: item.error ?? "创建运行失败" };
    }
    const finished = done.get(item.id);
    if (!finished) {
      return { ...item, status: "timeout", error: `超过 ${timeoutMs}ms 未结束` };
    }
    return { ...item, ...finished };
  });
}

async function submitRun(input) {
  const submittedAt = Date.now();
  try {
    const response = await fetch(`${env.baseUrl}/api/platform/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, input, async: true })
    });
    if (!response.ok) {
      return { submittedAt, error: `HTTP ${response.status} ${(await response.text()).slice(0, 200)}` };
    }
    const { run } = await response.json();
    return { id: run.id, submittedAt };
  } catch (error) {
    return { submittedAt, error: error instanceof Error ? error.message : String(error) };
  }
}

function statsOf(runs) {
  const scores = runs.map((item) => scoreOf(item.run?.output)).filter((score) => score !== null);
  const passed = runs.filter((item) => {
    const score = scoreOf(item.run?.output);
    return item.run?.status === "succeeded" && score !== null && score >= threshold;
  }).length;
  const succeeded = runs.filter((item) => item.run?.status === "succeeded").length;
  const latencies = runs
    .filter((item) => item.finishedAt)
    .map((item) => item.finishedAt - item.submittedAt)
    .sort((left, right) => left - right);
  const queues = runs
    .filter((item) => item.run?.startedAt)
    .map((item) => Math.max(0, Date.parse(item.run.startedAt) - item.submittedAt))
    .sort((left, right) => left - right);
  const durations = runs
    .map((item) => {
      const reported = Number(item.run?.durationMs ?? 0);
      if (reported > 0) {
        return reported;
      }
      if (item.run?.startedAt && item.finishedAt) {
        return Math.max(0, item.finishedAt - Date.parse(item.run.startedAt));
      }
      return 0;
    })
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const tokens = runs.map((item) => Number(item.run?.output?.tokensUsed ?? 0));
  return {
    n: runs.length,
    successRate: runs.length === 0 ? 0 : succeeded / runs.length,
    passRate: runs.length === 0 ? 0 : passed / runs.length,
    scoreAvg: scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    queueP50: percentile(queues, 0.5),
    queueP95: percentile(queues, 0.95),
    durationP50: percentile(durations, 0.5),
    durationP95: percentile(durations, 0.95),
    tokensAvg: avg(tokens),
    errors: runs.filter((item) => item.error || item.run?.error).length,
    planned: runs.filter((item) => Array.isArray(item.run?.plan?.decisions) && item.run.plan.decisions.length > 0).length
  };
}

function scoreOf(output) {
  if (!output || typeof output !== "object") {
    return null;
  }
  const verify = output.verify;
  if (verify && typeof verify.score === "number") {
    return verify.score;
  }
  return typeof output.score === "number" ? output.score : null;
}

function render({ mode, batches, baseUrl }) {
  const lines = [
    "# 平台并发压测",
    "",
    `- 生成时间：${new Date().toISOString()}`,
    `- 服务地址：${baseUrl}（隔离临时库）`,
    `- 运行模式：${mode}${mode === "stub" ? "（stub 延迟由 PLATFORM_STUB_DELAY_MS 控制，数字只反映平台调度与排队开销）" : ""}`,
    `- 工作流：${workflowId}`,
    `- 用例：${task.id}（${task.scenario} / ${task.difficulty}）`,
    `- 达标线：${threshold}`,
    "",
    "| 并发 | 运行数 | 成功率 | 任务达标率 | 平均验证分 | 端到端 P50 | 端到端 P95 | 排队 P50 | 排队 P95 | 执行 P50 | 执行 P95 | 平均 Tokens | 有调度计划 | 错误 |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  const rows = [];
  for (const batch of batches) {
    const summary = statsOf(batch.runs);
    lines.push(
      `| ${batch.level} | ${summary.n} | ${pct(summary.successRate)} | ${pct(summary.passRate)} | ${num(summary.scoreAvg)} | ${ms(summary.p50)} | ${ms(summary.p95)} | ${ms(summary.queueP50)} | ${ms(summary.queueP95)} | ${ms(summary.durationP50)} | ${ms(summary.durationP95)} | ${Math.round(summary.tokensAvg)} | ${summary.planned}/${summary.n} | ${summary.errors} |`
    );
    rows.push(
      [
        batch.level,
        summary.n,
        summary.successRate.toFixed(3),
        summary.passRate.toFixed(3),
        summary.scoreAvg === null ? "" : summary.scoreAvg.toFixed(3),
        summary.p50,
        summary.p95,
        summary.queueP50,
        summary.queueP95,
        summary.durationP50,
        summary.durationP95,
        Math.round(summary.tokensAvg),
        `${summary.planned}/${summary.n}`,
        summary.errors
      ].join(",")
    );
  }
  const header = "concurrency,runs,success_rate,pass_rate,avg_score,e2e_p50_ms,e2e_p95_ms,queue_p50_ms,queue_p95_ms,exec_p50_ms,exec_p95_ms,avg_tokens,planned,errors";
  const errors = [];
  for (const batch of batches) {
    for (const item of batch.runs) {
      const message = item.error || item.run?.error;
      if (message) {
        errors.push({ level: batch.level, runId: item.id ?? null, status: item.run?.status ?? item.status, message });
      }
    }
  }
  if (errors.length > 0) {
    lines.push("", "## 错误样本", "");
    for (const item of errors.slice(0, 10)) {
      lines.push(`- 并发 ${item.level} / ${item.runId ?? "(未创建)"}：${String(item.message).slice(0, 300)}`);
    }
  }
  lines.push(
    "",
    `说明：${
      mode === "stub"
        ? "本报告为 stub：模型延迟由 PLATFORM_STUB_DELAY_MS 控制，数字只反映平台调度与排队开销，不能代表 live 并发。"
        : "本报告为 live：端到端延迟包含真实模型请求；失败或超时的运行会进入错误样本，不参与成功率与分位数。"
    }调度计划在运行开始时生成，并读取活跃运行的真实租约（activeLeaseLoads）作为在飞负载；租约只影响评分，不阻塞执行。`
  );
  return {
    markdown: lines.join("\n") + "\n",
    csv: [header, ...rows].join("\n") + "\n",
    json: {
      generatedAt: new Date().toISOString(),
      baseUrl,
      mode,
      workflowId,
      taskId: task.id,
      threshold,
      batches: batches.map((batch) => ({ level: batch.level, elapsedMs: batch.elapsedMs, stats: statsOf(batch.runs) }))
    }
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function avg(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function num(value) {
  return value === null ? "—" : value.toFixed(3);
}

function ms(value) {
  return `${Math.round(value)}ms`;
}
