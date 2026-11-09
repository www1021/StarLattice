export function summarize(raw, metaInput = {}) {
  const {
    startedAt,
    finishedAt = Date.now(),
    baseUrl = "",
    external = false,
    concurrency = 1,
    artifactDir = ""
  } = metaInput;
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
  const judgeModes = [...new Set(rows.map((row) => row.judgeMode).filter(Boolean))];
  const judgeModels = [...new Set(rows.map((row) => row.judgeModel).filter(Boolean))];
  const judgeVersions = [...new Set(rows.map((row) => row.judgeVersion).filter(Boolean))];
  const taskIds = new Set(rows.map((row) => row.taskId).filter(Boolean));
  const elapsedMs =
    Number.isFinite(startedAt) && startedAt > 0 && finishedAt > startedAt
      ? finishedAt - startedAt
      : null;
  const meta = {
    generatedAt: new Date().toISOString(),
    startedAt: Number.isFinite(startedAt) && startedAt > 0 ? new Date(startedAt).toISOString() : null,
    finishedAt: new Date(finishedAt).toISOString(),
    elapsedMs,
    baseUrl,
    external,
    concurrency,
    artifactDir,
    modes,
    judgeModes,
    judgeModels,
    judgeVersions,
    judgeFallbacks: rows.filter((row) => row.judgeFallback).length,
    model:
      process.env.PLATFORM_LIVE_MODEL ||
      process.env.QWEN_MODEL ||
      process.env.AI_MODEL ||
      "",
    cases: taskIds.size > 0 ? taskIds.size : rows.length / Math.max(1, stats.length),
    runs: rows.length
  };
  const paired = pairedComparisons(rows, [
    ["S-C-弱初稿自循环", "S-CN-弱初稿无循环"],
    ["C-完整平台", "Cstatic-去调度"],
    ["C-完整平台", "C−loop-去自循环"],
    ["C−loop-去自循环", "Csingle-单验证器"],
    ["Csingle-单验证器", "B-固定流水线"],
    ["C−loop-去自循环", "B-固定流水线"],
    ["B-固定流水线", "A1-公平单Agent"],
    ["A1-公平单Agent", "A0-历史单Agent"]
  ]);
  const engagement = selfLoopEngagement(rows, paired);
  return {
    markdown: renderMarkdown(
      meta,
      stats,
      scenarioStats,
      difficultyStats,
      paired,
      hardRuleStats(rows, labels),
      engagement
    ),
    csv: renderCsv(meta, stats, scenarioStats, difficultyStats, paired, engagement)
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
        : payload.success === true && payload.evalPassed === true,
    evalPassed: typeof payload.evalPassed === "boolean" ? payload.evalPassed : null,
    evalScore: numberOrNull(payload.evalScore),
    selfVerifyPassed:
      typeof payload.selfVerifyPassed === "boolean" ? payload.selfVerifyPassed : null,
    selfVerifyScore: numberOrNull(payload.selfVerifyScore ?? payload.score),
    judgeMode: payload.judgeMode ?? null,
    judgeModel: payload.judgeModel ?? null,
    judgeVersion: payload.judgeVersion ?? null,
    judgeFallback: payload.judgeFallback === true,
    hardRules: Array.isArray(payload.hardRules) ? payload.hardRules : [],
    artifactSource: payload.artifactSource ?? null,
    artifactFile: payload.artifactFile ?? null,
    retrievalTitles: Array.isArray(payload.retrievalTitles) ? payload.retrievalTitles : [],
    retrievalRecall5: numberOrNull(payload.retrievalRecall5),
    retrievalPrecision5: numberOrNull(payload.retrievalPrecision5),
    steps: Number(payload.steps ?? 0),
    iterations: Number(payload.iterations ?? 0),
    initialVerifyScore: numberOrNull(payload.initialVerifyScore),
    finalVerifyScore: numberOrNull(payload.finalVerifyScore),
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
  const judged = rows.filter((row) => row.evalPassed !== null);
  const judgedPassed = judged.filter((row) => row.evalPassed).length;
  const evalScores = rows.map((row) => row.evalScore).filter((score) => score !== null);
  const selfRows = rows.filter((row) => row.selfVerifyPassed !== null);
  const selfScores = rows.map((row) => row.selfVerifyScore).filter((score) => score !== null);
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const tokens = rows.map((row) => row.tokens).filter((value) => Number.isFinite(value));
  const recalls = rows.map((row) => row.retrievalRecall5).filter((value) => value !== null);
  const precisions = rows.map((row) => row.retrievalPrecision5).filter((value) => value !== null);
  const pairedScores = rows.filter(
    (row) =>
      row.evalScore !== null &&
      row.selfVerifyScore !== null &&
      row.evalPassed !== null &&
      row.selfVerifyPassed !== null
  );
  return {
    n,
    successRate: n === 0 ? 0 : success / n,
    taskRate: n === 0 ? 0 : asserted / n,
    judgeRate: judged.length === 0 ? null : judgedPassed / judged.length,
    judgeAvg: evalScores.length === 0 ? null : average(evalScores),
    verifyRate: selfRows.length === 0 ? null : selfRows.filter((row) => row.selfVerifyPassed).length / selfRows.length,
    verifyAvg: selfScores.length === 0 ? null : average(selfScores),
    judgeSelfN: pairedScores.length,
    judgeSelfGap:
      pairedScores.length === 0
        ? null
        : average(pairedScores.map((row) => Math.abs(row.evalScore - row.selfVerifyScore))),
    judgeSelfAgreement:
      pairedScores.length === 0
        ? null
        : pairedScores.filter((row) => row.evalPassed === row.selfVerifyPassed).length /
          pairedScores.length,
    retrievalN: recalls.length,
    retrievalRecall5: recalls.length === 0 ? null : average(recalls),
    retrievalPrecision5: precisions.length === 0 ? null : average(precisions),
    tokensAvg: average(tokens),
    tokensTotal: tokens.reduce((sum, value) => sum + value, 0),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    stepsAvg: average(rows.map((row) => row.steps)),
    iterationsAvg: average(rows.map((row) => row.iterations)),
    errors: rows.filter((row) => row.error).length,
    sampleError: rows.find((row) => row.error)?.error ?? null
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 配对比较：同一用例在不同基线之间做差，按用例重采样给出 95% CI。
 * 固定随机种子，保证同一份结果重复汇总得到同一区间。
 */
function pairedComparisons(rows, pairSpecs) {
  const byArm = new Map();
  for (const row of rows) {
    if (!row.taskId) continue;
    if (!byArm.has(row.label)) byArm.set(row.label, new Map());
    byArm.get(row.label).set(row.taskId, row);
  }
  // 兼容两种写法：字符串数组视为相邻链式比较，[treatment, control] 数组视为显式配对。
  const pairs = [];
  for (let index = 0; index < pairSpecs.length; index += 1) {
    const spec = pairSpecs[index];
    if (Array.isArray(spec)) {
      pairs.push([spec[0], spec[1]]);
    } else if (index + 1 < pairSpecs.length) {
      pairs.push([spec, pairSpecs[index + 1]]);
    }
  }
  const seen = new Set();
  const comparisons = [];
  for (const [treatment, control] of pairs) {
    const key = `${treatment}\u0000${control}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const left = byArm.get(treatment);
    const right = byArm.get(control);
    if (!left || !right) continue;
    const taskIds = [...left.keys()].filter((taskId) => right.has(taskId)).sort();
    if (taskIds.length === 0) continue;
    const scoreDiffs = [];
    const passDiffs = [];
    let wins = 0;
    let losses = 0;
    let ties = 0;
    let skipped = 0;
    for (const taskId of taskIds) {
      const a = left.get(taskId);
      const b = right.get(taskId);
      // 只认固定裁判；缺裁判分的用例整对剔除，绝不用平台自验分补位。
      if (a.evalScore === null || b.evalScore === null || a.evalPassed === null || b.evalPassed === null) {
        skipped += 1;
        continue;
      }
      const scoreA = a.evalScore;
      const scoreB = b.evalScore;
      scoreDiffs.push(scoreA - scoreB);
      const passA = a.evalPassed ? 1 : 0;
      const passB = b.evalPassed ? 1 : 0;
      passDiffs.push(passA - passB);
      if (scoreA > scoreB + 1e-9) wins += 1;
      else if (scoreA < scoreB - 1e-9) losses += 1;
      else ties += 1;
    }
    if (scoreDiffs.length === 0) continue;
    const scoreCi = bootstrapCi(scoreDiffs, 0.95);
    const passCi = bootstrapCi(passDiffs, 0.95);
    comparisons.push({
      treatment,
      control,
      n: scoreDiffs.length,
      skipped,
      scoreDiff: average(scoreDiffs),
      scoreCi,
      passDiff: average(passDiffs),
      passCi,
      wins,
      losses,
      ties
    });
  }
  return comparisons;
}

/**
 * Self-Loop 只有初始验证未达标才会进入；未触发时 C 与 C−loop 链路完全一致。
 * 这里单独报告触发率，并在触发子集上重算 C−C−loop，避免把模型采样波动算成 Self-Loop 增益。
 */
function selfLoopEngagement(rows, paired) {
  const pair = paired.find(
    (item) => item.treatment === "C-完整平台" && item.control === "C−loop-去自循环"
  ) ?? paired.find(
    (item) => /自循环/.test(item.treatment) && /(无循环|去自循环)/.test(item.control)
  );
  if (!pair) {
    return {
      treatment: null,
      control: null,
      total: 0,
      engaged: 0,
      rate: null,
      avgIterations: null,
      engagedAvg: null,
      idleAvg: null,
      initialVerifyAvg: null,
      finalVerifyAvg: null,
      engagedPair: null,
      fullPair: null
    };
  }
  const treatmentRows = rows.filter((row) => row.label === pair.treatment && row.taskId);
  const controlIds = new Set(
    rows.filter((row) => row.label === pair.control).map((row) => row.taskId)
  );
  const engaged = treatmentRows.filter((row) => row.iterations > 0);
  const engagedIds = new Set(engaged.map((row) => row.taskId).filter((id) => controlIds.has(id)));
  const subset = rows.filter(
    (row) =>
      (row.label === pair.treatment || row.label === pair.control) && engagedIds.has(row.taskId)
  );
  const engagedPair = pairedComparisons(subset, [pair.treatment, pair.control])[0] ?? null;
  const fullPair =
    paired.find((item) => item.treatment === pair.treatment && item.control === pair.control) ??
    null;
  const initialScores = engaged
    .map((row) => row.initialVerifyScore)
    .filter((score) => score !== null && score !== undefined);
  const finalScores = engaged
    .map((row) => row.finalVerifyScore)
    .filter((score) => score !== null && score !== undefined);
  return {
    treatment: pair.treatment,
    control: pair.control,
    total: treatmentRows.length,
    engaged: engaged.length,
    rate: treatmentRows.length === 0 ? null : engaged.length / treatmentRows.length,
    avgIterations: averageOrNull(engaged.map((row) => row.iterations)),
    engagedAvg: averageOrNull(engaged.map((row) => row.evalScore).filter((score) => score !== null)),
    idleAvg: averageOrNull(
      treatmentRows
        .filter((row) => row.iterations === 0)
        .map((row) => row.evalScore)
        .filter((score) => score !== null)
    ),
    initialVerifyAvg: averageOrNull(initialScores),
    finalVerifyAvg: averageOrNull(finalScores),
    engagedPair,
    fullPair
  };
}

function averageOrNull(values) {
  return values.length === 0 ? null : average(values);
}

function bootstrapCi(values, level, iterations = 2000) {  if (values.length === 0) return [0, 0];
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

function hardRuleStats(rows, labels) {
  const buckets = new Map();
  for (const label of labels) buckets.set(label, new Map());
  for (const row of rows) {
    const bucket = buckets.get(row.label);
    if (!bucket) continue;
    for (const rule of row.hardRules ?? []) {
      const key = rule.split(/[：:]/)[0];
      bucket.set(key, (bucket.get(key) ?? 0) + 1);
    }
  }
  return [...buckets.entries()]
    .map(([label, bucket]) => ({
      label,
      rules: [...bucket.entries()].sort((left, right) => right[1] - left[1])
    }))
    .filter((item) => item.rules.length > 0);
}

function renderMarkdown(meta, stats, scenarioStats, difficultyStats, paired, hardRules, engagement) {
  const judgeText =
    meta.judgeModes.length === 0
      ? "未记录"
      : meta.judgeModes
          .map((mode) => (mode.startsWith("llm") ? `LLM(${meta.judgeModels.join(" / ") || "unknown"})` : "固定规则裁判"))
          .join(" / ");
  const ablationNotes = [
    stats.some((item) => item.label === "Csingle-单验证器")
      ? "Csingle 把 C−loop 的多验证器收敛为单验证器"
      : null,
    stats.some((item) => item.label === "Cstatic-去调度")
      ? "Cstatic 与 C 同链路但跳过运行前调度"
      : null
  ].filter(Boolean);
  const lines = [
    "# Agent 编排平台基准评测",
    "",
    `- 生成时间：${meta.generatedAt}`,
    `- 服务地址：${meta.baseUrl}${meta.external ? "（外部服务）" : "（隔离临时库）"}`,
    `- 运行模式：${meta.modes.join(" / ") || "unknown"}${meta.modes.includes("stub") ? "（stub 为确定性骨架，延迟仅反映平台开销）" : ""}`,
    ...(meta.model ? [`- 执行模型：${meta.model}`] : []),
    `- 固定裁判：${judgeText}${meta.judgeVersions.length > 0 ? ` · ${meta.judgeVersions.join(" / ")}` : ""}`,
    ...(meta.judgeFallbacks > 0 ? [`- 裁判回退：${meta.judgeFallbacks} 次（LLM 不可用，已回退规则裁判）`] : []),
    `- 用例数：${meta.cases}（总运行 ${meta.runs} 次，并发 ${meta.concurrency}）`,
    `- 墙钟耗时：${meta.elapsedMs === null ? "未记录（合并分片结果不推算总耗时）" : ms(meta.elapsedMs)}`,
    ...(meta.artifactDir ? [`- 产物文本：${meta.artifactDir}`] : []),
    `- 达标口径：固定裁判分 ≥ 用例阈值且无硬规则失败；平台自验分仅作对照，不参与达标判定。`,
    `- 臂定义：A0 保留旧提示词，仅作历史参照；A1 单 Agent + 检索 + 统一交付契约；B 在 A1 之上加入三角色演练；C−loop 在 B 之上加入多验证器；C 在 C−loop 之上加入 Self-Loop${ablationNotes.length > 0 ? `；${ablationNotes.join("；")}` : ""}。`,
    ...(stats.some((item) => item.label.startsWith("S-"))
      ? [
          "- 压力条件：S 臂把初稿刻意压成 4 行提纲，强制初始验证不达标；S−loop 臂同链路但去掉 Self-Loop。压力臂不属于常规主表，只用于测量 Self-Loop 在失败输入上的修复增量。"
        ]
      : []),
    "- 所有臂的最终交付物由同一 finalize 节点按同一契约生成；裁判不读取臂标签、平台验证分或循环记录。",
    ""
  ];

  lines.push(
    "| 基线 | 运行数 | 运行成功率 | 裁判达标率 | 平均裁判分 | 平台自验率 | 平均自验分 | 平均 Tokens | P50 延迟 | P95 延迟 | 平均步骤 | 平均循环轮次 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const item of stats) {
    lines.push(
      `| ${item.label} | ${item.n} | ${pct(item.successRate)} | ${item.judgeRate === null ? "—" : pct(item.judgeRate)} | ${num(item.judgeAvg)} | ${item.verifyRate === null ? "—" : pct(item.verifyRate)} | ${num(item.verifyAvg)} | ${Math.round(item.tokensAvg)} | ${ms(item.p50)} | ${ms(item.p95)} | ${item.stepsAvg.toFixed(1)} | ${item.iterationsAvg.toFixed(1)} |`
    );
  }

  if (paired.length > 0) {
    lines.push(
      "",
      "## 配对差值与 bootstrap 95% CI",
      "",
      "同一用例在两组之间做差，按用例重采样 2000 次；区间跨 0 视为该组差异不显著。只使用固定裁判分，缺裁判分的用例整对剔除。",
      "",
      "| 对比 | 配对用例 | 裁判分差 | 95% CI | 达标率差 | 95% CI | 胜/负/平 |",
      "| --- | ---: | ---: | --- | ---: | --- | --- |"
    );
    for (const item of paired) {
      lines.push(
        `| ${item.treatment} − ${item.control} | ${item.n}${item.skipped > 0 ? `（剔除 ${item.skipped}）` : ""} | ${signed(item.scoreDiff, 3)} | [${signed(item.scoreCi[0], 3)}, ${signed(item.scoreCi[1], 3)}] | ${signed(item.passDiff * 100, 1)}pp | [${signed(item.passCi[0] * 100, 1)}, ${signed(item.passCi[1] * 100, 1)}]pp | ${item.wins}/${item.losses}/${item.ties} |`
      );
    }
  }

  if (engagement && engagement.total > 0) {
    const arm = engagement.treatment;
    const baseline = engagement.control;
    lines.push(
      "",
      "## Self-Loop 触发与增量",
      "",
      `- ${arm} 触发 Self-Loop：${engagement.engaged}/${engagement.total}（${engagement.rate === null ? "—" : pct(engagement.rate)}）${engagement.avgIterations === null ? "" : `，触发时平均 ${engagement.avgIterations.toFixed(1)} 轮`}。`,
      `- 触发子集平台自验：首次 ${num(engagement.initialVerifyAvg)} → 末次 ${num(engagement.finalVerifyAvg)}（仅统计触发用例）。`,
      `- 触发子集裁判均分：${num(engagement.engagedAvg)}；未触发子集：${num(engagement.idleAvg)}。`
    );
    if (engagement.engagedPair) {
      const item = engagement.engagedPair;
      lines.push(
        `- 仅触发子集：${arm} − ${baseline} 裁判分差 ${signed(item.scoreDiff, 3)}，95% CI [${signed(item.scoreCi[0], 3)}, ${signed(item.scoreCi[1], 3)}]，n=${item.n}。`
      );
    } else {
      lines.push(`- 本次没有同时具备 ${arm} 触发与 ${baseline} 结果的用例，无法计算 Self-Loop 触发子集增量。`);
    }
    if (engagement.engaged === 0) {
      lines.push(
        `- 本轮 Self-Loop 未触发；未触发链路上 ${arm} 与 ${baseline} 完全相同，${arm} − ${baseline} 的差值只反映模型采样波动，不能作为 Self-Loop 增益证据。`
      );
    }
  }

  const calibratable = stats.filter((item) => item.judgeSelfN > 0);
  if (calibratable.length > 0) {
    lines.push(
      "",
      "## 裁判与平台自验的口径差",
      "",
      "固定裁判与平台自验相互独立；平均绝对差越小、结论一致率越高，说明平台自验越接近外部口径，但它仍不参与达标判定。",
      "",
      "| 基线 | 可比用例 | 平均绝对差 | 结论一致率 |",
      "| --- | ---: | ---: | ---: |"
    );
    for (const item of calibratable) {
      lines.push(
        `| ${item.label} | ${item.judgeSelfN} | ${num(item.judgeSelfGap)} | ${item.judgeSelfAgreement === null ? "—" : pct(item.judgeSelfAgreement)} |`
      );
    }
  }

  if (hardRules.length > 0) {
    lines.push("", "## 裁判硬规则失败分布", "");
    for (const item of hardRules) {
      lines.push(
        `- ${item.label}：${item.rules.map(([rule, count]) => `${rule} ${count}`).join("；")}`
      );
    }
  }

  lines.push(
    "",
    "## 分场景",
    "",
    "| 基线 | 场景 | 运行数 | 运行成功率 | 裁判达标率 | 平均裁判分 | 平均 Tokens | P50 延迟 | P95 延迟 | 平均循环轮次 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const item of scenarioStats) {
    lines.push(
      `| ${item.label} | ${item.scenario} | ${item.n} | ${pct(item.successRate)} | ${item.judgeRate === null ? "—" : pct(item.judgeRate)} | ${num(item.judgeAvg)} | ${Math.round(item.tokensAvg)} | ${ms(item.p50)} | ${ms(item.p95)} | ${item.iterationsAvg.toFixed(1)} |`
    );
  }

  lines.push(
    "",
    "## 分难度",
    "",
    "| 基线 | 难度 | 运行数 | 运行成功率 | 裁判达标率 | 平均裁判分 | 平均 Tokens | P50 延迟 | P95 延迟 | 平均循环轮次 |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const item of difficultyStats) {
    lines.push(
      `| ${item.label} | ${item.difficulty} | ${item.n} | ${pct(item.successRate)} | ${item.judgeRate === null ? "—" : pct(item.judgeRate)} | ${num(item.judgeAvg)} | ${Math.round(item.tokensAvg)} | ${ms(item.p50)} | ${ms(item.p95)} | ${item.iterationsAvg.toFixed(1)} |`
    );
  }

  const retrievable = stats.filter((item) => item.retrievalN > 0);
  if (retrievable.length > 0) {
    lines.push(
      "",
      "## 检索质量（金标相关性 @5）",
      "",
      "相关性金标写在 data/eval/tasks.json 的 relevantDocs，由基准脚本按任务主题标注（agent 构建，非人工标注）。A0 不做检索，故无召回。",
      "",
      "| 基线 | 检索运行数 | 平均 Recall@5 | 平均 Precision@5 |",
      "| --- | ---: | ---: | ---: |"
    );
    for (const item of retrievable) {
      lines.push(
        `| ${item.label} | ${item.retrievalN} | ${num(item.retrievalRecall5)} | ${num(item.retrievalPrecision5)} |`
      );
    }
  }

  const hard = difficultyStats.filter((item) => item.difficulty === "hard");
  if (hard.length > 0) {
    lines.push("", "## 难例子集", "");
    for (const item of hard) {
      lines.push(`- ${item.label}：裁判达标率 ${item.judgeRate === null ? "—" : pct(item.judgeRate)}，平均裁判分 ${num(item.judgeAvg)}，n=${item.n}`);
    }
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

function renderCsv(meta, stats, scenarioStats, difficultyStats, paired, engagement) {
  const header = [
    "scope",
    "value",
    "baseline",
    "runs",
    "run_success_rate",
    "judge_pass_rate",
    "avg_judge_score",
    "self_verify_pass_rate",
    "avg_self_verify_score",
    "avg_tokens",
    "p50_ms",
    "p95_ms",
    "avg_steps",
    "avg_iterations",
    "errors",
    "retrieval_recall5",
    "retrieval_precision5"
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
  for (const item of paired) {
    rows.push(
      [
        "paired",
        `${item.treatment} - ${item.control}`,
        "",
        item.n,
        "",
        (item.passDiff * 100).toFixed(1),
        `${item.scoreDiff.toFixed(3)} [${item.scoreCi[0].toFixed(3)}, ${item.scoreCi[1].toFixed(3)}]`,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        ""
      ].join(",")
    );
  }
  if (engagement && engagement.total > 0) {
    rows.push(
      [
        "self-loop",
        `${engagement.treatment} 触发 ${engagement.engaged}/${engagement.total} (${engagement.rate === null ? "—" : pct(engagement.rate)})`,
        engagement.treatment,
        engagement.total,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        engagement.avgIterations === null ? "" : engagement.avgIterations.toFixed(1),
        "",
        "",
        ""
      ].join(",")
    );
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
    item.judgeRate === null ? "" : item.judgeRate.toFixed(3),
    item.judgeAvg === null ? "" : item.judgeAvg.toFixed(3),
    item.verifyRate === null ? "" : item.verifyRate.toFixed(3),
    item.verifyAvg === null ? "" : item.verifyAvg.toFixed(3),
    Math.round(item.tokensAvg),
    item.p50,
    item.p95,
    item.stepsAvg.toFixed(1),
    item.iterationsAvg.toFixed(1),
    item.errors,
    item.retrievalRecall5 === null ? "" : item.retrievalRecall5.toFixed(3),
    item.retrievalPrecision5 === null ? "" : item.retrievalPrecision5.toFixed(3)
  ].join(",");
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function num(value) {
  return value === null ? "—" : value.toFixed(3);
}

function signed(value, digits) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function ms(value) {
  return `${Math.round(value)}ms`;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
