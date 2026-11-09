import type { ToolRecord } from "../types.js";
import type { ExecutorHandlers } from "./executor.js";
import { executeHttpNode } from "./httpNode.js";
import {
  createPlatformLiveHandlers,
  executeKnowledgeSearchNode,
  executeMcpToolNode,
  type LiveHandlerOptions
} from "./liveHandlers.js";

/**
 * 平台执行 handler 的唯一装配点：控制面与（后续的）Worker 进程共用同一套依赖，
 * 避免两边对「知识库 / MCP / 训练工具」的行为产生分叉。
 */
export type PlatformHandlerDependencies = Omit<
  LiveHandlerOptions,
  "searchKnowledge" | "getTool" | "callMcpTool"
> & {
  getTool: (id: string) => ToolRecord | undefined;
  callMcpTool: NonNullable<LiveHandlerOptions["callMcpTool"]>;
  searchKnowledge: NonNullable<LiveHandlerOptions["searchKnowledge"]>;
  trainingTool: (tool: string, input: Record<string, unknown>) => unknown | Promise<unknown>;
};

export function createPlatformHandlers(dependencies: PlatformHandlerDependencies): ExecutorHandlers {
  const { trainingTool, ...liveDependencies } = dependencies;
  return {
    ...createPlatformLiveHandlers(liveDependencies),
    // 知识库检索不依赖模型，stub 模式也接真实 provider，避免默认演示出现假引用。
    knowledgeTool: async (node, input, context) => {
      if (node.tool !== "knowledge.search") {
        return undefined;
      }
      return executeKnowledgeSearchNode(node, input, context, dependencies.searchKnowledge);
    },
    // 独立 knowledge 节点与 knowledge.search 工具共用检索服务，stub / live 均可用。
    knowledgeNode: async (node, input, context) =>
      executeKnowledgeSearchNode(node, input, context, dependencies.searchKnowledge),
    // HTTP 节点自带 SSRF 防护与响应大小上限；调用外部 API 不依赖模型是否启用。
    http: async (node, input) => executeHttpNode(node, input),
    // MCP 是确定性工具调用，不依赖 Qwen；stub 模式下也走真实连接，便于零成本演示。
    mcpTool: async (node, input) => {
      const tool = dependencies.getTool(node.tool);
      if (tool?.type !== "mcp") {
        return undefined;
      }
      return executeMcpToolNode(node, input, tool, (target, args) =>
        dependencies.callMcpTool(target, args)
      );
    },
    // 课堂 / 谈心谈话会话由平台工作流驱动；这些工具不依赖模型开关，stub 模式同样可用。
    trainingTool: async (node, input) => trainingTool(node.tool, input)
  };
}
