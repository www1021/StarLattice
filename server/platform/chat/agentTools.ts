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
  streamQwenToolChat,
  UpstreamModelError,
  type ModelProviderConfig,
  type QwenToolCall,
  type QwenToolDefinition,
  type ToolChatMessage,
  type ToolChatResult
} from "../../qwenOpenAiClient.js";
import type { McpCallResult, ToolRecord } from "../types.js";

export type ChatToolDescriptor = {
  /** 给模型看的函数名，必须是 [a-zA-Z0-9_-]，由工具 id 末段派生。 */
  functionName: string;
  toolId: string;
  tool: ToolRecord;
  definition: QwenToolDefinition;
  /** tool = 真正查数据；delegation = 把问题转交给另一个智能体。 */
  kind?: "tool" | "delegation";
  /** delegation 专用：被转交的智能体，界面直接用它当这轮回复的署名。 */
  targetAgent?: { id: string; name: string; avatar?: string };
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
  /** 存档用：重开历史时还能分清「调插件」和「转交智能体」。 */
  kind?: "tool" | "delegation";
  /** 存档用：界面显示成「服务器/工具」。 */
  serverName?: string;
  toolName?: string;
};

/** 工具调用进度，用来在对话里显示「正在调用 / 已调用 / 未调用」。 */
export type ChatToolProgress = {
  stage: "running" | "done" | "skipped";
  toolId: string;
  name: string;
  ok?: boolean;
  summary?: string;
  latencyMs?: number;
  /** 界面上把「转交给某个智能体」和「调用插件」区分开。 */
  kind?: "tool" | "delegation";
  /** 工具所属的服务器（MCP 连接名 / 插件名），界面显示成「服务器/工具」。 */
  serverName?: string;
  /** 工具的真实函数名，界面显示成「服务器/工具」。 */
  toolName?: string;
  /** 转交目标：界面直接把署名换成它，不显示「正在转交」这种过程文案。 */
  targetAgent?: { id: string; name: string; avatar?: string };
};

export type ChatToolLoopResult = {
  content: string;
  rounds: number;
  calls: ChatToolTrace[];
  /** 模型始终不肯调用工具时，是否由后端兜底强制执行过一次。 */
  forcedToolCall: boolean;
  /**
   * 本轮由专项智能体直接作答：上层拿它当回复，不再让主智能体二次改写。
   * 有值时 content 可能为空。
   */
  delegatedAnswer?: DelegatedAnswer;
};

/** 专项智能体的独立答复。 */
export type DelegatedAnswer = {
  agentId: string;
  agentName: string;
  avatar?: string;
  answer: string;
};

const DEFAULT_MAX_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 6000;

/**
 * 用户明显在要外部资料时，才允许后端强制/兜底调用工具。
 * 闲聊（「你好」「谢谢」）不该被硬塞一次检索。
 */
const EXTERNAL_EVIDENCE_PATTERN =
  /文献|论文|检索|搜索|查询|查找|查一下|找几篇|资料|数据|最新|现状|进展|引用|期刊|年份|事实|统计|报告|新闻|知识库|证据|来源|参考|有哪些研究|研究现状|\bpapers?\b|\bliterature\b|\barticles?\b|\bsearch\b|\bquer(?:y|ies)\b|\bcitations?\b|\bpublications?\b|related work|state[- ]of[- ]the[- ]art|doi/i;

export function needsExternalEvidence(text: string): boolean {
  return EXTERNAL_EVIDENCE_PATTERN.test(text);
}

/** 上游不支持 tool_choice=required 时，用这段话把「必须调用」钉进 system。 */
const FORCE_TOOL_SYSTEM_HINT = [
  "【本轮强制要求】用户的问题需要外部真实资料。",
  "你必须先调用一个可用工具取得结果，再基于工具返回的内容作答。",
  "没有工具结果时，禁止给出具体文献条目、DOI、期刊名、年份、数字或链接；禁止声称已经检索过或已经启动过某个 Agent。",
  "工具查不到或调用失败就如实说明，不要用记忆里的内容补齐。"
].join("\n");

/**
 * 从工具目录里挑出最像「检索」的工具，把 query 填进它的检索词参数，直接构造一次调用。
 *
 * 两处复用：
 * - 模型不肯调工具时的兜底（见 buildForcedToolCall）；
 * - 转交后子智能体首轮直接检索，省掉「模型决定调哪个工具」的一次完整模型往返。
 *
 * 配了转交工具时优先转给对口专项智能体：它带自己的检索工具和领域提示词，
 * 比主智能体临时客串检索更准。子智能体的目录里没有转交工具，自然退回到它自己的检索工具。
 */
export function buildSearchToolCall(
  query: string,
  catalog: ChatToolDescriptor[],
  callIdPrefix: string
): QwenToolCall | null {
  const match = (pool: ChatToolDescriptor[]) =>
    pool.find((item) =>
      /检索|搜索|查询|文献|查找|资料|研究现状|search|query/i.test(
        `${item.tool.name} ${item.tool.description || ""}`
      )
    );
  const delegations = catalog.filter((item) => item.kind === "delegation");
  const descriptor = match(delegations) ?? match(catalog) ?? delegations[0] ?? catalog[0];
  if (!descriptor) {
    return null;
  }
  return {
    id: `${callIdPrefix}-${descriptor.functionName}`,
    type: "function",
    function: {
      name: descriptor.functionName,
      arguments: JSON.stringify(forcedToolArguments(descriptor, query))
    }
  };
}

/**
 * 最后一道兜底：模型完全不支持 function calling 时，直接按用户输入构造一次真实调用。
 * 只在「明显需要外部资料 + 有可用工具」时启用，避免把闲聊也变成一次无谓的检索。
 */
function buildForcedToolCall(
  messages: ToolChatMessage[],
  catalog: ChatToolDescriptor[],
  round: number
): QwenToolCall | null {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser || !needsExternalEvidence(lastUser.content)) {
    return null;
  }
  return buildSearchToolCall(lastUser.content, catalog, `forced-${round}`);
}

/** 按工具 schema 找出最像「检索词」的字符串参数，把用户原话填进去。 */
function forcedToolArguments(descriptor: ChatToolDescriptor, query: string): Record<string, unknown> {
  const parameters = descriptor.definition.function.parameters as {
    properties?: Record<string, { type?: string }>;
  };
  const properties = parameters?.properties ?? {};
  const preferred = [
    "query",
    "keyword",
    "keywords",
    "q",
    "search",
    "text",
    "topic",
    "title",
    "question"
  ];
  const name =
    preferred.find((key) => properties[key]) ??
    Object.keys(properties).find((key) => properties[key]?.type === "string");
  return name ? { [name]: query.trim().slice(0, 300) } : {};
}

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
  /** 关掉后完全依赖模型自觉，主要用于回归测试与特殊模型。 */
  forceToolsForExternalEvidence?: boolean;
  /**
   * 首轮不问模型，直接执行这次调用。
   * 问题明显属于某个专项智能体时由后端路由，省一次往返，也不给模型「先反问一通」的机会。
   */
  presetToolCall?: QwenToolCall;
  /** 转交成功后立刻收尾，把这轮交给专项智能体作答。 */
  stopAfterDelegation?: boolean;
  onProgress?: (progress: ChatToolProgress) => void;
  /**
   * 成文轮边生成边回调。只在「已经执行过工具、这一轮基本就是写给用户看」的时候开流式，
   * 让第一个字随模型吐字出现，而不是等整段写完再一次性发。
   *
   * 前 24 个字先攒着不发：模型偶尔会先来一句「我先查一下」再去调工具，
   * 那半句不该出现在正文里。攒够 60 字还没调工具，就当它确实在写答复了。
   */
  onDelta?: (delta: string) => void;
  /** 流式补全实现，可注入以便测试。 */
  streamComplete?: typeof streamQwenToolChat;
}): Promise<ChatToolLoopResult> {
  const complete = input.complete ?? completeQwenToolChat;
  const maxRounds = input.maxRounds ?? maxChatToolRounds();
  const tools = input.catalog.map((item) => item.definition);
  const messages: ToolChatMessage[] = [...input.messages];
  const calls: ChatToolTrace[] = [];
  let content = "";
  let rounds = 0;
  let forcedToolCall = false;
  let forceAttempted = false;
  let delegatedAnswer: DelegatedAnswer | undefined;

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;
    const base = {
      system: input.system,
      model: input.model,
      maxTokens: input.maxTokens,
      temperature: input.temperature,
      provider: input.provider,
      tools,
      signal: input.signal
    };
    const preset = round === 1 ? input.presetToolCall : undefined;
    // 已经跑过工具之后的那一轮，基本就是成文轮：改走流式，第一个字立刻推给前端。
    const streamAnswer = Boolean(input.onDelta) && calls.length > 0 && !preset;
    let spill = "";
    let spilling = false;
    const pushDelta = (delta: string) => {
      if (!input.onDelta || !delta) {
        return;
      }
      if (!spilling) {
        spill += delta;
        // 攒够 24 字还没去调工具，就当它确实在写答复了：再攒下去首字就白等了。
        if (spill.length < 24) {
          return;
        }
        spilling = true;
        input.onDelta(spill);
        spill = "";
        return;
      }
      input.onDelta(delta);
    };

    let response: ToolChatResult;
    if (preset) {
      response = { content: "", toolCalls: [preset] };
    } else if (streamAnswer) {
      response = await (input.streamComplete ?? streamQwenToolChat)({
        ...base,
        messages,
        onDelta: pushDelta,
        onThinkingDelta: () => {}
      });
    } else {
      response = await complete({ ...base, messages });
    }

    // 首轮模型一个工具都不调、而用户明显在要真实资料时，逐级兜底：
    // required → 强制提示词 → 后端直接构造一次调用。这样「挂了插件却像纯 AI 回答」不会再发生。
    // 预设调用不需要这套兜底：那本来就绕过了模型。
    if (
      !preset &&
      round === 1 &&
      !forceAttempted &&
      response.toolCalls.length === 0 &&
      tools.length > 0 &&
      input.forceToolsForExternalEvidence !== false
    ) {
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      if (lastUser && needsExternalEvidence(lastUser.content)) {
        forceAttempted = true;
        let retried: ToolChatResult | undefined;
        try {
          retried = await complete({ ...base, messages, toolChoice: "required" });
        } catch {
          // 部分 OpenAI 兼容端点不接受 tool_choice=required，交给下一级处理。
        }
        if (!retried?.toolCalls.length) {
          try {
            retried = await complete({
              ...base,
              system: [input.system, FORCE_TOOL_SYSTEM_HINT].filter(Boolean).join("\n\n"),
              messages
            });
          } catch {
            retried = undefined;
          }
        }
        if (retried?.toolCalls.length) {
          // 重试前模型可能已经编了一段「文献清单」，别让它进入上下文当依据。
          response = { ...retried, content: "" };
        } else {
          const forced = buildForcedToolCall(messages, input.catalog, round);
          if (forced) {
            forcedToolCall = true;
            response = { content: "", toolCalls: [forced] };
          } else {
            input.onProgress?.({
              stage: "skipped",
              toolId: "tool-call-skipped",
              name: "未调用工具",
              summary: "模型没有调用任何工具，本轮回答未经外部检索，请核对其中的文献与数据。"
            });
          }
        }
      }
    }

    // 成文轮里没攒够 24 字的那点尾巴，等确认这一轮确实不调工具再补发。
    if (spill) {
      if (!spilling && response.toolCalls.length === 0) {
        input.onDelta?.(spill);
      }
      spill = "";
    }

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
      // 转交成功就不再让主智能体重写：学生问到文献，答复就该是文献阅读Agent的说法。
      if (execution.delegated && input.stopAfterDelegation) {
        delegatedAnswer = execution.delegated;
        break;
      }
    }

    if (delegatedAnswer) {
      break;
    }
  }

  if (!content.trim() && !delegatedAnswer) {
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

  if (!content.trim() && !delegatedAnswer) {
    throw new UpstreamModelError("智能体调用工具后没有给出答复，请换个问法再试一次。");
  }

  return { content, rounds, calls, forcedToolCall, delegatedAnswer };
}

async function executeToolCall(
  call: QwenToolCall,
  catalog: ChatToolDescriptor[],
  callTool: (tool: ToolRecord, args: Record<string, unknown>) => Promise<McpCallResult>,
  onProgress?: (progress: ChatToolProgress) => void
): Promise<{ content: string; trace: ChatToolTrace; delegated?: DelegatedAnswer }> {
  const descriptor = catalog.find((item) => item.functionName === call.function.name);
  const startedAt = Date.now();

  if (!descriptor) {
    return failed(call, `模型请求了未声明的工具「${call.function.name}」。`, startedAt, undefined, onProgress);
  }

  const displayName = descriptor.tool.name || lastSegment(descriptor.toolId);
  const parsed = parseToolArguments(call.function.arguments);
  if (!parsed.ok) {
    return failed(
      call,
      `工具参数不是合法 JSON 对象：${parsed.error}`,
      startedAt,
      descriptor,
      onProgress
    );
  }

  onProgress?.({
    stage: "running",
    toolId: descriptor.toolId,
    name: displayName,
    kind: descriptor.kind,
    targetAgent: descriptor.targetAgent
  });

  try {
    const result = await callTool(descriptor.tool, parsed.value);
    const text = truncate(result.text.trim() || "（工具没有返回文本内容）", MAX_TOOL_RESULT_CHARS);
    const summary = `${result.serverName} · ${result.tool}（${result.latencyMs} ms）`;
    // 「平台插件」这类通用名对用户没信息量，用工具自己的名字更清楚。
    const serverName = result.serverName === "平台插件" ? undefined : result.serverName;
    const toolName = prettyToolName(result.tool, descriptor);
    const trace: ChatToolTrace = {
      id: call.id,
      toolId: descriptor.toolId,
      name: displayName,
      arguments: parsed.value,
      ok: !result.isError,
      latencyMs: result.latencyMs,
      summary,
      kind: descriptor.kind,
      serverName,
      toolName
    };
    onProgress?.({
      stage: "done",
      toolId: descriptor.toolId,
      name: displayName,
      ok: trace.ok,
      summary,
      latencyMs: result.latencyMs,
      kind: descriptor.kind,
      targetAgent: descriptor.targetAgent,
      serverName,
      toolName
    });
    return { content: text, trace, delegated: result.delegatedAnswer };
  } catch (error) {
    return failed(call, describe(error), startedAt, descriptor, onProgress, parsed.value);
  }
}

function failed(
  call: QwenToolCall,
  message: string,
  startedAt: number,
  descriptor: ChatToolDescriptor | undefined,
  onProgress?: (progress: ChatToolProgress) => void,
  args: Record<string, unknown> | string = call.function.arguments
): { content: string; trace: ChatToolTrace } {
  const latencyMs = Date.now() - startedAt;
  const name = descriptor?.tool.name || call.function.name;
  const summary = `工具调用失败：${truncate(message, 160)}`;
  if (descriptor) {
    onProgress?.({
      stage: "done",
      toolId: descriptor.toolId,
      name,
      ok: false,
      summary,
      latencyMs,
      kind: descriptor.kind,
      targetAgent: descriptor.targetAgent
    });
  }
  return {
    content: JSON.stringify({ error: message }),
    trace: {
      id: call.id,
      toolId: descriptor?.toolId ?? "",
      name,
      arguments: args,
      ok: false,
      latencyMs,
      summary,
      kind: descriptor?.kind
    }
  };
}

/** 工具函数名：内置插件的 result.tool 是工具记录 id，取末段才是真名。 */
function prettyToolName(raw: string, descriptor: ChatToolDescriptor): string {
  const name = raw.trim();
  if (!name || name.startsWith("plugin.") || name.startsWith("builtin.")) {
    return lastSegment(descriptor.toolId);
  }
  return name;
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
