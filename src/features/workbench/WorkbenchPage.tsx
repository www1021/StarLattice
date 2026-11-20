import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowRight,
  BookOpen,
  Database,
  FileText,
  LayoutGrid,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Sparkles,
  Workflow
} from "lucide-react";
import { USER_DISPLAY_NAME } from "../profile";
import { platformApi } from "../platform/api";
import { runStatusLabel } from "../platform/layout";
import { WORKFLOW_TEMPLATES } from "../platform/templates";
import type { RunRecord, WorkflowSummary } from "../platform/types";
import "./workbench.css";

type WorkbenchPageProps = {
  onOpenChat: () => void;
  onOpenPlatform: () => void;
  onOpenWorkflow: (workflowId: string) => void;
  onOpenMonitor: (runId?: string) => void;
  onOpenLibrary: () => void;
  onOpenRegistry: () => void;
  onNewWorkflow: () => void;
};

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "凌晨好";
  if (hour < 12) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatWhen(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return `今天 ${hm}`;
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")} ${hm}`;
}

function toneOf(status: RunRecord["status"]): "ok" | "bad" | "run" | "muted" {
  if (status === "succeeded") return "ok";
  if (status === "queued" || status === "running" || status === "verifying" || status === "revising") {
    return "run";
  }
  if (status === "failed" || status === "rolled_back") return "bad";
  return "muted";
}

export function WorkbenchPage({
  onOpenChat,
  onOpenPlatform,
  onOpenWorkflow,
  onOpenMonitor,
  onOpenLibrary,
  onOpenRegistry,
  onNewWorkflow
}: WorkbenchPageProps) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const [workflowResult, runResult] = await Promise.all([
        platformApi.listWorkflows(),
        platformApi.listRuns(8)
      ]);
      setWorkflows(workflowResult.workflows ?? []);
      setRuns(runResult.runs ?? []);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const workflowNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const workflow of workflows) {
      map.set(workflow.id, workflow.name);
    }
    return map;
  }, [workflows]);

  const successRate = useMemo(() => {
    const finished = runs.filter((run) => run.status === "succeeded" || run.status === "failed");
    if (finished.length === 0) return undefined;
    const ok = finished.filter((run) => run.status === "succeeded").length;
    return Math.round((ok / finished.length) * 100);
  }, [runs]);

  const latestRun = runs[0];

  return (
    <div className="wb">
      <header className="wb-head">
        <div>
          <h1>
            {greeting()}，{USER_DISPLAY_NAME}
          </h1>
          <p>
            {status === "loading"
              ? "正在读取工作流与运行记录…"
              : status === "error"
                ? "没能读到工作流列表，可以先从左侧进入画布"
                : `${workflows.length} 条工作流可用${latestRun ? `，最近一次运行在 ${formatWhen(latestRun.startedAt)}` : "，还没有运行记录"}`}
          </p>
        </div>
        <div className="wb-head-actions">
          <button
            type="button"
            className="wb-btn is-icon"
            title="刷新"
            aria-label="刷新"
            onClick={() => void load()}
          >
            <RefreshCw size={14} strokeWidth={1.8} className={status === "loading" ? "wb-spin" : ""} />
          </button>
          <button type="button" className="wb-btn" onClick={onOpenLibrary}>
            <BookOpen size={15} strokeWidth={1.7} />
            导入知识
          </button>
          <button type="button" className="wb-btn" onClick={onNewWorkflow}>
            <Plus size={15} strokeWidth={1.8} />
            新建工作流
          </button>
        </div>
      </header>

      <section className="wb-actions">
        <button type="button" className="wb-act" onClick={onOpenChat}>
          <span className="wb-act-icon is-chat">
            <MessageSquare size={17} strokeWidth={1.7} />
          </span>
          <strong>直接问 AI</strong>
          <span className="wb-act-desc">写作、总结、翻译、会议纪要，一句话就能拿到结果</span>
          <div className="wb-act-tags" aria-hidden="true" />
          <span className="wb-act-link">
            开始对话
            <ArrowRight size={13} strokeWidth={1.8} />
          </span>
        </button>

        <button type="button" className="wb-act" onClick={onOpenPlatform}>
          <span className="wb-act-icon is-tpl">
            <Sparkles size={17} strokeWidth={1.7} />
          </span>
          <strong>用模板跑一次</strong>
          <span className="wb-act-desc">
            {workflows.length > 0
              ? `已有 ${workflows.length} 条流程，挑一条填参数就能跑`
              : "还没有工作流，先挑个模板再填参数"}
          </span>
          <div className="wb-act-tags">
            {workflows.slice(0, 2).map((workflow) => (
              <span key={workflow.id} className="wb-tag">
                {workflow.name}
              </span>
            ))}
            {workflows.length > 2 ? <span className="wb-tag">+{workflows.length - 2}</span> : null}
          </div>
          <span className="wb-act-link">
            挑一个模板
            <ArrowRight size={13} strokeWidth={1.8} />
          </span>
        </button>

        <button type="button" className="wb-act" onClick={onOpenPlatform}>
          <span className="wb-act-icon is-canvas">
            <Workflow size={17} strokeWidth={1.7} />
          </span>
          <strong>自己搭工作流</strong>
          <span className="wb-act-desc">从空白画布开始，连节点、配参数、跑通全流程</span>
          <div className="wb-act-tags">
            <span className="wb-tag">17 类节点</span>
            <span className="wb-tag">支持引用上游</span>
          </div>
          <span className="wb-act-link">
            打开画布
            <ArrowRight size={13} strokeWidth={1.8} />
          </span>
        </button>

        <button type="button" className="wb-act is-run" onClick={() => onOpenMonitor()}>
          <span className="wb-act-icon is-run">
            <Activity size={17} strokeWidth={1.7} />
          </span>
          <strong>回看运行轨迹</strong>
          <span className="wb-act-desc">每个节点做了什么、耗时多少、卡在哪一步</span>
          <div className="wb-act-tags">
            <span className="wb-tag">{runs.length} 次运行</span>
            {successRate === undefined ? null : <span className="wb-tag">成功率 {successRate}%</span>}
          </div>
          <span className="wb-act-link">
            打开运行记录
            <ArrowRight size={13} strokeWidth={1.8} />
          </span>
        </button>
      </section>

      <div className="wb-grid">
        <section className="wb-card">
          <div className="wb-card-head">
            <h2>最近运行</h2>
            <button type="button" className="wb-link" onClick={() => onOpenMonitor()}>
              全部运行
              <ArrowRight size={12} strokeWidth={1.8} />
            </button>
          </div>

          {status === "loading" ? (
            <div className="wb-empty">
              <Loader2 size={14} className="wb-spin" />
              正在读取运行记录
            </div>
          ) : status === "error" ? (
            <div className="wb-empty">
              后端没有响应
              <button type="button" className="wb-link" onClick={() => void load()}>
                <RefreshCw size={12} />
                重试
              </button>
            </div>
          ) : runs.length === 0 ? (
            <div className="wb-empty">还没有运行记录，先跑一次模板试试</div>
          ) : (
            <div className="wb-runs">
              {runs.slice(0, 8).map((run) => (
                <button
                  type="button"
                  key={run.id}
                  className="wb-run"
                  onClick={() => onOpenMonitor(run.id)}
                >
                  <span className={`wb-dot is-${toneOf(run.status)}`} />
                  <span className="wb-run-name">
                    <b>{workflowNames.get(run.workflowId) ?? run.workflowId}</b>
                    <em>
                      v{run.workflowVersion} · {run.stepCount} 步
                    </em>
                  </span>
                  <span className="wb-run-when">{formatWhen(run.startedAt)}</span>
                  <span className="wb-run-dur">{formatDuration(run.durationMs)}</span>
                  <span className={`wb-run-status is-${toneOf(run.status)}`}>
                    {runStatusLabel(run.status)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="wb-card">
          <div className="wb-card-head">
            <h2>我的工作流</h2>
            <button type="button" className="wb-link" onClick={onOpenPlatform}>
              管理
              <ArrowRight size={12} strokeWidth={1.8} />
            </button>
          </div>

          {workflows.length === 0 ? (
            <div className="wb-empty">还没有工作流</div>
          ) : (
            <div className="wb-wfs">
              {workflows.slice(0, 6).map((workflow) => (
                <button
                  type="button"
                  key={workflow.id}
                  className="wb-wf"
                  onClick={() => onOpenWorkflow(workflow.id)}
                >
                  <span className="wb-wf-bar" />
                  <span className="wb-wf-name">
                    <b>{workflow.name}</b>
                    <em>
                      {workflow.nodeCount} 个节点 · v{workflow.version}
                    </em>
                  </span>
                  <ArrowRight size={13} strokeWidth={1.8} className="wb-wf-go" />
                </button>
              ))}
            </div>
          )}

          <div className="wb-stats">
            <div>
              <b>{workflows.length}</b>
              <span>工作流</span>
            </div>
            <div>
              <b>{runs.length}</b>
              <span>近期运行</span>
            </div>
            <div>
              <b>{successRate === undefined ? "—" : `${successRate}%`}</b>
              <span>成功率</span>
            </div>
          </div>
        </section>
      </div>

      <section className="wb-guide">
        <div className="wb-guide-lead">
          <h3>三步跑通第一条流程</h3>
          <p>从模板开始最快，跑完就能看懂运行记录</p>
        </div>
        <div className="wb-steps">
          <button type="button" className="wb-step" onClick={onOpenPlatform}>
            <span className="wb-step-n">
              <LayoutGrid size={12} strokeWidth={1.9} />
            </span>
            <span>
              <b>挑一条现成流程</b>
              <em>画布左侧「模板」</em>
            </span>
          </button>
          <button type="button" className="wb-step" onClick={onOpenLibrary}>
            <span className="wb-step-n">
              <Database size={12} strokeWidth={1.9} />
            </span>
            <span>
              <b>接一个知识库</b>
              <em>让回答有依据</em>
            </span>
          </button>
          <button type="button" className="wb-step" onClick={() => onOpenMonitor()}>
            <span className="wb-step-n">
              <FileText size={12} strokeWidth={1.9} />
            </span>
            <span>
              <b>看懂运行轨迹</b>
              <em>每个节点做了什么</em>
            </span>
          </button>
        </div>
      </section>

      <section className="wb-tpls">
        <span className="wb-tpls-label">常用模板</span>
        <div className="wb-tpls-row">
          {WORKFLOW_TEMPLATES.map((template) => (
            <button
              key={template.id}
              type="button"
              className="wb-tpl"
              onClick={onOpenPlatform}
              title={template.description}
            >
              <b>{template.name}</b>
              <span>{template.badge}</span>
            </button>
          ))}
        </div>
        <button type="button" className="wb-link" onClick={onOpenPlatform}>
          去画布取用
          <ArrowRight size={12} strokeWidth={1.8} />
        </button>
      </section>
    </div>
  );
}
