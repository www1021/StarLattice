import assert from "node:assert/strict";
import test from "node:test";
import type { CompleteToolChatOptions, ToolChatResult } from "../../qwenOpenAiClient.js";
import type { AgentRecord, McpCallResult, ToolRecord } from "../types.js";
import {
  buildChatToolsWithDelegation,
  buildDelegationCatalog,
  delegationTargetId,
  isDelegationToolId,
  runAgentDelegation
} from "./agentDelegation.js";

function agentRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "ytz-guide",
    name: "研途引航",
    version: 4,
    role: "科研导师",
    prompt: "你是科研导师。",
    tools: [],
    model: "platform-default",
    capabilities: [],
    memory: {},
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    description: "全流程科研引导",
    ...overrides
  };
}

function toolRecord(overrides: Partial<ToolRecord> = {}): ToolRecord {
  return {
    id: "plugin.pl-1",
    name: "文献检索（OpenAlex）",
    type: "builtin",
    schema: {
      type: "object",
      properties: { search: { type: "string" } },
      required: ["search"]
    },
    endpoint: "plugin://pl-1",
    description: "按关键词检索学术文献",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: "builtin",
    ...overrides
  };
}

function mcpResult(text: string, overrides: Partial<McpCallResult> = {}): McpCallResult {
  return {
    serverId: "openalex",
    serverName: "OpenAlex",
    tool: "search",
    latencyMs: 8,
    isError: false,
    content: [{ type: "text", text }],
    text,
    ...overrides
  };
}

function scriptedComplete(script: ToolChatResult[]) {
  const calls: CompleteToolChatOptions[] = [];
  const fn = async (options: CompleteToolChatOptions): Promise<ToolChatResult> => {
    calls.push(options);
    return script.shift() ?? { content: "脚本已用尽", toolCalls: [] };
  };
  return { fn, calls };
}

function agentsOf(list: AgentRecord[]) {
  return new Map(list.map((item) => [item.id, item]));
}

test("转交工具按 agent:// 前缀展开，停用的目标和自己被排除", () => {
  const literature = agentRecord({
    id: "ytz-literature",
    name: "文献阅读Agent",
    role: "文献阅读",
    description: "检索、精读、综述"
  });
  const disabled = agentRecord({ id: "ytz-growth", name: "科研成长Agent", enabled: false });
  const agents = agentsOf([literature, disabled]);

  const catalog = buildChatToolsWithDelegation({
    agent: agentRecord({
      tools: ["agent://ytz-literature", "agent://ytz-growth", "agent://ytz-guide", "plugin.pl-1"]
    }),
    getAgent: (id) => agents.get(id),
    getTool: (id) => (id === "plugin.pl-1" ? toolRecord() : undefined)
  });

  assert.deepEqual(
    catalog.map((item) => item.toolId),
    ["plugin.pl-1", "agent://ytz-literature"]
  );
  const delegation = catalog.find((item) => item.kind === "delegation");
  assert.ok(delegation);
  assert.equal(delegation.functionName, "delegate_ytz-literature");
  assert.equal(delegation.tool.name, "转交给文献阅读Agent");
  assert.match(delegation.definition.function.description ?? "", /文献阅读/);
  assert.equal(isDelegationToolId(delegation.toolId), true);
  assert.equal(delegationTargetId(delegation.toolId), "ytz-literature");
});

test("转交工具只带 question 一个参数，模型不需要猜 schema", () => {
  const [descriptor] = buildDelegationCatalog([
    agentRecord({ id: "ytz-literature", name: "文献阅读Agent" })
  ]);
  const parameters = descriptor.definition.function.parameters as {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
  assert.deepEqual(Object.keys(parameters.properties ?? {}), ["question"]);
  assert.deepEqual(parameters.required, ["question"]);
});

test("转交真的会用目标智能体跑一次，并把结果回灌给主智能体", async () => {
  const literature = agentRecord({
    id: "ytz-literature",
    name: "文献阅读Agent",
    role: "文献阅读",
    prompt: "你是文献阅读导师，先检索再回答。",
    tools: ["plugin.pl-1"]
  });
  const tools = new Map([["plugin.pl-1", toolRecord()]]);
  const { fn, calls } = scriptedComplete([
    { content: "", toolCalls: [] },
    {
      content: "",
      toolCalls: [
        {
          id: "child-call-1",
          type: "function",
          function: { name: "pl-1", arguments: JSON.stringify({ search: "无人机病虫害识别" }) }
        }
      ]
    },
    { content: "找到 3 篇：UAV Pest Detection（2023）等。", toolCalls: [] }
  ]);

  const result = await runAgentDelegation({
    host: agentRecord(),
    targetId: "ytz-literature",
    question: "帮我查无人机病虫害识别的文献",
    getAgent: (id) => (id === literature.id ? literature : undefined),
    getTool: (id) => tools.get(id),
    callTool: async () => mcpResult("1. UAV Pest Detection · 2023"),
    resolveModel: () => ({}),
    complete: fn
  });

  assert.equal(result.isError, false);
  assert.equal(result.tool, "文献阅读Agent");
  assert.match(result.text, /UAV Pest Detection/);
  // 子智能体拿到的是自己的提示词，不是主智能体的。
  assert.match(String(calls[0].system ?? ""), /文献阅读导师/);
  assert.match(calls[0].messages[0].content, /无人机病虫害识别/);
  // 子智能体有检索工具时，用户问文献会被要求先查一次。
  assert.equal(calls[1].toolChoice, "required");
  assert.match(result.text, /文献检索（OpenAlex）/);
});

test("子智能体会过滤掉 agent://，转交只有一层不会互相踢皮球", async () => {
  const loop = agentRecord({
    id: "ytz-literature",
    name: "文献阅读Agent",
    tools: ["agent://ytz-guide", "plugin.pl-1"]
  });
  const tools = new Map([["plugin.pl-1", toolRecord()]]);
  const { fn, calls } = scriptedComplete([{ content: "这边直接回答。", toolCalls: [] }]);

  await runAgentDelegation({
    host: agentRecord(),
    targetId: "ytz-literature",
    question: "随便聊聊",
    getAgent: (id) => (id === loop.id ? loop : agentRecord()),
    getTool: (id) => tools.get(id),
    callTool: async () => mcpResult("不该被调用"),
    resolveModel: () => ({}),
    complete: fn
  });

  const names = (calls[0].tools ?? []).map((item) => item.function.name);
  assert.deepEqual(names, ["pl-1"]);
  assert.equal(
    (calls[0].tools ?? []).some((item) => item.function.name.startsWith("delegate_")),
    false
  );
});

test("目标不存在、已停用、转给自己或没给问题时都返回失败而不是硬跑", async () => {
  const disabled = agentRecord({ id: "ytz-growth", name: "科研成长Agent", enabled: false });
  const { fn } = scriptedComplete([]);
  const base = {
    host: agentRecord(),
    getAgent: (id: string) => (id === disabled.id ? disabled : undefined),
    getTool: () => undefined,
    callTool: async () => mcpResult("不该被调用"),
    resolveModel: () => ({}),
    complete: fn
  };

  const missing = await runAgentDelegation({ ...base, targetId: "ytz-missing", question: "查文献" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /不存在/);

  const off = await runAgentDelegation({ ...base, targetId: "ytz-growth", question: "查文献" });
  assert.equal(off.isError, true);
  assert.match(off.text, /已停用/);

  const selfHost = agentRecord();
  const self = await runAgentDelegation({
    ...base,
    host: selfHost,
    getAgent: (id) => (id === selfHost.id ? selfHost : undefined),
    targetId: selfHost.id,
    question: "查文献"
  });
  assert.equal(self.isError, true);
  assert.match(self.text, /不能把问题转交给自己/);

  const empty = await runAgentDelegation({ ...base, targetId: "ytz-missing", question: "  " });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /没有给出问题/);
});

test("子智能体抛错时把原因带回去，主智能体不会以为查过了", async () => {
  const literature = agentRecord({ id: "ytz-literature", name: "文献阅读Agent" });
  const result = await runAgentDelegation({
    host: agentRecord(),
    targetId: "ytz-literature",
    question: "查文献",
    getAgent: (id) => (id === literature.id ? literature : undefined),
    getTool: () => undefined,
    callTool: async () => mcpResult("x"),
    resolveModel: () => ({}),
    complete: async () => {
      throw new Error("上游模型 429");
    }
  });

  assert.equal(result.isError, true);
  assert.match(result.text, /上游模型 429/);
  assert.match(result.text, /不要.*编造/);
});
