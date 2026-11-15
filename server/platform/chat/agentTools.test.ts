import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompleteToolChatOptions,
  ToolChatResult
} from "../../qwenOpenAiClient.js";
import type { McpCallResult, ToolRecord } from "../types.js";
import {
  buildChatToolCatalog,
  needsExternalEvidence,
  parseToolArguments,
  runChatToolLoop,
  type ChatToolProgress
} from "./agentTools.js";
import { buildDelegationCatalog } from "./agentDelegation.js";

function toolRecord(overrides: Partial<ToolRecord> = {}): ToolRecord {
  return {
    id: "mcp.library.query",
    name: "文献查询",
    type: "mcp",
    schema: {
      type: "object",
      properties: { keyword: { type: "string" } },
      required: ["keyword"]
    },
    endpoint: "mcp://library/query",
    description: "按关键词检索文献并返回题录",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "custom",
    ...overrides
  };
}

function mcpResult(text: string, overrides: Partial<McpCallResult> = {}): McpCallResult {
  return {
    serverId: "library",
    serverName: "文献库",
    tool: "query",
    latencyMs: 12,
    isError: false,
    content: [{ type: "text", text }],
    text,
    ...overrides
  };
}

/** 按脚本逐个返回，同时把每次真正发给模型的参数记下来，方便断言。 */
function scriptedComplete(script: ToolChatResult[]) {
  const calls: CompleteToolChatOptions[] = [];
  const fn = async (options: CompleteToolChatOptions): Promise<ToolChatResult> => {
    calls.push(options);
    return script.shift() ?? { content: "脚本已用尽", toolCalls: [] };
  };
  return { fn, calls };
}

test("工具目录收已启用的 MCP 与插件工具，函数名安全化并去重", () => {
  const tools = new Map<string, ToolRecord>([
    ["mcp.library.query", toolRecord()],
    ["mcp.news.query", toolRecord({ id: "mcp.news.query", name: "新闻查询", endpoint: "mcp://news/query" })],
    ["mcp.off", toolRecord({ id: "mcp.off.check", enabled: false })],
    ["knowledge.search", toolRecord({ id: "knowledge.search", type: "builtin" })]
  ]);

  const catalog = buildChatToolCatalog(
    ["mcp.library.query", "mcp.news.query", "mcp.off.check", "knowledge.search", "mcp.missing.x"],
    (id) => tools.get(id)
  );

  // 插件（builtin）现在与 MCP 一样可执行：停用的 mcp.off 仍被排除，knowledge.search 收进来。
  assert.equal(catalog.length, 3);
  assert.deepEqual(
    catalog.map((item) => item.functionName),
    ["query", "query_2", "search"]
  );
  assert.match(catalog[0].definition.function.description ?? "", /文献查询：按关键词检索文献/);
  assert.equal(catalog[0].definition.function.parameters.type, "object");
});

test("模型先要工具后用结果作答，参数与进度都进得去", async () => {
  const catalog = buildChatToolCatalog(["mcp.library.query"], () => toolRecord());
  const { fn, calls } = scriptedComplete([
    {
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "query", arguments: JSON.stringify({ keyword: "跨学科教学" }) }
        }
      ]
    },
    { content: "查到 3 篇相关文献。", toolCalls: [] }
  ]);
  const progress: ChatToolProgress[] = [];
  const asked: Array<Record<string, unknown>> = [];

  const result = await runChatToolLoop({
    system: "你是文献助手。",
    messages: [{ role: "user", content: "帮我查跨学科教学的文献" }],
    catalog,
    complete: fn,
    callTool: async (_tool, args) => {
      asked.push(args);
      return mcpResult("1. 跨学科教学研究综述");
    },
    onProgress: (item) => progress.push(item)
  });

  assert.equal(result.content, "查到 3 篇相关文献。");
  assert.equal(result.rounds, 2);
  assert.deepEqual(asked, [{ keyword: "跨学科教学" }]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, "文献查询");
  assert.equal(result.calls[0].ok, true);
  assert.deepEqual(
    progress.map((item) => item.stage),
    ["running", "done"]
  );

  // 第二轮必须把工具结果真的带给模型，否则模型只能瞎猜。
  const secondRound = calls[1].messages;
  const toolMessage = secondRound[secondRound.length - 1];
  assert.equal(toolMessage.role, "tool");
  assert.match(toolMessage.content, /跨学科教学研究综述/);
});

test("工具执行失败时把错误回填给模型，不让整轮对话挂掉", async () => {
  const catalog = buildChatToolCatalog(["mcp.library.query"], () => toolRecord());
  const progress: ChatToolProgress[] = [];
  const { fn, calls } = scriptedComplete([
    {
      content: "",
      toolCalls: [
        { id: "call-1", type: "function", function: { name: "query", arguments: "{}" } }
      ]
    },
    { content: "文献库暂时连不上，我先把已知信息列给你。", toolCalls: [] }
  ]);

  const result = await runChatToolLoop({
    system: "你是文献助手。",
    messages: [{ role: "user", content: "查文献" }],
    catalog,
    complete: fn,
    callTool: async () => {
      throw new Error("MCP 服务器没有响应");
    },
    onProgress: (item) => progress.push(item)
  });

  assert.equal(result.calls[0].ok, false);
  assert.equal(progress.some((item) => item.ok === false), true);
  const toolMessage = calls[1].messages[calls[1].messages.length - 1];
  assert.match(toolMessage.content, /MCP 服务器没有响应/);
  assert.match(result.content, /文献库暂时连不上/);
});

test("参数不是合法 JSON 时不执行工具，把错误交给模型改", async () => {
  const catalog = buildChatToolCatalog(["mcp.library.query"], () => toolRecord());
  let called = 0;
  const { fn, calls } = scriptedComplete([
    {
      content: "",
      toolCalls: [
        { id: "call-1", type: "function", function: { name: "query", arguments: "{keyword:文学}" } }
      ]
    },
    { content: "我换个写法再查。", toolCalls: [] }
  ]);

  const result = await runChatToolLoop({
    system: "你是文献助手。",
    messages: [{ role: "user", content: "查文献" }],
    catalog,
    complete: fn,
    callTool: async () => {
      called += 1;
      return mcpResult("不该走到这里");
    }
  });

  assert.equal(called, 0);
  assert.equal(result.calls[0].ok, false);
  const toolMessage = calls[1].messages[calls[1].messages.length - 1];
  assert.match(toolMessage.content, /合法 JSON/);
});

test("轮次打满仍在要工具时，关掉工具再收一次结论", async () => {
  const catalog = buildChatToolCatalog(["mcp.library.query"], () => toolRecord());
  const call = (id: string) => ({
    content: "",
    toolCalls: [
      { id, type: "function" as const, function: { name: "query", arguments: "{\"keyword\":\"x\"}" } }
    ]
  });
  const { fn, calls } = scriptedComplete([
    call("call-1"),
    call("call-2"),
    { content: "按现有资料只能给出这些。", toolCalls: [] }
  ]);

  const result = await runChatToolLoop({
    system: "你是文献助手。",
    messages: [{ role: "user", content: "查文献" }],
    catalog,
    complete: fn,
    maxRounds: 2,
    callTool: async () => mcpResult("片段")
  });

  assert.equal(result.content, "按现有资料只能给出这些。");
  assert.equal(result.rounds, 2);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].tools, []);
});

test("参数解析对空串与数组分别给对结果", () => {
  assert.deepEqual(parseToolArguments("  "), { ok: true, value: {} });
  assert.equal(parseToolArguments("[1,2]").ok, false);
  assert.deepEqual(parseToolArguments('{"a":1}'), { ok: true, value: { a: 1 } });
});

/** 模拟真实挂载的「文献检索（OpenAlex）」插件，参数字段叫 search。 */
function pluginCatalog() {
  return buildChatToolCatalog(["plugin.literature"], () =>
    toolRecord({
      id: "plugin.literature",
      name: "文献检索（OpenAlex）",
      type: "builtin",
      endpoint: "plugin://pl-1",
      description: "按关键词检索 OpenAlex 学术文献，返回论文列表",
      schema: {
        type: "object",
        properties: { search: { type: "string" }, per_page: { type: "integer" } },
        required: ["search"]
      }
    })
  );
}

test("识别需要外部资料的问题，闲聊不被误判", () => {
  assert.equal(needsExternalEvidence("帮我查询病虫害识别相关文献"), true);
  assert.equal(needsExternalEvidence("这个方向有哪些研究现状？"), true);
  assert.equal(needsExternalEvidence("你好"), false);
  assert.equal(needsExternalEvidence("谢谢，明白了"), false);
});

test("首轮不肯调工具时用 required 重试，凭记忆编的答案不进上下文", async () => {
  const catalog = pluginCatalog();
  const { fn, calls } = scriptedComplete([
    { content: "《UAV Survey》Remote Sensing 2023，DOI 10.3390/xxx", toolCalls: [] },
    {
      content: "",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "literature", arguments: JSON.stringify({ search: "病虫害识别" }) }
        }
      ]
    },
    { content: "检索到 2 篇真实文献。", toolCalls: [] }
  ]);
  const asked: Array<Record<string, unknown>> = [];

  const result = await runChatToolLoop({
    system: "你是文献助手。",
    messages: [{ role: "user", content: "帮我查询病虫害识别相关文献" }],
    catalog,
    complete: fn,
    callTool: async (_tool, args) => {
      asked.push(args);
      return mcpResult("1. UAV Pest Detection · OpenAlex");
    }
  });

  assert.equal(calls[1].toolChoice, "required");
  assert.deepEqual(asked, [{ search: "病虫害识别" }]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.forcedToolCall, false);
  assert.match(result.content, /真实文献/);
  // 首轮那段编造内容不能作为上下文依据传给模型。
  assert.equal(
    calls[2].messages.some(
      (message) => message.role === "assistant" && message.content.includes("Remote Sensing")
    ),
    false
  );
  assert.match(calls[2].messages[calls[2].messages.length - 1].content, /OpenAlex/);
});

test("模型完全不支持 function calling 时，后端也兜底真查一次", async () => {
  const catalog = pluginCatalog();
  const calls: CompleteToolChatOptions[] = [];
  const progress: ChatToolProgress[] = [];
  let step = 0;
  const fn = async (options: CompleteToolChatOptions): Promise<ToolChatResult> => {
    calls.push(options);
    step += 1;
    if (step === 1) return { content: "《编的综述》Nature 2024", toolCalls: [] };
    if (step === 2) throw new Error("tool_choice required is not supported");
    if (step === 3) return { content: "我直接回答。", toolCalls: [] };
    return { content: "根据检索结果，找到 2 篇真实文献。", toolCalls: [] };
  };
  const asked: Array<Record<string, unknown>> = [];

  const result = await runChatToolLoop({
    system: "你是文献助手。",
    messages: [{ role: "user", content: "查询相关文献" }],
    catalog,
    complete: fn,
    callTool: async (_tool, args) => {
      asked.push(args);
      return mcpResult("1. Real Paper · OpenAlex");
    },
    onProgress: (item) => progress.push(item)
  });

  assert.equal(calls[1].toolChoice, "required");
  assert.match(String(calls[2].system ?? ""), /本轮强制要求/);
  assert.equal(result.forcedToolCall, true);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].search, "查询相关文献");
  assert.match(result.content, /检索结果/);
  assert.deepEqual(
    progress.map((item) => item.stage),
    ["running", "done"]
  );
});

test("模型完全不配合时，兜底优先转交给对口的专项智能体", async () => {
  const catalog = [
    ...pluginCatalog(),
    ...buildDelegationCatalog([
      {
        id: "ytz-literature",
        name: "文献阅读Agent",
        version: 4,
        role: "文献阅读",
        prompt: "你是文献阅读导师。",
        tools: [],
        model: "platform-default",
        capabilities: [],
        memory: {},
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        description: "检索、精读、综述"
      }
    ])
  ];
  const calls: CompleteToolChatOptions[] = [];
  let step = 0;
  const fn = async (options: CompleteToolChatOptions): Promise<ToolChatResult> => {
    calls.push(options);
    step += 1;
    if (step === 1) return { content: "《编的文献》Nature 2024", toolCalls: [] };
    if (step === 2) throw new Error("required not supported");
    return { content: "我直接回答。", toolCalls: [] };
  };
  const asked: Array<{ tool: string; args: Record<string, unknown> }> = [];

  const result = await runChatToolLoop({
    system: "你是科研导师。",
    messages: [{ role: "user", content: "帮我查询相关文献" }],
    catalog,
    complete: fn,
    callTool: async (tool, args) => {
      asked.push({ tool: tool.id, args });
      return mcpResult("1. Real Paper · OpenAlex");
    }
  });

  assert.equal(result.forcedToolCall, true);
  // 兜底选的是「转交给文献阅读Agent」，不是导师自己去查插件。
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tool, "agent://ytz-literature");
  assert.equal(asked[0].args.question, "帮我查询相关文献");
  assert.equal(result.calls[0].toolId, "agent://ytz-literature");
});

test("闲聊不会被硬塞一次检索", async () => {
  const catalog = pluginCatalog();
  const { fn, calls } = scriptedComplete([{ content: "你好，有什么可以帮你？", toolCalls: [] }]);
  let executed = 0;

  const result = await runChatToolLoop({
    messages: [{ role: "user", content: "你好" }],
    catalog,
    complete: fn,
    callTool: async () => {
      executed += 1;
      return mcpResult("不该被调用");
    }
  });

  assert.equal(executed, 0);
  assert.equal(calls.length, 1);
  assert.equal(result.forcedToolCall, false);
  assert.equal(result.content, "你好，有什么可以帮你？");
});

test("预设路由直接执行转交，转交成功后不再叫主智能体改写", async () => {
  const catalog = buildDelegationCatalog([
    {
      id: "ytz-literature",
      name: "文献阅读Agent",
      version: 5,
      role: "文献阅读",
      prompt: "你是文献阅读导师。",
      tools: [],
      model: "platform-default",
      capabilities: [],
      memory: {},
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      description: "检索、精读、综述"
    }
  ]);
  const { fn, calls } = scriptedComplete([]);

  const result = await runChatToolLoop({
    system: "你是科研导师。",
    messages: [{ role: "user", content: "查询机械设计相关文献" }],
    catalog,
    presetToolCall: {
      id: "route-delegate_ytz-literature",
      type: "function",
      function: {
        name: "delegate_ytz-literature",
        arguments: JSON.stringify({ question: "查询机械设计相关文献" })
      }
    },
    stopAfterDelegation: true,
    complete: fn,
    callTool: async () =>
      mcpResult("（给模型看的版本）", {
        delegatedAnswer: {
          agentId: "ytz-literature",
          agentName: "文献阅读Agent",
          answer: "先建关键词金字塔，再按综述种子法往下追。"
        }
      })
  });

  // 路由命中就不该再问模型一次，省掉一轮往返和它那段「你大几」。
  assert.equal(calls.length, 0);
  assert.equal(result.content, "");
  assert.equal(result.calls[0].toolId, "agent://ytz-literature");
  assert.equal(result.delegatedAnswer?.agentName, "文献阅读Agent");
  assert.match(result.delegatedAnswer?.answer ?? "", /关键词金字塔/);
});
