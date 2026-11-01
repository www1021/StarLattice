export function summarize(raw, metaInput = {}) {
  const { startedAt = Date.now(), baseUrl = "", external = false } = metaInput;
  const rows = extractRows(raw).map(toRow);
  if (rows.length === 0) {
    throw new Error("结果文件中没有可汇总的评测行");
  }
  const labels = [...new Set(rows.map((row) => row.label))].sort((left, right) =>
    left.localeCompare(right, "zh-CN")
  );
  const stats = labels.map((label) => ({
    label,
    ...statsOf(rows.filter((row) => row.label === label))
  }));
  const scenarioStats = [];
  const difficultyStats = [];
  const difficultyOrder = ["easy", "medium", "hard"];
  for (const label of labels) {
    const labelRows = rows.filter((row) => row.label === label);
    const scenarios = [...new Set(labelRows.map((row) => row.scenario).filter(Boolean))].sort(
      (left, right) => left.localeCompare(right, "zh-CN")
    );
    for (const scenario of scenarios) {
      scenarioStats.push({
        label,
        scenario,
        ...statsOf(labelRows.filter((row) => row.scenario === scenario))
      });
    }
    const difficulties = new Set(labelRows.map((row) => row.difficulty).filter(Boolean));
    for (const difficulty of difficultyOrder.filter((item) => difficulties.has(item))) {
      difficultyStats.push({
        label,
        difficulty,
        ...statsOf(labelRows.filter((row) => row.difficulty === difficulty))
      });
    }
  }
  const modes = [...new Set(rows.map((row) => row.mode).filter(Boolean))];
  const taskIds = new Set(rows.map((row) => row.taskId).filter(Boolean));
  const meta = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    baseUrl,
    external,
    modes,
    model:
      process.env.PLATFORM_LIVE_MODEL ||
      process.env.QWEN_MODEL ||
      process.env.AI_MODEL ||
      "",
    cases: taskIds.size > 0 ? taskIds.size : rows.length / Math.max(1, stats.length),
    runs: rows.length
  };
  return {
    markdown: renderMarkdown(meta, stats, scenarioStats, difficultyStats),
    csv: renderCsv(meta, stats, scenarioStats, difficultyStats)
  };
}

export function extractRows(raw) {
  if (Array.isArray(raw?.results?.results)) return raw.results.results;
  if (Array.isArray(raw?.results)) return raw.results;
  if (Array.isArray(raw?.data?.results)) return raw.data.results;
  return [];
}

function toRow(row) {
  const label = row.provider?.label || row.provider?.id || row.providerId || "unknown";
  let payload = {};
  const output = row.response?.output ?? row.output ?? "";
  try {
    payload = typeof output === "string" ? JSON.parse(output) : output ?? {};
  } catch {
    payload = { success: false, error: "输出不是 JSON" };
  }
  return {
    label,
    taskId: payload.taskId ?? null,
    scenario: payload.scenario ?? null,
    difficulty: payload.difficulty ?? null,
    category: payload.category ?? null,
    success: payload.success === true,
    assertionPassed:
      typeof row.success === "boolean"
        ? row.success
        : payload.success === true && payload.verifyPassed !== false,
    score: typeof payload.score === "number" ? payload.score : null,
    verifyPassed: typeof payload.verifyPassed === "boolean" ? payload.verifyPassed : null,
    steps: Number(payload.steps ?? 0),
    iterations: Number(payload.iterations ?? 0),
    tokens: Number(payload.tokens ?? 0),
    latencyMs: Number(row.latencyMs ?? payload.durationMs ?? 0),
    durationMs: Number(payload.durationMs ?? 0),
    mode: payload.mode ?? null,
    error: payload.error ?? (payload.success === false ? row.error : null) ?? null
  };
}

function statsOf(rows) {
  const n = rows.length;
  const success = rows.filter((row) => row.success).length;
  const asserted = rows.filter((row) => row.assertionPassed).length;
  const verifyRows = rows.filter((row) => row.verifyPassed !== null);
  const verifyPassed = verifyRows.filter((row) => row.verifyPassed).length;
  const scores = rows.map((row) => row.score).filter((score) => score !== null);
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const tokens = rows.map((row) => row.tokens).filter((value) => Number.isFinite(value));
  return {
    n,
    successRate: n === 0 ? 0 : success / n,
    taskRate: n === 0 ? 0 : asserted / n,
    verifyRate: verifyRows.length === 0 ? null : verifyPassed / verifyRows.length,
    scoreAvg: scores.length === 0 ? null : scores.reduce((sum, score) => sum + score, 0) / scores.length,
    tokensAvg: avg(tokens),
    tokensTotal: tokens.reduce((sum, value) => sum + value, 0),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    stepsAvg: avg(rows.map((row) => row.steps)),
    iterationsAvg: avg(rows.map((row) => row.iterations)),
    errors: rows.filter((row) => row.error).length,
    sampleError: rows.find((row) => row.error)?.error ?? null
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function avg(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderMarkdown(meta, stats, scenarioStats, difficultyStats) {
  const lines = [
    "# Agent 编排平台基准评测",
    "",
    `- 生成时间：${meta.generatedAt}`,
    `- 服务地址：${meta.baseUrl}${meta.external ? "（外部服务）" : "（隔离临时库）"}`,
    `- 运行模式：${meta.modes.join(" / ") || "unknown"}${meta.modes.includes("stub") ? "（stub 为确定性骨架，延迟仅反映平台开销）" : ""}`,
    ...(meta.model ? [`- 模型：${meta.model}`] : []),
    `- 用例数：${meta.cases}（总运行 ${meta.runs} 次）`,
    `- 总耗时：${ms(meta.elapsedMs)}`,
    "",
    "| 基线 | 运行数 | 运行成功率 | 任务达标率 | 验证通过率 | 平均验证分 | 平均 Tokens | P50 延迟 | P95 延迟 | 平均步骤 | 平均循环轮次 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const item of stats) {
    lines.push(
      `| ${item.label} | ${item.n} | ${pct(item.successRate)} | ${pct(item.taskRate)} | ${item.verifyRate === null ? "—" : pct(item.verifyRate)} | ${num(item.scoreAvg)} | ${Math.round(item.tokensAvg)} | ${ms(item.p50)} | ${ms(item.p95)} | ${item.stepsAvg.toFixed(1)} | ${item.iterationsAvg.toFixed(1)} |`
    );
  }

  lines.push(
    "",
    "## 分场景",
    "",
    "| 基线 | 场景 | 运行数 | 运行成功率 | 任务达标率 | 验证通过率 | 平均验证分 | 平均 Tokens | P50 延迟 | P95 延迟 | 平均循环轮次 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const item of scenarioStats) {
    lines.push(
      `| ${item.label} | ${item.scenario} | ${item.n} | ${pct(item.successRate)} | ${pct(item.taskRate)} | ${item.verifyRate === null ? "—" : pct(item.verifyRate)} | ${num(item.scoreAvg)} | ${Math.round(item.tokensAvg)} | ${ms(item.p50)} | ${ms(item.p95)} | ${item.iterationsAvg.toFixed(1)} |`
    );
  }

  lines.push(
    "",
    "## 分难度",
    "",
    "| 基线 | 难度 | 运行数 | 运行成功率 | 任务达标率 | 验证通过率 | 平均验证分 | 平均 Tokens | P50 延迟 | P95 延迟 | 平均循环轮次 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const item of difficultyStats) {
    lines.push(
      `| ${item.label} | ${item.difficulty} | ${item.n} | ${pct(item.successRate)} | ${pct(item.taskRate)} | ${item.verifyRate === null ? "—" : pct(item.verifyRate)} | ${num(item.scoreAvg)} | ${Math.round(item.tokensAvg)} | ${ms(item.p50)} | ${ms(item.p95)} | ${item.iterationsAvg.toFixed(1)} |`
    );
  }

  const hardC = difficultyStats.find((item) => item.label.startsWith("C-") && item.difficulty === "hard");
  const hardB = difficultyStats.find((item) => item.label.startsWith("B-") && item.difficulty === "hard");
  if (hardC && hardB) {
    const delta = (hardC.taskRate - hardB.taskRate) * 100;
    lines.push(
      "",
      `- 难例子集达标率：C ${pct(hardC.taskRate)}，B ${pct(hardB.taskRate)}，差值 ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} 个百分点。`
    );
  }

  const failed = stats.filter((item) => item.errors > 0);
  if (failed.length > 0) {
    lines.push("", "## 运行错误样本", "");
    for (const item of failed) {
      lines.push(`- ${item.label}（${item.errors}/${item.n} 次）：${truncateError(item.sampleError)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function truncateError(error) {
  const text = typeof error === "string" ? error : JSON.stringify(error ?? "");
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 300 ? `${normalized.slice(0, 300)}…` : normalized;
}

function renderCsv(meta, stats, scenarioStats, difficultyStats) {
  const header = [
    "scope",
    "value",
    "baseline",
    "runs",
    "run_success_rate",
    "task_pass_rate",
    "verify_pass_rate",
    "avg_score",
    "avg_tokens",
    "p50_ms",
    "p95_ms",
    "avg_steps",
    "avg_iterations",
    "errors"
  ];
  const rows = [];
  for (const item of stats) {
    rows.push(csvRow("all", "all", item));
  }
  for (const item of scenarioStats) {
    rows.push(csvRow("scenario", item.scenario, item));
  }
  for (const item of difficultyStats) {
    rows.push(csvRow("difficulty", item.difficulty, item));
  }
  return [header.join(","), ...rows].join("\n") + "\n";
}

function csvRow(scope, value, item) {
  return [
    scope,
    value,
    item.label,
    item.n,
    item.successRate.toFixed(3),
    item.taskRate.toFixed(3),
    item.verifyRate === null ? "" : item.verifyRate.toFixed(3),
    item.scoreAvg === null ? "" : item.scoreAvg.toFixed(3),
    Math.round(item.tokensAvg),
    item.p50,
    item.p95,
    item.stepsAvg.toFixed(1),
    item.iterationsAvg.toFixed(1),
    item.errors
  ].join(",");
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
