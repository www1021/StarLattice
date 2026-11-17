/**
 * 试卷质量测量：难度 P 与区分度 D 的确定性计算。
 *
 * 口径遵循教育测量学通行做法：
 * - 难度 P = 该题全体平均得分 / 该题满分。P 越大题目越容易。
 * - 区分度 D = (高分组平均得分 - 低分组平均得分) / 该题满分。高分组与低分组
 *   通常各取总分前后 27%，这里由调用方传入两组的平均分。
 *
 * 刻意不输出信度：信度需要原始逐人作答矩阵，平台只拿到分组均值，
 * 用这些数据估算出来的信度是伪指标，宁可不说。
 */

export type PsychometricsItemInput = {
  id: string;
  fullScore: number;
  highGroupAvg: number;
  lowGroupAvg: number;
  /** 缺省时取高分组与低分组的均值。 */
  overallAvg?: number;
  level?: string;
};

export type PsychometricsOptions = {
  difficultyRange?: number[];
  discriminationMin?: number;
};

export type PsychometricsItemResult = {
  id: string;
  fullScore: number;
  difficulty: number;
  difficultyBand: string;
  discrimination: number;
  level: string;
  verdict: "保留" | "返工";
  reasons: string[];
};

export type PsychometricsResult = {
  paper: {
    itemCount: number;
    totalScore: number;
    avgScore: number;
    difficulty: number;
    discrimination: number;
    difficultyRange: [number, number];
    discriminationMin: number;
    passed: boolean;
  };
  items: PsychometricsItemResult[];
  distribution: Record<string, number>;
  levelCoverage: Record<string, number>;
  rework: string[];
  summary: string;
};

const DEFAULT_DIFFICULTY_RANGE: [number, number] = [0.55, 0.75];
const DEFAULT_DISCRIMINATION_MIN = 0.3;

function round(value: number): number {
  return Number(value.toFixed(3));
}

function bandOf(difficulty: number): string {
  if (difficulty < 0.3) return "过难";
  if (difficulty < 0.5) return "偏难";
  if (difficulty <= 0.75) return "适中";
  if (difficulty <= 0.85) return "偏易";
  return "过易";
}

/** 把外部传入的原始数组过滤成可用条目，非法项直接丢弃而不是报错中断。 */
export function normalizeItems(raw: unknown): PsychometricsItemInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      const fullScore = Number(item.fullScore);
      const highGroupAvg = Number(item.highGroupAvg);
      const lowGroupAvg = Number(item.lowGroupAvg);
      const overallRaw = Number(item.overallAvg);
      return {
        id: String(item.id ?? "").trim(),
        fullScore,
        highGroupAvg,
        lowGroupAvg,
        overallAvg: Number.isFinite(overallRaw) ? overallRaw : (highGroupAvg + lowGroupAvg) / 2,
        level: typeof item.level === "string" && item.level.trim() ? item.level.trim() : "未标注"
      };
    })
    .filter(
      (item) =>
        item.id &&
        Number.isFinite(item.fullScore) &&
        item.fullScore > 0 &&
        Number.isFinite(item.highGroupAvg) &&
        Number.isFinite(item.lowGroupAvg)
    );
}

export function computePsychometrics(
  items: PsychometricsItemInput[],
  options: PsychometricsOptions = {}
): PsychometricsResult {
  if (items.length === 0) {
    throw new Error("没有可用的题目数据，请为每题提供 id、fullScore、highGroupAvg、lowGroupAvg。");
  }
  const range = options.difficultyRange ?? [];
  const pLow = Number.isFinite(range[0]) ? range[0] : DEFAULT_DIFFICULTY_RANGE[0];
  const pHigh = Number.isFinite(range[1]) ? range[1] : DEFAULT_DIFFICULTY_RANGE[1];
  const dMin =
    typeof options.discriminationMin === "number"
      ? options.discriminationMin
      : DEFAULT_DISCRIMINATION_MIN;

  const results: PsychometricsItemResult[] = items.map((item) => {
    const difficulty = round((item.overallAvg ?? (item.highGroupAvg + item.lowGroupAvg) / 2) / item.fullScore);
    const discrimination = round((item.highGroupAvg - item.lowGroupAvg) / item.fullScore);
    const reasons: string[] = [];
    if (difficulty < pLow) {
      reasons.push(`难度 ${difficulty} 低于下限 ${pLow}，整题偏难`);
    } else if (difficulty > pHigh) {
      reasons.push(`难度 ${difficulty} 高于上限 ${pHigh}，整题偏易`);
    }
    if (discrimination < dMin) {
      reasons.push(`区分度 ${discrimination} 低于下限 ${dMin}，无法有效区分学力`);
    }
    return {
      id: item.id,
      fullScore: item.fullScore,
      difficulty,
      difficultyBand: bandOf(difficulty),
      discrimination,
      level: item.level ?? "未标注",
      verdict: reasons.length === 0 ? "保留" : "返工",
      reasons
    };
  });

  const totalScore = round(items.reduce((sum, item) => sum + item.fullScore, 0));
  const avgScore = round(
    items.reduce((sum, item) => sum + (item.overallAvg ?? (item.highGroupAvg + item.lowGroupAvg) / 2), 0)
  );
  const paperDifficulty = round(avgScore / totalScore);
  const paperDiscrimination = round(
    items.reduce((sum, item) => sum + (item.highGroupAvg - item.lowGroupAvg), 0) / totalScore
  );

  const distribution = results.reduce<Record<string, number>>((acc, item) => {
    acc[item.difficultyBand] = (acc[item.difficultyBand] ?? 0) + 1;
    return acc;
  }, {});
  const levelCoverage = results.reduce<Record<string, number>>((acc, item) => {
    acc[item.level] = (acc[item.level] ?? 0) + 1;
    return acc;
  }, {});
  const rework = results.filter((item) => item.verdict === "返工").map((item) => item.id);
  const passed =
    rework.length === 0 &&
    paperDifficulty >= pLow &&
    paperDifficulty <= pHigh &&
    paperDiscrimination >= dMin;

  return {
    paper: {
      itemCount: results.length,
      totalScore,
      avgScore,
      difficulty: paperDifficulty,
      discrimination: paperDiscrimination,
      difficultyRange: [pLow, pHigh],
      discriminationMin: dMin,
      passed
    },
    items: results,
    distribution,
    levelCoverage,
    rework,
    summary: passed
      ? `整卷难度 ${paperDifficulty}、平均区分度 ${paperDiscrimination}，${results.length} 题全部达标，可直接定稿。`
      : `整卷难度 ${paperDifficulty}、平均区分度 ${paperDiscrimination}，需返工 ${rework.length} 题（${rework.join("、")}）。`
  };
}
