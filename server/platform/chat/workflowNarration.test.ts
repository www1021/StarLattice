import assert from "node:assert/strict";
import { test } from "node:test";
import { narrateNodeResult } from "./workflowNarration.js";

test("校验类节点：通过", () => {
  const raw = JSON.stringify({ output: { passed: true, issues: [] } });
  assert.equal(narrateNodeResult("review", "完整性校验", raw), "方案校验通过，可以继续。");
});

test("校验类节点：未通过带问题数", () => {
  const raw = JSON.stringify({ passed: false, issues: [{ detail: "a" }, { detail: "b" }] });
  assert.equal(
    narrateNodeResult("review", "完整性校验", raw),
    "方案校验发现 2 处问题，正在自动修订。"
  );
});

test("学情档位与易错点", () => {
  const raw = JSON.stringify({ tiers: [{}, {}, {}], misconceptions: [{}, {}] });
  assert.equal(narrateNodeResult("analyse", "学情分析", raw), "学情分成 3 档，锁定 2 个易错点。");
});

test("教学目标数量", () => {
  assert.equal(
    narrateNodeResult("goal", "目标拆解", JSON.stringify({ objectives: [{}, {}, {}] })),
    "拆出 3 条可观测教学目标。"
  );
});

test("课堂活动带课时", () => {
  assert.equal(
    narrateNodeResult("activity", "活动设计", JSON.stringify({ activities: [{}, {}], minutesSum: 40 })),
    "排出 2 个课堂环节，合计 40 分钟。"
  );
});

test("分层评价题量", () => {
  assert.equal(
    narrateNodeResult("assessment", "分层评价", JSON.stringify({ items: [{}, {}, {}] })),
    "出了 3 道分层评价题，附评分要点。"
  );
});

test("安全等级", () => {
  assert.equal(
    narrateNodeResult("facts", "事实抽取", JSON.stringify({ level: "红线" })),
    "风险等级判定为红线，处置动作已按规则生成。"
  );
});

test("兜底用标题，不倒 JSON", () => {
  const raw = JSON.stringify({ summary: "这是一段很长的说明".repeat(20) });
  const result = narrateNodeResult("notice", "家长通知", raw);
  assert.ok(result.startsWith("家长通知完成："));
  assert.ok(result.length < 90);
});

test("无产物返回空串", () => {
  assert.equal(narrateNodeResult("start", "开始", undefined), "");
  assert.equal(narrateNodeResult("end", "结束", "{bad json"), "");
});
