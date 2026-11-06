import assert from "node:assert/strict";
import test from "node:test";
import { parseKnowledgeBaseName } from "./knowledgeBases.js";

test("accepts purpose-driven knowledge base names", () => {
  assert.equal(
    parseKnowledgeBaseName(" 教育-初中数学-分数教案语料 "),
    "教育-初中数学-分数教案语料"
  );
  assert.equal(
    parseKnowledgeBaseName("经营-销售数据-毛利口径包"),
    "经营-销售数据-毛利口径包"
  );
});

test("rejects IDs, timestamps and test-only names", () => {
  for (const name of [
    "T09-kb-1783743681162",
    "7月24回归资料-1783695587626",
    "2026-07-27 第三轮测试资料库",
    "kb_9f8f51f9-1d01",
    "test-data-01"
  ]) {
    assert.throws(() => parseKnowledgeBaseName(name), /知识库名称要能看懂用途|至少包含/);
  }
});

test("rejects names that are too short or only digits", () => {
  assert.throws(() => parseKnowledgeBaseName("资料"), /4–40/);
  assert.throws(() => parseKnowledgeBaseName("1234"), /至少包含/);
});
