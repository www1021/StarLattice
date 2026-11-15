import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunTrace,
  collectTraceNodeMeta,
  type RunTraceNodeMeta
} from "./runTrace.js";

const masterNodes = [
  { id: "classify", title: "意图识别", kind: "llm" },
  { id: "planning-agent", title: "科研规划 Agent", kind: "agent", agent: "ytz-planning" },
  { id: "literature-agent", title: "文献阅读 Agent", kind: "agent", agent: "ytz-literature" },
  { id: "general-llm", title: "通用导师回答", kind: "llm" },
  {
    id: "defense-training",
    title: "模拟开题答辩训练",
    kind: "subworkflow",
    workflowId: "ytz-defense-training-v1"
  }
];

const defenseNodes = [
  { id: "ask", title: "追问生成", kind: "llm" },
  { id: "search-papers", title: "文献检索", kind: "tool", tool: "plugin.p1" }
];

/** 与 routes.ts 里相同的注入方式：definition + 子工作流解析器。 */
function makeNodeMeta(): (nodeId: string) => RunTraceNodeMeta | undefined {
  const map = collectTraceNodeMeta(
    { nodes: masterNodes },
    (workflowId) =>
      workflowId === "ytz-defense-training-v1" ? { nodes: defenseNodes } : undefined
  );
  return (nodeId) => map.get(nodeId);
}

const resolveTool = (toolId: string) => {
  if (toolId === "plugin.p1") {
    return { name: "查文献/search_academic_papers", endpoint: "plugin://p1" };
  }
  if (toolId === "knowledge.search") {
    return { name: "知识库检索", endpoint: "builtin://knowledge/search" };
  }
  return undefined;
};

const resolvePluginName = (pluginId: string) =>
  pluginId === "p1" ? "OpenAlex 文献" : undefined;

test("轨迹提炼：跑成功的智能体节点进列表，跳过的分支不进", () => {
  const trace = buildRunTrace({
    steps: [
      { nodeId: "classify", nodeKind: "llm", status: "succeeded", durationMs: 544 },
      { nodeId: "planning-agent", nodeKind: "agent", status: "skipped", durationMs: 0 },
      { nodeId: "literature-agent", nodeKind: "agent", status: "succeeded", durationMs: 3200 }
    ],
    nodeMeta: makeNodeMeta(),
    resolveTool,
    resolvePluginName
  });
  assert.deepEqual(trace.agents, [
    { name: "意图识别", kind: "llm", durationMs: 544 },
    { name: "文献阅读 Agent", kind: "agent", durationMs: 3200, agentId: "ytz-literature" }
  ]);
  assert.deepEqual(trace.tools, []);
});

test("工具节点解析展示名：插件端点换成插件名，失败的调用标记 ok=false", () => {
  const trace = buildRunTrace({
    steps: [
      {
        nodeId: "search-papers",
        path: "defense-training/search-papers",
        nodeKind: "tool",
        status: "succeeded",
        durationMs: 2751
      },
      { nodeId: "kb", nodeKind: "tool", status: "failed", durationMs: 120 },
      { nodeId: "unknown-tool", nodeKind: "tool", status: "failed", durationMs: 40 }
    ],
    nodeMeta: makeNodeMeta(),
    resolveTool,
    resolvePluginName
  });
  assert.deepEqual(trace.tools, [
    { toolId: "plugin.p1", name: "OpenAlex 文献", ok: true, latencyMs: 2751 },
    { toolId: "kb", name: "kb", ok: false, latencyMs: 120 },
    { toolId: "unknown-tool", name: "unknown-tool", ok: false, latencyMs: 40 }
  ]);
});

test("子工作流与其内部工具都能解析：智能体只收顶层，工具不论层级", () => {
  const trace = buildRunTrace({
    steps: [
      {
        nodeId: "defense-training",
        nodeKind: "subworkflow",
        status: "succeeded",
        durationMs: 43663
      },
      {
        nodeId: "ask",
        path: "defense-training/ask",
        nodeKind: "llm",
        status: "succeeded",
        durationMs: 3037
      },
      {
        nodeId: "search-papers",
        path: "defense-training/search-papers",
        nodeKind: "tool",
        status: "succeeded",
        durationMs: 900
      }
    ],
    nodeMeta: makeNodeMeta(),
    resolveTool,
    resolvePluginName
  });
  assert.deepEqual(trace.agents, [
    { name: "模拟开题答辩训练", kind: "subworkflow", durationMs: 43663 }
  ]);
  assert.deepEqual(trace.tools, [
    { toolId: "plugin.p1", name: "OpenAlex 文献", ok: true, latencyMs: 900 }
  ]);
});

test("循环里重复执行的节点：智能体合并耗时，工具合并耗时且成败取与", () => {
  const trace = buildRunTrace({
    steps: [
      { nodeId: "literature-agent", nodeKind: "agent", status: "succeeded", durationMs: 1000 },
      { nodeId: "literature-agent", nodeKind: "agent", status: "succeeded", durationMs: 1500 },
      { nodeId: "kb", nodeKind: "tool", status: "succeeded", durationMs: 200 },
      { nodeId: "kb", nodeKind: "tool", status: "failed", durationMs: 300 }
    ],
    nodeMeta: makeNodeMeta(),
    resolveTool,
    resolvePluginName
  });
  assert.deepEqual(trace.agents, [
    { name: "文献阅读 Agent", kind: "agent", durationMs: 2500, agentId: "ytz-literature" }
  ]);
  assert.deepEqual(trace.tools, [
    { toolId: "kb", name: "kb", ok: false, latencyMs: 500 }
  ]);
});

test("节点元数据收集覆盖循环体与被引用子工作流", () => {
  const map = collectTraceNodeMeta(
    {
      nodes: [
        { id: "top", title: "顶层", kind: "llm" },
        {
          id: "loop",
          kind: "loop",
          body: { nodes: [{ id: "inner", title: "循环内", kind: "tool", tool: "knowledge.search" }] }
        },
        {
          id: "sub",
          kind: "subworkflow",
          workflowId: "ytz-defense-training-v1"
        }
      ]
    },
    (workflowId) =>
      workflowId === "ytz-defense-training-v1" ? { nodes: defenseNodes } : undefined
  );
  assert.equal(map.get("top")?.title, "顶层");
  assert.equal(map.get("inner")?.tool, "knowledge.search");
  assert.equal(map.get("ask")?.title, "追问生成");
  assert.equal(map.get("search-papers")?.tool, "plugin.p1");
});
