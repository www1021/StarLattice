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
  assert.match(found[0].message, /没有连任何线/);
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

test("有结束节点时，悬空输出是硬错误，产物到不了终点不允许运行", () => {
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
  assert.equal(found[0].severity, "error");
  assert.match(found[0].message, /没有输出连线/);
  assert.equal(hasBlockingIssue(issues), true);
});

test("没有结束节点的流程保留宽松判定，悬空输出只提示", () => {
  const issues = diagnoseWorkflow(
    draft([llm("a"), llm("b")], [{ from: "a", to: "b" }])
  );
  const found = issues.filter((issue) => issue.code === "missing-outgoing-edge");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "warning");
  assert.equal(hasBlockingIssue(issues), false);
});

test("报告从开始节点到不了的节点", () => {
  const issues = diagnoseWorkflow(
    draft(
      [
        { id: "start", kind: "start" },
        llm("a"),
        llm("island-a"),
        llm("island-b"),
        { id: "end", kind: "end" }
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
        { from: "island-a", to: "island-b" },
        { from: "island-b", to: "end" }
      ]
    )
  );
  const found = issues.filter((issue) => issue.code === "unreachable-node");
  assert.deepEqual(
    found.map((issue) => issue.path).sort(),
    ["island-a", "island-b"]
  );
  assert.equal(hasBlockingIssue(issues), true);
});

test("报告互相连成圈、但流不到结束节点的分支", () => {
  const issues = diagnoseWorkflow(
    draft(
      [
        { id: "start", kind: "start" },
        llm("a"),
        llm("x"),
        llm("y"),
        { id: "end", kind: "end" }
      ],
      [
        { from: "start", to: "a" },
        { from: "a", to: "end" },
        { from: "start", to: "x" },
        { from: "x", to: "y" },
        { from: "y", to: "x" }
      ]
    )
  );
  const found = issues.filter((issue) => issue.code === "dead-end-node");
  assert.deepEqual(found.map((issue) => issue.path).sort(), ["x", "y"]);
  assert.equal(hasBlockingIssue(issues), true);
});

test("汇入结束节点的分支不算断链", () => {
  const issues = diagnoseWorkflow(
    draft(
      [
        { id: "start", kind: "start" },
        llm("a"),
        llm("side"),
        { id: "end", kind: "end" }
      ],
      [
        { from: "start", to: "a" },
        { from: "start", to: "side" },
        { from: "side", to: "a" },
        { from: "a", to: "end" }
      ]
    )
  );
  assert.equal(issues.filter((issue) => issue.code === "dead-end-node").length, 0);
  assert.equal(issues.filter((issue) => issue.code === "unreachable-node").length, 0);
});

test("报错文案带节点标题，方便在画布上找到是哪个节点", () => {
  const issues = diagnoseWorkflow(
    draft(
      [
        { id: "start", kind: "start" },
        { id: "reply-3", kind: "template", title: "回复3", template: "你好" },
        { id: "end", kind: "end" }
      ],
      [
        { from: "start", to: "reply-3" },
        { from: "start", to: "end" }
      ]
    )
  );
  const found = issues.find((issue) => issue.path === "reply-3");
  assert.ok(found);
  assert.match(found.message, /回复3/);
  assert.match(found.message, /reply-3/);
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

test("all builtin workflows pass the debug gate without blocking issues", () => {
  const builtins = loadBuiltinWorkflows();
  assert.ok(builtins.length >= 17, `builtins: ${builtins.length}`);
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

/** 选项卡 + 一个下游节点：用来验证各条选项端口/兜底口的诊断。 */
function tabDraft(options: string[], fromPort: string) {
  return draft(
    [
      { id: "start", kind: "start" },
      { id: "ask", kind: "human", title: "选项卡", prompt: "选一个", options },
      llm("next")
    ],
    [
      { from: "start", to: "ask" },
      { from: "ask", to: "next", fromPort }
    ]
  );
}

test("选项卡的「其他」兜底口是合法端口，不会被当成认不出的端口", () => {
  const issues = diagnoseWorkflow(tabDraft(["甲", "乙"], "choice:other"));
  assert.equal(
    issues.filter((issue) => issue.code === "unknown-edge-port" || issue.code === "stale-choice-port")
      .length,
    0
  );
});

test("选项删光之后兜底口也不存在了，连线会被点名", () => {
  const issues = diagnoseWorkflow(tabDraft([], "choice:other"));
  const found = issues.filter((issue) => issue.code === "stale-choice-port");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /兜底/);
});

test("选项卡的连线既没端口也看不出属于哪个选项时会被点名", () => {
  const issues = diagnoseWorkflow(
    draft(
      [
        { id: "start", kind: "start" },
        { id: "ask", kind: "human", title: "选项卡", prompt: "选一个", options: ["甲", "乙"] },
        llm("next")
      ],
      [
        { from: "start", to: "ask" },
        // 条件和选项无关：推断不出端口，运行期这条线永远不会激活。
        { from: "ask", to: "next", when: "${ask.output} == 甲" }
      ]
    )
  );
  const found = issues.filter((issue) => issue.code === "unbound-choice-edge");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /选项端口/);
});

test("条件里写了选项文本的老连线不算没绑定，不会被误报", () => {
  const issues = diagnoseWorkflow(
    draft(
      [
        { id: "start", kind: "start" },
        { id: "ask", kind: "human", title: "选项卡", prompt: "选一个", options: ["甲", "乙"] },
        llm("next")
      ],
      [
        { from: "start", to: "ask" },
        { from: "ask", to: "next", when: "${ask.choice} == 甲" }
      ]
    )
  );
  assert.equal(issues.filter((issue) => issue.code === "unbound-choice-edge").length, 0);
});

/** 参数提取的草稿：留空参数表 / 重名 / 没写描述三种常见配置错误。 */
function extractDraft(params: unknown[]) {
  return draft(
    [
      { id: "start", kind: "start" },
      { id: "ask", kind: "extract", title: "参数提取", params },
      { id: "end", kind: "end" }
    ],
    [
      { from: "start", to: "ask" },
      { from: "ask", to: "end" }
    ]
  );
}

test("参数提取没定义参数会被点名，否则运行时直接放行", () => {
  const issues = diagnoseWorkflow(extractDraft([]));
  const found = issues.filter((issue) => issue.code === "empty-extract-params");
  assert.equal(found.length, 1);
  assert.match(found[0].message, /参数信息/);
});

test("参数提取的参数重名和缺描述分开提示，补齐描述后消失", () => {
  const issues = diagnoseWorkflow(extractDraft([{ name: "title" }, { name: "title" }]));
  assert.equal(issues.filter((issue) => issue.code === "duplicate-extract-param").length, 1);
  assert.equal(issues.filter((issue) => issue.code === "vague-extract-param").length, 1);

  const fixed = diagnoseWorkflow(extractDraft([{ name: "title", description: "完整论文标题" }]));
  assert.equal(fixed.filter((issue) => issue.code.startsWith("duplicate-extract")).length, 0);
  assert.equal(fixed.filter((issue) => issue.code === "vague-extract-param").length, 0);
  assert.equal(fixed.filter((issue) => issue.code === "empty-extract-params").length, 0);
});
