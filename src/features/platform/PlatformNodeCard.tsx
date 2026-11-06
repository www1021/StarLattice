import { useContext } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { AlertTriangle, ChevronsDownUp, ChevronsUpDown, Clock3 } from "lucide-react";
import { CanvasContainerContext } from "./canvasContainerContext";
import { categoryLabel, categoryOf, NODE_VISUALS } from "./nodeVisuals";
import type { PlatformIssue, WorkflowNode } from "./types";

export type PlatformNodeData = {
  definition: WorkflowNode;
  label: string;
  accent: string;
  status?: "succeeded" | "failed" | "running";
  durationMs?: number;
  issues: PlatformIssue[];
  inputs: string[];
  /** 展开容器时给内部步骤加的路由标签（分支 1 / 满足条件 / 循环体）。 */
  innerLabel?: string;
  /** 内部步骤归属的顶层容器；点击时回落到容器检查器。 */
  ownerId?: string;
  canExpand?: boolean;
  expanded?: boolean;
  childCount?: number;
  readOnly?: boolean;
};

export type PlatformFlowNode = Node<PlatformNodeData, "platform">;

export function PlatformNodeCard({ data, selected }: NodeProps<PlatformFlowNode>) {
  const { definition, label, accent, status, durationMs, issues, inputs } = data;
  const { isExpanded, toggle } = useContext(CanvasContainerContext);
  const Icon = NODE_VISUALS[definition.kind].icon;
  const category = categoryOf(definition.kind);
  const expanded = data.expanded ?? isExpanded(definition.id);

  return (
    <div
      className={`platform-node ${selected ? "is-selected" : ""} ${status ? `is-${status}` : ""} ${
        issues.length > 0 ? "has-issue" : ""
      } ${data.readOnly ? "is-inner" : ""}`}
    >
      {data.innerLabel && <span className="platform-node-inline-label">{data.innerLabel}</span>}
      <Handle type="target" position={Position.Left} className="platform-handle" />

      <div className="platform-node-head">
        <span
          className="platform-node-icon"
          style={{ background: `${accent}14`, color: accent }}
          aria-hidden
        >
          <Icon size={17} strokeWidth={1.9} />
        </span>
        <div className="platform-node-ident">
          <strong className="platform-node-title">{definition.title || definition.id}</strong>
          <code className="platform-node-id">{definition.id}</code>
        </div>
        {status ? (
          <span className={`platform-node-status is-${status}`}>
            <span className="platform-node-status-dot" />
            {statusLabel(status)}
          </span>
        ) : (
          <span className="platform-node-category">{categoryLabel(category)}</span>
        )}
      </div>

      <p className="platform-node-summary">{summarize(definition)}</p>

      <div className="platform-node-io">
        <div className="platform-node-io-row">
          <span>输入</span>
          <strong title={inputs.join(" · ")}>
            {inputs.length > 0 ? inputs.slice(0, 3).join(" · ") : "—"}
          </strong>
        </div>
        <div className="platform-node-io-row">
          <span>输出</span>
          <strong className="is-ref">{`\${${definition.id}}`}</strong>
        </div>
      </div>

      <div className="platform-node-foot">
        <span className="platform-node-kind" style={{ background: `${accent}14`, color: accent }}>
          {label}
        </span>
        {data.canExpand && (
          <button
            type="button"
            className="platform-node-expand nodrag"
            onClick={(event) => {
              event.stopPropagation();
              toggle(definition.id);
            }}
            title={expanded ? "收起内部步骤" : `展开 ${data.childCount ?? 0} 个内部步骤`}
          >
            {expanded ? <ChevronsDownUp size={11} /> : <ChevronsUpDown size={11} />}
            {expanded ? "收起" : `展开 ${data.childCount ?? 0} 步`}
          </button>
        )}
        {durationMs !== undefined && (
          <span className="platform-node-time">
            <Clock3 size={11} />
            {formatDuration(durationMs)}
          </span>
        )}
        {issues.length > 0 && (
          <span className="platform-node-issue" title={issues[0]?.message}>
            <AlertTriangle size={11} />
            {issues.length}
          </span>
        )}
      </div>

      <Handle type="source" position={Position.Right} className="platform-handle" />
    </div>
  );
}

function statusLabel(status: "succeeded" | "failed" | "running"): string {
  if (status === "succeeded") {
    return "成功";
  }
  if (status === "failed") {
    return "失败";
  }
  return "运行中";
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

function summarize(node: WorkflowNode): string {
  switch (node.kind) {
    case "start":
      return "流程入口 · 接收工作流输入";
    case "end":
      return "流程出口 · 汇总最终结果";
    case "agent":
      return `调用 ${node.agent || "未配置 Agent"}`;
    case "llm":
      return `${node.model || "默认模型"}${node.thinking === false ? "" : " · 思考摘要"}`;
    case "knowledge":
      return `检索 ${node.query || "未设置查询"}`;
    case "tool":
      return `调用 ${node.tool || "未配置工具"}`;
    case "http":
      return `${node.method ?? "GET"} ${shortUrl(node.url)}`;
    case "template":
      return `模板拼接 · ${(node.template ?? "").length} 字符`;
    case "subworkflow":
      return `子流程 ${node.workflowId || "未选择"}${
        node.workflowVersion === undefined ? "" : ` v${node.workflowVersion}`
      }`;
    case "verify":
      return `验证器 ${node.verifier || "未配置"} · 阈值 ${node.threshold ?? 0.8}`;
    case "approve":
      return `人工审批 · ${node.assignee || "未指定审批人"}`;
    case "human":
      return `人工交互 · ${node.assignee || "未指定操作人"}`;
    case "parallel":
      return `${node.branches?.length ?? 0} 个并行分支`;
    case "condition":
      return `then ${node.then?.length ?? 0} · else ${node.else?.length ?? 0}`;
    case "loop":
      return `最多 ${node.maxIterations ?? 1} 轮 · 循环体 ${node.body?.length ?? 0} 步`;
  }
}

function shortUrl(url: string | undefined): string {
  if (!url) {
    return "未配置地址";
  }
  try {
    return new URL(url).host + new URL(url).pathname;
  } catch {
    return url;
  }
}
