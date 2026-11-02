import { createContext } from "react";

export type CanvasEdgeActions = {
  hoveredEdgeId?: string;
  keepEdgeHover: (edgeId: string) => void;
  scheduleEdgeLeave: () => void;
  insertOnEdge: (edgeId: string) => void;
};

export const CanvasEdgeContext = createContext<CanvasEdgeActions>({
  keepEdgeHover: () => undefined,
  scheduleEdgeLeave: () => undefined,
  insertOnEdge: () => undefined
});
