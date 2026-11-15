import { EventEmitter } from "node:events";

/**
 * 运行级 token 流：live handler 边生成边往这里推，调试 SSE 订阅后实时转发给面板。
 *
 * 为什么不用 store 轮询：步骤产物是节点跑完才落库的，轮询天然只能整篇发；
 * 打字动画是前端假流式，等 36 秒才蹦字，体感「断断续续」。真流式必须从
 * 模型回调直接往外送，所以需要一个绕过台账的进程内事件通道。
 *
 * 范围限制：Worker 子进程（PLATFORM_WORKER_PROCESSES>0）里的叶子步骤不经过
 * 本进程的 handler，token 到不了这里，那些运行退回「整篇一次性下发」。
 */

export type RunTokenEvent = {
  runId: string;
  /** 步骤 path（容器内是 loopId/childId），与平台运行台账里的 step.path 一致。 */
  path: string;
  delta: string;
};

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** 无订阅者时是零成本空操作：生产运行、测试进程都不会有人听。 */
export function emitRunToken(event: RunTokenEvent): void {
  if (emitter.listenerCount(event.runId) > 0) {
    emitter.emit(event.runId, event);
  }
}

/** handler 据此决定走流式请求还是普通补全：没人听就不必向上游要流。 */
export function hasRunTokenListeners(runId: string): boolean {
  return emitter.listenerCount(runId) > 0;
}

export function subscribeRunTokens(
  runId: string,
  listener: (event: RunTokenEvent) => void
): () => void {
  emitter.on(runId, listener);
  return () => {
    emitter.off(runId, listener);
  };
}
