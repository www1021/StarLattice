/**
 * 工作流运行轨迹提炼：给聊天页的回复加上「走了哪个智能体 / 调了哪些工具」的标识。
 *
 * 纯函数，不碰执行器：节点元数据（标题、引用的工具/智能体）由调用方从
 * DSL 递归收集后注入，插件名等展示信息也通过回调解析，便于单测。
 */

export type RunTraceAgentKind = "agent" | "subworkflow" | "llm";

export type RunTraceAgent = {
  /** 展示名：节点标题优先，退回节点 id。 */
  name: string;
  kind: RunTraceAgentKind;
  durationMs: number;
  /** agent 节点引用的智能体 id（chat_agents 表），前端可用于头像。 */
  agentId?: string;
};

export type RunTraceTool = {
  toolId: string;
  name: string;
  ok: boolean;
  latencyMs?: number;
};

export type RunTrace = {
  agents: RunTraceAgent[];
  tools: RunTraceTool[];
};

/** 节点元数据：从工作流 DSL（含被引用子工作流）收集。 */
export type RunTraceNodeMeta = {
  title?: string;
  kind?: string;
  /** tool 节点引用的平台工具 id。 */
  tool?: string;
  /** agent 节点引用的智能体 id。 */
  agent?: string;
};

export type RunTraceStep = {
  nodeId?: string;
  path?: string;
  nodeKind?: string;
  status?: string;
  durationMs?: number;
};

export type RunTraceDefinition = {
  nodes?: unknown;
};

const TRACE_DEPTH_LIMIT = 6;
const PLUGIN_ENDPOINT_PREFIX = "plugin://";

/**
 * 递归收集节点元数据（含循环体与被引用子工作流，防环 + 深度上限）。
 * 键为节点 id；子工作流内部节点与顶层节点 id 冲突时保留先收集到的顶层定义。
 */
export function collectTraceNodeMeta(
  definition: RunTraceDefinition,
  resolveWorkflow: (workflowId: string) => RunTraceDefinition | undefined,
  visited: Set<string> = new Set(),
  depth = 0,
  out: Map<string, RunTraceNodeMeta> = new Map()
): Map<string, RunTraceNodeMeta> {
  if (depth > TRACE_DEPTH_LIMIT || !Array.isArray(definition.nodes)) {
    return out;
  }
  for (const node of definition.nodes) {
    if (!node || typeof node !== "object") {
      continue;
    }
    const item = node as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id) {
      continue;
    }
    if (!out.has(item.id)) {
      out.set(item.id, {
        title: typeof item.title === "string" ? item.title : undefined,
        kind: typeof item.kind === "string" ? item.kind : undefined,
        tool: typeof item.tool === "string" ? item.tool : undefined,
        agent: typeof item.agent === "string" ? item.agent : undefined
      });
    }
    // 循环体：DSL 里 body 是节点数组；兼容 { nodes: [...] } 的容器写法。
    const childSource = Array.isArray(item.body)
      ? item.body
      : item.body &&
        typeof item.body === "object" &&
        Array.isArray((item.body as Record<string, unknown>).nodes)
        ? (item.body as Record<string, unknown>).nodes
        : item.nodes;
    collectTraceNodeMeta(
      { nodes: childSource },
      resolveWorkflow,
      visited,
      depth + 1,
      out
    );
    const workflowId = typeof item.workflowId === "string" ? item.workflowId : "";
    if (workflowId && !visited.has(workflowId)) {
      visited.add(workflowId);
      collectTraceNodeMeta(resolveWorkflow(workflowId) ?? {}, resolveWorkflow, visited, depth + 1, out);
    }
  }
  return out;
}

/**
 * 从运行台账提炼轨迹：
 * - 智能体侧只看顶层节点（path 不含 "/"），子流程内部的中间 LLM 不进列表，
 *   否则答辩训练一跑会冒出一串哈希 id 节点，标识就成噪音了。
 * - 工具节点不论层级都收（插件/工作流工具常在子流程里，恰恰是用户想看的）。
 * - 循环里同一节点跑多次：智能体合并耗时；工具合并耗时、成败取与。
 */
export function buildRunTrace(options: {
  steps: RunTraceStep[];
  nodeMeta: (nodeId: string) => RunTraceNodeMeta | undefined;
  resolveTool: (toolId: string) => { name?: string; endpoint?: string } | undefined;
  resolvePluginName: (pluginId: string) => string | undefined;
}): RunTrace {
  const agents = new Map<string, RunTraceAgent>();
  const tools = new Map<string, RunTraceTool>();
  for (const step of options.steps) {
    const nodeId = (step.nodeId ?? "").trim();
    if (!nodeId) {
      continue;
    }
    const meta = options.nodeMeta(nodeId);
    const kind = step.nodeKind ?? meta?.kind ?? "";

    // 智能体侧只收跑成功的节点；失败/跳过的分支不算「走了哪个智能体」。
    if (kind === "agent" || kind === "subworkflow" || kind === "llm") {
      if (step.status !== "succeeded") {
        continue;
      }
      // 子流程 / 循环体内部的推理节点不算「走了哪个智能体」。
      if ((step.path ?? "").includes("/")) {
        continue;
      }
      const existing = agents.get(nodeId);
      const duration = Math.max(0, step.durationMs ?? 0);
      if (existing) {
        existing.durationMs += duration;
      } else {
        agents.set(nodeId, {
          name: meta?.title || nodeId,
          kind: kind as RunTraceAgentKind,
          durationMs: duration,
          ...(meta?.agent ? { agentId: meta.agent } : {})
        });
      }
      continue;
    }

    if (kind === "tool") {
      // 工具失败也要标识出来（ok=false），用户得知道插件没跑成。
      if (step.status !== "succeeded" && step.status !== "failed") {
        continue;
      }
      const ok = step.status === "succeeded";
      const toolRef = meta?.tool || nodeId;
      const record = options.resolveTool(toolRef);
      let name = meta?.title || record?.name || toolRef;
      const endpoint = record?.endpoint ?? "";
      if (endpoint.startsWith(PLUGIN_ENDPOINT_PREFIX)) {
        const pluginName = options.resolvePluginName(
          endpoint.slice(PLUGIN_ENDPOINT_PREFIX.length)
        );
        if (pluginName) {
          name = pluginName;
        }
      }
      const existing = tools.get(nodeId);
      const duration = Math.max(0, step.durationMs ?? 0);
      if (existing) {
        existing.latencyMs = (existing.latencyMs ?? 0) + duration;
        existing.ok = existing.ok && ok;
      } else {
        tools.set(nodeId, {
          toolId: toolRef,
          name,
          ok,
          latencyMs: duration
        });
      }
    }
  }
  return { agents: [...agents.values()], tools: [...tools.values()] };
}
