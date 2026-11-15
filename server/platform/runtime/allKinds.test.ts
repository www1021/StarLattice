/**
 * 全节点类型联动探针：把 nodeTypes.ts 里定义的 17 种 kind 全部塞进真实执行器跑一遍。
 * 每种 kind 至少出现在一个流程里并成功产出，防止「定义了却跑不起来」的节点混进面板。
 * 覆盖清单：start / end / agent / tool / knowledge / http / llm / clarify / extract /
 * template / subworkflow / parallel / condition / loop / verify / approve / human。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { WorkflowExecutor } from "./executor.js";
import { PlatformStateStore } from "./stateStore.js";
import { NODE_TYPE_SPECS } from "../workflow/nodeTypes.js";
import type { NodeKind, WorkflowDefinition } from "../types.js";

function createStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-all-kinds-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  return {
    store,
    dispose() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** 注册一个最小可用 Agent，供 agent 节点在 stub 模式下调度。 */
function saveProbeAgent(store: PlatformStateStore, id: string) {
  store.saveAgent({
    id,
    name: `探针-${id}`,
    version: 1,
    role: "全节点探针",
    prompt: "",
    tools: [],
    model: "probe-llm",
    capabilities: [],
    memory: {},
    enabled: true
  });
}

test("全部 17 种节点类型都能在执行器里跑通", async () => {
  const { store, dispose } = createStore();
  try {
    // 先自检：定义表里的 kind 一共 17 种，本测试要全覆盖。
    const definedKinds = NODE_TYPE_SPECS.map((spec) => spec.kind).sort();
    assert.deepEqual(
      definedKinds,
      [
        "agent",
        "approve",
        "clarify",
        "condition",
        "end",
        "extract",
        "http",
        "human",
        "knowledge",
        "llm",
        "loop",
        "parallel",
        "start",
        "subworkflow",
        "template",
        "tool",
        "verify"
      ],
      "nodeTypes.ts 的 kind 清单变化时，请同步更新本测试的覆盖清单"
    );

    saveProbeAgent(store, "probe-writer");
    saveProbeAgent(store, "probe-reviewer");

    // 子流程：给 subworkflow 节点调用。
    store.saveWorkflow({
      id: "all-kinds-child",
      name: "全节点探针·子流程",
      version: 1,
      inputs: [{ name: "topic", type: "string", required: false }],
      nodes: [
        { id: "child-llm", kind: "llm", title: "子流程思考", prompt: "围绕 ${input.topic} 写一句。" },
        { id: "child-out", kind: "end", inputs: { result: "${child-llm.output}" } }
      ],
      edges: [{ from: "child-llm", to: "child-out" }]
    } as WorkflowDefinition);

    // ── 流程 1：start → agent → tool → knowledge → http → llm → template → end ──
    const chain: WorkflowDefinition = {
      id: "all-kinds-chain",
      name: "全节点探针·主链",
      version: 1,
      inputs: [{ name: "topic", type: "string", required: false }],
      nodes: [
        { id: "entry", kind: "start", inputs: { topic: "${input.topic}" } },
        { id: "writer", kind: "agent", agent: "probe-writer", inputs: { topic: "${input.topic}" } },
        { id: "plugin", kind: "tool", tool: "probe.plugin", args: { input: "${writer.output}" } },
        {
          id: "search",
          kind: "knowledge",
          query: "${input.topic}",
          topK: 3,
          knowledgeBaseIds: ["kb-probe"]
        },
        { id: "fetch", kind: "http", method: "GET", url: "https://example.com/api/probe" },
        { id: "think", kind: "llm", prompt: "综合 ${plugin.output} 与 ${search.output} 再想一步。" },
        { id: "render", kind: "template", template: "结论：${think.output}" },
        { id: "exit", kind: "end", inputs: { result: "${render.output}" } }
      ],
      edges: [
        { from: "entry", to: "writer" },
        { from: "writer", to: "plugin" },
        { from: "plugin", to: "search" },
        { from: "search", to: "fetch" },
        { from: "fetch", to: "think" },
        { from: "think", to: "render" },
        { from: "render", to: "exit" }
      ]
    };

    const chainRun = await new WorkflowExecutor(store).run(chain, { topic: "分数的意义" });
    assert.equal(chainRun.run.status, "succeeded");
    assert.deepEqual(
      chainRun.steps.map((step) => step.nodeKind),
      ["start", "agent", "tool", "knowledge", "http", "llm", "template", "end"]
    );
    for (const step of chainRun.steps) {
      assert.equal(step.status, "succeeded", `节点 ${step.nodeId} 应成功`);
      assert.ok(step.output, `节点 ${step.nodeId} 应有产物`);
    }

    // ── 流程 2：clarify → extract → human → end（交互三件套，参数已带齐不追问）──
    const interactive: WorkflowDefinition = {
      id: "all-kinds-interactive",
      name: "全节点探针·交互链",
      version: 1,
      inputs: [
        { name: "request", type: "string", required: true },
        { name: "title", type: "string", required: true }
      ],
      nodes: [
        { id: "clarify", kind: "clarify", clarifyOn: "never" },
        {
          id: "extract",
          kind: "extract",
          params: [{ name: "title", label: "题目", description: "论文题目", type: "string", required: true }]
        },
        {
          id: "gather",
          kind: "human",
          prompt: "请补充说明",
          fields: [{ key: "note", label: "备注", type: "textarea", required: true }]
        },
        { id: "echo", kind: "template", template: "${extract.title} / ${gather.note}" },
        { id: "exit", kind: "end", inputs: { result: "${echo.output}" } }
      ],
      edges: [
        { from: "clarify", to: "extract" },
        { from: "extract", to: "gather" },
        { from: "gather", to: "echo" },
        { from: "echo", to: "exit" }
      ]
    };

    const executor = new WorkflowExecutor(store);
    const interactiveStart = executor.start(interactive, {
      request: "帮我准备答辩",
      title: "人工智能在无人机领域的应用"
    });
    const interaction = await waitFor("人工输入卡片", () =>
      store.listInteractions({ runId: interactiveStart.id, status: "pending" })[0]
    );
    executor.respondInteraction(interaction.id, { values: { note: "重点讲方法部分" }, actor: "探针用户" });
    const interactiveDone = await waitFor("交互链完成", () => {
      const run = store.getRun(interactiveStart.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const interactiveSteps = store.listSteps(interactiveDone.id);
    assert.deepEqual(
      interactiveSteps.map((step) => step.nodeKind),
      ["clarify", "extract", "human", "template", "end"]
    );
    const extractOutput = interactiveSteps.find((step) => step.nodeId === "extract")
      ?.output as Record<string, unknown>;
    assert.equal((extractOutput.params as Record<string, unknown>).title, "人工智能在无人机领域的应用");

    // ── 流程 3：condition → parallel(并行容器) → loop → verify → approve → subworkflow → end ──
    const control: WorkflowDefinition = {
      id: "all-kinds-control",
      name: "全节点探针·控制链",
      version: 1,
      inputs: [{ name: "mode", type: "string", required: true }],
      nodes: [
        {
          id: "gate",
          kind: "condition",
          when: "${input.mode} == fast",
          then: [{ id: "fast-note", kind: "template", template: "快速通道" }],
          else: [{ id: "slow-note", kind: "template", template: "慢速通道" }]
        },
        {
          id: "fanout",
          kind: "parallel",
          branches: [
            { id: "left", kind: "agent", agent: "probe-writer" },
            { id: "right", kind: "agent", agent: "probe-reviewer" }
          ]
        },
        {
          id: "retry",
          kind: "loop",
          maxIterations: 2,
          while: "${loop.iteration} < 2",
          body: [{ id: "round-note", kind: "template", template: "第 ${loop.iteration} 轮" }]
        },
        { id: "check", kind: "verify", verifier: "probe-verifier", threshold: 0.5 },
        { id: "review", kind: "approve", assignee: "探针组长", instructions: "请审批" },
        {
          id: "call-child",
          kind: "subworkflow",
          workflowId: "all-kinds-child",
          inputs: { topic: "${input.mode}" },
          outputs: { childResult: "${child-out.result}" }
        },
        { id: "exit", kind: "end", inputs: { result: "${call-child.childResult}" } }
      ],
      edges: [
        { from: "gate", to: "fanout" },
        { from: "fanout", to: "retry" },
        { from: "retry", to: "check" },
        { from: "check", to: "review" },
        { from: "review", to: "call-child" },
        { from: "call-child", to: "exit" }
      ]
    };

    const controlStart = executor.start(control, { mode: "fast" });
    const approval = await waitFor("审批卡片", () =>
      store.listApprovals({ runId: controlStart.id, status: "pending" })[0]
    );
    executor.decideApproval(approval.id, { decision: "approved", reviewer: "探针组长" });
    const controlDone = await waitFor("控制链完成", () => {
      const run = store.getRun(controlStart.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const controlSteps = store.listSteps(controlDone.id);
    const controlKinds = controlSteps.map((step) => step.nodeKind);
    // condition / loop / parallel 是容器节点，编译成内部步骤，本身不产生 nodeKind=自身 的记录，
    // 分别用 fast-note、round-note、双 agent 并发步骤证明它们生效。
    for (const kind of ["agent", "template", "verify", "approve", "subworkflow", "end"] as NodeKind[]) {
      assert.ok(controlKinds.includes(kind), `控制链应包含 ${kind} 节点`);
    }
    // 条件走了 fast 分支
    assert.ok(
      controlSteps.some((step) => step.nodeId === "fast-note" && step.status === "succeeded"),
      "condition 的 then 分支应执行"
    );
    // 循环体跑了 2 轮
    const roundNotes = controlSteps.filter((step) => step.nodeId === "round-note");
    assert.equal(roundNotes.length, 2, "loop 循环体应执行 2 轮");
    // 子流程产物带回了父流程
    const exitStep = controlSteps.find((step) => step.nodeId === "exit");
    assert.ok(
      String(JSON.stringify(exitStep?.output)).includes("stub"),
      "subworkflow 输出映射应带回子流程产物"
    );
  } finally {
    dispose();
  }
});

async function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}
