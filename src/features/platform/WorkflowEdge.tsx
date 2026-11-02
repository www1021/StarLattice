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
};

export type WorkflowFlowEdge = Edge<WorkflowEdgeData, "workflow">;

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
  const { hoveredEdgeId, keepEdgeHover, scheduleEdgeLeave, insertOnEdge } =
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
  const accent = data?.accent ?? "#94a3b8";
  const showActions = hoveredEdgeId === id || selected;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={26}
        className={data?.running ? "platform-edge is-running" : "platform-edge"}
        style={{
          stroke: accent,
          strokeWidth: selected ? 2.6 : 2,
          opacity: data?.running ? 1 : 0.72
        }}
      />
      <EdgeLabelRenderer>
        {label && (
          <div
            className="platform-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 18}px)` }}
          >
            {label}
          </div>
        )}
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
      </EdgeLabelRenderer>
    </>
  );
}
