#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractRows, summarize } from "./summary.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const resultsDir = path.join(here, "results");
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("用法：node benchmarks/merge-results.mjs <分片结果.json>...");
  process.exit(1);
}

const dataset = JSON.parse(readFileSync(path.join(root, "data", "eval", "tasks.json"), "utf8"));
const expectedTaskIds = new Set(dataset.tasks.map((task) => task.id));
const expectedLabels = new Set(["A-单Agent", "B-固定流水线", "C-完整平台"]);
const rows = [];
const seen = new Set();

for (const file of files) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const list = extractRows(raw);
  if (list.length === 0) {
    throw new Error(`${file} 中没有评测结果`);
  }
  for (const row of list) {
    const label = row.provider?.label || row.provider?.id || row.providerId || "unknown";
    const payload = parseOutput(row);
    const taskId = payload.taskId;
    if (!taskId) {
      throw new Error(`${file} 存在缺少 taskId 的结果，拒绝合并`);
    }
    const key = `${label}|${taskId}`;
    if (seen.has(key)) {
      throw new Error(`分片结果重复：${key}`);
    }
    seen.add(key);
    rows.push(row);
  }
}

const seenTasks = new Set(
  rows.map((row) => parseOutput(row).taskId).filter(Boolean)
);
const missingTasks = [...expectedTaskIds].filter((taskId) => !seenTasks.has(taskId));
if (missingTasks.length > 0) {
  throw new Error(`分片结果缺少用例：${missingTasks.join("、")}`);
}
const missingPairs = [];
for (const taskId of expectedTaskIds) {
  for (const label of expectedLabels) {
    if (!seen.has(`${label}|${taskId}`)) {
      missingPairs.push(`${label}/${taskId}`);
    }
  }
}
if (missingPairs.length > 0) {
  throw new Error(`分片结果缺少基线运行：${missingPairs.slice(0, 10).join("、")}`);
}
const extraTasks = [...seenTasks].filter((taskId) => !expectedTaskIds.has(taskId));
if (extraTasks.length > 0) {
  throw new Error(`分片结果包含未知用例：${extraTasks.join("、")}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const startedAt = Number(process.env.BENCH_SUITE_STARTED_AT || Date.now());
const meta = {
  startedAt,
  baseUrl: (process.env.BENCH_BASE_URL || "http://127.0.0.1:8790").replace(/\/$/, ""),
  external: process.env.BENCH_EXTERNAL === "1"
};
const summary = summarize({ results: { results: rows } }, meta);
mkdirSync(resultsDir, { recursive: true });
const jsonPath = path.join(resultsDir, `bench-merged-${stamp}.json`);
const mdPath = path.join(resultsDir, `bench-merged-${stamp}.md`);
const csvPath = path.join(resultsDir, `bench-merged-${stamp}.csv`);
writeFileSync(jsonPath, JSON.stringify({ results: { results: rows } }, null, 2));
writeFileSync(mdPath, summary.markdown);
writeFileSync(csvPath, summary.csv);
writeFileSync(path.join(resultsDir, "latest.md"), summary.markdown);
writeFileSync(path.join(resultsDir, "latest.csv"), summary.csv);
console.log(summary.markdown);
console.log(`合并报告：${mdPath}`);
console.log(`合并 CSV：${csvPath}`);
console.log(`合并 JSON：${jsonPath}`);

function parseOutput(row) {
  const output = row.response?.output ?? row.output ?? "";
  try {
    return typeof output === "string" ? JSON.parse(output) : output ?? {};
  } catch {
    return {};
  }
}
