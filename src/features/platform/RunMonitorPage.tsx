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
import {
  isActiveRun,
  runStatusLabel,
  runStatusTone,
  selfLoopActionLabel,
  stepStatusLabel
} from "./layout";
import type {
  ApprovalDecision,
  ApprovalRecord,
  NodeKind,
  RunRecord,
  TraceResponse,
  WorkflowSummary
} from "./types";
import "./platform.css";

type Banner = {
  tone: "info" | "success" | "error";
  text: string;
};

const NODE_KIND_LABELS: Record<NodeKind, string> = {
  agent: "Agent",
  llm: "模型思考",
  tool: "工具",
  template: "文本模板",
  subworkflow: "子工作流",
  parallel: "并行",
  condition: "条件",
  loop: "循环",
  verify: "验证",
  approve: "人工审批"
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
  const [reviewer, setReviewer] = useState("实训用户");
  const [comments, setComments] = useState<Record<string, string>>({});

  const workflowNames = useMemo(
    () => new Map(workflows.map((workflow) => [workflow.id, workflow.name])),
    [workflows]
  );
  const active =
    Boolean(trace && isActiveRun(trace.run.status)) ||
    runs.some((run) => isActiveRun(run.status));
  const pendingApprovals = trace?.approvals.filter((approval) => approval.status === "pending") ?? [];

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

  async function handleCancelRun() {
    if (!trace) {
      return;
    }
    setBusy("cancel");
    setBanner(undefined);
    try {
      const response = await platformApi.cancelRun(trace.run.id);
      setBanner({ tone: "info", text: "已请求取消，运行会在当前节点结束后停止。" });
      window.setTimeout(async () => {
        setTrace(await platformApi.trace(response.run.id));
        await refreshAll();
      }, 250);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function handleDecision(approval: ApprovalRecord, decision: ApprovalDecision) {
    const comment = (comments[approval.id] ?? "").trim();
    if (decision === "rejected" && !comment) {
      setBanner({ tone: "error", text: "驳回时必须填写审批意见，说明需要修改的地方。" });
      return;
    }
    setBusy(`approval:${approval.id}`);
    setBanner(undefined);
    try {
      await platformApi.decideApproval(approval.id, {
        decision,
        reviewer: reviewer.trim() || "实训用户",
        comment: comment || undefined
      });
      setBanner({
        tone: decision === "approved" ? "success" : "error",
        text:
          decision === "approved"
            ? `已通过「${approval.title}」，运行将从该节点继续执行。`
            : `已驳回「${approval.title}」，运行将在此终止并保留审批意见。`
      });
      setComments((current) => ({ ...current, [approval.id]: "" }));
      window.setTimeout(() => void refreshAll(), 250);
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
                  <VerificationBadge value={trace.run.output?.verify} />
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
                    className="platform-button is-ghost"
                    onClick={() => void handleCancelRun()}
                    disabled={busy !== undefined || !isActiveRun(trace.run.status)}
                    title="停止后续节点，已完成的步骤保留在 trace 中"
                  >
                    {busy === "cancel" ? (
                      <Loader2 size={14} className="is-spinning" />
                    ) : (
                      <XCircle size={14} />
                    )}
                    取消运行
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
                    {trace.run.status === "cancelled" ? <XCircle size={14} /> : <AlertTriangle size={14} />}
                    {trace.run.status === "cancelled" ? "运行已取消" : "运行失败"}
                  </div>
                  <pre>{trace.run.error}</pre>
                </div>
              )}

              {pendingApprovals.map((approval) => (
                <section className="monitor-approval" key={approval.id}>
                  <header className="monitor-approval-head">
                    <span className="monitor-approval-badge">待人工审批</span>
                    <strong>{approval.title}</strong>
                    <span>{approval.assignee || "未指定审批人"}</span>
                  </header>
                  {approval.instructions && <p className="monitor-approval-note">{approval.instructions}</p>}
                  <div className="monitor-approval-meta">
                    <span>节点 {approval.nodeId}</span>
                    {typeof approval.context?.score === "number" && (
                      <span>自动验证 {approval.context.score.toFixed(2)}</span>
                    )}
                    {approval.context?.issues && approval.context.issues.length > 0 && (
                      <span className="is-warning">{approval.context.issues.length} 个待关注问题</span>
                    )}
                    <span>截止 {formatDateTime(approval.expiresAt)}</span>
                  </div>
                  <div className="monitor-approval-context">
                    <span>待审产物</span>
                    <pre>{pretty(approval.context?.input ?? approval.context?.artifact)}</pre>
                  </div>
                  {approval.context?.issues && approval.context.issues.length > 0 && (
                    <ul className="monitor-approval-issues">
                      {approval.context.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  <div className="monitor-approval-form">
                    <label>
                      <span>审批人</span>
                      <input value={reviewer} onChange={(event) => setReviewer(event.target.value)} />
                    </label>
                    <label className="is-wide">
                      <span>审批意见</span>
                      <textarea
                        rows={3}
                        value={comments[approval.id] ?? ""}
                        placeholder="通过可留空；驳回必须填写需要修改的地方。"
                        onChange={(event) =>
                          setComments((current) => ({ ...current, [approval.id]: event.target.value }))
                        }
                      />
                    </label>
                  </div>
                  <div className="monitor-approval-actions">
                    <button
                      type="button"
                      className="platform-button is-primary"
                      disabled={busy !== undefined}
                      onClick={() => void handleDecision(approval, "approved")}
                    >
                      {busy === `approval:${approval.id}` ? (
                        <Loader2 size={14} className="is-spinning" />
                      ) : (
                        <CheckCircle2 size={14} />
                      )}
                      通过并继续
                    </button>
                    <button
                      type="button"
                      className="platform-button is-ghost is-reject"
                      disabled={busy !== undefined}
                      onClick={() => void handleDecision(approval, "rejected")}
                    >
                      <XCircle size={14} />
                      驳回并终止
                    </button>
                  </div>
                </section>
              ))}

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

              {trace.approvals.length > 0 && (
                <section className="monitor-section">
                  <div className="monitor-section-head">
                    <h3>人工审批记录</h3>
                    <span>
                      {trace.approvals.filter((approval) => approval.status === "approved").length} 通过 ·{" "}
                      {trace.approvals.filter((approval) => approval.status === "rejected").length} 驳回
                    </span>
                  </div>
                  <div className="monitor-approval-records">
                    {trace.approvals.map((approval) => (
                      <article className={`monitor-approval-record is-${approval.status}`} key={approval.id}>
                        <div className="monitor-approval-record-head">
                          <strong>{approval.title}</strong>
                          <span className={`monitor-approval-status is-${approval.status}`}>
                            {approvalStatusLabel(approval.status)}
                          </span>
                        </div>
                        <small>
                          {approval.assignee || "未指定审批人"} · {approval.reviewer || "未记录审批人"} ·{" "}
                          {formatDateTime(approval.decidedAt ?? approval.createdAt)}
                        </small>
                        {approval.comment && <p>{approval.comment}</p>}
                        {typeof approval.context?.score === "number" && (
                          <span className="monitor-approval-score">
                            审批时自动验证 {approval.context.score.toFixed(2)}
                          </span>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {trace.run.plan && trace.run.plan.decisions.length + trace.run.plan.unassigned.length > 0 && (
                <section className="monitor-section">
                  <div className="monitor-section-head">
                    <h3>运行前调度计划</h3>
                    <span>
                      {trace.run.plan.formula} · 已分配 {trace.run.plan.stats.scheduledCount}/
                      {trace.run.plan.stats.taskCount}
                    </span>
                  </div>
                  <div className="monitor-schedule">
                    {trace.run.plan.decisions.map((decision) => {
                      const requested = trace.run.plan?.requestedAgentIds[decision.taskId];
                      return (
                        <article className="monitor-schedule-row" key={decision.taskId}>
                          <div className="monitor-schedule-head">
                            <strong>{decision.taskTitle}</strong>
                            <code>{decision.taskId}</code>
                            <span>
                              {requested && requested !== decision.agentId
                                ? `${requested} → ${decision.agentName}`
                                : `${decision.agentName}（DSL 首选）`}
                            </span>
                            <em>{decision.score.toFixed(2)}</em>
                          </div>
                          <p>{decision.reason}</p>
                          <small>
                            能力 {decision.breakdown.capability.toFixed(2)} · 可用度{" "}
                            {decision.breakdown.availability.toFixed(2)} · 优先级{" "}
                            {decision.breakdown.priority.toFixed(2)}
                            {decision.dependsOn.length > 0 && ` · 依赖 ${decision.dependsOn.join("、")}`}
                            {decision.alternatives.length > 0 &&
                              ` · 次选 ${decision.alternatives
                                .slice(0, 2)
                                .map((item) => `${item.agentName}（${item.score.toFixed(2)}）`)
                                .join("、")}`}
                          </small>
                        </article>
                      );
                    })}
                    {trace.run.plan.unassigned.map((task) => (
                      <article className="monitor-schedule-row is-unassigned" key={task.taskId}>
                        <div className="monitor-schedule-head">
                          <strong>{task.taskTitle}</strong>
                          <code>{task.taskId}</code>
                          <span>未分配，回退到 DSL 声明 Agent</span>
                        </div>
                        <p>{task.reason}</p>
                      </article>
                    ))}
                  </div>
                </section>
              )}

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
                    const depth = step.path.split("/").length - 1;
                    return (
                      <article className={`monitor-step is-${step.status}`} key={step.id}>
                        <span className="monitor-step-dot" aria-hidden="true" />
                        <div
                          className="monitor-step-card"
                          style={depth > 0 ? { marginLeft: Math.min(depth, 3) * 18 } : undefined}
                        >
                          <div className="monitor-step-head">
                            <div>
                              <code>{step.path}</code>
                              {step.nodeKind === "subworkflow" && (
                                <span className="monitor-step-boundary">子流程边界</span>
                              )}
                              <small>
                                #{step.sequence} · {NODE_KIND_LABELS[step.nodeKind] ?? step.nodeKind} ·{" "}
                                {step.durationMs ?? 0} ms · {formatTime(step.startedAt)}
                                {(step.attempts ?? 1) > 1 && ` · 尝试 ${step.attempts} 次`}
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
                            {step.nodeKind !== "approve" &&
                              step.status !== "running" &&
                              step.status !== "waiting" &&
                              step.status !== "pending" && (
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
                    {trace.verifyResults.map((result, index) => {
                      const layers = result.detail?.layers;
                      return (
                        <div className="monitor-verify" key={result.id}>
                          <div className="monitor-verify-head">
                            <strong>第 {index + 1} 次验证 · {result.score.toFixed(2)}</strong>
                            <span>置信度 {result.confidence.toFixed(2)}</span>
                          </div>
                          {layers && (
                            <>
                              <div className="monitor-verify-layers">
                                <span>规则 {layers.rule.score.toFixed(2)}</span>
                                <span>
                                  交叉 {layers.crossCheck.score.toFixed(2)} · {layers.crossCheck.verifiers.length} 名验证器
                                  · 分歧 {layers.crossCheck.spread.toFixed(2)}
                                </span>
                                <span>基准 {layers.baseline.coverage.toFixed(2)}</span>
                              </div>
                              {layers.crossCheck.verifiers.length > 0 && (
                                <div className="monitor-verify-agents">
                                  {layers.crossCheck.verifiers.map((verifier) => (
                                    <span key={`${result.id}-${verifier.agentId}`}>
                                      {verifier.agentName} {verifier.score.toFixed(2)}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
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
                      );
                    })}
                  </div>
                </section>
              )}

              {trace.loopIterations.length > 0 && (
                <section className="monitor-section">
                  <div className="monitor-section-head">
                    <h3>循环轮次</h3>
                    <span>{trace.loopIterations.length} 轮</span>
                  </div>
                  {loopSummariesOf(trace).map((summary, index) => (
                    <p className="monitor-loop-retention" key={`retention-${index}`}>
                      {retentionText(summary)}
                    </p>
                  ))}
                  <div className="monitor-loops">
                    {trace.loopIterations.map((iteration) => (
                      <div className="monitor-loop" key={iteration.id}>
                        <div className="monitor-loop-main">
                          <strong>{iteration.loopNodeId}</strong>
                          <span>第 {iteration.iteration} 轮</span>
                          <span>
                            {iteration.scoreBefore === undefined ? "—" : iteration.scoreBefore.toFixed(2)} →{" "}
                            {iteration.scoreAfter === undefined ? "—" : iteration.scoreAfter.toFixed(2)}
                          </span>
                          <em>{selfLoopActionLabel(iteration.action)}</em>
                        </div>
                        {iteration.changes && iteration.changes.length > 0 && (
                          <ul className="monitor-loop-changes">
                            {iteration.changes.map((change) => (
                              <li key={`${iteration.id}-${change}`}>{change}</li>
                            ))}
                          </ul>
                        )}
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

type LoopSummaryView = {
  bestIteration?: number;
  iterations?: number;
  finalScore?: number;
};

function loopSummariesOf(trace: TraceResponse): LoopSummaryView[] {
  const value = trace.run.output?.selfLoop;
  return Array.isArray(value) ? (value as LoopSummaryView[]) : [];
}

function retentionText(summary: LoopSummaryView): string {
  const kept =
    summary.bestIteration === 0
      ? "初始产物"
      : typeof summary.bestIteration === "number"
        ? `第 ${summary.bestIteration} 轮产物`
        : "最优产物";
  const score =
    typeof summary.finalScore === "number" ? `，最终验证分 ${summary.finalScore.toFixed(2)}` : "";
  const rounds =
    typeof summary.iterations === "number" ? `（循环 ${summary.iterations} 轮）` : "";
  return `保留${kept}${score}${rounds}；被丢弃轮次的验证记录仍保留在证据中。`;
}

function approvalStatusLabel(status: ApprovalRecord["status"]): string {
  const labels: Record<ApprovalRecord["status"], string> = {
    pending: "待审批",
    approved: "已通过",
    rejected: "已驳回",
    expired: "已超时"
  };
  return labels[status] ?? status;
}

function shortId(id: string): string {
  return id.replace(/^run_/, "").slice(0, 8);
}

/** 运行成功只代表执行没抛错；验证结论单独展示，避免把两者混为一谈。 */
function VerificationBadge({ value }: { value: unknown }) {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const verification = value as { score?: unknown; passed?: unknown };
  if (typeof verification.passed !== "boolean") {
    return null;
  }
  const score = typeof verification.score === "number" ? verification.score.toFixed(2) : "—";
  return (
    <span
      className={`platform-run-status is-${verification.passed ? "succeeded" : "failed"}`}
      title="验证结论独立于运行状态记录"
    >
      {verification.passed ? "验证通过" : "验证未通过"} {score}
    </span>
  );
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
