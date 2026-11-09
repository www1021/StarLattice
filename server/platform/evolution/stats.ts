import { mulberry32, round4, seedFromString } from "./util.js";

export type PairedBootstrap = {
  count: number;
  mean: number;
  ciLow: number;
  ciHigh: number;
};

/**
 * 配对差值的 percentile bootstrap。样本少时只报告区间，不把"平均值略高"
 * 当成显著提升；区间下界用于非劣性判定。
 */
export function pairedBootstrap(
  deltas: number[],
  confidence = 0.95,
  iterations = 2000,
  seed = "paired-bootstrap"
): PairedBootstrap {
  const values = deltas.filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    return { count: 0, mean: 0, ciLow: 0, ciHigh: 0 };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) {
    return { count: 1, mean: round4(mean), ciLow: round4(mean), ciHigh: round4(mean) };
  }
  const random = mulberry32(seedFromString(seed));
  const means: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) {
      sum += values[Math.floor(random() * values.length)];
    }
    means.push(sum / values.length);
  }
  means.sort((left, right) => left - right);
  const alpha = (1 - clampConfidence(confidence)) / 2;
  const lowIndex = Math.floor(alpha * (means.length - 1));
  const highIndex = Math.ceil((1 - alpha) * (means.length - 1));
  return {
    count: values.length,
    mean: round4(mean),
    ciLow: round4(means[lowIndex]),
    ciHigh: round4(means[highIndex])
  };
}

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) {
    return 0.95;
  }
  return Math.min(0.999, Math.max(0.5, value));
}
