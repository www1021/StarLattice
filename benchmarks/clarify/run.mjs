#!/usr/bin/env node
/**
 * 意图澄清 A/B：同一模糊需求，对照组直接执行，实验组先澄清再执行。
 *
 * - 澄清答案由脚本按预设规格注入（actor 标注为脚本模拟，非真人）。
 * - 达标与质量用固定裁判（benchmarks/judge.mjs），不看平台自验分。
 * - 规格覆盖为确定性关键词检查：原始需求已给出的槽位单独统计，避免把“本来就说了”算成澄清收益。
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JUDGE_VERSION, extractArtifact, judgeArtifact } from "../judge.mjs";
import { knowledgeDocumentNames } from "../knowledge-names.mjs";
import { assertWorkflowDag } from "../workflow-dag.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const port = Number(process.env.CLARIFY_PORT || 8794);
const baseUrl = (process.env.CLARIFY_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, "");
const external = Boolean(process.env.CLARIFY_BASE_URL);
const concurrency = Math.max(1, Math.trunc(Number(process.env.CLARIFY_CONCURRENCY || 3)));
const limit = Math.max(0, Math.trunc(Number(process.env.CLARIFY_LIMIT || 0)));
const runTimeoutMs = Number(process.env.CLARIFY_RUN_TIMEOUT_MS || 900_000);
const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-p${port}`;
const resultsDir = path.join(root, "benchmarks", "results");
const tmpDir = path.join(root, "benchmarks", ".tmp");
const jsonPath = path.join(resultsDir, `clarify-ab-${stamp}.json`);
const mdPath = path.join(resultsDir, `clarify-ab-${stamp}.md`);
mkdirSync(resultsDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

const SLOT_QUESTION_WORDS = {
  topic: ["课题", "主题", "内容", "哪一课", "哪个"],
  subject: ["学科", "科目"],
  grade: ["年级", "学段"],
  duration: ["课时", "时长", "分钟", "多久"],
  method: ["活动", "形式", "方式", "练习", "互动"]
};

const selectedIds = new Set(
  (process.env.CLARIFY_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);
const allCases = JSON.parse(readFileSync(path.join(here, "fuzzy-cases.json"), "utf8")).cases;
const cases = allCases
  .filter((item) => selectedIds.size === 0 || selectedIds.has(item.id))
  .slice(0, limit > 0 ? limit : undefined);

let server;
let serverLog = "";
let shuttingDown = false;
const startedAt = Date.now();

try {
  if (!external) {
    await ensurePortFree();
    server = startServer();
  }
  await waitForHealth(baseUrl, 60_000);
  await seedWorkflows(baseUrl);
  const knowledgeBaseIds = await seedKnowledge(baseUrl);

  const tasks = cases.flatMap((item) => [
    { item, arm: "on", workflowId: "bench-clarify-on" },
    { item, arm: "off", workflowId: "bench-clarify-off" }
  ]);
  const rows = await runPool(tasks, concurrency, (task) => runOne(task, knowledgeBaseIds));
  const finishedAt = Date.now();
  const report = summarize(rows, { startedAt, finishedAt, concurrency });
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, report.markdown);
  writeFileSync(path.join(resultsDir, "clarify-ab-latest.md"), report.markdown);
  writeFileSync(path.join(resultsDir, "clarify-ab-latest.json"), JSON.stringify(report, null, 2));
  console.log(`\n${report.markdown}`);
  console.log(`\n报告：${mdPath}`);
} catch (error) {
  if (serverLog && server?.exitCode !== null) {
    console.error("\n--- server log ---\n" + serverLog.slice(-4000));
  }
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
} finally {
  if (server) {
    shuttingDown = true;
    server.kill("SIGTERM");
  }
}

function startServer() {
  const tsx = path.join(root, "node_modules", ".bin", "tsx");
  const child = spawn(tsx, ["server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      PLATFORM_DB_PATH: path.join(tmpDir, `clarify-platform-${stamp}.db`),
      TRAINING_DB_PATH: path.join(tmpDir, `clarify-training-${stamp}.db`),
      KNOWLEDGE_DB_PATH: path.join(tmpDir, `clarify-knowledge-${stamp}.db`),
      PLATFORM_STUB_DELAY_MS: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    serverLog += chunk.toString();
  });
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`澄清实验服务提前退出，code=${code}`);
    }
  });
  return child;
}

async function runPool(tasks, size, worker) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await worker(tasks[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runOne({ item, arm, workflowId }, knowledgeBaseIds) {
  const task = {
    scenario: "education",
    expectedPoints: item.expectedPoints,
    relevantDocs: item.relevantDocs,
    threshold: 0.85
  };
  const started = Date.now();
  const input = {
    request: item.prompt,
    knowledgeBaseIds,
    scenario: "education",
    taskId: item.id
  };
  let run;
  let trace = { steps: [], interactions: [] };
  let interactionQuestions = [];
  let answered = false;
  let error = null;
  try {
    const created = await fetch(`${baseUrl}/api/platform/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, input, async: true })
    });
    if (!created.ok) {
      throw new Error(`创建运行失败 HTTP ${created.status}：${await safeText(created)}`);
    }
    const { run: createdRun } = await created.json();
    run = await waitForRun(createdRun.id, async () => {
      const pending = await pendingInteractions(createdRun.id);
      for (const interaction of pending) {
        interactionQuestions = questionsFromPrompt(interaction.prompt);
        answered = true;
        await respondInteraction(interaction.id, item.answer);
      }
    });
    trace = await safeJson(await fetch(`${baseUrl}/api/platform/runs/${run.id}/trace`));
    interactionQuestions =
      interactionQuestions.length > 0
        ? interactionQuestions
        : questionsFromPrompt(
            (trace.interactions ?? []).find((item2) => item2.prompt)?.prompt ?? ""
          );
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const latencyMs = Date.now() - started;
  const artifact = extractArtifact(trace);
  const judge = judgeArtifact(task, artifact.text, { mode: process.env.BENCH_JUDGE_MODE || "rules" });
  const slotChecks = item.slots.map((slot) => {
    const given = matchesAny(item.prompt, slot.keywords);
    const covered = matchesAny(artifact.text, slot.keywords);
    const asked = matchesAny(
      interactionQuestions.join("\n"),
      SLOT_QUESTION_WORDS[slot.id] ?? slot.keywords
    );
    return { id: slot.id, label: slot.label, given, covered, asked };
  });
  const clarifyStep = (trace.steps ?? []).find((step) => step.nodeId === "clarify");
  const outcome =
    clarifyStep && clarifyStep.output && typeof clarifyStep.output === "object"
      ? clarifyStep.output
      : null;
  return {
    caseId: item.id,
    arm,
    workflowId,
    prompt: item.prompt,
    answer: item.answer,
    runId: run?.id ?? null,
    status: run?.status ?? "failed",
    error,
    latencyMs,
    tokens: tokensOf(trace, run),
    steps: (trace.steps ?? []).length,
    paused: answered,
    questions: interactionQuestions,
    rewrittenPrompt:
      outcome && typeof outcome.rewrittenPrompt === "string" ? outcome.rewrittenPrompt : null,
    artifactChars: [...artifact.text].length,
    judgeScore: Number(judge.evalScore ?? 0),
    judgePassed: judge.evalPassed === true,
    judgeFailures: judge.hardRules ?? [],
    slots: slotChecks
  };
}

async function waitForRun(runId, onWaiting) {
  const deadline = Date.now() + runTimeoutMs;
  let last;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/platform/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) {
      throw new Error(`查询运行失败 HTTP ${response.status}`);
    }
    last = (await response.json()).run;
    if (last.status === "waiting_input") {
      await onWaiting();
      await sleep(300);
      continue;
    }
    if (!["queued", "running", "verifying", "revising"].includes(last.status)) {
      return last;
    }
    await sleep(500);
  }
  return { ...last, status: "failed", error: `超时：${runTimeoutMs}ms 内未结束` };
}

async function pendingInteractions(runId) {
  const response = await fetch(
    `${baseUrl}/api/platform/interactions?runId=${encodeURIComponent(runId)}&status=pending`
  );
  if (!response.ok) return [];
  const payload = await safeJson(response);
  return Array.isArray(payload.interactions) ? payload.interactions : [];
}

async function respondInteraction(id, answer) {
  const response = await fetch(`${baseUrl}/api/platform/interactions/${encodeURIComponent(id)}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      values: { answer },
      actor: "clarify-ab-scripted-user"
    })
  });
  if (!response.ok) {
    throw new Error(`回答澄清失败 HTTP ${response.status}：${await safeText(response)}`);
  }
}

function tokensOf(trace, run) {
  const steps = Array.isArray(trace?.steps) ? trace.steps : [];
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const used = steps[index]?.output?.tokensUsed;
    if (typeof used === "number" && Number.isFinite(used)) return used;
  }
  const fromRun = run?.output?.tokensUsed;
  return typeof fromRun === "number" && Number.isFinite(fromRun) ? fromRun : 0;
}

function questionsFromPrompt(prompt) {  if (typeof prompt !== "string" || prompt.trim() === "") return [];
  return prompt
    .split("\n")
    .map((line) => line.replace(/^\s*\d+[.、)]\s*/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("以下信息") && !line.startsWith("可直接回答"));
}

function matchesAny(text, keywords) {
  const value = String(text ?? "").replace(/\s+/g, "");
  return (keywords ?? []).some((keyword) => {
    const needle = String(keyword).replace(/\s+/g, "");
    return needle !== "" && value.includes(needle);
  });
}

function summarize(list, meta) {
  const arms = ["off", "on"];
  const byArm = Object.fromEntries(
    arms.map((arm) => {
      const rows = list.filter((row) => row.arm === arm);
      return [arm, aggregate(rows)];
    })
  );
  const pairs = cases
    .map((item) => {
      const off = list.find((row) => row.caseId === item.id && row.arm === "off");
      const on = list.find((row) => row.caseId === item.id && row.arm === "on");
      if (!off || !on || off.status === "failed" || on.status === "failed") return null;
      return { caseId: item.id, off, on };
    })
    .filter(Boolean);
  const judgeDelta = average(pairs.map((pair) => pair.on.judgeScore - pair.off.judgeScore));
  const missingDelta = average(
    pairs.map((pair) => missingCoverage(pair.on) - missingCoverage(pair.off))
  );
  const judgeCi = bootstrapCi(pairs.map((pair) => pair.on.judgeScore - pair.off.judgeScore), 0.95);
  const missingCi = bootstrapCi(
    pairs.map((pair) => missingCoverage(pair.on) - missingCoverage(pair.off)),
    0.95
  );

  const lines = [];
  lines.push("# 意图澄清 A/B 报告");
  lines.push("");
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 服务地址：${baseUrl}（隔离临时库）`);
  lines.push(`- 用例数：${cases.length}（每臂 ${cases.length} 次，总运行 ${list.length} 次，并发 ${meta.concurrency}）`);
  lines.push(`- 墙钟耗时：${meta.finishedAt - meta.startedAt}ms`);
  lines.push(`- 固定裁判：${JUDGE_VERSION}`);
  lines.push("- 对照组：模糊需求直接进入检索 / 生成 / 整理；实验组：先澄清、经脚本注入补充后改写需求，再进入相同链路。");
  lines.push("- 澄清答案由脚本按预设规格注入（actor=`clarify-ab-scripted-user`），不是真人回答；也不存在人工评分。");
  lines.push("- 规格覆盖是确定性关键词检查；原始需求已写明的槽位单独统计，不把“本来就说了”算成澄清收益。");
  lines.push("");
  lines.push("## 总览");
  lines.push("");
  lines.push("| 臂 | 运行数 | 成功率 | 裁判达标率 | 平均裁判分 | 平均 Tokens | P50 延迟 | 平均步骤 | 触发澄清 | 平均缺失槽位覆盖 |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const arm of arms) {
    const item = byArm[arm];
    lines.push(
      `| ${arm === "on" ? "实验组-先澄清" : "对照组-直接执行"} | ${item.n} | ${pct(item.successRate)} | ${pct(item.judgeRate)} | ${item.judgeAvg.toFixed(3)} | ${Math.round(item.tokensAvg)} | ${ms(item.p50)} | ${item.stepsAvg.toFixed(1)} | ${pct(item.pausedRate)} | ${pct(item.missingCoverage)} |`
    );
  }
  lines.push("");
  lines.push("## 配对差值");
  lines.push("");
  lines.push(`- 可配对用例：${pairs.length}`);
  lines.push(`- 裁判分：实验组 − 对照组 = ${signed(judgeDelta)}（95% CI [${signed(judgeCi[0])}, ${signed(judgeCi[1])}]）`);
  lines.push(
    `- 缺失槽位覆盖率：实验组 − 对照组 = ${signed(missingDelta * 100)}pp（95% CI [${signed(missingCi[0] * 100)}, ${signed(missingCi[1] * 100)}]pp）`
  );
  const wins = pairs.filter((pair) => pair.on.judgeScore > pair.off.judgeScore + 1e-9).length;
  const losses = pairs.filter((pair) => pair.on.judgeScore < pair.off.judgeScore - 1e-9).length;
  lines.push(`- 裁判分胜负：实验组胜 ${wins} / 负 ${losses} / 平 ${pairs.length - wins - losses}`);
  lines.push("");
  lines.push("## 澄清行为");
  lines.push("");
  const onRows = list.filter((row) => row.arm === "on");
  const paused = onRows.filter((row) => row.paused);
  lines.push(`- 触发暂停追问：${paused.length}/${onRows.length}`);
  const askedSlots = onRows.flatMap((row) => row.slots.filter((slot) => !slot.given && slot.asked));
  const missingSlots = onRows.flatMap((row) => row.slots.filter((slot) => !slot.given));
  lines.push(
    `- 缺失槽位被追问的召回率：${pct(ratio(askedSlots.length, missingSlots.length))}（${askedSlots.length}/${missingSlots.length}）`
  );
  const coverageBySlot = {};
  for (const row of onRows) {
    for (const slot of row.slots) {
      if (slot.given) continue;
      coverageBySlot[slot.id] ??= { asked: 0, covered: 0, total: 0 };
      coverageBySlot[slot.id].total += 1;
      coverageBySlot[slot.id].asked += slot.asked ? 1 : 0;
      coverageBySlot[slot.id].covered += slot.covered ? 1 : 0;
    }
  }
  lines.push("");
  lines.push("| 缺失槽位 | 出现次数 | 被追问率 | 进入最终产物率 |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const [id, value] of Object.entries(coverageBySlot)) {
    lines.push(`| ${id} | ${value.total} | ${pct(ratio(value.asked, value.total))} | ${pct(ratio(value.covered, value.total))} |`);
  }
  lines.push("");
  lines.push("## 边界");
  lines.push("");
  lines.push("- 补充答案来自预设规格，实验衡量的是“澄清与改写链路能否把已知规格带进产物”，不等于真实用户回答的质量。");
  lines.push("- 两组共用 finalize / deliverable / report 三个节点；差异只有澄清节点、改写后的检索查询与教案生成输入，以及“按最佳判断补齐”对“严格按给定规格”的指令；交付契约（小节、引用、篇幅）完全相同。");
  lines.push(`- 用例只有 ${cases.length} 个模糊教学需求，结论不外推到所有任务类型；对照组没有机会追问，差异上限由缺失槽位数量决定。`);
  lines.push("- 裁判仍是固定规则裁判，只看结构、引用、篇幅与预设要点覆盖，不判断教学语义优劣。");
  return {
    meta: { ...meta, judgeVersion: JUDGE_VERSION, baseUrl, cases: cases.length },
    arms: byArm,
    pairs: pairs.map(({ caseId, off, on }) => ({
      caseId,
      judgeDelta: on.judgeScore - off.judgeScore,
      missingCoverageDelta: missingCoverage(on) - missingCoverage(off),
      offPaused: off.paused,
      onPaused: on.paused
    })),
    judgeDelta,
    judgeCi,
    missingCoverageDelta: missingDelta,
    missingCoverageCi: missingCi,
    rows: list,
    markdown: lines.join("\n")
  };
}

function aggregate(rows) {
  const n = rows.length;
  const ok = rows.filter((row) => row.status === "succeeded");
  const scored = ok.filter((row) => Number.isFinite(row.judgeScore));
  const missing = ok.flatMap((row) => row.slots.filter((slot) => !slot.given));
  return {
    n,
    successRate: ratio(ok.length, n),
    judgeRate: ratio(scored.filter((row) => row.judgePassed).length, scored.length),
    judgeAvg: average(scored.map((row) => row.judgeScore)),
    tokensAvg: average(rows.map((row) => row.tokens)),
    p50: percentile(rows.map((row) => row.latencyMs), 0.5),
    stepsAvg: average(rows.map((row) => row.steps)),
    pausedRate: ratio(rows.filter((row) => row.paused).length, n),
    missingCoverage: ratio(missing.filter((slot) => slot.covered).length, missing.length)
  };
}

function missingCoverage(row) {
  const missing = row.slots.filter((slot) => !slot.given);
  return ratio(missing.filter((slot) => slot.covered).length, missing.length);
}

async function seedWorkflows(url) {
  const dir = path.join(here, "workflows");
  for (const file of readdirSync(dir).filter((item) => item.endsWith(".json")).sort()) {
    const dsl = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    assertWorkflowDag(dsl, file);
    const response = await fetch(`${url}/api/platform/workflows`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dsl })
    });
    if (!response.ok) {
      throw new Error(`写入工作流 ${dsl.id} 失败：HTTP ${response.status} ${await safeText(response)}`);
    }
  }
}

async function seedKnowledge(url) {
  const dir = path.join(root, "benchmarks", "knowledge");
  const created = await fetch(`${url}/api/knowledge/bases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "澄清实验知识库" })
  });
  if (!created.ok) {
    throw new Error(`创建知识库失败：HTTP ${created.status} ${await safeText(created)}`);
  }
  const { base } = await created.json();
  for (const file of readdirSync(dir).filter((item) => item.endsWith(".md")).sort()) {
    const form = new FormData();
    form.append(
      "file",
      new Blob([readFileSync(path.join(dir, file))], { type: "text/markdown" }),
      knowledgeDocumentNames.get(file) ?? file
    );
    const response = await fetch(`${url}/api/knowledge/bases/${base.id}/documents`, {
      method: "POST",
      body: form
    });
    if (!response.ok) {
      throw new Error(`上传文档 ${file} 失败：HTTP ${response.status} ${await safeText(response)}`);
    }
  }
  return [base.id];
}

async function ensurePortFree() {
  const response = await fetch(`http://127.0.0.1:${port}/api/platform/health`).catch(() => null);
  if (response?.ok) {
    throw new Error(`端口 ${port} 已被占用，请先停止旧服务或改用 CLARIFY_PORT。`);
  }
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/platform/health`);
      if (response.ok) {
        const health = await response.json();
        console.log(`服务就绪：${url} · runtime=${health.runtime?.mode ?? "unknown"}`);
        return;
      }
      lastError = new Error(`health HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(`等待服务就绪超时：${lastError?.message ?? "unknown"}`);
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ratio(part, total) {
  return total > 0 ? part / total : 0;
}

function average(list) {
  return list.length > 0 ? list.reduce((sum, value) => sum + value, 0) / list.length : 0;
}

function percentile(list, p) {
  if (list.length === 0) return 0;
  const sorted = [...list].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}

function bootstrapCi(values, level, iterations = 2000) {
  if (values.length === 0) return [0, 0];
  const random = mulberry32(20261108);
  const means = [];
  for (let index = 0; index < iterations; index += 1) {
    let sum = 0;
    for (let pick = 0; pick < values.length; pick += 1) {
      sum += values[Math.floor(random() * values.length)];
    }
    means.push(sum / values.length);
  }
  means.sort((left, right) => left - right);
  const alpha = (1 - level) / 2;
  return [
    means[Math.floor(alpha * means.length)],
    means[Math.min(means.length - 1, Math.floor((1 - alpha) * means.length))]
  ];
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function ms(value) {
  return `${Math.round(value)}ms`;
}

function signed(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}
