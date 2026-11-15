/**
 * 自建智能体在聊天里的工具层。
 *
 * 工具来自注册中心：用户在 MCP 连接页连上服务器后，工具会被发现并同步成工具记录，
 * 智能体只按工具 id 引用。这样同一份工具能被多个智能体复用，启用/停用也只有一处开关。
 *
 * 这里只做三件事：把工具翻译成模型能调的函数、按轮次执行 tool_calls、把真实结果回填。
 * 不碰存储与 HTTP，方便单独测。
 */

import {
  completeQwenToolChat,
  UpstreamModelError,
  type ModelProviderConfig,
  type QwenToolCall,
  type QwenToolDefinition,
  type ToolChatMessage
} from "../../qwenOpenAiClient.js";
import type { McpCallResult, ToolRecord } from "../types.js";

export type ChatToolDescriptor = {
  /** 给模型看的函数名，必须是 [a-zA-Z0-9_-]，由工具 id 末段派生。 */
  functionName: string;
  toolId: string;
  tool: ToolRecord;
  definition: QwenToolDefinition;
};

export type ChatToolTrace = {
  id: string;
  toolId: string;
  /** 工具的中文名，给界面显示。 */
  name: string;
  arguments: Record<string, unknown> | string;
  ok: boolean;
  latencyMs: number;
  summary: string;
};

/** 工具调用进度，用来在对话里显示「正在调用 / 已调用」。 */
export type ChatToolProgress = {
  stage: "running" | "done";
  toolId: string;
  name: string;
  ok?: boolean;
  summary?: string;
  latencyMs?: number;
};

export type ChatToolLoopResult = {
  content: string;
  rounds: number;
  calls: ChatToolTrace[];
};

const DEFAULT_MAX_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 6000;

/**
 * 轮次上限：模型偶尔会反复查同一个工具，掐住上限比事后计费更省事。
 * 默认 4 轮，可用 PLATFORM_AGENT_TOOL_ROUNDS 调到 1～8。
 */
export function maxChatToolRounds() {
  const configured = Number(process.env.PLATFORM_AGENT_TOOL_ROUNDS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_MAX_ROUNDS;
  }
  return Math.min(8, Math.max(1, Math.trunc(configured)));
}

/**
 * 聊天历史转成工具模式能吃的消息：content 只收纯文本。
 *
 * 图片没法传给工具模式的补全接口，这里明确告诉模型「这张图没转过来」，
 * 让它自己跟用户确认，而不是假装看懂了。
 */
export function toToolChatMessages(
  messages: Array<{ role: "user" | "assistant"; content: string | Array<{ type: string; text?: string }> }>
): ToolChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) =>
              part.type === "text" ? part.text ?? "" : "（用户发了一张图片，本次没有转发给工具模式，你看不到图）"
            )
            .filter((text) => text.trim() !== "")
            .join("\n")
  }));
}

/** 只暴露「已启用且能真正执行」的工具：MCP 内联工具 + 平台插件（builtin）；停用的工具不能靠对话绕过。 */
export function buildChatToolCatalog(
  toolIds: string[],
  getTool: (id: string) => ToolRecord | undefined
): ChatToolDescriptor[] {
  const catalog: ChatToolDescriptor[] = [];
  const usedNames = new Set<string>();

  for (const toolId of toolIds) {
    const tool = getTool(toolId);
    if (!tool || !tool.enabled || (tool.type !== "mcp" && tool.type !== "builtin")) {
      continue;
    }
    const functionName = uniqueFunctionName(lastSegment(toolId), usedNames);
    catalog.push({
      functionName,
      toolId,
      tool,
      definition: {
        type: "function",
        function: {
          name: functionName,
          // 工具名放前面、描述放后面：模型判断「什么时候用」主要靠这两句。
          description: `${tool.name}：${tool.description || "无描述"}`.slice(0, 900),
          parameters: toObjectSchema(tool.schema)
        }
      }
    });
  }

  return catalog;
}

/**
 * 有工具时不再走流式：工具调用的中间状态没法边调边吐字，
 * 而「先查完再一次性回答」比「先吐一半再回头补」更可信。
 */
export async function runChatToolLoop(input: {
  system?: string;
  messages: ToolChatMessage[];
  catalog: ChatToolDescriptor[];
  callTool: (tool: ToolRecord, args: Record<string, unknown>) => Promise<McpCallResult>;
  complete?: typeof completeQwenToolChat;
  model?: string;
  provider?: ModelProviderConfig;
  maxTokens?: number;
  temperature?: number;
  maxRounds?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ChatToolProgress) => void;
}): Promise<ChatToolLoopResult> {
  const complete = input.complete ?? completeQwenToolChat;
  const maxRounds = input.maxRounds ?? maxChatToolRounds();
  const tools = input.catalog.map((item) => item.definition);
  const messages: ToolChatMessage[] = [...input.messages];
  const calls: ChatToolTrace[] = [];
  let content = "";
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;
    const response = await complete({
      system: input.system,
      messages,
      model: input.model,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      provider: input.provider,
      tools,
      signal: input.signal
    });

    if (response.toolCalls.length === 0) {
      content = response.content;
      break;
    }

    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.toolCalls
    });

    for (const call of response.toolCalls) {
      const execution = await executeToolCall(call, input.catalog, input.callTool, input.onProgress);
      calls.push(execution.trace);
      messages.push({
        role: "tool",
        tool_call_id: execution.trace.id,
        content: execution.content
      });
    }
  }

  if (!content.trim()) {
    // 撞到轮次上限还只有 tool_calls：关掉工具再要一次结论，避免空响应。
    const final = await complete({
      system: input.system,
      messages,
      model: input.model,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      provider: input.provider,
      tools: [],
      signal: input.signal
    });
    content = final.content;
  }

  if (!content.trim()) {
    throw new UpstreamModelError("智能体调用工具后没有给出答复，请换个问法再试一次。");
  }

  return { content, rounds, calls };
}

async function executeToolCall(
  call: QwenToolCall,
  catalog: ChatToolDescriptor[],
  callTool: (tool: ToolRecord, args: Record<string, unknown>) => Promise<McpCallResult>,
  onProgress?: (progress: ChatToolProgress) => void
): Promise<{ content: string; trace: ChatToolTrace }> {
  const descriptor = catalog.find((item) => item.functionName === call.function.name);
  const startedAt = Date.now();

  if (!descriptor) {
    return failed(call, call.function.name, `模型请求了未声明的工具「${call.function.name}」。`, startedAt);
  }

  const displayName = descriptor.tool.name || lastSegment(descriptor.toolId);
  const parsed = parseToolArguments(call.function.arguments);
  if (!parsed.ok) {
    return failed(
      call,
      displayName,
      `工具参数不是合法 JSON 对象：${parsed.error}`,
      startedAt,
      descriptor.toolId
    );
  }

  onProgress?.({
    stage: "running",
    toolId: descriptor.toolId,
    name: displayName
  });

  try {
    const result = await callTool(descriptor.tool, parsed.value);
    const text = truncate(result.text.trim() || "（工具没有返回文本内容）", MAX_TOOL_RESULT_CHARS);
    const summary = `${result.serverName} · ${result.tool}（${result.latencyMs} ms）`;
    const trace: ChatToolTrace = {
      id: call.id,
      toolId: descriptor.toolId,
      name: displayName,
      arguments: parsed.value,
      ok: !result.isError,
      latencyMs: result.latencyMs,
      summary
    };
    onProgress?.({
      stage: "done",
      toolId: descriptor.toolId,
      name: displayName,
      ok: trace.ok,
      summary,
      latencyMs: result.latencyMs
    });
    return { content: text, trace };
  } catch (error) {
    const message = describe(error);
    return failed(call, displayName, message, startedAt, descriptor.toolId, parsed.value, onProgress);
  }
}

function failed(
  call: QwenToolCall,
  name: string,
  message: string,
  startedAt: number,
  toolId = "",
  args: Record<string, unknown> | string = call.function.arguments,
  onProgress?: (progress: ChatToolProgress) => void
): { content: string; trace: ChatToolTrace } {
  const latencyMs = Date.now() - startedAt;
  const summary = `工具调用失败：${truncate(message, 160)}`;
  if (toolId) {
    onProgress?.({
      stage: "done",
      toolId,
      name,
      ok: false,
      summary,
      latencyMs
    });
  }
  return {
    content: JSON.stringify({ error: message }),
    trace: { id: call.id, toolId, name, arguments: args, ok: false, latencyMs, summary }
  };
}

export function parseToolArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {  const text = raw.trim();
  if (!text) {
    return { ok: true, value: {} };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
    return { ok: false, error: "必须是 JSON 对象" };
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

function uniqueFunctionName(preferred: string, used: Set<string>) {
  const base = preferred.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "tool";
  let name = base;
  let index = 2;
  while (used.has(name)) {
    name = `${base.slice(0, 56)}_${index}`;
    index += 1;
  }
  used.add(name);
  return name;
}

function lastSegment(toolId: string) {
  const segments = toolId.split(".").filter(Boolean);
  return segments[segments.length - 1] || toolId;
}

function toObjectSchema(schema: Record<string, unknown>) {
  return schema.type === "object" ? schema : { type: "object", properties: {} };
}

function truncate(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`;
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
