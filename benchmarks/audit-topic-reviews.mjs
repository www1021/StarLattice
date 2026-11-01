#!/usr/bin/env node
import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, "results");
const taskFile = path.join(here, "..", "data", "eval", "tasks.json");
const taskCategories = new Map();
const taskPayload = JSON.parse(readFileSync(taskFile, "utf8"));
const taskList = Array.isArray(taskPayload) ? taskPayload : taskPayload.tasks ?? [];
for (const task of taskList) {
  taskCategories.set(task.id, task.category ?? "unknown");
}
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("用法：node benchmarks/audit-topic-reviews.mjs <platform-*.db>...");
  process.exit(1);
}

const records = [];
for (const file of files) {
  const db = new Database(file, { readonly: true });
  const runs = db
    .prepare(
      "select id, workflow_id, input, started_at from platform_runs where workflow_id like 'bench-topic-%' and status = 'succeeded'"
    )
    .all();
  for (const run of runs) {
    const input = parseJson(run.input, {});
    const steps = db
      .prepare("select node_id, node_kind, path, output from platform_run_steps where run_id = ? order by sequence")
      .all(run.id);
    const agents = steps
      .filter((step) => step.node_kind === "agent")
      .map((step) => ({ ...step, text: textOf(parseJson(step.output, step.output)) }))
      .filter((step) => step.text.length > 0);
    if (agents.length === 0) {
      continue;
    }
    const main = agents.reduce((best, step) => (step.text.length > best.text.length ? step : best), agents[0]);
    const verify = db
      .prepare("select score, confidence, dimensions, detail from platform_verify_results where run_id = ? order by created_at desc limit 1")
      .get(run.id);
    const detail = parseJson(verify?.detail, {});
    const verifiers = detail?.layers?.crossCheck?.verifiers ?? [];
    const verifierScores = verifiers
      .map((item) => item.score)
      .filter((score) => typeof score === "number" && Number.isFinite(score));
    const ruleChecks = detail?.layers?.rule?.checks ?? [];
    const placeholderHit = ruleChecks.some((check) => check.key === "placeholder" && check.passed === false);
    const dimensions = parseJson(verify?.dimensions, []);
    const taskId = input.taskId ?? "unknown";
    records.push({
      taskId,
      category: taskCategories.get(taskId) ?? "unknown",
      baseline: baselineOf(run.workflow_id),
      startedAt: Number(run.started_at) || 0,
      path: main.path,
      chars: main.text.length,
      score: numberOrNull(verify?.score),
      confidence: numberOrNull(verify?.confidence),
      spread:
        verifierScores.length >= 2 ? round4(Math.max(...verifierScores) - Math.min(...verifierScores)) : null,
      dimSpread:
        Array.isArray(dimensions) && dimensions.length >= 2
          ? round4(
              Math.max(...dimensions.map((item) => item.score)) -
                Math.min(...dimensions.map((item) => item.score))
            )
          : null,
      coverage: coverageOf(main.text),
      citations: (main.text.match(/依据|来源|引用|证据|文献|\[[0-9]+\]/g) ?? []).length,
      actions: (main.text.match(/补充|修改|增加|替换|删除|改为|细化|明确/g) ?? []).length,
      placeholderHit
    });
  }
  db.close();
}

if (records.length === 0) {
  console.error("没有找到选题运行记录");
  process.exit(1);
}

// 同一 用例 × 基线 若运行过多次（烟测/重跑），只保留最后一次，避免重复计入统计。
const latest = new Map();
for (const item of records) {
  const key = `${item.taskId}|${item.baseline}`;
  const previous = latest.get(key);
  if (!previous || item.startedAt >= previous.startedAt) {
    latest.set(key, item);
  }
}
const deduped = [...latest.values()];
if (deduped.length !== records.length) {
  console.log(`去重：${records.length} → ${deduped.length} 条（同用例同基线保留最后一次）`);
}
records.length = 0;
records.push(...deduped);

const baselines = ["A", "B", "C"];
const lines = [
  "# 选题评审可靠性审计",
  "",
  `- 生成时间：${new Date().toISOString()}`,
  `- 样本：${records.length} 份评审产物（${files.length} 个运行库）`,
  "- 口径：结构完整度、双验证器分歧、规则层占位误伤，均由脚本计算，不依赖人工标注。",
  "",
  "## 基线 × 可靠性",
  "",
  "| 基线 | 样本 | 平均验证分 | 平均置信度 | 平均验证器分歧 | 分歧>0.15 | 占位误伤 | 平均字数 | 平均引用 | 平均行动项 |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
];
for (const baseline of baselines) {
  const rows = records.filter((item) => item.baseline === baseline);
  if (rows.length === 0) {
    continue;
  }
  const scores = rows.map((item) => item.score).filter((value) => value !== null);
  const confidences = rows.map((item) => item.confidence).filter((value) => value !== null);
  const spreads = rows.map((item) => item.spread).filter((value) => value !== null);
  lines.push(
    `| ${baseline} | ${rows.length} | ${mean(scores)} | ${mean(confidences)} | ${mean(spreads)} | ${spreads.filter((value) => value > 0.15).length}/${spreads.length} | ${rows.filter((item) => item.placeholderHit).length}/${rows.length} | ${Math.round(mean(rows.map((item) => item.chars)) ?? 0)} | ${Math.round(mean(rows.map((item) => item.citations)) ?? 0)} | ${Math.round(mean(rows.map((item) => item.actions)) ?? 0)} |`
  );
}

lines.push("", "## 结构覆盖 × 验证分", "", "| 覆盖项数 | 样本 | 平均验证分 |", "| ---: | ---: | ---: |");
for (const coverage of [4, 3, 2, 1, 0]) {
  const rows = records.filter((item) => item.coverage === coverage);
  if (rows.length === 0) {
    continue;
  }
  lines.push(`| ${coverage} | ${rows.length} | ${mean(rows.map((item) => item.score).filter((value) => value !== null))} |`);
}

lines.push(
  "",
  "## 与设计标签的关系",
  "",
  "用例 `category` 描述的是选题本身的缺陷类型，而专用验证器评估的是评审报告质量：选题有缺陷但报告把缺陷讲清楚，报告质量仍然高。两者不是同一个目标，因此本审计不把 `category` 当校准标签，验证器的方向性改由缺陷注入实验检验（`benchmarks/results/verify-sensitivity-latest.md`）。",
  "",
  "## 逐样本",
  ""
);
lines.push("| 用例 | 基线 | 产物节点 | 字数 | 覆盖 | 引用 | 行动项 | 分歧 | 置信度 | 验证分 | 占位误伤 |");
lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
for (const item of records.sort(
  (left, right) => left.taskId.localeCompare(right.taskId) || left.baseline.localeCompare(right.baseline)
)) {
  lines.push(
    `| ${item.taskId} | ${item.baseline} | ${item.path} | ${item.chars} | ${item.coverage}/4 | ${item.citations} | ${item.actions} | ${item.spread === null ? "—" : item.spread.toFixed(3)} | ${item.confidence === null ? "—" : item.confidence.toFixed(3)} | ${item.score === null ? "—" : item.score.toFixed(3)} | ${item.placeholderHit ? "是" : ""} |`
  );
}
const markdown = lines.join("\n") + "\n";
mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(path.join(resultsDir, `audit-topic-${stamp}.md`), markdown);
writeFileSync(path.join(resultsDir, "audit-topic-latest.md"), markdown);
console.log(markdown);

function coverageOf(text) {
  const checks = [
    /创新/.test(text),
    /可行性|数据|方法成熟度|时间|资源/.test(text),
    /规范性|伦理|引用|表述/.test(text),
    /建议开题|不建议开题|总体结论|结论/.test(text)
  ];
  return checks.filter(Boolean).length;
}

function baselineOf(workflowId) {
  if (workflowId.endsWith("single-agent")) {
    return "A";
  }
  if (workflowId.endsWith("fixed-pipeline")) {
    return "B";
  }
  return "C";
}

function textOf(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object") {
    // summary 是截断预览，优先取 output/content 全文。
    const candidates = [payload.output, payload.content, payload.text, payload.summary].filter(
      (value) => typeof value === "string"
    );
    return candidates.reduce((longest, value) => (value.length > longest.length ? value : longest), "");
  }
  return "";
}

function parseJson(value, fallback) {
  if (typeof value !== "string") {
    return value ?? fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function mean(values) {
  const list = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  return list.length === 0 ? null : round4(list.reduce((sum, value) => sum + value, 0) / list.length);
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
}
