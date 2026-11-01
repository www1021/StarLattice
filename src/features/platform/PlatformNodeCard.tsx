import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { PlatformIssue, WorkflowNode } from "./types";

export type PlatformNodeData = {
  definition: WorkflowNode;
  label: string;
  accent: string;
  status?: "succeeded" | "failed" | "running";
  issues: PlatformIssue[];
};

export type PlatformFlowNode = Node<PlatformNodeData, "platform">;

export function PlatformNodeCard({ data, selected }: NodeProps<PlatformFlowNode>) {
  const { definition, label, accent, status, issues } = data;
  return (
    <div
      className={`platform-node ${selected ? "is-selected" : ""} ${status ? `is-${status}` : ""} ${
        issues.length > 0 ? "has-issue" : ""
      }`}
    >
      <Handle type="target" position={Position.Left} className="platform-handle" />
      <div className="platform-node-head">
        <span className="platform-node-kind" style={{ background: `${accent}1a`, color: accent }}>
          {label}
        </span>
        {status && <span className={`platform-node-dot is-${status}`} />}
      </div>
      <strong className="platform-node-title">{definition.title || definition.id}</strong>
      <code className="platform-node-id">{definition.id}</code>
      <p className="platform-node-summary">{summarize(definition)}</p>
      {issues.length > 0 && <p className="platform-node-issue">{issues[0].message}</p>}
      <Handle type="source" position={Position.Right} className="platform-handle" />
    </div>
  );
}

function summarize(node: WorkflowNode): string {
  switch (node.kind) {
    case "agent":
      return `调用 ${node.agent || "未配置 Agent"}`;
    case "llm":
      return `${node.model || "默认模型"}${node.thinking === false ? "" : " · 思考摘要"}`;
    case "tool":
      return `调用 ${node.tool || "未配置工具"}`;
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
    case "parallel":
      return `${node.branches?.length ?? 0} 个并行分支`;
    case "condition":
      return `then ${node.then?.length ?? 0} · else ${node.else?.length ?? 0}`;
    case "loop":
      return `最多 ${node.maxIterations ?? 1} 轮 · 循环体 ${node.body?.length ?? 0} 步`;
  }
}
