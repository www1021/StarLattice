import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Ellipsis,
  History,
  Loader2,
  RefreshCw,
  RotateCcw,
  XCircle
} from "lucide-react";
import { platformApi } from "./api";
import { latestStepOutputOf } from "./trainingRuns";
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
  HumanField,
  InteractionRecord,
  NodeKind,
  ReclaimerStatusView,
  RunRecord,
  SchedulerLeadershipView,
  SchedulerProcessView,
  SchedulerQueueEntry,
  SchedulerWorkerView,
  TraceResponse,
  VerifyIndependence,
  WhatIfResponse,
  WorkflowSummary
} from "./types";
import "./platform.css";

type Banner = {
  tone: "info" | "success" | "error";
  text: string;
};

const NODE_KIND_LABELS: Record<NodeKind, string> = {
  start: "开始",
  end: "结束",
  agent: "Agent",
  llm: "模型思考",
  clarify: "意图澄清",
  extract: "参数提取",
  knowledge: "知识检索",
  tool: "工具",
  http: "HTTP 请求",
  template: "文本模板",
  subworkflow: "子工作流",
  parallel: "并行",
  condition: "条件",
  loop: "循环",
  verify: "验证",
  approve: "人工审批",
  human: "人工交互"
};

const QUEUE_STATUS_LABELS: Record<SchedulerQueueEntry["status"], string> = {
  queued: "排队中",
  claimed: "已认领",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  skipped: "跳过",
  cancelled: "已撤销",
  expired: "已过期"
};

const REPLAY_POLICY_LABELS: Record<string, string> = {
  dynamic: "动态优先级",
  static: "静态分层",
  "critical-path": "关键路径",
  fifo: "先到先得",
  recorded: "实际记录"
};

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

export type MonitorSessionTarget = {
  workflowId: string;
  runId: string;
  sessionId?: string;
};

type RunMonitorPageProps = {
  initialRunId?: string;
  initialRunToken?: number;
  onOpenSession?: (target: MonitorSessionTarget) => void;
};

const SESSION_WORKFLOW_IDS = new Set(["classroom-session-v1", "counseling-session-v1"]);

export function RunMonitorPage({
  initialRunId,
  initialRunToken,
  onOpenSession
}: RunMonitorPageProps) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [trace, setTrace] = useState<TraceResponse>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<Banner>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [workers, setWorkers] = useState<SchedulerWorkerView[]>([]);
  const [processes, setProcesses] = useState<SchedulerProcessView[]>([]);
  const [leadership, setLeadership] = useState<SchedulerLeadershipView>();
  const [reclaimer, setReclaimer] = useState<ReclaimerStatusView>();
  const [workerBusy, setWorkerBusy] = useState(false);
  const [whatIf, setWhatIf] = useState<WhatIfResponse>();
  const [whatIfBusy, setWhatIfBusy] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [reviewer, setReviewer] = useState("实训用户");
  const [comments, setComments] = useState<Record<string, string>>({});
  const [filterWorkflow, setFilterWorkflow] = useState("");
  const [filterStatus, setFilterStatus] = useState<"all" | "active" | "succeeded" | "failed" | "cancelled">("all");
  const [detailTab, setDetailTab] = useState<"overview" | "timeline" | "advanced">("overview");
  const [onlyFailedSteps, setOnlyFailedSteps] = useState(false);
  const [interactionValues, setInteractionValues] = useState<
    Record<string, Record<string, string | boolean>>
  >({});
  const requestedRunRef = useRef(initialRunId);
  requestedRunRef.current = initialRunId;
  const handledRunTokenRef = useRef<number | undefined>(initialRunToken);

  const workflowNames = useMemo(
    () => new Map(workflows.map((workflow) => [workflow.id, workflow.name])),
    [workflows]
  );
  const filteredRuns = useMemo(() => {
    return runs.filter((run) => {
      if (filterWorkflow && run.workflowId !== filterWorkflow) {
        return false;
      }
      if (filterStatus === "active") {
        return isActiveRun(run.status);
      }
      if (filterStatus !== "all" && run.status !== filterStatus) {
        return false;
      }
      return true;
    });
  }, [runs, filterWorkflow, filterStatus]);
  const failedStepCount =
    trace?.steps.filter((step) => step.status === "failed").length ?? 0;
  const visibleSteps = useMemo(() => {
    if (!trace) {
      return [];
    }
    return onlyFailedSteps
      ? trace.steps.filter((step) => step.status === "failed" || step.error)
      : trace.steps;
  }, [trace, onlyFailedSteps]);
  const workflowsWithRuns = useMemo(() => {
    const ids = new Set(runs.map((run) => run.workflowId));
    return workflows.filter((workflow) => ids.has(workflow.id));
  }, [runs, workflows]);
  const active =
    Boolean(trace && isActiveRun(trace.run.status)) ||
    runs.some((run) => isActiveRun(run.status));
  const pendingApprovals = trace?.approvals.filter((approval) => approval.status === "pending") ?? [];
  const pendingInteractions =
    trace?.interactions.filter((interaction) => interaction.status === "pending") ?? [];
  const sessionTarget = useMemo(() => {
    if (!trace || !SESSION_WORKFLOW_IDS.has(trace.run.workflowId)) {
      return undefined;
    }
    if (trace.run.workflowId === "classroom-session-v1") {
      const created = latestStepOutputOf<{ sessionId?: string }>(trace, ["create-classroom"]);
      return { workflowId: trace.run.workflowId, runId: trace.run.id, sessionId: created?.sessionId };
    }
    const created = latestStepOutputOf<{ session?: { id?: string } }>(trace, ["create-session"]);
    return {
      workflowId: trace.run.workflowId,
      runId: trace.run.id,
      sessionId: created?.session?.id
    };
  }, [trace]);

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
        setSelectedId(requestedRunRef.current ?? runResponse.runs[0]?.id);
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
    if (!initialRunId || !initialRunToken || initialRunToken === handledRunTokenRef.current) {
      return;
    }
    handledRunTokenRef.current = initialRunToken;
    setSelectedId(initialRunId);
  }, [initialRunId, initialRunToken]);

  useEffect(() => {
    if (!selectedId) {
      setTrace(undefined);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setWhatIf(undefined);
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

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      platformApi
        .schedulerWorkers()
        .then((response) => {
          if (!cancelled) {
            setWorkers(response.workers);
            setProcesses(response.processes);
          }
        })
        .catch(() => {
          // Worker 面板失败不影响主监控链路
        });
    const loadLeadership = () =>
      platformApi
        .schedulerLeadership()
        .then((response) => {
          if (!cancelled) {
            setLeadership(response.leadership);
            setReclaimer(response.reclaimer);
          }
        })
        .catch(() => {
          // 单实例部署或旧后端没有该接口时静默跳过
        });
    void load();
    void loadLeadership();
    const timer = active ? window.setInterval(load, 1500) : undefined;
    const leadershipTimer = window.setInterval(loadLeadership, 4000);
    return () => {
      cancelled = true;
      if (timer) {
        window.clearInterval(timer);
      }
      window.clearInterval(leadershipTimer);
    };
  }, [active]);

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

  async function handleKillWorker(workerId: string) {
    setWorkerBusy(true);
    try {
      const result = await platformApi.killSchedulerWorker(workerId);
      setBanner({
        tone: result.killed ? "info" : "error",
        text: result.killed
          ? `已终止 Worker ${result.workerId}，${result.aborted} 个在飞任务进入重派。`
          : `Worker ${result.workerId} 已终止或不存在。`
      });
      const [workerResponse, nextTrace] = await Promise.all([
        platformApi.schedulerWorkers(),
        selectedId ? platformApi.trace(selectedId) : Promise.resolve(undefined)
      ]);
      setWorkers(workerResponse.workers);
      if (nextTrace) {
        setTrace(nextTrace);
      }
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setWorkerBusy(false);
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

  async function handleResumeRun() {
    if (!trace) {
      return;
    }
    setBusy("resume");
    setBanner(undefined);
    try {
      const response = await platformApi.resumeRun(trace.run.id);
      setRuns((current) => [response.run, ...current.filter((run) => run.id !== response.run.id)]);
      setSelectedId(response.run.id);
      setTrace(await platformApi.trace(response.run.id));
      setBanner({
        tone: "info",
        text: `已从最近检查点创建续跑 ${shortId(response.run.id)}；已完成节点直接回放，不会重复调用 Agent 或工具。`
      });
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setBusy(undefined);
    }
  }

  async function handleWhatIf() {
    if (!trace) {
      return;
    }
    setWhatIfBusy(true);
    setBanner(undefined);
    try {
      const result = await platformApi.whatIf({ runId: trace.run.id, capacity: 4 });
      setWhatIf(result);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setWhatIfBusy(false);
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

  async function handleInteraction(interaction: InteractionRecord) {
    setBusy(`interaction:${interaction.id}`);
    setBanner(undefined);
    try {
      const values: Record<string, unknown> = {};
      for (const field of interaction.fields) {
        const raw = interactionValues[interaction.id]?.[field.key];
        const value = raw ?? field.defaultValue;
        if (field.type === "boolean") {
          values[field.key] = value === true;
        } else if (value !== undefined && value !== "") {
          values[field.key] = field.type === "number" ? Number(value) : String(value);
        }
      }
      await platformApi.respondInteraction(
        interaction.id,
        values,
        reviewer.trim() || "实训用户"
      );
      setInteractionValues((current) => {
        const next = { ...current };
        delete next[interaction.id];
        return next;
      });
      setBanner({
        tone: "success",
        text: `已提交「${interaction.title}」，运行将从该节点继续执行。`
      });
      await refreshAll();
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setBusy(undefined);
    }
  }

  function interactionValue(interaction: InteractionRecord, field: HumanField): string | boolean {
    const stored = interactionValues[interaction.id]?.[field.key];
    if (stored !== undefined) {
      return stored;
    }
    if (typeof field.defaultValue === "boolean") {
      return field.defaultValue;
    }
    return field.defaultValue === undefined ? "" : String(field.defaultValue);
  }

  function updateInteractionValue(
    interactionId: string,
    key: string,
    value: string | boolean
  ) {
    setInteractionValues((current) => ({
      ...current,
      [interactionId]: { ...current[interactionId], [key]: value }
    }));
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
          正在加载运行记录…
        </div>
      </div>
    );
  }

  return (
    <div className="platform-page monitor-page">
      <header className="platform-head">
        <div className="platform-head-main">
          <h1>
            运行记录
            <span className="platform-version">{runs.length} 次运行</span>
          </h1>
          <p className="platform-head-meta">按运行查看时间线、单步输入输出与错误堆栈；失败步骤可单步重跑，整单可按键重放。</p>
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
            <strong>{filteredRuns.length}</strong>
          </header>
          <div className="monitor-filters">
            <select
              value={filterWorkflow}
              aria-label="按工作流筛选"
              onChange={(event) => setFilterWorkflow(event.target.value)}
            >
              <option value="">全部工作流</option>
              {workflowsWithRuns.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </select>
            <div className="monitor-filter-chips" role="group" aria-label="按状态筛选">
              {(
                [
                  ["all", "全部"],
                  ["active", "进行中"],
                  ["succeeded", "成功"],
                  ["failed", "失败"],
                  ["cancelled", "已取消"]
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`monitor-filter-chip${filterStatus === value ? " is-on" : ""}`}
                  onClick={() => setFilterStatus(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="monitor-list-scroll">
            {runs.length === 0 && (
              <p className="monitor-list-empty">还没有运行记录，去「编排画布」跑一次。</p>
            )}
            {runs.length > 0 && filteredRuns.length === 0 && (
              <p className="monitor-list-empty">没有符合筛选条件的运行，试试放宽条件。</p>
            )}
            {filteredRuns.map((run) => (
              <button
                key={run.id}
                type="button"
                className={`monitor-run ${run.id === selectedId ? "is-active" : ""}`}
                onClick={() => setSelectedId(run.id)}
              >
                <span className={`monitor-run-dot is-${runStatusTone(run.status)}`} />
                <span className="monitor-run-main">
                  <strong>{workflowNames.get(run.workflowId) ?? run.workflowId}</strong>
                  <small>
                    {formatTime(run.startedAt)} · {run.stepCount} 步 · {formatDuration(run.durationMs)}
                    {SESSION_WORKFLOW_IDS.has(run.workflowId) && (
                      <em className="monitor-run-tag">交互链路</em>
                    )}
                  </small>
                </span>
                <span className="monitor-run-meta">
                  <span className={`platform-run-status is-${runStatusTone(run.status)}`}>
                    {runStatusLabel(run.status)}
                  </span>
                  <small>#{shortId(run.id)}</small>
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
                    {sessionTarget && (
                      <span className="monitor-session-badge">教育交互链路</span>
                    )}
                  </h2>
                  <p>
                    {formatDateTime(trace.run.startedAt)} 启动 · {trace.run.mode === "stub" ? "确定性 stub" : "真实 Agent"} ·
                    {" "}用时 {formatDuration(trace.run.durationMs)}
                    {(trace.run.priorityClass ?? 0) > 0 && ` · 优先级分层 ${trace.run.priorityClass}`}
                    {(trace.run.resumeCount ?? 0) > 0 && ` · 已续跑 ${trace.run.resumeCount} 次`}
                    {trace.run.cancelRequestedAt && " · 已收到取消请求"}
                  </p>
                </div>
                <div className="monitor-detail-actions">
                  <span className={`platform-run-status is-${runStatusTone(trace.run.status)}`}>
                    {runStatusLabel(trace.run.status)}
                  </span>
                  <VerificationBadge value={trace.run.output?.verify} />
                  {sessionTarget && onOpenSession && (
                    <button
                      type="button"
                      className="platform-button is-ghost"
                      onClick={() => onOpenSession(sessionTarget)}
                      title="回到这条运行对应的课堂或谈话会话"
                    >
                      打开会话
                    </button>
                  )}
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
                  <div className="platform-more">
                    <button
                      type="button"
                      className="platform-icon-button"
                      aria-label="更多运行操作"
                      aria-expanded={moreOpen}
                      onClick={() => setMoreOpen((value) => !value)}
                    >
                      <Ellipsis size={16} />
                    </button>
                    {moreOpen && (
                      <div className="platform-more-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMoreOpen(false);
                            void refreshAll();
                          }}
                        >
                          <RefreshCw size={13} />
                          刷新轨迹
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={
                            busy !== undefined ||
                            isActiveRun(trace.run.status) ||
                            (trace.checkpoints?.length ?? 0) === 0
                          }
                          title="按最近检查点续跑：已完成节点直接回放，只执行未完成节点"
                          onClick={() => {
                            setMoreOpen(false);
                            void handleResumeRun();
                          }}
                        >
                          <History size={13} />
                          从检查点恢复
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="is-danger"
                          disabled={busy !== undefined || !isActiveRun(trace.run.status)}
                          title="停止后续节点，已完成的步骤保留在 trace 中"
                          onClick={() => {
                            setMoreOpen(false);
                            void handleCancelRun();
                          }}
                        >
                          <XCircle size={13} />
                          取消运行
                        </button>
                      </div>
                    )}
                  </div>
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

              {pendingInteractions.map((interaction) => (
                <section className="monitor-approval is-human" key={interaction.id}>
                  <header className="monitor-approval-head">
                    <span className="monitor-approval-badge is-human">待人工输入</span>
                    <strong>{interaction.title}</strong>
                    <span>节点 {interaction.nodeId}</span>
                  </header>
                  <p className="monitor-approval-note">{interaction.prompt}</p>
                  {interaction.context && Object.keys(interaction.context).length > 0 && (
                    <div className="monitor-approval-context">
                      <span>交互上下文</span>
                      <pre>{pretty(interaction.context)}</pre>
                    </div>
                  )}
                  {interaction.expiresAt && (
                    <div className="monitor-approval-meta">
                      <span>截止 {formatDateTime(interaction.expiresAt)}</span>
                    </div>
                  )}
                  <div className="monitor-approval-form">
                    {interaction.fields.map((field) => {
                      const value = interactionValue(interaction, field);
                      const wide = field.type === "textarea" || field.type === "select";
                      const options = field.options ?? [];
                      // 选了预置之外的内容（用户自己填的）就不再高亮任何按钮。
                      const customValue = options.includes(String(value)) ? "" : String(value);
                      return (
                        <label key={field.key} className={wide ? "is-wide" : ""}>
                          <span>
                            {field.label}
                            {field.required ? " *" : ""}
                          </span>
                          {field.type === "textarea" ? (
                            <textarea
                              rows={3}
                              value={String(value)}
                              placeholder={field.placeholder}
                              onChange={(event) =>
                                updateInteractionValue(interaction.id, field.key, event.target.value)
                              }
                            />
                          ) : field.type === "select" ? (
                            <div className="monitor-choice">
                              {options.map((option, index) => (
                                <button
                                  key={option}
                                  type="button"
                                  className={`monitor-choice-item${
                                    String(value) === option ? " is-on" : ""
                                  }`}
                                  onClick={() =>
                                    updateInteractionValue(interaction.id, field.key, option)
                                  }
                                >
                                  <span className="monitor-choice-index">
                                    {String(index + 1).padStart(2, "0")}
                                  </span>
                                  <span className="monitor-choice-text">{option}</span>
                                </button>
                              ))}
                              {/* 兜底：选项都不合适就自己写，提交后走「其他」分支。 */}
                              <span className="monitor-choice-other">
                                <input
                                  value={customValue}
                                  placeholder="其他：不在上面选项里就填这里"
                                  onChange={(event) =>
                                    updateInteractionValue(
                                      interaction.id,
                                      field.key,
                                      event.target.value
                                    )
                                  }
                                />
                              </span>
                            </div>
                          ) : field.type === "boolean" ? (
                            <input
                              type="checkbox"
                              checked={value === true}
                              onChange={(event) =>
                                updateInteractionValue(interaction.id, field.key, event.target.checked)
                              }
                            />
                          ) : (
                            <input
                              type={field.type === "number" ? "number" : "text"}
                              value={String(value)}
                              placeholder={field.placeholder}
                              onChange={(event) =>
                                updateInteractionValue(interaction.id, field.key, event.target.value)
                              }
                            />
                          )}
                          {field.description && <small>{field.description}</small>}
                        </label>
                      );
                    })}
                  </div>
                  <div className="monitor-approval-actions">
                    <button
                      type="button"
                      className="platform-button is-primary"
                      disabled={busy !== undefined}
                      onClick={() => void handleInteraction(interaction)}
                    >
                      {busy === `interaction:${interaction.id}` ? (
                        <Loader2 size={14} className="is-spinning" />
                      ) : (
                        <CheckCircle2 size={14} />
                      )}
                      提交并继续
                    </button>
                  </div>
                </section>
              ))}

              <div className="monitor-tabs" role="tablist" aria-label="详情分区">
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === "overview"}
                  className={detailTab === "overview" ? "is-on" : ""}
                  onClick={() => setDetailTab("overview")}
                >
                  概览
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === "timeline"}
                  className={detailTab === "timeline" ? "is-on" : ""}
                  onClick={() => setDetailTab("timeline")}
                >
                  执行时间线
                  {failedStepCount > 0 && <em>{failedStepCount} 失败</em>}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === "advanced"}
                  className={detailTab === "advanced" ? "is-on" : ""}
                  onClick={() => setDetailTab("advanced")}
                >
                  高级信息
                </button>
              </div>

              {detailTab === "overview" && (
              <>
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
                  <strong>{formatDuration(trace.run.durationMs)}</strong>
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
              </>
              )}

              {detailTab === "advanced" && trace.run.plan && trace.run.plan.decisions.length + trace.run.plan.unassigned.length > 0 && (
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
                            {decision.load && ` · 在飞 ${decision.load.inFlight}/${decision.load.capacity}`}
                            {decision.model &&
                              ` · 模型 ${decision.model.id}（${decision.model.costTier}）`}
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

              {detailTab === "advanced" && trace.queue && trace.queue.length > 0 && (
                <section className="monitor-section">
                  <div className="monitor-section-head">
                    <h3>运行时调度队列</h3>
                    <span>按关键路径优先级排序 · 队列级抢占不中断已运行步骤</span>
                  </div>
                  <div className="monitor-queue">
                    {trace.queue.map((entry) => (
                      <article className={`monitor-queue-row is-${entry.status}`} key={entry.id}>
                        <div className="monitor-queue-head">
                          <code>{entry.path}</code>
                          <span>优先级 {entry.priority.toFixed(2)}</span>
                          <em>{QUEUE_STATUS_LABELS[entry.status]}</em>
                        </div>
                        <small>
                          排队 {formatDuration(entry.waitMs)}{entry.reason ? ` · ${entry.reason}` : ""}
                        </small>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {detailTab === "advanced" && (
              <section className="monitor-section">
                <div className="monitor-section-head">
                  <h3>调度 Worker</h3>
                  <span>
                    {processes.length > 0
                      ? `${processes.filter((item) => item.status !== "dead").length}/${processes.length} 个 Worker 子进程在线`
                      : "未启用 Worker 子进程，叶子步骤在本进程执行槽内运行"}
                  </span>
                </div>
                {processes.length > 0 && (
                  <div className="monitor-workers">
                    {processes.map((process) => (
                      <article
                        className={`monitor-worker${process.status === "dead" ? " is-killed" : ""}`}
                        key={process.id}
                      >
                        <div>
                          <code>{process.id}</code>
                          <small>
                            槽 {process.slot ?? "-"} · PID {process.pid ?? "-"} · {process.status}
                            {process.stopReason ? ` · ${process.stopReason}` : ""}
                          </small>
                        </div>
                        <button
                          type="button"
                          className="platform-link"
                          disabled={process.status === "dead" || workerBusy}
                          onClick={() => void handleKillWorker(process.id)}
                          title="终止该 Worker 子进程，在飞任务进入重派"
                        >
                          终止
                        </button>
                      </article>
                    ))}
                  </div>
                )}
                <div className="monitor-workers">
                  {workers.length === 0 && (
                    <p className="monitor-hint">尚未创建执行槽，运行 Agent 步骤后出现。</p>
                  )}
                  {workers.map((worker) => (
                    <article className={`monitor-worker${worker.killed ? " is-killed" : ""}`} key={worker.id}>
                      <div>
                        <code>{worker.id}</code>
                        <small>
                          {worker.pid ? `PID ${worker.pid} · ` : ""}
                          {worker.killed
                            ? "已终止"
                            : worker.activeTasks.length > 0
                              ? `在飞 ${worker.activeTasks.length}`
                              : "空闲"}
                        </small>
                      </div>
                      <button
                        type="button"
                        className="platform-link"
                        disabled={worker.killed || workerBusy}
                        onClick={() => void handleKillWorker(worker.id)}
                      >
                        终止
                      </button>
                    </article>
                  ))}
                </div>
                <p className="monitor-hint">
                  调度租约：{leadership ? `${leadership.holder} 持有至 ${formatDateTime(leadership.expiresAt)}` : "暂无"}
                  {reclaimer
                    ? ` · 回收器${reclaimer.leader ? "已获领导权" : "待命"}，每 ${Math.round(reclaimer.intervalMs / 1000)}s 巡检，自动续跑${reclaimer.autoResume ? "已开启" : "关闭"}`
                    : " · 未启用周期回收器"}
                  {reclaimer?.lastTickAt ? ` · 上次巡检 ${formatDateTime(reclaimer.lastTickAt)}` : ""}
                </p>
              </section>
              )}


              {detailTab === "advanced" && (
              <section className="monitor-section">
                <div className="monitor-section-head">
                  <h3>检查点</h3>
                  <span>
                    {trace.checkpoints?.length
                      ? `最近 ${trace.checkpoints.length} 个 · 续跑会回放已完成节点`
                      : "尚未落检查点，运行至少完成一个顶层节点后出现"}
                  </span>
                </div>
                <div className="monitor-queue">
                  {(trace.checkpoints ?? []).map((checkpoint) => (
                    <article className="monitor-queue-row" key={checkpoint.id}>
                      <div className="monitor-queue-head">
                        <code>#{checkpoint.sequence}</code>
                        <span>{formatDateTime(checkpoint.createdAt)}</span>
                      </div>
                      <small>
                        已完成节点 {checkpoint.nodeCount ?? checkpointNodeCount(checkpoint.state ?? {})} ·
                        {" "}序号 {checkpoint.sequence}
                      </small>
                    </article>
                  ))}
                </div>
              </section>
              )}


              {detailTab === "advanced" && (
              <section className="monitor-section">
                <div className="monitor-section-head">
                  <h3>策略沙盒（离线回放）</h3>
                  <span>复用本运行的实际耗时，在 4 槽容量下重排任务，不执行 Agent</span>
                </div>
                <div className="monitor-detail-actions">
                  <button
                    type="button"
                    className="platform-button is-ghost"
                    onClick={() => void handleWhatIf()}
                    disabled={whatIfBusy || trace.steps.length === 0}
                    title="把已完成任务的真实耗时放回队列，比较不同出队策略"
                  >
                    {whatIfBusy ? <Loader2 size={14} className="is-spinning" /> : <Activity size={14} />}
                    运行回放
                  </button>
                </div>
                {whatIf && (
                  <div className="monitor-queue">
                    {[whatIf.recorded, ...whatIf.policies.filter((item) => item.policy !== "recorded")]
                      .filter((item) => item.policy !== "recorded" || item.tasks > 0)
                      .map((metrics) => (
                      <article className="monitor-queue-row" key={metrics.policy}>
                        <div className="monitor-queue-head">
                          <code>{REPLAY_POLICY_LABELS[metrics.policy] ?? metrics.policy}</code>
                          <span>完工跨度 {formatDuration(metrics.makespanMs)}</span>
                          <span>等待 P95 {formatDuration(metrics.waitP95Ms)}</span>
                        </div>
                        <small>
                          截止违约 {metrics.deadlineMisses} · 优先级倒挂 {metrics.priorityInversions} ·
                          {" "}利用率 {(metrics.utilization * 100).toFixed(1)}%
                        </small>
                      </article>
                    ))}
                  </div>
                )}
                {!whatIf && (
                  <p className="monitor-hint">
                    回放只重排已完成的任务，不会启动新的 Agent 调用，因此可以反复试策略。
                  </p>
                )}
              </section>
              )}


              {detailTab === "timeline" && (
              <section className="monitor-section">
                <div className="monitor-section-head">
                  <h3>执行时间线</h3>
                  <span className="monitor-timeline-head">
                    {trace.steps.length} 条记录 · 失败 {failedStepCount}
                    <button
                      type="button"
                      className={`monitor-filter-chip${onlyFailedSteps ? " is-on" : ""}`}
                      disabled={failedStepCount === 0}
                      onClick={() => setOnlyFailedSteps((value) => !value)}
                    >
                      只看失败
                    </button>
                  </span>
                </div>
                <div className="monitor-timeline">
                  {visibleSteps.length === 0 && (
                    <p className="monitor-hint">
                      {onlyFailedSteps ? "没有失败步骤，试试关掉过滤。" : "尚未产生步骤记录。"}
                    </p>
                  )}
                  {visibleSteps.map((step) => {
                    const isExpanded = expanded.has(step.id);
                    const depth = step.path.split("/").length - 1;
                    const reschedule =
                      step.input && typeof step.input === "object" && "reschedule" in step.input
                        ? (
                            step.input as {
                              reschedule?: { attempt?: number; from?: string; to?: string; reason?: string };
                            }
                          ).reschedule
                        : undefined;
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
                                {formatDuration(step.durationMs)} · {formatTime(step.startedAt)}
                                {(step.attempts ?? 1) > 1 && ` · 尝试 ${step.attempts} 次`}
                              </small>
                            </div>
                            <span className={`platform-step-status is-${step.status}`}>
                              {stepStatusLabel(step.status)}
                            </span>
                          </div>

                          {step.error && (
                            <pre
                              className={`monitor-step-error${
                                step.status === "succeeded" ? " is-degraded" : ""
                              }`}
                            >
                              {step.error}
                            </pre>
                          )}

                          {reschedule && (
                            <p className="monitor-step-reschedule">
                              运行中重调度 #{reschedule.attempt}：{reschedule.from} → {reschedule.to} ·{" "}
                              {reschedule.reason}
                            </p>
                          )}

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
              )}

              {detailTab === "overview" && (
              <>
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
                                      {verifier.resolvedModel ? ` · ${verifier.resolvedModel}` : ""}
                                      {verifier.evidenceView
                                        ? ` · ${verifier.evidenceView === "cited" ? "引用视图" : "证据池"}`
                                        : ""}
                                      {verifier.fallback ? " · 启发式回退" : ""}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </>
                          )}
                          {result.detail?.independence && (
                            <div className="monitor-verify-layers">
                              <span>
                                {independenceLabel(result.detail.independence.level)}
                                {result.detail.independence.heuristicFallback ? " · 启发式回退" : ""}
                              </span>
                              {!result.detail.independence.heuristicFallback &&
                                result.detail.independence.models.length > 0 && (
                                  <span>{result.detail.independence.models.join(" / ")}</span>
                                )}
                            </div>
                          )}
                          {result.detail?.citations && (
                            <div className="monitor-verify-layers">
                              <span>
                                引用 {result.detail.citations.total} 处 · 有效{" "}
                                {result.detail.citations.valid} · 缺失 {result.detail.citations.missing}
                              </span>
                            </div>
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
                          {iteration.modelBefore &&
                            iteration.modelAfter &&
                            iteration.modelBefore !== iteration.modelAfter && (
                              <span>
                                模型 {iteration.modelBefore} → {iteration.modelAfter}
                              </span>
                            )}
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

/** 把毫秒换算成可读时长：1s 以内保留 ms，1 分钟以内保留一位小数秒，更长换算分钟。 */
function formatDuration(ms?: number | null): string {
  const value = ms ?? 0;
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)} s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

function checkpointNodeCount(state: Record<string, unknown>): number {
  const nodes = state.nodes;
  return nodes && typeof nodes === "object" && !Array.isArray(nodes)
    ? Object.keys(nodes as Record<string, unknown>).length
    : 0;
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
