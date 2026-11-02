import type {
  AgentNode,
  AgentRecord,
  KnowledgeNode,
  LlmNode,
  McpCallResult,
  ToolNode,
  ToolRecord
} from "../types.js";
import { completeQwenChat, getPlatformLiveModel, isQwenConfigured } from "../../qwenOpenAiClient.js";
import type { ExecutionContext, ExecutorHandlers } from "./executor.js";

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
  maxTokens?: number;
  temperature?: number;
};

const REF_PATTERN = /\$\{([^}\s]+)\}/g;

/**
 * 真实 Agent 与内置工具的实现入口。默认关闭：只有显式设置 PLATFORM_LIVE_AGENTS=1
 * 且配置了 Qwen Key 时才创建 handler，否则执行器继续使用确定性 stub，避免误触发计费。
 */
export function isPlatformLiveEnabled() {
  return process.env.PLATFORM_LIVE_AGENTS === "1" && isQwenConfigured();
}

export function createPlatformLiveHandlers(options: LiveHandlerOptions): ExecutorHandlers {
  if (!isPlatformLiveEnabled()) {
    return {};
  }

  const maxTokens = positiveInt(options.maxTokens ?? process.env.PLATFORM_LIVE_MAX_TOKENS, 2048);
  const temperature = fraction(options.temperature ?? process.env.PLATFORM_LIVE_TEMPERATURE, 0.35);

  return {
    agent: (node, input, context) =>
      runLiveAgent(node, input, context, { ...options, maxTokens, temperature }),
    llm: (node, input, context) =>
      runLiveLlm(node, input, context, { maxTokens, temperature }),
    tool: (node, input, context) => runLiveTool(node, input, context, options)
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
  defaults: { maxTokens: number; temperature: number }
) {
  const input = withoutSelfLoop(rawInput);
  const model = node.model?.trim() || getPlatformLiveModel();
  const maxTokens = clampInt(node.maxTokens ?? defaults.maxTokens, 1, 32768);
  const temperature = node.temperature ?? defaults.temperature;
  let thinking = "";

  const content = await completeQwenChat({
    system:
      node.system?.trim() ||
      "你是 Agent 编排平台中的通用模型节点。只输出可交付结果，不要复述任务，不要输出占位内容。",
    messages: [
      {
        role: "user",
        content: [
          `## 节点任务\n${node.title ?? node.id}`,
          node.prompt ? `## 任务说明\n${interpolate(node.prompt, context)}` : "",
          `## 节点输入\n${formatInputs(input)}`
        ]
          .filter(Boolean)
          .join("\n\n")
      }
    ],
    model,
    maxTokens,
    temperature,
    enableThinking: node.thinking === true,
    onThinking: (value) => {
      thinking = value;
    }
  });

  return {
    mode: "live",
    kind: "llm",
    model,
    summary: summarize(content, 220),
    thinking: thinking || undefined,
    output: content,
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
    node.agentVersion === undefined
      ? options.getAgent(node.agent)
      : options.getAgentVersion?.(node.agent, node.agentVersion);
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
  const system = buildAgentSystemPrompt(agent);
  const prompt = buildAgentUserPrompt(node, input, rawInput, context);

  const content = await completeQwenChat({
    system,
    messages: [{ role: "user", content: prompt }],
    model: getPlatformLiveModel(),
    maxTokens: options.maxTokens ?? 2048,
    temperature: options.temperature ?? 0.35
  });

  return {
    mode: "live",
    agent: agent.id,
    agentName: agent.name,
    agentVersion: agent.version,
    role: agent.role,
    model: getPlatformLiveModel(),
    summary: summarize(content, 220),
    output: content,
    inputs: input,
    tools: agent.tools,
    memory: agent.memory
  };
}

/** 注册中心的工具集与记忆配置必须在运行期真正进入提示词，不能只做展示。 */
export function buildAgentSystemPrompt(agent: AgentRecord) {
  const capabilities = agent.capabilities
    .map((capability) => `${capability.tag}(${capability.weight})`)
    .join("、");
  const tools = agent.tools.length > 0 ? `可用工具：${agent.tools.join("、")}。需要证据时优先调用知识库检索工具。` : "";
  const memory =
    Object.keys(agent.memory).length > 0
      ? `记忆配置（跨轮次保留）：${JSON.stringify(agent.memory)}。`
      : "";
  const jsonOnly = /JSON/i.test(agent.prompt);

  return [
    `你是「${agent.name}」，在 Agent 编排平台的工作流节点中承担「${agent.role}」职责。`,
    agent.prompt,
    capabilities ? `能力标签：${capabilities}。` : "",
    tools,
    memory,
    jsonOnly
      ? "输出要求：只输出合法 JSON，不要使用 Markdown 代码块，不要添加解释性前后缀。"
      : "输出要求：直接给出可交付的成稿，用 Markdown 组织；不要复述任务，不要输出 TODO、待补充、示例占位等占位内容；引用知识库证据时使用 [1][2] 编号，并在结尾列出“引用来源”。"
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
  const agentId = stringValue(directive.agentId);
  if (agentId) {
    lines.push(`- 本轮执行 Agent：${agentId}`);
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
      if (tool?.type === "mcp" && options.callMcpTool) {
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
  const title = stringValue(input.title) || "课堂训练报告";
  const bodyLabel = stringValue(input.bodyLabel) || "观察员结论";
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
  let current: unknown =
    head === "input"
      ? context.scope.input
      : head === "loop"
        ? context.loop
        : context.scope.outputs.get(head);
  for (const segment of rest) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
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
