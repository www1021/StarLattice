import { createPlatformHandlers } from "../runtime/handlersFactory.js";
import { WorkflowExecutor } from "../runtime/executor.js";
import { PlatformStateStore } from "../runtime/stateStore.js";
import { createLlmDimensionScorer, isLlmVerifyEnabled } from "../verify/liveScorer.js";
import {
  deserializeWorkerState,
  errorToPayload,
  type ParentToWorkerMessage,
  type WorkerServiceReply,
  type WorkerToParentMessage
} from "./protocol.js";

/**
 * Worker 子进程宿主：只做叶子步骤执行，不持有调度队列。
 * 知识库、MCP 与训练工具会改变父进程内的服务状态（连接、会话），因此通过 IPC 回父进程调用；
 * Agent / 工具注册表是只读的，直接从同一 SQLite 台账读取，避免每次调用都多一跳。
 */
if (!process.send) {
  console.error("[worker] 必须通过 fork 启动，缺少 IPC 通道。");
  process.exit(1);
}
const send = (message: WorkerToParentMessage) => {
  process.send?.(message);
};

const store = new PlatformStateStore(undefined, { readonly: true });
const pendingServices = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
let serviceSequence = 0;

function callParent<T>(service: "knowledge.search" | "mcp.call" | "training.tool", payload: Record<string, unknown>): Promise<T> {
  const id = `svc-${(serviceSequence += 1)}`;
  return new Promise<T>((resolve, reject) => {
    pendingServices.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject
    });
    send({ type: "service", request: { id, service, payload } });
  });
}

const handlers = createPlatformHandlers({
  getAgent: (id) => store.getAgent(id),
  getAgentVersion: (id, version) => store.getAgentVersion(id, version),
  getTool: (id) => store.getTool(id),
  callMcpTool: (tool, args) => callParent("mcp.call", { toolId: tool.id, args }),
  searchKnowledge: (options) => callParent("knowledge.search", options),
  trainingTool: (tool, input) => callParent("training.tool", { tool, input })
});

const executor = new WorkflowExecutor(store, handlers, {
  ...(isLlmVerifyEnabled() ? { dimensionScorer: createLlmDimensionScorer() } : {})
});

function replyService(reply: WorkerServiceReply) {
  const pending = pendingServices.get(reply.id);
  if (!pending) {
    return;
  }
  pendingServices.delete(reply.id);
  if (reply.ok) {
    pending.resolve(reply.result);
  } else {
    pending.reject(new Error(reply.error ?? "父进程服务调用失败。"));
  }
}

async function runInvocation(message: Extract<ParentToWorkerMessage, { type: "invoke" }>) {
  const invocation = message.invocation;
  try {
    const state = deserializeWorkerState(invocation.state);
    const output = await executor.invokeLeaf(invocation.step, invocation.input, state);
    send({ type: "result", id: invocation.id, ok: true, output });
  } catch (error) {
    send({ type: "result", id: invocation.id, ok: false, error: errorToPayload(error) });
  }
}

process.on("message", (message: ParentToWorkerMessage) => {
  if (message.type === "invoke") {
    void runInvocation(message);
    return;
  }
  if (message.type === "service-reply") {
    replyService(message.reply);
    return;
  }
  if (message.type === "shutdown") {
    process.exit(0);
  }
});

process.on("disconnect", () => {
  process.exit(0);
});

const heartbeatMs = Math.max(250, Number(process.env.PLATFORM_WORKER_HEARTBEAT_MS) || 5000);
setInterval(() => {
  send({ type: "heartbeat", at: Date.now() });
}, heartbeatMs).unref?.();

process.on("uncaughtException", (error) => {
  send({ type: "fatal", error: errorToPayload(error) });
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  send({ type: "fatal", error: errorToPayload(error) });
  process.exit(1);
});

send({ type: "ready", pid: process.pid });
