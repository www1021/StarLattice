import type { PlatformStateStore } from "../runtime/stateStore.js";
import type { WorkflowExecutor } from "../runtime/executor.js";
import { estimateTokens } from "../selfLoop/controller.js";
import type {
  EvaluationDataset,
  EvaluationRun,
  GateCaseResult,
  GateDecision,
  GatePolicy,
  GateStats,
  ReleaseManifest
} from "./types.js";
import { pairedBootstrap } from "./stats.js";
import { round4 } from "./util.js";

export type GateEvaluationOptions = {
  store: PlatformStateStore;
  executor: WorkflowExecutor;
  dataset: EvaluationDataset;
  base: ReleaseManifest;
  candidate: ReleaseManifest;
  candidateId: string;
  evalRunId: string;
  mode: "stub" | "live";
  policy: GatePolicy;
  /** 单次门禁最多评测的用例数，控制 live 成本。 */
  maxCases?: number;
};

/** 依次跑基线与候选两条臂；同一用例配对比较，避免不同样本造成的偏差。 */
export async function evaluateGate(options: GateEvaluationOptions): Promise<{
  evaluationRun: EvaluationRun;
  decision: GateDecision;
}> {
  const maxCases = Math.min(Math.max(options.maxCases ?? 8, 1), 30);
  const cases = options.dataset.cases.slice(0, maxCases);
  const perCase: GateCaseResult[] = [];
  let baseTokens = 0;
  let candidateTokens = 0;
  let baseErrors = 0;
  let candidateErrors = 0;

  for (const testCase of cases) {
    const base = await runArm(options, testCase.id, testCase.input, options.base, "control");
    const candidate = await runArm(options, testCase.id, testCase.input, options.candidate, "treatment");
    baseTokens += base.tokens;
    candidateTokens += candidate.tokens;
    if (base.status === "failed" || base.status === "rolled_back") {
      baseErrors += 1;
    }
    if (candidate.status === "failed" || candidate.status === "rolled_back") {
      candidateErrors += 1;
    }
    const delta =
      base.score !== undefined && candidate.score !== undefined
        ? round4(candidate.score - base.score)
        : undefined;
    perCase.push({
      caseId: testCase.id,
      title: testCase.title,
      baseScore: base.score,
      candidateScore: candidate.score,
      delta,
      baseStatus: base.status,
      candidateStatus: candidate.status,
      baseTokens: base.tokens,
      candidateTokens: candidate.tokens,
      threshold: testCase.threshold,
      target: options.policy.targetCaseIds.includes(testCase.id)
    });
  }

  const paired = perCase.filter(
    (item) => typeof item.baseScore === "number" && typeof item.candidateScore === "number"
  );
  const deltas = paired.map((item) => item.delta ?? 0);
  const bootstrap = pairedBootstrap(deltas, options.policy.confidence);
  const baseMean = mean(paired.map((item) => item.baseScore!));
  const candidateMean = mean(paired.map((item) => item.candidateScore!));
  const targets = perCase.filter((item) => item.target && item.delta !== undefined);
  const targetDelta = targets.length > 0 ? mean(targets.map((item) => item.delta!)) : undefined;
  const costIncreasePct =
    baseTokens === 0 ? 0 : round4((candidateTokens - baseTokens) / baseTokens);

  const stats: GateStats = {
    caseCount: perCase.length,
    pairedCount: paired.length,
    baseMean,
    candidateMean,
    meanDelta: round4(candidateMean - baseMean),
    ciLow: bootstrap.ciLow,
    ciHigh: bootstrap.ciHigh,
    win: deltas.filter((delta) => delta > 0.005).length,
    loss: deltas.filter((delta) => delta < -0.005).length,
    tie: deltas.filter((delta) => Math.abs(delta) <= 0.005).length,
    targetDelta,
    baseTokens,
    candidateTokens,
    costIncreasePct
  };

  const reasons = gateReasons(perCase, stats, options, baseErrors, candidateErrors);
  const decision: GateDecision = {
    passed: reasons.length === 0,
    reasons: reasons.length === 0 ? ["全部门禁通过。"] : reasons,
    policy: options.policy,
    stats,
    perCase,
    mode: options.mode,
    evaluatedAt: new Date().toISOString()
  };

  return {
    evaluationRun: {
      id: options.evalRunId,
      candidateId: options.candidateId,
      datasetId: options.dataset.id,
      baseReleaseId: options.base.id,
      candidateReleaseId: options.candidate.id,
      mode: options.mode,
      status: decision.passed ? "passed" : "failed",
      decision,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString()
    },
    decision
  };
}

async function runArm(
  options: GateEvaluationOptions,
  caseId: string,
  input: Record<string, unknown>,
  release: ReleaseManifest,
  arm: "control" | "treatment"
): Promise<{ status: string; score?: number; tokens: number }> {
  try {
    const view = await options.executor.run(release.artifact.workflow, input, {
      releaseId: release.id,
      experimentId: options.evalRunId,
      arm
    });
    const run = view.run;
    const verify = options.store.listVerifyResults(run.id).at(-1);
    const tokens = view.steps.reduce(
      (sum, step) => sum + estimateTokens(step.input) + estimateTokens(step.output),
      0
    );
    return { status: run.status, score: verify?.score, tokens };
  } catch (error) {
    return { status: "error", tokens: 0 };
  }
}

function gateReasons(
  perCase: GateCaseResult[],
  stats: GateStats,
  options: GateEvaluationOptions,
  baseErrors: number,
  candidateErrors: number
): string[] {
  const reasons: string[] = [];
  const policy = options.policy;
  if (stats.pairedCount < policy.minCases) {
    reasons.push(`可配对用例只有 ${stats.pairedCount} 个，少于门禁要求的 ${policy.minCases} 个。`);
  }
  if (
    perCase.filter((item) => item.baseScore !== undefined).length < policy.minCompletedPerArm ||
    perCase.filter((item) => item.candidateScore !== undefined).length < policy.minCompletedPerArm
  ) {
    reasons.push(`每条臂至少需要 ${policy.minCompletedPerArm} 个完成用例。`);
  }
  if (candidateErrors > baseErrors) {
    reasons.push(`候选臂失败 ${candidateErrors} 例，基线失败 ${baseErrors} 例，运行稳定性退化。`);
  }
  const worst = [...perCase]
    .filter((item) => item.delta !== undefined)
    .sort((left, right) => left.delta! - right.delta!)[0];
  if (worst && worst.delta! < -policy.maxCaseDrop) {
    reasons.push(
      `用例 ${worst.caseId} 退化 ${worst.delta!.toFixed(3)}，超过单例上限 ${policy.maxCaseDrop}。`
    );
  }
  if (stats.meanDelta < -policy.maxMeanDrop) {
    reasons.push(`平均分下降 ${(-stats.meanDelta).toFixed(3)}，超过上限 ${policy.maxMeanDrop}。`);
  }
  if (stats.ciLow < -policy.maxMeanDrop) {
    reasons.push(
      `配对 bootstrap 置信下界 ${stats.ciLow.toFixed(3)} 低于 -${policy.maxMeanDrop}，无法排除整体退化。`
    );
  }
  if (policy.targetCaseIds.length > 0) {
    if (stats.targetDelta === undefined) {
      reasons.push("目标用例没有同时得到基线与候选分数，无法验证提升。");
    } else if (stats.targetDelta < policy.minTargetDelta) {
      reasons.push(
        `目标用例平均提升 ${stats.targetDelta.toFixed(3)}，未达到 ${policy.minTargetDelta}。`
      );
    }
  } else if (stats.meanDelta < policy.minTargetDelta) {
    reasons.push(
      `未指定目标用例时要求整体平均提升 ≥ ${policy.minTargetDelta}，当前为 ${stats.meanDelta.toFixed(3)}。`
    );
  }
  if (stats.costIncreasePct > policy.maxCostIncreasePct) {
    reasons.push(
      `估算 token 成本上升 ${(stats.costIncreasePct * 100).toFixed(1)}%，超过 ${(policy.maxCostIncreasePct * 100).toFixed(0)}% 预算。`
    );
  }
  return reasons;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return round4(values.reduce((sum, value) => sum + value, 0) / values.length);
}
