import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinition, WorkflowNode } from "../types.js";
import { NODE_KINDS, type NodeKind } from "../types.js";
import { compileWorkflow, WorkflowCompileError } from "./compiler.js";
import { loadBuiltinWorkflows } from "./dsl.js";
import { COMMON_NODE_FIELDS, NODE_TYPE_SPECS } from "./nodeTypes.js";

function classroomWorkflow(): WorkflowDefinition {
  const workflow = loadBuiltinWorkflows().find((item) => item.id === "classroom-v1");
  assert.ok(workflow, "classroom-v1.json 应存在");
  return structuredClone(workflow);
}

function compileError(workflow: WorkflowDefinition): WorkflowCompileError {
  try {
    compileWorkflow(workflow);
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

test("node-type contract stays in sync with the parser for all six kinds", () => {
  const acceptedFields: Record<NodeKind, string[]> = {
    agent: ["agent", "prompt", "inputs"],
    tool: ["tool", "args"],
    parallel: [],
    condition: ["when"],
    loop: ["maxIterations", "while"],
    verify: ["verifier", "rubric", "threshold", "inputs"]
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
