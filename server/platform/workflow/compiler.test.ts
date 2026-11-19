import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinition, WorkflowNode } from "../types.js";
import { NODE_KINDS, type NodeKind } from "../types.js";
import { compileWorkflow, WorkflowCompileError, type CompileOptions } from "./compiler.js";
import { loadBuiltinWorkflows, parseWorkflowDefinition } from "./dsl.js";
import { COMMON_NODE_FIELDS, NODE_TYPE_SPECS } from "./nodeTypes.js";

function classroomWorkflow(): WorkflowDefinition {
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
  assert.ok(workflow, "classroom-v1.json 应存在");
  return structuredClone(workflow);
}

function compileError(
  workflow: WorkflowDefinition,
  options: CompileOptions = {}
): WorkflowCompileError {
  try {
    compileWorkflow(workflow, options);
  } catch (error) {
    if (error instanceof WorkflowCompileError) {
      return error;
    }
    throw error;
  }
  throw new Error("预期编译失败，但编译通过");
}

function singleNodeWorkflow(node: WorkflowNode, inputs: WorkflowDefinition["inputs"] = []): WorkflowDefinition {
  return { id: "probe", name: "probe", version: 1, inputs, nodes: [node], edges: [] };
}

test("compiles classroom-v1 with topological order and flattened paths", () => {
  const plan = compileWorkflow(classroomWorkflow());

  assert.deepEqual(plan.order, [
    "retrieve",
    "lesson-plan",
    "rehearse",
    "observer",
    "verify-initial",
    "revise-loop",
    "report"
  ]);
  assert.equal(plan.stats.stepCount, 10);
  assert.equal(plan.stats.rootNodes, 7);
  assert.equal(plan.stats.maxDepth, 2);
  assert.equal(plan.steps.find((step) => step.nodeId === "student-weak")?.path, "rehearse/student-weak");
  assert.equal(plan.steps.find((step) => step.nodeId === "verify-loop")?.path, "revise-loop/verify-loop");
});

test("rejects an unknown scheduler mode", () => {
  const workflow = classroomWorkflow();
  (workflow as unknown as { schedulerMode: string }).schedulerMode = "round-robin";
  const error = compileError(workflow);
  assert.ok(error.issues.some((issue) => issue.code === "invalid-scheduler-mode"));
});

test("rejects a workflow with a cycle and names the cycle path", () => {
  const workflow = classroomWorkflow();
  workflow.edges.push({ from: "report", to: "retrieve" });

  const error = compileError(workflow);
  const cycle = error.issues.find((issue) => issue.code === "cycle");
  assert.ok(cycle, "应报告 cycle 错误");
  assert.match(cycle.message, /report -> retrieve/);
});

test("rejects unknown edge targets, duplicate node ids and unknown input refs", () => {
  const ghostEdge = classroomWorkflow();
  ghostEdge.edges.push({ from: "observer", to: "ghost" });
  assert.equal(compileError(ghostEdge).issues[0]?.code, "unknown-edge-node");

  const duplicate = classroomWorkflow();
  duplicate.nodes.push({ id: "retrieve", kind: "tool", tool: "noop" });
  assert.ok(compileError(duplicate).issues.some((issue) => issue.code === "duplicate-node-id"));

  const unknownInput = classroomWorkflow();
  const retrieve = unknownInput.nodes[0];
  assert.equal(retrieve.kind, "tool");
  if (retrieve.kind === "tool") {
    retrieve.args = { query: "${input.unknownField}" };
  }
  assert.ok(compileError(unknownInput).issues.some((issue) => issue.code === "unknown-input"));
});

test("rejects references to outputs that are not available yet", () => {
  const workflow = classroomWorkflow();
  const retrieve = workflow.nodes[0];
  assert.equal(retrieve.kind, "tool");
  if (retrieve.kind === "tool") {
    retrieve.args = { query: "${report.output}" };
  }
  assert.ok(compileError(workflow).issues.some((issue) => issue.code === "reference-order"));

  const crossBranch = singleNodeWorkflow({
    id: "fanout",
    kind: "parallel",
    branches: [
      { id: "left", kind: "agent", agent: "agent-a" },
      { id: "right", kind: "agent", agent: "agent-b", inputs: { peer: "${left.output}" } }
    ]
  });
  assert.ok(compileError(crossBranch).issues.some((issue) => issue.code === "reference-order"));
});

test("rejects expressions the runtime cannot evaluate", () => {
  const workflow = singleNodeWorkflow({
    id: "gate",
    kind: "condition",
    when: "score > 0.8",
    then: [{ id: "pass", kind: "agent", agent: "agent-a" }]
  });
  const error = compileError(workflow);
  assert.ok(error.issues.some((issue) => issue.code === "unsupported-expression"));
});

test("allows loop conditions to read outputs produced inside the body", () => {
  const workflow = singleNodeWorkflow({
    id: "polish",
    kind: "loop",
    maxIterations: 3,
    while: "${check.score} < 0.9",
    body: [
      { id: "rewrite", kind: "agent", agent: "agent-a" },
      { id: "check", kind: "verify", verifier: "verifier-a", threshold: 0.9 }
    ]
  });
  const plan = compileWorkflow(workflow);
  assert.equal(plan.stats.stepCount, 2);
});

test("resolves ${loop.*} only inside a loop body", () => {
  const workflow = singleNodeWorkflow({
    id: "polish",
    kind: "loop",
    maxIterations: 2,
    body: [
      {
        id: "rewrite",
        kind: "agent",
        agent: "agent-a",
        inputs: {
          draft: "${loop.artifact}",
          issues: "${loop.issues}",
          score: "${loop.score}",
          round: "${loop.iteration}",
          query: "${loop.retrievalQuery}"
        }
      },
      { id: "check", kind: "verify", verifier: "verifier-a", threshold: 0.9 }
    ]
  });
  assert.equal(compileWorkflow(workflow).stats.stepCount, 2);

  const outside = singleNodeWorkflow({
    id: "bad",
    kind: "agent",
    agent: "agent-a",
    inputs: { draft: "${loop.artifact}" }
  });
  assert.ok(compileError(outside).issues.some((issue) => issue.code === "loop-ref-outside-loop"));

  const unknownKey = singleNodeWorkflow({
    id: "polish",
    kind: "loop",
    maxIterations: 2,
    body: [{ id: "rewrite", kind: "agent", agent: "agent-a", inputs: { draft: "${loop.draft}" } }]
  });
  assert.ok(compileError(unknownKey).issues.some((issue) => issue.code === "unknown-loop-ref"));
});

test("node-type contract stays in sync with the parser for all node kinds", () => {
  const acceptedFields: Record<NodeKind, string[]> = {
    start: [],
    end: ["inputs"],
    agent: [
      "agent",
      "agentVersion",
      "prompt",
      "outputFormat",
      "outputContract",
      "loopRole",
      "promoteToAgent",
      "toolCalling",
      "model",
      "capabilities",
      "inputs"
    ],
    llm: ["prompt", "system", "model", "thinking", "temperature", "topP", "maxTokens", "inputs"],
    clarify: [
      "prompt",
      "model",
      "clarifyOn",
      "maxQuestions",
      "assignee",
      "timeoutMs",
      "stubOutput",
      "inputs"
    ],
    knowledge: ["query", "knowledgeBaseIds", "topK", "inputs"],
    extract: [
      "params",
      "prompt",
      "model",
      "askPrompt",
      "maxRounds",
      "onMissing",
      "assignee",
      "timeoutMs",
      "stubOutput",
      "inputs"
    ],
    tool: ["tool", "args"],
    http: ["method", "url", "headers", "requestBody", "timeoutMs", "inputs"],
    template: ["template", "inputs"],
    subworkflow: ["workflowId", "workflowVersion", "inputs", "outputs"],
    parallel: [],
    condition: ["when"],
    loop: ["maxIterations", "while", "patience", "budget"],
    approve: ["instructions", "assignee", "timeoutMs", "inputs"],
    human: [
      "prompt",
      "fields",
      "submitLabel",
      "assignee",
      "timeoutMs",
      "inputs",
      "options",
      "optionsFrom",
      "generatePrompt",
      "model"
    ],
    verify: [
      "verifier",
      "rubric",
      "threshold",
      "required",
      "expectedKeywords",
      "minChars",
      "verifiers",
      "requireEvidence",
      "checks",
      "model",
      "inputs"
    ]
  };
  const containerKinds = new Set<NodeKind>(["parallel", "condition", "loop"]);

  assert.deepEqual(
    NODE_TYPE_SPECS.map((spec) => spec.kind).sort(),
    [...NODE_KINDS].sort()
  );
  for (const spec of NODE_TYPE_SPECS) {
    assert.equal(spec.shape, containerKinds.has(spec.kind) ? "container" : "node", spec.kind);
    if (spec.shape === "container") {
      assert.ok(spec.blocks.length > 0, `${spec.kind} 必须声明子块`);
    } else {
      assert.equal(spec.blocks.length, 0, `${spec.kind} 不应有子块`);
    }
    for (const field of spec.fields) {
      assert.ok(acceptedFields[spec.kind].includes(field.key), `${spec.kind} 的字段 ${field.key} 不被解析器接受`);
    }
  }
  assert.deepEqual(
    COMMON_NODE_FIELDS.map((field) => field.key),
    ["id", "title", "description"]
  );
});

test("validates verify number_match checks and tolerance at compile time", () => {
  const unknown = singleNodeWorkflow({
    id: "check",
    kind: "verify",
    verifier: "verifier-a",
    checks: [{ type: "bogus" as never }]
  });
  assert.ok(compileError(unknown).issues.some((issue) => issue.code === "unknown-verify-check"));

  const badTolerance = singleNodeWorkflow({
    id: "check",
    kind: "verify",
    verifier: "verifier-a",
    checks: [{ type: "number_match", tolerance: 1.5 }]
  });
  assert.ok(compileError(badTolerance).issues.some((issue) => issue.code === "invalid-verify-tolerance"));

  const ok = singleNodeWorkflow({
    id: "check",
    kind: "verify",
    verifier: "verifier-a",
    checks: [{ type: "number_match", tolerance: 0.01 }]
  });
  assert.doesNotThrow(() => compileWorkflow(ok));
});

test("validates verify citation, section and per-verifier model settings", () => {
  const badCitations = singleNodeWorkflow({
    id: "check",
    kind: "verify",
    verifier: "verifier-a",
    minCitations: 51
  });
  assert.ok(
    compileError(badCitations).issues.some((issue) => issue.code === "invalid-verify-min-citations")
  );

  const badSections = singleNodeWorkflow({
    id: "check",
    kind: "verify",
    verifier: "verifier-a",
    requiredSections: [" "]
  });
  assert.ok(
    compileError(badSections).issues.some((issue) => issue.code === "invalid-verify-sections")
  );

  const badModels = singleNodeWorkflow({
    id: "check",
    kind: "verify",
    verifier: "verifier-a",
    verifierModels: {}
  });
  assert.ok(
    compileError(badModels).issues.some((issue) => issue.code === "invalid-verify-models")
  );

  const ok = singleNodeWorkflow({
    id: "check",
    kind: "verify",
    verifier: "verifier-a",
    minCitations: 2,
    requiredSections: ["结论"],
    verifierModels: { "verifier-a": "reasoning", "verifier-b": "fast" },
    evidenceView: "split"
  });
  assert.doesNotThrow(() => compileWorkflow(ok));
});

test("accepts start/end anchors with knowledge and http leaves", () => {
  const workflow: WorkflowDefinition = {
    id: "anchor-probe",
    name: "锚点探针",
    version: 1,
    inputs: [{ name: "topic", type: "string", required: true }],
    nodes: [
      { id: "begin", kind: "start" },
      {
        id: "recall",
        kind: "knowledge",
        query: "${input.topic} 的课标要求",
        knowledgeBaseIds: ["kb-1"],
        topK: 3
      },
      {
        id: "fetch",
        kind: "http",
        method: "POST",
        url: "https://example.com/api/plan",
        headers: { "content-type": "application/json" },
        requestBody: { topic: "${input.topic}" },
        timeoutMs: 5000
      },
      { id: "finish", kind: "end", inputs: { draft: "${fetch.output}" } }
    ],
    edges: [
      { from: "begin", to: "recall" },
      { from: "recall", to: "fetch" },
      { from: "fetch", to: "finish" }
    ]
  };

  const plan = compileWorkflow(workflow);
  assert.deepEqual(plan.order, ["begin", "recall", "fetch", "finish"]);
  assert.equal(plan.steps.find((step) => step.nodeId === "recall")?.node.kind, "knowledge");
  assert.equal(plan.steps.find((step) => step.nodeId === "fetch")?.node.kind, "http");
});

test("rejects duplicate anchors and edges that cross the start/end boundary", () => {
  const duplicateStart: WorkflowDefinition = {
    id: "two-starts",
    name: "双开始",
    version: 1,
    inputs: [],
    nodes: [
      { id: "s1", kind: "start" },
      { id: "s2", kind: "start" }
    ],
    edges: []
  };
  assert.equal(compileError(duplicateStart).issues[0]?.code, "duplicate-start");

  const incoming: WorkflowDefinition = {
    id: "start-incoming",
    name: "开始节点入边",
    version: 1,
    inputs: [],
    nodes: [
      { id: "begin", kind: "start" },
      { id: "work", kind: "agent", agent: "agent-a" }
    ],
    edges: [{ from: "work", to: "begin" }]
  };
  assert.ok(compileError(incoming).issues.some((issue) => issue.code === "start-has-incoming"));

  const outgoing: WorkflowDefinition = {
    id: "end-outgoing",
    name: "结束节点出边",
    version: 1,
    inputs: [],
    nodes: [
      { id: "work", kind: "agent", agent: "agent-a" },
      { id: "finish", kind: "end" }
    ],
    edges: [{ from: "finish", to: "work" }]
  };
  assert.ok(compileError(outgoing).issues.some((issue) => issue.code === "end-has-outgoing"));
});

test("rejects invalid knowledge and http node settings", () => {
  const badTopK = singleNodeWorkflow({
    id: "recall",
    kind: "knowledge",
    query: "分数的意义",
    topK: 50
  });
  assert.ok(compileError(badTopK).issues.some((issue) => issue.code === "invalid-knowledge-top-k"));

  const badProtocol = singleNodeWorkflow({
    id: "fetch",
    kind: "http",
    method: "GET",
    url: "ftp://example.com/data"
  });
  assert.ok(compileError(badProtocol).issues.some((issue) => issue.code === "invalid-http-url"));

  const badTimeout = singleNodeWorkflow({
    id: "fetch",
    kind: "http",
    method: "GET",
    url: "https://example.com",
    timeoutMs: 500
  });
  assert.ok(compileError(badTimeout).issues.some((issue) => issue.code === "invalid-http-timeout"));
});

function childDefinition(id = "child-probe"): WorkflowDefinition {
  return {
    id,
    name: "子流程探针",
    version: 1,
    inputs: [{ name: "topic", type: "string", required: true }],
    nodes: [
      { id: "think", kind: "llm", prompt: "分析 ${input.topic} 的教学难点" },
      { id: "draft", kind: "agent", agent: "agent-a", inputs: { brief: "${think.output}" } },
      { id: "check", kind: "verify", verifier: "verifier-a", threshold: 0.8 }
    ],
    edges: [
      { from: "think", to: "draft" },
      { from: "draft", to: "check" }
    ]
  };
}

function parentDefinition(childId = "child-probe"): WorkflowDefinition {
  return {
    id: "parent-probe",
    name: "父流程探针",
    version: 1,
    inputs: [{ name: "topic", type: "string", required: true }],
    nodes: [
      { id: "prepare", kind: "template", template: "# ${input.topic}" },
      {
        id: "child",
        kind: "subworkflow",
        workflowId: childId,
        inputs: { topic: "${input.topic}" },
        outputs: { draft: "${draft.output}", score: "${check.score}" }
      },
      { id: "summary", kind: "template", template: "${child.draft} / ${child.score}" }
    ],
    edges: [
      { from: "prepare", to: "child" },
      { from: "child", to: "summary" }
    ]
  };
}

test("expands a sub-workflow in place with prefixed paths", () => {
  const plan = compileWorkflow(parentDefinition(), {
    resolveWorkflow: (id) => (id === "child-probe" ? childDefinition() : undefined)
  });

  assert.equal(plan.stats.rootNodes, 3);
  assert.equal(plan.stats.stepCount, 5);
  assert.equal(plan.stats.subWorkflows, 1);
  assert.deepEqual(
    plan.steps.map((step) => step.path),
    ["prepare", "child/think", "child/draft", "child/check", "summary"]
  );
  const subStatement = plan.program.find((statement) => statement.type === "subworkflow");
  assert.ok(subStatement && subStatement.type === "subworkflow");
  assert.equal(subStatement.definition?.id, "child-probe");
  assert.equal(subStatement.program.length, 3);
});

test("rejects missing sub-workflow inputs, unknown refs and unresolved workflows", () => {
  const missing = parentDefinition();
  const subNode = missing.nodes[1];
  assert.equal(subNode.kind, "subworkflow");
  if (subNode.kind === "subworkflow") {
    subNode.inputs = {};
  }
  const missingError = compileError(missing, {
    resolveWorkflow: () => childDefinition()
  });
  assert.ok(missingError.issues.some((issue) => issue.code === "subworkflow-missing-input"));

  const badOutput = parentDefinition();
  const badNode = badOutput.nodes[1];
  if (badNode.kind === "subworkflow") {
    badNode.outputs = { draft: "${ghost.output}" };
  }
  assert.ok(
    compileError(badOutput, { resolveWorkflow: () => childDefinition() }).issues.some(
      (issue) => issue.code === "unknown-subworkflow-output-ref"
    )
  );

  assert.equal(compileError(parentDefinition()).issues[0]?.code, "unknown-subworkflow");

  const badInput = parentDefinition();
  const inputNode = badInput.nodes[1];
  if (inputNode.kind === "subworkflow") {
    inputNode.inputs = { topic: "${ghost.output}" };
  }
  assert.ok(
    compileError(badInput, { resolveWorkflow: () => childDefinition() }).issues.some(
      (issue) => issue.code === "unknown-node-ref"
    )
  );
});

test("rejects direct and indirect sub-workflow cycles", () => {
  const selfReferencing: WorkflowDefinition = {
    ...parentDefinition("parent-probe")
  };
  const selfError = compileError(selfReferencing, {
    resolveWorkflow: () => selfReferencing
  });
  assert.ok(selfError.issues.some((issue) => issue.code === "subworkflow-cycle"));

  const left: WorkflowDefinition = {
    id: "flow-left",
    name: "左",
    version: 1,
    inputs: [],
    nodes: [
      { id: "to-right", kind: "subworkflow", workflowId: "flow-right", inputs: {} }
    ],
    edges: []
  };
  const right: WorkflowDefinition = {
    id: "flow-right",
    name: "右",
    version: 1,
    inputs: [],
    nodes: [
      { id: "to-left", kind: "subworkflow", workflowId: "flow-left", inputs: {} }
    ],
    edges: []
  };
  const cycleError = compileError(left, {
    resolveWorkflow: (id) => (id === "flow-left" ? left : id === "flow-right" ? right : undefined)
  });
  assert.ok(cycleError.issues.some((issue) => issue.code === "subworkflow-cycle"));
  assert.match(
    cycleError.issues.find((issue) => issue.code === "subworkflow-cycle")?.message ?? "",
    /flow-left@1 -> flow-right@1 -> flow-left@1/
  );
});

test("compiles conditional edges into a top-level graph", () => {
  const workflow: WorkflowDefinition = {
    id: "edge-probe",
    name: "边条件探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "start", kind: "start" },
      { id: "draft", kind: "agent", agent: "planner-agent" },
      { id: "good", kind: "template", template: "ok ${draft.output}" },
      { id: "fallback", kind: "template", template: "fallback" }
    ],
    edges: [
      { from: "start", to: "draft" },
      { from: "draft", to: "good", when: "${draft.output} != \"\"" },
      { from: "draft", to: "fallback", label: "兜底" }
    ]
  };

  const plan = compileWorkflow(workflow);
  assert.deepEqual(plan.graph.entry, ["start"]);
  assert.equal(plan.graph.edges.length, 3);
  assert.equal(plan.graph.edges.find((edge) => edge.to === "good")?.when?.ref, "draft.output");
  assert.equal(plan.graph.edges.find((edge) => edge.to === "fallback")?.label, "兜底");
});

test("rejects edge conditions with unknown or downstream references", () => {
  const workflow: WorkflowDefinition = {
    id: "edge-ref-probe",
    name: "边条件引用探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "start", kind: "start" },
      { id: "draft", kind: "agent", agent: "planner-agent" },
      { id: "good", kind: "template", template: "ok" }
    ],
    edges: [
      { from: "start", to: "draft" },
      { from: "draft", to: "good", when: "${good.output} != \"\"" }
    ]
  };
  assert.ok(compileError(workflow).issues.some((issue) => issue.code === "reference-order"));

  workflow.edges[1] = { from: "draft", to: "good", when: "${ghost.output} != \"\"" };
  assert.ok(compileError(workflow).issues.some((issue) => issue.code === "unknown-node-ref"));
});


test("accepts a well-formed node error policy", () => {
  const workflow = singleNodeWorkflow({
    id: "llm-guarded",
    kind: "llm",
    prompt: "写一段话",
    errorPolicy: { strategy: "continue", retries: 2, retryIntervalMs: 500, timeoutMs: 30_000 }
  } as WorkflowNode);

  const plan = compileWorkflow(workflow);
  const node = plan.steps[0]?.node as WorkflowNode;
  assert.equal(node.errorPolicy?.retries, 2);
  assert.equal(node.errorPolicy?.strategy, "continue");
});

test("rejects out-of-range retries and missing fallback value", () => {
  const tooMany = singleNodeWorkflow({
    id: "llm-retry",
    kind: "llm",
    prompt: "写一段话",
    errorPolicy: { retries: 9 }
  } as WorkflowNode);
  assert.ok(compileError(tooMany).issues.some((issue) => issue.code === "invalid-error-policy"));

  const missingFallback = singleNodeWorkflow({
    id: "llm-fallback",
    kind: "llm",
    prompt: "写一段话",
    errorPolicy: { strategy: "fallback" }
  } as WorkflowNode);
  assert.ok(compileError(missingFallback).issues.some((issue) => issue.code === "invalid-error-policy"));

  const tooFast = singleNodeWorkflow({
    id: "llm-timeout",
    kind: "llm",
    prompt: "写一段话",
    errorPolicy: { timeoutMs: 10 }
  } as WorkflowNode);
  assert.ok(compileError(tooFast).issues.some((issue) => issue.code === "invalid-error-policy"));
});

test("validates nested output schema names", () => {
  const workflow = singleNodeWorkflow({
    id: "llm-output",
    kind: "llm",
    prompt: "写一段话",
    outputSchema: [
      { name: "output", type: "object", properties: [{ name: "bad name", type: "string" }] }
    ]
  } as WorkflowNode);
  assert.ok(compileError(workflow).issues.some((issue) => issue.code === "invalid-port-name"));
});

test("参数提取节点：参数表原样解析，重名与非法轮次在编译期报错", () => {
  const parsed = parseWorkflowDefinition({
    id: "extract-probe",
    name: "参数提取探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "ask",
        kind: "extract",
        params: [
          { name: "title", label: "论文题目", description: "完整的论文标题" },
          { name: "mode", type: "string", required: false }
        ],
        askPrompt: "请提供您的论文题目，我将为您模拟开题答辩。",
        maxRounds: 2
      },
      { id: "end", kind: "end" }
    ],
    edges: [
      { from: "start", to: "ask" },
      { from: "ask", to: "end" }
    ]
  });
  const node = parsed.nodes.find((item) => item.id === "ask");
  assert.ok(node && node.kind === "extract");
  assert.deepEqual(
    node.params.map((param) => [param.name, param.label, param.required]),
    [
      ["title", "论文题目", undefined],
      ["mode", undefined, false]
    ]
  );
  // 没说 required 的参数默认必填，运行时才会真的拦住。
  assert.equal(node.maxRounds, 2);
  assert.equal(node.askPrompt, "请提供您的论文题目，我将为您模拟开题答辩。");
  compileWorkflow(parsed);

  const duplicated = structuredClone(parsed) as unknown as {
    nodes: Array<Record<string, unknown>>;
  };
  const ask = duplicated.nodes.find((item) => item.id === "ask")!;
  ask.params = [
    { name: "title", label: "论文题目" },
    { name: "title", label: "重复的题目" }
  ];
  assert.ok(
    compileError(duplicated as unknown as WorkflowDefinition).issues.some(
      (issue) => issue.code === "duplicate-extract-param"
    )
  );

  ask.params = [{ name: "bad name", label: "带空格的名字" }];
  assert.ok(
    compileError(duplicated as unknown as WorkflowDefinition).issues.some(
      (issue) => issue.code === "invalid-extract-param"
    )
  );

  ask.params = [{ name: "title" }];
  ask.maxRounds = 9;
  assert.ok(
    compileError(duplicated as unknown as WorkflowDefinition).issues.some(
      (issue) => issue.code === "invalid-extract-rounds"
    )
  );
});

test("师者工作台总流能展开五条业务子流，六线分流齐全", () => {
  const workflows = loadBuiltinWorkflows();
  const master = workflows.find((item) => item.id === "teacher-workbench-master-v1");
  assert.ok(master, "teacher-workbench-master-v1.json 应存在");

  const latest = new Map<string, WorkflowDefinition>();
  for (const workflow of workflows) {
    const current = latest.get(workflow.id);
    if (!current || current.version < workflow.version) latest.set(workflow.id, workflow);
  }
  const resolveWorkflow: CompileOptions["resolveWorkflow"] = (id, version) =>
    version === undefined
      ? latest.get(id)
      : workflows.find((item) => item.id === id && item.version === version);

  const plan = compileWorkflow(master, { resolveWorkflow });
  // 总流自身的条件分流 + 子流内的「循环 → 条件 → 循环」目前占到 6 层。
  // 断言锁住当前深度，再往子流里加深容器要同步核对编译上限。
  assert.equal(plan.stats.maxDepth, 6);

  const flowRefs = master.nodes
    .filter((node) => node.kind === "subworkflow")
    .map((node) => (node as { workflowId?: string }).workflowId ?? "");
  assert.deepEqual(flowRefs, [
    "lesson-prep-v1",
    "qa-tutor-v1",
    "exam-quality-v1",
    "safety-health-v1",
    "cd-master-v1"
  ]);

  const routed = master.edges.filter((edge) => edge.when).map((edge) => edge.to);
  assert.deepEqual(routed, [
    "prep-flow",
    "qa-flow",
    "exam-flow",
    "safety-flow",
    "observe-flow",
    "mind-guide"
  ]);
  assert.equal(master.edges.filter((edge) => !edge.when && edge.from === "classify").length, 1);
});
