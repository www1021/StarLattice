import type { RunRecord } from "../types.js";

export type MetricsOptions = {
  workflowIds?: string[];
  limit?: number;
};

export type RunMetrics = {
  runCount: number;
  succeeded: number;
  failed: number;
  successRate: number;
  taskPassed: number;
  taskRate: number;
  scoreAvg: number | null;
  p50Ms: number;
  p95Ms: number;
  stepsAvg: number;
  iterationsAvg: number;
  tokensTotal: number;
  tokensAvg: number;
  estimatedCost: number;
  modes: string[];
};

export type MetricsReport = {
  generatedAt: string;
  costRatePer1kTokens: number;
  overall: RunMetrics;
  workflows: Array<{ workflowId: string } & RunMetrics>;
  alerts: AnomalyAlert[];
};

export type AnomalyAlert = {
  workflowId: string;
  kind: "failure_spike" | "latency_spike" | "score_drift";
  severity: "warning" | "critical";
  message: string;
  value: number;
  threshold: number;
  sampleSize: number;
};

/** 告警阈值集中在常量里，界面与文档引用同一套口径。 */
export const ANOMALY_RULES = {
  failureWindow: 5,
  failureRateWarning: 0.4,
  failureRateCritical: 0.6,
  latencyBaselineWindow: 10,
  latencyFactorWarning: 2,
  latencyFactorCritical: 3,
  latencyFloorMs: 5000,
  scoreWindow: 5,
  scoreBaselineWindow: 10,
  scoreDropWarning: 0.1,
  scoreDropCritical: 0.2,
  minSamples: 3
} as const;

export type MetricsSource = {
  listRunsForMetrics(workflowIds?: string[], limit?: number): RunRecord[];
  countLoopIterationsByRun(runIds: string[]): Map<string, number>;
};

/**
 * 从 run 记录聚合指标。成本按 token 总量估算，单价通过 PLATFORM_COST_PER_1K_TOKENS 注入，
 * 不写死供应商价格；未配置时成本为 0，前端应展示“未配置单价”。
 */
export function collectMetrics(source: MetricsSource, options: MetricsOptions = {}): MetricsReport {
  const workflowIds = (options.workflowIds ?? []).filter(Boolean);
  const runs = source.listRunsForMetrics(workflowIds, options.limit ?? 1000);
  const loopCounts = source.countLoopIterationsByRun(runs.map((run) => run.id));
  const rate = costRate();

  const grouped = new Map<string, RunRecord[]>();
  for (const run of runs) {
    const list = grouped.get(run.workflowId) ?? [];
    list.push(run);
    grouped.set(run.workflowId, list);
  }

  return {
    generatedAt: new Date().toISOString(),
    costRatePer1kTokens: rate,
    overall: metricsOf(runs, loopCounts, rate),
    workflows: [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
      .map(([workflowId, list]) => ({
        workflowId,
        ...metricsOf(list, loopCounts, rate)
      })),
    alerts: [...grouped.entries()].flatMap(([workflowId, list]) => detectAnomalies(workflowId, list))
  };
}

function detectAnomalies(workflowId: string, runs: RunRecord[]): AnomalyAlert[] {
  const alerts: AnomalyAlert[] = [];
  const finished = runs.filter(
    (run) => run.status !== "queued" && run.status !== "running"
  );

  const recent = finished.slice(0, ANOMALY_RULES.failureWindow);
  if (recent.length >= ANOMALY_RULES.failureWindow) {
    const failed = recent.filter(
      (run) =>
        run.status === "failed" || run.status === "rolled_back" || run.status === "cancelled"
    ).length;
    const rate = failed / recent.length;
    if (failed >= 2 && rate >= ANOMALY_RULES.failureRateWarning) {
      alerts.push({
        workflowId,
        kind: "failure_spike",
        severity: rate >= ANOMALY_RULES.failureRateCritical ? "critical" : "warning",
        message: `最近 ${recent.length} 次运行失败 ${failed} 次（${(rate * 100).toFixed(0)}%），超过 ${(ANOMALY_RULES.failureRateWarning * 100).toFixed(0)}% 告警线`,
        value: round4(rate),
        threshold: ANOMALY_RULES.failureRateWarning,
        sampleSize: recent.length
      });
    }
  }

  const latestDuration = finished[0]?.durationMs;
  const baselineDurations = finished
    .slice(1, 1 + ANOMALY_RULES.latencyBaselineWindow)
    .map((run) => run.durationMs)
    .filter((value): value is number => typeof value === "number" && value > 0);
  if (
    typeof latestDuration === "number" &&
    latestDuration >= ANOMALY_RULES.latencyFloorMs &&
    baselineDurations.length >= ANOMALY_RULES.minSamples
  ) {
    const baseline = median(baselineDurations);
    const factor = baseline > 0 ? latestDuration / baseline : 0;
    if (factor >= ANOMALY_RULES.latencyFactorWarning) {
      alerts.push({
        workflowId,
        kind: "latency_spike",
        severity: factor >= ANOMALY_RULES.latencyFactorCritical ? "critical" : "warning",
        message: `最近一次耗时 ${Math.round(latestDuration)}ms，是前 ${baselineDurations.length} 次中位数 ${Math.round(baseline)}ms 的 ${factor.toFixed(1)} 倍`,
        value: round4(factor),
        threshold: ANOMALY_RULES.latencyFactorWarning,
        sampleSize: baselineDurations.length + 1
      });
    }
  }

  const recentScores = finished
    .slice(0, ANOMALY_RULES.scoreWindow)
    .map(scoreOf)
    .filter((score): score is number => typeof score === "number");
  const baselineScores = finished
    .slice(ANOMALY_RULES.scoreWindow, ANOMALY_RULES.scoreWindow + ANOMALY_RULES.scoreBaselineWindow)
    .map(scoreOf)
    .filter((score): score is number => typeof score === "number");
  if (
    recentScores.length >= ANOMALY_RULES.minSamples &&
    baselineScores.length >= ANOMALY_RULES.minSamples
  ) {
    const drop = avg(baselineScores) - avg(recentScores);
    if (drop >= ANOMALY_RULES.scoreDropWarning) {
      alerts.push({
        workflowId,
        kind: "score_drift",
        severity: drop >= ANOMALY_RULES.scoreDropCritical ? "critical" : "warning",
        message: `最近 ${recentScores.length} 次平均验证分 ${avg(recentScores).toFixed(2)}，比此前 ${baselineScores.length} 次的 ${avg(baselineScores).toFixed(2)} 下降 ${drop.toFixed(2)}`,
        value: round4(drop),
        threshold: ANOMALY_RULES.scoreDropWarning,
        sampleSize: recentScores.length + baselineScores.length
      });
    }
  }

  return alerts;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function metricsOf(
  runs: RunRecord[],
  loopCounts: Map<string, number>,
  rate: number
): RunMetrics {
  const n = runs.length;
  const succeeded = runs.filter((run) => run.status === "succeeded").length;
  const failed = runs.filter(
    (run) => run.status === "failed" || run.status === "rolled_back" || run.status === "cancelled"
  ).length;
  const scores = runs
    .map(scoreOf)
    .filter((score): score is number => typeof score === "number");
  const passed = runs.filter((run) => verifyPassedOf(run) === true).length;
  const durations = runs
    .map((run) => run.durationMs)
    .filter((duration): duration is number => typeof duration === "number")
    .sort((left, right) => left - right);
  const iterations = runs.map((run) => loopCounts.get(run.id) ?? 0);
  const tokens = runs.map(tokensOf);
  const tokensTotal = tokens.reduce((sum, value) => sum + value, 0);

  return {
    runCount: n,
    succeeded,
    failed,
    successRate: n === 0 ? 0 : succeeded / n,
    taskPassed: passed,
    taskRate: n === 0 ? 0 : passed / n,
    scoreAvg: scores.length === 0 ? null : round4(avg(scores)),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    stepsAvg: n === 0 ? 0 : round4(avg(runs.map((run) => run.stepCount))),
    iterationsAvg: n === 0 ? 0 : round4(avg(iterations)),
    tokensTotal,
    tokensAvg: n === 0 ? 0 : round4(tokensTotal / n),
    estimatedCost: round4((tokensTotal / 1000) * rate),
    modes: [...new Set(runs.map((run) => run.mode))]
  };
}

function scoreOf(run: RunRecord): number | undefined {
  const verify = run.output?.verify;
  if (typeof verify === "object" && verify !== null) {
    const score = (verify as Record<string, unknown>).score;
    if (typeof score === "number" && Number.isFinite(score)) {
      return score;
    }
  }
  const score = run.output?.score;
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}

function verifyPassedOf(run: RunRecord): boolean | undefined {
  const verify = run.output?.verify;
  if (typeof verify !== "object" || verify === null) {
    return undefined;
  }
  const passed = (verify as Record<string, unknown>).passed;
  return typeof passed === "boolean" ? passed : undefined;
}

function tokensOf(run: RunRecord): number {
  const tokens = run.output?.tokensUsed;
  return typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0;
}

function costRate(): number {
  const value = Number(process.env.PLATFORM_COST_PER_1K_TOKENS);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function percentile(sorted: number[], p: number) {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function avg(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round4(value: number) {
  return Number(value.toFixed(4));
}
