import assert from "node:assert/strict";
import test from "node:test";
import type { CompleteToolChatOptions, ToolChatResult } from "../../qwenOpenAiClient.js";
import { BUILTIN_AGENTS } from "../registry/agents.js";
import type { AgentRecord, AgentNode, ClarifyNode, IntentAnalysis, ToolRecord } from "../types.js";
import { buildAgentSystemPrompt, createPlatformLiveHandlers } from "./liveHandlers.js";
import { configureTestModel, configureTestModels } from "../../testing/modelFixtures.js";

test("injects registry tools and memory into the agent system prompt", () => {
  const agent = agentRecord("lesson-plan-agent");

  const prompt = buildAgentSystemPrompt(agent);
  assert.match(prompt, /knowledge\.search/);
  assert.match(prompt, /记忆配置/);
  assert.match(prompt, /lessonPlanDraft/);
});

test("tool-calling agent executes model-chosen knowledge and MCP tools before answering", async () => {
  const previousLive = process.env.PLATFORM_LIVE_AGENTS;
  process.env.PLATFORM_LIVE_AGENTS = "1";
  const restoreModels = configureTestModel();

  try {
    const searches: Array<{ query: string; knowledgeBaseIds: string[]; topK?: number }> = [];
    const mcpCalls: Array<{ toolId: string; args: Record<string, unknown> }> = [];
    const promptsSeen: CompleteToolChatOptions[] = [];
    const toolNames = ["knowledge_search", "metric_calc", "profile"];

    const completeToolChat = async (options: CompleteToolChatOptions): Promise<ToolChatResult> => {
      promptsSeen.push(options);
      assert.deepEqual(
        options.tools?.map((tool) => tool.function.name).sort(),
        toolNames,
        "只应暴露可执行的已声明工具"      );

      if (promptsSeen.length === 1) {
        return {
          content: "",
          toolCalls: [
            toolCall("call-1", "knowledge_search", { query: "退款 净销售额 毛利额 口径" }),
            toolCall("call-2", "profile", {}),
            toolCall("call-3", "metric_calc", { revenueBasis: "gross" }),
            toolCall("call-4", "metric_calc", { revenueBasis: "net" })
          ]
        };
      }

      const toolMessages = options.messages.filter((message) => message.role === "tool");
      assert.equal(toolMessages.length, 4, "每条工具结果都必须回填给模型");
      assert.match(toolMessages[0].content, /退款必须从销售额中扣除/);
      assert.match(toolMessages[1].content, /"orderCount":24/);

      return {
        content: JSON.stringify({
          rootCause: "报告使用毛销售额口径，未扣除退款。",
          evidence: ["知识库规则要求退款必须扣除", "gross 与 net 的毛利额存在差异"],
          action: "rewrite_agent",
          revenueBasis: "net",
          retrievalQuery: "退款 净销售额 毛利额 口径",
          promptPatch: "当数据包含退款字段时，revenueBasis 必须选择 net，并按净销售额重新计算毛利额与毛利率。",
          confidence: 0.93
        }),
        toolCalls: []
      };
    };

    const handlers = createPlatformLiveHandlers({
      getAgent: () => agentRecord("business-diagnostician"),
      getTool: (id) => mcpTool(id),
      callMcpTool: async (tool, args) => {
        mcpCalls.push({ toolId: tool.id, args });
        return {
          serverId: "data-analysis",
          serverName: "经营数据分析 MCP",
          tool: tool.id.split(".").pop() ?? tool.id,
          latencyMs: 3,
          isError: false,
          content: [],
          text: tool.id.endsWith("profile")
            ? JSON.stringify({ orderCount: 24, refunds: 3700, netSales: 113400 })
            : JSON.stringify({ revenueBasis: args.revenueBasis, grossProfit: args.revenueBasis === "net" ? 42290 : 45990 })
        };
      },
      searchKnowledge: async (options) => {
        searches.push(options);
        return [
          {
            documentName: "经营口径规则",
            knowledgeBaseName: "演示资料包",
            snippet: "退款必须从销售额中扣除，毛利额 = 净销售额 − 销货成本。",
            source: "kb-business-metrics",
            score: 0.91
          }
        ];
      },
      completeToolChat
    });

    const node: AgentNode = {
      id: "diagnose",
      kind: "agent",
      title: "诊断根因与修正补丁",
      agent: "business-diagnostician",
      toolCalling: true,
      outputFormat: "json"
    };
    const agent = handlers.agent;
    assert.ok(agent);

    const output = (await agent(node, { question: "为什么毛利下滑？", source: "data/demo/sales.csv" }, {
      runId: "run-test",
      workflowId: "business-analysis-v1",
      iteration: 1,
      knowledgeBaseIds: ["business-metrics-demo"],
      scope: {
        input: {},
        outputs: new Map(),
        evidence: [],
        verifyRounds: 0
      }
    })) as Record<string, unknown>;

    assert.equal(searches.length, 1);
    assert.deepEqual(searches[0].knowledgeBaseIds, ["business-metrics-demo"]);
    assert.equal(mcpCalls.length, 3, "profile + gross + net 共三次 MCP 调用");
    assert.equal(mcpCalls[0].args.source, "data/demo/sales.csv", "平台应自动补齐数据源");
    assert.equal(mcpCalls[1].args.revenueBasis, "gross");
    assert.equal(mcpCalls[2].args.revenueBasis, "net");

    assert.equal(output.toolCalling, "enabled");
    assert.equal(output.toolRounds, 2);
    assert.equal((output.toolCalls as unknown[]).length, 4);
    assert.equal((output.citations as unknown[]).length, 1);
    assert.equal(JSON.parse(output.output as string).revenueBasis, "net");
    assert.match(String(output.summary), /工具调用 4 次/);
  } finally {
    restore("PLATFORM_LIVE_AGENTS", previousLive);
    restoreModels();
  }
});

test("routes fast and reasoning agents to different upstream models", async () => {
  const restoreEnv = withEnv({
    PLATFORM_LIVE_AGENTS: "1",
    PLATFORM_LIVE_MODEL: "default-model",
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_MODEL_REASONING: "strong-model"
  });
  const restoreModels = configureTestModel();
  try {
    const requested: string[] = [];
    const agents: Record<string, AgentRecord> = {
      "fast-agent": routedAgent("fast-agent", "fast"),
      "strong-agent": routedAgent("strong-agent", "reasoning")
    };
    const handlers = createPlatformLiveHandlers({
      getAgent: (id) => agents[id],
      getTool: () => undefined,
      completeChat: async (options) => {
        requested.push(options.model ?? "");
        return "完成";
      }
    });
    const agent = handlers.agent;
    assert.ok(agent);

    const fastNode = agentNode("fast-agent");
    const strongNode = agentNode("strong-agent");
    const fastOutput = (await agent(fastNode, {}, context())) as Record<string, unknown>;
    const strongOutput = (await agent(strongNode, {}, context())) as Record<string, unknown>;

    assert.deepEqual(requested, ["fast-model", "strong-model"]);
    assert.equal(fastOutput.resolvedModel, "fast-model");
    assert.equal(fastOutput.modelProfile, "fast");
    assert.equal(strongOutput.resolvedModel, "strong-model");
    assert.equal(strongOutput.modelProfile, "reasoning");
    assert.equal(strongOutput.modelSource, "agent");
  } finally {
    restoreEnv();
    restoreModels();
  }
});

test("node model overrides the agent model and is recorded in the step output", async () => {
  const restoreEnv = withEnv({
    PLATFORM_LIVE_AGENTS: "1",
    PLATFORM_LIVE_MODEL: "default-model",
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_MODEL_REASONING: "strong-model"
  });
  const restoreModels = configureTestModel();
  try {
    const requested: string[] = [];
    const handlers = createPlatformLiveHandlers({
      getAgent: () => routedAgent("fast-agent", "fast"),
      getTool: () => undefined,
      completeChat: async (options) => {
        requested.push(options.model ?? "");
        return "完成";
      }
    });
    const agent = handlers.agent;
    assert.ok(agent);

    const output = (await agent(agentNode("fast-agent", { model: "reasoning" }), {}, context())) as Record<
      string,
      unknown
    >;

    assert.deepEqual(requested, ["strong-model"]);
    assert.equal(output.requestedModel, "reasoning");
    assert.equal(output.resolvedModel, "strong-model");
    assert.equal(output.modelProfile, "reasoning");
    assert.equal(output.modelSource, "node");
  } finally {
    restoreEnv();
    restoreModels();
  }
});

test("marks an unknown agent model as fallback instead of silently replacing it", async () => {
  const restoreEnv = withEnv({
    PLATFORM_LIVE_AGENTS: "1",
    PLATFORM_LIVE_MODEL: "default-model"
  });
  const restoreModels = configureTestModel();
  try {
    const requested: string[] = [];
    const handlers = createPlatformLiveHandlers({
      getAgent: () => routedAgent("raw-agent", "vendor-model-x"),
      getTool: () => undefined,
      completeChat: async (options) => {
        requested.push(options.model ?? "");
        return "完成";
      }
    });
    const agent = handlers.agent;
    assert.ok(agent);

    const output = (await agent(agentNode("raw-agent"), {}, context())) as Record<string, unknown>;

    assert.deepEqual(requested, ["vendor-model-x"]);
    assert.equal(output.resolvedModel, "vendor-model-x");
    assert.equal(output.modelSource, "fallback");
    assert.equal((output.modelFallback as { requestedModel: string }).requestedModel, "vendor-model-x");
  } finally {
    restoreEnv();
    restoreModels();
  }
});

test("downgrades a high-cost model once the run token budget is exhausted", async () => {
  const restoreEnv = withEnv({
    PLATFORM_LIVE_AGENTS: "1"
  });
  const restoreModels = configureTestModels(
    [
      { id: "strong-agent-model", model: "strong-model", costTier: "high" },
      { id: "cheap-model", model: "cheap-model", costTier: "low" }
    ],
    { defaultId: "strong-agent-model" }
  );
  try {
    const requested: string[] = [];
    const handlers = createPlatformLiveHandlers({
      getAgent: () => routedAgent("strong-agent", "strong-agent-model"),
      getTool: () => undefined,
      completeChat: async (options) => {
        requested.push(options.model ?? "");
        return "完成";
      }
    });
    const agent = handlers.agent;
    assert.ok(agent);

    const output = (await agent(agentNode("strong-agent"), {}, context({ tokensUsed: 100, tokenBudget: 100 }))) as Record<
      string,
      unknown
    >;

    assert.deepEqual(requested, ["cheap-model"]);
    assert.equal(output.modelSource, "budget-downgrade");
    assert.equal((output.modelDowngraded as { from: string }).from, "strong-agent-model");
  } finally {
    restoreEnv();
    restoreModels();
  }
});

test("diagnose prompt lists model directory options for swap_model decisions", () => {
  // 目录来自当前可用的模型：这里等价于用户在设置里配了快速/推理两条。
  const restoreModels = configureTestModels([
    { id: "fast-model", model: "fast-model", tags: ["fast"], costTier: "low" },
    { id: "strong-model", model: "strong-model", tags: ["reasoning"], costTier: "high" }
  ]);
  try {
    const prompt = buildAgentSystemPrompt(agentRecord("business-diagnostician"), {
      id: "diagnose",
      kind: "agent",
      agent: "business-diagnostician",
      loopRole: "diagnose",
      outputFormat: "json"
    });

    assert.match(prompt, /可选模型目录/);
    assert.match(prompt, /strong-model（strong-model，high）/);
    assert.match(prompt, /swap_model/);
  } finally {
    restoreModels();
  }
});

test("tool-calling prompt requires tool use and contract-compliant final answer", () => {
  const agent = agentRecord("business-diagnostician");
  const prompt = buildAgentSystemPrompt(agent, {
    id: "diagnose",
    kind: "agent",
    agent: "business-diagnostician",
    toolCalling: true,
    outputFormat: "json",
    outputContract: { required: ["rootCause", "revenueBasis", "promptPatch"] }
  });

  assert.match(prompt, /工具调用协议/);
  assert.match(prompt, /工具结果是外部事实的唯一来源/);
  assert.match(prompt, /JSON 必填字段/);
});

function routedAgent(id: string, model: string): AgentRecord {
  return {
    id,
    name: id,
    version: 1,
    role: "测试角色",
    prompt: "你是测试 Agent，只输出结果。",
    tools: [],
    model,
    capabilities: [],
    memory: {},
    enabled: true,
    createdAt: "",
    updatedAt: ""
  };
}

function agentNode(agent: string, extra: Partial<AgentNode> = {}): AgentNode {
  return { id: `node-${agent}`, kind: "agent", agent, ...extra };
}

function context(extra: { tokensUsed?: number; tokenBudget?: number } = {}) {
  return {
    runId: "run-model",
    workflowId: "workflow-model",
    iteration: 1,
    knowledgeBaseIds: [],
    scope: { input: {}, outputs: new Map(), evidence: [], verifyRounds: 0 },
    ...extra
  };
}

function withEnv(values: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

function agentRecord(id: string): AgentRecord {
  const authored = BUILTIN_AGENTS.find((agent) => agent.id === id);
  assert.ok(authored, `内置 Agent ${id} 不存在`);
  return { ...authored, version: 1, enabled: true, createdAt: "", updatedAt: "" };
}

function mcpTool(id: string): ToolRecord | undefined {
  if (id === "knowledge.search" || id === "verify.rubric") {
    return undefined;
  }
  return {
    id,
    name: id,
    type: "mcp",
    schema: {
      type: "object",
      properties: {
        source: { type: "string" },
        revenueBasis: { type: "string", enum: ["gross", "net"] }
      }
    },
    endpoint: `mcp://data-analysis/${id.split(".").pop()}`,
    description: "经营数据工具",
    enabled: true,
    createdAt: "",
    updatedAt: "",
    source: "custom"
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) }
  };
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test("live clarify analyzes intent, then rewrites the prompt and retries once when a new number leaks in", async () => {
  const restoreEnv = withEnv({
    PLATFORM_LIVE_AGENTS: "1",
    PLATFORM_LIVE_MODEL: "default-model"
  });
  const restoreModels = configureTestModel();
  try {
    const systems: string[] = [];
    const rewritePrompts: string[] = [];
    const handlers = createPlatformLiveHandlers({
      getAgent: () => undefined,
      completeChat: async (options) => {
        systems.push(options.system ?? "");
        if ((options.system ?? "").includes("意图分析器")) {
          return JSON.stringify({
            taskType: "教学复盘",
            goal: "复盘一节 40 分钟数学课",
            deliverable: "复盘报告",
            constraints: ["40 分钟"],
            ambiguities: [{ slot: "班级", question: "哪个班级？", impact: "high" }],
            assumptions: [],
            needsClarification: true,
            confidence: 0.81
          });
        }
        const content = options.messages[0]?.content;
        rewritePrompts.push(typeof content === "string" ? content : JSON.stringify(content ?? ""));
        return JSON.stringify(
          rewritePrompts.length === 1
            ? { rewrittenPrompt: "# 目标\n完成 45 分钟的复盘", changes: ["补充结构"] }
            : { rewrittenPrompt: "# 目标\n完成 40 分钟的复盘", changes: ["移除未提供的时长"] }
        );
      }
    });
    const clarify = handlers.clarify;
    assert.ok(clarify);
    const node: ClarifyNode = { id: "clarify", kind: "clarify", title: "意图理解" };
    const input = { request: "帮我复盘一节 40 分钟数学课" };

    const analysis = (await clarify(node, input, context(), { phase: "analyze" })) as Record<
      string,
      unknown
    >;
    assert.equal(analysis.kind, "clarify");
    assert.equal((analysis.output as { taskType?: string }).taskType, "教学复盘");

    const rewrite = (await clarify(node, input, context(), {
      phase: "rewrite",
      analysis: analysis.output as IntentAnalysis,
      clarification: {
        questions: ["哪个班级？"],
        answer: "五年级二班",
        actor: "张老师",
        askedAt: "2026-11-07T00:00:00.000Z"
      }
    })) as Record<string, unknown>;

    assert.equal(rewrite.rewrittenPrompt, "# 目标\n完成 40 分钟的复盘");
    assert.deepEqual(rewrite.guardrail, { ok: true, unexpected: [] });
    assert.equal(rewritePrompts.length, 2);
    assert.match(rewritePrompts[1] ?? "", /纠正要求/);
    assert.match(rewritePrompts[1] ?? "", /45/);
    assert.match(rewritePrompts[1] ?? "", /五年级二班/);
    assert.match(systems[0] ?? "", /意图分析器/);
  } finally {
    restoreEnv();
    restoreModels();
  }
});

test("live clarify reports leaked numbers when the rewrite retry still violates the guardrail", async () => {
  const restoreEnv = withEnv({
    PLATFORM_LIVE_AGENTS: "1",
    PLATFORM_LIVE_MODEL: "default-model"
  });
  const restoreModels = configureTestModel();
  try {
    let rewriteCalls = 0;
    const handlers = createPlatformLiveHandlers({
      getAgent: () => undefined,
      completeChat: async () => {
        rewriteCalls += 1;
        return JSON.stringify({
          rewrittenPrompt: "# 目标\n完成 45 分钟的复盘",
          changes: ["补充结构"]
        });
      }
    });
    const clarify = handlers.clarify;
    assert.ok(clarify);

    const analysis: IntentAnalysis = {
      taskType: "教学复盘",
      goal: "复盘一节 40 分钟数学课",
      deliverable: "复盘报告",
      constraints: ["40 分钟"],
      ambiguities: [],
      assumptions: [],
      needsClarification: false,
      confidence: 0.9
    };
    const rewrite = (await clarify(
      { id: "clarify", kind: "clarify" },
      { request: "帮我复盘一节 40 分钟数学课" },
      context(),
      { phase: "rewrite", analysis }
    )) as Record<string, unknown>;

    assert.equal(rewriteCalls, 2);
    assert.deepEqual(rewrite.guardrail, { ok: false, unexpected: ["45"] });
  } finally {
    restoreEnv();
    restoreModels();
  }
});
