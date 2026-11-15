import assert from "node:assert/strict";
import test from "node:test";
import { CHOICE_FIELD_KEY, normalizeChoices, withChoiceField } from "./humanChoices.js";

test("字符串选项去空白、去重、丢掉空项", () => {
  assert.deepEqual(normalizeChoices([" 甲 ", "乙", "", "甲", "   "]), ["甲", "乙"]);
});

test("对象选项取展示名，label 优先于 value", () => {
  assert.deepEqual(
    normalizeChoices([
      { label: "根据论文题目答辩", value: "topic" },
      { value: "material", text: "上传材料" },
      { name: "自定义" }
    ]),
    ["根据论文题目答辩", "上传材料", "自定义"]
  );
});

test("非数组一律当没有选项", () => {
  assert.deepEqual(normalizeChoices(undefined), []);
  assert.deepEqual(normalizeChoices("甲"), []);
  assert.deepEqual(normalizeChoices({ 0: "甲" }), []);
});

test("选项折成 choice 字段并排在最前", () => {
  const fields = withChoiceField(
    [{ key: "note", label: "补充说明", type: "textarea" }],
    ["甲", "乙"]
  );
  assert.equal(fields[0].key, CHOICE_FIELD_KEY);
  assert.equal(fields[0].type, "select");
  assert.equal(fields[0].required, true);
  assert.deepEqual(fields[0].options, ["甲", "乙"]);
  assert.equal(fields[1].key, "note");
});

test("已有同名 choice 字段时不重复插入，且以最新选项为准", () => {
  const fields = withChoiceField(
    [
      { key: CHOICE_FIELD_KEY, label: "旧选择", type: "select", options: ["旧"] },
      { key: "note", label: "补充说明", type: "text" }
    ],
    ["甲"]
  );
  assert.equal(fields.filter((field) => field.key === CHOICE_FIELD_KEY).length, 1);
  assert.deepEqual(fields[0].options, ["甲"]);
  assert.equal(fields[1].key, "note");
});

test("没有选项时不动原字段", () => {
  const fields = [{ key: "note", label: "补充说明", type: "text" as const }];
  assert.equal(withChoiceField(fields, []), fields);
});
