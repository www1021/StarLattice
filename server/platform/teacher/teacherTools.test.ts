import test from "node:test";
import assert from "node:assert/strict";
import { classifyRisk, queryStudentProfiles, type RiskInput } from "./teacherTools.js";

test("档案查询按分数线筛人并算平均分，带标记的原因写清楚", () => {
  const result = queryStudentProfiles({
    students: [
      { id: "s1", name: "甲", scores: [63, 68], tags: ["数学"] },
      { id: "s2", name: "乙", scores: [82, 86], tags: [] },
      { id: "s3", name: "丙", scores: [58, 61], tags: ["数学", "心理"] }
    ],
    scoreBelow: 70,
    order: "asc"
  });
  assert.equal(result.total, 3);
  assert.equal(result.matched, 2);
  assert.deepEqual(result.students.map((item) => item.id), ["s3", "s1"]);
  assert.equal(result.students[0].average, 59.5);
  assert.ok(result.students[0].reasons.some((reason) => reason.includes("平均分")));
});

test("档案查询只看标签时，分数缺失的人也能命中", () => {
  const result = queryStudentProfiles({
    students: [
      { id: "s1", name: "甲", tags: ["安全"] },
      { id: "s2", name: "乙", tags: [] }
    ],
    tags: ["安全"]
  });
  assert.equal(result.matched, 1);
  assert.equal(result.students[0].name, "甲");
  assert.equal(result.students[0].average, null);
});

test("风险分级：红线硬命中，禁止动作与上报模板齐全", () => {
  const result = classifyRisk({ text: "他说有人要打我，我不想活了" });
  assert.equal(result.level, "红线");
  assert.equal(result.code, "safety-red");
  assert.ok(result.hits.some((item) => item.keyword === "打我"));
  assert.ok(result.forbiddenActions.some((item) => item.includes("单独处理")));
  assert.ok(result.reportTemplate.some((item) => item.includes("逐字")));
  assert.ok(result.rationale.includes("不得改写等级"));
});

test("风险分级：既往红线记录让本次无关键词的事件升为橙线", () => {
  const input: RiskInput = {
    text: "今天情绪不太好",
    history: [{ date: "2026-11-05", level: "橙线", note: "家庭变故" }]
  };
  const result = classifyRisk(input);
  assert.equal(result.level, "橙线");
  assert.equal(result.repeat, true);
  assert.ok(result.hits.some((item) => item.keyword === "历史记录"));
});

test("风险分级：单次口角是黄线，未命中是无风险", () => {
  assert.equal(classifyRisk({ text: "课间和同学吵架了" }).level, "黄线");
  const none = classifyRisk({ text: "今天天气不错" });
  assert.equal(none.level, "无风险");
  assert.deepEqual(none.hits, []);
});

test("风险分级：红线优先于橙线和黄线，不会被弱关键词拉低", () => {
  const result = classifyRisk({ text: "吵架之后他说不想活了" });
  assert.equal(result.level, "红线");
  assert.ok(result.hits.some((item) => item.keyword === "吵架") === false);
});
