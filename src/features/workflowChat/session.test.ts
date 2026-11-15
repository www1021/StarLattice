import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkflowChatInput,
  readWorkflowOptions,
  readWorkflowVariables
} from "./session.js";

test("对话内容填满字符串字段，避免必填校验直接失败", () => {
  const input = buildWorkflowChatInput(
    [
      { name: "topic", type: "string", required: true },
      { name: "subject", type: "string", required: true },
      { name: "grade", type: "string", required: true },
      { name: "minutes", type: "number" },
      { name: "strict", type: "boolean" },
      { name: "knowledgeBaseIds", type: "object" }
    ],
    "围绕勾股定理生成一份教案"
  );
  assert.equal(input.topic, "围绕勾股定理生成一份教案");
  assert.equal(input.subject, "围绕勾股定理生成一份教案");
  assert.equal(input.grade, "围绕勾股定理生成一份教案");
  assert.equal(input.minutes, 0);
  assert.equal(input.strict, false);
  assert.deepEqual(input.knowledgeBaseIds, {});
});

test("工作流详情坏数据不会让会话崩溃", () => {
  assert.deepEqual(readWorkflowVariables(null), []);
  assert.deepEqual(readWorkflowVariables({ workflow: {} }), []);
  assert.deepEqual(readWorkflowVariables({ workflow: { definition: { inputs: "bad" } } }), []);
  assert.deepEqual(
    readWorkflowVariables({
      workflow: {
        definition: {
          inputs: [
            { name: "topic", type: "string", required: true },
            null,
            { type: "number" },
            { name: "grade", type: 42 }
          ]
        }
      }
    }),
    [
      { name: "topic", type: "string", required: true },
      { name: "grade", type: "string", required: false }
    ]
  );
});

test("工作流列表坏数据返回空数组", () => {
  assert.deepEqual(readWorkflowOptions(null), []);
  assert.deepEqual(readWorkflowOptions({ workflows: "bad" }), []);
  assert.deepEqual(
    readWorkflowOptions({
      workflows: [{ id: "a", name: "教学流水线" }, null, { name: "缺 id" }]
    }),
    [{ id: "a", name: "教学流水线" }]
  );
});
