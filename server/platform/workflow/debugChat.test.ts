import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDebugSystemPrompt,
  buildFallbackReply,
  buildRunUserMessage,
  chunkFallbackText,
  classifyDebugIntent,
  debugChatModel,
  pickFinalArtifact,
  stringifyArtifact,
  summarizeNodes
} from "./debugChat.js";

test("寒暄与能力询问不触发工作流，显式任务句才触发", () => {
  assert.equal(classifyDebugIntent("你好"), "greeting");
  assert.equal(classifyDebugIntent("您好！"), "greeting");
  assert.equal(classifyDebugIntent("hi"), "greeting");
  assert.equal(classifyDebugIntent("你是谁"), "capability");
  assert.equal(classifyDebugIntent("你能做什么？"), "capability");
  assert.equal(classifyDebugIntent("围绕勾股定理生成一份教案"), "run");
  assert.equal(
    classifyDebugIntent("帮我围绕勾股定理设计一份能帮助初二学生理解证明过程的完整教案并附上课堂练习"),
    "run"
  );
  assert.equal(classifyDebugIntent("跑一遍工作流"), "run");
  assert.equal(classifyDebugIntent("试运行看看节点耗时"), "run");
});

test("教学咨询类提问直接聊天，不再被当成任务跑工作流", () => {
  assert.equal(classifyDebugIntent("如何让学生听课效率变高"), "chat");
  assert.equal(classifyDebugIntent("怎么提高课堂互动？"), "chat");
  assert.equal(classifyDebugIntent("为什么学生上课容易走神"), "chat");
  assert.equal(classifyDebugIntent("讲讲形成性评价怎么做"), "chat");
  assert.equal(classifyDebugIntent("这条工作流有哪些节点"), "chat");
  assert.equal(classifyDebugIntent("随便聊聊"), "chat");
});

test("最终产物取交付节点，不取运行指标 JSON", () => {
  const steps = [
    { nodeId: "start", output: { started: true } },
    { nodeId: "report", output: "报告草稿" },
    { nodeId: "deliver", output: { title: "勾股定理教案", sections: 4 } },
    {
      nodeId: "end",
      output: { mode: "stub", score: 0.66, stepCount: 28, tokensUsed: 18208 }
    }
  ];
  const artifact = pickFinalArtifact(steps);
  assert.equal(artifact?.nodeId, "deliver");
  assert.deepEqual(artifact?.output, { title: "勾股定理教案", sections: 4 });
});

test("没有交付节点时退回最后一个有输出的步骤", () => {
  const artifact = pickFinalArtifact([
    { nodeId: "start", output: "开始" },
    { nodeId: "design", output: "设计稿" },
    { nodeId: "end" }
  ]);
  assert.equal(artifact?.nodeId, "design");
  assert.equal(pickFinalArtifact([]), undefined);
});

test("节点摘要按顶层聚合耗时并保留失败状态", () => {
  const summary = summarizeNodes([
    { path: "loop/design", status: "succeeded", durationMs: 10 },
    { path: "loop/design", status: "succeeded", durationMs: 5 },
    { nodeId: "verify", status: "failed", durationMs: 3 },
    { nodeId: "verify", status: "succeeded", durationMs: 2 }
  ]);
  assert.deepEqual(summary, [
    { nodeId: "loop", status: "succeeded", durationMs: 15 },
    { nodeId: "verify", status: "failed", durationMs: 5 }
  ]);
});

test("提示词带上工作流信息，运行轮要求只讲结果", () => {
  const prompt = buildDebugSystemPrompt({
    workflowName: "师范生课堂训练全链路",
    nodeCount: 14,
    inputNames: ["topic", "grade"],
    intent: "run"
  });
  assert.match(prompt, /师范生课堂训练全链路/);
  assert.match(prompt, /14 个节点/);
  assert.match(prompt, /topic、grade/);
  assert.match(prompt, /不要逐个节点报状态/);
});

test("聊天轮提示词要求直接回答实质问题，并且不主动提节点", () => {
  const prompt = buildDebugSystemPrompt({
    workflowName: "师范生课堂训练全链路",
    nodeCount: 14,
    inputNames: ["topic"],
    nodeLabels: ["start:start", "design:agent"],
    intent: "chat"
  });
  assert.match(prompt, /不要提工作流、节点、运行状态/);
  assert.match(prompt, /start:start/);
  assert.match(prompt, /这一轮只是聊天/);
});

test("运行用户消息包含交付内容且限制长度", () => {
  const message = buildRunUserMessage({
    message: "生成教案",
    artifact: { text: "x".repeat(9000) },
    artifactNodeId: "deliver",
    status: "succeeded",
    stepCount: 28,
    durationMs: 66,
    mode: "stub"
  });
  assert.match(message, /生成教案/);
  assert.match(message, /deliver/);
  assert.match(message, /已截断/);
  assert.ok(message.length < 5000);
});

test("离线兜底对寒暄和运行结果都有可读文字", () => {
  const greeting = buildFallbackReply({ intent: "greeting", workflowName: "教案流水线" });
  assert.match(greeting, /你好呀/);
  assert.match(greeting, /教案流水线/);

  const chat = buildFallbackReply({
    intent: "chat",
    workflowName: "教案流水线",
    message: "如何让学生听课效率变高"
  });
  assert.match(chat, /如何让学生听课效率变高/);
  assert.match(chat, /调试运行/);

  const run = buildFallbackReply({
    intent: "run",
    workflowName: "教案流水线",
    status: "succeeded",
    mode: "stub",
    stepCount: 28,
    durationMs: 66
  });
  assert.match(run, /28 步/);
  assert.match(run, /离线夹具模式/);

  const failed = buildFallbackReply({
    intent: "run",
    workflowName: "教案流水线",
    error: "节点未连接"
  });
  assert.match(failed, /节点未连接/);
});

test("切块可无损还原", () => {
  const text = "这是一段用于验证切块逻辑的中文回复。";
  assert.equal(chunkFallbackText(text, 4).join(""), text);
  assert.equal(stringifyArtifact(undefined), "（无输出）");
  assert.equal(typeof debugChatModel(), "string");
});
