import { createContext } from "react";

export type CanvasEdgeActions = {
  hoveredEdgeId?: string;
  /**
   * 鼠标停在哪个节点上。连线读它判断自己是不是这个节点的出入线，
   * 是的话整条变蓝——一眼看出这个节点连了几条线、连去哪儿。
   */
  hoveredNodeId?: string;
  keepEdgeHover: (edgeId: string) => void;
  scheduleEdgeLeave: () => void;
  insertOnEdge: (edgeId: string) => void;
};

export const CanvasEdgeContext = createContext<CanvasEdgeActions>({
  keepEdgeHover: () => undefined,
  scheduleEdgeLeave: () => undefined,
  insertOnEdge: () => undefined
});
