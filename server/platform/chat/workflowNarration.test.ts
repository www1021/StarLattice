import assert from "node:assert/strict";
import { test } from "node:test";
import { narrateNodeResult, narrateStepFailure, narrateStepRunning } from "./workflowNarration.js";

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

test("兜底只说产物那句话，不倒 JSON 也不加标题", () => {
  const raw = JSON.stringify({ summary: "这是一段很长的说明".repeat(20) });
  const result = narrateNodeResult("notice", "家长通知", raw);
  assert.ok(result.startsWith("这是一段很长的说明"));
  assert.ok(!result.includes("家长通知完成"));
  assert.ok(result.length < 70);
});

test("技术串摘要不念给用户听", () => {
  const raw = JSON.stringify({
    summary: "教学资源 MCP（本地示例）· teaching_resource_search（76.1 ms）"
  });
  assert.equal(narrateNodeResult("resources", "教学资源检索", raw), "");
});

test("知识库检索：命中与未命中都说人话", () => {
  const hit = JSON.stringify({
    query: "语文 圆明园的毁灭 课程标准",
    citations: [{ id: "a" }, { id: "b" }]
  });
  assert.equal(
    narrateNodeResult("retrieve", "课标检索", hit),
    "在「语文 圆明园的毁灭 课程标准」里翻到 2 条可用依据。"
  );

  const miss = JSON.stringify({ query: "语文 圆明园的毁灭 课程标准", citations: [] });
  assert.match(narrateNodeResult("retrieve", "课标检索", miss), /没有现成依据/);
});

test("同名字段按节点语义说：细目表是条目，不是题目", () => {
  assert.equal(
    narrateNodeResult("blueprint", "细目表子流程", JSON.stringify({ items: [{}, {}, {}] })),
    "把细目表拆成 3 条。"
  );
});

test("开始/结束/条件节点不播报", () => {
  assert.equal(narrateNodeResult("start", "开始", JSON.stringify({ summary: "开始" }), "start"), "");
  assert.equal(narrateNodeResult("end", "结束", JSON.stringify({ summary: "结束" }), "end"), "");
});

test("节点开跑说正在做什么，结构节点不念", () => {
  assert.equal(narrateStepRunning("tool", "课标检索"), "正在课标检索…");
  assert.equal(narrateStepRunning("agent", "基础题命制"), "正在基础题命制…");
  assert.equal(narrateStepRunning("subworkflow", "细目表子流程"), "正在细目表…");
  assert.equal(narrateStepRunning("start", "开始"), "");
  assert.equal(narrateStepRunning("condition", "达标分流"), "");
});

test("节点失败不甩堆栈", () => {
  assert.equal(narrateStepFailure("tool", "课标检索"), "课标检索这步没跑通，我先用已有的部分往下走。");
  assert.match(
    narrateStepFailure("llm", "合卷与编号", "模型返回为空\n请重试"),
    /^合卷与编号这步卡住了：模型返回为空 请重试/
  );
});

test("无产物返回空串", () => {
  assert.equal(narrateNodeResult("start", "开始", undefined), "");
  assert.equal(narrateNodeResult("end", "结束", "{bad json"), "");
});
