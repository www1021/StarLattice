import { create } from "zustand";
import { temporal } from "zundo";
import type { WorkflowDefinition } from "./types";

type DefinitionHistoryState = {
  definition?: WorkflowDefinition;
  setDefinition: (
    next:
      | WorkflowDefinition
      | ((current: WorkflowDefinition | undefined) => WorkflowDefinition | undefined)
  ) => void;
};

export const useDefinitionHistory = create<DefinitionHistoryState>()(
  temporal(
    (set) => ({
      definition: undefined,
      setDefinition: (next) =>
        set((state) => ({
          definition: typeof next === "function" ? next(state.definition) : next
        }))
    }),
    {
      limit: 50,
      partialize: (state) => ({ definition: state.definition })
    }
  )
);

/** 只记录 definition 的撤销 / 重做栈，供快捷键与工具栏使用。 */
export const definitionTemporal = useDefinitionHistory.temporal;
