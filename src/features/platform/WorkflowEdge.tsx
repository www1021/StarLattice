import { useContext } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type Edge,
  type EdgeProps
} from "@xyflow/react";
import { Plus, Trash2 } from "lucide-react";
import { CanvasEdgeContext } from "./canvasEdgeContext";

export type WorkflowEdgeData = {
  accent: string;
  running?: boolean;
  /** 已执行完成的路径（两端节点都已成功），整条线变蓝，便于一眼看出流程实际走了哪条。 */
  done?: boolean;
  /** 上游走完但下游被跳过：这条分支这一轮没选中，画成灰虚线。 */
  skipped?: boolean;
  /** 容器展开后的内部连线只读：不提供插入与删除。 */
  inner?: boolean;
};

export type WorkflowFlowEdge = Edge<WorkflowEdgeData, "workflow">;

/**
 * 箭头也换色，否则蓝线上挂个米色箭头很扎眼。
 * defs 由画布页统一挂一份（见 CanvasEdgeMarkers），这里只引 id。
 */
const ARROW = {
  focus: "url(#platform-arrow-focus)",
  running: "url(#platform-arrow-running)",
  done: "url(#platform-arrow-done)",
  idle: "url(#platform-arrow-idle)"
};

/** 画布页挂一次即可：四种状态色的箭头形状。 */
export function CanvasEdgeMarkers() {
  const arrow = { markerWidth: 13, markerHeight: 13, viewBox: "-10 -10 20 20" } as const;
  const shape = { points: "-5,-4 0,0 -5,4 -5,-4" };
  return (
    <svg className="platform-edge-defs" aria-hidden width="0" height="0">
      <defs>
        {(
          [
            ["platform-arrow-idle", "var(--edge-idle)"],
            ["platform-arrow-focus", "var(--edge-focus)"],
            ["platform-arrow-running", "var(--edge-running)"],
            ["platform-arrow-done", "var(--edge-done)"]
          ] as const
        ).map(([id, color]) => (
          <marker
            key={id}
            id={id}
            markerUnits="strokeWidth"
            orient="auto-start-reverse"
            refX="0"
            refY="0"
            {...arrow}
          >
            <polyline
              {...shape}
              style={{ fill: color, stroke: color }}
              strokeWidth={1}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

export function WorkflowEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  label,
  selected,
  data
}: EdgeProps<WorkflowFlowEdge>) {
  const { hoveredEdgeId, hoveredNodeId, keepEdgeHover, scheduleEdgeLeave, insertOnEdge } =
    useContext(CanvasEdgeContext);
  const { deleteElements } = useReactFlow();
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.32
  });
  const inner = data?.inner === true;
  const showActions = !inner && (hoveredEdgeId === id || selected);
  /**
   * 鼠标停在这个节点的入线或出线上：整条线变蓝并加粗，
   * 别的线同时压暗，一眼能数出这个节点连了几条。
   */
  const related = Boolean(hoveredNodeId) && (source === hoveredNodeId || target === hoveredNodeId);
  const dimmed = Boolean(hoveredNodeId) && !related && !selected;
  /** 连线统一走主题里的中性灰；运行中保留琥珀色当状态色，选中时用强调色。 */
  const skipped = data?.skipped === true;
  const stroke = related
    ? "var(--edge-focus)"
    : data?.running
      ? "var(--edge-running)"
      : data?.done
        ? "var(--edge-done)"
        : selected
          ? "var(--edge-active)"
          : "var(--edge-idle)";
  const strokeWidth = related
    ? 2.2
    : selected
      ? 2
      : data?.done
        ? 2.2
        : data?.running
          ? 2
          : inner
            ? 1.1
            : 1.4;
  const opacity = related
    ? 1
    : dimmed
      ? 0.2
      : skipped
        ? 0.45
        : data?.running || data?.done
          ? 1
          : inner
            ? 0.45
            : 0.9;
  const arrow = related
    ? ARROW.focus
    : data?.running
      ? ARROW.running
      : data?.done
        ? ARROW.done
        : ARROW.idle;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={inner ? markerEnd : arrow}
        interactionWidth={inner ? 0 : 26}
        className={`platform-edge ${data?.running ? "is-running" : data?.done ? "is-done" : ""} ${
          inner ? "is-inner" : ""
        } ${skipped ? "is-skipped" : ""} ${related ? "is-related" : ""}`}
        style={{
          stroke,
          strokeWidth,
          opacity,
          // 没走的分支用虚线区分：实线是「走过/在走」，虚线是「这一轮没轮到」。
          ...(skipped ? { strokeDasharray: "5 5" } : {})
        }}
      />
      <EdgeLabelRenderer>
        {label && (
          <div
            className="platform-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 18}px)` }}
          >
            <span>{label}</span>
          </div>
        )}
        {!inner && (
          <div
            className={`platform-edge-actions ${showActions ? "is-visible" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onMouseEnter={() => keepEdgeHover(id)}
            onMouseLeave={scheduleEdgeLeave}
          >
            <button
              type="button"
              className="platform-edge-action"
              title="在这条连线中插入节点"
              aria-label="在这条连线中插入节点"
              onClick={() => insertOnEdge(id)}
            >
              <Plus size={12} />
            </button>
            <button
              type="button"
              className="platform-edge-action is-danger"
              title="删除这条连线"
              aria-label="删除这条连线"
              onClick={() => void deleteElements({ edges: [{ id, source, target }] })}
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
