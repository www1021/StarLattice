import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  RotateCcw,
  XCircle
} from "lucide-react";
import { platformApi } from "./api";
import { isActiveRun, runStatusLabel, runStatusTone, stepStatusLabel } from "./layout";
import type { NodeKind, RunRecord, TraceResponse, WorkflowSummary } from "./types";
import "./platform.css";

type Banner = {
  tone: "info" | "success" | "error";
  text: string;
};

const NODE_KIND_LABELS: Record<NodeKind, string> = {
  agent: "Agent",
  tool: "工具",
  parallel: "并行",
  condition: "条件",
  loop: "循环",
  verify: "验证"
};

export function RunMonitorPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [trace, setTrace] = useState<TraceResponse>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<Banner>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string>();

  const workflowNames = useMemo(
    () => new Map(workflows.map((workflow) => [workflow.id, workflow.name])),
    [workflows]
  );
  const active =
    Boolean(trace && isActiveRun(trace.run.status)) ||
    runs.some((run) => isActiveRun(run.status));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [runResponse, workflowResponse] = await Promise.all([
          platformApi.listRuns(40),
          platformApi.listWorkflows()
        ]);
        if (cancelled) {
          return;
        }
        setRuns(runResponse.runs);
        setWorkflows(workflowResponse.workflows);
        setSelectedId(runResponse.runs[0]?.id);
      } catch (error) {
        if (!cancelled) {
          setBanner({ tone: "error", text: describe(error) });
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
    if (!selectedId) {
      setTrace(undefined);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    void platformApi
      .trace(selectedId)
      .then((value) => {
        if (cancelled) {
          return;
        }
        setTrace(value);
        setExpanded(new Set(value.steps.filter((step) => step.status === "failed").map((step) => step.id)));
      })
      .catch((error) => {
        if (!cancelled) {
          setBanner({ tone: "error", text: describe(error) });
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

  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => {
      void platformApi
        .listRuns(40)
        .then((response) => setRuns(response.runs))
        .catch(() => {
          // 轮询失败不覆盖页面上的既有记录
        });
      if (selectedId) {
        void platformApi
          .trace(selectedId)
          .then(setTrace)
          .catch(() => {
            // 同上
          });
      }
    }, 900);
    return () => window.clearInterval(timer);
  }, [active, selectedId]);

  async function refreshAll() {
    try {
      const [runResponse, workflowResponse] = await Promise.all([
        platformApi.listRuns(40),
        platformApi.listWorkflows()
      ]);
      setRuns(runResponse.runs);
      setWorkflows(workflowResponse.workflows);
      if (selectedId) {
        setTrace(await platformApi.trace(selectedId));
      }
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    }
  }

  function toggleStep(stepId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  }

  async function handleRetryRun() {
    if (!trace) {
      return;
    }
    setBusy("run");
    setBanner(undefined);
    try {
      const response = await platformApi.retryRun(trace.run.id);
      setRuns((current) => [response.run, ...current.filter((run) => run.id !== response.run.id)]);
      setSelectedId(response.run.id);
      setTrace(await platformApi.trace(response.run.id));
      setBanner({
        tone: "info",
        text: `已按原始输入创建重跑 ${shortId(response.run.id)}，原运行 ${shortId(trace.run.id)} 保持不变。`
      });
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function handleRetryStep(stepId: string) {
    if (!trace) {
      return;
    }
    setBusy(`step:${stepId}`);
    setBanner(undefined);
    try {
      const response = await platformApi.retryStep(trace.run.id, stepId);
      setTrace(response.trace);
      setExpanded((current) => new Set(current).add(response.step.id));
      setRuns((current) =>
        current.map((run) => (run.id === response.trace.run.id ? response.trace.run : run))
      );
      const succeeded = response.step.status === "succeeded";
      setBanner({
        tone: succeeded ? "success" : "error",
        text: `单步重跑 ${response.step.path} · ${stepStatusLabel(response.step.status)}；只追加一条记录，不改变原运行的最终状态与下游结果。`
      });
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setBusy(undefined);
    }
  }

  if (loading) {
    return (
      <div className="platform-page">
        <div className="platform-loading">
          <Loader2 size={18} className="is-spinning" />
          正在加载运行台账…
        </div>
      </div>
    );
  }

  return (
    <div className="platform-page monitor-page">
      <header className="platform-head">
        <div className="platform-head-main">
          <span className="platform-eyebrow">
            运行监控台
            {active && <em>实时刷新中</em>}
          </span>
          <h1>
            运行台账
            <span className="platform-version">{runs.length} 次运行</span>
          </h1>
          <p>按运行查看时间线、单步输入输出与错误堆栈；失败步骤可单步重跑，整单可按键重放。</p>
        </div>
        <div className="platform-head-actions">
          <span className={`monitor-live ${active ? "is-active" : ""}`}>
            {active ? <Loader2 size={13} className="is-spinning" /> : <CheckCircle2 size={13} />}
            {active ? "轮询中" : "已同步"}
          </span>
          <button type="button" className="platform-button is-ghost" onClick={() => void refreshAll()}>
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
      </header>

      {banner && (
        <div className={`platform-banner is-${banner.tone}`}>
          <div className="platform-banner-line">
            {banner.tone === "error" ? <XCircle size={15} /> : <CheckCircle2 size={15} />}
            <span>{banner.text}</span>
          </div>
        </div>
      )}

      <div className="monitor-body">
        <aside className="monitor-list" aria-label="运行记录">
          <header>
            <span>运行记录</span>
            <strong>{runs.length}</strong>
          </header>
          <div className="monitor-list-scroll">
            {runs.length === 0 && (
              <p className="monitor-list-empty">还没有运行记录，去「编排画布」跑一次。</p>
            )}
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className={`monitor-run ${run.id === selectedId ? "is-active" : ""}`}
                onClick={() => setSelectedId(run.id)}
              >
                <span className={`monitor-run-dot is-${runStatusTone(run.status)}`} />
                <span className="monitor-run-main">
                  <strong>{shortId(run.id)}</strong>
                  <small>
                    {workflowNames.get(run.workflowId) ?? run.workflowId} · {run.stepCount} 步
                  </small>
                </span>
                <span className="monitor-run-meta">
                  <span className={`platform-run-status is-${runStatusTone(run.status)}`}>
                    {runStatusLabel(run.status)}
                  </span>
                  <small>
                    {formatTime(run.startedAt)} · {run.durationMs ?? 0} ms
                  </small>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="monitor-detail">
          {!trace ? (
            <div className="platform-empty">
              <Activity size={20} />
              <strong>选择左侧一次运行</strong>
              <p>{detailLoading ? "正在读取执行轨迹…" : "轨迹包含步骤时间线、验证分数与循环轮次。"}</p>
            </div>
          ) : (
            <>
              <header className="monitor-detail-head">
                <div>
                  <span className="platform-inspector-kind">运行 {shortId(trace.run.id)}</span>
                  <h2>
                    {workflowNames.get(trace.run.workflowId) ?? trace.run.workflowId}
                    <span className="platform-version">v{trace.run.workflowVersion}</span>
                  </h2>
                  <p>
                    {formatDateTime(trace.run.startedAt)} 启动 · {trace.run.mode === "stub" ? "确定性 stub" : "真实 Agent"} ·
                    {" "}用时 {trace.run.durationMs ?? 0} ms
                  </p>
                </div>
                <div className="monitor-detail-actions">
                  <span className={`platform-run-status is-${runStatusTone(trace.run.status)}`}>
                    {runStatusLabel(trace.run.status)}
                  </span>
                  <button
                    type="button"
                    className="platform-button is-ghost"
                    onClick={() => void refreshAll()}
                  >
                    <RefreshCw size={14} />
                    刷新
                  </button>
                  <button
                    type="button"
                    className="platform-button is-primary"
                    onClick={() => void handleRetryRun()}
                    disabled={busy !== undefined || isActiveRun(trace.run.status)}
                    title="按原输入新建一次运行"
                  >
                    {busy === "run" ? (
                      <Loader2 size={14} className="is-spinning" />
                    ) : (
                      <RotateCcw size={14} />
                    )}
                    整单重跑
                  </button>
                </div>
              </header>

              {trace.run.error && (
                <div className="monitor-error-box">
                  <div>
                    <AlertTriangle size={14} />
                    运行失败
                  </div>
                  <pre>{trace.run.error}</pre>
                </div>
              )}

              <div className="monitor-summary">
                <div>
                  <span>步骤</span>
                  <strong>{trace.steps.length}</strong>
                </div>
                <div>
                  <span>最终评分</span>
                  <strong>{finalScoreOf(trace) === undefined ? "—" : finalScoreOf(trace)!.toFixed(2)}</strong>
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
                  <span>总耗时</span>
                  <strong>{trace.run.durationMs ?? 0} ms</strong>
                </div>
              </div>

              <section className="monitor-section">
                <div className="monitor-section-head">
                  <h3>执行时间线</h3>
                  <span>
                    {trace.steps.length} 条记录 · 失败 {trace.steps.filter((step) => step.status === "failed").length}
                  </span>
                </div>
                <div className="monitor-timeline">
                  {trace.steps.length === 0 && <p className="monitor-hint">尚未产生步骤记录。</p>}
                  {trace.steps.map((step) => {
                    const isExpanded = expanded.has(step.id);
                    return (
                      <article className={`monitor-step is-${step.status}`} key={step.id}>
                        <span className="monitor-step-dot" aria-hidden="true" />
                        <div className="monitor-step-card">
                          <div className="monitor-step-head">
                            <div>
                              <code>{step.path}</code>
                              <small>
                                #{step.sequence} · {NODE_KIND_LABELS[step.nodeKind] ?? step.nodeKind} ·{" "}
                                {step.durationMs ?? 0} ms · {formatTime(step.startedAt)}
                              </small>
                            </div>
                            <span className={`platform-step-status is-${step.status}`}>
                              {stepStatusLabel(step.status)}
                            </span>
                          </div>

                          {step.error && <pre className="monitor-step-error">{step.error}</pre>}

                          {isExpanded && (
                            <div className="monitor-io">
                              <label>
                                <span>输入</span>
                                <pre>{pretty(step.input)}</pre>
                              </label>
                              <label>
                                <span>输出</span>
                                <pre>{pretty(step.output)}</pre>
                              </label>
                            </div>
                          )}

                          <div className="monitor-step-actions">
                            <button type="button" className="platform-link" onClick={() => toggleStep(step.id)}>
                              {isExpanded ? "收起输入/输出" : "查看输入/输出"}
                            </button>
                            {step.status !== "running" && step.status !== "pending" && (
                              <button
                                type="button"
                                className="monitor-retry-step"
                                onClick={() => void handleRetryStep(step.id)}
                                disabled={busy !== undefined}
                                title="用同一路径和已解析输入再执行一次，只追加记录，不改动原运行"
                              >
                                {busy === `step:${step.id}` ? (
                                  <Loader2 size={11} className="is-spinning" />
                                ) : (
                                  <RotateCcw size={11} />
                                )}
                                单步重跑
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>

              {trace.verifyResults.length > 0 && (
                <section className="monitor-section">
                  <div className="monitor-section-head">
                    <h3>验证结果</h3>
                    <span>分数随循环变化</span>
                  </div>
                  <div className="monitor-verify-grid">
                    {trace.verifyResults.map((result, index) => (
                      <div className="monitor-verify" key={result.id}>
                        <div className="monitor-verify-head">
                          <strong>第 {index + 1} 次验证 · {result.score.toFixed(2)}</strong>
                          <span>置信度 {result.confidence.toFixed(2)}</span>
                        </div>
                        {result.dimensions.length > 0 && (
                          <div className="monitor-dims">
                            {result.dimensions.map((dimension) => (
                              <span key={`${result.id}-${dimension.name}`}>
                                {dimension.name} {dimension.score.toFixed(2)}
                              </span>
                            ))}
                          </div>
                        )}
                        {result.issues.length > 0 && (
                          <ul>
                            {result.issues.map((issue) => (
                              <li key={issue}>{issue}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {trace.loopIterations.length > 0 && (
                <section className="monitor-section">
                  <div className="monitor-section-head">
                    <h3>循环轮次</h3>
                    <span>{trace.loopIterations.length} 轮</span>
                  </div>
                  <div className="monitor-loops">
                    {trace.loopIterations.map((iteration) => (
                      <div className="monitor-loop" key={iteration.id}>
                        <strong>{iteration.loopNodeId}</strong>
                        <span>第 {iteration.iteration} 轮</span>
                        <span>
                          {iteration.scoreBefore === undefined ? "—" : iteration.scoreBefore.toFixed(2)} →{" "}
                          {iteration.scoreAfter === undefined ? "—" : iteration.scoreAfter.toFixed(2)}
                        </span>
                        <em>{iteration.action}</em>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="monitor-section">
                <div className="monitor-section-head">
                  <h3>运行输入</h3>
                  <span>只读</span>
                </div>
                <pre className="monitor-json">{pretty(trace.run.input)}</pre>
              </section>

              {trace.run.output && (
                <section className="monitor-section">
                  <div className="monitor-section-head">
                    <h3>运行输出</h3>
                    <span>终态摘要</span>
                  </div>
                  <pre className="monitor-json">{pretty(trace.run.output)}</pre>
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function finalScoreOf(trace: TraceResponse): number | undefined {
  const score = trace.run.output?.score;
  if (typeof score === "number") {
    return score;
  }
  const last = trace.verifyResults[trace.verifyResults.length - 1];
  return last?.score;
}

function shortId(id: string): string {
  return id.replace(/^run_/, "").slice(0, 8);
}

function formatTime(iso?: string): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDateTime(iso?: string): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${date.toLocaleTimeString("zh-CN", { hour12: false })}`;
}

function pretty(value: unknown): string {
  if (value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
