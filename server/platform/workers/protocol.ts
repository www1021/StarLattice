import type { AgentRecord, CompiledStep, SchedulerWorkerStatus } from "../types.js";
import type { LeafExecutionState } from "../runtime/executor.js";
import type { VerifyLayers } from "../verify/verifier.js";

/** 循环帧只把 ${loop.*} 需要的字段传给 Worker，控制器与策略仍留在父进程。 */
export type SerializedLoopProfile = {
  path: string;
  artifact?: unknown;
  issues: string[];
  score?: number;
  iteration: number;
  retrievalQuery?: string;
};

export type SerializedScope = {
  input: Record<string, unknown>;
  outputs: Array<[string, unknown]>;
  evidence: string[];
  verifyRounds: number;
  lastVerifyScore?: number;
  lastVerifyIssues?: string[];
  lastVerifyConfidence?: number;
  lastVerifyPassed?: boolean;
  lastVerifyLayers?: VerifyLayers;
  lastArtifact?: unknown;
  lastArtifactNodeId?: string;
};

export type SerializedWorkerState = {
  runId: string;
  workflowId: string;
  iteration: number;
  tokensUsed: number;
  tokenBudget?: number;
  scope: SerializedScope;
  loops: SerializedLoopProfile[];
  workflowKnowledgeBaseIds: string[];
  agentSnapshots?: AgentRecord[];
};

export type WorkerInvocation = {
  id: string;
  runId: string;
  stepId?: string;
  step: CompiledStep;
  input: Record<string, unknown>;
  state: SerializedWorkerState;
};

export type WorkerErrorPayload = {
  name: string;
  message: string;
  stack?: string;
};

export type WorkerServiceName = "knowledge.search" | "mcp.call" | "training.tool";

export type WorkerServiceCall = {
  id: string;
  service: WorkerServiceName;
  payload: Record<string, unknown>;
};

export type ParentToWorkerMessage =
  | { type: "invoke"; invocation: WorkerInvocation }
  | { type: "service-reply"; reply: WorkerServiceReply }
  | { type: "shutdown"; reason?: string };

export type WorkerToParentMessage =
  | { type: "ready"; pid: number }
  | { type: "heartbeat"; at: number }
  | { type: "result"; id: string; ok: true; output: unknown }
  | { type: "result"; id: string; ok: false; error: WorkerErrorPayload }
  | { type: "service"; request: WorkerServiceCall }
  | { type: "fatal"; error: WorkerErrorPayload };

export type WorkerServiceReply = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type WorkerLease = {
  workerId: string;
  /** Worker 失联/被终止时拒绝；用于中断正在等待的步骤。 */
  abort: Promise<never>;
  invoke: (invocation: WorkerInvocation) => Promise<unknown>;
  release: () => void;
};

export type WorkerSnapshot = {
  id: string;
  pid?: number;
  slot: number;
  status: SchedulerWorkerStatus;
  killed: boolean;
  activeTasks: string[];
};

export type WorkerPoolLike = {
  readonly size: number;
  readonly lane: string;
  acquire(taskKey: string): Promise<WorkerLease>;
  listWorkers(): WorkerSnapshot[];
  killWorker(workerId: string): { workerId: string; killed: boolean; aborted: number };
  drain(reason?: string): Promise<void>;
};

export function buildWorkerInvocation(args: {
  id: string;
  step: CompiledStep;
  input: Record<string, unknown>;
  state: LeafExecutionState;
  tokenBudget?: number;
  stepId?: string;
}): WorkerInvocation {
  return {
    id: args.id,
    runId: args.state.runId,
    stepId: args.stepId,
    step: args.step,
    input: args.input,
    state: serializeWorkerState(args.state, args.tokenBudget)
  };
}

export function serializeWorkerState(
  state: LeafExecutionState,
  tokenBudget = 0
): SerializedWorkerState {
  const scope = state.scope;
  return {
    runId: state.runId,
    workflowId: state.workflowId,
    iteration: state.iteration,
    tokensUsed: state.tokensUsed,
    tokenBudget: tokenBudget > 0 ? tokenBudget : undefined,
    scope: {
      input: scope.input,
      outputs: [...scope.outputs.entries()],
      evidence: [...scope.evidence],
      verifyRounds: scope.verifyRounds,
      lastVerifyScore: scope.lastVerifyScore,
      lastVerifyIssues: scope.lastVerifyIssues,
      lastVerifyConfidence: scope.lastVerifyConfidence,
      lastVerifyPassed: scope.lastVerifyPassed,
      lastVerifyLayers: scope.lastVerifyLayers,
      lastArtifact: scope.lastArtifact,
      lastArtifactNodeId: scope.lastArtifactNodeId
    },
    loops: state.loops.map((frame) => ({
      path: frame.path,
      artifact: frame.artifact,
      issues: [...frame.issues],
      score: frame.score,
      iteration: frame.iteration,
      retrievalQuery: frame.retrievalQuery
    })),
    workflowKnowledgeBaseIds: [...state.workflowKnowledgeBaseIds],
    agentSnapshots: state.agentSnapshots ? [...state.agentSnapshots.values()] : undefined
  };
}

export function deserializeWorkerState(serialized: SerializedWorkerState): LeafExecutionState {
  const scope = serialized.scope;
  return {
    runId: serialized.runId,
    workflowId: serialized.workflowId,
    iteration: serialized.iteration,
    tokensUsed: serialized.tokensUsed,
    tokenBudget: serialized.tokenBudget,
    scope: {
      input: scope.input ?? {},
      outputs: new Map(scope.outputs ?? []),
      evidence: [...(scope.evidence ?? [])],
      verifyRounds: scope.verifyRounds ?? 0,
      lastVerifyScore: scope.lastVerifyScore,
      lastVerifyIssues: scope.lastVerifyIssues,
      lastVerifyConfidence: scope.lastVerifyConfidence,
      lastVerifyPassed: scope.lastVerifyPassed,
      lastVerifyLayers: scope.lastVerifyLayers,
      lastArtifact: scope.lastArtifact,
      lastArtifactNodeId: scope.lastArtifactNodeId
    },
    loops: (serialized.loops ?? []).map((frame) => ({
      path: frame.path,
      artifact: frame.artifact,
      issues: [...(frame.issues ?? [])],
      score: frame.score,
      iteration: frame.iteration,
      retrievalQuery: frame.retrievalQuery
    })),
    workflowKnowledgeBaseIds: [...(serialized.workflowKnowledgeBaseIds ?? [])],
    agentSnapshots: serialized.agentSnapshots
      ? new Map(serialized.agentSnapshots.map((agent) => [agent.id, agent]))
      : undefined
  };
}

export function errorToPayload(error: unknown): WorkerErrorPayload {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}

/** 远程错误无法保留原 class，至少保留 name/message，便于按名称识别取消语义。 */
export function errorFromPayload(payload: WorkerErrorPayload): Error {
  const error = new Error(payload.message);
  error.name = payload.name || "Error";
  if (payload.stack) {
    error.stack = payload.stack;
  }
  return error;
}
