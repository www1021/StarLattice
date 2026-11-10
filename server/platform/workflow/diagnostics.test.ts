import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseWorkflow, hasBlockingIssue } from "./diagnostics.js";
import { loadBuiltinWorkflows } from "./dsl.js";

function draft(nodes: unknown[], edges: unknown[] = [], inputs: unknown[] = []) {
  return { id: "probe", name: "probe", version: 1, inputs, nodes, edges };
}

function llm(id: string, extra: Record<string, unknown> = {}) {
  return { id, kind: "llm", title: id, prompt: "写点什么", ...extra };
}

test("reports a completely isolated node with its id as path", () => {
  const issues = diagnoseWorkflow(
    draft(
      [llm("a"), llm("b"), llm("orphan")],
      [{ from: "a", to: "b" }]
    )
  );
  const found = issues.filter((issue) => issue.code === "disconnected-node");
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "orphan");
  assert.match(found[0].message, /未被连接/);
  assert.equal(found[0].severity, "error");
  assert.equal(hasBlockingIssue(issues), true);
});

test("reports a node without an incoming edge when the graph has a start", () => {
  const issues = diagnoseWorkflow(
    draft(
      [
        { id: "start", kind: "start" },
        llm("a"),
        llm("b"),
        { id: "end", kind: "end" }
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
        { from: "b", to: "end" }
      ]
    )
  );
  const found = issues.filter((issue) => issue.code === "missing-incoming-edge");
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "b");
  assert.equal(hasBlockingIssue(issues), true);
});

test("treats a dangling output as a warning, not a blocker", () => {
  const issues = diagnoseWorkflow(
    draft(
      [
        { id: "start", kind: "start" },
        llm("a"),
        { id: "end", kind: "end" }
      ],
      [
        { from: "start", to: "a" },
        { from: "start", to: "end" }
      ]
    )
  );
  const found = issues.filter((issue) => issue.code === "missing-outgoing-edge");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
  assert.equal(hasBlockingIssue(issues), false);
});

test("single node workflow is not flagged as disconnected", () => {
  const issues = diagnoseWorkflow(draft([llm("only")]));
  assert.equal(issues.filter((issue) => issue.code === "disconnected-node").length, 0);
});

test("reports empty required fields and empty input references", () => {
  const issues = diagnoseWorkflow(
    draft(
      [
        { id: "draft", kind: "agent", title: "起稿", agent: "", prompt: "..." },
        { id: "join", kind: "template", title: "汇总", template: "${a}", inputs: { topic: "" } }
      ],
      [{ from: "draft", to: "join" }]
    )
  );
  assert.ok(issues.some((issue) => issue.code === "empty-required-field" && issue.path === "draft"));
  assert.ok(issues.some((issue) => issue.code === "empty-input-ref" && issue.path === "join"));
  assert.equal(hasBlockingIssue(issues), true);
});

test("reports incomplete ${} references and undeclared workflow inputs", () => {
  const issues = diagnoseWorkflow(
    draft(
      [llm("a", { prompt: "围绕 ${} 和 ${input.missing} 写一段" })],
      [],
      [{ name: "topic", type: "string", required: true }]
    )
  );
  assert.ok(issues.some((issue) => issue.code === "incomplete-ref" && issue.path === "a"));
  assert.ok(issues.some((issue) => issue.code === "unknown-input-ref" && issue.path === "a"));
});

test("checks required fields inside containers without flagging their connectivity", () => {
  const issues = diagnoseWorkflow(
    draft(
      [
        { id: "start", kind: "start" },
        {
          id: "parallel-1",
          kind: "parallel",
          branches: [[{ id: "inner", kind: "tool", tool: "", title: "内部工具" }]]
        },
        { id: "end", kind: "end" }
      ],
      [
        { from: "start", to: "parallel-1" },
        { from: "parallel-1", to: "end" }
      ]
    )
  );
  assert.ok(issues.some((issue) => issue.code === "empty-required-field" && issue.path === "inner"));
  assert.equal(issues.filter((issue) => issue.code === "disconnected-node").length, 0);
});

test("flags json output without a stub fixture as a warning", () => {
  const issues = diagnoseWorkflow(
    draft([llm("a", { kind: "agent", agent: "planner-agent", outputFormat: "json" })])
  );
  const found = issues.filter((issue) => issue.code === "missing-stub-output");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
});

test("all 15 builtin workflows pass the debug gate without blocking issues", () => {
  const builtins = loadBuiltinWorkflows();
  assert.equal(builtins.length, 15);
  for (const workflow of builtins) {
    const issues = diagnoseWorkflow(workflow);
    assert.equal(
      hasBlockingIssue(issues),
      false,
      `${workflow.id} 不应被调试门禁拦截：${JSON.stringify(issues.filter((issue) => issue.severity === "error"))}`
    );
  }
});

test("non-object input produces no issues instead of throwing", () => {
  assert.deepEqual(diagnoseWorkflow(null), []);
  assert.deepEqual(diagnoseWorkflow("oops"), []);
});
