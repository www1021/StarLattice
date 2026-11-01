import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinition, WorkflowNode } from "../types.js";
import { NODE_KINDS, type NodeKind } from "../types.js";
import { compileWorkflow, WorkflowCompileError, type CompileOptions } from "./compiler.js";
import { loadBuiltinWorkflows } from "./dsl.js";
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
    agent: ["agent", "agentVersion", "prompt", "inputs"],
    llm: ["prompt", "system", "model", "thinking", "temperature", "maxTokens", "inputs"],
    tool: ["tool", "args"],
    template: ["template", "inputs"],
    subworkflow: ["workflowId", "workflowVersion", "inputs", "outputs"],
    parallel: [],
    condition: ["when"],
    loop: ["maxIterations", "while", "patience", "budget"],
    approve: ["instructions", "assignee", "timeoutMs", "inputs"],
    verify: [
      "verifier",
      "rubric",
      "threshold",
      "required",
      "expectedKeywords",
      "minChars",
      "verifiers",
      "requireEvidence",
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
