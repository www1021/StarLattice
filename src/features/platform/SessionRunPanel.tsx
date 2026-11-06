import { useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  CircleDot,
  GitBranch,
  Loader2,
  Workflow as WorkflowIcon
} from "lucide-react";
import type { InteractionRecord, StepRecord, TraceResponse } from "./types";

type RailStep = { id: string; label: string; hint?: string };

export type SessionRunPanelProps = {
  workflowId: string;
  workflowName?: string;
  runId?: string;
  trace?: TraceResponse;
  steps: RailStep[];
  turnNodeId?: string;
  turnStepId?: string;
  turnLabel?: string;
  followupLabels?: string[];
  onOpenMonitor?: () => void;
  onOpenWorkflow?: (nodeId?: string) => void;
};

function topLevelId(step: StepRecord): string {
  return step.path.split("/")[0] || step.nodeId;
}

function pendingInteraction(trace?: TraceResponse): InteractionRecord | undefined {
  return trace?.interactions.find((item) => item.status === "pending");
}

function currentNodeId(trace?: TraceResponse): string | undefined {
  if (!trace) {
    return undefined;
  }
  const pending = pendingInteraction(trace);
  if (pending) {
    return pending.nodeId;
  }
  const running = [...trace.steps]
    .reverse()
    .find((step) => step.status === "running" || step.status === "waiting");
  if (running) {
    return running.nodeId;
  }
  const last = [...trace.steps].reverse().find((step) => step.status !== "skipped");
  return last?.nodeId;
}

function activeTopLevel(trace?: TraceResponse): string | undefined {
  if (!trace) {
    return undefined;
  }
  const pending = pendingInteraction(trace);
  if (pending) {
    return pending.path.split("/")[0] || pending.nodeId;
  }
  const running = [...trace.steps]
    .reverse()
    .find((step) => step.status === "running" || step.status === "waiting");
  if (running) {
    return topLevelId(running);
  }
  return undefined;
}

function stepState(stepId: string, trace?: TraceResponse): "done" | "active" | "pending" {
  if (!trace) {
    return "pending";
  }
  const related = trace.steps.filter(
    (step) => topLevelId(step) === stepId || step.nodeId === stepId
  );
  if (related.some((step) => step.status === "running" || step.status === "waiting")) {
    return "active";
  }
  if (related.some((step) => step.status === "failed")) {
    return "active";
  }
  if (related.length > 0 && related.every((step) => step.status === "succeeded" || step.status === "skipped")) {
    return "done";
  }
  if (related.some((step) => step.status === "succeeded")) {
    return "done";
  }
  return "pending";
}

function shortRunId(runId?: string): string {
  if (!runId) {
    return "尚未运行";
  }
  return runId.length > 14 ? `${runId.slice(0, 12)}…` : runId;
}

function runStatusText(trace?: TraceResponse): string | undefined {
  if (!trace) {
    return undefined;
  }
  switch (trace.run.status) {
    case "succeeded":
      return "已完成";
    case "failed":
      return "运行失败";
    case "cancelled":
      return "已取消";
    case "waiting_input":
      return "等待人工输入";
    case "waiting_approval":
      return "等待审批";
    default:
      return "运行中";
  }
}

export function SessionRunBar({
  workflowId,
  workflowName,
  runId,
  trace,
  steps,
  turnLabel,
  onOpenMonitor,
  onOpenWorkflow
}: SessionRunPanelProps) {
  const pending = pendingInteraction(trace);
  const topLevel = activeTopLevel(trace);
  const activeStep = steps.find((step) => step.id === topLevel);
  const statusText = runStatusText(trace);
  const currentLabel = !trace
    ? "等待首次运行"
    : trace.run.status === "succeeded"
      ? "全部节点已完成"
      : pending
        ? `${activeStep?.label ?? "交互节点"} · 等待${pending.title || turnLabel || "人工输入"}`
        : statusText;

  return (
    <div className={`session-run-bar ${trace ? `is-${trace.run.status}` : "is-idle"}`}>
      <span className="session-run-bar-badge">
        <WorkflowIcon size={13} />
        工作流驱动
      </span>
      <code className="session-run-bar-workflow">{workflowName ?? workflowId}</code>
      <span className="session-run-bar-run" title={runId}>
        <GitBranch size={12} />
        {shortRunId(runId)}
      </span>
      <span className="session-run-bar-current">
        <CircleDot size={12} />
        当前节点：{currentLabel}
      </span>
      <div className="session-run-bar-actions">
        <button
          type="button"
          className="session-run-bar-link"
          onClick={onOpenMonitor}
          disabled={!runId || !onOpenMonitor}
        >
          查看 trace
        </button>
        <button
          type="button"
          className="session-run-bar-link"
          onClick={() => onOpenWorkflow?.(currentNodeId(trace))}
          disabled={!onOpenWorkflow}
        >
          在编排器中打开
          <ArrowUpRight size={12} />
        </button>
      </div>
    </div>
  );
}

export function SessionRunRail({
  workflowId,
  workflowName,
  runId,
  trace,
  steps,
  turnNodeId,
  turnStepId,
  turnLabel,
  followupLabels = [],
  onOpenMonitor,
  onOpenWorkflow
}: SessionRunPanelProps) {
  const [expanded, setExpanded] = useState(true);
  const turns = (trace?.interactions ?? [])
    .filter((item) => item.nodeId === turnNodeId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const pending = pendingInteraction(trace);
  const active = activeTopLevel(trace);

  return (
    <aside className="session-run-rail" aria-label="工作流进度">
      <header className="session-run-rail-head">
        <div>
          <span>工作流进度</span>
          <strong>{workflowName ?? workflowId}</strong>
        </div>
        <button
          type="button"
          className="session-run-rail-toggle"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? "收起" : "展开"}
        </button>
      </header>

      <div className="session-run-rail-meta">
        <code>{shortRunId(runId)}</code>
        <span className={`session-run-rail-status is-${trace?.run.status ?? "idle"}`}>
          {runStatusText(trace) ?? "等待运行"}
        </span>
      </div>

      {expanded && (
        <ol className="session-run-steps">
          {steps.map((step, index) => {
            const state = stepState(step.id, trace);
            const isTurnStep = step.id === (turnStepId ?? turnNodeId);
            return (
              <li key={step.id} className={`session-run-step is-${state}`}>
                <span className="session-run-step-dot" aria-hidden="true">
                  {state === "done" ? <CheckCircle2 size={14} /> : index + 1}
                </span>
                <div className="session-run-step-body">
                  <strong>{step.label}</strong>
                  {step.hint && <small>{step.hint}</small>}
                  {isTurnStep && turns.length > 0 && (
                    <ol className="session-run-turns">
                      {turns.map((turn, turnIndex) => {
                        const answered = turn.status === "answered";
                        const waiting = pending?.id === turn.id;
                        const finished = turn.response?.action === "finish";
                        return (
                          <li key={turn.id} className={waiting ? "is-active" : answered ? "is-done" : ""}>
                            <span>
                              {waiting ? <Loader2 size={11} className="is-spinning" /> : answered ? "✓" : "·"}
                              第 {turnIndex + 1} 轮 · {turnLabel ?? "人工发言"}
                            </span>
                            <small>
                              {waiting
                                ? "等待输入"
                                : answered
                                  ? finished
                                    ? "已提交 · 结束训练"
                                    : followupLabels.length
                                      ? `已提交 → ${followupLabels.join(" → ")}`
                                      : "已提交"
                                  : "未开始"}
                            </small>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                  {isTurnStep && turns.length === 0 && active === step.id && (
                    <small>等待第一轮人工输入</small>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="session-run-rail-actions">
        <button type="button" onClick={onOpenMonitor} disabled={!runId || !onOpenMonitor}>
          查看 trace
        </button>
        <button
          type="button"
          onClick={() => onOpenWorkflow?.(currentNodeId(trace))}
          disabled={!onOpenWorkflow}
        >
          在编排器中打开
        </button>
      </div>
    </aside>
  );
}

export { currentNodeId };
