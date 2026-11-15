import assert from "node:assert/strict";
import test from "node:test";
import { describeSyntaxError, WorkflowSyntaxError } from "./dsl.js";

const source = {
  id: "wf",
  name: "测试流程",
  version: 1,
  inputs: [{ name: "topic", type: "string", required: true }],
  nodes: [
    { id: "start", kind: "start" },
    {
      id: "ask",
      kind: "extract",
      title: "参数提取1",
      params: [{ name: "title", label: "", description: "论文题目" }]
    },
    { id: "end", kind: "end" }
  ],
  edges: [{ from: "start", to: "ask" }]
};

test.describe("describeSyntaxError", () => {
  test("把 nodes[i].params[k].label 翻译成可读位置并定位到节点与参数行", () => {
    const error = new WorkflowSyntaxError("nodes[1].params[0].label", "应为非空字符串");
    const result = describeSyntaxError(source, error);
    assert.equal(result.nodeId, "ask");
    assert.equal(result.paramIndex, 0);
    assert.match(result.path, /参数提取1/);
    assert.match(result.path, /参数信息/);
    assert.match(result.path, /标签/);
    assert.equal(result.message, "应为非空字符串");
  });

  test("剥掉 message 里重复的路径前缀", () => {
    const error = new WorkflowSyntaxError("nodes[1].params[0].label", "应为非空字符串");
    const result = describeSyntaxError(source, error);
    assert.equal(result.message, "应为非空字符串");
    assert.ok(!result.message.includes("nodes["));
  });

  test("顶层输入变量的问题不带节点上下文", () => {
    const error = new WorkflowSyntaxError("inputs[0].name", "应为非空字符串");
    const result = describeSyntaxError(source, error);
    assert.equal(result.nodeId, undefined);
    assert.match(result.path, /输入变量/);
    assert.match(result.path, /名称/);
  });

  test("连线问题可读且不指向某个节点", () => {
    const error = new WorkflowSyntaxError("edges[0].from", "应为非空字符串");
    const result = describeSyntaxError(source, error);
    assert.equal(result.nodeId, undefined);
    assert.match(result.path, /连线/);
    assert.match(result.path, /起点/);
  });

  test("嵌套容器里的节点也能定位到正确 id", () => {
    const nested = {
      id: "wf",
      name: "嵌套",
      version: 1,
      nodes: [
        { id: "start", kind: "start" },
        {
          id: "gate",
          kind: "condition",
          when: "x",
          then: [
            { id: "inner", kind: "extract", title: "内层提取", params: [{ name: "a", label: "" }] }
          ],
          else: []
        },
        { id: "end", kind: "end" }
      ],
      edges: [{ from: "start", to: "gate" }]
    };
    const error = new WorkflowSyntaxError("nodes[1].then[0].params[0].label", "应为非空字符串");
    const result = describeSyntaxError(nested, error);
    assert.equal(result.nodeId, "inner");
    assert.equal(result.paramIndex, 0);
    assert.match(result.path, /内层提取/);
  });

  test("缺少 id 的节点退化为「第N个节点」而不崩溃", () => {
    const broken = {
      id: "wf",
      name: "测试",
      version: 1,
      nodes: [
        { id: "start", kind: "start" },
        { kind: "extract", title: "无ID节点", params: [{ name: "a", label: "" }] },
        { id: "end", kind: "end" }
      ],
      edges: []
    };
    const error = new WorkflowSyntaxError("nodes[1].id", "应为非空字符串");
    const result = describeSyntaxError(broken, error);
    // 没 id 就定位不到具体节点：nodeId 为空（不可跳转），但整体不崩。
    assert.ok(!result.nodeId);
    assert.match(result.path, /节点/);
  });
});
