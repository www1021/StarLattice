import { useContext } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ChevronsDownUp } from "lucide-react";
import { CanvasContainerContext } from "./canvasContainerContext";
import { NODE_VISUALS, nodeTintStyle } from "./nodeVisuals";
import { EditableNodeTitle } from "./PlatformNodeCard";
import type { NodeKind, WorkflowNode } from "./types";

function containerBadgeLabel(kind: NodeKind, columns: number): string {
  if (kind === "loop") return "循环体";
  if (kind === "condition") return `${columns} 条分支`;
  return `${columns} 路并发`;
}

export type PlatformContainerData = {
  definition: WorkflowNode;
  accent: string;
  width: number;
  height: number;
  childCount: number;
  columns: number;
  /** 点击标题就地改名。 */
  onRename?: (nodeId: string, title: string) => void;
};

export type PlatformContainerFlowNode = Node<PlatformContainerData, "container">;

export function PlatformContainerNode({ data, selected }: NodeProps<PlatformContainerFlowNode>) {
  const { toggle } = useContext(CanvasContainerContext);
  const { definition, width, height, childCount, columns } = data;
  const Icon = NODE_VISUALS[definition.kind].icon;

  return (
    <div
      className={`platform-container-node ${selected ? "is-selected" : ""}`}
      style={{ width, height }}
    >
      <Handle type="target" position={Position.Left} className="platform-handle" />
      <header className="platform-container-head">
        <span
          className="platform-node-icon"
          style={nodeTintStyle(definition.kind)}
          aria-hidden
        >
          <Icon size={17} strokeWidth={1.9} />
        </span>
        <div className="platform-node-ident">
          <EditableNodeTitle node={definition} onRename={data.onRename} />
          <code className="platform-node-id">{definition.id}</code>
        </div>
        <span className="platform-container-badge">
          {containerBadgeLabel(definition.kind, columns)} · {childCount} 个内部步骤
        </span>
        <button
          type="button"
          className="platform-node-expand nodrag"
          onClick={(event) => {
            event.stopPropagation();
            toggle(definition.id);
          }}
          title="收起内部步骤"
        >
          <ChevronsDownUp size={12} />
          收起
        </button>
      </header>
      <Handle type="source" position={Position.Right} className="platform-handle" />
    </div>
  );
}
