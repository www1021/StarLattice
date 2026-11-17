import test from "node:test";
import assert from "node:assert/strict";
import { computePsychometrics, normalizeItems } from "./psychometrics.js";

const item = (id: string, fullScore: number, high: number, low: number, extra = {}) => ({
  id,
  fullScore,
  highGroupAvg: high,
  lowGroupAvg: low,
  ...extra
});

test("难度与区分度按教育测量口径计算", () => {
  const result = computePsychometrics([item("1", 10, 8, 4)]);
  const first = result.items[0];
  assert.equal(first.difficulty, 0.6);
  assert.equal(first.discrimination, 0.4);
  assert.equal(first.difficultyBand, "适中");
  assert.equal(first.verdict, "保留");
  assert.deepEqual(first.reasons, []);
  assert.equal(result.paper.passed, true);
  assert.equal(result.paper.totalScore, 10);
  assert.equal(result.paper.difficulty, 0.6);
});

test("缺省 overallAvg 时取高低分组均值", () => {
  const result = computePsychometrics([item("1", 10, 7, 3)]);
  assert.equal(result.items[0].difficulty, 0.5);
  assert.equal(result.paper.avgScore, 5);
});

test("过难题与过易题都被判返工并给出原因", () => {
  const result = computePsychometrics([item("1", 10, 3, 1), item("2", 5, 5, 4)]);
  const hard = result.items.find((entry) => entry.id === "1")!;
  const easy = result.items.find((entry) => entry.id === "2")!;
  assert.equal(hard.difficulty, 0.2);
  assert.equal(hard.difficultyBand, "过难");
  assert.equal(hard.verdict, "返工");
  assert.ok(hard.reasons.some((reason) => reason.includes("偏难")));
  assert.equal(easy.difficulty, 0.9);
  assert.equal(easy.difficultyBand, "过易");
  assert.equal(easy.verdict, "返工");
  assert.ok(easy.reasons.some((reason) => reason.includes("偏易")));
  assert.deepEqual(result.rework.sort(), ["1", "2"]);
  assert.equal(result.paper.passed, false);
});

test("区分度不足即使难度合适也要返工", () => {
  const result = computePsychometrics([item("1", 10, 6, 5)]);
  const first = result.items[0];
  assert.equal(first.difficulty, 0.55);
  assert.equal(first.discrimination, 0.1);
  assert.equal(first.verdict, "返工");
  assert.ok(first.reasons.some((reason) => reason.includes("区分度")));
});

test("整卷区分度按分值加权", () => {
  const result = computePsychometrics([item("1", 10, 8, 4), item("2", 10, 3, 1)]);
  assert.equal(result.paper.difficulty, 0.4);
  assert.equal(result.paper.discrimination, 0.3);
});

test("自定义难度区间与区分度下限生效", () => {
  const result = computePsychometrics([item("1", 10, 8, 4)], {
    difficultyRange: [0.4, 0.5],
    discriminationMin: 0.5
  });
  assert.deepEqual(result.paper.difficultyRange, [0.4, 0.5]);
  assert.equal(result.paper.discriminationMin, 0.5);
  assert.equal(result.items[0].verdict, "返工");
});

test("认知层级统计与难度分布统计", () => {
  const result = computePsychometrics([
    item("1", 10, 8, 4, { level: "理解" }),
    item("2", 10, 7, 5, { level: "应用" }),
    item("3", 10, 8, 6, { level: "理解" })
  ]);
  assert.equal(result.levelCoverage["理解"], 2);
  assert.equal(result.levelCoverage["应用"], 1);
  assert.equal(result.distribution["适中"], 3);
});

test("非法条目被过滤，空数组抛错", () => {
  const cleaned = normalizeItems([
    { id: "1", fullScore: 10, highGroupAvg: 8, lowGroupAvg: 4 },
    { id: "", fullScore: 10, highGroupAvg: 8, lowGroupAvg: 4 },
    { id: "3", fullScore: 0, highGroupAvg: 8, lowGroupAvg: 4 },
    { id: "4", fullScore: 10 }
  ]);
  assert.equal(cleaned.length, 1);
  assert.throws(() => computePsychometrics([]), /没有可用的题目数据/);
});
