import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  RefreshCw,
  XCircle
} from "lucide-react";
import { platformApi } from "./api";
import { runStatusLabel, runStatusTone, selfLoopActionLabel } from "./layout";
import type {
  MetricsReport,
  RunRecord,
  TraceResponse,
  VerifyCitationSummary,
  VerifyIndependence,
  VerifyLayers,
  VerifyResult,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowSummary
} from "./types";
import "./platform.css";

const STOP_REASON_LABELS: Record<string, string> = {
  passed: "达到阈值",
  max_iterations: "达到最大轮次",
  no_improvement: "连续无提升",
  budget_time: "超时预算",
  budget_tokens: "Token 预算耗尽",
  while_false: "循环条件不再满足"
};

type LoopSummaryView = {
  loopNodeId?: string;
  iterations?: number;
  threshold?: number;
  initialScore?: number;
  finalScore?: number;
  bestScore?: number;
  bestIteration?: number;
  stopReason?: string;
  tokensUsed?: number;
  elapsedMs?: number;
};

type VerifySummary = {
  score?: number;
  confidence?: number;
  passed?: boolean;
};

export function VerifyReportPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [metrics, setMetrics] = useState<MetricsReport>();
  const [workflowFilter, setWorkflowFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [trace, setTrace] = useState<TraceResponse>();
  const [definition, setDefinition] = useState<WorkflowDefinition>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string>();

  const workflowNames = useMemo(
    () => new Map(workflows.map((workflow) => [workflow.id, workflow.name])),
    [workflows]
  );
  const visibleRuns = useMemo(
    () =>
      workflowFilter
        ? runs.filter((run) => run.workflowId === workflowFilter)
        : runs,
    [runs, workflowFilter]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [runResponse, workflowResponse, metricsResponse] = await Promise.all([
          platformApi.listRuns(60),
          platformApi.listWorkflows(),
          platformApi.metricsSummary(undefined, 500)
        ]);
        if (cancelled) {
          return;
        }
        setRuns(runResponse.runs);
        setWorkflows(workflowResponse.workflows);
        setMetrics(metricsResponse);
        setSelectedId(pickInitialRun(runResponse.runs)?.id);
      } catch (caught) {
        if (!cancelled) {
          setError(describe(caught));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void platformApi
      .metricsSummary(workflowFilter || undefined, 500)
      .then((value) => {
        if (!cancelled) {
          setMetrics(value);
        }
      })
      .catch(() => {
        // 指标失败不覆盖已展示的报告
      });
    return () => {
      cancelled = true;
    };
  }, [workflowFilter]);

  useEffect(() => {
    if (!workflowFilter) {
      return;
    }
    const stillVisible = runs.some(
      (run) => run.id === selectedId && run.workflowId === workflowFilter
    );
    if (!stillVisible) {
      setSelectedId(runs.find((run) => run.workflowId === workflowFilter)?.id);
    }
  }, [workflowFilter, runs, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setTrace(undefined);
      setDefinition(undefined);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void platformApi
      .trace(selectedId)
      .then(async (nextTrace) => {
        if (cancelled) {
          return;
        }
        setTrace(nextTrace);
        try {
          const response = await platformApi.getWorkflow(nextTrace.run.workflowId);
          if (!cancelled) {
            setDefinition(response.workflow.definition);
          }
        } catch {
          if (!cancelled) {
            setDefinition(undefined);
          }
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(describe(caught));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  async function refresh() {
    setError(undefined);
    try {
      const [runResponse, metricsResponse] = await Promise.all([
        platformApi.listRuns(60),
        platformApi.metricsSummary(workflowFilter || undefined, 500)
      ]);
      setRuns(runResponse.runs);
      setMetrics(metricsResponse);
      if (selectedId) {
        setTrace(await platformApi.trace(selectedId));
      }
    } catch (caught) {
      setError(describe(caught));
    }
  }

  if (loading) {
    return (
      <div className="platform-page">
        <div className="platform-loading">
          <Loader2 size={18} className="is-spinning" />
          正在加载验证台账…
        </div>
      </div>
    );
  }

  const summary = trace ? verifySummaryOf(trace) : undefined;
  const retained = trace ? retainedVerifyOf(trace, summary?.score) : undefined;
  const threshold =
    definition && retained
      ? thresholdOf(definition.nodes, retained.dimensions.map((dimension) => dimension.name))
      : undefined;
  const layers = trace ? layersOf(trace, retained) : undefined;
  const independence = trace ? independenceOf(trace, retained) : undefined;
  const citations = trace ? citationsOf(trace, retained) : undefined;
  const passed =
    summary?.passed ??
    (summary?.score !== undefined && threshold !== undefined
      ? summary.score >= threshold
      : undefined);
  const loops = trace ? loopSummariesOf(trace) : [];

  return (
    <div className="platform-page report-page">
      <header className="platform-head">
        <div className="platform-head-main">
          <span className="platform-eyebrow">
            验证报告
            <em>三层验证 · 自循环 · 批量指标</em>
          </span>
          <h1>
            验证交付物
            <span className="platform-version">{runs.length} 次运行</span>
          </h1>
          <p>按运行查看最终保留产物的验证结论、三维明细与循环前后对比，并按工作流汇总批量指标。</p>
        </div>
        <div className="platform-head-actions">
          <span className="monitor-live">
            {metrics ? <CheckCircle2 size={13} /> : <Loader2 size={13} className="is-spinning" />}
            {metrics ? "指标已同步" : "指标同步中"}
          </span>
          <button type="button" className="platform-button is-ghost" onClick={() => void refresh()}>
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
      </header>

      {error && (
        <div className="platform-banner is-error">
          <div className="platform-banner-line">
            <XCircle size={15} />
            <span>{error}</span>
          </div>
        </div>
      )}

      <div className="report-toolbar">
        <label htmlFor="report-workflow">
          <span>工作流</span>
          <select
            id="report-workflow"
            className="platform-select"
            value={workflowFilter}
            onChange={(event) => setWorkflowFilter(event.target.value)}
          >
            <option value="">全部工作流</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="report-run">
          <span>运行</span>
          <select
            id="report-run"
            className="platform-select report-run-select"
            value={selectedId ?? ""}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            {visibleRuns.length === 0 && <option value="">暂无运行</option>}
            {visibleRuns.map((run) => (
              <option key={run.id} value={run.id}>
                {shortId(run.id)} · {workflowNames.get(run.workflowId) ?? run.workflowId} ·{" "}
                {formatDateTime(run.startedAt)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="report-body">
        {runs.length === 0 ? (
          <div className="platform-empty">
            <ClipboardCheck size={20} />
            <strong>还没有可验证的运行</strong>
            <p>去「编排画布」启动一次工作流，验证结论会出现在这里。</p>
          </div>
        ) : !trace ? (
          <div className="platform-empty">
            <ClipboardCheck size={20} />
            <strong>选择一次运行</strong>
            <p>{detailLoading ? "正在读取验证记录…" : "报告包含最终保留产物、维度分与三层验证明细。"}</p>
          </div>
        ) : (
          <>
            <section className={`report-verdict ${verdictTone(passed)}`}>
              <div>
                <span className="report-verdict-label">验证结论</span>
                <strong>
                  {passed === true
                    ? "达到验证阈值"
                    : passed === false
                      ? "未达到验证阈值"
                      : "本次运行没有验证结论"}
                </strong>
                <p>
                  {summary?.score === undefined
                    ? "该运行未经过验证节点，无法给出分数。"
                    : `最终保留产物验证分 ${summary.score.toFixed(3)}${
                        threshold === undefined ? "" : ` · 阈值 ${threshold.toFixed(2)}`
                      }${
                        retained
                          ? ` · 保留第 ${
                              indexOfVerify(trace, retained) + 1
                            }/${trace.verifyResults.length} 次验证记录`
                          : ""
                      }`}
                </p>
              </div>
              <div className="report-verdict-score">
                <strong>{summary?.score === undefined ? "—" : summary.score.toFixed(3)}</strong>
                <small>置信度 {summary?.confidence === undefined ? "—" : summary.confidence.toFixed(2)}</small>
              </div>
            </section>

            <div className="monitor-summary report-summary">
              <div>
                <span>运行状态</span>
                <strong className={`report-status is-${runStatusTone(trace.run.status)}`}>
                  {runStatusLabel(trace.run.status)}
                </strong>
              </div>
              <div>
                <span>验证次数</span>
                <strong>{trace.verifyResults.length}</strong>
              </div>
              <div>
                <span>循环轮次</span>
                <strong>{trace.loopIterations.length}</strong>
              </div>
              <div>
                <span>步骤</span>
                <strong>{trace.steps.length}</strong>
              </div>
              <div>
                <span>Token</span>
                <strong>{formatNumber(numberOf(trace.run.output?.tokensUsed) ?? 0)}</strong>
              </div>
              <div>
                <span>总耗时</span>
                <strong>{formatDuration(trace.run.durationMs)}</strong>
              </div>
            </div>

            <div className="report-columns">
              <section className="report-card">
                <div className="monitor-section-head">
                  <h3>维度得分</h3>
                  <span>{retained?.dimensions.length ?? 0} 个维度</span>
                </div>
                {retained && retained.dimensions.length > 0 ? (
                  <div className="report-dims">
                    {retained.dimensions.map((dimension) => (
                      <div className="report-dim" key={dimension.name}>
                        <span className="report-dim-name">{dimension.name}</span>
                        <span className="report-dim-bar" aria-hidden="true">
                          <i style={{ width: `${barWidth(dimension.score)}%` }} />
                        </span>
                        <strong>{dimension.score.toFixed(2)}</strong>
                        {dimension.comment && (
                          <small className="report-dim-comment">{dimension.comment}</small>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="monitor-hint">该运行未记录维度分。</p>
                )}
              </section>

              <section className="report-card">
                <div className="monitor-section-head">
                  <h3>问题与证据</h3>
                  <span>{retained?.issues.length ?? 0} 个问题</span>
                </div>
                {retained ? (
                  <>
                    {retained.issues.length > 0 ? (
                      <ul className="report-issues">
                        {retained.issues.map((issue) => (
                          <li key={issue}>
                            <AlertTriangle size={12} />
                            <span>{issue}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="report-ok">
                        <CheckCircle2 size={13} />
                        没有阻断性问题
                      </p>
                    )}
                    {retained.evidence.length > 0 ? (
                      <ul className="report-evidence">
                        {retained.evidence.map((item, index) => (
                          <li key={`${index}-${item}`}>{item}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="monitor-hint">未记录证据引用。</p>
                    )}
                  </>
                ) : (
                  <p className="monitor-hint">没有可展示的验证记录。</p>
                )}
              </section>
            </div>

            <section className="report-card">
              <div className="monitor-section-head">
                <h3>三层验证</h3>
                <span>规则 → 交叉 → 基准</span>
              </div>
              {layers ? (
                <div className="report-layer-grid">
                  <article className="report-layer">
                    <header>
                      <strong>规则层</strong>
                      <span>{layers.rule.score.toFixed(2)}</span>
                    </header>
                    <ul className="report-checks">
                      {layers.rule.checks.map((check) => (
                        <li key={check.key} className={check.passed ? "" : "is-failed"}>
                          {check.passed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                          <span>
                            {check.label}
                            {check.detail ? ` · ${check.detail}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                    {layers.rule.checks.length === 0 && <p className="monitor-hint">无规则检查项。</p>}
                  </article>

                  <article className="report-layer">
                    <header>
                      <strong>交叉验证层</strong>
                      <span>{layers.crossCheck.score.toFixed(2)}</span>
                    </header>
                    <p className="report-layer-meta">
                      {layers.crossCheck.verifiers.length} 名验证器 · 分歧{" "}
                      {layers.crossCheck.spread.toFixed(2)} ·{" "}
                      {layers.crossCheck.agreement ? "结论一致" : "存在分歧"}
                    </p>
                    {independence && (
                      <p className="report-layer-meta">
                        独立性：{independenceLabel(independence.level)}
                        {independence.models.length > 0
                          ? ` · ${independence.models.join(" / ")}`
                          : ""}
                        {independence.heuristicFallback ? " · 已回退启发式打分" : ""}
                      </p>
                    )}
                    {citations && (
                      <p className="report-layer-meta">
                        正文引用 {citations.total} 条 · 可追溯 {citations.valid} · 无法绑定{" "}
                        {citations.missing} · 证据池 {citations.pool}
                      </p>
                    )}
                    <ul className="report-verifiers">
                      {layers.crossCheck.verifiers.map((verifier) => (
                        <li key={verifier.agentId}>
                          <span>
                            {verifier.agentName}
                            {verifier.resolvedModel && <small> · {verifier.resolvedModel}</small>}
                            {verifier.evidenceView && (
                              <small>
                                {" "}
                                · {verifier.evidenceView === "cited" ? "引用内证据" : "完整证据池"}
                              </small>
                            )}
                            {verifier.fallback && <small> · 启发式回退</small>}
                          </span>
                          <strong>{verifier.score.toFixed(2)}</strong>
                        </li>
                      ))}
                    </ul>
                    {layers.crossCheck.verifiers.length === 0 && (
                      <p className="monitor-hint">未配置交叉验证器。</p>
                    )}
                  </article>

                  <article className="report-layer">
                    <header>
                      <strong>基准层</strong>
                      <span>{layers.baseline.score.toFixed(2)}</span>
                    </header>
                    <p className="report-layer-meta">
                      基准覆盖率 {layers.baseline.coverage.toFixed(2)}
                    </p>
                    <div className="report-tags">
                      {layers.baseline.matched.map((item) => (
                        <span key={`matched-${item}`}>{item}</span>
                      ))}
                      {layers.baseline.missing.map((item) => (
                        <span className="is-missing" key={`missing-${item}`}>
                          缺 {item}
                        </span>
                      ))}
                    </div>
                    {layers.baseline.matched.length + layers.baseline.missing.length === 0 && (
                      <p className="monitor-hint">未配置基准要点。</p>
                    )}
                  </article>
                </div>
              ) : (
                <p className="monitor-hint">该运行未记录三层验证明细。</p>
              )}
            </section>

            <section className="report-card">
              <div className="monitor-section-head">
                <h3>自循环对比</h3>
                <span>{trace.loopIterations.length} 轮迭代</span>
              </div>
              {loops.map((loop, index) => (
                <p className="monitor-loop-retention" key={`${loop.loopNodeId ?? "loop"}-${index}`}>
                  {retentionText(loop)}
                </p>
              ))}
              {trace.loopIterations.length > 0 ? (
                <div className="report-loops">
                  {trace.loopIterations.map((iteration) => {
                    const summaryForLoop = loops.find(
                      (loop) => loop.loopNodeId === iteration.loopNodeId
                    );
                    const isRetained = summaryForLoop?.bestIteration === iteration.iteration;
                    return (
                      <article
                        className={`report-loop ${isRetained ? "is-retained" : ""}`}
                        key={iteration.id}
                      >
                        <div className="report-loop-head">
                          <code>{iteration.loopNodeId}</code>
                          <span>第 {iteration.iteration} 轮</span>
                          <span className="report-loop-score">
                            {iteration.scoreBefore === undefined
                              ? "—"
                              : iteration.scoreBefore.toFixed(2)}{" "}
                            →{" "}
                            {iteration.scoreAfter === undefined
                              ? "—"
                              : iteration.scoreAfter.toFixed(2)}
                          </span>
                          <em>{selfLoopActionLabel(iteration.action)}</em>
                          {iteration.modelBefore &&
                            iteration.modelAfter &&
                            iteration.modelBefore !== iteration.modelAfter && (
                              <span>
                                模型 {iteration.modelBefore} → {iteration.modelAfter}
                              </span>
                            )}
                          {isRetained && <span className="report-loop-badge">已保留</span>}
                        </div>
                        {iteration.changes && iteration.changes.length > 0 && (
                          <ul className="report-loop-changes">
                            {iteration.changes.map((change) => (
                              <li key={`${iteration.id}-${change}`}>{change}</li>
                            ))}
                          </ul>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="monitor-hint">本次运行未进入自循环，初始产物直接达标或未配置循环。</p>
              )}
            </section>

            <section className="report-card">
              <div className="monitor-section-head">
                <h3>批量指标</h3>
                <span>
                  {metrics ? `生成于 ${formatDateTime(metrics.generatedAt)}` : "加载中"}
                  {metrics && ` · 单价 ${metrics.costRatePer1kTokens > 0
                    ? `¥${metrics.costRatePer1kTokens}/1k tokens`
                    : "未配置"}`}
                </span>
              </div>
              {metrics ? (
                <>
                  <div className="report-alerts">
                    {metrics.alerts.length === 0 ? (
                      <p className="monitor-hint">最近运行未触发异常阈值（失败率、延迟突增、验证分漂移）。</p>
                    ) : (
                      metrics.alerts.map((alert, index) => (
                        <div
                          className={`report-alert is-${alert.severity}`}
                          key={`${alert.workflowId}-${alert.kind}-${index}`}
                        >
                          <strong>{alert.severity === "critical" ? "严重异常" : "异常预警"}</strong>
                          <span>
                            {workflowNames.get(alert.workflowId) ?? alert.workflowId}：{alert.message}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="report-metrics-overall">
                    <Metric label="运行数" value={String(metrics.overall.runCount)} />
                    <Metric label="成功率" value={formatPercent(metrics.overall.successRate)} />
                    <Metric label="任务达标率" value={formatPercent(metrics.overall.taskRate)} />
                    <Metric
                      label="平均验证分"
                      value={
                        metrics.overall.scoreAvg === null
                          ? "—"
                          : metrics.overall.scoreAvg.toFixed(3)
                      }
                    />
                    <Metric label="P95 延迟" value={formatDuration(metrics.overall.p95Ms)} />
                    <Metric
                      label="估算成本"
                      value={
                        metrics.costRatePer1kTokens > 0
                          ? `¥${metrics.overall.estimatedCost.toFixed(2)}`
                          : "未配置单价"
                      }
                    />
                  </div>
                  <div className="report-metric-cards">
                    {metrics.workflows.map((workflow) => (
                      <article className="report-metric-card" key={workflow.workflowId}>
                        <header>
                          <strong>
                            {workflowNames.get(workflow.workflowId) ?? workflow.workflowId}
                          </strong>
                          <small>{workflow.modes.join(" / ") || "—"}</small>
                        </header>
                        <div className="report-metric-grid">
                          <Metric label="运行" value={String(workflow.runCount)} />
                          <Metric label="成功率" value={formatPercent(workflow.successRate)} />
                          <Metric label="达标率" value={formatPercent(workflow.taskRate)} />
                          <Metric
                            label="平均分"
                            value={
                              workflow.scoreAvg === null ? "—" : workflow.scoreAvg.toFixed(3)
                            }
                          />
                          <Metric label="P50" value={formatDuration(workflow.p50Ms)} />
                          <Metric label="P95" value={formatDuration(workflow.p95Ms)} />
                          <Metric label="平均步骤" value={workflow.stepsAvg.toFixed(1)} />
                          <Metric label="平均轮次" value={workflow.iterationsAvg.toFixed(1)} />
                          <Metric
                            label="平均 Tokens"
                            value={formatNumber(Math.round(workflow.tokensAvg))}
                          />
                        </div>
                      </article>
                    ))}
                  </div>
                  {metrics.workflows.length === 0 && (
                    <p className="monitor-hint">当前筛选条件下还没有运行记录。</p>
                  )}
                </>
              ) : (
                <p className="monitor-hint">指标加载失败，稍后刷新重试。</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function pickInitialRun(runs: RunRecord[]): RunRecord | undefined {
  return runs.find((run) => hasVerify(run)) ?? runs[0];
}

function hasVerify(run: RunRecord): boolean {
  const verify = asRecord(run.output?.verify);
  return verify !== undefined && numberOf(verify.score) !== undefined;
}

function verifySummaryOf(trace: TraceResponse): VerifySummary {
  const verify = asRecord(trace.run.output?.verify);
  return {
    score: numberOf(verify?.score),
    confidence: numberOf(verify?.confidence),
    passed: typeof verify?.passed === "boolean" ? verify.passed : undefined
  };
}

function retainedVerifyOf(trace: TraceResponse, score?: number): VerifyResult | undefined {
  const results = trace.verifyResults;
  if (results.length === 0) {
    return undefined;
  }
  if (score === undefined) {
    return results[results.length - 1];
  }
  return results.find((result) => Math.abs(result.score - score) < 1e-6) ?? results[results.length - 1];
}

function indexOfVerify(trace: TraceResponse, target: VerifyResult): number {
  const index = trace.verifyResults.findIndex((result) => result.id === target.id);
  return index < 0 ? trace.verifyResults.length - 1 : index;
}

function layersOf(trace: TraceResponse, retained?: VerifyResult): VerifyLayers | undefined {
  if (retained?.detail?.layers) {
    return retained.detail.layers;
  }
  const layers = asRecord(asRecord(trace.run.output?.verify)?.layers);
  return isLayers(layers) ? layers : undefined;
}

function independenceOf(
  trace: TraceResponse,
  retained?: VerifyResult
): VerifyIndependence | undefined {
  const value =
    retained?.detail?.independence ?? asRecord(asRecord(trace.run.output?.verify)?.independence);
  return isIndependence(value) ? value : undefined;
}

function citationsOf(
  trace: TraceResponse,
  retained?: VerifyResult
): VerifyCitationSummary | undefined {
  const value =
    retained?.detail?.citations ?? asRecord(asRecord(trace.run.output?.verify)?.citations);
  return isCitations(value) ? value : undefined;
}

function isIndependence(value: unknown): value is VerifyIndependence {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.level === "string" &&
    Array.isArray(record.models) &&
    Array.isArray(record.providers)
  );
}

function isCitations(value: unknown): value is VerifyCitationSummary {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record.total === "number" &&
    typeof record.valid === "number" &&
    typeof record.missing === "number"
  );
}

function independenceLabel(level: VerifyIndependence["level"]): string {
  switch (level) {
    case "cross-provider":
      return "跨供应商独立";
    case "model":
      return "模型级独立";
    case "evidence":
      return "证据级独立";
    default:
      return "提示词级交叉";
  }
}

function isLayers(value: unknown): value is VerifyLayers {
  const record = asRecord(value);
  return (
    record !== undefined &&
    asRecord(record.rule) !== undefined &&
    asRecord(record.crossCheck) !== undefined &&
    asRecord(record.baseline) !== undefined
  );
}

function thresholdOf(nodes: WorkflowNode[], dimensions: string[]): number | undefined {
  const verifyNodes = collectVerifyNodes(nodes);
  if (verifyNodes.length === 0) {
    return undefined;
  }
  const names = new Set(dimensions);
  let best: WorkflowNode | undefined;
  let bestOverlap = -1;
  for (const node of verifyNodes) {
    const overlap = (node.rubric ?? []).filter((name) => names.has(name)).length;
    if (overlap > bestOverlap) {
      best = node;
      bestOverlap = overlap;
    }
  }
  return best?.threshold;
}

function collectVerifyNodes(nodes: WorkflowNode[], acc: WorkflowNode[] = []): WorkflowNode[] {
  for (const node of nodes) {
    if (node.kind === "verify") {
      acc.push(node);
    }
    collectVerifyNodes(node.branches ?? [], acc);
    collectVerifyNodes(node.then ?? [], acc);
    collectVerifyNodes(node.else ?? [], acc);
    collectVerifyNodes(node.body ?? [], acc);
  }
  return acc;
}

function loopSummariesOf(trace: TraceResponse): LoopSummaryView[] {
  const value = trace.run.output?.selfLoop;
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is LoopSummaryView => asRecord(item) !== undefined);
}

function retentionText(loop: LoopSummaryView): string {
  const kept =
    loop.bestIteration === 0
      ? "初始产物"
      : typeof loop.bestIteration === "number"
        ? `第 ${loop.bestIteration} 轮产物`
        : "最优产物";
  const score =
    typeof loop.finalScore === "number" ? `，保留分 ${loop.finalScore.toFixed(2)}` : "";
  const stop = loop.stopReason ? `，停止原因：${STOP_REASON_LABELS[loop.stopReason] ?? loop.stopReason}` : "";
  const rounds = typeof loop.iterations === "number" ? `（循环 ${loop.iterations} 轮）` : "";
  return `保留${kept}${score}${rounds}${stop}；被丢弃轮次的验证记录仍保留在证据中。`;
}

function verdictTone(passed?: boolean): string {
  if (passed === true) {
    return "is-passed";
  }
  if (passed === false) {
    return "is-failed";
  }
  return "is-neutral";
}

function barWidth(score: number): number {
  return Math.round(Math.min(1, Math.max(0, score)) * 100);
}

function shortId(id: string): string {
  return id.replace(/^run_/, "").slice(0, 8);
}

function formatDateTime(iso?: string): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${date.toLocaleTimeString("zh-CN", {
    hour12: false
  })}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatDuration(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "—";
  }
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
