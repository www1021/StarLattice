import { platformApi } from "./api";
import type {
  InteractionRecord,
  RunRecord,
  StepRecord,
  TraceResponse
} from "./types";

export type TrainingTrace = Pick<
  TraceResponse,
  "run" | "steps" | "interactions"
>;

const TERMINAL_STATUSES = new Set<RunRecord["status"]>([
  "succeeded",
  "failed",
  "rolled_back",
  "cancelled"
]);

export function isTerminalStatus(status: RunRecord["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function pendingInteractionOf(
  trace: Pick<TraceResponse, "interactions">
): InteractionRecord | undefined {
  return trace.interactions.find((interaction) => interaction.status === "pending");
}

/** 同一节点可能在循环里执行多次，调用方通常只关心最近一次成功输出。 */
export function latestStepOutputOf<T>(
  trace: Pick<TraceResponse, "steps">,
  nodeIds: string[]
): T | undefined {
  const wanted = new Set(nodeIds);
  for (let index = trace.steps.length - 1; index >= 0; index -= 1) {
    const step = trace.steps[index];
    if (wanted.has(step.nodeId) && step.status === "succeeded" && step.output !== undefined) {
      return step.output as T;
    }
  }
  return undefined;
}

export function latestStepOf(
  trace: Pick<TraceResponse, "steps">,
  nodeId: string
): StepRecord | undefined {
  for (let index = trace.steps.length - 1; index >= 0; index -= 1) {
    if (trace.steps[index].nodeId === nodeId) {
      return trace.steps[index];
    }
  }
  return undefined;
}

export async function startTrainingRun(
  workflowId: string,
  input: Record<string, unknown>
): Promise<RunRecord> {
  const payload = await platformApi.startRun(workflowId, input);
  return payload.run;
}

/**
 * 轮询 trace 直到出现待处理交互或运行进入终态。
 * 训练页只在“暂停点”刷新一次界面，避免每一轮重复拉取。
 */
export async function waitForTrainingCheckpoint(
  runId: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<TraceResponse> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 400;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const trace = await platformApi.trace(runId);
    if (pendingInteractionOf(trace) || isTerminalStatus(trace.run.status)) {
      return trace;
    }
    if (Date.now() >= deadline) {
      throw new Error("等待训练暂停超时，请稍后在运行监控中查看该次训练。");
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function respondTrainingInteraction(
  interactionId: string,
  values: Record<string, unknown>,
  actor?: string
): Promise<TraceResponse> {
  const response = await platformApi.respondInteraction(interactionId, values, actor);
  const immediate: TraceResponse = {
    run: response.run,
    steps: response.steps,
    verifyResults: [],
    loopIterations: [],
    approvals: [],
    interactions: response.interactions
  };
  if (response.pending || isTerminalStatus(response.run.status)) {
    return immediate;
  }
  // 服务端最多等待 120s 的下一个检查点，超时后继续由前端轮询。
  return waitForTrainingCheckpoint(response.run.id);
}

export async function cancelTrainingRun(runId?: string): Promise<void> {
  if (!runId) {
    return;
  }
  try {
    await platformApi.cancelRun(runId);
  } catch {
    // 运行可能已经结束；退出训练不应因为取消失败而阻塞。
  }
}
