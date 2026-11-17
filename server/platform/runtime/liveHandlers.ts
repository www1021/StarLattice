import type {
  AgentNode,
  AgentRecord,
  ClarifyNode,
  ExtractNode,
  KnowledgeNode,
  LlmNode,
  McpCallResult,
  ToolNode,
  ToolRecord
} from "../types.js";
import {
  completeQwenChat,
  completeQwenToolChat,
  streamQwenChat,
  type QwenToolCall,
  type QwenToolDefinition,
  type ToolChatMessage
} from "../../qwenOpenAiClient.js";
import {
  getModelCatalog,
  isAnyModelConfigured,
  resolveAgentModel,
  resolveModel,
  type ModelResolution
} from "../models/catalog.js";
import { configuredModelOwnerIds } from "../models/userModels.js";
import { currentOwnerId, runWithAuth, type AuthContext } from "../../auth/context.js";
import type { ClarifyPhase, ExecutionContext, ExecutorHandlers } from "./executor.js";
import { emitRunToken, hasRunTokenListeners } from "./runStreamBus.js";

type KnowledgeCitation = {
  id?: unknown;
  documentName?: unknown;
  knowledgeBaseName?: unknown;
  snippet?: unknown;
  source?: unknown;
  score?: unknown;
};

type KnowledgeSearch = (options: {
  query: string;
  knowledgeBaseIds: string[];
  topK?: number;
}) => Promise<KnowledgeCitation[]>;

export type LiveHandlerOptions = {
  getAgent: (id: string) => AgentRecord | undefined;
  getAgentVersion?: (id: string, version: number) => AgentRecord | undefined;
  getTool?: (id: string) => ToolRecord | undefined;
  callMcpTool?: (tool: ToolRecord, args: Record<string, unknown>) => Promise<McpCallResult>;
  searchKnowledge?: KnowledgeSearch;
  /** 测试或私有部署可替换的补全实现；默认按解析出的 provider 调用。 */
  completeChat?: typeof completeQwenChat;
  completeToolChat?: typeof completeQwenToolChat;
  maxTokens?: number;
  temperature?: number;
};

const REF_PATTERN = /\$\{([^}\s]+)\}/g;

/**
 * 真实 Agent 与内置工具的实现入口。默认关闭：只有显式设置 PLATFORM_LIVE_AGENTS=1
 * 且至少一个模型目录项具备凭据时才创建 handler，否则执行器继续使用确定性 stub，避免误触发计费。
 *
 * 注意判定发生在服务启动时，此时没有请求身份，isAnyModelConfigured() 读的是空的
 * _system 目录；必须同时扫描各账号的 settings 目录，否则用户在「模型与密钥」里
 * 明明配好了 Key，执行器仍会永久停在 stub（llm 节点只回 [stub:llm] 夹具文本）。
 */
export function isPlatformLiveEnabled() {
  if (process.env.PLATFORM_LIVE_AGENTS !== "1") {
    return false;
  }
  return isAnyModelConfigured() || configuredModelOwnerIds().length > 0;
}

/**
 * 后台调度（SchedulerService 的定时 tick / Worker 回调）可能已经脱离请求 ALS，
 * 这时 resolveModel() 读不到账号的 models.json。单账号私有部署里用唯一的模型配置
 * 目录把身份续上；多账号时不做猜测，保持无身份，避免把某个账号的 Key 用到别人的请求上。
 */
function withModelOwner<T>(callback: () => T): T {
  if (currentOwnerId()) {
    return callback();
  }
  const owners = configuredModelOwnerIds();
  if (owners.length !== 1) {
    return callback();
  }
  const scope: AuthContext = {
    userId: owners[0],
    username: "",
    displayName: "",
    role: "owner",
    sessionId: ""
  };
  return runWithAuth(scope, callback);
}

export function createPlatformLiveHandlers(options: LiveHandlerOptions): ExecutorHandlers {
  if (!isPlatformLiveEnabled()) {
    return {};
  }

  const maxTokens = positiveInt(options.maxTokens ?? process.env.PLATFORM_LIVE_MAX_TOKENS, 2048);
  const temperature = fraction(options.temperature ?? process.env.PLATFORM_LIVE_TEMPERATURE, 0.35);

  return {
    agent: (node, input, context) =>
      withModelOwner(() =>
        runLiveAgent(node, input, context, { ...options, maxTokens, temperature })
      ),
    llm: (node, input, context) =>
      withModelOwner(() =>
        runLiveLlm(node, input, context, { ...options, maxTokens, temperature })
      ),
    clarify: (node, input, context, phase) =>
      withModelOwner(() =>
        runLiveClarify(node, input, context, phase, { ...options, maxTokens })
      ),
    extract: (node, input, context) =>
      withModelOwner(() =>
        // 抽参数是「照着文本抄」，温度压到 0 最稳，也不该占用大段输出额度。
        runLiveExtract(node, input, context, { ...options, maxTokens: Math.min(maxTokens, 1024) })
      ),
    tool: (node, input, context) =>
      withModelOwner(() => runLiveTool(node, input, context, options))
  };
}

/**
 * 模型思考节点：不绑定 Agent 角色，直接按节点提示词调用模型；
 * thinking=true 时请求上游返回 reasoning_content，并作为可折叠的思考摘要落库。
 */
async function runLiveLlm(
  node: LlmNode,
  rawInput: Record<string, unknown>,
  context: ExecutionContext,
  defaults: {
    maxTokens: number;
    temperature: number;
    completeChat?: typeof completeQwenChat;
  }
) {
  const input = withoutSelfLoop(rawInput);
  const resolution = resolveModel(node.model, {
    source: "node",
    budgetExceeded: budgetExceeded(context)
  });
  const model = resolution.model;
  const maxTokens = clampInt(node.maxTokens ?? defaults.maxTokens, 1, 32768);
  const temperature = node.temperature ?? defaults.temperature;

  const { content, thinking } = await chatWithOptionalStream({
    context,
    system: node.system?.trim()
      ? interpolate(node.system.trim(), context)
      : "你是 Agent 编排平台中的通用模型节点。只输出可交付结果，不要复述任务，不要输出占位内容。",
    // system 与 prompt 走同一套 ${…} 引用解析。元器导入的 systemPrompt 里
    // 常带 {{var}}，转换器已改成引用；不插值的话模型会收到字面占位符。
    prompt: [
      `## 节点任务\n${node.title ?? node.id}`,
      node.prompt ? `## 任务说明\n${interpolate(node.prompt, context)}` : "",
      `## 节点输入\n${formatInputs(input)}`
    ]
      .filter(Boolean)
      .join("\n\n"),
    model,
    maxTokens,
    temperature,
    topP: node.topP,
    enableThinking: node.thinking === true,
    provider: providerConfig(resolution),
    completeChat: defaults.completeChat
  });

  return {
    mode: "live",
    kind: "llm",
    ...modelTrace(resolution),
    summary: summarize(content, 220),
    thinking: thinking || undefined,
    output: content,
    inputs: input
  };
}

const EXTRACT_SYSTEM = [
  "你是参数抽取器。任务是从给定文本里摘出指定参数，不做推理、不做补全。",
  "只输出一个 JSON 对象：键是参数名，值是原文里的片段；找不到的参数给空字符串。",
  "规则：",
  "1. 只抄原文，不改写、不缩写、不翻译，也不要把铺垫话术（「我的论文题目是」）带进去；",
  "2. 找不到就留空，绝对不许编造或用示例值填；",
  "3. 参数是数字 / 布尔时按声明类型输出，别把整句话塞进去；",
  "4. 除 JSON 外不要输出任何解释、Markdown 或代码块标记。"
].join("\n");

/**
 * 参数提取的模型调用：一次只回一个 JSON。
 * 上层负责「缺了就追问」，所以这里没抽到就老实留空，不能拿模型猜的值去糊弄下游。
 */
async function runLiveExtract(
  node: ExtractNode,
  rawInput: Record<string, unknown>,
  context: ExecutionContext,
  defaults: {
    maxTokens: number;
    completeChat?: typeof completeQwenChat;
  }
) {
  const input = withoutSelfLoop(rawInput);
  const params = (node.params ?? []).filter(
    (item) => typeof item?.name === "string" && item.name.trim() !== ""
  );
  if (params.length === 0) {
    return { mode: "live", kind: "extract", output: {}, params: {}, summary: "没有声明参数" };
  }
  const text = extractSourceText(input);
  if (text.trim() === "") {
    return { mode: "live", kind: "extract", output: {}, params: {}, summary: "没有可抽取的文本" };
  }

  const resolution = resolveModel(node.model, {
    source: "node",
    budgetExceeded: budgetExceeded(context)
  });
  const table = params
    .map((param, index) => {
      const bits = [
        param.label?.trim() ? `展示名=${param.label.trim()}` : "",
        param.type ? `类型=${param.type}` : "",
        param.required === false ? "必填=否" : "必填=是",
        param.description?.trim() ? `说明=${param.description.trim()}` : ""
      ].filter(Boolean);
      return `${index + 1}. ${param.name}（${bits.join("；")}）`;
    })
    .join("\n");

  const content = await (defaults.completeChat ?? completeQwenChat)({
    system: EXTRACT_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `## 参数表\n${table}`,
          `## 待抽取文本\n${text}`,
          node.prompt?.trim() ? `## 额外规则\n${interpolate(node.prompt.trim(), context)}` : "",
          "## 输出\n只输出 JSON 对象，键为参数名。"
        ]
          .filter(Boolean)
          .join("\n\n")
      }
    ],
    model: resolution.model,
    maxTokens: clampInt(defaults.maxTokens, 1, 32768),
    temperature: 0,
    provider: providerConfig(resolution)
  });

  const parsed = parseJsonObjectFromText(content) ?? {};
  // 只收参数表里声明过的键：模型多给的字段一律丢掉，免得下游引用到不存在的变量。
  const values: Record<string, unknown> = {};
  for (const param of params) {
    const value = parsed[param.name];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.trim() === "") {
      continue;
    }
    values[param.name] = value;
  }

  return {
    mode: "live",
    kind: "extract",
    ...modelTrace(resolution),
    summary: summarize(content, 160),
    output: values,
    params: values,
    inputs: input
  };
}

/** 抽取用的正文：取输入里的字符串，按顺序拼；数组 / 对象整段丢给模型只会干扰判断。 */
function extractSourceText(input: Record<string, unknown>): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const value of Object.values(input)) {
    if (typeof value !== "string") {
      continue;
    }
    const text = value.trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    parts.push(text);
  }
  return parts.join("\n");
}

const CLARIFY_ANALYZE_SYSTEM = [  "你是 Agent 编排平台的意图分析器。只依据用户原始需求与已给约束分析，不编造事实。",
  "只输出一个 JSON 对象，字段：taskType、goal、audience、deliverable、constraints（字符串数组）、",
  "ambiguities（数组，元素为 {slot, question, impact}，impact ∈ high/medium/low）、assumptions（字符串数组）、",
  "needsClarification（布尔）、confidence（0-1）。",
  "规则：歧义必须具体到可直接回答；只有缺失信息会改变交付结果时才标 high；已有信息不要重复提问。"
].join("\n");

const CLARIFY_REWRITE_SYSTEM = [
  "你是平台的 Prompt 重写器。把原始模糊需求改写成可直接执行的结构化 Prompt。",
  "必须包含：目标、已知条件、待确认假设、交付格式、验收标准、禁止事项，用 Markdown 分节。",
  "规则：保留原始意图；不得引入原始需求、意图分析与人工澄清之外的事实或数字；",
  "所有补充信息都要能追溯到上述来源。只输出 JSON：{\"rewrittenPrompt\": \"...\", \"changes\": [\"...\"]}。"
].join("\n");

/**
 * 意图澄清节点的真实实现：分析阶段只输出意图结构；改写阶段把澄清结果并入结构化 Prompt。
 * 数值守门：改写稿不得出现原文与澄清回答之外的数字，命中时带纠正指令重写一次。
 */
async function runLiveClarify(
  node: ClarifyNode,
  rawInput: Record<string, unknown>,
  context: ExecutionContext,
  phase: ClarifyPhase,
  defaults: {
    maxTokens: number;
    completeChat?: typeof completeQwenChat;
  }
) {
  const input = withoutSelfLoop(rawInput);
  const resolution = resolveModel(node.model, {
    source: "node",
    budgetExceeded: budgetExceeded(context)
  });
  const model = resolution.model;
  const maxTokens = clampInt(defaults.maxTokens, 1, 32768);
  const temperature = 0.2;
  const completeChat = defaults.completeChat ?? completeQwenChat;
  const rawPrompt = requestOf(input);
  const hint = stringValue(input.hint).trim();

  if (phase.phase === "analyze") {
    const content = await completeChat({
      system: CLARIFY_ANALYZE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `## 原始需求\n${rawPrompt}`,
            hint ? `## 领域提示\n${hint}` : "",
            "## 输出\n只输出 JSON 对象。"
          ]
            .filter(Boolean)
            .join("\n\n")
        }
      ],
      model,
      maxTokens,
      temperature,
      provider: providerConfig(resolution)
    });
    const parsed = parseJsonObjectFromText(content);
    if (!parsed) {
      throw new Error("意图分析未返回合法 JSON 对象。");
    }
    return {
      mode: "live",
      kind: "clarify",
      ...modelTrace(resolution),
      summary: summarize(content, 200),
      output: parsed,
      inputs: input
    };
  }

  const analysis = phase.analysis;
  const clarification = phase.clarification;
  const callRewrite = async (correction?: string) => {
    const content = await completeChat({
      system: CLARIFY_REWRITE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `## 原始需求\n${rawPrompt}`,
            `## 意图分析\n${JSON.stringify(analysis, null, 2)}`,
            clarification?.answer ? `## 人工澄清\n${clarification.answer}` : "",
            correction ? `## 纠正要求\n${correction}` : "",
            "## 输出\n只输出 JSON 对象。"
          ]
            .filter(Boolean)
            .join("\n\n")
        }
      ],
      model,
      maxTokens,
      temperature,
      provider: providerConfig(resolution)
    });
    const parsed = parseJsonObjectFromText(content);
    const rewrittenPrompt = stringValue(parsed?.rewrittenPrompt).trim();
    if (!parsed || rewrittenPrompt === "") {
      throw new Error("Prompt 改写未返回 rewrittenPrompt 字段。");
    }
    return {
      rewrittenPrompt,
      changes: stringList(parsed.changes),
      summary: summarize(content, 200)
    };
  };

  const allowedNumbers = `${rawPrompt}\n${clarification?.answer ?? ""}`;
  let rewrite = await callRewrite();
  let unexpected = findNewNumbers(allowedNumbers, rewrite.rewrittenPrompt);
  if (unexpected.length > 0) {
    rewrite = await callRewrite(
      `上一版改写在 Prompt 中引入了原文没有的数字：${unexpected.join("、")}。请移除这些数字或改为定性表述。`
    );
    unexpected = findNewNumbers(allowedNumbers, rewrite.rewrittenPrompt);
  }

  return {
    mode: "live",
    kind: "clarify",
    ...modelTrace(resolution),
    summary: rewrite.summary,
    output: { rewrittenPrompt: rewrite.rewrittenPrompt, changes: rewrite.changes },
    rewrittenPrompt: rewrite.rewrittenPrompt,
    changes: rewrite.changes,
    guardrail: { ok: unexpected.length === 0, unexpected },
    inputs: input
  };
}

async function runLiveAgent(
  node: AgentNode,
  rawInput: Record<string, unknown>,
  context: ExecutionContext,
  options: LiveHandlerOptions
) {
  const agent =
    context.agentSnapshots?.get(node.agent) ??
    (node.agentVersion === undefined
      ? options.getAgent(node.agent)
      : options.getAgentVersion?.(node.agent, node.agentVersion));
  if (!agent) {
    throw new Error(
      node.agentVersion === undefined
        ? `Agent「${node.agent}」未在注册中心中找到，无法执行节点 ${node.id}。`
        : `Agent「${node.agent}」的版本 v${node.agentVersion} 未在版本历史中找到，无法执行节点 ${node.id}。`
    );
  }
  if (!agent.enabled) {
    throw new Error(`Agent「${agent.name}」已停用，无法执行节点 ${node.id}。`);
  }

  const input = withoutSelfLoop(rawInput);
  const system = buildAgentSystemPrompt(agent, node);
  const prompt = buildAgentUserPrompt(node, input, rawInput, context);
  const resolution = resolveAgentModel({
    nodeModel: node.model,
    agentModel: agent.model,
    budgetExceeded: budgetExceeded(context)
  });

  if (node.toolCalling !== true) {
    // JSON 输出模式不做真流式：token 流是原始 JSON 碎片，打印出来没法看，
    // 反正结束后还有 normalizeAgentJsonOutput 的整篇替换兜底。
    const streamable = (node.outputFormat ?? "text") === "text";
    let content: string;
    if (streamable) {
      ({ content } = await chatWithOptionalStream({
        context,
        system,
        prompt,
        model: resolution.model,
        maxTokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.35,
        provider: providerConfig(resolution),
        completeChat: options.completeChat
      }));
    } else {
      content = await (options.completeChat ?? completeQwenChat)({
        system,
        messages: [{ role: "user", content: prompt }],
        model: resolution.model,
        maxTokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.35,
        provider: providerConfig(resolution)
      });
    }

    return {
      mode: "live",
      agent: agent.id,
      agentName: agent.name,
      agentVersion: agent.version,
      role: agent.role,
      ...modelTrace(resolution),
      outputFormat: node.outputFormat ?? "text",
      summary: summarize(content, 220),
      output: content,
      inputs: input,
      tools: agent.tools,
      memory: agent.memory
    };
  }

  const catalog = buildAgentToolCatalog(agent, options);
  if (catalog.length === 0) {
    throw new Error(
      `Agent「${agent.name}」开启工具调用，但声明的工具中没有可执行的 knowledge.search 或已启用的 MCP 工具。`
    );
  }

  const result = await runAgentWithTools({
    system,
    prompt,
    catalog,
    options,
    context,
    input,
    resolution
  });
  const citations = result.trace.flatMap((call) => call.citations ?? []);

  return {
    mode: "live",
    agent: agent.id,
    agentName: agent.name,
    agentVersion: agent.version,
    role: agent.role,
    ...modelTrace(resolution),
    outputFormat: node.outputFormat ?? "text",
    toolCalling: "enabled",
    toolRounds: result.rounds,
    toolCalls: result.trace,
    citations,
    summary: `工具调用 ${result.trace.length} 次 · ${summarize(result.content, 180)}`,
    output: result.content,
    inputs: input,
    tools: agent.tools,
    memory: agent.memory
  };
}

type AgentToolDescriptor = {
  functionName: string;
  toolId: string;
  kind: "knowledge" | "mcp";
  definition: QwenToolDefinition;
  tool?: ToolRecord;
};

type ToolCallTrace = {
  id: string;
  name: string;
  toolId: string;
  arguments: Record<string, unknown> | string;
  ok: boolean;
  latencyMs: number;
  summary: string;
  citations?: Array<{ title: string; source: string }>;
};

/**
 * 只暴露 Agent 自己声明且当前可执行的工具。工具 id 含点号，必须转成 OpenAI 允许的函数名，
 * 再由这里反向映射回注册中心记录，避免模型直接拼 MCP 端点。
 */
function buildAgentToolCatalog(agent: AgentRecord, options: LiveHandlerOptions) {
  const catalog: AgentToolDescriptor[] = [];
  const usedNames = new Set<string>();

  for (const toolId of agent.tools) {
    if (toolId === "knowledge.search") {
      if (!options.searchKnowledge) {
        continue;
      }
      const functionName = uniqueFunctionName("knowledge_search", usedNames);
      catalog.push({
        functionName,
        toolId,
        kind: "knowledge",
        definition: {
          type: "function",
          function: {
            name: functionName,
            description: "检索工作流绑定的知识库，返回可引用的口径规则或资料片段。（工具 ID：knowledge.search）",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "检索问题或关键词，尽量具体。" },
                topK: { type: "integer", minimum: 1, maximum: 10, description: "返回条数，默认 5。" }
              },
              required: ["query"]
            }
          }
        }
      });
      continue;
    }

    const tool = options.getTool?.(toolId);
    // 内置工具（type=builtin，端点 builtin://…）和 MCP 走的是同一条执行通道：
    // callMcpTool 就是 platformMcp.callToolRecord，它内部按端点分流到内置执行器。
    // 之前这里只放 mcp，导致「测量分析师」这类只挂内置工具的 Agent 目录为空、
    // 节点直接报错——注册中心允许声明，运行时却不认，属于两边口径不一致。
    const executable = tool && (tool.type === "mcp" || tool.type === "builtin");
    if (!executable || !tool.enabled || !options.callMcpTool) {
      continue;
    }
    const functionName = uniqueFunctionName(lastSegment(toolId), usedNames);
    catalog.push({
      functionName,
      toolId,
      kind: "mcp",
      tool,
      definition: {
        type: "function",
        function: {
          name: functionName,
          description: `${tool.description}（工具 ID：${toolId}）`,
          parameters: toObjectSchema(tool.schema)
        }
      }
    });
  }

  return catalog;
}

async function runAgentWithTools(input: {
  system: string;
  prompt: string;
  catalog: AgentToolDescriptor[];
  options: LiveHandlerOptions;
  context: ExecutionContext;
  input: Record<string, unknown>;
  resolution: ModelResolution;
}) {
  const { system, prompt, catalog, options, context, input: agentInput, resolution } = input;
  const model = resolution.model;
  const maxTokens = options.maxTokens ?? 2048;
  const temperature = options.temperature ?? 0.35;
  const maxRounds = clampInt(positiveInt(process.env.PLATFORM_AGENT_TOOL_ROUNDS, 4), 1, 8);
  const complete = options.completeToolChat ?? completeQwenToolChat;
  const provider = providerConfig(resolution);
  const messages: ToolChatMessage[] = [{ role: "user", content: prompt }];
  const trace: ToolCallTrace[] = [];
  let content = "";
  let rounds = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    rounds = round;
    const response = await complete({
      system,
      messages,
      model,
      maxTokens,
      temperature,
      provider,
      tools: catalog.map((item) => item.definition)
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
      const execution = await executeAgentToolCall({
        call,
        catalog,
        options,
        context,
        agentInput
      });
      trace.push(execution.trace);
      messages.push({
        role: "tool",
        tool_call_id: execution.trace.id,
        content: execution.content
      });
    }
  }

  if (!content.trim()) {
    // 达到轮次上限或模型只返回了 tool_calls：禁用工具再要一次最终答复，避免死循环。
    const final = await complete({
      system,
      messages,
      model,
      maxTokens,
      temperature,
      provider,
      tools: []
    });
    content = final.content;
  }

  if (!content.trim()) {
    throw new Error(`Agent 在 ${rounds} 轮工具调用后仍未返回最终内容。`);
  }

  return { content, trace, rounds };
}

async function executeAgentToolCall(input: {
  call: QwenToolCall;
  catalog: AgentToolDescriptor[];
  options: LiveHandlerOptions;
  context: ExecutionContext;
  agentInput: Record<string, unknown>;
}): Promise<{ content: string; trace: ToolCallTrace }> {
  const { call, catalog, options, context, agentInput } = input;
  const descriptor = catalog.find((item) => item.functionName === call.function.name);
  const startedAt = Date.now();

  if (!descriptor) {
    const message = `模型请求了未声明的工具「${call.function.name}」。`;
    return toolError(call, "", message, startedAt);
  }

  const parsed = parseToolArguments(call.function.arguments);
  if (!parsed.ok) {
    return toolError(call, descriptor.toolId, `工具参数不是合法 JSON 对象：${parsed.error}`, startedAt);
  }

  if (descriptor.kind === "knowledge") {
    const query = stringValue(parsed.value.query).trim();
    if (!query) {
      return toolError(call, descriptor.toolId, "knowledge.search 缺少非空 query。", startedAt);
    }
    const knowledgeBaseIds =
      context.knowledgeBaseIds && context.knowledgeBaseIds.length > 0
        ? context.knowledgeBaseIds
        : stringList(agentInput.knowledgeBaseIds);
    if (knowledgeBaseIds.length === 0) {
      return toolError(call, descriptor.toolId, "当前工作流未绑定知识库，无法检索。", startedAt);
    }
    if (!options.searchKnowledge) {
      return toolError(call, descriptor.toolId, "知识库检索服务未接入。", startedAt);
    }

    try {
      const topK = clampInt(numberValue(parsed.value.topK) ?? 5, 1, 10);
      const citations = await options.searchKnowledge({ query, knowledgeBaseIds, topK });
      const mapped = citations.map((citation, index) => ({
        title: stringValue(citation.documentName) || `引用 ${index + 1}`,
        documentName: stringValue(citation.documentName),
        knowledgeBaseName: stringValue(citation.knowledgeBaseName),
        snippet: stringValue(citation.snippet),
        source: stringValue(citation.source) || "local",
        score: numberValue(citation.score) ?? 0
      }));
      const content = truncate(JSON.stringify({ query, citations: mapped }, null, 2), 6000);
      return {
        content,
        trace: {
          id: call.id,
          name: call.function.name,
          toolId: descriptor.toolId,
          arguments: parsed.value,
          ok: true,
          latencyMs: Date.now() - startedAt,
          summary: `知识库检索「${query}」命中 ${mapped.length} 条`,
          citations: mapped.map((item) => ({ title: item.title, source: item.source }))
        }
      };
    } catch (error) {
      return toolError(call, descriptor.toolId, describe(error), startedAt);
    }
  }

  const tool = descriptor.tool;
  if (!tool || !options.callMcpTool) {
    return toolError(call, descriptor.toolId, "MCP 工具不可执行。", startedAt);
  }

  const args = {
    ...defaultToolArgs({ ...context.scope.input, ...agentInput }),
    ...parsed.value
  };

  try {
    const result = await options.callMcpTool(tool, args);
    const text = truncate(result.text.trim() || "（MCP 工具未返回文本内容）", 6000);
    return {
      content: text,
      trace: {
        id: call.id,
        name: call.function.name,
        toolId: descriptor.toolId,
        arguments: args,
        ok: !result.isError,
        latencyMs: result.latencyMs,
        summary: `${result.serverName} · ${result.tool}（${result.latencyMs} ms）`
      }
    };
  } catch (error) {
    return toolError(call, descriptor.toolId, describe(error), startedAt, args);
  }
}

function toolError(
  call: QwenToolCall,
  toolId: string,
  message: string,
  startedAt: number,
  args: Record<string, unknown> | string = call.function.arguments
): { content: string; trace: ToolCallTrace } {
  return {
    content: JSON.stringify({ error: message }),
    trace: {
      id: call.id,
      name: call.function.name,
      toolId,
      arguments: args,
      ok: false,
      latencyMs: Date.now() - startedAt,
      summary: `工具调用失败：${truncate(message, 160)}`
    }
  };
}

function parseToolArguments(raw: string) {
  const text = raw.trim();
  if (!text) {
    return { ok: true as const, value: {} as Record<string, unknown> };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true as const, value: parsed as Record<string, unknown> };
    }
    return { ok: false as const, error: "必须是 JSON 对象" };
  } catch (error) {
    return { ok: false as const, error: describe(error) };
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

function defaultToolArgs(input: Record<string, unknown>) {
  const source = stringValue(input.source).trim();
  return source ? { source } : {};
}

/** 注册中心的工具集与记忆配置必须在运行期真正进入提示词，不能只做展示。 */
export function buildAgentSystemPrompt(agent: AgentRecord, node?: AgentNode) {
  const capabilities = agent.capabilities
    .map((capability) => `${capability.tag}(${capability.weight})`)
    .join("、");
  const tools = agent.tools.length > 0 ? `可用工具：${agent.tools.join("、")}。需要证据时优先调用知识库检索工具。` : "";
  const toolProtocol =
    node?.toolCalling === true
      ? "工具调用协议：你可以自主调用已声明的工具补充事实，平台会执行并把结果回填；先调用工具再下结论，工具结果是外部事实的唯一来源，不要编造工具参数或返回值。完成必要调用后，必须给出符合输出契约的最终答复。"
      : "";
  const memory =
    Object.keys(agent.memory).length > 0
      ? `记忆配置（跨轮次保留）：${JSON.stringify(agent.memory)}。`
      : "";
  const jsonOnly = node?.outputFormat === "json" || /JSON/i.test(agent.prompt);
  const contract = node?.outputContract;
  // 诊断角色可以建议换模型，但只能从目录里选，避免写出执行层无法解析的 id。
  const modelDirectory =
    node?.loopRole === "diagnose"
      ? `可选模型目录：${getModelCatalog()
          .map((profile) => `${profile.id}（${profile.label}，${profile.costTier}）`)
          .join("、")}。`
      : "";

  return [
    `你是「${agent.name}」，在 Agent 编排平台的工作流节点中承担「${agent.role}」职责。`,
    agent.prompt,
    capabilities ? `能力标签：${capabilities}。` : "",
    tools,
    toolProtocol,
    memory,
    modelDirectory,
    jsonOnly
      ? "输出要求：只输出一个合法 JSON 对象，不要使用 Markdown 代码块，不要添加解释性前后缀。"
      : "输出要求：直接给出可交付的成稿，用 Markdown 组织；不要复述任务，不要输出 TODO、待补充、示例占位等占位内容；引用知识库证据时使用 [1][2] 编号，并在结尾列出“引用来源”。",
    jsonOnly && contract?.required?.length
      ? `JSON 必填字段：${contract.required.join("、")}。`
      : "",
    jsonOnly && contract?.enums
      ? `JSON 枚举约束：${Object.entries(contract.enums)
          .map(([key, values]) => `${key} ∈ {${values.join(", ")}}`)
          .join("；")}。`
      : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function buildAgentUserPrompt(
  node: AgentNode,
  input: Record<string, unknown>,
  rawInput: Record<string, unknown>,
  context: ExecutionContext
) {
  const sections = [`## 节点任务\n${node.title ?? node.id}`];

  if (node.prompt) {
    sections.push(`## 任务说明\n${interpolate(node.prompt, context)}`);
  }

  const directive = asRecord(rawInput.selfLoop);
  if (directive) {
    sections.push(`## 修正指令\n${formatSelfLoopDirective(directive)}`);
  }

  sections.push(`## 节点输入\n${formatInputs(input)}`);
  sections.push(
    `## 运行信息\n工作流：${context.workflowId} · 运行：${context.runId} · 第 ${context.iteration + 1} 轮`
  );

  return sections.join("\n\n");
}

function formatSelfLoopDirective(directive: Record<string, unknown>) {
  const lines: string[] = [];
  const action = stringValue(directive.actionLabel) || stringValue(directive.action);
  if (action) {
    lines.push(`- 修正动作：${action}`);
  }
  const target = numberValue(directive.targetScore);
  const previous = numberValue(directive.previousScore);
  if (target !== undefined || previous !== undefined) {
    lines.push(
      `- 目标分：${target ?? "—"} · 上一轮分：${previous === undefined ? "—" : previous.toFixed(3)}`
    );
  }
  const reason = stringValue(directive.reason);
  if (reason) {
    lines.push(`- 调度原因：${reason}`);
  }
  const issues = Array.isArray(directive.issues)
    ? directive.issues.filter((issue): issue is string => typeof issue === "string")
    : [];
  if (issues.length > 0) {
    lines.push("- 必须逐条回应的问题：");
    issues.slice(0, 8).forEach((issue, index) => {
      lines.push(`  ${index + 1}. ${issue}`);
    });
  }
  const retrievalQuery = stringValue(directive.retrievalQuery);
  if (retrievalQuery) {
    lines.push(`- 建议补充检索：${retrievalQuery}`);
  }
  const promptPatch = stringValue(directive.promptPatch);
  if (promptPatch) {
    lines.push(`- 已采纳的提示词补丁：${promptPatch}`);
  }
  const agentId = stringValue(directive.agentId);
  if (agentId) {
    lines.push(`- 本轮执行 Agent：${agentId}`);
  }
  const modelId = stringValue(directive.modelId);
  if (modelId) {
    const fromModel = stringValue(directive.previousModelId);
    lines.push(`- 本轮执行模型：${modelId}${fromModel ? `（上一轮 ${fromModel}）` : ""}`);
  }
  return lines.join("\n") || "- 依据验证问题定向修订，无需重写已达标部分。";
}

async function runLiveTool(
  node: ToolNode,
  input: Record<string, unknown>,
  context: ExecutionContext,
  options: LiveHandlerOptions
) {
  switch (node.tool) {
    case "knowledge.search":
      return searchKnowledgeTool(node, input, context, options);
    case "report.build":
      return buildReportTool(node, input, context);
    case "verify.rubric":
      return rubricTool(node, input);
    default: {
      const tool = options.getTool?.(node.tool);
      // 与 Agent 工具目录同一口径：内置工具（builtin://…）和 MCP 都能当工具节点跑。
      if (tool && (tool.type === "mcp" || tool.type === "builtin") && options.callMcpTool) {
        return executeMcpToolNode(node, input, tool, options.callMcpTool);
      }
      if (tool?.type === "http") {
        // 已知边界：HTTP 工具只做登记与展示，不执行任意 URL，避免把工作流变成 SSRF 入口。
        throw new Error(
          `HTTP 工具「${node.tool}」未启用执行：当前版本只执行内置工具与 MCP，请改用 MCP 连接调用外部系统。`
        );
      }
      return unsupportedTool(node, input);
    }
  }
}

/** 供 live 与 stub 两种模式共用：把 MCP 调用结果整理成节点产物，附带 server/tool/latency 证据。 */
export async function executeMcpToolNode(
  node: ToolNode,
  input: Record<string, unknown>,
  tool: ToolRecord,
  callMcpTool: (tool: ToolRecord, args: Record<string, unknown>) => Promise<McpCallResult>
) {
  try {
    const result = await callMcpTool(tool, input);
    const text = result.text.trim() || "（MCP 工具未返回文本内容）";
    return {
      mode: "live",
      tool: node.tool,
      status: result.isError ? "tool_error" : "ok",
      server: result.serverId,
      serverName: result.serverName,
      mcpTool: result.tool,
      latencyMs: result.latencyMs,
      isError: result.isError,
      summary: `${result.serverName} · ${result.tool}（${result.latencyMs} ms）`,
      output: text,
      content: result.content,
      structuredContent: result.structuredContent,
      args: input
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`MCP 工具「${node.tool}」调用失败：${message}`);
  }
}

async function searchKnowledgeTool(
  node: ToolNode,
  input: Record<string, unknown>,
  context: ExecutionContext,
  options: LiveHandlerOptions
) {
  if (!options.searchKnowledge) {
    throw new Error(`工具「${node.tool}」缺少知识库检索依赖，无法执行节点 ${node.id}。`);
  }
  return executeKnowledgeSearchNode(node, input, context, options.searchKnowledge);
}

/**
 * 知识库检索是确定性工具，不依赖模型。stub 与 live 都走这里，
 * 避免默认模式下返回假 citation，让「知识库集成」在零 token 时也可验证。
 */
export async function executeKnowledgeSearchNode(
  node: ToolNode | KnowledgeNode,
  input: Record<string, unknown>,
  context: ExecutionContext,
  searchKnowledge?: KnowledgeSearch
) {
  const toolName = node.kind === "knowledge" ? "knowledge.search" : node.tool;
  if (!searchKnowledge) {
    throw new Error(`工具「${toolName}」缺少知识库检索依赖，无法执行节点 ${node.id}。`);
  }

  const query = stringValue(input.query) || stringValue(context.scope.input.topic);
  if (!query) {
    throw new Error(`知识库检索节点 ${node.id} 缺少 query。`);
  }
  const knowledgeBaseIds = stringList(input.knowledgeBaseIds);
  const topK = clampInt(numberValue(input.topK) ?? 5, 1, 20);
  const citations = knowledgeBaseIds.length > 0
    ? await searchKnowledge({ query, knowledgeBaseIds, topK })
    : [];

  const mapped = citations.map((citation, index) => ({
    id: stringValue(citation.id) || `citation-${index + 1}`,
    title: stringValue(citation.documentName),
    documentName: stringValue(citation.documentName),
    knowledgeBaseName: stringValue(citation.knowledgeBaseName),
    snippet: stringValue(citation.snippet),
    source: stringValue(citation.source) || "local",
    score: numberValue(citation.score) ?? 0
  }));

  return {
    mode: "live",
    tool: toolName,
    summary:
      mapped.length > 0
        ? `检索「${query}」命中 ${mapped.length} 条引用`
        : `检索「${query}」未命中引用`,
    query,
    knowledgeBaseIds,
    citations: mapped,
    output:
      mapped.length > 0
        ? mapped
            .map(
              (citation, index) =>
                `[${index + 1}] ${citation.documentName || citation.title}（${citation.source}）：${citation.snippet}`
            )
            .join("\n")
        : "知识库未召回可引用片段，请基于学科常识作答并说明缺少资料支撑。",
    args: input
  };
}

function buildReportTool(
  node: ToolNode,
  input: Record<string, unknown>,
  context: ExecutionContext
) {
  const score = numberValue(input.score) ?? numberValue(input.initialScore);
  const iterations = clampInt(numberValue(input.iterations) ?? 0, 0, 100);
  // 报告正文由上游产物原样组装，避免再调一次模型把证据与结构改写掉。
  // 循环未执行时 ${revise.output} 不存在，回退到最近一次产出的最优产物。
  const observer = renderText(input.observer) || artifactText(context.scope.lastArtifact);
  const title = stringValue(input.title) || "任务报告";
  const bodyLabel = stringValue(input.bodyLabel) || "评审结论";
  const lines = [
    `# ${title}`,
    "",
    `- 工作流：${context.workflowId}`,
    `- 运行：${context.runId}`,
    `- 最终验证分：${score === undefined ? "未验证" : score.toFixed(3)}`,
    `- 自循环轮次：${iterations}`
  ];
  if (observer) {
    lines.push("", `## ${bodyLabel}`, observer);
  }

  return {
    mode: "live",
    tool: node.tool,
    summary: `${title}已生成${score === undefined ? "" : `，验证分 ${score.toFixed(3)}`}`,
    report: {
      workflowId: context.workflowId,
      runId: context.runId,
      score,
      iterations,
      observer
    },
    output: lines.join("\n"),
    args: input
  };
}

function rubricTool(node: ToolNode, input: Record<string, unknown>) {
  const rubric = stringList(input.rubric);
  const threshold = numberValue(input.threshold) ?? 0.8;
  const dimensions = rubric.length > 0 ? rubric : ["目标达成", "证据支撑", "可执行性"];

  return {
    mode: "live",
    tool: node.tool,
    summary: `按 ${dimensions.join("、")} 评分维度输出评审说明`,
    threshold,
    dimensions: dimensions.map((name) => ({ name })),
    output: [
      `评分维度：${dimensions.join("、")}`,
      `达标阈值：${threshold}`,
      "该工具只提供评分口径说明，实际分数由三层验证器（规则校验 → 交叉验证 → 基准比对）产出。"
    ].join("\n"),
    args: input
  };
}

function unsupportedTool(node: ToolNode, input: Record<string, unknown>) {
  return {
    mode: "live",
    tool: node.tool,
    status: "not_connected",
    summary: `工具「${node.tool}」尚未接入真实服务，返回占位结果`,
    output: `[未接入] ${node.title ?? node.id}：${node.tool} 需要在注册中心配置 endpoint 或 MCP 连接后才能调用。`,
    args: input
  };
}

function withoutSelfLoop(input: Record<string, unknown>) {
  if (!("selfLoop" in input)) {
    return input;
  }
  const { selfLoop: _selfLoop, ...rest } = input;
  return rest;
}

function formatInputs(input: Record<string, unknown>) {
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return "（无显式节点输入，按任务说明执行）";
  }
  return entries
    .map(([key, value]) => `- ${key}：${renderText(value, 4000)}`)
    .join("\n");
}

function renderText(value: unknown, maxChars = 6000) {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return truncate(value, maxChars);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return truncate(JSON.stringify(value, null, 2), maxChars);
  } catch {
    return String(value);
  }
}

// 节点产物对象里正文在 output，summary 只是预览；报告组装优先取全文。
function artifactText(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return renderText(record.output) || renderText(record.summary);
  }
  return renderText(value);
}

function interpolate(text: string, context: ExecutionContext) {
  return text.replace(REF_PATTERN, (_match, ref: string) =>
    renderValue(resolveRef(ref, context), 2000)
  );
}

function resolveRef(ref: string, context: ExecutionContext): unknown {
  const [head, ...rest] = ref.split(".");
  const readPath = (source: unknown, segments: string[]): unknown => {
    let current = source;
    for (const segment of segments) {
      if (current === null || typeof current !== "object") {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  };
  // 节点自己的输入变量排在前面：提示词里 ${template} 指的是「输入变量」表里那一行，
  // 取不到再走原来的节点输出 / 运行输入，避免同名遮蔽已有引用。
  if (head !== "loop" && context.locals && Object.prototype.hasOwnProperty.call(context.locals, head)) {
    const local = readPath(context.locals[head], rest);
    if (local !== undefined) {
      return local;
    }
  }
  const source: unknown =
    head === "input" ? context.scope.input : head === "loop" ? context.loop : context.scope.outputs.get(head);
  return readPath(source, rest);
}

function renderValue(value: unknown, maxChars: number) {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? truncate(value, maxChars) : renderText(value, maxChars);
}

function truncate(value: string, maxChars: number) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…（已截断）`;
}

function summarize(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return truncate(normalized, maxChars);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

/** 与执行器保持同一优先级：request / topic / question / text / query。 */
function requestOf(input: Record<string, unknown>): string {
  for (const key of ["request", "topic", "question", "text", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  const strings = Object.entries(input)
    .filter(([key, value]) => key !== "hint" && key !== "selfLoop" && typeof value === "string" && value.trim() !== "")
    .map(([, value]) => (value as string).trim());
  return strings.length > 0 ? strings.join("\n") : "（运行输入未提供可读的任务描述）";
}

/** 模型常把 JSON 包在代码块或解释文字里；这里取第一个可解析的对象。 */
function parseJsonObjectFromText(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  const direct = tryJsonObject(trimmed);
  if (direct) {
    return direct;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryJsonObject(trimmed.slice(start, end + 1));
  }
  return undefined;
}

function tryJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** 改写稿里出现原文与澄清回答之外的数字，说明模型可能把答案写进了 Prompt。 */
function findNewNumbers(source: string, rewritten: string): string[] {
  const allowed = new Set(source.match(/\d+(?:[.,]\d+)?%?/g) ?? []);
  const unexpected = (rewritten.match(/\d+(?:[.,]\d+)?%?/g) ?? []).filter(
    (token) => !allowed.has(token)
  );
  return [...new Set(unexpected)].slice(0, 8);
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function fraction(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : fallback;
}

function clampInt(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function budgetExceeded(context: ExecutionContext) {
  const budget = context.tokenBudget ?? 0;
  return budget > 0 && (context.tokensUsed ?? 0) >= budget;
}

function providerConfig(resolution: ModelResolution) {
  return {
    baseUrl: resolution.baseUrl,
    apiKey: resolution.apiKey,
    label: resolution.provider
  };
}

/**
 * 带可选真流式的补全调用：调试面板正在收听本次运行时，改用流式请求，
 * 每个 token 通过 runStreamBus 实时推给 SSE；没人听（生产运行、测试）保持
 * 原补全路径，行为与产物完全不变。
 *
 * 注意：流式分支不支持 topP（streamQwenChat 未暴露该参数）；llm 节点单独
 * 配过 topP 且面板在收听时，采样参数以流式请求的上游默认为准，正文不受影响。
 */
async function chatWithOptionalStream(args: {
  context: ExecutionContext;
  system?: string;
  prompt: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  enableThinking?: boolean;
  provider: { baseUrl: string; apiKey: string; label?: string };
  completeChat?: typeof completeQwenChat;
}): Promise<{ content: string; thinking: string }> {
  const { context, provider } = args;
  const messages = [{ role: "user" as const, content: args.prompt }];
  if (hasRunTokenListeners(context.runId) && context.stepPath) {
    let thinking = "";
    const streamed = await streamQwenChat({
      system: args.system,
      messages,
      model: args.model,
      provider,
      enableThinking: args.enableThinking === true,
      maxTokens: args.maxTokens,
      temperature: args.temperature,
      onThinkingDelta: (value) => {
        thinking += value;
      },
      onDelta: (delta) => {
        if (delta) {
          emitRunToken({ runId: context.runId, path: context.stepPath!, delta });
        }
      }
    });
    return { content: streamed.visibleAssistantContent, thinking };
  }
  let thinking = "";
  const content = await (args.completeChat ?? completeQwenChat)({
    system: args.system,
    messages,
    model: args.model,
    maxTokens: args.maxTokens,
    temperature: args.temperature,
    topP: args.topP,
    enableThinking: args.enableThinking === true,
    provider,
    onThinking: (value) => {
      thinking = value;
    }
  });
  return { content, thinking };
}

/** trace 同时记录请求值与解析值，避免“配置了模型却看不出是否生效”。 */
function modelTrace(resolution: ModelResolution) {
  return {
    model: resolution.model,
    requestedModel: resolution.requestedModel,
    resolvedModel: resolution.model,
    modelProfile: resolution.id,
    modelProvider: resolution.provider,
    modelSource: resolution.source,
    ...(resolution.fallback ? { modelFallback: resolution.fallback } : {}),
    ...(resolution.downgraded ? { modelDowngraded: resolution.downgraded } : {})
  };
}
