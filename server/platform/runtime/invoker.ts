import type { AgentRecord, CompiledStep } from "../types.js";
import type { ExecutionContext, RunState } from "./executor.js";

/**
 * 叶子步骤的执行边界：控制面持有 RunState 与落库，执行只通过这个接口发生。
 * 默认实现留在本进程；Worker Pool 接入后替换为进程间调用，其余逻辑不变。
 */
export type StepInvoker = {
  invoke(step: CompiledStep, input: Record<string, unknown>, state: RunState): Promise<unknown>;
};

export class InlineStepInvoker implements StepInvoker {
  constructor(
    private readonly invokeStep: (
      step: CompiledStep,
      input: Record<string, unknown>,
      state: RunState
    ) => Promise<unknown>
  ) {}

  invoke(step: CompiledStep, input: Record<string, unknown>, state: RunState) {
    return this.invokeStep(step, input, state);
  }
}

export type SerializedScope = Omit<ExecutionContext["scope"], "outputs"> & {
  outputs: Array<[string, unknown]>;
};

/** 跨进程执行所需的上下文快照；不含循环控制器等进程内对象。 */
export type SerializedExecutionContext = Omit<ExecutionContext, "scope" | "agentSnapshots"> & {
  scope: SerializedScope;
  agentSnapshots?: Array<[string, AgentRecord]>;
};

export function serializeExecutionContext(context: ExecutionContext): SerializedExecutionContext {
  const { scope, agentSnapshots, ...rest } = context;
  return {
    ...rest,
    scope: { ...scope, outputs: [...scope.outputs.entries()] },
    ...(agentSnapshots ? { agentSnapshots: [...agentSnapshots.entries()] } : {})
  };
}

export function deserializeExecutionContext(
  serialized: SerializedExecutionContext
): ExecutionContext {
  const { scope, agentSnapshots, ...rest } = serialized;
  return {
    ...rest,
    scope: { ...scope, outputs: new Map(scope.outputs) },
    ...(agentSnapshots ? { agentSnapshots: new Map(agentSnapshots) } : {})
  };
}
