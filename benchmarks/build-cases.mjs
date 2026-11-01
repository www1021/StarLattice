#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tasksPath = path.join(root, "data", "eval", "tasks.json");
const configPath = path.join(here, "promptfoo", "promptfooconfig.yaml");

const dataset = JSON.parse(readFileSync(tasksPath, "utf8"));
const tasks = Array.isArray(dataset.tasks) ? dataset.tasks : [];
validate(tasks);

const providers = [
  {
    label: "A-单Agent",
    workflows: {
      education: "bench-single-agent",
      topic: "bench-topic-single-agent"
    }
  },
  {
    label: "B-固定流水线",
    workflows: {
      education: "bench-fixed-pipeline",
      topic: "bench-topic-fixed-pipeline"
    }
  },
  {
    label: "C-完整平台",
    workflows: {
      education: "bench-full-platform",
      topic: "bench-topic-full-platform"
    }
  }
];

const lines = [
  "# 由 benchmarks/build-cases.mjs 从 data/eval/tasks.json 生成，请勿手工编辑。",
  `description: ${q("易师训 Agent 编排平台 · 单 Agent / 固定流水线 / 完整平台三基线对比（30 用例：教育 20 + 选题 10）")}`,
  "",
  "prompts:",
  `  - ${q("{{taskId}}")}`,
  "",
  "providers:"
];
for (const provider of providers) {
  lines.push("  - id: file://provider.mjs");
  lines.push(`    label: ${q(provider.label)}`);
  lines.push("    config:");
  lines.push("      threshold: 0.85");
  lines.push("      workflowIds:");
  for (const scenario of ["education", "topic"]) {
    lines.push(`        ${scenario}: ${q(provider.workflows[scenario])}`);
  }
}

lines.push(
  "",
  "defaultTest:",
  "  assert:",
  "    - type: javascript",
  "      value: |",
  "        const result = JSON.parse(output);",
  "        return result.success === true && result.verifyPassed !== false;",
  "",
  "tests:"
);

for (const task of tasks) {
  lines.push("  - vars:");
  lines.push(`      taskId: ${q(task.id)}`);
  lines.push(`      scenario: ${q(task.scenario)}`);
  lines.push(`      difficulty: ${q(task.difficulty)}`);
  lines.push(`      category: ${q(task.category)}`);
  for (const [key, value] of Object.entries(task.vars)) {
    lines.push(`      ${key}: ${q(value)}`);
  }
}

writeFileSync(configPath, `${lines.join("\n")}\n`);

const byScenario = groupCount(tasks, (task) => task.scenario);
const byDifficulty = groupCount(tasks, (task) => task.difficulty);
const byCategory = groupCount(tasks, (task) => `${task.scenario}/${task.category}`);
console.log(`评测集已生成：${tasks.length} 条 · ${configPath}`);
console.log(`场景：${format(byScenario)}`);
console.log(`难度：${format(byDifficulty)}`);
console.log(`类型：${format(byCategory)}`);

function validate(list) {
  if (list.length === 0) {
    throw new Error("tasks.json 中没有任务");
  }
  const ids = new Set();
  const scenarioCounts = new Map();
  const thresholds = new Set();
  for (const task of list) {
    if (!task.id || ids.has(task.id)) {
      throw new Error(`任务 id 缺失或重复：${task.id ?? "(empty)"}`);
    }
    ids.add(task.id);
    if (task.scenario !== "education" && task.scenario !== "topic") {
      throw new Error(`${task.id} 的 scenario 必须是 education 或 topic`);
    }
    if (!["easy", "medium", "hard"].includes(task.difficulty)) {
      throw new Error(`${task.id} 的 difficulty 必须是 easy/medium/hard`);
    }
    if (!task.category) {
      throw new Error(`${task.id} 缺少 category`);
    }
    if (!Array.isArray(task.expectedPoints) || task.expectedPoints.length === 0) {
      throw new Error(`${task.id} 缺少 expectedPoints`);
    }
    if (!Array.isArray(task.rubric) || task.rubric.length === 0) {
      throw new Error(`${task.id} 缺少 rubric`);
    }
    if (typeof task.threshold !== "number" || task.threshold < 0 || task.threshold > 1) {
      throw new Error(`${task.id} 的 threshold 必须是 0-1 数字`);
    }
    if (!task.vars || typeof task.vars !== "object") {
      throw new Error(`${task.id} 缺少 vars`);
    }
    scenarioCounts.set(task.scenario, (scenarioCounts.get(task.scenario) ?? 0) + 1);
    thresholds.add(task.threshold);
  }
  if ((scenarioCounts.get("education") ?? 0) !== 20) {
    throw new Error(`教育场景任务应为 20 条，当前 ${scenarioCounts.get("education") ?? 0} 条`);
  }
  if ((scenarioCounts.get("topic") ?? 0) !== 10) {
    throw new Error(`选题场景任务应为 10 条，当前 ${scenarioCounts.get("topic") ?? 0} 条`);
  }
  if (thresholds.size !== 1) {
    throw new Error(`当前 promptfoo 只支持统一阈值，发现 ${[...thresholds].join(", ")}`);
  }
}

function q(value) {
  return JSON.stringify(String(value));
}

function groupCount(list, keyOf) {
  const counts = new Map();
  for (const item of list) {
    const key = keyOf(item);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function format(counts) {
  return [...counts.entries()].map(([key, value]) => `${key} ${value}`).join(" · ");
}
