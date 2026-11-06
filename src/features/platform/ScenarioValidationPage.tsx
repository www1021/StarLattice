import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BookOpen,
  Cable,
  CheckCircle2,
  ClipboardCheck,
  GraduationCap,
  HeartHandshake,
  Layers,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Users,
  Workflow
} from "lucide-react";
import {
  SCENARIO_PACK_ITEMS,
  SCENARIO_PACK_META,
  type ScenarioPackId
} from "../../../shared/scenarioPacks";
import { platformApi } from "./api";
import { runStatusLabel } from "./layout";
import type {
  InteractionRecord,
  RunRecord,
  StepRecord,
  TraceResponse,
  WorkflowSummary
} from "./types";
import "./platform.css";

const SESSION_WORKFLOW_IDS = new Set(["classroom-session-v1", "counseling-session-v1"]);

type ScenarioAction = {
  label: string;
  icon: typeof Workflow;
  onClick: () => void;
};

type PackPresentation = {
  id: ScenarioPackId;
  title: string;
  narrative: string;
  flagship: string[];
  interactive: Record<string, string>;
  actions: (handlers: ScenarioValidationPageProps) => ScenarioAction[];
};

const TERMINAL_STATUSES = new Set<RunRecord["status"]>([
  "succeeded",
  "failed",
  "rolled_back",
  "cancelled"
]);

const PACKS: PackPresentation[] = [
  {
    id: "education",
    title: "师范生课堂训练",
    narrative:
      "教案、课堂演练、虚拟课堂与谈心谈话共用同一套 Agent 注册与运行台账；虚拟课堂和谈心谈话在人工交互节点暂停，提交后继续同一条运行。",
    flagship: ["classroom-map-v1", "classroom-session-v1", "counseling-session-v1"],
    interactive: {
      "classroom-session-v1": "人工交互",
      "counseling-session-v1": "人工交互",
      "lesson-approval-v1": "人工审批"
    },
    actions: (handlers) => [
      { label: "进入虚拟课堂", icon: GraduationCap, onClick: handlers.onOpenClassroom },
      { label: "进入谈心谈话", icon: HeartHandshake, onClick: handlers.onOpenCounseling },
      { label: "场景对话", icon: MessagesSquare, onClick: handlers.onOpenChat },
      { label: "Agent 注册中心", icon: Users, onClick: handlers.onOpenRegistry }
    ]
  },
  {
    id: "business-analysis",
    title: "经营分析决策",
    narrative:
      "指标计算、归因与报告走同一条地图式工作流，数据工具从 MCP 接入；验证与运行记录和教育场景共用同一套监控与报告页面。",
    flagship: ["business-map-v1", "business-analysis-v1"],
    interactive: {},
    actions: (handlers) => [
      {
        label: "打开经营分析地图",
        icon: Workflow,
        onClick: () => handlers.onOpenWorkflow("business-map-v1")
      },
      { label: "指标知识库", icon: BookOpen, onClick: handlers.onOpenLibrary },
      { label: "数据分析 MCP", icon: Cable, onClick: handlers.onOpenMcp },
      { label: "运行监控", icon: Activity, onClick: handlers.onOpenMonitor }
    ]
  },
  {
    id: "core",
    title: "跨场景通用链路",
    narrative:
      "检索、规划、起草、验证、自循环修订与定稿不绑定领域词；两个场景的专属链路都在同一执行器上编译与并发调度。",
    flagship: ["task-report-v1"],
    interactive: {},
    actions: (handlers) => [
      {
        label: "打开任务报告流水线",
        icon: Workflow,
        onClick: () => handlers.onOpenWorkflow("task-report-v1")
      },
      { label: "Agent 注册中心", icon: Users, onClick: handlers.onOpenRegistry },
      { label: "验证报告", icon: ClipboardCheck, onClick: handlers.onOpenReport }
    ]
  }
];

export type ScenarioValidationPageProps = {
  onOpenWorkflow: (workflowId: string, nodeId?: string) => void;
  onOpenMonitor: () => void;
  onOpenMonitorRun?: (runId: string) => void;
  onOpenSession?: (target: { workflowId: string; runId: string; sessionId?: string }) => void;
  onOpenReport: () => void;
  onOpenRegistry: () => void;
  onOpenLibrary: () => void;
  onOpenMcp: () => void;
  onOpenClassroom: () => void;
  onOpenCounseling: () => void;
  onOpenChat: () => void;
};

type WorkflowStats = {
  runs: RunRecord[];
  succeeded: number;
  active: number;
  lastRun?: RunRecord;
  tone: "verified" | "running" | "failed" | "idle";
};

export function ScenarioValidationPage(handlers: ScenarioValidationPageProps) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [interactions, setInteractions] = useState<InteractionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [evidenceTrace, setEvidenceTrace] = useState<TraceResponse>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void Promise.all([
      platformApi.listWorkflows(),
      platformApi.listRuns(200),
      platformApi.listInteractions(undefined, "pending")
    ])
      .then(([workflowResponse, runResponse, interactionResponse]) => {
        if (cancelled) {
          return;
        }
        setWorkflows(workflowResponse.workflows);
        setRuns(runResponse.runs);
        setInteractions(interactionResponse.interactions);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "加载场景验证数据失败。");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  const workflowById = useMemo(
    () => new Map(workflows.map((workflow) => [workflow.id, workflow])),
    [workflows]
  );
  const statsByWorkflow = useMemo(() => {
    const map = new Map<string, WorkflowStats>();
    for (const run of runs) {
      const current: WorkflowStats = map.get(run.workflowId) ?? {
        runs: [],
        succeeded: 0,
        active: 0,
        tone: "idle"
      };
      current.runs.push(run);
      if (run.status === "succeeded") {
        current.succeeded += 1;
      }
      if (!TERMINAL_STATUSES.has(run.status)) {
        current.active += 1;
      }
      map.set(run.workflowId, current);
    }
    for (const stats of map.values()) {
      stats.lastRun = stats.runs[0];
      stats.tone =
        stats.active > 0
          ? "running"
          : stats.succeeded > 0
            ? "verified"
            : stats.lastRun?.status === "failed"
              ? "failed"
              : "idle";
    }
    return map;
  }, [runs]);

  const terminalRuns = runs.filter((run) => TERMINAL_STATUSES.has(run.status));
  const overallSuccess = terminalRuns.filter((run) => run.status === "succeeded").length;
  const sessionRuns = useMemo(
    () => runs.filter((run) => SESSION_WORKFLOW_IDS.has(run.workflowId)),
    [runs]
  );
  const latestSessionRun = sessionRuns[0];

  useEffect(() => {
    if (!latestSessionRun) {
      setEvidenceTrace(undefined);
      return;
    }
    let cancelled = false;
    void platformApi
      .trace(latestSessionRun.id)
      .then((value) => {
        if (!cancelled) {
          setEvidenceTrace(value);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEvidenceTrace(undefined);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [latestSessionRun?.id]);

  const evidenceItems = useMemo(
    () => (evidenceTrace ? buildEvidenceTimeline(evidenceTrace) : []),
    [evidenceTrace]
  );
  const interactiveCount = PACKS.reduce(
    (total, pack) =>
      total +
      SCENARIO_PACK_ITEMS[pack.id].workflows.filter((id) => pack.interactive[id]).length,
    0
  );

  if (loading) {
    return (
      <div className="platform-page">
        <div className="platform-loading">
          <Loader2 size={18} className="is-spinning" />
          正在汇总场景覆盖与运行结果…
        </div>
      </div>
    );
  }

  return (
    <div className="platform-page scenario-page">
      <header className="platform-head">
        <div className="platform-head-main">
          <span className="platform-eyebrow">
            场景验证 <em>Scenario Validation</em>
          </span>
          <h1>两个场景，一套编排引擎</h1>
          <p>
            教育训练与经营分析共用工作流、Agent、知识库与运行台账。这里按场景汇总覆盖度、最近运行和待处理交互，
            点开任意链路即可回到同一条执行器的画布。
          </p>
        </div>
        <div className="platform-head-actions">
          <button
            type="button"
            className="platform-button is-ghost"
            onClick={() => setRefreshToken((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw size={15} />
            刷新
          </button>
          <button type="button" className="platform-button is-ghost" onClick={handlers.onOpenMonitor}>
            <Activity size={15} />
            运行台账
          </button>
          <button type="button" className="platform-button is-primary" onClick={handlers.onOpenReport}>
            <ClipboardCheck size={15} />
            验证报告
          </button>
        </div>
      </header>

      {error && (
        <div className="scenario-alert" role="alert">
          {error}
        </div>
      )}

      <div className="scenario-overview">
        <div className="scenario-kpi">
          <span>近期运行</span>
          <strong>{runs.length}</strong>
          <small>最近 200 次，跨全部场景</small>
        </div>
        <div className="scenario-kpi">
          <span>成功率</span>
          <strong>
            {terminalRuns.length ? `${Math.round((overallSuccess / terminalRuns.length) * 100)}%` : "—"}
          </strong>
          <small>
            {overallSuccess}/{terminalRuns.length} 次已结束运行成功
          </small>
        </div>
        <div className="scenario-kpi">
          <span>人机交互链路</span>
          <strong>{interactiveCount}</strong>
          <small>人工交互 / 审批节点，暂停后可恢复</small>
        </div>
        <button
          type="button"
          className={`scenario-kpi is-action ${interactions.length ? "has-pending" : ""}`}
          onClick={handlers.onOpenMonitor}
        >
          <span>待处理交互</span>
          <strong>{interactions.length}</strong>
          <small>{interactions.length ? "去运行台账继续提交" : "当前没有暂停中的运行"}</small>
        </button>
      </div>

      {latestSessionRun && (
        <section className="scenario-evidence">
          <header className="scenario-evidence-head">
            <div>
              <span>演示证据链</span>
              <h2>用户操作 → 工作流节点 → 人工交互 → 输出报告</h2>
              <p>
                最近一条教育交互运行 {latestSessionRun.workflowId} · {formatDateTime(latestSessionRun.startedAt)}，
                评委可对照时间线逐项复核。
              </p>
            </div>
            <div className="scenario-evidence-actions">
              <button
                type="button"
                className="platform-button is-ghost"
                onClick={() => handlers.onOpenMonitorRun?.(latestSessionRun.id)}
              >
                <Activity size={14} />
                查看完整 trace
              </button>
              <button
                type="button"
                className="platform-button is-primary"
                onClick={() =>
                  handlers.onOpenSession?.({
                    workflowId: latestSessionRun.workflowId,
                    runId: latestSessionRun.id
                  })
                }
              >
                <GraduationCap size={14} />
                打开会话
              </button>
            </div>
          </header>
          {evidenceTrace ? (
            <ol className="scenario-evidence-timeline">
              {evidenceItems.map((item) => (
                <li key={item.key} className={`is-${item.phase}`}>
                  <span className="scenario-evidence-dot" aria-hidden="true" />
                  <div>
                    <em>{evidencePhaseLabel(item.phase)}</em>
                    <strong>{item.action}</strong>
                    <small>{item.detail}</small>
                    <code>{item.nodeId}</code>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="scenario-evidence-empty">正在读取最近一条交互运行的执行轨迹…</p>
          )}
        </section>
      )}

      {sessionRuns.length > 0 && (
        <section className="scenario-recent">
          <header>
            <div>
              <span>最近交互运行</span>
              <p>课堂与谈心谈话的每一轮发言都落在同一条平台运行里。</p>
            </div>
            <button type="button" className="platform-button is-ghost" onClick={handlers.onOpenMonitor}>
              全部运行
              <ArrowUpRight size={13} />
            </button>
          </header>
          <div className="scenario-recent-list">
            {sessionRuns.slice(0, 6).map((run) => (
              <article key={run.id}>
                <span className={`scenario-tag is-${runTone(run)}`}>{runStatusLabel(run.status)}</span>
                <div>
                  <strong>{workflowById.get(run.workflowId)?.name ?? run.workflowId}</strong>
                  <small>
                    {shortRun(run.id)} · {formatDateTime(run.startedAt)} · {run.stepCount} 步
                  </small>
                </div>
                <button type="button" onClick={() => handlers.onOpenMonitorRun?.(run.id)}>
                  查看 trace
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handlers.onOpenSession?.({ workflowId: run.workflowId, runId: run.id })
                  }
                >
                  打开会话
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {PACKS.map((pack) => {
        const meta = SCENARIO_PACK_META[pack.id];
        const items = SCENARIO_PACK_ITEMS[pack.id];
        const packRuns = runs.filter((run) => items.workflows.includes(run.workflowId));
        const packTerminal = packRuns.filter((run) => TERMINAL_STATUSES.has(run.status));
        const packSucceeded = packTerminal.filter((run) => run.status === "succeeded").length;
        const verified = items.workflows.filter(
          (id) => (statsByWorkflow.get(id)?.succeeded ?? 0) > 0
        ).length;
        const coverage = items.workflows.length
          ? Math.round((verified / items.workflows.length) * 100)
          : 0;
        const ordered = [...items.workflows].sort((left, right) => {
          const leftRank = pack.flagship.indexOf(left);
          const rightRank = pack.flagship.indexOf(right);
          if (leftRank === -1 && rightRank === -1) {
            return left.localeCompare(right);
          }
          if (leftRank === -1) {
            return 1;
          }
          if (rightRank === -1) {
            return -1;
          }
          return leftRank - rightRank;
        });
        return (
          <section className="scenario-pack" key={pack.id}>
            <header className="scenario-pack-head">
              <div className="scenario-pack-title">
                <span className="scenario-pack-label">
                  <Layers size={14} />
                  {meta.label}
                </span>
                <h2>{pack.title}</h2>
                <p>{pack.narrative}</p>
              </div>
              <div className="scenario-coverage">
                <div className="scenario-coverage-head">
                  <span>链路验证覆盖</span>
                  <strong>{coverage}%</strong>
                </div>
                <div className="scenario-coverage-bar">
                  <i style={{ width: `${coverage}%` }} />
                </div>
                <small>
                  {verified}/{items.workflows.length} 条工作流有成功运行
                </small>
              </div>
            </header>

            <div className="scenario-pack-stats">
              <div>
                <span>工作流</span>
                <strong>{items.workflows.length}</strong>
              </div>
              <div>
                <span>Agent</span>
                <strong>{items.agents.length}</strong>
              </div>
              <div>
                <span>工具</span>
                <strong>{items.tools.length}</strong>
              </div>
              <div>
                <span>近期运行</span>
                <strong>{packRuns.length}</strong>
              </div>
              <div>
                <span>成功率</span>
                <strong>
                  {packTerminal.length
                    ? `${Math.round((packSucceeded / packTerminal.length) * 100)}%`
                    : "—"}
                </strong>
              </div>
            </div>

            <div className="scenario-workflows">
              {ordered.map((workflowId) => {
                const summary = workflowById.get(workflowId);
                const stats = statsByWorkflow.get(workflowId);
                return (
                  <article className={`scenario-workflow is-${stats?.tone ?? "idle"}`} key={workflowId}>
                    <button
                      type="button"
                      className="scenario-workflow-open"
                      onClick={() => handlers.onOpenWorkflow(workflowId)}
                      title="在编排器中打开"
                    >
                      <span className="scenario-workflow-name">
                        <strong>{summary?.name ?? workflowId}</strong>
                        <ArrowUpRight size={13} />
                      </span>
                      <small>
                        {workflowId}
                        {summary ? ` · ${summary.nodeCount} 个顶层节点` : " · 尚未载入"}
                      </small>
                    </button>
                    <div className="scenario-workflow-meta">
                      {pack.interactive[workflowId] && (
                        <span className="scenario-tag is-human">{pack.interactive[workflowId]}</span>
                      )}
                      <span className={`scenario-tag is-${stats?.tone ?? "idle"}`}>
                        {stats?.tone === "verified" ? (
                          <CheckCircle2 size={12} />
                        ) : stats?.tone === "running" ? (
                          <Activity size={12} />
                        ) : null}
                        {workflowStatusLabel(stats)}
                      </span>
                      <small>
                        {stats?.lastRun
                          ? `${stats.runs.length} 次运行 · 最近 ${formatDateTime(stats.lastRun.startedAt)} · ${runStatusLabel(stats.lastRun.status)}`
                          : "尚无运行记录"}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="scenario-workflow-link"
                      onClick={handlers.onOpenMonitor}
                      title="查看运行台账"
                    >
                      台账
                    </button>
                  </article>
                );
              })}
            </div>

            <footer className="scenario-actions">
              {pack.actions(handlers).map((action) => {
                const Icon = action.icon;
                return (
                  <button
                    type="button"
                    className="platform-button is-ghost"
                    key={action.label}
                    onClick={action.onClick}
                  >
                    <Icon size={15} />
                    {action.label}
                  </button>
                );
              })}
            </footer>
          </section>
        );
      })}
    </div>
  );
}

type EvidencePhase = "user" | "workflow" | "human" | "output";
type EvidenceItem = {
  key: string;
  phase: EvidencePhase;
  action: string;
  detail: string;
  nodeId: string;
};

const STEP_PRESENTATION: Record<string, { phase: EvidencePhase; label: string }> = {
  start: { phase: "user", label: "用户开始训练" },
  "create-classroom": { phase: "user", label: "用户创建虚拟班级" },
  "create-session": { phase: "user", label: "用户创建虚拟个案" },
  "teacher-turn": { phase: "human", label: "教师发言（人工交互）" },
  "counselor-turn": { phase: "human", label: "辅导员发言（人工交互）" },
  "student-reactions": { phase: "workflow", label: "学生 Agent 反应" },
  "teacher-feedback": { phase: "workflow", label: "观察员点评" },
  "counselor-turn-result": { phase: "workflow", label: "学生 Agent 回应" },
  "coach-feedback": { phase: "workflow", label: "督导即时提示" },
  report: { phase: "output", label: "生成诊断报告" },
  "finish-session": { phase: "output", label: "生成复盘报告" },
  end: { phase: "output", label: "运行结束" }
};

function evidencePhaseLabel(phase: EvidencePhase): string {
  return phase === "user"
    ? "用户操作"
    : phase === "human"
      ? "人工交互"
      : phase === "output"
        ? "输出报告"
        : "工作流节点";
}

function clipText(value: string, max = 88): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function buildEvidenceTimeline(trace: TraceResponse): EvidenceItem[] {
  const interactionByStep = new Map(trace.interactions.map((item) => [item.stepId, item]));
  const items: EvidenceItem[] = [];
  for (const step of trace.steps) {
    if (step.status === "skipped") {
      continue;
    }
    const presentation = STEP_PRESENTATION[step.nodeId] ?? {
      phase: "workflow" as const,
      label: step.nodeId
    };
    const interaction = interactionByStep.get(step.id);
    items.push({
      key: step.id,
      phase: presentation.phase,
      action: presentation.label,
      detail: evidenceDetail(step, interaction),
      nodeId: step.nodeId
    });
  }
  return items;
}

function evidenceDetail(step: StepRecord, interaction?: InteractionRecord): string {
  if (step.nodeKind === "human") {
    const response = interaction?.response;
    const text = typeof response?.text === "string" ? response.text.trim() : "";
    if (text) {
      return interaction?.status === "pending" ? "等待提交" : `提交：${clipText(text)}`;
    }
    return typeof response?.action === "string" && response.action === "finish"
      ? "选择结束，进入报告节点"
      : "等待人工输入";
  }
  const output = step.output as Record<string, unknown> | undefined;
  if (step.nodeId === "create-classroom" && output) {
    return `已生成 ${String(output.sessionId ?? "课堂会话")} 的学生画像与课堂状态`;
  }
  if (step.nodeId === "create-session" && output) {
    const session = output.session as { id?: string; student?: { name?: string } } | undefined;
    return `已创建个案 ${session?.id ?? ""}${session?.student?.name ? ` · ${session.student.name}` : ""}`;
  }
  if (step.nodeId === "student-reactions" && output) {
    const reactions = Array.isArray(output.studentReactions) ? output.studentReactions.length : 0;
    const tips = Array.isArray(output.observerTips) ? output.observerTips.length : 0;
    return `${reactions} 名学生 Agent 响应，${tips} 条观察员提示`;
  }
  if (step.nodeId === "teacher-feedback" && output) {
    return clipText(String(output.summary ?? (Array.isArray(output.nextMoves) ? output.nextMoves[0] : "") ?? "已生成观察员点评"));
  }
  if (step.nodeId === "counselor-turn-result" && output) {
    const session = output.session as { messages?: Array<{ role?: string }> } | undefined;
    const replies = session?.messages?.filter((message) => message.role === "student").length ?? 0;
    return `${replies} 次学生回应已写入谈话记录`;
  }
  if (step.nodeId === "coach-feedback" && output) {
    const suggestions = Array.isArray(output.suggestions) ? output.suggestions : [];
    return clipText(String(suggestions[0] ?? "已生成督导提示"));
  }
  if (step.nodeId === "report" && output) {
    const report = output.report as { overallScore?: number } | undefined;
    return report?.overallScore !== undefined
      ? `诊断报告已生成 · 综合评分 ${report.overallScore}`
      : "诊断报告与引用已生成";
  }
  if (step.nodeId === "finish-session" && output) {
    const session = output.session as { report?: { overallScore?: number } } | undefined;
    return session?.report?.overallScore !== undefined
      ? `复盘报告已生成 · 综合评分 ${session.report.overallScore}`
      : "复盘报告已保存";
  }
  if (step.error) {
    return clipText(step.error);
  }
  return step.status === "waiting" ? "等待人工输入" : "节点已执行";
}

function shortRun(runId: string): string {
  return runId.length > 16 ? `${runId.slice(0, 14)}…` : runId;
}

function runTone(run: RunRecord): "verified" | "running" | "failed" | "idle" {
  if (!TERMINAL_STATUSES.has(run.status)) {
    return "running";
  }
  if (run.status === "succeeded") {
    return "verified";
  }
  return run.status === "failed" ? "failed" : "idle";
}

function workflowStatusLabel(stats?: WorkflowStats): string {
  if (!stats) {
    return "未运行";
  }
  if (stats.tone === "running") {
    return `${stats.active} 次进行中`;
  }
  if (stats.tone === "verified") {
    return "已验证";
  }
  if (stats.tone === "failed") {
    return "最近失败";
  }
  return "未成功";
}

function formatDateTime(iso?: string): string {
  if (!iso) {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}
