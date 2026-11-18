import assert from "node:assert/strict";
import test from "node:test";
import type { CompleteToolChatOptions, ToolChatResult } from "../../qwenOpenAiClient.js";
import type { AgentRecord, McpCallResult, ToolRecord } from "../types.js";
import {
  buildChatToolsWithDelegation,
  buildDelegationCatalog,
  delegationTargetId,
  isDelegationToolId,
  pickDelegationRoute,
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
  // 中文问题留给模型先翻英文再查：第一轮调用工具，第二轮拿题录作答。
  const { fn, calls } = scriptedComplete([
    {
      content: "",
      toolCalls: [
        {
          id: "child-call-1",
          type: "function",
          function: { name: "pl-1", arguments: JSON.stringify({ search: "UAV pest detection" }) }
        }
      ]
    },
    { content: "找到 3 篇：UAV Pest Detection（2023）等。", toolCalls: [] }
  ]);
  const toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];

  const result = await runAgentDelegation({
    host: agentRecord(),
    targetId: "ytz-literature",
    question: "帮我查无人机病虫害识别的文献",
    getAgent: (id) => (id === literature.id ? literature : undefined),
    getTool: (id) => tools.get(id),
    callTool: async (tool, args) => {
      toolCalls.push({ tool: tool.name, args });
      return mcpResult("1. UAV Pest Detection · 2023");
    },
    resolveModel: () => ({}),
    complete: fn
  });

  assert.equal(result.isError, false);
  assert.equal(result.tool, "文献阅读Agent");
  assert.match(result.text, /UAV Pest Detection/);
  // 原话单独留一份，上层直接拿它当本轮回复，不再让主智能体改写。
  assert.equal(result.delegatedAnswer?.agentName, "文献阅读Agent");
  assert.equal(result.delegatedAnswer?.agentId, "ytz-literature");
  assert.match(result.delegatedAnswer?.answer ?? "", /UAV Pest Detection/);
  // 子智能体拿到的是自己的提示词，不是主智能体的。
  assert.match(String(calls[0].system ?? ""), /文献阅读导师/);
  assert.match(calls[0].messages[0].content, /无人机病虫害识别/);
  assert.match(result.text, /文献检索（OpenAlex）/);

  // 中文问题：system 里钉死「先翻英文再查」，避免中文原话命中差多跑一轮。
  assert.match(String(calls[0].system ?? ""), /英文关键词/);
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].args.search, "UAV pest detection");
});

test("英文检索词首轮直接 preset 检索，省掉一次模型往返", async () => {
  const literature = agentRecord({
    id: "ytz-literature",
    name: "文献阅读Agent",
    tools: ["plugin.pl-1"]
  });
  const tools = new Map([["plugin.pl-1", toolRecord()]]);
  const { fn, calls } = scriptedComplete([{ content: "找到 2 篇英文文献。", toolCalls: [] }]);
  const toolCalls: Array<{ args: Record<string, unknown> }> = [];

  await runAgentDelegation({
    host: agentRecord(),
    targetId: "ytz-literature",
    question: "find papers about UAV visual surveillance",
    getAgent: (id) => (id === literature.id ? literature : undefined),
    getTool: (id) => tools.get(id),
    callTool: async (_tool, args) => {
      toolCalls.push({ args });
      return mcpResult("1. UAV Surveillance · 2024");
    },
    resolveModel: () => ({}),
    complete: fn
  });

  assert.equal(calls.length, 1, "英文问题模型只被调用一次（作答），检索在首轮直接发出");
  assert.equal(toolCalls[0].args.search, "find papers about UAV visual surveillance");
  // 英文问题不需要注入中文翻译硬要求。
  assert.doesNotMatch(String(calls[0].system ?? ""), /英文关键词/);
});

test("子智能体的检索进度会透传给前端，工具条不再全程空白", async () => {
  const literature = agentRecord({
    id: "ytz-literature",
    name: "文献阅读Agent",
    tools: ["plugin.pl-1"]
  });
  const tools = new Map([["plugin.pl-1", toolRecord()]]);
  const { fn } = scriptedComplete([{ content: "找到 2 篇。", toolCalls: [] }]);
  const progress: Array<{ stage: string; toolId: string; name: string }> = [];

  await runAgentDelegation({
    host: agentRecord(),
    targetId: "ytz-literature",
    question: "帮我查无人机视觉监控的文献",
    getAgent: (id) => (id === literature.id ? literature : undefined),
    getTool: (id) => tools.get(id),
    callTool: async () => mcpResult("1. UAV Visual Surveillance · 2024"),
    resolveModel: () => ({}),
    complete: fn,
    onProgress: (item) => progress.push({ stage: item.stage, toolId: item.toolId, name: item.name })
  });

  assert.deepEqual(
    progress.map((item) => item.stage),
    ["running", "done"],
    "检索工具先 running 再 done，界面能显示出整条工具调用"
  );
  assert.equal(progress[0].toolId, "plugin.pl-1");
  assert.match(progress[0].name, /文献检索/);
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

test("子智能体抛错时把原因带回去，主智能体不会以为查过了", async () => {  const literature = agentRecord({ id: "ytz-literature", name: "文献阅读Agent" });
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

/** 研途引航那套五个专项，名字和定位照抄共享注册表。 */
function researchTeam() {
  return buildDelegationCatalog([
    agentRecord({
      id: "ytz-planning",
      name: "科研规划Agent",
      role: "科研规划",
      description: "制定科研计划、拆解任务、安排进度、选题"
    }),
    agentRecord({
      id: "ytz-literature",
      name: "文献阅读Agent",
      role: "文献阅读",
      description: "阅读论文、分析文献、寻找研究现状与空白"
    }),
    agentRecord({
      id: "ytz-experiment",
      name: "实验设计Agent",
      role: "实验设计",
      description: "设计实验方案、确定变量与评价指标"
    }),
    agentRecord({
      id: "ytz-defense",
      name: "开题答辩Agent",
      role: "开题答辩",
      description: "开题报告、模拟导师提问、答辩应对"
    }),
    agentRecord({
      id: "ytz-growth",
      name: "科研成长Agent",
      role: "科研成长",
      description: "成长计划、心态调整、能力分析"
    })
  ]);
}

test("问文献这类归属明确的问题，直接路由给文献阅读Agent", () => {
  const route = pickDelegationRoute("查询机械设计相关文献", researchTeam());

  assert.ok(route);
  assert.equal(route.descriptor.toolId, "agent://ytz-literature");
  assert.equal(route.call.function.name, "delegate_ytz-literature");
  assert.deepEqual(JSON.parse(route.call.function.arguments), {
    question: "查询机械设计相关文献"
  });
});

test("五类专项各按领域词路由，工具名与目标一一对应", () => {
  const team = researchTeam();
  const cases: Array<[string, string]> = [
    ["下周要开题答辩，导师会问什么", "agent://ytz-defense"],
    ["实验里的变量和对照组怎么定", "agent://ytz-experiment"],
    ["我很焦虑，好几次想放弃科研", "agent://ytz-growth"],
    ["帮我做个这学期的科研计划", "agent://ytz-planning"]
  ];

  for (const [question, expected] of cases) {
    const route = pickDelegationRoute(question, team);
    assert.equal(route?.descriptor.toolId, expected, question);
  }
});

/** 师者工作台那六个专项，名字照抄共享注册表。 */
function teacherTeam() {
  return buildDelegationCatalog([
    agentRecord({ id: "teacher-prep", name: "备课专项", role: "备课", description: "写教案、设计活动、分层评价" }),
    agentRecord({ id: "teacher-qa", name: "答疑专项", role: "答疑", description: "定位错因、给三级提示" }),
    agentRecord({ id: "teacher-exam", name: "命题专项", role: "命题", description: "出卷、审卷、难度区分度" }),
    agentRecord({ id: "teacher-safety", name: "安全专项", role: "安全", description: "欺凌、伤害、自伤风险" }),
    agentRecord({ id: "teacher-mind", name: "心理专项", role: "心理", description: "情绪、谈心、家庭变故" }),
    agentRecord({ id: "teacher-observe", name: "观课专项", role: "观课", description: "评课、诊断、磨课" })
  ]);
}

test("只给参数、没给任务词的追问靠上一轮原话补归属，别掉进别的专项", () => {
  const team = teacherTeam();
  // 用户上一轮问的是「备课 + 出一份小测」，这轮只补「10 道题、15 分钟、难度中等」。
  const route = pickDelegationRoute("10道题左右，15分钟，难度中等", team, {
    contextText: "请补充以上信息，我立刻为你生成符合考试质量标准的小测，并同步给出结构清晰、重难点突出的教案框架。",
    questionText: "帮我给大一高数备一节《夹逼定理》的课，顺便出一份小测\n\n补充：10道题左右，15分钟，难度中等"
  });
  assert.equal(route?.descriptor.toolId, "agent://teacher-exam");
  // 转交出去的问题要带上一轮的用户原话，否则专项只知道「10 道题」，年级学科全靠猜。
  assert.match(
    (JSON.parse(route!.call.function.arguments) as { question: string }).question,
    /夹逼定理/
  );
});

test("出题与答疑都带「题」字，靠动作词分开，不会互相抢", () => {
  const team = teacherTeam();
  const cases: Array<[string, string]> = [
    ["帮我出一份小测，10道题", "agent://teacher-exam"],
    ["难度中等偏上，选择题五道", "agent://teacher-exam"],
    ["学生这道题答错了，怎么给提示", "agent://teacher-qa"],
    ["这道题怎么讲，学生完全不会做", "agent://teacher-qa"],
    ["帮我把这堂课再磨一轮", "agent://teacher-observe"]
  ];

  for (const [question, expected] of cases) {
    const route = pickDelegationRoute(question, team);
    assert.equal(route?.descriptor.toolId, expected, question);
  }
});

test("一句话点两件事时不硬指定专项，留给主智能体拆步转交", () => {
  // 「备课 + 出小测」是两件活儿，硬指定命题专项会把备课那半截丢掉。
  assert.equal(
    pickDelegationRoute(
      "帮我给大一高数备一节《夹逼定理》的课，顺便出一份小测，小测要有选择题、填空题、简答题",
      teacherTeam()
    ),
    undefined
  );
});

test("归属不明、只有背景词或者两边打平时不硬猜，交回模型", () => {
  const team = researchTeam();

  assert.equal(pickDelegationRoute("你好", team), undefined);
  assert.equal(pickDelegationRoute("随便聊聊", team), undefined);
  // 只有「科研」这个背景词，没落到任何一类任务上。
  assert.equal(pickDelegationRoute("我想做科研但不知道怎么开始", team), undefined);
  // 文献和答辩都命中，硬猜不如让模型判断。
  assert.equal(pickDelegationRoute("开题要查文献", team), undefined);
  assert.equal(pickDelegationRoute("查询机械设计相关文献", []), undefined);
});

test("无工具的专项智能体流式吐正文：逐段回调，首字不必等整段写完", async () => {
  const planning = agentRecord({
    id: "ytz-planning",
    name: "科研规划Agent",
    role: "科研规划",
    tools: [],
    description: "规划、计划、时间线"
  });
  const deltas: string[] = [];
  const pieces = ["【当前阶段】", "你处于探索期。", "【目标】先定一个可验证的问题。"];
  let streamOptions: { system?: string } | undefined;

  const result = await runAgentDelegation({
    host: agentRecord(),
    targetId: "ytz-planning",
    question: "帮我做个这学期的科研规划",
    getAgent: (id) => (id === planning.id ? planning : undefined),
    getTool: () => undefined,
    callTool: async () => mcpResult(""),
    resolveModel: () => ({}),
    // 注入流式 mock：每个字块立刻回调，模拟边生成边推。
    stream: async (options) => {
      streamOptions = options;
      for (const piece of pieces) {
        options.onDelta(piece);
      }
      return {
        rawAssistantContent: pieces.join(""),
        visibleAssistantContent: pieces.join(""),
        artifactRequests: []
      };
    },
    onAnswerDelta: (delta) => deltas.push(delta)
  });

  assert.equal(result.isError, false);
  assert.equal(result.tool, "科研规划Agent");
  // 每个字块都实时回调了，且顺序一致——首字能立刻推给前端。
  assert.deepEqual(deltas, pieces);
  // 存档用的完整原文仍然是拼起来的整段。
  assert.equal(result.delegatedAnswer?.answer, pieces.join(""));
  assert.match(String(streamOptions?.system ?? ""), /科研规划/);
});
