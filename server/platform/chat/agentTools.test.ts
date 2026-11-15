import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompleteToolChatOptions,
  ToolChatResult
} from "../../qwenOpenAiClient.js";
import type { McpCallResult, ToolRecord } from "../types.js";
import {
  buildChatToolCatalog,
  parseToolArguments,
  runChatToolLoop,
  type ChatToolProgress
} from "./agentTools.js";

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
