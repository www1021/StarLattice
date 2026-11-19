import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunStatus, ToolNode, WorkflowDefinition } from "../types.js";
import { BUILTIN_AGENTS } from "../registry/agents.js";
import { McpClient } from "../mcp/client.js";
import { loadBuiltinWorkflows } from "../workflow/dsl.js";
import { WorkflowExecutor } from "./executor.js";
import { assertSafeHttpUrl, isPrivateAddress } from "./httpNode.js";
import { PlatformStateStore } from "./stateStore.js";

function createStore() {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-platform-run-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  return {
    store,
    dispose() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

/** 模拟已绑定知识库的服务端 handler；stub 执行器本身不再伪造 citation。 */
function knowledgeHandlers(documentName = "义务教育数学课程标准（2022年版）") {
  return {
    knowledgeTool: async (node: ToolNode) => {
      if (node.tool !== "knowledge.search") {
        return undefined;
      }
      return {
        mode: "live",
        tool: node.tool,
        summary: "命中 1 条引用",
        citations: [
          {
            id: `${documentName}-1`,
            title: documentName,
            documentName,
            knowledgeBaseName: "课标库",
            snippet: "分数的意义在于把单位“1”平均分。",
            source: "local",
            score: 0.9
          }
        ],
        output: `[1] ${documentName}`
      };
    }
  };
}

test("runs classroom-v1 end to end without inflating stub scores by round", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
  assert.ok(workflow);
  try {
    const { run, steps } = await new WorkflowExecutor(store, knowledgeHandlers()).run(workflow, {
      topic: "分数的意义",
      subject: "数学",
      grade: "五年级"
    });

    assert.equal(run.status, "succeeded");
    assert.equal(run.mode, "stub");
    // 10 个节点，循环体 2 个节点跑 2 轮 → 12 条执行记录
    assert.equal(steps.length, 12);
    assert.ok(steps.every((step) => step.status === "succeeded"));

    const scores = store.listVerifyResults(run.id).map((result) => result.score);
    // stub 产物内容几乎不变，分数也必须保持稳定：不允许按尝试次数抬分。
    assert.deepEqual(scores, [0.6663, 0.6633, 0.6633]);
    assert.ok(scores.every((score) => score < 0.85));

    const verifications = store.listVerifyResults(run.id);
    for (const verification of verifications) {
      const layers = verification.detail?.layers as
        | { rule: { score: number }; crossCheck: { verifiers: unknown[] }; baseline: { coverage: number } }
        | undefined;
      assert.ok(layers, "验证结果应携带三层明细");
      assert.ok(layers.rule.score > 0.8);
      assert.equal(layers.baseline.coverage, 1);
      assert.equal(layers.crossCheck.verifiers.length, 2);
      assert.ok(verification.confidence <= 0.5, "stub 验证置信度应封顶");
      assert.match(verification.issues.join(" "), /stub 演练/);
    }

    const iterations = store.listLoopIterations(run.id);
    assert.equal(iterations.length, 2);
    assert.equal(iterations[0]?.scoreBefore, 0.6663);
    assert.equal(iterations[1]?.scoreAfter, 0.6633);
    // 没有更优轮次时保留初始产物，而不是把最后一轮当作结果。
    assert.equal(store.getRun(run.id)?.output?.score, 0.6663);
  } finally {
    dispose();
  }
});

test("feeds the previous round's artifact and issues into revise", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
  assert.ok(workflow);
  try {
    const { steps } = await new WorkflowExecutor(store, knowledgeHandlers()).run(workflow, {
      topic: "分数的意义",
      subject: "数学",
      grade: "五年级"
    });
    const revisions = steps.filter((step) => step.nodeId === "revise");
    assert.equal(revisions.length, 2);

    const first = revisions[0]!.input as Record<string, unknown>;
    const second = revisions[1]!.input as Record<string, unknown>;
    assert.equal(first.citations !== undefined, true);
    assert.notDeepEqual(second.draft, first.draft);
    assert.deepEqual(second.draft, revisions[0]!.output);
    assert.ok(Array.isArray(second.issues) && second.issues.length > 0);
  } finally {
    dispose();
  }
});

test("runs classroom-map-v1 through the parallel rehearsal, gate and revision loop", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-map-v1");
  assert.ok(workflow);
  try {
    for (const item of loadBuiltinWorkflows()) {
      store.saveWorkflow(item);
    }
    const { run, steps } = await new WorkflowExecutor(store, knowledgeHandlers()).run(workflow, {
      topic: "分数的意义",
      subject: "数学",
      grade: "五年级",
      focus: "提问梯度"
    });

    assert.equal(run.status, "succeeded");
    // 教学设计子流程 1 次验证 + 演练验证 + 2 轮修订复核 + 学情报告验证。
    assert.deepEqual(
      store.listVerifyResults(run.id).map((result) => result.score),
      [0.6641, 0.6591, 0.6605, 0.6605, 0.6885]
    );

    const loops = store.listLoopIterations(run.id);
    assert.equal(loops.length, 2);
    assert.equal(loops[0]?.scoreBefore, 0.6591);
    assert.equal(loops[0]?.scoreAfter, 0.6605);
    assert.equal(loops[1]?.scoreAfter, 0.6605);

    const executed = new Set(steps.filter((step) => step.status === "succeeded").map((step) => step.nodeId));
    for (const nodeId of [
      "teacher-actions",
      "student-top",
      "student-weak",
      "student-silent",
      "student-naughty",
      "student-misunderstanding",
      "expert-review",
      "revise"
    ]) {
      assert.ok(executed.has(nodeId), `节点 ${nodeId} 应执行成功`);
    }

    const end = steps.find((step) => step.nodeId === "end");
    assert.ok(end);
    assert.ok((end.output as { insight?: unknown }).insight !== undefined);
  } finally {
    dispose();
  }
});

test("runs business-map-v1 fan-out, calibration loop and final verification", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "business-map-v1");
  assert.ok(workflow);
  try {
    const { run, steps } = await new WorkflowExecutor(store).run(workflow, {
      question: "本月各区域与品类的毛利表现如何？",
      focus: "退款影响"
    });

    assert.equal(run.status, "succeeded");
    const verifications = store.listVerifyResults(run.id);
    assert.equal(verifications.length, 4);
    assert.ok((verifications[0]?.score ?? 1) < 0.85, "初稿口径错误应低于阈值");
    assert.ok((verifications.at(-1)?.score ?? 0) < 0.9, "终稿验证分应被记录");

    const loops = store.listLoopIterations(run.id);
    assert.equal(loops.length, 2, "未达标时应重算两轮");

    const executed = steps.filter((step) => step.status === "succeeded").map((step) => step.nodeId);
    for (const nodeId of ["region", "product", "channel", "trend", "chart", "reference-metrics"]) {
      assert.ok(executed.includes(nodeId), `节点 ${nodeId} 应执行成功`);
    }
    assert.equal(executed.filter((nodeId) => nodeId === "rebuild").length, 2);

    const end = steps.find((step) => step.nodeId === "end");
    assert.ok(end);
    assert.ok((end.output as { report?: unknown }).report !== undefined);
  } finally {
    dispose();
  }
});

test("keeps sub-workflow verification scores content-based instead of attempt-based", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "teaching-pipeline-v1");
  assert.ok(workflow);
  try {
    for (const item of loadBuiltinWorkflows()) {
      store.saveWorkflow(item);
    }
    const { run, steps } = await new WorkflowExecutor(store, knowledgeHandlers()).run(workflow, {
      topic: "分数的意义",
      subject: "数学",
      grade: "五年级"
    });
    assert.equal(run.status, "succeeded");

    const verifications = store.listVerifyResults(run.id);
    // 四处验证的分数由各自产物内容决定，不随运行内验证次数累加。
    assert.deepEqual(
      verifications.map((result) => {
        const layers = result.detail?.layers as { crossCheck: { score: number } } | undefined;
        return layers?.crossCheck.score;
      }),
      [0.6641, 0.6663, 0.6633, 0.6885]
    );

    const overallStep = steps.find((step) => step.nodeId === "verify-overall");
    assert.ok(overallStep);
    const overall = verifications.find((result) => result.stepId === overallStep.id);
    assert.ok(overall);
    assert.equal(overall.score, 0.6633);
    assert.ok(overall.evidence.length > 0);
    // stub 产物没有达到 0.85 时如实报告未通过，不能靠轮次凑到达标。
    assert.equal((run.output?.verify as { passed?: boolean } | undefined)?.passed, false);

    // 子流程内的验证不能因为作用域切换而丢掉父流程检索到的证据。
    assert.equal(verifications.length, 4);
    assert.ok(
      verifications.every((result) => result.evidence.length > 0),
      "四个验证点都应拿到证据池里的引用"
    );
  } finally {
    dispose();
  }
});

test("carries evidence across sub-workflow boundaries in both directions", async () => {
  const { store, dispose } = createStore();
  const child: WorkflowDefinition = {
    id: "evidence-child",
    name: "证据子流程",
    version: 1,
    inputs: [],
    nodes: [
      {
        id: "child-retrieve",
        kind: "tool",
        tool: "knowledge.search",
        args: { query: "child" }
      },
      {
        id: "child-check",
        kind: "verify",
        verifier: "observer-verifier",
        rubric: ["证据支撑"],
        threshold: 0.5
      }
    ],
    edges: [{ from: "child-retrieve", to: "child-check" }]
  };
  const parent: WorkflowDefinition = {
    id: "evidence-parent",
    name: "证据父流程",
    version: 1,
    inputs: [],
    nodes: [
      {
        id: "parent-retrieve",
        kind: "tool",
        tool: "knowledge.search",
        args: { query: "parent" }
      },
      { id: "child", kind: "subworkflow", workflowId: "evidence-child" },
      {
        id: "parent-check",
        kind: "verify",
        verifier: "observer-verifier",
        rubric: ["证据支撑"],
        threshold: 0.5
      }
    ],
    edges: [
      { from: "parent-retrieve", to: "child" },
      { from: "child", to: "parent-check" }
    ]
  };

  try {
    store.saveWorkflow(child);
    store.saveWorkflow(parent);
    const executor = new WorkflowExecutor(store, {
      knowledgeTool: async (node, input) => {
        if (node.tool !== "knowledge.search") {
          return undefined;
        }
        const documentName = input.query === "child" ? "子流程课标" : "父流程课标";
        return {
          mode: "live",
          tool: node.tool,
          summary: "命中 1 条引用",
          citations: [{ id: documentName, title: documentName, documentName, source: "local" }],
          output: documentName
        };
      }
    });

    const { run } = await executor.run(parent, {});
    const steps = store.listSteps(run.id);
    const verifications = store.listVerifyResults(run.id);
    const childResult = verifications.find(
      (result) => result.stepId === steps.find((step) => step.nodeId === "child-check")?.id
    );
    const parentResult = verifications.find(
      (result) => result.stepId === steps.find((step) => step.nodeId === "parent-check")?.id
    );

    assert.ok(childResult, "子流程验证应写入结果");
    assert.ok(parentResult, "父流程验证应写入结果");
    assert.ok(childResult.evidence.includes("父流程课标 · local"), "子流程应继承父流程证据");
    assert.ok(childResult.evidence.includes("子流程课标 · local"), "子流程应吸收自身检索证据");
    assert.ok(parentResult.evidence.includes("父流程课标 · local"));
    assert.ok(parentResult.evidence.includes("子流程课标 · local"), "父流程应合并子流程证据");
  } finally {
    dispose();
  }
});

test("does not fabricate citations for non-knowledge stub tools", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "stub-tool-evidence-probe",
    name: "假引用探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "report", kind: "tool", tool: "report.build", args: { title: "报告" } },
      {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        rubric: ["证据支撑"],
        threshold: 0.5
      }
    ],
    edges: [{ from: "report", to: "check" }]
  };

  try {
    const { run, steps } = await new WorkflowExecutor(store).run(workflow, {});
    const reportOutput = steps.find((step) => step.nodeId === "report")?.output as
      | Record<string, unknown>
      | undefined;
    assert.equal(reportOutput?.citations, undefined);

    const result = store.listVerifyResults(run.id)[0];
    assert.ok(result);
    assert.deepEqual(result.evidence, []);
    assert.ok(result.issues.some((issue) => issue.includes("证据引用")));
  } finally {
    dispose();
  }
});

test("stub mode delegates knowledge.search to the deterministic handler", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "kb-probe",
    name: "知识库探针",
    version: 1,
    inputs: [],
    nodes: [
      {
        id: "retrieve",
        kind: "tool",
        tool: "knowledge.search",
        args: { query: "分数的意义", knowledgeBaseIds: ["kb-1"], topK: 3 }
      }
    ],
    edges: []
  };
  const calls: Array<Record<string, unknown>> = [];
  try {
    const executor = new WorkflowExecutor(store, {
      knowledgeTool: async (node, input) => {
        if (node.tool !== "knowledge.search") return undefined;
        calls.push(input);
        return {
          mode: "live",
          tool: node.tool,
          summary: "命中 1 条引用",
          citations: [
            {
              id: "local-1",
              documentName: "义务教育数学课程标准（2022年版）",
              knowledgeBaseName: "课标库",
              snippet: "分数的意义在于把单位“1”平均分。",
              source: "local",
              score: 0.9
            }
          ],
          output: "[1] 课标片段"
        };
      }
    });
    const { run, steps } = await executor.run(workflow, {});

    assert.equal(run.mode, "stub");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].knowledgeBaseIds, ["kb-1"]);
    const citations = (steps[0]?.output as { citations: Array<{ id: string }> }).citations;
    assert.equal(citations.length, 1);
    assert.equal(citations[0]?.id, "local-1");
  } finally {
    dispose();
  }
});

test("start forwards workflow input and end maps upstream artifacts", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "anchor-run-probe",
    name: "锚点执行探针",
    version: 1,
    inputs: [{ name: "topic", type: "string", required: true }],
    nodes: [
      { id: "begin", kind: "start" },
      { id: "think", kind: "llm", prompt: "围绕 ${input.topic} 写要点" },
      { id: "finish", kind: "end", inputs: { draft: "${think.output}", topic: "${input.topic}" } }
    ],
    edges: [
      { from: "begin", to: "think" },
      { from: "think", to: "finish" }
    ]
  };

  try {
    const { run, steps } = await new WorkflowExecutor(store).run(workflow, {
      topic: "分数的意义"
    });
    assert.equal(run.status, "succeeded");

    const begin = steps.find((step) => step.nodeId === "begin");
    assert.ok(begin);
    assert.deepEqual(begin.input, { topic: "分数的意义" });
    const beginOutput = begin.output as Record<string, unknown>;
    assert.equal(beginOutput.kind, "start");
    assert.deepEqual(beginOutput.input, { topic: "分数的意义" });

    const finish = steps.find((step) => step.nodeId === "finish");
    assert.ok(finish);
    const finishOutput = finish.output as Record<string, unknown>;
    assert.equal(finishOutput.kind, "end");
    const mapped = finishOutput.outputs as Record<string, unknown>;
    assert.equal(mapped.topic, "分数的意义");
    assert.match(String(mapped.draft), /stub:llm/);
  } finally {
    dispose();
  }
});

test("knowledge nodes call the knowledge handler with query, bases and topK", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "knowledge-node-probe",
    name: "知识节点探针",
    version: 1,
    inputs: [{ name: "topic", type: "string", required: true }],
    nodes: [
      {
        id: "recall",
        kind: "knowledge",
        query: "${input.topic} 的课标要求",
        knowledgeBaseIds: ["kb-1"],
        topK: 3
      }
    ],
    edges: []
  };
  const calls: Array<Record<string, unknown>> = [];

  try {
    const { run, steps } = await new WorkflowExecutor(store, {
      knowledgeNode: async (_node, input) => {
        calls.push(input);
        return {
          mode: "live",
          kind: "knowledge",
          tool: "knowledge.search",
          summary: "命中 1 条引用",
          citations: [{ id: "local-1", documentName: "课标", source: "local" }]
        };
      }
    }).run(workflow, { topic: "分数的意义" });

    assert.equal(run.status, "succeeded");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      query: "分数的意义 的课标要求",
      knowledgeBaseIds: ["kb-1"],
      topK: 3
    });
    const output = steps[0]?.output as { kind?: string; citations?: unknown[] };
    assert.equal(output.kind, "knowledge");
    assert.equal(output.citations?.length, 1);
  } finally {
    dispose();
  }
});

test("http nodes stay in stub mode without network access when no handler is configured", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "http-stub-probe",
    name: "HTTP stub 探针",
    version: 1,
    inputs: [],
    nodes: [
      {
        id: "fetch",
        kind: "http",
        method: "GET",
        url: "https://example.com/api/plan",
        headers: { authorization: "Bearer secret" }
      }
    ],
    edges: []
  };

  try {
    const { run, steps } = await new WorkflowExecutor(store).run(workflow, {});
    assert.equal(run.status, "succeeded");
    const output = steps[0]?.output as Record<string, unknown>;
    assert.equal(output.kind, "http");
    assert.equal(output.mode, "stub");
    assert.equal(output.method, "GET");
    assert.equal(output.url, "https://example.com/api/plan");
    assert.match(String(output.output), /未实际发送/);
  } finally {
    dispose();
  }
});

test("rejects loopback, private and metadata HTTP targets", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("10.0.0.8"), true);
  assert.equal(isPrivateAddress("172.20.1.1"), true);
  assert.equal(isPrivateAddress("192.168.1.10"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("::ffff:10.0.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);

  await assert.rejects(() => assertSafeHttpUrl("http://127.0.0.1/admin"), /内网|保留地址/);
  await assert.rejects(() => assertSafeHttpUrl("http://169.254.169.254/latest/meta-data"), /内网|保留地址/);
  await assert.rejects(() => assertSafeHttpUrl("http://localhost:3000/api"), /内网|元数据/);
  await assert.rejects(() => assertSafeHttpUrl("file:///etc/passwd"), /http/);
  await assert.rejects(() => assertSafeHttpUrl("https://user:pass@example.com"), /用户名或密码/);
});

test("follows the branch selected by a condition", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "condition-probe",
    name: "条件分支探针",
    version: 1,
    inputs: [{ name: "pass", type: "boolean", required: true }],
    nodes: [
      {
        id: "gate",
        kind: "condition",
        when: "${input.pass} == true",
        then: [{ id: "advance", kind: "agent", agent: "reviewer-agent" }],
        else: [{ id: "rework", kind: "agent", agent: "coach-agent" }]
      }
    ],
    edges: []
  };
  try {
    const passed = await new WorkflowExecutor(store).run(workflow, { pass: true });
    assert.deepEqual(
      passed.steps.map((step) => step.nodeId),
      ["advance"]
    );

    const failed = await new WorkflowExecutor(store).run(workflow, { pass: false });
    assert.deepEqual(
      failed.steps.map((step) => step.nodeId),
      ["rework"]
    );
  } finally {
    dispose();
  }
});

test("start returns a queued record and execution continues through to success", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
  assert.ok(workflow);
  try {
    const started = new WorkflowExecutor(store).start(workflow, {
      topic: "分数的意义",
      subject: "数学",
      grade: "五年级"
    });
    assert.equal(started.workflowId, "classroom-v1");
    assert.equal(started.status, "queued");
    assert.equal(started.stepCount, 0);

    let current = store.getRun(started.id)!;
    const terminal = new Set(["succeeded", "failed", "rolled_back"]);
    for (let attempt = 0; attempt < 200 && !terminal.has(current.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = store.getRun(started.id)!;
    }
    assert.equal(current.status, "succeeded");
    assert.equal(store.listSteps(started.id).length, 12);
  } finally {
    dispose();
  }
});

test("retryStep appends a step without changing the original run status", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "retry-probe",
    name: "单步重跑探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "boom", kind: "agent", agent: "broken-agent" }],
    edges: []
  };
  try {
    store.saveWorkflow(workflow);
    const failing = new WorkflowExecutor(store, {
      agent: () => {
        throw new Error("模型不可用");
      }
    });
    const { run, steps } = await failing.run(workflow);
    assert.equal(run.status, "failed");
    const original = steps[0];
    assert.ok(original);

    const recovered = new WorkflowExecutor(store, {
      agent: () => ({ mode: "live", output: "recovered" })
    });
    const retried = await recovered.retryStep(run.id, original.id);
    assert.equal(retried.status, "succeeded");
    assert.equal(retried.sequence, 2);
    assert.equal(retried.path, original.path);
    assert.deepEqual(retried.input, original.input);
    assert.equal(store.getRun(run.id)?.status, "failed");
    assert.equal(store.listSteps(run.id).length, 2);
  } finally {
    dispose();
  }
});

test("retries a failing node twice before marking the run failed and keeps the trace", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "failure-probe",
    name: "失败探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "boom", kind: "agent", agent: "broken-agent" }],
    edges: []
  };
  try {
    let calls = 0;
    const executor = new WorkflowExecutor(
      store,
      {
        agent: () => {
          calls += 1;
          throw new Error(`模型不可用（第 ${calls} 次）`);
        }
      },
      { maxAttempts: 3, retryBaseDelayMs: 1, timeoutMs: 1000 }
    );
    const { run, steps } = await executor.run(workflow);
    assert.equal(calls, 3);
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /第 3 次/);
    assert.equal(steps.length, 1);
    assert.equal(steps[0]?.status, "failed");
    assert.equal(steps[0]?.attempts, 3);
    assert.match(steps[0]?.error ?? "", /模型不可用（第 3 次）/);
    assert.match(steps[0]?.error ?? "", /at /);
  } finally {
    dispose();
  }
});

test("recovers when a retry succeeds and records the attempt count", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "recover-probe",
    name: "重试恢复探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "flaky", kind: "agent", agent: "flaky-agent" }],
    edges: []
  };
  try {
    let calls = 0;
    const executor = new WorkflowExecutor(
      store,
      {
        agent: () => {
          calls += 1;
          if (calls < 3) {
            throw new Error("临时波动");
          }
          return { mode: "live", output: "recovered" };
        }
      },
      { maxAttempts: 3, retryBaseDelayMs: 1, timeoutMs: 1000 }
    );
    const { run, steps } = await executor.run(workflow);
    assert.equal(run.status, "succeeded");
    assert.equal(calls, 3);
    assert.equal(steps[0]?.status, "succeeded");
    assert.equal(steps[0]?.attempts, 3);
    assert.equal(steps[0]?.error, undefined);
    assert.deepEqual(steps[0]?.output, { mode: "live", output: "recovered" });
  } finally {
    dispose();
  }
});

test("reschedules an agent step to the next candidate after an invocation failure", async () => {
  const { store, dispose } = createStore();
  const capability = "调度重排探针技能";
  store.saveAgent({
    id: "primary-agent",
    name: "主 Agent",
    version: 1,
    role: "报告写作",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities: [{ tag: capability, weight: 0.9 }],
    memory: {},
    enabled: true
  });
  store.saveAgent({
    id: "backup-agent",
    name: "备用 Agent",
    version: 1,
    role: "报告写作",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities: [{ tag: capability, weight: 0.6 }],
    memory: {},
    enabled: true
  });
  const workflow: WorkflowDefinition = {
    id: "reschedule-probe",
    name: "运行中重调度探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "write", kind: "agent", agent: "primary-agent" }],
    edges: []
  };
  try {
    store.saveWorkflow(workflow);
    const seen: string[] = [];
    const executor = new WorkflowExecutor(
      store,
      {
        agent: (node) => {
          seen.push(node.agent);
          // 租约代表真实执行中的步骤，失败或换 Agent 前都应处于在飞状态。
          assert.equal(store.activeLeaseLoads()[node.agent]?.inFlight, 1);
          if (node.agent === "primary-agent") {
            throw new Error("主 Agent 超时");
          }
          return { mode: "live", output: "备用 Agent 完成" };
        }
      },
      { maxAttempts: 3, retryBaseDelayMs: 1, timeoutMs: 1000 }
    );
    const { run, steps } = await executor.run(workflow);
    assert.equal(run.status, "succeeded");
    assert.deepEqual(seen, ["primary-agent", "backup-agent"]);
    assert.equal(steps[0]?.attempts, 2);
    const input = steps[0]?.input as Record<string, unknown>;
    const reschedule = input.reschedule as Record<string, unknown>;
    assert.equal(reschedule.from, "primary-agent");
    assert.equal(reschedule.to, "backup-agent");
    assert.match(String(reschedule.reason), /运行中重调度/);

    const leases = store
      .listSchedulerLeases({ runId: run.id })
      .map((lease) => [lease.agentId, lease.status, lease.releaseReason])
      .sort();
    assert.deepEqual(leases, [
      ["backup-agent", "released", "completed"],
      ["primary-agent", "released", "rescheduled"]
    ]);
    assert.deepEqual(store.activeLeaseLoads(), {});
  } finally {
    dispose();
  }
});

test("orders the ready queue by critical-path priority and records queue waits", async () => {
  const { store, dispose } = createStore();
  store.seedAgents(BUILTIN_AGENTS);
  const workflow: WorkflowDefinition = {
    id: "priority-queue-probe",
    name: "优先级队列探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "short", kind: "agent", agent: "topic-innovation-agent" },
      { id: "long", kind: "agent", agent: "lesson-plan-agent" },
      { id: "tail", kind: "agent", agent: "student-silent-agent" }
    ],
    edges: [{ from: "long", to: "tail" }]
  };
  try {
    store.saveWorkflow(workflow);
    const seen: string[] = [];
    const executor = new WorkflowExecutor(
      store,
      {
        agent: async (node) => {
          seen.push(node.id);
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { mode: "live", output: `${node.id} 完成` };
        }
      },
      { maxConcurrency: 1, maxAttempts: 1, retryBaseDelayMs: 1, timeoutMs: 0 }
    );
    const { run } = await executor.run(workflow);
    assert.equal(run.status, "succeeded");
    // long 的关键路径更深，先于 short 出队；tail 与 short 同级时按声明顺序。
    assert.deepEqual(seen, ["long", "short", "tail"]);

    const queue = store.listSchedulerQueue(run.id);
    assert.deepEqual([...queue.map((entry) => entry.path)].sort(), ["long", "short", "tail"]);
    assert.ok(queue.every((entry) => entry.status === "succeeded"));
    const short = queue.find((entry) => entry.path === "short");
    assert.ok((short?.waitMs ?? 0) >= 15);
  } finally {
    dispose();
  }
});

test("reassigns a step after its simulated worker is killed", async () => {
  const { store, dispose } = createStore();
  const capability = "Worker 终止重派技能";
  store.saveAgent({
    id: "primary-agent",
    name: "主 Agent",
    version: 1,
    role: "报告写作",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities: [{ tag: capability, weight: 0.9 }],
    memory: {},
    enabled: true
  });
  store.saveAgent({
    id: "backup-agent",
    name: "备用 Agent",
    version: 1,
    role: "报告写作",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities: [{ tag: capability, weight: 0.6 }],
    memory: {},
    enabled: true
  });
  const workflow: WorkflowDefinition = {
    id: "worker-kill-probe",
    name: "Worker 终止探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "write", kind: "agent", agent: "primary-agent", capabilities: [capability] }],
    edges: []
  };
  try {
    store.saveWorkflow(workflow);
    let signalPrimary!: () => void;
    const primaryStarted = new Promise<void>((resolve) => {
      signalPrimary = resolve;
    });
    const seen: string[] = [];
    const executor = new WorkflowExecutor(
      store,
      {
        agent: async (node) => {
          seen.push(node.agent);
          if (node.agent === "primary-agent") {
            signalPrimary();
            await new Promise<never>(() => {});
          }
          return { mode: "live", output: "备用 Agent 完成" };
        }
      },
      { maxAttempts: 3, retryBaseDelayMs: 1, timeoutMs: 0 }
    );
    const pending = executor.run(workflow);
    await primaryStarted;
    const worker = executor.listWorkers().find((item) => !item.killed && item.activeTasks.length > 0);
    assert.ok(worker);
    const killed = executor.killWorker(worker!.id);
    assert.equal(killed.aborted, 1);

    const { run, steps } = await pending;
    assert.equal(run.status, "succeeded");
    assert.deepEqual(seen, ["primary-agent", "backup-agent"]);
    const leases = store.listSchedulerLeases({ runId: run.id });
    assert.equal(
      leases.find((lease) => lease.agentId === "primary-agent")?.releaseReason,
      "worker_lost"
    );
    assert.equal(
      leases.find((lease) => lease.agentId === "backup-agent")?.releaseReason,
      "completed"
    );
    const reschedule = (steps[0]?.input as { reschedule?: { reason?: string } }).reschedule;
    assert.match(String(reschedule?.reason), /运行中重调度|Worker/);
  } finally {
    dispose();
  }
});

test("requeues a run whose worker lease expired", async () => {
  const { store, dispose } = createStore();
  store.seedAgents(BUILTIN_AGENTS);
  const workflow: WorkflowDefinition = {
    id: "orphan-probe",
    name: "孤儿回收探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "write", kind: "agent", agent: "topic-innovation-agent" }],
    edges: []
  };
  try {
    store.saveWorkflow(workflow);
    const old = store.createRun({
      workflowId: workflow.id,
      workflowVersion: 1,
      workflowInput: {},
      mode: "stub",
      status: "running",
      definition: workflow
    });
    store.acquireSchedulerLease({
      runId: old.id,
      taskPath: "write",
      agentId: "topic-innovation-agent",
      workerId: "dead-worker",
      ttlMs: 1000
    });
    store.expireSchedulerLeases(Date.now() + 5000);

    const result = await new WorkflowExecutor(store).requeueOrphanedRuns();
    assert.equal(result.requeued.length, 1);
    assert.equal(store.getRun(old.id)?.status, "failed");
    assert.match(store.getRun(old.id)?.error ?? "", /Worker 失联/);
    const requeued = store.getRun(result.requeued[0]!.runId);
    assert.equal(requeued?.status, "succeeded");
  } finally {
    dispose();
  }
});

test("resumes from the latest checkpoint without re-running completed nodes", async () => {
  const { store, dispose } = createStore();
  store.seedAgents(BUILTIN_AGENTS);
  const workflow: WorkflowDefinition = {
    id: "resume-probe",
    name: "检查点续跑探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "first", kind: "agent", agent: "topic-innovation-agent" },
      {
        id: "second",
        kind: "agent",
        agent: "topic-innovation-agent",
        inputs: { draft: "${first.output}" }
      }
    ],
    edges: [{ from: "first", to: "second" }]
  };
  try {
    store.saveWorkflow(workflow);
    const seen: string[] = [];
    let failSecond = true;
    const executor = new WorkflowExecutor(
      store,
      {
        agent: async (node) => {
          seen.push(node.id);
          if (node.id === "second" && failSecond) {
            failSecond = false;
            throw new Error("模拟节点崩溃");
          }
          return { mode: "stub", output: `${node.id}:ok` };
        }
      },
      { maxAttempts: 1 }
    );
    const first = await executor.run(workflow, {});
    assert.equal(first.run.status, "failed");

    const checkpoint = store.latestRunCheckpoint(first.run.id);
    assert.ok(checkpoint, "已完成部分节点后应写入检查点");
    const savedNodes = checkpoint.state.nodes as Record<string, unknown>;
    assert.ok("first" in savedNodes);
    assert.ok(!("second" in savedNodes));

    const resumed = executor.startResume(first.run.id);
    const finished = await executor.waitForRun(resumed.id, 5000);
    assert.equal(finished?.status, "succeeded");
    assert.equal(finished?.resumeCount, 1);
    // 续跑只重跑未完成节点，first 的产物直接从检查点回放。
    assert.deepEqual(seen, ["first", "second", "second"]);
    assert.deepEqual(
      store.listSteps(resumed.id).map((step) => step.nodeId),
      ["second"]
    );
    assert.match(JSON.stringify(store.listSteps(resumed.id)[0]?.input ?? {}), /first:ok/);
    assert.equal(store.getRun(first.run.id)?.status, "failed");
  } finally {
    dispose();
  }
});

test("observes a cancellation requested by another process via the database flag", async () => {
  const { store, dispose } = createStore();
  store.seedAgents(BUILTIN_AGENTS);
  const workflow: WorkflowDefinition = {
    id: "cross-process-cancel-probe",
    name: "跨进程取消探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "slow", kind: "agent", agent: "topic-innovation-agent" }],
    edges: []
  };
  try {
    store.saveWorkflow(workflow);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = new WorkflowExecutor(
      store,
      {
        agent: async () => {
          await gate;
          return { mode: "stub", output: "迟到的产物" };
        }
      },
      { cancelPollMs: 10, timeoutMs: 0 }
    );
    const pending = executor.run(workflow, {});
    const running = await waitFor("慢节点进入运行", () =>
      store.listRuns(5).find((run) => run.id && run.status === "running" && run.workflowId === workflow.id)
    );
    // 另一个进程只写数据库标记，不持有本进程的执行器句柄。
    store.requestRunCancel(running.id);

    const result = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("跨进程取消未在 3s 内生效")), 3000)
      )
    ]);
    assert.equal(result.run.status, "cancelled");
    assert.match(result.run.error ?? "", /取消/);
    release();
  } finally {
    dispose();
  }
});

test("persists opt-in agent memory across runs and recalls it into the next prompt", async () => {
  const { store, dispose } = createStore();
  store.saveAgent({
    id: "memory-agent",
    name: "记忆 Agent",
    version: 1,
    role: "写作",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities: [{ tag: "跨运行记忆探针", weight: 0.9 }],
    memory: { persist: true, retain: ["summary"], maxEntries: 2, recall: 2 },
    enabled: true
  });
  const workflow: WorkflowDefinition = {
    id: "memory-probe",
    name: "跨运行记忆探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "remember", kind: "agent", agent: "memory-agent" }],
    edges: []
  };
  try {
    store.saveWorkflow(workflow);
    const seen: Array<Record<string, unknown>> = [];
    const executor = new WorkflowExecutor(store, {
      agent: (_node, input) => {
        seen.push(input);
        return { mode: "live", output: { summary: `第 ${seen.length} 次摘要` } };
      }
    });
    await executor.run(workflow);
    await executor.run(workflow);
    await executor.run(workflow);

    assert.equal(seen[0]?.memoryHistory, undefined);
    const recalled = seen[2]?.memoryHistory as Array<{ key: string; value: string }>;
    assert.equal(recalled.length, 2);
    assert.deepEqual(
      recalled.map((item) => item.value),
      ["第 2 次摘要", "第 1 次摘要"]
    );
    assert.equal(store.listAgentMemory("memory-agent", workflow.id, 10).length, 2);
  } finally {
    dispose();
  }
});

test("times out a hanging node, retries, then fails with the timeout reason", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "timeout-probe",
    name: "超时探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "slow", kind: "agent", agent: "slow-agent" }],
    edges: []
  };
  try {
    let calls = 0;
    const executor = new WorkflowExecutor(
      store,
      {
        agent: () => {
          calls += 1;
          return new Promise(() => {});
        }
      },
      { maxAttempts: 2, retryBaseDelayMs: 1, timeoutMs: 15 }
    );
    const { run, steps } = await executor.run(workflow);
    assert.equal(calls, 2);
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /步骤执行超时/);
    assert.equal(steps[0]?.attempts, 2);
    assert.match(steps[0]?.error ?? "", /步骤执行超时/);
  } finally {
    dispose();
  }
});

test("rolls back to the latest successful snapshot instead of failing", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "rollback-probe",
    name: "回滚探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "draft", kind: "agent", agent: "writer-agent" },
      { id: "boom", kind: "agent", agent: "broken-agent" }
    ],
    edges: [{ from: "draft", to: "boom" }]
  };
  try {
    const executor = new WorkflowExecutor(
      store,
      {
        agent: (node) => {
          if (node.id === "boom") {
            throw new Error("模型不可用");
          }
          return { mode: "live", output: "draft-ok" };
        }
      },
      { maxAttempts: 1, retryBaseDelayMs: 1, timeoutMs: 1000, rollbackOnFailure: true }
    );
    const { run, steps } = await executor.run(workflow);
    assert.equal(run.status, "rolled_back");
    assert.equal(run.output?.rolledBackTo, "draft");
    assert.equal(typeof run.output?.stepId, "string");
    assert.match(run.error ?? "", /模型不可用/);
    assert.deepEqual(
      steps.map((step) => [step.nodeId, step.status]),
      [
        ["draft", "succeeded"],
        ["boom", "failed"]
      ]
    );
    assert.equal(store.latestSnapshot(run.id)?.path, "draft");
  } finally {
    dispose();
  }
});

test("walks the run state machine through verifying and revising", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "status-probe",
    name: "状态机探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "draft", kind: "agent", agent: "writer-agent" },
      {
        id: "check",
        kind: "verify",
        verifier: "rubric-verifier",
        rubric: ["目标达成"],
        threshold: 0.9
      },
      {
        id: "revise-loop",
        kind: "loop",
        maxIterations: 1,
        body: [{ id: "revise", kind: "agent", agent: "writer-agent" }]
      }
    ],
    edges: [
      { from: "draft", to: "check" },
      { from: "check", to: "revise-loop" }
    ]
  };
  try {
    const statuses: RunStatus[] = [];
    const executor = new WorkflowExecutor(store, {}, {
      maxAttempts: 1,
      onStatusChange: (_runId, status) => statuses.push(status)
    });
    const { run } = await executor.run(workflow);
    assert.equal(run.status, "succeeded");
    assert.ok(statuses.includes("queued"));
    assert.ok(statuses.includes("running"));
    assert.ok(statuses.includes("verifying"));
    assert.ok(statuses.includes("revising"));
    assert.ok(statuses.indexOf("verifying") < statuses.indexOf("revising"));
    assert.equal(statuses[statuses.length - 1], "succeeded");
  } finally {
    dispose();
  }
});

test("self-loop records two rounds, revision directives and a stop reason", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
  assert.ok(workflow);
  try {
    const { run, steps } = await new WorkflowExecutor(store, knowledgeHandlers()).run(workflow, {
      topic: "分数的意义",
      subject: "数学",
      grade: "五年级"
    });

    const iterations = store.listLoopIterations(run.id);
    assert.deepEqual(
      iterations.map((iteration) => iteration.action),
      ["rewrite", "retrieve"]
    );
    assert.match(iterations[0]?.changes.join(" ") ?? "", /下一轮动作：补检索/);
    assert.match(iterations[1]?.changes.join(" ") ?? "", /停止原因：达到最大轮次/);

    const revisions = steps.filter((step) => step.nodeId === "revise");
    assert.equal(revisions.length, 2);
    const directive = (revisions[0]?.input as { selfLoop?: Record<string, unknown> }).selfLoop;
    assert.equal(directive?.action, "rewrite");
    assert.equal(directive?.targetScore, 0.85);
    assert.ok(Array.isArray(directive?.issues) && directive.issues.length > 0);

    const summaries = (run.output?.selfLoop ?? []) as Array<Record<string, unknown>>;
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.iterations, 2);
    assert.equal(summaries[0]?.stopReason, "max_iterations");
    assert.equal(summaries[0]?.bestScore, 0.6663);
    assert.equal(
      (summaries[0]?.promotion as { status?: string } | undefined)?.status,
      "skipped",
      "stub 模式不应把演练补丁写进 Agent 版本"
    );
    assert.ok(typeof run.output?.tokensUsed === "number" && run.output.tokensUsed > 0);
  } finally {
    dispose();
  }
});

test("self-loop swaps the revision agent after a stalled round and stops on patience", async () => {
  const { store, dispose } = createStore();
  store.saveAgent({
    id: "weak-agent",
    name: "普通教案 Agent",
    version: 1,
    role: "教案设计",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities: [{ tag: "教案设计", weight: 0.6 }],
    memory: {},
    enabled: true
  });
  store.saveAgent({
    id: "strong-agent",
    name: "资深教案 Agent",
    version: 1,
    role: "教案设计",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities: [{ tag: "教案设计", weight: 0.9 }],
    memory: {},
    enabled: true
  });

  const workflow: WorkflowDefinition = {
    id: "self-loop-swap-probe",
    name: "换 Agent 探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "initial", kind: "verify", verifier: "probe-verifier", threshold: 0.95 },
      {
        id: "loop",
        kind: "loop",
        maxIterations: 5,
        while: "${verify-loop.score} < 0.95",
        patience: 2,
        body: [
          {
            id: "revise",
            kind: "agent",
            agent: "weak-agent",
            inputs: { draft: "初稿" }
          },
          { id: "verify-loop", kind: "verify", verifier: "probe-verifier", threshold: 0.95 }
        ]
      }
    ],
    edges: [{ from: "initial", to: "loop" }]
  };

  try {
    const executor = new WorkflowExecutor(store, {
      agent: (node) => ({ agent: node.agent, output: `${node.agent} 的输出` }),
      verify: () => ({
        score: 0.7,
        confidence: 0.8,
        dimensions: [],
        issues: ["互动覆盖不足"],
        evidence: []
      })
    });
    const { run, steps } = await executor.run(workflow);

    const iterations = store.listLoopIterations(run.id);
    assert.deepEqual(
      iterations.map((iteration) => iteration.action),
      ["rewrite", "rewrite", "swap_agent"]
    );
    assert.match(iterations[1]?.changes.join(" ") ?? "", /改用 普通教案 Agent/);

    const revisions = steps.filter((step) => step.nodeId === "revise");
    assert.deepEqual(
      revisions.map((step) => (step.output as { agent?: string }).agent),
      ["strong-agent", "strong-agent", "weak-agent"]
    );
    const swapped = (revisions[2]?.input as { selfLoop?: Record<string, unknown> }).selfLoop;
    assert.equal(swapped?.action, "swap_agent");
    assert.equal(swapped?.previousAgentId, "strong-agent");
    assert.equal(swapped?.agentId, "weak-agent");

    const summary = ((run.output?.selfLoop ?? []) as Array<Record<string, unknown>>)[0];
    assert.equal(summary?.iterations, 3);
    assert.equal(summary?.stopReason, "no_improvement");
  } finally {
    dispose();
  }
});

test("skips the loop when the initial verification already meets the threshold", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "self-loop-skip-probe",
    name: "达标跳过探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "initial", kind: "verify", verifier: "probe-verifier", threshold: 0.3 },
      {
        id: "loop",
        kind: "loop",
        maxIterations: 2,
        while: "${verify-loop.score} < 0.3",
        body: [
          { id: "revise", kind: "agent", agent: "weak-agent", inputs: { draft: "初稿" } },
          { id: "verify-loop", kind: "verify", verifier: "probe-verifier", threshold: 0.3 }
        ]
      }
    ],
    edges: [{ from: "initial", to: "loop" }]
  };

  try {
    const { run, steps } = await new WorkflowExecutor(store).run(workflow);
    assert.deepEqual(
      steps.map((step) => step.nodeId),
      ["initial"]
    );
    assert.equal(store.listLoopIterations(run.id).length, 0);
    const summary = ((run.output?.selfLoop ?? []) as Array<Record<string, unknown>>)[0];
    assert.equal(summary?.iterations, 0);
    assert.equal(summary?.bestIteration, 0);
    assert.equal(summary?.stopReason, "passed");
  } finally {
    dispose();
  }
});

type LoopProbeResult = {
  run: Awaited<ReturnType<WorkflowExecutor["run"]>>["run"];
  steps: Awaited<ReturnType<WorkflowExecutor["run"]>>["steps"];
  summary: Record<string, unknown> | undefined;
  iterations: ReturnType<PlatformStateStore["listLoopIterations"]>;
};

async function runLoopProbe(scores: number[]): Promise<LoopProbeResult> {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "best-artifact-probe",
    name: "最优产物探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "draft", kind: "agent", agent: "writer-agent" },
      { id: "verify-initial", kind: "verify", verifier: "probe-verifier", threshold: 0.95 },
      {
        id: "loop",
        kind: "loop",
        maxIterations: 2,
        while: "${verify-loop.score} < 0.95",
        patience: 3,
        body: [
          {
            id: "revise",
            kind: "agent",
            agent: "writer-agent",
            inputs: { draft: "${draft.output}" }
          },
          { id: "verify-loop", kind: "verify", verifier: "probe-verifier", threshold: 0.95 }
        ]
      },
      {
        id: "report",
        kind: "agent",
        agent: "report-agent",
        inputs: { draft: "${revise.output}", score: "${verify-loop.score}" }
      }
    ],
    edges: [
      { from: "draft", to: "verify-initial" },
      { from: "verify-initial", to: "loop" },
      { from: "loop", to: "report" }
    ]
  };

  let verifyIndex = 0;
  try {
    const executor = new WorkflowExecutor(store, {
      agent: (node, input) => {
        if (node.id === "report") {
          return { received: input };
        }
        const iteration = (input.selfLoop as { iteration?: number } | undefined)?.iteration ?? 0;
        return { output: node.id === "draft" ? "initial" : `round-${iteration}` };
      },
      verify: () => {
        const score = scores[verifyIndex] ?? scores[scores.length - 1] ?? 0;
        verifyIndex += 1;
        return {
          score,
          confidence: 0.9,
          dimensions: [],
          issues: score < 0.95 ? ["需要改进"] : [],
          evidence: []
        };
      }
    });
    const { run, steps } = await executor.run(workflow);
    const summary = ((run.output?.selfLoop ?? []) as Array<Record<string, unknown>>)[0];
    return {
      run,
      steps,
      summary,
      iterations: store.listLoopIterations(run.id)
    };
  } finally {
    dispose();
  }
}

test("self-loop keeps the best artifact when a later round regresses (up then down)", async () => {
  const { run, steps, summary, iterations } = await runLoopProbe([0.6, 0.7, 0.65]);
  assert.equal(run.status, "succeeded");
  assert.equal(run.output?.score, 0.7);
  assert.equal(summary?.bestIteration, 1);
  assert.equal(summary?.bestScore, 0.7);
  assert.equal(summary?.finalScore, 0.7);
  assert.equal(iterations.length, 2);

  const report = steps.find((step) => step.nodeId === "report");
  assert.deepEqual(report?.input, { draft: "round-1", score: 0.7 });
  assert.match(iterations[1]?.changes.join(" ") ?? "", /保留第 1 轮产物，丢弃第 2 轮/);
});

test("self-loop recovers from an early regression (down then up)", async () => {
  const { run, steps, summary, iterations } = await runLoopProbe([0.6, 0.55, 0.75]);
  assert.equal(run.status, "succeeded");
  assert.equal(run.output?.score, 0.75);
  assert.equal(summary?.bestIteration, 2);
  assert.equal(summary?.finalScore, 0.75);

  const report = steps.find((step) => step.nodeId === "report");
  assert.deepEqual(report?.input, { draft: "round-2", score: 0.75 });
  assert.match(iterations[1]?.changes.join(" ") ?? "", /第 2 轮为最优，保留该轮产物/);
});

test("self-loop restores the initial artifact when no round improves", async () => {
  const { run, steps, summary, iterations } = await runLoopProbe([0.6, 0.55, 0.5]);
  assert.equal(run.status, "succeeded");
  assert.equal(run.output?.score, 0.6);
  assert.equal(summary?.bestIteration, 0);
  assert.equal(summary?.bestScore, 0.6);
  assert.equal(summary?.finalScore, 0.6);

  const report = steps.find((step) => step.nodeId === "report");
  assert.deepEqual(report?.input, { draft: "initial", score: 0.6 });
  assert.match(iterations[1]?.changes.join(" ") ?? "", /保留初始产物，丢弃第 2 轮/);
  // 被丢弃轮次的验证证据仍留在库里，不删除。
  assert.equal(iterations.length, 2);
});

test("loop scope exposes the previous round's artifact, issues and score", async () => {
  const { store, dispose } = createStore();
  const reviseInputs: Array<Record<string, unknown>> = [];
  const workflow: WorkflowDefinition = {
    id: "loop-scope-probe",
    name: "循环作用域探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "draft", kind: "agent", agent: "writer-agent" },
      { id: "verify-initial", kind: "verify", verifier: "probe-verifier", threshold: 0.95 },
      {
        id: "loop",
        kind: "loop",
        maxIterations: 2,
        while: "${verify-loop.score} < 0.95",
        patience: 3,
        body: [
          {
            id: "revise",
            kind: "agent",
            agent: "writer-agent",
            inputs: {
              draft: "${loop.artifact}",
              issues: "${loop.issues}",
              score: "${loop.score}",
              round: "${loop.iteration}"
            }
          },
          { id: "verify-loop", kind: "verify", verifier: "probe-verifier", threshold: 0.95 }
        ]
      }
    ],
    edges: [
      { from: "draft", to: "verify-initial" },
      { from: "verify-initial", to: "loop" }
    ]
  };

  const scores = [0.6, 0.7, 0.65];
  let verifyIndex = 0;
  try {
    const executor = new WorkflowExecutor(store, {
      agent: (node, input) => {
        if (node.id === "draft") {
          return { output: "initial" };
        }
        reviseInputs.push(input);
        const iteration = (input.selfLoop as { iteration?: number } | undefined)?.iteration ?? 0;
        return { output: `round-${iteration}` };
      },
      verify: () => {
        const score = scores[verifyIndex] ?? scores[scores.length - 1] ?? 0;
        verifyIndex += 1;
        return { score, confidence: 0.9, dimensions: [], issues: ["需要改进"], evidence: [] };
      }
    });
    await executor.run(workflow);
  } finally {
    dispose();
  }

  assert.equal(reviseInputs.length, 2);
  assert.deepEqual(reviseInputs[0]?.draft, { output: "initial" });
  assert.deepEqual(reviseInputs[0]?.issues, ["需要改进"]);
  assert.equal(reviseInputs[0]?.score, 0.6);
  assert.equal(reviseInputs[0]?.round, 0);

  assert.deepEqual(reviseInputs[1]?.draft, { output: "round-1" });
  assert.deepEqual(reviseInputs[1]?.issues, ["需要改进"]);
  assert.equal(reviseInputs[1]?.score, 0.7);
  assert.equal(reviseInputs[1]?.round, 1);
});

test("keeps verification scores stable across repeated runs", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
  assert.ok(workflow);
  try {
    const executor = new WorkflowExecutor(store, knowledgeHandlers());
    const input = { topic: "分数的意义", subject: "数学", grade: "五年级" };
    const first = await executor.run(workflow, input);
    const second = await executor.run(workflow, input);
    const firstScores = store.listVerifyResults(first.run.id).map((result) => result.score);
    const secondScores = store.listVerifyResults(second.run.id).map((result) => result.score);
    assert.deepEqual(firstScores, secondScores);
  } finally {
    dispose();
  }
});

test("flags a deliberately wrong artifact with layered issues", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "wrong-answer-probe",
    name: "错误答案探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "draft", kind: "agent", agent: "writer-agent" },
      {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        rubric: ["目标达成", "证据支撑"],
        threshold: 0.8,
        required: ["教学目标"],
        expectedKeywords: ["分数的意义"]
      }
    ],
    edges: [{ from: "draft", to: "check" }]
  };

  try {
    const executor = new WorkflowExecutor(store, {
      agent: () => ({ draft: "TODO 待补充，先随便写点。" })
    });
    const { run } = await executor.run(workflow);
    const output = run.output as
      | { score?: number; verify?: { passed?: boolean; layers?: { rule: { score: number } } } }
      | undefined;
    assert.equal(run.status, "succeeded");
    assert.ok((output?.score ?? 1) < 0.5, `score=${output?.score}`);
    assert.equal(output?.verify?.passed, false);
    assert.ok((output?.verify?.layers?.rule.score ?? 1) < 0.5);

    const issues = store.listVerifyResults(run.id)[0]?.issues.join(" ") ?? "";
    assert.match(issues, /必需内容「教学目标」/);
    assert.match(issues, /占位标记/);
    assert.match(issues, /基准比对缺少要点：分数的意义/);
  } finally {
    dispose();
  }
});

test("number_match reads the reference bound through verify inputs", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "number-match-probe",
    name: "数值核对探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "source", kind: "agent", agent: "writer-agent" },
      { id: "analysis", kind: "agent", agent: "writer-agent" },
      {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        rubric: ["数据一致性"],
        threshold: 0.9,
        checks: [{ type: "number_match", tolerance: 0.01 }],
        inputs: { reference: "${source.output}" }
      }
    ],
    edges: [
      { from: "source", to: "analysis" },
      { from: "analysis", to: "check" }
    ]
  };
  let revenue = "1234.56";

  try {
    const executor = new WorkflowExecutor(store, {
      agent: (node) =>
        node.id === "source" ? { output: "营收 1,234.56 万元" } : { output: `营收 ${revenue} 万元` }
    });
    type VerifyOutput = { verify?: { layers?: { rule: { score: number } } } } | undefined;

    const good = await executor.run(workflow);
    const goodRule = (good.run.output as VerifyOutput)?.verify?.layers?.rule.score;
    assert.equal(goodRule, 1);

    revenue = "1500";
    const bad = await executor.run(workflow);
    const badRule = (bad.run.output as VerifyOutput)?.verify?.layers?.rule.score;
    assert.ok((badRule ?? 1) < 1, `rule=${badRule}`);
    assert.match(store.listVerifyResults(bad.run.id)[0]?.issues.join(" ") ?? "", /数值一致未通过/);
  } finally {
    dispose();
  }
});

test("business-analysis-v1 lets the model diagnose and repair a gross-profit error", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "business-analysis-v1");
  assert.ok(workflow);
  const entry = path.resolve("scripts", "data-analysis-mcp.mjs");
  const { client } = await McpClient.open({
    transport: "stdio",
    command: process.execPath,
    args: [entry]
  });
  store.seedAgents(BUILTIN_AGENTS);

  const promptPatch =
    "当数据包含退款字段时，revenueBasis 必须选择 net：净销售额 = 毛销售额 − 退款，毛利额 = 净销售额 − 销货成本；即使用户要求按订单销售额口径，也应在报告中说明差异并采用净额口径。";

  try {
    const executor = new WorkflowExecutor(store, {
      // 与 server/index.ts 的 mcpTool 接线一致：节点产物正文取 MCP 返回文本。
      mcpTool: async (node, input) => {
        const toolName = node.tool.split(".").pop() ?? "";
        const result = await client.callTool(toolName, input);
        const text = result.content
          .map((item) =>
            typeof item === "object" && item !== null && "text" in item
              ? String((item as { text?: unknown }).text ?? "")
              : ""
          )
          .join("\n");
        return {
          mode: "live",
          tool: node.tool,
          output: text,
          structuredContent: result.structuredContent,
          isError: result.isError
        };
      },
      // 仅模拟模型输出：规划与诊断由“模型”给出 JSON，报告逐字抄写工具返回的核算文本。
      agent: async (node, input) => {
        if (node.id === "plan") {
          const planner = store.getAgent("business-planner");
          const revenueBasis = planner?.prompt.includes("revenueBasis 必须选择 net")
            ? "net"
            : "gross";
          return {
            mode: "live",
            agent: node.agent,
            output: JSON.stringify({
              revenueBasis,
              rationale: `根据用户问题选择 ${revenueBasis} 口径。`,
              dimensions: ["region", "product"],
              acceptance: "毛利额与毛利率可被数值验证复算。"
            })
          };
        }
        if (node.id === "diagnose") {
          return {
            mode: "live",
            agent: node.agent,
            output: JSON.stringify({
              rootCause: "指标使用毛销售额口径，未扣除退款，导致毛利额与毛利率高估。",
              evidence: ["验证问题指出数值与净额口径基准不一致", "零售口径应对退款单独扣减"],
              action: "rewrite_agent",
              revenueBasis: "net",
              retrievalQuery: "退款 净销售额 毛利额 计算口径",
              promptPatch,
              confidence: 0.9
            })
          };
        }
        if (node.id === "report" || node.id === "report-fixed") {
          const basis = node.id === "report" ? "毛销售额（未扣退款）" : "净销售额（已扣退款）";
          const output = [
            "## 结论",
            "本期毛利表现需要区分毛销售额与净销售额口径，退款是主要差异来源。",
            "## 数据概况",
            String(input.profile ?? ""),
            "## 区域表现与品类表现",
            String(input.dataPack ?? ""),
            "## 毛利核算",
            String(input.metrics ?? ""),
            "## 口径说明",
            `本报告采用${basis}口径。`,
            "## 行动建议",
            "建议一：复核退款原因并按净额口径跟踪毛利。建议二：对高退款品类做专项复盘。"
          ].join("\n");
          return { mode: "live", agent: node.agent, output, summary: output.slice(0, 120) };
        }
        return {
          mode: "live",
          agent: node.agent,
          output: `[live:${node.agent}] ${node.title ?? node.id} 的输出`
        };
      }
    });
    const { run, steps } = await executor.run(workflow, {
      question: "本月各区域与品类的毛利表现如何？"
    });

    assert.equal(run.status, "succeeded");
    const verifyResults = store.listVerifyResults(run.id);
    assert.equal(verifyResults.length, 2);
    const [initial, repaired] = verifyResults;
    assert.ok(initial.score < 0.7, `initial=${initial.score}`);
    assert.equal(initial.issues.some((issue) => /数值一致未通过/.test(issue)), true);
    assert.ok(repaired.score >= 0.7, `repaired=${repaired.score}`);

    const loops = store.listLoopIterations(run.id);
    assert.equal(loops.length, 1);
    assert.ok((loops[0]?.scoreBefore ?? 1) < 0.7);
    assert.ok((loops[0]?.scoreAfter ?? 0) >= 0.7);
    assert.match(loops[0]?.changes.join(" ") ?? "", /决策来源：模型诊断/);
    assert.match(loops[0]?.changes.join(" ") ?? "", /提示词补丁/);

    const diagnosis = steps.find((step) => step.nodeId === "diagnose")?.output as
      | { output?: { revenueBasis?: string; action?: string; promptPatch?: string } }
      | undefined;
    assert.equal(diagnosis?.output?.action, "rewrite_agent");
    assert.equal(diagnosis?.output?.revenueBasis, "net");
    assert.equal(diagnosis?.output?.promptPatch, promptPatch);

    const metrics = steps.find((step) => step.nodeId === "metrics")?.output as
      | { structuredContent?: { revenueBasis?: string; grossProfit?: number } }
      | undefined;
    assert.equal(metrics?.structuredContent?.revenueBasis, "gross");
    assert.equal(metrics?.structuredContent?.grossProfit, 45990);

    const recalc = steps.find((step) => step.nodeId === "recalc")?.output as
      | { structuredContent?: { revenueBasis?: string; grossProfit?: number } }
      | undefined;
    assert.equal(recalc?.structuredContent?.revenueBasis, "net");
    assert.equal(recalc?.structuredContent?.grossProfit, 42290);

    const initialReport = steps.find((step) => step.nodeId === "report")?.output as
      | { output?: string }
      | undefined;
    assert.match(initialReport?.output ?? "", /毛利额：45,990\.00 元/);

    const repairedReport = steps.find((step) => step.nodeId === "report-fixed")?.output as
      | { output?: string }
      | undefined;
    assert.match(repairedReport?.output ?? "", /毛利额：42,290\.00 元/);
    assert.doesNotMatch(repairedReport?.output ?? "", /45,990\.00/);

    const summary = (run.output?.selfLoop as Array<Record<string, unknown>> | undefined)?.[0];
    assert.equal(summary?.iterations, 1);
    assert.equal(summary?.stopReason, "passed");
    const promotion = summary?.promotion as
      | { status?: string; agentId?: string; fromVersion?: number; toVersion?: number }
      | undefined;
    assert.equal(promotion?.status, "promoted");
    assert.equal(promotion?.agentId, "business-planner");
    assert.equal(promotion?.fromVersion, 1);
    assert.equal(promotion?.toVersion, 2);

    const planner = store.getAgent("business-planner");
    assert.equal(planner?.version, 2);
    assert.match(planner?.prompt ?? "", /revenueBasis 必须选择 net/);
    assert.equal(store.listAgentVersions("business-planner").length >= 1, true);

    // 第二次运行：规划 Agent 已带有 v2 补丁，首轮即选净额口径，不再触发自循环。
    const second = await executor.run(workflow, {
      question: "本月各区域与品类的毛利表现如何？"
    });
    assert.equal(second.run.status, "succeeded");
    const secondVerifications = store.listVerifyResults(second.run.id);
    assert.equal(secondVerifications.length, 1);
    assert.ok((secondVerifications[0]?.score ?? 0) >= 0.7);
    assert.equal(store.listLoopIterations(second.run.id).length, 0);
    const secondSummary = (second.run.output?.selfLoop as Array<Record<string, unknown>> | undefined)?.[0];
    assert.equal(secondSummary?.iterations, 0);
    assert.equal(secondSummary?.stopReason, "passed");
    const secondMetrics = second.steps.find((step) => step.nodeId === "metrics")?.output as
      | { structuredContent?: { revenueBasis?: string } }
      | undefined;
    assert.equal(secondMetrics?.structuredContent?.revenueBasis, "net");

    // 回滚到 v1 后补丁消失，可随时恢复晋升前的行为。
    store.rollbackAgent("business-planner", 1);
    const rolledBack = store.getAgent("business-planner");
    assert.equal(rolledBack?.version, 1);
    assert.doesNotMatch(rolledBack?.prompt ?? "", /revenueBasis 必须选择 net/);
  } finally {
    await client.close();
    dispose();
  }
});

test("refuses to promote a prompt patch that leaks answer numbers", async () => {
  const { store, dispose } = createStore();
  store.seedAgents(BUILTIN_AGENTS);
  const workflow: WorkflowDefinition = {
    id: "promotion-guard-probe",
    name: "补丁晋升安全探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "initial", kind: "verify", verifier: "probe-verifier", threshold: 0.8 },
      {
        id: "loop",
        kind: "loop",
        title: "补丁晋升",
        maxIterations: 1,
        body: [
          {
            id: "diagnose",
            kind: "agent",
            title: "诊断",
            agent: "business-diagnostician",
            loopRole: "diagnose",
            promoteToAgent: "business-planner",
            outputFormat: "json",
            outputContract: { required: ["action", "promptPatch"] },
            inputs: {}
          },
          { id: "fix", kind: "agent", title: "修复", agent: "business-reporter", inputs: {} },
          { id: "check", kind: "verify", verifier: "probe-verifier", threshold: 0.8 }
        ]
      }
    ],
    edges: [{ from: "initial", to: "loop" }]
  };
  let verifyCalls = 0;

  try {
    const { run } = await new WorkflowExecutor(store, {
      verify: (node) => {
        verifyCalls += 1;
        const score = verifyCalls === 1 ? 0.6 : 0.9;
        return {
          mode: "live",
          verifier: node.verifier,
          threshold: node.threshold ?? 0.8,
          score,
          confidence: 0.9,
          passed: score >= (node.threshold ?? 0.8),
          dimensions: [],
          issues: score < (node.threshold ?? 0.8) ? ["数值不一致"] : [],
          evidence: []
        };
      },
      agent: (node) => {
        if (node.id === "diagnose") {
          return {
            mode: "live",
            agent: node.agent,
            output: JSON.stringify({
              action: "rewrite_agent",
              promptPatch: "数据包含退款时必须选择净额口径，参考 42290 进行核对。"
            })
          };
        }
        return { mode: "live", agent: node.agent, output: "修复后的报告正文。" };
      }
    }).run(workflow);

    assert.equal(run.status, "succeeded");
    const summary = (run.output?.selfLoop as Array<Record<string, unknown>> | undefined)?.[0];
    const promotion = summary?.promotion as { status?: string; reason?: string } | undefined;
    assert.equal(promotion?.status, "rejected");
    assert.match(promotion?.reason ?? "", /答案数字/);
    assert.equal(store.getAgent("business-planner")?.version, 1);
  } finally {
    dispose();
  }
});

test("plans agent assignments before the run and executes the scheduled agent", async () => {
  const { store, dispose } = createStore();
  store.saveAgent({
    id: "weak-agent",
    name: "普通教案 Agent",
    version: 1,
    role: "教案设计",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities: [{ tag: "教案设计", weight: 0.6 }],
    memory: {},
    enabled: true
  });
  store.saveAgent({
    id: "strong-agent",
    name: "资深教案 Agent",
    version: 1,
    role: "教案设计",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities: [{ tag: "教案设计", weight: 0.95 }],
    memory: {},
    enabled: true
  });
  const workflow: WorkflowDefinition = {
    id: "scheduler-probe",
    name: "运行前调度探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "draft", kind: "agent", title: "撰写教案", agent: "weak-agent" }],
    edges: []
  };

  try {
    const { run, steps } = await new WorkflowExecutor(store, {
      agent: (node) => ({ agent: node.agent, output: `${node.agent} 的输出` })
    }).run(workflow);

    const plan = run.plan as
      | {
          decisions: Array<{ taskId: string; agentId: string; reason: string }>;
          requestedAgentIds: Record<string, string>;
        }
      | undefined;
    assert.ok(plan, "运行应携带调度计划");
    assert.equal(plan.requestedAgentIds.draft, "weak-agent");
    assert.equal(plan.decisions[0]?.taskId, "draft");
    assert.equal(plan.decisions[0]?.agentId, "strong-agent");
    assert.match(plan.decisions[0]?.reason ?? "", /能力匹配/);
    assert.equal((steps[0]?.output as { agent?: string }).agent, "strong-agent");
  } finally {
    dispose();
  }
});

test("falls back to the DSL agent and reports unassigned tasks when no candidate exists", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "scheduler-missing-probe",
    name: "能力缺口探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "draft", kind: "agent", agent: "ghost-agent" }],
    edges: []
  };

  try {
    const { run, steps } = await new WorkflowExecutor(store, {
      agent: (node) => ({ agent: node.agent })
    }).run(workflow);

    const plan = run.plan as
      | {
          decisions: unknown[];
          unassigned: Array<{ taskId: string; reason: string }>;
        }
      | undefined;
    assert.ok(plan, "运行应携带调度计划");
    assert.equal(plan.decisions.length, 0);
    assert.equal(plan.unassigned[0]?.taskId, "draft");
    assert.match(plan.unassigned[0]?.reason ?? "", /未分配/);
    assert.equal((steps[0]?.output as { agent?: string }).agent, "ghost-agent");
  } finally {
    dispose();
  }
});

test("runs the topic-review-v1 workflow through the same executor", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "topic-review-v1");
  assert.ok(workflow);
  try {
    const { run, steps } = await new WorkflowExecutor(store, knowledgeHandlers()).run(workflow, {
      title: "乡村小学课后服务的家校协同机制研究",
      field: "教育学",
      background: "已联系两所乡村小学，可获取一学期课后服务记录。"
    });

    assert.equal(run.status, "succeeded");
    const nodeIds = steps.map((step) => step.nodeId);
    for (const id of [
      "retrieve",
      "innovation-review",
      "feasibility-review",
      "compliance-review",
      "summary",
      "verify-initial",
      "revise",
      "verify-loop",
      "report"
    ]) {
      assert.ok(nodeIds.includes(id), `缺少节点 ${id}`);
    }

    const iterations = store.listLoopIterations(run.id);
    assert.equal(iterations.length, 1);
    const summary = ((run.output?.selfLoop ?? []) as Array<Record<string, unknown>>)[0];
    assert.equal(summary?.iterations, 1);
    assert.ok(typeof summary?.finalScore === "number");
    assert.ok(typeof run.output?.score === "number");
  } finally {
    dispose();
  }
});

function approvalProbe(timeoutMs = 60_000): WorkflowDefinition {
  return {
    id: "approval-probe",
    name: "人工审批探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "draft", kind: "agent", agent: "lesson-plan-agent" },
      { id: "verify", kind: "verify", verifier: "observer-verifier", threshold: 0.8 },
      {
        id: "review",
        kind: "approve",
        title: "人工审核",
        instructions: "确认后通过",
        assignee: "教研组长",
        timeoutMs,
        inputs: { draft: "${draft.output}", score: "${verify.score}" }
      },
      {
        id: "publish",
        kind: "agent",
        agent: "teaching-report-agent",
        inputs: { plan: "${draft.output}", approval: "${review.decision}" }
      }
    ],
    edges: [
      { from: "draft", to: "verify" },
      { from: "verify", to: "review" },
      { from: "review", to: "publish" }
    ]
  };
}

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

test("pauses at an approve node, then continues after approval", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(approvalProbe(), {});
    const approval = await waitFor("待审记录", () =>
      store.listApprovals({ runId: started.id, status: "pending" })[0]
    );
    assert.equal(store.getRun(started.id)?.status, "waiting_approval");
    assert.equal(store.getStep(approval.stepId)?.status, "waiting");
    assert.equal(approval.assignee, "教研组长");
    assert.equal(approval.instructions, "确认后通过");
    assert.equal(typeof approval.context?.score, "number");

    executor.decideApproval(approval.id, {
      decision: "approved",
      reviewer: "张老师",
      comment: "目标与活动一致，同意发布。"
    });
    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });

    const steps = store.listSteps(finished.id);
    assert.deepEqual(
      steps.map((step) => step.nodeId),
      ["draft", "verify", "review", "publish"]
    );
    assert.ok(steps.every((step) => step.status === "succeeded"));
    const reviewStep = steps.find((step) => step.nodeId === "review");
    const reviewOutput = reviewStep?.output as Record<string, unknown>;
    assert.equal(reviewOutput.decision, "approved");
    assert.equal(reviewOutput.reviewer, "张老师");

    const decided = store.getApproval(approval.id);
    assert.equal(decided?.status, "approved");
    assert.equal(decided?.comment, "目标与活动一致，同意发布。");
    assert.ok(decided?.decidedAt);
  } finally {
    dispose();
  }
});

test("cancels a run waiting for approval and skips downstream steps", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(approvalProbe(), {});
    await waitFor("待审记录", () =>
      store.listApprovals({ runId: started.id, status: "pending" })[0]
    );
    assert.equal(store.getRun(started.id)?.status, "waiting_approval");

    executor.cancelRun(started.id);
    const finished = await waitFor("运行取消", () => {
      const run = store.getRun(started.id);
      return run?.status === "cancelled" ? run : undefined;
    });
    assert.match(finished.error ?? "", /取消/);
    assert.deepEqual(
      store.listSteps(started.id).map((step) => step.nodeId),
      ["draft", "verify", "review"]
    );
    assert.equal(store.listSteps(started.id).at(-1)?.status, "failed");
    assert.equal(store.listApprovals({ runId: started.id })[0]?.status, "rejected");
  } finally {
    dispose();
  }
});

test("scheduler counts agents reserved by real in-flight leases", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "load-probe",
    name: "调度负载探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "review", kind: "agent", agent: "topic-innovation-agent" }],
    edges: []
  };
  try {
    store.seedAgents(BUILTIN_AGENTS);
    const other = store.createRun({
      workflowId: "load-holder",
      workflowVersion: 1,
      workflowInput: {},
      mode: "stub",
      status: "running"
    });
    store.acquireSchedulerLease({
      runId: other.id,
      taskPath: "review",
      agentId: "topic-innovation-agent",
      workerId: "worker-other",
      ttlMs: 60000
    });

    const { run } = await new WorkflowExecutor(store).run(workflow);
    const plan = run.plan as {
      decisions: Array<{ agentId: string; load: { inFlight: number } }>;
    };
    const decision = plan.decisions.find((item) => item.agentId === "topic-innovation-agent");
    assert.equal(decision?.load.inFlight, 1);
  } finally {
    dispose();
  }
});

test("limits the scheduling pool to the workflow team", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "team-probe",
    name: "团队调度探针",
    version: 1,
    inputs: [],
    teamId: "narrow-team",
    nodes: [{ id: "draft", kind: "agent", agent: "lesson-plan-agent" }],
    edges: []
  };
  try {
    store.seedAgents(BUILTIN_AGENTS);
    store.saveTeam({
      id: "narrow-team",
      name: "窄团队",
      description: "",
      agentIds: ["student-silent-agent"],
      knowledgeBaseIds: []
    });

    const { run } = await new WorkflowExecutor(store).run(workflow);
    const plan = run.plan as {
      decisions: Array<{ agentId: string }>;
      unassigned: Array<{ taskId: string }>;
    };
    assert.equal(plan.decisions.length, 0);
    assert.equal(plan.unassigned[0]?.taskId, "draft");
  } finally {
    dispose();
  }
});

test("single-step retry uses the DSL snapshot captured at run start", async () => {
  const { store, dispose } = createStore();
  const original: WorkflowDefinition = {
    id: "snapshot-probe",
    name: "快照探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "draft", kind: "agent", agent: "lesson-plan-agent", title: "旧版教案节点" }],
    edges: []
  };
  try {
    store.saveWorkflow(original);
    const executor = new WorkflowExecutor(store);
    const { run, steps } = await executor.run(original);

    store.saveWorkflow({
      ...original,
      nodes: [{ id: "draft", kind: "agent", agent: "lesson-plan-agent", title: "新版教案节点" }]
    });

    const retried = await executor.retryStep(run.id, steps[0]!.id);
    assert.match(String((retried.output as { summary?: string })?.summary), /旧版教案节点/);
  } finally {
    dispose();
  }
});

test("rejects at an approve node, stops downstream steps and keeps the reason", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(approvalProbe(), {});
    const approval = await waitFor("待审记录", () =>
      store.listApprovals({ runId: started.id, status: "pending" })[0]
    );

    assert.throws(
      () =>
        executor.decideApproval(approval.id, {
          decision: "rejected",
          reviewer: "张老师"
        }),
      /驳回时必须填写审批意见/
    );

    executor.decideApproval(approval.id, {
      decision: "rejected",
      reviewer: "张老师",
      comment: "学生活动与目标不匹配，请补充分层练习。"
    });
    const finished = await waitFor("运行失败", () => {
      const run = store.getRun(started.id);
      return run?.status === "failed" ? run : undefined;
    });

    assert.match(finished.error ?? "", /学生活动与目标不匹配/);
    assert.equal(
      store.listSteps(finished.id).some((step) => step.nodeId === "publish"),
      false
    );
    const reviewStep = store.listSteps(finished.id).find((step) => step.nodeId === "review");
    assert.equal(reviewStep?.status, "failed");
    assert.equal(store.getApproval(approval.id)?.status, "rejected");
  } finally {
    dispose();
  }
});

test("fails the run when the approval times out", async () => {
  const { store, dispose } = createStore();
  try {
    const started = new WorkflowExecutor(store).start(approvalProbe(1000), {});
    const finished = await waitFor(
      "审批超时",
      () => {
        const run = store.getRun(started.id);
        return run?.status === "failed" ? run : undefined;
      },
      5000
    );
    assert.match(finished.error ?? "", /人工审批超时/);
    const approval = store.listApprovals({ runId: finished.id })[0];
    assert.equal(approval?.status, "expired");
    assert.equal(
      store.listSteps(finished.id).some((step) => step.nodeId === "publish"),
      false
    );
  } finally {
    dispose();
  }
});

test("injects workflow-bound knowledge bases into knowledge.search unless the node overrides them", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "kb-bind-probe",
    name: "知识库绑定探针",
    version: 1,
    knowledgeBaseIds: ["kb-a"],
    inputs: [],
    nodes: [
      { id: "search", kind: "tool", tool: "knowledge.search", args: { query: "分数的意义" } },
      {
        id: "search-explicit",
        kind: "tool",
        tool: "knowledge.search",
        args: { query: "网络素养", knowledgeBaseIds: ["kb-b"] }
      },
      { id: "report", kind: "tool", tool: "report.build", args: {} }
    ],
    edges: [
      { from: "search", to: "search-explicit" },
      { from: "search-explicit", to: "report" }
    ]
  };

  try {
    const { run, steps } = await new WorkflowExecutor(store).run(workflow, {});
    assert.equal(run.status, "succeeded");
    const byNode = new Map(steps.map((step) => [step.nodeId, step]));
    const inputOf = (nodeId: string) => (byNode.get(nodeId)?.input ?? {}) as Record<string, unknown>;
    assert.deepEqual(inputOf("search").knowledgeBaseIds, ["kb-a"]);
    assert.deepEqual(inputOf("search-explicit").knowledgeBaseIds, ["kb-b"]);
    assert.equal("knowledgeBaseIds" in inputOf("report"), false);
  } finally {
    dispose();
  }
});

test("runs a nested sub-workflow with parent-child trace paths and mapped outputs", async () => {
  const { store, dispose } = createStore();
  const child: WorkflowDefinition = {
    id: "training-child",
    name: "训练子流程",
    version: 1,
    inputs: [{ name: "topic", type: "string", required: true }],
    nodes: [
      {
        id: "think",
        kind: "llm",
        title: "子流程思考",
        thinking: true,
        prompt: "分析 ${input.topic} 的教学难点"
      },
      {
        id: "draft",
        kind: "agent",
        agent: "lesson-plan-agent",
        title: "子流程成稿",
        inputs: { brief: "${think.output}" }
      },
      {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        threshold: 0.8,
        inputs: { artifact: "${draft.output}" }
      }
    ],
    edges: [
      { from: "think", to: "draft" },
      { from: "draft", to: "check" }
    ]
  };
  const parent: WorkflowDefinition = {
    id: "training-parent",
    name: "父流程",
    version: 1,
    inputs: [{ name: "topic", type: "string", required: true }],
    nodes: [
      { id: "intro", kind: "template", template: "# ${input.topic}" },
      {
        id: "child",
        kind: "subworkflow",
        title: "训练子流程",
        workflowId: "training-child",
        inputs: { topic: "${input.topic}" },
        outputs: { draft: "${draft.output}", score: "${check.score}" }
      },
      { id: "deliver", kind: "template", template: "报告：${child.draft}" }
    ],
    edges: [
      { from: "intro", to: "child" },
      { from: "child", to: "deliver" }
    ]
  };

  try {
    store.saveWorkflow(child);
    store.saveWorkflow(parent);
    const { run, steps } = await new WorkflowExecutor(store).run(parent, {
      topic: "分数的意义"
    });

    assert.equal(run.status, "succeeded");
    assert.deepEqual(
      steps.map((step) => step.path),
      ["intro", "child", "child/think", "child/draft", "child/check", "deliver"]
    );

    const [intro, container, think, , check, deliver] = steps;
    assert.equal((intro.output as Record<string, unknown>).output, "# 分数的意义");
    assert.match(String((think.output as Record<string, unknown>).thinking), /目标：子流程思考/);

    const containerOutput = container.output as Record<string, unknown>;
    assert.equal(containerOutput.workflowId, "training-child");
    assert.deepEqual(Object.keys(containerOutput.outputs as Record<string, unknown>), [
      "think",
      "draft",
      "check"
    ]);
    const mapped = containerOutput.mappedOutputs as Record<string, unknown>;
    assert.equal(typeof mapped.draft, "string");
    assert.equal(mapped.score, (check.output as Record<string, unknown>).score);
    assert.match(String((deliver.output as Record<string, unknown>).output), /^报告：/);

    const plan = run.plan as
      | {
          requestedAgentIds: Record<string, string>;
          unassigned: Array<{ taskId: string }>;
        }
      | undefined;
    assert.ok(plan, "运行应携带调度计划");
    assert.equal(plan.requestedAgentIds["child/draft"], "lesson-plan-agent");
    assert.equal(plan.unassigned[0]?.taskId, "child/draft");
  } finally {
    dispose();
  }
});

test("stops after the requested top-level node for a trial run", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "trial-probe",
    name: "试跑探针",
    version: 1,
    inputs: [{ name: "topic", type: "string", required: true }],
    nodes: [
      { id: "first", kind: "template", template: "A ${input.topic}" },
      { id: "second", kind: "template", template: "B ${input.topic}" }
    ],
    edges: [{ from: "first", to: "second" }]
  };
  try {
    const { run, steps } = await new WorkflowExecutor(store).run(
      workflow,
      { topic: "分数" },
      { stopAfter: "first" }
    );
    assert.equal(run.status, "succeeded");
    assert.deepEqual(steps.map((step) => step.nodeId), ["first"]);
    assert.equal(run.output?.stoppedAfter, "first");
    assert.match(String((steps[0]!.output as { output?: string }).output), /^A 分数/);
  } finally {
    dispose();
  }
});

test("rejects stopAfter targets that are not top-level nodes", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "trial-invalid",
    name: "试跑反例",
    version: 1,
    inputs: [],
    nodes: [{ id: "only", kind: "template", template: "hello" }],
    edges: []
  };
  try {
    await assert.rejects(
      () => new WorkflowExecutor(store).run(workflow, {}, { stopAfter: "missing" }),
      /stopAfter 只能指向顶层节点/
    );
  } finally {
    dispose();
  }
});

test("runs independent branches concurrently and joins after all of them settle", async () => {
  const { store, dispose } = createStore();
  let active = 0;
  let maxActive = 0;
  const workflow: WorkflowDefinition = {
    id: "dag-fan-out",
    name: "并发扇出",
    version: 1,
    inputs: [],
    nodes: [
      { id: "left", kind: "tool", tool: "test.slow", args: { branch: "left" } },
      { id: "middle", kind: "tool", tool: "test.slow", args: { branch: "middle" } },
      { id: "right", kind: "tool", tool: "test.slow", args: { branch: "right" } },
      {
        id: "join",
        kind: "template",
        template: "${left.output} | ${middle.output} | ${right.output}"
      }
    ],
    edges: [
      { from: "left", to: "join" },
      { from: "middle", to: "join" },
      { from: "right", to: "join" }
    ]
  };
  const startedAt = Date.now();
  try {
    const { run, steps } = await new WorkflowExecutor(
      store,
      {
        tool: async (node) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 120));
          active -= 1;
          return { mode: "live", tool: node.tool, output: node.id };
        }
      },
      { maxConcurrency: 4 }
    ).run(workflow);
    const elapsed = Date.now() - startedAt;

    assert.equal(run.status, "succeeded");
    assert.equal(maxActive, 3, "三个入口节点应同时执行");
    assert.ok(elapsed < 300, `并发耗时 ${elapsed}ms 应明显短于串行约 360ms`);
    assert.equal(steps.length, 4);
    const join = steps.find((step) => step.nodeId === "join");
    assert.equal(join?.status, "succeeded");
    assert.match(String((join?.output as { output?: string }).output), /left \| middle \| right/);
  } finally {
    dispose();
  }
});

test("selects conditional edges and propagates skipped nodes to the join", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "dag-condition",
    name: "条件分支",
    version: 1,
    inputs: [{ name: "approved", type: "boolean", required: true }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "approved-path", kind: "template", template: "approved" },
      { id: "fallback-path", kind: "template", template: "fallback" },
      { id: "deep", kind: "template", template: "deep" },
      { id: "join", kind: "template", template: "${fallback-path.output}" }
    ],
    edges: [
      { from: "start", to: "approved-path", when: "${input.approved} == true" },
      { from: "start", to: "fallback-path", when: "${input.approved} == false" },
      { from: "approved-path", to: "deep" },
      { from: "deep", to: "join" },
      { from: "fallback-path", to: "join" }
    ]
  };
  try {
    const { run, steps } = await new WorkflowExecutor(store).run(workflow, { approved: false });
    assert.equal(run.status, "succeeded");
    const byId = new Map(steps.map((step) => [step.nodeId, step]));
    assert.equal(byId.get("approved-path")?.status, "skipped");
    assert.equal(byId.get("deep")?.status, "skipped");
    assert.equal(byId.get("fallback-path")?.status, "succeeded");
    const join = byId.get("join");
    assert.equal(join?.status, "succeeded");
    assert.match(String((join?.output as { output?: string }).output), /fallback/);
  } finally {
    dispose();
  }
});

test("drains in-flight branches after a failure without launching downstream nodes", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "dag-failure",
    name: "失败收敛",
    version: 1,
    inputs: [],
    nodes: [
      { id: "slow", kind: "tool", tool: "test.slow" },
      { id: "boom", kind: "tool", tool: "test.boom" },
      { id: "join", kind: "template", template: "${slow.output}" }
    ],
    edges: [
      { from: "slow", to: "join" },
      { from: "boom", to: "join" }
    ]
  };
  try {
    const executor = new WorkflowExecutor(
      store,
      {
        tool: async (node) => {
          if (node.id === "boom") {
            throw new Error("boom");
          }
          await new Promise((resolve) => setTimeout(resolve, 80));
          return { mode: "live", tool: node.tool, output: node.id };
        }
      },
      { maxAttempts: 1, maxConcurrency: 2 }
    );
    const started = executor.start(workflow, {});
    const finished = await waitFor("运行失败", () => {
      const run = store.getRun(started.id);
      return run?.status === "failed" ? run : undefined;
    });
    assert.match(finished.error ?? "", /boom/);
    const steps = store.listSteps(started.id);
    assert.deepEqual(
      steps.map((step) => step.nodeId).sort(),
      ["boom", "slow"],
      "失败后不应再启动汇合节点"
    );
    assert.equal(steps.find((step) => step.nodeId === "slow")?.status, "succeeded");
    assert.equal(steps.find((step) => step.nodeId === "boom")?.status, "failed");
  } finally {
    dispose();
  }
});

test("keeps an unrelated branch running while an approval is pending", async () => {
  const { store, dispose } = createStore();
  const workflow: WorkflowDefinition = {
    id: "dag-approval",
    name: "审批并发",
    version: 1,
    inputs: [],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "review",
        kind: "approve",
        title: "人工审核",
        instructions: "确认后通过",
        assignee: "教研组长",
        timeoutMs: 60_000
      },
      { id: "side", kind: "tool", tool: "test.side" },
      {
        id: "join",
        kind: "template",
        template: "${side.output} / ${review.decision}"
      }
    ],
    edges: [
      { from: "start", to: "review" },
      { from: "start", to: "side" },
      { from: "review", to: "join" },
      { from: "side", to: "join" }
    ]
  };
  try {
    const executor = new WorkflowExecutor(
      store,
      {
        tool: async (node) => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { mode: "live", tool: node.tool, output: node.id };
        }
      },
      { maxConcurrency: 4 }
    );
    const started = executor.start(workflow, {});
    const approval = await waitFor("待审记录", () =>
      store.listApprovals({ runId: started.id, status: "pending" })[0]
    );
    await waitFor("旁支完成", () =>
      store
        .listSteps(started.id)
        .find((step) => step.nodeId === "side" && step.status === "succeeded")
    );
    assert.equal(store.getRun(started.id)?.status, "waiting_approval");

    executor.decideApproval(approval.id, { decision: "approved", reviewer: "tester" });
    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const join = store
      .listSteps(finished.id)
      .find((step) => step.nodeId === "join");
    assert.equal(join?.status, "succeeded");
    assert.match(String((join?.output as { output?: string }).output), /side \/ approved/);
  } finally {
    dispose();
  }
});

function humanProbe(timeoutMs = 60_000): WorkflowDefinition {
  return {
    id: "human-probe",
    name: "人工交互探针",
    version: 1,
    inputs: [],
    nodes: [
      {
        id: "gather",
        kind: "human",
        title: "教师发言",
        prompt: "请输入本轮发言",
        assignee: "参训教师",
        timeoutMs,
        fields: [
          { key: "text", label: "发言", type: "textarea", required: true },
          {
            key: "action",
            label: "动作",
            type: "select",
            options: ["speak", "finish"],
            defaultValue: "speak",
            required: true
          }
        ],
        inputs: { topic: "分数的意义" }
      },
      {
        id: "echo",
        kind: "template",
        template: "${gather.text} / ${gather.action}"
      }
    ],
    edges: [{ from: "gather", to: "echo" }]
  };
}

test("pauses at a human node, records the interaction and resumes with the submitted values", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(humanProbe(), {});
    const interaction = await waitFor("待输入记录", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );

    assert.equal(store.getRun(started.id)?.status, "waiting_input");
    assert.equal(store.getStep(interaction.stepId)?.status, "waiting");
    assert.equal(interaction.nodeId, "gather");
    assert.equal(interaction.fields.length, 2);
    assert.equal(interaction.context?.topic, "分数的意义");

    executor.respondInteraction(interaction.id, {
      values: { text: "请第三排的同学说说理由。", action: "speak" },
      actor: "张老师"
    });

    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const steps = store.listSteps(finished.id);
    const gather = steps.find((step) => step.nodeId === "gather");
    const output = gather?.output as Record<string, unknown>;
    assert.equal(output.text, "请第三排的同学说说理由。");
    assert.equal(output.action, "speak");
    assert.equal(output.actor, "张老师");
    assert.equal(output.interaction, interaction.id);
    assert.deepEqual(output.input, { topic: "分数的意义" });

    const echo = steps.find((step) => step.nodeId === "echo");
    assert.equal((echo?.output as { value?: string }).value, "请第三排的同学说说理由。 / speak");

    const decided = store.getInteraction(interaction.id);
    assert.equal(decided?.status, "answered");
    assert.equal(decided?.actor, "张老师");
    assert.ok(decided?.decidedAt);
  } finally {
    dispose();
  }
});

test("validates human input fields before waking the run", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(humanProbe(), {});
    const interaction = await waitFor("待输入记录", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );

    assert.throws(
      () => executor.respondInteraction(interaction.id, { values: { action: "speak" } }),
      /不能为空/
    );
    assert.throws(
      () =>
        executor.respondInteraction(interaction.id, {
          values: { text: "继续", action: "skip" }
        }),
      /只能是 speak \/ finish/
    );
    assert.equal(store.getInteraction(interaction.id)?.status, "pending");
    assert.equal(store.getRun(started.id)?.status, "waiting_input");

    executor.respondInteraction(interaction.id, {
      values: { text: "继续", action: "finish" }
    });
    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    assert.equal(store.getInteraction(interaction.id)?.status, "answered");
    assert.equal(finished.id, started.id);
  } finally {
    dispose();
  }
});

test("cancels a run waiting for human input", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(humanProbe(), {});
    const interaction = await waitFor("待输入记录", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    assert.equal(store.getRun(started.id)?.status, "waiting_input");

    executor.cancelRun(started.id);
    const finished = await waitFor("运行取消", () => {
      const run = store.getRun(started.id);
      return run?.status === "cancelled" ? run : undefined;
    });

    assert.match(finished.error ?? "", /取消/);
    assert.equal(store.getInteraction(interaction.id)?.status, "cancelled");
    assert.equal(store.getStep(interaction.stepId)?.status, "failed");
  } finally {
    dispose();
  }
});

test("expires a human interaction and fails the run on timeout", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(humanProbe(1000), {});
    const interaction = await waitFor("待输入记录", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    const failed = await waitFor(
      "运行超时",
      () => {
        const run = store.getRun(started.id);
        return run?.status === "failed" ? run : undefined;
      },
      4000
    );

    assert.match(failed.error ?? "", /超时/);
    assert.equal(store.getInteraction(interaction.id)?.status, "expired");
    assert.equal(store.getStep(interaction.stepId)?.status, "failed");
  } finally {
    dispose();
  }
});

/** 用确定性假工具替代课堂/谈话服务，验证会话工作流的循环与人工暂停点。 */
function sessionToolHandlers() {
  return {
    trainingTool: async (node: ToolNode, input: Record<string, unknown>) => {
      if (node.tool === "classroom.create") {
        return {
          sessionId: "classroom-1",
          classroomState: { sessionId: "classroom-1", topic: input.topic, turnCount: 0 }
        };
      }
      if (node.tool === "classroom.turn") {
        return {
          classroomState: { sessionId: "classroom-1", lastText: input.teacherText },
          observerTips: [`已处理：${input.teacherText}`],
          events: []
        };
      }
      if (node.tool === "classroom.feedback") {
        return {
          summary: `第 1 轮点评：${input.sessionId}`,
          nextMoves: ["扩大参与面"],
          risks: []
        };
      }
      if (node.tool === "classroom.report") {
        return { report: { overallScore: 88 }, citations: [], saveError: undefined };
      }
      if (node.tool === "counseling.create") {
        return { session: { id: "counseling-1", config: input.config, messages: [] } };
      }
      if (node.tool === "counseling.turn") {
        return {
          session: {
            id: "counseling-1",
            messages: [{ role: "student", text: `回应：${input.text}`, turnId: input.turnId }]
          }
        };
      }
      if (node.tool === "counseling.feedback") {
        return { turn: 1, suggestions: ["先回应感受，再澄清事实。"] };
      }
      if (node.tool === "counseling.finish") {
        return { session: { id: "counseling-1", status: "finished", report: { overallScore: 90 } } };
      }
      return undefined;
    }
  };
}

test("classroom-session-v1 pauses for each teacher turn, loops, then generates the report", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-session-v1");
  assert.ok(workflow);
  try {
    const executor = new WorkflowExecutor(store, sessionToolHandlers());
    const started = executor.start(workflow, {
      subject: "数学",
      grade: "初中",
      topic: "分数的意义",
      classType: "普通班"
    });

    const first = await waitFor("第一次教师输入", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    assert.equal(first.nodeId, "teacher-turn");
    assert.deepEqual(first.context, { sessionId: "classroom-1" });

    executor.respondInteraction(first.id, {
      values: { text: "请第三排的同学说说理由。", action: "speak" },
      actor: "参训教师"
    });
    const second = await waitFor("第二次教师输入", () => {
      const pending = store.listInteractions({ runId: started.id, status: "pending" })[0];
      return pending && pending.id !== first.id ? pending : undefined;
    });

    const turnStep = store
      .listSteps(started.id)
      .find((step) => step.nodeId === "student-reactions");
    assert.equal(turnStep?.status, "succeeded");
    assert.match(String((turnStep?.output as { observerTips?: string[] }).observerTips?.[0]), /请第三排/);
    const feedbackStep = store
      .listSteps(started.id)
      .find((step) => step.nodeId === "teacher-feedback");
    assert.equal(feedbackStep?.status, "succeeded");
    assert.match(String((feedbackStep?.output as { summary?: string }).summary), /第 1 轮点评/);

    executor.respondInteraction(second.id, {
      values: { action: "finish" },
      actor: "参训教师"
    });
    const finished = await waitFor("课堂运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });

    const reportStep = store.listSteps(finished.id).find((step) => step.nodeId === "report");
    assert.equal(reportStep?.status, "succeeded");
    assert.equal((reportStep?.output as { report?: { overallScore?: number } }).report?.overallScore, 88);
    assert.equal(
      store.listInteractions({ runId: finished.id, status: "answered" }).length,
      2
    );
  } finally {
    dispose();
  }
});

test("counseling-session-v1 turns each counselor speech into a human pause and finishes the session", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "counseling-session-v1");
  assert.ok(workflow);
  try {
    const executor = new WorkflowExecutor(store, sessionToolHandlers());
    const started = executor.start(workflow, {
      config: { caseId: "case-1", mode: "guided", emotion: "焦虑", intensity: 3, trust: 40, openness: 30, risk: "ordinary" }
    });

    const first = await waitFor("第一次辅导员输入", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    assert.equal(first.nodeId, "counselor-turn");
    assert.deepEqual(first.context, { sessionId: "counseling-1" });

    executor.respondInteraction(first.id, {
      values: { text: "听起来你最近很紧绷。", turnId: "turn_1", action: "speak" },
      actor: "参训辅导员"
    });
    const second = await waitFor("第二次辅导员输入", () => {
      const pending = store.listInteractions({ runId: started.id, status: "pending" })[0];
      return pending && pending.id !== first.id ? pending : undefined;
    });

    const turnStep = store
      .listSteps(started.id)
      .find((step) => step.nodeId === "counselor-turn-result");
    assert.equal(turnStep?.status, "succeeded");
    assert.match(
      String((turnStep?.output as { session?: { messages?: Array<{ text?: string }> } }).session?.messages?.[0]?.text),
      /听起来你最近很紧绷/
    );
    const feedbackStep = store
      .listSteps(started.id)
      .find((step) => step.nodeId === "coach-feedback");
    assert.equal(feedbackStep?.status, "succeeded");
    assert.match(
      String((feedbackStep?.output as { suggestions?: string[] }).suggestions?.[0]),
      /先回应感受/
    );

    executor.respondInteraction(second.id, {
      values: { action: "finish" },
      actor: "参训辅导员"
    });
    const finished = await waitFor("谈话运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });

    const finishStep = store.listSteps(finished.id).find((step) => step.nodeId === "finish-session");
    assert.equal(finishStep?.status, "succeeded");
    assert.equal((finishStep?.output as { session?: { status?: string } }).session?.status, "finished");
  } finally {
    dispose();
  }
});

test("self-loop swaps the execution model after a stalled round and records the transition", async () => {
  const restoreEnv = withEnv({
    PLATFORM_MODEL_FAST: "cheap-model",
    PLATFORM_MODEL_REASONING: "strong-model"
  });
  const { store, dispose } = createStore();
  store.saveAgent({
    id: "weak-agent",
    name: "普通教案 Agent",
    version: 1,
    role: "教案设计",
    prompt: "",
    tools: [],
    model: "fast",
    capabilities: [{ tag: "教案设计", weight: 0.7 }],
    memory: {},
    enabled: true
  });

  const workflow: WorkflowDefinition = {
    id: "self-loop-model-probe",
    name: "换模型探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "initial", kind: "verify", verifier: "probe-verifier", threshold: 0.95 },
      {
        id: "loop",
        kind: "loop",
        maxIterations: 5,
        while: "${verify-loop.score} < 0.95",
        patience: 2,
        body: [
          {
            id: "revise",
            kind: "agent",
            agent: "weak-agent",
            inputs: { draft: "初稿" }
          },
          { id: "verify-loop", kind: "verify", verifier: "probe-verifier", threshold: 0.95 }
        ]
      }
    ],
    edges: [{ from: "initial", to: "loop" }]
  };

  try {
    const executor = new WorkflowExecutor(store, {
      agent: (node) => ({ agent: node.agent, model: node.model, output: "输出" }),
      verify: () => ({
        score: 0.7,
        confidence: 0.8,
        dimensions: [],
        issues: ["互动覆盖不足"],
        evidence: []
      })
    });
    const { run, steps } = await executor.run(workflow);

    const iterations = store.listLoopIterations(run.id);
    assert.deepEqual(
      iterations.map((iteration) => iteration.action),
      ["rewrite", "rewrite", "swap_model"]
    );

    const revisions = steps.filter((step) => step.nodeId === "revise");
    assert.equal(revisions.length, 3);
    assert.equal((revisions[0]?.output as { model?: string }).model, undefined);
    assert.equal((revisions[1]?.output as { model?: string }).model, undefined);
    assert.equal((revisions[2]?.output as { model?: string }).model, "reasoning");

    const directive = (revisions[2]?.input as { selfLoop?: Record<string, unknown> }).selfLoop;
    assert.equal(directive?.action, "swap_model");
    assert.equal(directive?.modelId, "reasoning");
    assert.equal(directive?.previousModelId, "fast");

    assert.equal(iterations[2]?.modelBefore, "fast");
    assert.equal(iterations[2]?.modelAfter, "reasoning");

    const summary = ((run.output?.selfLoop ?? []) as Array<Record<string, unknown>>)[0];
    const switches = summary?.modelSwitches as Array<Record<string, unknown>>;
    assert.equal(switches?.length, 1);
    assert.equal(switches[0]?.iteration, 2);
    assert.equal(switches[0]?.fromModel, "fast");
    assert.equal(switches[0]?.toModel, "reasoning");
    assert.equal(switches[0]?.scoreAfter, 0.7);
  } finally {
    dispose();
    restoreEnv();
  }
});

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

function clarifyProbe(overrides: Record<string, unknown> = {}): WorkflowDefinition {
  return {
    id: "clarify-probe",
    name: "意图澄清探针",
    version: 1,
    inputs: [{ name: "request", type: "string", required: true }],
    nodes: [
      {
        id: "clarify",
        kind: "clarify",
        title: "意图澄清",
        clarifyOn: "high",
        maxQuestions: 2,
        ...overrides
      },
      {
        id: "echo",
        kind: "template",
        template: "${clarify.rewrittenPrompt}"
      }
    ],
    edges: [{ from: "clarify", to: "echo" }]
  };
}

test("clarify rewrites the raw request and exposes the result downstream", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const { run, steps } = await executor.run(clarifyProbe(), {
      request: "看看 Q3 为什么下滑，给三条建议"
    });

    assert.equal(run.status, "succeeded");
    const clarify = steps.find((step) => step.nodeId === "clarify");
    const output = clarify?.output as Record<string, unknown>;
    assert.equal(output.kind, "clarify");
    assert.equal(output.rawPrompt, "看看 Q3 为什么下滑，给三条建议");
    assert.equal((output.intent as { taskType?: string }).taskType, "通用任务");
    assert.match(String(output.rewrittenPrompt), /# 目标/);
    assert.equal(output.needsClarification, false);

    const echo = steps.find((step) => step.nodeId === "echo");
    assert.equal((echo?.output as { value?: string }).value, output.rewrittenPrompt);
    assert.equal(store.listInteractions({ runId: run.id }).length, 0);
  } finally {
    dispose();
  }
});

test("clarify pauses on a high-impact ambiguity and folds the answer into the rewrite", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(
      clarifyProbe({
        stubOutput: {
          needsClarification: true,
          ambiguities: [
            { slot: "timeRange", question: "Q3 指自然季度还是财季？", impact: "high" }
          ]
        }
      }),
      { request: "看看 Q3 为什么下滑，给三条建议" }
    );

    const interaction = await waitFor("澄清记录", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    assert.equal(store.getRun(started.id)?.status, "waiting_input");
    assert.equal(interaction.nodeId, "clarify");
    assert.equal(interaction.fields.length, 1);
    assert.match(interaction.prompt, /Q3 指自然季度还是财季/);
    assert.equal(
      (interaction.context?.intent as { taskType?: string } | undefined)?.taskType,
      "通用任务"
    );

    executor.respondInteraction(interaction.id, {
      values: { answer: "自然季度（7–9 月）" },
      actor: "需求提出人"
    });

    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const clarify = store
      .listSteps(finished.id)
      .find((step) => step.nodeId === "clarify");
    const output = clarify?.output as Record<string, unknown>;
    const clarification = output.clarification as Record<string, unknown>;
    assert.equal(clarification.answer, "自然季度（7–9 月）");
    assert.equal(clarification.actor, "需求提出人");
    assert.match(String(output.rewrittenPrompt), /人工补充：自然季度/);
    assert.equal(output.needsClarification, true);
  } finally {
    dispose();
  }
});

test("clarifyOn=never records ambiguities without pausing", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const { run, steps } = await executor.run(
      clarifyProbe({
        clarifyOn: "never",
        stubOutput: {
          needsClarification: true,
          ambiguities: [
            { slot: "scope", question: "只看华东还是全国？", impact: "high" }
          ]
        }
      }),
      { request: "看看 Q3 为什么下滑" }
    );

    assert.equal(run.status, "succeeded");
    assert.equal(store.listInteractions({ runId: run.id }).length, 0);
    const output = steps.find((step) => step.nodeId === "clarify")?.output as Record<string, unknown>;
    assert.equal(output.needsClarification, true);
    assert.equal((output.ambiguities as unknown[]).length, 1);
    assert.equal(output.clarification, undefined);
  } finally {
    dispose();
  }
});

test("intent-clarify-v1 pauses on the built-in critical ambiguity, then runs the rewritten prompt through verification", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "intent-clarify-v1");
  assert.ok(workflow);
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(workflow, { request: "帮我做个期末复习的方案" });
    const interaction = await waitFor("意图澄清记录", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );

    assert.equal(store.getRun(started.id)?.status, "waiting_input");
    assert.equal(interaction.nodeId, "clarify");
    assert.match(interaction.prompt, /期末复习只覆盖本学期内容/);
    assert.doesNotMatch(interaction.prompt, /Word 文档还是 Markdown/);

    executor.respondInteraction(interaction.id, {
      values: { answer: "只复习本学期，控制在 40 分钟内" },
      actor: "需求提出人"
    });

    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const steps = store.listSteps(finished.id);
    const clarify = steps.find((step) => step.nodeId === "clarify")?.output as Record<
      string,
      unknown
    >;
    assert.equal(clarify.taskType, "教学设计");
    assert.equal((clarify.clarification as { answer?: string }).answer, "只复习本学期，控制在 40 分钟内");
    assert.match(String(clarify.rewrittenPrompt), /人工补充：只复习本学期/);

    const draft = steps.find((step) => step.nodeId === "draft");
    assert.equal(draft?.status, "succeeded");
    assert.match(String((draft?.input as { request?: string }).request), /人工补充：只复习本学期/);

    const report = steps.find((step) => step.nodeId === "report")?.output as { output?: string };
    assert.match(String(report.output), /## 原始需求/);
    assert.match(String(report.output), /## 改写后 Prompt/);
    assert.match(String(report.output), /人工补充：只复习本学期/);
  } finally {
    dispose();
  }
});

test("serves a higher-priority run first on the shared global queue", async () => {
  const { store, dispose } = createStore();
  store.seedAgents(BUILTIN_AGENTS);
  const workflow: WorkflowDefinition = {
    id: "cross-run-priority-probe",
    name: "跨运行优先级探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "work", kind: "agent", agent: "topic-innovation-agent" }],
    edges: []
  };
  try {
    store.saveWorkflow(workflow);
    const seen: string[] = [];
    const tags = new Map<string, string>();
    const executor = new WorkflowExecutor(
      store,
      {
        agent: async (_node, _input, context) => {
          seen.push(tags.get(context.runId) ?? context.runId);
          return { mode: "live", output: "完成" };
        }
      },
      { maxConcurrency: 1, schedulerCapacity: 1, maxAttempts: 1, timeoutMs: 0 }
    );

    // 两个运行在同一批就绪任务里提交，容量只有 1，高优运行应整体先执行。
    const low = executor.start(workflow, {}, { priorityClass: 0 });
    tags.set(low.id, "low");
    const high = executor.start(workflow, {}, { priorityClass: 5 });
    tags.set(high.id, "high");

    await waitFor("两个运行完成", () => {
      const lowRun = store.getRun(low.id);
      const highRun = store.getRun(high.id);
      return lowRun?.status === "succeeded" && highRun?.status === "succeeded"
        ? { lowRun, highRun }
        : undefined;
    });

    assert.deepEqual(seen, ["high", "low"]);
    const highQueue = store.listSchedulerQueue(high.id)[0];
    const lowQueue = store.listSchedulerQueue(low.id)[0];
    assert.equal(highQueue?.priorityClass, 5);
    assert.equal(lowQueue?.priorityClass, 0);
    assert.equal(highQueue?.status, "succeeded");
    assert.equal(store.listRunNodes(high.id)[0]?.status, "succeeded");
    assert.equal(executor.schedulerSnapshot().pending, 0);
    assert.equal(executor.schedulerSnapshot().running, 0);
  } finally {
    dispose();
  }
});


test("node error policy keeps the run alive after retries are exhausted", async () => {
  const { store, dispose } = createStore();
  try {
    const workflow: WorkflowDefinition = {
      id: "guard-continue",
      name: "异常继续探针",
      version: 1,
      inputs: [],
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "flaky",
          kind: "llm",
          prompt: "必然失败的节点",
          errorPolicy: { strategy: "continue", retries: 1, retryIntervalMs: 0 }
        },
        { id: "after", kind: "template", template: "后续节点照常执行" }
      ],
      edges: [
        { from: "start", to: "flaky" },
        { from: "flaky", to: "after" }
      ]
    };

    const { run, steps } = await new WorkflowExecutor(store, {
      llm: () => {
        throw new Error("上游模型不可用");
      }
    }).run(workflow, {});

    assert.equal(run.status, "succeeded");
    const flakyStep = steps.find((step) => step.nodeId === "flaky");
    const afterStep = steps.find((step) => step.nodeId === "after");
    assert.equal(flakyStep?.status, "succeeded");
    assert.match(String(flakyStep?.error), /已降级/);
    assert.equal(afterStep?.status, "succeeded");
  } finally {
    dispose();
  }
});

test("error guard writes failures into the Error branch for downstream refs", async () => {
  const { store, dispose } = createStore();
  try {
    const workflow: WorkflowDefinition = {
      id: "guard-error-branch",
      name: "Error 分支探针",
      version: 1,
      inputs: [],
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "flaky",
          kind: "llm",
          prompt: "必然失败的节点",
          errorPolicy: { enabled: true, retries: 0 }
        },
        { id: "after", kind: "template", template: "失败原因：${flaky.Error.FailMessage}" }
      ],
      edges: [
        { from: "start", to: "flaky" },
        { from: "flaky", to: "after" }
      ]
    };

    const { run, steps } = await new WorkflowExecutor(store, {
      llm: () => {
        throw new Error("上游模型不可用");
      }
    }).run(workflow, {});

    assert.equal(run.status, "succeeded");
    const flakyStep = steps.find((step) => step.nodeId === "flaky");
    assert.match(JSON.stringify(flakyStep?.output), /runtime_error/);
    const afterStep = steps.find((step) => step.nodeId === "after");
    assert.match(JSON.stringify(afterStep?.output), /上游模型不可用/);
  } finally {
    dispose();
  }
});

test("node error policy abort still fails the run", async () => {
  const { store, dispose } = createStore();
  try {
    const workflow: WorkflowDefinition = {
      id: "guard-abort",
      name: "异常中断探针",
      version: 1,
      inputs: [],
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "flaky",
          kind: "llm",
          prompt: "必然失败的节点",
          errorPolicy: { strategy: "abort", retries: 0 }
        }
      ],
      edges: [{ from: "start", to: "flaky" }]
    };

    const { run } = await new WorkflowExecutor(store, {
      llm: () => {
        throw new Error("上游模型不可用");
      }
    }).run(workflow, {});

    assert.equal(run.status, "failed");
  } finally {
    dispose();
  }
});

/** 复刻「新老连线混着」的选项卡：一条老线只有条件，两条新线直接绑端口。 */
function mixedChoiceProbe(): WorkflowDefinition {
  return {
    id: "mixed-choice",
    name: "选项卡混合连线",
    version: 1,
    inputs: [],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "ask",
        kind: "human",
        title: "选项卡",
        prompt: "你想通过什么方式来模拟开题答辩？",
        options: ["根据论文题目进行模拟开题答辩", "上传相关论文材料进行模拟开题答辩"],
        fields: [
          {
            key: "choice",
            label: "选项",
            type: "select",
            options: [
              "根据论文题目进行模拟开题答辩",
              "上传相关论文材料进行模拟开题答辩",
              "其他情况"
            ]
          }
        ]
      },
      { id: "title", kind: "template", title: "论文题目分支", template: "请提供论文题目" },
      { id: "material", kind: "template", title: "材料分支", template: "请上传材料" },
      { id: "fallback", kind: "template", title: "兜底分支", template: "只支持前两项" },
      { id: "end", kind: "end", inputs: { result: "${title.output}" } }
    ],
    edges: [
      { from: "start", to: "ask" },
      // 老连线：只有条件，没有 fromPort。
      { from: "ask", to: "title", when: "${ask.choice} == 根据论文题目进行模拟开题答辩" },
      { from: "ask", to: "material", fromPort: "choice:1" },
      { from: "ask", to: "fallback", fromPort: "choice:other" },
      { from: "title", to: "end" },
      { from: "material", to: "end" },
      { from: "fallback", to: "end" }
    ]
  };
}

test("选项卡选第一项时走第一条分支，不会再滑到兜底分支", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(mixedChoiceProbe(), {});
    const interaction = await waitFor("选项卡待输入", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    executor.respondInteraction(interaction.id, {
      values: { choice: "根据论文题目进行模拟开题答辩" }
    });
    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const statusOf = (nodeId: string) =>
      store.listSteps(finished.id).find((step) => step.nodeId === nodeId)?.status;
    assert.equal(statusOf("title"), "succeeded");
    assert.equal(statusOf("material"), "skipped");
    assert.equal(statusOf("fallback"), "skipped");
  } finally {
    dispose();
  }
});

test("选项卡自由输入时走兜底分支，选项分支保持跳过", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(mixedChoiceProbe(), {});
    const interaction = await waitFor("选项卡待输入", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    executor.respondInteraction(interaction.id, { values: { choice: "先随便聊聊" } });
    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const statusOf = (nodeId: string) =>
      store.listSteps(finished.id).find((step) => step.nodeId === nodeId)?.status;
    assert.equal(statusOf("fallback"), "succeeded");
    assert.equal(statusOf("title"), "skipped");
    assert.equal(statusOf("material"), "skipped");
  } finally {
    dispose();
  }
});

/** 参数提取探针：用户只说「模拟答辩」，参数表要的论文题目没给。 */
function extractProbe(options?: {
  maxRounds?: number;
  onMissing?: "fail" | "continue";
}): WorkflowDefinition {
  return {
    id: "extract-probe",
    name: "参数提取探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "ask",
        kind: "extract",
        title: "参数提取",
        params: [
          {
            name: "title",
            label: "论文题目",
            description: "用户要练的那篇论文的完整标题",
            required: true
          }
        ],
        askPrompt: "请提供您的论文题目，我将为您模拟开题答辩。",
        maxRounds: options?.maxRounds ?? 2,
        onMissing: options?.onMissing ?? "fail"
      },
      { id: "render", kind: "template", title: "下游节点", template: "题目=${ask.title}" },
      { id: "end", kind: "end", inputs: { result: "${render.output}" } }
    ],
    edges: [
      { from: "start", to: "ask" },
      { from: "ask", to: "render" },
      { from: "render", to: "end" }
    ]
  };
}

test("参数提取：输入变量里已经有值就直接放行，不再追问", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(extractProbe(), {
      title: "《基于深度学习的图像识别研究》"
    });
    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    assert.equal(store.listInteractions({ runId: started.id }).length, 0);
    const steps = store.listSteps(finished.id);
    const ask = steps.find((step) => step.nodeId === "ask");
    assert.equal(ask?.status, "succeeded");
    const payload = ask?.output as Record<string, unknown>;
    assert.equal(payload.title, "《基于深度学习的图像识别研究》");
    assert.equal(payload.complete, true);
    assert.equal(payload.rounds, 0);
    const render = steps.find((step) => step.nodeId === "render")?.output as Record<
      string,
      unknown
    >;
    assert.match(String(render.output), /基于深度学习的图像识别研究/);
  } finally {
    dispose();
  }
});

test("参数提取：缺必填参数先暂停追问，用户补齐后才走下游", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(extractProbe(), { request: "模拟答辩" });
    const interaction = await waitFor("参数追问", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    assert.equal(interaction.nodeId, "ask");
    assert.match(interaction.prompt, /请提供您的论文题目/);
    assert.equal(store.getRun(started.id)?.status, "waiting_input");
    // 没拿到参数之前，下游一步都不能跑。
    assert.equal(
      store.listSteps(started.id).find((step) => step.nodeId === "render")?.status,
      undefined
    );

    executor.respondInteraction(interaction.id, {
      values: { title: "《基于深度学习的图像识别研究》" }
    });
    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const steps = store.listSteps(finished.id);
    const payload = steps.find((step) => step.nodeId === "ask")?.output as Record<
      string,
      unknown
    >;
    assert.equal(payload.title, "《基于深度学习的图像识别研究》");
    assert.equal(payload.complete, true);
    assert.equal(payload.rounds, 1);
    const render = steps.find((step) => step.nodeId === "render")?.output as Record<
      string,
      unknown
    >;
    assert.match(String(render.output), /基于深度学习的图像识别研究/);
    assert.equal(store.listInteractions({ runId: finished.id, status: "pending" }).length, 0);
  } finally {
    dispose();
  }
});

test("参数提取：追问轮次用尽仍没拿到就失败，不会把空参数传给下游", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(extractProbe({ maxRounds: 1 }), { request: "模拟答辩" });
    const interaction = await waitFor("参数追问", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    // 空白回答不算「拿到了」，一轮用尽就该停。
    executor.respondInteraction(interaction.id, { values: { title: "   " } });
    const failed = await waitFor("运行失败", () => {
      const run = store.getRun(started.id);
      return run?.status === "failed" ? run : undefined;
    });
    assert.match(failed.error ?? "", /还没有拿到/);
    const steps = store.listSteps(failed.id);
    assert.equal(steps.find((step) => step.nodeId === "ask")?.status, "failed");
    assert.equal(steps.find((step) => step.nodeId === "render")?.status, undefined);
  } finally {
    dispose();
  }
});

/** 两个必填参数：验证追问是一轮一个，不会一次生成多行必填表单。 */
function extractMultiProbe(): WorkflowDefinition {
  const probe = extractProbe();
  const ask = probe.nodes.find((node) => node.id === "ask") as Record<string, unknown>;
  ask.params = [
    { name: "title", label: "论文题目", description: "完整的论文标题", required: true },
    { name: "advisor", label: "指导教师", description: "带这组答辩的老师", required: true }
  ];
  const render = probe.nodes.find((node) => node.id === "render") as Record<string, unknown>;
  render.template = "题目=${ask.title}；导师=${ask.advisor}";
  return probe;
}

test("参数提取：多个必填参数一轮只问一个，逐项补齐才放行", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(extractMultiProbe(), { request: "模拟答辩" });
    const first = await waitFor("第一次追问", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    assert.equal((first.fields ?? []).length, 1);
    assert.equal(first.fields?.[0]?.key, "title");
    assert.match(first.prompt, /论文题目/);
    executor.respondInteraction(first.id, {
      values: { title: "《基于深度学习的图像识别研究》" }
    });

    const second = await waitFor("第二次追问", () =>
      store
        .listInteractions({ runId: started.id, status: "pending" })
        .find((item) => item.id !== first.id)
    );
    assert.equal((second.fields ?? []).length, 1);
    assert.equal(second.fields?.[0]?.key, "advisor");
    assert.match(second.prompt, /指导教师/);
    executor.respondInteraction(second.id, { values: { advisor: "李教授" } });

    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const steps = store.listSteps(finished.id);
    const payload = steps.find((step) => step.nodeId === "ask")?.output as Record<
      string,
      unknown
    >;
    assert.equal(payload.complete, true);
    assert.equal(payload.title, "《基于深度学习的图像识别研究》");
    assert.equal(payload.advisor, "李教授");
    assert.equal(payload.rounds, 2);
    const render = steps.find((step) => step.nodeId === "render")?.output as Record<
      string,
      unknown
    >;
    assert.match(String(render.output), /李教授/);
  } finally {
    dispose();
  }
});

test("参数提取：允许缺参放行时标记 complete=false，下游照常执行", async () => {
  const { store, dispose } = createStore();
  try {
    const executor = new WorkflowExecutor(store);
    const started = executor.start(
      extractProbe({ maxRounds: 1, onMissing: "continue" }),
      { request: "模拟答辩" }
    );
    const interaction = await waitFor("参数追问", () =>
      store.listInteractions({ runId: started.id, status: "pending" })[0]
    );
    executor.respondInteraction(interaction.id, { values: { title: "   " } });
    const finished = await waitFor("运行完成", () => {
      const run = store.getRun(started.id);
      return run?.status === "succeeded" ? run : undefined;
    });
    const steps = store.listSteps(finished.id);
    const payload = steps.find((step) => step.nodeId === "ask")?.output as Record<
      string,
      unknown
    >;
    assert.equal(payload.complete, false);
    assert.deepEqual(payload.missing, ["title"]);
    assert.equal(steps.find((step) => step.nodeId === "render")?.status, "succeeded");
  } finally {
    dispose();
  }
});

test("师者工作台总流按意图只跑命中的那条线", async () => {
  const { store, dispose } = createStore();
  const workflows = loadBuiltinWorkflows();
  const master = workflows.find((item) => item.id === "teacher-workbench-master-v1");
  assert.ok(master);
  for (const workflow of workflows) {
    store.saveWorkflow(workflow);
  }
  try {
    const { run, steps } = await new WorkflowExecutor(store).run(master, {
      question: "给五年级数学备一节分数的意义",
      grade: "五年级",
      subject: "数学",
      topic: "分数的意义"
    });
    assert.equal(run.status, "succeeded");
    const status = new Map(steps.map((step) => [step.nodeId, step.status]));
    // 同时锁住两处：DSL 必须解析 llm.stubOutput，stubLlm 必须认它；
    // 任一处丢掉桩输出，条件边就全落空、兜底边会被误触发。
    assert.equal(status.get("prep-flow"), "succeeded");
    assert.equal(status.get("qa-flow"), "skipped");
    assert.equal(status.get("exam-flow"), "skipped");
    assert.equal(status.get("mind-guide"), "skipped");
    assert.equal(status.get("general-llm"), "skipped");
    assert.equal(status.get("synthesize"), "succeeded");
  } finally {
    dispose();
  }
});
