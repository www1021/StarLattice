import assert from "node:assert/strict";
import test from "node:test";
import { buildRefAlias, displayFromRaw, rawFromDisplay } from "./refAlias.js";

const FULL_ID = "fd3ab424c74e5162d1e8d95579a2b187";

const alias = buildRefAlias([
  { key: FULL_ID, label: "大模型2" },
  { key: "508de73bac974770981bc6e25a6163ea", label: "循环1" }
]);

test("正文里显示节点名，不显示哈希", () => {
  const stored = `“\${${FULL_ID}.output}”`;
  assert.equal(displayFromRaw(stored, alias), "“${大模型2.output}”");
});

test("显示文本落库时换回节点 id", () => {
  assert.equal(rawFromDisplay("“${大模型2.output}”", alias), `“\${${FULL_ID}.output}”`);
});

test("来回换一轮不改变内容", () => {
  const stored = `${FULL_ID} 输出：\${${FULL_ID}.output}；循环：\${508de73bac974770981bc6e25a6163ea.output}`;
  assert.equal(rawFromDisplay(displayFromRaw(stored, alias), alias), stored);
});

test("工作流输入 ${input.x} 不受同名节点影响", () => {
  const withInputNode = buildRefAlias([
    { key: "n1", label: "input" },
    { key: FULL_ID, label: "大模型2" }
  ]);
  assert.equal(displayFromRaw("${input.question}", withInputNode), "${input.question}");
  assert.equal(rawFromDisplay("${input.question}", withInputNode), "${input.question}");
  // 标题叫 input 的节点不参与改名，否则两边都会串味
  assert.equal(displayFromRaw("${n1.output}", withInputNode), "${n1.output}");
  assert.equal(rawFromDisplay("${n1.output}", withInputNode), "${n1.output}");
});

test("本节点输入变量 ${template} 原样保留", () => {
  assert.equal(displayFromRaw("${template}", alias), "${template}");
  assert.equal(rawFromDisplay("${template}", alias), "${template}");
});

test("同名节点补 #2，反查不会串到另一个节点", () => {
  const dup = buildRefAlias([
    { key: "a", label: "回复1" },
    { key: "b", label: "回复1" }
  ]);
  assert.equal(displayFromRaw("${a.output}${b.output}", dup), "${回复1.output}${回复1#2.output}");
  assert.equal(rawFromDisplay("${回复1.output}", dup), "${a.output}");
  assert.equal(rawFromDisplay("${回复1#2.output}", dup), "${b.output}");
});

test("标题里带点也能正确反查", () => {
  const dotted = buildRefAlias([{ key: "x1", label: "v1.2 提取" }]);
  assert.equal(displayFromRaw("${x1.output}", dotted), "${v1.2 提取.output}");
  assert.equal(rawFromDisplay("${v1.2 提取.output}", dotted), "${x1.output}");
});

test("认不出的引用原样留着，交给编译器报错", () => {
  assert.equal(displayFromRaw("${deadbeef.output}", alias), "${deadbeef.output}");
  assert.equal(rawFromDisplay("${别人家.output}", alias), "${别人家.output}");
});

test("一个字都不改也能原样返回", () => {
  assert.equal(displayFromRaw("纯文本，没有变量。", alias), "纯文本，没有变量。");
  assert.equal(rawFromDisplay("纯文本，没有变量。", alias), "纯文本，没有变量。");
});
