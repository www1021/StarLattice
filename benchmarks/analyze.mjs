#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, "results");
const input = process.argv[2] ? path.resolve(process.argv[2]) : newestResult();
const raw = JSON.parse(readFileSync(input, "utf8"));
const rows = extractRows(raw).map(toRow);
if (rows.length === 0) {
  console.error("没有可分析的结果行");
  process.exit(1);
}

const labels = [...new Set(rows.map((row) => row.label))];
const labelOf = (prefix) => labels.find((label) => label.startsWith(prefix)) ?? null;
const labelA = labelOf("A");
const labelB = labelOf("B");
const labelC = labelOf("C");
if (!labelB || !labelC) {
  console.error(`缺少 B/C 基线，当前标签：${labels.join(", ")}`);
  process.exit(1);
}

const byTask = new Map();
for (const row of rows) {
  const id = row.taskId ?? "(unknown)";
  if (!byTask.has(id)) {
    byTask.set(id, {
      id,
      scenario: row.scenario,
      difficulty: row.difficulty,
      category: row.category,
      cells: {}
    });
  }
  byTask.get(id).cells[row.label] = row;
}
const tasks = [...byTask.values()].sort((left, right) =>
  left.id.localeCompare(right.id, "zh-CN", { numeric: true })
);

const paired = tasks.filter((task) => task.cells[labelB] && task.cells[labelC]);
const cWins = paired.filter(
  (task) => task.cells[labelC].passed === true && task.cells[labelB].passed !== true
);
const cLosses = paired.filter(
  (task) => task.cells[labelC].passed !== true && task.cells[labelB].passed === true
);
const scoreGains = paired.filter(
  (task) => scoreDelta(task) !== null && scoreDelta(task) > 0.02
);
const scoreDrops = paired.filter(
  (task) => scoreDelta(task) !== null && scoreDelta(task) < -0.02
);

const stamp = path.basename(input).replace(/^bench-/, "").replace(/\.json$/, "");
const mdPath = path.join(resultsDir, `analysis-${stamp}.md`);
const csvPath = path.join(resultsDir, `analysis-${stamp}.csv`);
const markdown = render();
writeFileSync(mdPath, markdown);
writeFileSync(csvPath, renderCsv());
writeFileSync(path.join(resultsDir, "latest-analysis.md"), markdown);
console.log(markdown);
console.log(`分析报告：${mdPath}`);
console.log(`逐用例 CSV：${csvPath}`);

function newestResult() {
  const files = readdirSync(resultsDir)
    .filter((file) => file.startsWith("bench-") && file.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    console.error("results 目录里没有 bench-*.json，请传入结果文件路径");
    process.exit(1);
  }
  return path.join(resultsDir, files.at(-1));
}

function extractRows(data) {
  if (Array.isArray(data?.results?.results)) return data.results.results;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data?.results)) return data.data.results;
  return [];
}

function toRow(row) {
  const label = row.provider?.label || row.provider?.id || row.providerId || "unknown";
  const vars = row.vars ?? row.testCase?.vars ?? {};
  let payload = {};
  const output = row.response?.output ?? row.output ?? "";
  try {
    payload = typeof output === "string" ? JSON.parse(output) : (output ?? {});
  } catch {
    payload = { success: false, error: "输出不是 JSON" };
  }
  return {
    label,
    taskId: payload.taskId ?? vars.taskId ?? null,
    scenario: payload.scenario ?? vars.scenario ?? null,
    difficulty: payload.difficulty ?? vars.difficulty ?? null,
    category: payload.category ?? vars.category ?? null,
    success: payload.success === true,
    passed: typeof payload.verifyPassed === "boolean" ? payload.verifyPassed : null,
    score: typeof payload.score === "number" ? payload.score : null,
    iterations: Number(payload.iterations ?? 0) || 0,
    tokens: Number(payload.tokens ?? 0) || 0,
    latencyMs: Number(row.latencyMs ?? payload.durationMs ?? 0) || 0,
    error: payload.error ?? null
  };
}

function scoreDelta(task) {
  const b = task.cells[labelB]?.score;
  const c = task.cells[labelC]?.score;
  return typeof b === "number" && typeof c === "number" ? c - b : null;
}

function statsOf(list) {
  const n = list.length;
  const passed = list.filter((row) => row.passed === true).length;
  const scores = list.map((row) => row.score).filter((score) => typeof score === "number");
  const latencies = list.map((row) => row.latencyMs).sort((left, right) => left - right);
  return {
    n,
    passed,
    passRate: n === 0 ? 0 : passed / n,
    avgScore: scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    avgTokens: avg(list.map((row) => row.tokens)),
    avgIterations: avg(list.map((row) => row.iterations))
  };
}

function pairedStats(filter) {
  const list = paired.filter(filter);
  const b = statsOf(list.map((task) => task.cells[labelB]));
  const c = statsOf(list.map((task) => task.cells[labelC]));
  const deltas = list.map(scoreDelta).filter((delta) => delta !== null);
  return {
    n: list.length,
    b,
    c,
    passDelta: c.passRate - b.passRate,
    scoreDelta: deltas.length === 0 ? null : deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length
  };
}

function render() {
  const overall = pairedStats(() => true);
  const hard = pairedStats((task) => task.difficulty === "hard");
  const checks = [
    {
      name: "C 整体达标率 ≥ B",
      ok: overall.passDelta >= 0,
      detail: `${pp(overall.passDelta)}（C ${pct(overall.c.passRate)} / B ${pct(overall.b.passRate)}）`
    },
    {
      name: "C 难例子集领先 B ≥ 10pp",
      ok: hard.n > 0 && hard.passDelta >= 0.1,
      detail: hard.n === 0 ? "无难例" : `${pp(hard.passDelta)}（${hard.n} 例，C ${pct(hard.c.passRate)} / B ${pct(hard.b.passRate)}）`
    },
    {
      name: "C 单例不低于 B 超过 0.02",
      ok: scoreDrops.length === 0,
      detail: scoreDrops.length === 0 ? "0 例" : `${scoreDrops.length} 例：${scoreDrops.map((task) => task.id).join("、")}`
    }
  ];
  const lines = [
    "# 三基线逐用例分析",
    "",
    `- 结果文件：${input}`,
    `- 用例数：${tasks.length}（配对用例 ${paired.length}）`,
    `- 总运行：${rows.length} 次`,
    "",
    "## 验收线",
    "",
    "| 验收项 | 结论 | 实测 |",
    "| --- | :---: | --- |",
    ...checks.map(
      (check) => `| ${check.name} | ${check.ok ? "通过" : "未通过"} | ${check.detail} |`
    ),
    "",
    "## 总体配对（C vs B）",
    "",
    "| 指标 | B-固定流水线 | C-完整平台 | C-B |",
    "| --- | ---: | ---: | ---: |",
    `| 达标率 | ${pct(overall.b.passRate)} (${overall.b.passed}/${overall.b.n}) | ${pct(overall.c.passRate)} (${overall.c.passed}/${overall.c.n}) | ${pp(overall.passDelta)} |`,
    `| 平均验证分 | ${num(overall.b.avgScore)} | ${num(overall.c.avgScore)} | ${signed(overall.scoreDelta)} |`,
    `| 平均 Tokens | ${Math.round(overall.b.avgTokens)} | ${Math.round(overall.c.avgTokens)} | ${signed(Math.round(overall.c.avgTokens - overall.b.avgTokens), 0)} |`,
    `| P50 延迟 | ${ms(overall.b.p50)} | ${ms(overall.c.p50)} | — |`,
    `| P95 延迟 | ${ms(overall.b.p95)} | ${ms(overall.c.p95)} | — |`,
    `| 平均循环轮次 | ${overall.b.avgIterations.toFixed(1)} | ${overall.c.avgIterations.toFixed(1)} | — |`,
    "",
    `- 达标胜出（B 未达标、C 达标）：${cWins.length} 例${ids(cWins)}`,
    `- 达标退化（B 达标、C 未达标）：${cLosses.length} 例${ids(cLosses)}`,
    `- 分数提升 > 0.02：${scoreGains.length} 例${ids(scoreGains)}`,
    `- 分数下降 > 0.02：${scoreDrops.length} 例${ids(scoreDrops)}`,
    "",
    "## 分难度",
    "",
    "| 难度 | 用例数 | B 达标率 | C 达标率 | 达标率差 | B 均分 | C 均分 | 均分差 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const difficulty of ["easy", "medium", "hard"]) {
    const item = pairedStats((task) => task.difficulty === difficulty);
    lines.push(
      item.n === 0
        ? `| ${difficulty} | 0 | — | — | — | — | — | — |`
        : `| ${difficulty} | ${item.n} | ${pct(item.b.passRate)} | ${pct(item.c.passRate)} | ${pp(item.passDelta)} | ${num(item.b.avgScore)} | ${num(item.c.avgScore)} | ${signed(item.scoreDelta)} |`
    );
  }

  lines.push(
    "",
    "## 分场景",
    "",
    "| 场景 | 用例数 | B 达标率 | C 达标率 | 达标率差 | B 均分 | C 均分 | 均分差 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const scenario of [...new Set(paired.map((task) => task.scenario).filter(Boolean))]) {
    const item = pairedStats((task) => task.scenario === scenario);
    lines.push(
      `| ${scenario} | ${item.n} | ${pct(item.b.passRate)} | ${pct(item.c.passRate)} | ${pp(item.passDelta)} | ${num(item.b.avgScore)} | ${num(item.c.avgScore)} | ${signed(item.scoreDelta)} |`
    );
  }

  lines.push(
    "",
    "## 逐用例",
    "",
    `| 用例 | 场景 | 难度 | ${labelA ?? "A"} 分 | B 分 | C 分 | C-B | B | C | C 轮次 | C Tokens | C 耗时 |`,
    "| --- | --- | --- | ---: | ---: | ---: | ---: | :---: | :---: | ---: | ---: | ---: |"
  );
  for (const task of tasks) {
    const a = task.cells[labelA] ?? {};
    const b = task.cells[labelB] ?? {};
    const c = task.cells[labelC] ?? {};
    lines.push(
      `| ${task.id} | ${task.scenario ?? "—"} | ${task.difficulty ?? "—"} | ${num(a.score)} | ${num(b.score)} | ${num(c.score)} | ${signed(scoreDelta(task))} | ${mark(b.passed)} | ${mark(c.passed)} | ${c.iterations ?? "—"} | ${c.tokens ? Math.round(c.tokens) : "—"} | ${c.latencyMs ? ms(c.latencyMs) : "—"} |`
    );
  }

  if (cLosses.length > 0) {
    lines.push("", "## 需要复盘的退化用例", "");
    for (const task of cLosses) {
      lines.push(
        `- ${task.id}（${task.difficulty ?? "?"}）：B ${num(task.cells[labelB].score)} 达标 → C ${num(task.cells[labelC].score)} 未达标（C 循环 ${task.cells[labelC].iterations} 轮）`
      );
    }
  }
  if (cWins.length > 0) {
    lines.push("", "## C 的达标增益用例", "");
    for (const task of cWins) {
      lines.push(
        `- ${task.id}（${task.difficulty ?? "?"}）：B ${num(task.cells[labelB].score)} 未达标 → C ${num(task.cells[labelC].score)} 达标（C 循环 ${task.cells[labelC].iterations} 轮）`
      );
    }
  }
  const failed = rows.filter((row) => row.error);
  if (failed.length > 0) {
    lines.push("", "## 运行错误", "");
    for (const row of failed) {
      lines.push(`- ${row.label} · ${row.taskId ?? "?"}：${String(row.error).slice(0, 240)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function renderCsv() {
  const header = [
    "task_id",
    "scenario",
    "difficulty",
    "category",
    "a_score",
    "b_score",
    "c_score",
    "c_minus_b",
    "b_passed",
    "c_passed",
    "c_iterations",
    "c_tokens",
    "c_latency_ms",
    "c_error"
  ];
  const lines = [header.join(",")];
  for (const task of tasks) {
    const a = task.cells[labelA] ?? {};
    const b = task.cells[labelB] ?? {};
    const c = task.cells[labelC] ?? {};
    lines.push(
      [
        task.id,
        task.scenario ?? "",
        task.difficulty ?? "",
        task.category ?? "",
        a.score ?? "",
        b.score ?? "",
        c.score ?? "",
        scoreDelta(task) === null ? "" : scoreDelta(task).toFixed(3),
        b.passed ?? "",
        c.passed ?? "",
        c.iterations ?? "",
        c.tokens ?? "",
        c.latencyMs ?? "",
        c.error ? String(c.error).replace(/[",\n]/g, " ").slice(0, 200) : ""
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function avg(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function pp(value) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pp`;
}

function num(value) {
  return typeof value === "number" ? value.toFixed(3) : "—";
}

function signed(value, digits = 3) {
  if (typeof value !== "number" || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function ms(value) {
  return `${Math.round(value)}ms`;
}

function mark(value) {
  if (value === true) return "✓";
  if (value === false) return "✗";
  return "—";
}

function ids(list) {
  return list.length === 0 ? "" : `（${list.map((task) => task.id).join("、")}）`;
}
