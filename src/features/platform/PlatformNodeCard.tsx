import { useContext, useEffect, useRef, useState } from "react";
import { Handle, Position, useUpdateNodeInternals, type Node, type NodeProps } from "@xyflow/react";
import { AlertTriangle, ChevronsDownUp, ChevronsUpDown, Clock3 } from "lucide-react";
import { CanvasContainerContext } from "./canvasContainerContext";
import { NODE_VISUALS, nodeTintStyle } from "./nodeVisuals";
import type { PlatformIssue, WorkflowNode } from "./types";
import { CHOICE_OTHER_PORT, choiceOptionsOf, choicePortOf } from "./choicePorts";

export type PlatformNodeData = {
  definition: WorkflowNode;
  label: string;
  accent: string;
  status?: "succeeded" | "failed" | "running" | "skipped";
  /** 停在人工输入上等回答：这时不该显示耗时（它还没跑完，0 ms 会让人以为已经过了）。 */
  waitingForInput?: boolean;
  durationMs?: number;
  issues: PlatformIssue[];
  inputs: string[];
  /** 这个节点出边上挂的条件，收在卡片里显示，不铺到画布上。 */
  branches?: Array<{ key: string; when: string }>;
  /** 点右上角「详情」查看这个节点的运行结果。 */
  onShowDetail?: () => void;
  /** 展开容器时给内部步骤加的路由标签（分支 1 / 满足条件 / 循环体）。 */
  innerLabel?: string;
  /** 内部步骤归属的顶层容器；点击时回落到容器检查器。 */
  ownerId?: string;
  canExpand?: boolean;
  expanded?: boolean;
  childCount?: number;
  readOnly?: boolean;
  /** 点击标题就地改名；只有可编辑的顶层节点会拿到这个回调。 */
  onRename?: (nodeId: string, title: string) => void;
};

export type PlatformFlowNode = Node<PlatformNodeData, "platform">;

type NodeRow = { key: string; value: string; muted?: boolean; code?: boolean; port?: string };

/**
 * 画布卡片只交代「变量进出」：出边条件、入参、产出变量。
 * 模型、提示词字数、轮次、模板字数这些配置项在右侧检查器里已经写全了，
 * 卡片上再抄一遍只会把画布糊成一片，所以这里一律不展示。
 */
function nodeRows(node: WorkflowNode, data: PlatformNodeData): NodeRow[] {
  const rows: NodeRow[] = [];
  // 选项卡有选项时，卡片直接列选项本身，每行右侧挂一个输出端口——
  // 这里显示 `${节点.字段}` 这种引用对用户没有任何意义，他关心的是「点了会走哪条路」。
  const choices = choiceOptionsOf(node);

  if (choices.length > 0) {
    choices.forEach((text, index) => {
      rows.push({ key: `选项${index + 1}`, value: text, port: choicePortOf(index) });
    });
    // 兜底口固定跟在选项后面：用户点「其他」或者写了不在列表里的内容就走这条。
    rows.push({
      key: "其他",
      value: "兜底：选的不在选项里时走这里",
      muted: true,
      port: CHOICE_OTHER_PORT
    });
  } else {
    // 出边上的条件收在卡片里，不铺到画布上。
    for (const branch of data.branches ?? []) {
      rows.push({ key: branch.key, value: branch.when, muted: true, code: true });
    }
  }

  if (node.kind === "start") {
    rows.push({
      key: "输入",
      value: data.inputs.length > 0 ? data.inputs.join("、") : "工作流入参",
      code: true
    });
  } else if (node.kind !== "end") {
    const names = outputVariableNames(node);
    if (names.length > 0) {
      rows.push({ key: "输出", value: names.join("、"), code: true });
    }
  }

  // 选项行就是端口行，不能被截断，否则会连出卡片上根本不存在的分支。
  return choices.length > 0 ? rows : rows.slice(0, 3);
}

/** 输出变量的预设名，与检查器里 Output 分支的只读字段保持一致。 */
const PRESET_OUTPUT_NAMES: Partial<Record<WorkflowNode["kind"], string[]>> = {
  llm: ["Output.Content", "Output.Thought"],
  template: ["Output.Answer"],
  agent: ["Output.Content"]
};

/**
 * 节点产出的变量清单（不是产物内容）：预设名 + 用户自定义的输出字段。
 * 画布上只报变量，运行结果点「详情」看。
 */
function outputVariableNames(node: WorkflowNode): string[] {
  // 参数提取的产物就是参数表：卡片上直接列字段名，下游能引用的就是这些。
  if (node.kind === "extract") {
    return (node.params ?? [])
      .map((param) => param.name?.trim())
      .filter((name): name is string => Boolean(name))
      .slice(0, 3);
  }
  const preset = PRESET_OUTPUT_NAMES[node.kind] ?? ["Output.Content"];
  const custom = (node.outputSchema ?? [])
    .map((item) => item.name?.trim())
    .filter((name): name is string => Boolean(name))
    .map((name) => `Output.${name}`);
  return [...preset, ...custom].slice(0, 3);
}

/** 节点名称长度上限，与输入框下的计数器一致。 */
export const NODE_TITLE_MAX = 100;

/**
 * 标题就地改名：点一下变成输入框，Enter / 失焦提交，Esc 取消。
 * 没传 onRename（内置只读步骤）就退回纯文本标题。
 */
export function EditableNodeTitle({
  node,
  onRename
}: {
  node: WorkflowNode;
  onRename?: (nodeId: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.title || "");
  const inputRef = useRef<HTMLInputElement>(null);

  const start = () => {
    setDraft(node.title || "");
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const commit = () => {
    if (!editing) {
      return;
    }
    const next = draft.trim();
    if (next && next !== (node.title || "")) {
      onRename?.(node.id, next);
    }
    setEditing(false);
  };

  if (!onRename) {
    return <strong className="platform-node-title">{node.title || node.id}</strong>;
  }

  if (editing) {
    return (
      <span className="platform-node-rename nodrag" onClick={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          value={draft}
          maxLength={NODE_TITLE_MAX}
          aria-label="节点名称"
          onChange={(event) => setDraft(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              commit();
            }
            if (event.key === "Escape") {
              setEditing(false);
            }
          }}
          onBlur={commit}
        />
        <small>
          {draft.length}/{NODE_TITLE_MAX}
        </small>
      </span>
    );
  }

  return (
    <strong
      className="platform-node-title is-editable nodrag"
      title="点击修改节点名称"
      onClick={(event) => {
        event.stopPropagation();
        start();
      }}
    >
      {node.title || node.id}
    </strong>
  );
}

/**
 * 画布卡片按腾讯云工作流的形态排：一行标题（图标 + 名称），
 * 下面最多三行「键：值」浅底信息条，不再堆端口胶囊和徽标。
 */
export function PlatformNodeCard({ data, selected }: NodeProps<PlatformFlowNode>) {
  const { definition, status, durationMs, issues } = data;
  const { isExpanded, toggle } = useContext(CanvasContainerContext);
  const Icon = NODE_VISUALS[definition.kind].icon;
  const expanded = data.expanded ?? isExpanded(definition.id);
  const rows = nodeRows(definition, data);
  const updateNodeInternals = useUpdateNodeInternals();

  // 增删选项会改变端口数量，xyflow 只在尺寸变化时重算端口位置。
  // 这里显式刷一次，连线才不会继续吸在已经不存在的旧端口上。
  const portKey = rows
    .map((row) => row.port)
    .filter(Boolean)
    .join(",");
  useEffect(() => {
    updateNodeInternals(definition.id);
  }, [definition.id, portKey, updateNodeInternals]);

  return (
    <div
      className={`platform-node ${selected ? "is-selected" : ""} ${status ? `is-${status}` : ""} ${
        issues.length > 0 ? "has-issue" : ""
      } ${data.readOnly ? "is-inner" : ""}`}
    >
      {data.innerLabel && <span className="platform-node-inline-label">{data.innerLabel}</span>}
      {data.waitingForInput && (
        <span className="platform-node-time-badge is-waiting" title="正在等人工输入">
          等待输入
        </span>
      )}
      {!data.waitingForInput && durationMs !== undefined && (
        <span
          className={`platform-node-time-badge${status ? ` is-${status}` : ""}`}
          title={`执行耗时 ${formatDuration(durationMs)}`}
        >
          <Clock3 size={9} />
          {formatDuration(durationMs)}
        </span>
      )}
      {data.onShowDetail && (
        <button
          type="button"
          className="platform-node-detail nodrag"
          title="查看这个节点的运行结果"
          onClick={(event) => {
            event.stopPropagation();
            data.onShowDetail?.();
          }}
        >
          详情
        </button>
      )}
      <Handle type="target" position={Position.Left} className="platform-handle" />

      <div className="platform-node-head">
        <span className="platform-node-icon" style={nodeTintStyle(definition.kind)} aria-hidden>
          <Icon size={13} strokeWidth={2.2} />
        </span>
        <EditableNodeTitle node={definition} onRename={data.onRename} />
        {status && (
          <span
            className={`platform-node-dot is-${status}`}
            title={
              status === "succeeded"
                ? "已通过"
                : status === "failed"
                  ? "失败"
                  : status === "skipped"
                    ? "本次跳过（上游分支没选中）"
                    : "运行中"
            }
          />
        )}
        {issues.length > 0 && (
          <span className="platform-node-issue" title={issues[0]?.message}>
            <AlertTriangle size={11} />
            {issues.length}
          </span>
        )}
      </div>

      {rows.length > 0 && (
        <div className="platform-node-rows">
          {rows.map((row) => (
            <div
              className={`platform-node-row${row.muted ? " is-muted" : ""}${
                row.port ? " has-port" : ""
              }`}
              key={`${row.key}-${row.port ?? row.value}`}
            >
              <span className="platform-node-row-key">{row.key}</span>
              <span
                className={`platform-node-row-value${row.code ? " is-code" : ""}`}
                title={row.value}
              >
                {row.value}
              </span>
              {row.port && (
                // 端口就长在这一行右边：拖线时一眼知道这条分支属于哪个选项。
                <Handle
                  type="source"
                  id={row.port}
                  position={Position.Right}
                  className="platform-handle is-port"
                />
              )}
            </div>
          ))}
        </div>
      )}

      {data.canExpand && (
        <div className="platform-node-foot">
          <button
            type="button"
            className="platform-node-expand is-icon nodrag"
            onClick={(event) => {
              event.stopPropagation();
              toggle(definition.id);
            }}
            title={expanded ? "收起内部步骤" : `展开 ${data.childCount ?? 0} 个内部步骤`}
            aria-label={expanded ? "收起内部步骤" : "展开内部步骤"}
          >
            {expanded ? <ChevronsDownUp size={11} /> : <ChevronsUpDown size={11} />}
          </button>
        </div>
      )}

      {/* 选项卡的端口跟着选项行走，卡片右下角就不再挂默认输出点。 */}
      {!rows.some((row) => row.port) && (
        <Handle type="source" position={Position.Right} className="platform-handle" />
      )}
      {/* 老连线可能还没绑端口：留一个隐形的落点，避免线找不到出口而飘到卡片外面。 */}
      {rows.some((row) => row.port) && (
        <Handle type="source" position={Position.Right} className="platform-handle is-fallback" />
      )}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}
