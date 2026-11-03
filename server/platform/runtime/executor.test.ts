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

test("runs classroom-v1 end to end and records the 0.62 → 0.86 loop", async () => {
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
    assert.deepEqual(scores, [0.62, 0.74, 0.86]);

    const verifications = store.listVerifyResults(run.id);
    for (const verification of verifications) {
      const layers = verification.detail?.layers as
        | { rule: { score: number }; crossCheck: { verifiers: unknown[] }; baseline: { coverage: number } }
        | undefined;
      assert.ok(layers, "验证结果应携带三层明细");
      assert.ok(layers.rule.score > 0.8);
      assert.equal(layers.baseline.coverage, 1);
      assert.equal(layers.crossCheck.verifiers.length, 2);
    }

    const iterations = store.listLoopIterations(run.id);
    assert.equal(iterations.length, 2);
    assert.equal(iterations[0]?.scoreBefore, 0.62);
    assert.equal(iterations[1]?.scoreAfter, 0.86);
    assert.equal(store.getRun(run.id)?.output?.score, 0.86);
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

test("counts sub-workflow verifications toward the run attempt curve", async () => {
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
    // 子流程里的验证也计入整条运行的轮次，因此四层验证依次拿到 0.62 / 0.74 / 0.86 / 0.98。
    assert.deepEqual(
      verifications.map((result) => {
        const layers = result.detail?.layers as { crossCheck: { score: number } } | undefined;
        return layers?.crossCheck.score;
      }),
      [0.62, 0.74, 0.86, 0.98]
    );

    const overallStep = steps.find((step) => step.nodeId === "verify-overall");
    assert.ok(overallStep);
    const overall = verifications.find((result) => result.stepId === overallStep.id);
    assert.ok(overall);
    assert.equal(overall.score, 0.86);
    assert.ok(overall.evidence.length > 0);
    assert.equal((run.output?.verify as { passed?: boolean } | undefined)?.passed, true);

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
    assert.match(iterations[1]?.changes.join(" ") ?? "", /停止原因：达到验证阈值/);

    const revisions = steps.filter((step) => step.nodeId === "revise");
    assert.equal(revisions.length, 2);
    const directive = (revisions[0]?.input as { selfLoop?: Record<string, unknown> }).selfLoop;
    assert.equal(directive?.action, "rewrite");
    assert.equal(directive?.targetScore, 0.85);
    assert.ok(Array.isArray(directive?.issues) && directive.issues.length > 0);

    const summaries = (run.output?.selfLoop ?? []) as Array<Record<string, unknown>>;
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.iterations, 2);
    assert.equal(summaries[0]?.stopReason, "passed");
    assert.equal(summaries[0]?.bestScore, 0.86);
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

test("business-analysis-v1 blocks gross-profit errors and passes after net recalculation", async () => {
  const { store, dispose } = createStore();
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "business-analysis-v1");
  assert.ok(workflow);
  const entry = path.resolve("scripts", "data-analysis-mcp.mjs");
  const { client } = await McpClient.open({
    transport: "stdio",
    command: process.execPath,
    args: [entry]
  });

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

    const repairedReport = steps.find((step) => step.nodeId === "rebuild")?.output as
      | { output?: string }
      | undefined;
    assert.match(repairedReport?.output ?? "", /毛利额：42,290\.00 元/);
    assert.doesNotMatch(repairedReport?.output ?? "", /45,990\.00/);
  } finally {
    await client.close();
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

test("scheduler counts agents reserved by active runs", async () => {
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
    store.createRun({
      workflowId: "load-holder",
      workflowVersion: 1,
      workflowInput: {},
      mode: "stub",
      status: "running",
      plan: { decisions: [{ taskId: "review", agentId: "topic-innovation-agent" }] }
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
