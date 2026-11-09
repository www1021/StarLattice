#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { knowledgeDocumentNames } from "./knowledge-names.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const tasksPath = path.join(root, "data", "eval", "tasks.json");
const configPath = path.join(here, "promptfoo", "promptfooconfig.yaml");

const dataset = JSON.parse(readFileSync(tasksPath, "utf8"));
const allTasks = Array.isArray(dataset.tasks) ? dataset.tasks : [];
validate(allTasks);
const tasks = filterTasks(allTasks);
if (tasks.length === 0) {
  throw new Error(`BENCH_TASK_IDS/BENCH_PATTERN 未匹配任何任务：${process.env.BENCH_TASK_IDS ?? process.env.BENCH_PATTERN}`);
}

const providers = [
  {
    key: "A0",
    label: "A0-历史单Agent",
    workflows: {
      education: "bench-single-agent",
      topic: "bench-topic-single-agent"
    }
  },
  {
    key: "A1",
    label: "A1-公平单Agent",
    workflows: {
      education: "bench-single-agent-fair",
      topic: "bench-topic-single-agent-fair"
    }
  },
  {
    key: "B",
    label: "B-固定流水线",
    workflows: {
      education: "bench-fixed-pipeline",
      topic: "bench-topic-fixed-pipeline"
    }
  },
  {
    key: "C",
    label: "C-完整平台",
    workflows: {
      education: "bench-full-platform",
      topic: "bench-topic-full-platform"
    }
  },
  {
    key: "Cloop",
    label: "C−loop-去自循环",
    workflows: {
      education: "bench-full-platform-noloop",
      topic: "bench-topic-full-platform-noloop"
    }
  },
  {
    key: "Csingle",
    label: "Csingle-单验证器",
    workflows: {
      education: "bench-full-platform-single-verifier",
      topic: "bench-topic-full-platform-single-verifier"
    }
  },
  {
    key: "Cstatic",
    label: "Cstatic-去调度",
    workflows: {
      education: "bench-full-platform-static",
      topic: "bench-topic-full-platform-static"
    }
  },
  {
    key: "S",
    label: "S-C-弱初稿自循环",
    workflows: {
      education: "bench-full-platform-stress",
      topic: "bench-topic-full-platform-stress"
    }
  },
  {
    key: "SN",
    label: "S-CN-弱初稿无循环",
    workflows: {
      education: "bench-full-platform-stress-noloop",
      topic: "bench-topic-full-platform-stress-noloop"
    }
  }
].filter((provider) => selectedArms().has(provider.key));

if (providers.length === 0) {
  throw new Error(`BENCH_ARMS 未匹配任何基线：${process.env.BENCH_ARMS}`);
}

const lines = [
  "# 由 benchmarks/build-cases.mjs 从 data/eval/tasks.json 生成，请勿手工编辑。",
  `description: ${q(`Agent 编排平台 · 主对照与消融臂（A0 / A1 / B / C / C−loop / Csingle / Cstatic），${tasks.length} 用例`)}`,
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
  "        return result.success === true && result.evalPassed === true;",
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
    if (Array.isArray(value)) {
      // promptfoo 会把数组 vars 压成首元素，这里显式用 | 分隔，provider 再拆回数组。
      lines.push(`      ${key}: ${q(value.join("|"))}`);
    } else {
      lines.push(`      ${key}: ${q(value)}`);
    }
  }
}

writeFileSync(configPath, `${lines.join("\n")}\n`);

const byScenario = groupCount(tasks, (task) => task.scenario);
const byDifficulty = groupCount(tasks, (task) => task.difficulty);
const byCategory = groupCount(tasks, (task) => `${task.scenario}/${task.category}`);
console.log(`评测集已生成：${tasks.length} 条 · ${configPath}`);
console.log(`基线：${providers.map((provider) => provider.label).join(" · ")}`);
console.log(`场景：${format(byScenario)}`);
console.log(`难度：${format(byDifficulty)}`);
console.log(`类型：${format(byCategory)}`);

function filterTasks(list) {
  const ids = (process.env.BENCH_TASK_IDS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length > 0) {
    const selected = new Set(ids);
    return list.filter((task) => selected.has(task.id));
  }
  if (process.env.BENCH_PATTERN) {
    const pattern = new RegExp(process.env.BENCH_PATTERN);
    return list.filter((task) => pattern.test(task.id));
  }
  return list;
}

function selectedArms() {  const raw = (process.env.BENCH_ARMS || "").trim();
  if (!raw) {
    return new Set(["A0", "A1", "B", "C", "Cloop"]);
  }
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const normalized = item.toLowerCase().replace(/[−-]/g, "");
        if (normalized === "cloop" || normalized === "c-loop" || normalized === "noloop") return "Cloop";
        if (normalized === "csingle" || normalized === "single") return "Csingle";
        if (normalized === "cstatic" || normalized === "static") return "Cstatic";
        if (normalized === "s" || normalized === "stress") return "S";
        if (normalized === "sn" || normalized === "stressnoloop") return "SN";
        return item;
      })
  );
}

function validate(list) {
  if (list.length === 0) {
    throw new Error("tasks.json 中没有任务");
  }
  const knowledgeDir = path.join(here, "knowledge");
  const knowledgeNames = new Set([
    ...readdirSync(knowledgeDir).filter((file) => file.endsWith(".md")),
    ...knowledgeDocumentNames.values()
  ]);
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
    if (!Array.isArray(task.vars.relevantDocs) || task.vars.relevantDocs.length === 0) {
      throw new Error(`${task.id} 缺少 relevantDocs（证据相关性金标）`);
    }
    for (const doc of task.vars.relevantDocs) {
      if (!knowledgeNames.has(doc)) {
        throw new Error(`${task.id} 的 relevantDocs 指向不存在的知识库文档：${doc}`);
      }
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
