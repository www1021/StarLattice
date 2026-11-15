import assert from "node:assert/strict";
import test from "node:test";
import { NODE_KINDS } from "../types.js";
import { compileWorkflow, WorkflowCompileError } from "./compiler.js";
import { diagnoseWorkflow } from "./diagnostics.js";
import { parseWorkflowDefinition, WorkflowSyntaxError } from "./dsl.js";
import {
  NODE_PORT_SPECS,
  NODE_TYPE_CONTRACT_VERSION,
  NODE_TYPE_SPECS
} from "./nodeTypes.js";

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: "port-probe",
    name: "端口契约探针",
    version: 1,
    inputs: [{ name: "topic", type: "string", required: true }],
    nodes: [
      { id: "start", kind: "start" },
      { id: "draft", kind: "llm", prompt: "围绕 ${input.topic} 写初稿" },
      { id: "review", kind: "llm", prompt: "评审 ${draft.output}" },
      { id: "end", kind: "end" }
    ],
    edges: [
      { from: "start", to: "draft" },
      { from: "draft", to: "review" },
      { from: "review", to: "end" }
    ],
    ...overrides
  };
}

test("节点契约 v3：每类节点都有端口预设与字段分组", () => {
  assert.equal(NODE_TYPE_CONTRACT_VERSION, 3);
  for (const kind of NODE_KINDS) {
    const spec = NODE_TYPE_SPECS.find((item) => item.kind === kind);
    assert.ok(spec, `${kind} 缺少节点类型定义`);
    assert.ok(spec.ports, `${kind} 缺少端口预设`);
    assert.ok(spec.ports.outputs.length > 0, `${kind} 至少要声明一个可被下游引用的输出字段`);
    assert.deepEqual(spec.ports, NODE_PORT_SPECS[kind]);
    for (const field of spec.fields) {
      assert.ok(field.group, `${kind}.${field.key} 缺少属性面板分组`);
    }
  }
  const llm = NODE_TYPE_SPECS.find((item) => item.kind === "llm");
  assert.ok(llm);
  const keys = llm.fields.map((field) => field.key);
  for (const key of ["prompt", "system", "model", "temperature", "topP", "maxTokens"]) {
    assert.ok(keys.includes(key), `llm 缺少 ${key}`);
  }
  assert.equal(llm.fields.find((field) => field.key === "model")?.type, "select");
  assert.ok(llm.fields.find((field) => field.key === "prompt")?.supportsRefs);
});

test("DSL 保留输入参数表、输出契约与模型采样参数", () => {
  const raw = draft({
    nodes: [
      { id: "start", kind: "start" },
      {
        id: "draft",
        kind: "llm",
        prompt: "围绕 ${input.topic} 写初稿",
        system: "你是教研助手",
        model: "qwen3.7-flash",
        temperature: 0.3,
        topP: 0.8,
        maxTokens: 1200,
        inputBindings: [
          {
            name: "topic",
            type: "string",
            required: true,
            source: "variable",
            value: "${input.topic}",
            description: "研究主题"
          },
          { name: "context", type: "object", source: "reference", value: "${start.output}" }
        ],
        outputSchema: [
          { name: "output", type: "string", description: "初稿正文" },
          { name: "sections", type: "array", properties: [{ name: "title", type: "string" }] }
        ]
      },
      { id: "end", kind: "end" }
    ],
    edges: [
      { from: "start", to: "draft" },
      { from: "draft", to: "end" }
    ]
  });
  const workflow = parseWorkflowDefinition(raw);
  const node = workflow.nodes.find((item) => item.kind === "llm");
  assert.ok(node);
  assert.equal(node.inputBindings?.length, 2);
  assert.equal(node.inputBindings?.[0].value, "${input.topic}");
  assert.equal(node.outputSchema?.[1].properties?.[0].name, "title");
  assert.equal(node.topP, 0.8);
});

test("DSL 拒绝非法端口类型与取值来源", () => {
  assert.throws(
    () =>
      parseWorkflowDefinition(
        draft({
          nodes: [
            {
              id: "draft",
              kind: "llm",
              prompt: "写点什么",
              inputBindings: [{ name: "x", type: "vector" }]
            }
          ],
          edges: []
        })
      ),
    WorkflowSyntaxError
  );
  assert.throws(
    () =>
      parseWorkflowDefinition(
        draft({
          nodes: [
            {
              id: "draft",
              kind: "llm",
              prompt: "写点什么",
              inputBindings: [{ name: "x", type: "string", source: "magic" }]
            }
          ],
          edges: []
        })
      ),
    WorkflowSyntaxError
  );
});

test("编译器校验输入参数表里的引用顺序与端口名", () => {
  const workflow = parseWorkflowDefinition(
    draft({
      nodes: [
        { id: "start", kind: "start" },
        { id: "draft", kind: "llm", prompt: "写初稿" },
        {
          id: "review",
          kind: "llm",
          prompt: "评审",
          inputBindings: [
            { name: "article", type: "string", source: "reference", value: "${draft.output}" }
          ],
          inputs: { article: "${draft.output}" },
          outputSchema: [{ name: "output", type: "string" }]
        },
        { id: "end", kind: "end" }
      ]
    })
  );
  assert.doesNotThrow(() => compileWorkflow(workflow));

  const duplicated = structuredClone(workflow);
  const review = duplicated.nodes.find((node) => node.id === "review");
  assert.ok(review);
  review.inputBindings = [
    { name: "article", type: "string" },
    { name: "article", type: "string" }
  ];
  assert.throws(
    () => compileWorkflow(duplicated),
    (error: unknown) =>
      error instanceof WorkflowCompileError &&
      error.issues.some((issue) => issue.code === "duplicate-port-name")
  );
});

test("编译器拒绝越界的 topP", () => {
  const workflow = parseWorkflowDefinition(
    draft({
      nodes: [
        { id: "start", kind: "start" },
        { id: "draft", kind: "llm", prompt: "写初稿", topP: 1.4 },
        { id: "end", kind: "end" }
      ],
      edges: [
        { from: "start", to: "draft" },
        { from: "draft", to: "end" }
      ]
    })
  );
  assert.throws(
    () => compileWorkflow(workflow),
    (error: unknown) =>
      error instanceof WorkflowCompileError &&
      error.issues.some((issue) => issue.code === "invalid-llm-top-p")
  );
});

test("诊断能指出不存在的上游节点与未取值的必填参数", () => {
  const issues = diagnoseWorkflow(
    draft({
      nodes: [
        { id: "start", kind: "start" },
        { id: "draft", kind: "llm", prompt: "参考 ${ghost.output} 写初稿" },
        {
          id: "review",
          kind: "llm",
          prompt: "评审",
          inputBindings: [
            { name: "article", type: "string", required: true, source: "reference", value: "" }
          ]
        },
        { id: "end", kind: "end" }
      ],
      edges: [
        { from: "start", to: "draft" },
        { from: "draft", to: "review" },
        { from: "review", to: "end" }
      ]
    })
  );
  assert.ok(issues.some((issue) => issue.code === "unknown-node-ref" && issue.path === "draft"));
  assert.ok(
    issues.some(
      (issue) => issue.code === "empty-required-port" && issue.path === "review" && issue.severity === "error"
    )
  );
});
