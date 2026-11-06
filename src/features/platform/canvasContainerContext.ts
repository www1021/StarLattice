import { createContext } from "react";

export type CanvasContainerContextValue = {
  isExpanded: (id: string) => boolean;
  toggle: (id: string) => void;
};

export const CanvasContainerContext = createContext<CanvasContainerContextValue>({
  isExpanded: () => false,
  toggle: () => undefined
});
