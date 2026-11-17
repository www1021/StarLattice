import test from "node:test";
import assert from "node:assert/strict";
import { checkRubric, computeClassroomEvidence, type Utterance } from "./classroomEvidence.js";

const line = (speaker: string, text: string, startSec?: number, endSec?: number): Utterance => ({
  speaker,
  text,
  startSec,
  endSec
});

test("话语统计区出教师与学生占比、提问数和冷场段", () => {
  const result = computeClassroomEvidence([
    line("teacher", "什么是摩擦力？", 0, 6),
    line("student-A", "阻碍相对运动的力。", 9, 14),
    line("teacher", "很好，那方向呢？", 30, 36),
    line("student-B", "与相对运动方向相反。", 38, 45)
  ]);
  assert.equal(result.turnCount, 4);
  assert.equal(result.teacherTurns, 2);
  assert.equal(result.studentTurns, 2);
  assert.equal(result.questionCount, 2);
  assert.equal(result.studentQuestionCount, 0);
  assert.deepEqual(result.silenceGapsSec, [16]);
  assert.equal(result.longestTeacherTurnSec, 6);
  assert.equal(result.durationSec, 45);
  assert.equal(result.excerpts.length, 4);
});

test("无时间信息时时长类指标归零，不产生 NaN", () => {
  const result = computeClassroomEvidence([line("teacher", "同学们好"), line("student", "老师好")]);
  assert.equal(result.durationSec, 0);
  assert.equal(result.longestTeacherTurnSec, 0);
  assert.deepEqual(result.silenceGapsSec, []);
  assert.ok(Number.isFinite(result.teacherTokenRatio));
});

test("量表一致性：分歧维度被点名，共识分取各维均值", () => {
  const result = checkRubric({
    dimensions: [
      { dimension: "目标达成", scores: [82, 80, 84] },
      { dimension: "师生互动", scores: [90, 55, 88] }
    ],
    maxSpread: 25
  });
  assert.equal(result.verdict, "divergent");
  assert.equal(result.passed, false);
  assert.deepEqual(result.divergentDimensions, ["师生互动"]);
  assert.equal(result.dimensions[0].spread, 4);
  assert.equal(result.dimensions[1].spread, 35);
  assert.equal(result.consensusScore, 79.834);
});

test("红线命中时一票否决，分数再高也不通过", () => {
  const result = checkRubric({
    dimensions: [{ dimension: "内容讲解", scores: [98, 97, 99] }],
    redlines: [{ code: "科学性错误", hit: true, evidence: "把重力方向讲成竖直向下作用于斜面" }]
  });
  assert.equal(result.verdict, "redline");
  assert.equal(result.redlineHit, true);
  assert.equal(result.passed, false);
  assert.ok(result.note.includes("科学性错误"));
});

test("分数低于达标线判 below，与分歧互斥", () => {
  const result = checkRubric({
    dimensions: [{ dimension: "学习成效", scores: [61, 64, 62] }],
    passScore: 70
  });
  assert.equal(result.verdict, "below");
  assert.equal(result.consensusScore, 62.333);
  assert.deepEqual(result.divergentDimensions, []);
});

test("全部维度一致且达标才判 pass", () => {
  const result = checkRubric({
    dimensions: [
      { dimension: "目标达成", scores: [85, 82, 88] },
      { dimension: "课堂管理", scores: [79, 81, 80] }
    ],
    redlines: [{ code: "师德问题", hit: false }]
  });
  assert.equal(result.verdict, "pass");
  assert.equal(result.passed, true);
  assert.equal(result.redlineHit, false);
});
