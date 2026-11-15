/**
 * 主智能体把问题转交给专项智能体。
 *
 * 之前「研途引航」的提示词里写着「必须调用对应的子 Agent」，但系统里没有任何调度能力，
 * 模型只能把这句话演成台词，再凭记忆编一串文献。这里把转交做成真的：
 *
 * - 转交在工具层暴露成 `agent://<id>`，和普通插件工具一样参与 tool_calls；
 * - 收到调用后，用目标智能体自己的提示词、模型和工具跑一次独立对话；
 * - 结果作为 tool 消息回灌给主智能体，由它整合成最终答复。
 *
 * 只允许一层：子智能体的工具目录会过滤掉 `agent://`，避免 A→B→A 无限转交。
 */

import {
  completeQwenToolChat,
  type ModelProviderConfig
} from "../../qwenOpenAiClient.js";
import type { AgentRecord, McpCallResult, ToolRecord } from "../types.js";
import { buildAgentChatSystemPrompt } from "./agentChat.js";
import {
  buildChatToolCatalog,
  runChatToolLoop,
  type ChatToolDescriptor
} from "./agentTools.js";

/** 转交工具在配置里的写法：agent://ytz-literature。 */
export const DELEGATION_TOOL_PREFIX = "agent://";

/** 子智能体拿到的用户问题上限，防止把整段会话历史搬过去。 */
const MAX_QUESTION_CHARS = 1600;
/** 回灌给主智能体的结果上限，和普通工具的结果上限保持同一量级。 */
const MAX_RESULT_CHARS = 6000;
/** 子智能体自己的工具轮次：2 轮够「检索一次 + 补充一次」，再多就是嵌套失控。 */
const CHILD_MAX_ROUNDS = 2;

export function isDelegationToolId(toolId: string): boolean {
  return toolId.startsWith(DELEGATION_TOOL_PREFIX);
}

export function delegationTargetId(toolId: string): string {
  return toolId.slice(DELEGATION_TOOL_PREFIX.length);
}

/** 把一批专项智能体翻译成模型可调用的转交工具。 */
export function buildDelegationCatalog(
  targets: AgentRecord[],
  options: { now?: string } = {}
): ChatToolDescriptor[] {
  const now = options.now ?? new Date().toISOString();
  const usedNames = new Set<string>();
  const catalog: ChatToolDescriptor[] = [];

  for (const target of targets) {
    const functionName = uniqueDelegationName(target.id, usedNames);
    const scope = [target.role.trim(), target.description?.trim()]
      .filter((item): item is string => Boolean(item))
      .join("；");
    const tool: ToolRecord = {
      id: `${DELEGATION_TOOL_PREFIX}${target.id}`,
      name: `转交给${target.name}`,
      type: "builtin",
      schema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "要转交的完整问题：保留用户原话里的事实，补上已确认的方向、阶段或材料，让专项智能体不需要再反问一轮。"
          }
        },
        required: ["question"]
      },
      description: scope
        ? `把问题交给「${target.name}」处理。${scope}`
        : `把问题交给「${target.name}」处理。`,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      source: "builtin"
    };
    catalog.push({
      functionName,
      toolId: tool.id,
      tool,
      kind: "delegation",
      definition: {
        type: "function",
        function: {
          name: functionName,
          description: `${tool.name}：${tool.description}`.slice(0, 900),
          parameters: tool.schema
        }
      }
    });
  }

  return catalog;
}

/**
 * 主智能体的完整工具目录：自己的插件 + 能转交的专项智能体。
 *
 * 目标不存在、被停用或就是自己时，这条转交工具直接不出现，
 * 免得模型调用一个必然失败的工具。
 */
export function buildChatToolsWithDelegation(input: {
  agent: AgentRecord;
  getAgent: (id: string) => AgentRecord | undefined;
  getTool: (id: string) => ToolRecord | undefined;
}): ChatToolDescriptor[] {
  const ownToolIds = input.agent.tools.filter((id) => !isDelegationToolId(id));
  const base = buildChatToolCatalog(ownToolIds, input.getTool);
  const targets = input.agent.tools
    .filter(isDelegationToolId)
    .map(delegationTargetId)
    .map((id) => input.getAgent(id))
    .filter(
      (target): target is AgentRecord =>
        Boolean(target) && target!.id !== input.agent.id && target!.enabled
    );
  return [...base, ...buildDelegationCatalog(targets)];
}

/** 执行一次转交，返回和普通工具一致的 McpCallResult，方便直接回灌。 */
export async function runAgentDelegation(input: {
  host: AgentRecord;
  targetId: string;
  question: string;
  getAgent: (id: string) => AgentRecord | undefined;
  getTool: (id: string) => ToolRecord | undefined;
  callTool: (tool: ToolRecord, args: Record<string, unknown>) => Promise<McpCallResult>;
  resolveModel: (id: string) => { model?: string; provider?: ModelProviderConfig };
  complete?: typeof completeQwenToolChat;
  signal?: AbortSignal;
}): Promise<McpCallResult> {
  const startedAt = Date.now();
  const question = input.question.trim().slice(0, MAX_QUESTION_CHARS);

  const fail = (message: string): McpCallResult => ({
    serverId: "agent-delegation",
    serverName: "智能体转交",
    tool: input.targetId,
    latencyMs: Date.now() - startedAt,
    isError: true,
    content: [{ type: "text", text: message }],
    text: message
  });

  if (!question) {
    return fail("转交时没有给出问题内容。");
  }

  const target = input.getAgent(input.targetId);
  if (!target) {
    return fail(`要转交的智能体「${input.targetId}」不存在或当前账号看不到。`);
  }
  if (target.id === input.host.id) {
    return fail("不能把问题转交给自己。");
  }
  if (!target.enabled) {
    return fail(`智能体「${target.name}」已停用，无法转交。`);
  }

  // 子智能体只拿自己的工具：这里把 agent:// 过滤掉，转交只有一层。
  const childToolIds = target.tools.filter((id) => !isDelegationToolId(id));
  const childCatalog = buildChatToolCatalog(childToolIds, input.getTool);
  const system = buildAgentChatSystemPrompt(target, {
    toolNames: childCatalog.map((item) => item.tool.name || item.toolId)
  });
  const picked = input.resolveModel(target.model);

  try {
    const result = await runChatToolLoop({
      system,
      messages: [{ role: "user", content: question }],
      catalog: childCatalog,
      callTool: input.callTool,
      complete: input.complete,
      model: picked.model,
      provider: picked.provider,
      maxRounds: CHILD_MAX_ROUNDS,
      signal: input.signal
    });
    const text = truncate(result.content.trim(), MAX_RESULT_CHARS);
    const toolNote = result.calls.length
      ? `（${target.name}另调用了 ${result.calls.map((call) => call.name).join("、")}）`
      : "";
    return {
      serverId: "agent-delegation",
      serverName: "智能体转交",
      tool: target.name,
      latencyMs: Date.now() - startedAt,
      isError: false,
      content: [{ type: "text", text }],
      text: `${text}${toolNote}`
    };
  } catch (error) {
    return fail(
      `转交「${target.name}」失败：${error instanceof Error ? error.message : String(error)}。请不要替它编造结论。`
    );
  }
}

function uniqueDelegationName(agentId: string, used: Set<string>) {
  const base = `delegate_${agentId.replace(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 60);
  let name = base;
  let index = 2;
  while (used.has(name)) {
    name = `${base.slice(0, 56)}_${index}`;
    index += 1;
  }
  used.add(name);
  return name;
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`;
}
