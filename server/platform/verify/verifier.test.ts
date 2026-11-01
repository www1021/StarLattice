import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRecord } from "../types.js";
import { LayeredVerifier } from "./verifier.js";

function agent(id: string, name: string, tools: string[] = []): AgentRecord {
  return {
    id,
    name,
    version: 1,
    role: "评分验证",
    prompt: "",
    tools,
    model: "classroom-llm",
    capabilities: [{ tag: "规则校验", weight: 0.9 }],
    memory: {},
    enabled: true,
    createdAt: "",
    updatedAt: ""
  };
}

const VERIFIERS = [
  agent("observer-verifier", "课堂交叉验证器", ["verify.rubric"]),
  agent("teaching-expert-agent", "教研专家 Agent", ["verify.rubric"])
];

const GOOD_ARTIFACT = {
  summary: "本课围绕分数的意义展开，设置了分层练习，并给出课标依据。",
  citations: [{ id: "c1", title: "数学课程标准", source: "课标解读" }]
};

test("runs rule, cross-check and baseline layers with evidence", () => {
  const verifier = new LayeredVerifier(() => 0.86);
  const report = verifier.evaluate({
    node: {
      id: "check",
      kind: "verify",
      verifier: "observer-verifier",
      rubric: ["目标达成", "证据支撑"],
      threshold: 0.8,
      required: ["summary"]
    },
    artifact: GOOD_ARTIFACT,
    attempt: 1,
    agents: VERIFIERS
  });

  assert.equal(report.score, 0.86);
  assert.equal(report.passed, true);
  assert.ok(report.confidence > 0.8);
  assert.equal(report.layers.rule.score, 1);
  assert.equal(report.layers.baseline.coverage, 1);
  assert.equal(report.layers.crossCheck.verifiers.length, 2);
  assert.equal(report.layers.crossCheck.agreement, true);
  assert.ok(report.evidence.some((item) => item.includes("数学课程标准")));
});

test("flags a wrong answer across all three layers", () => {
  const verifier = new LayeredVerifier(() => 0.9);
  const report = verifier.evaluate({
    node: {
      id: "check",
      kind: "verify",
      verifier: "observer-verifier",
      rubric: ["目标达成", "证据支撑"],
      threshold: 0.8,
      required: ["教学目标"],
      expectedKeywords: ["分数的意义", "分层练习"]
    },
    artifact: { summary: "TODO 待补充", citations: [] },
    attempt: 1,
    agents: VERIFIERS
  });

  assert.ok(report.score < 0.5, `score=${report.score}`);
  assert.equal(report.passed, false);
  assert.equal(report.layers.rule.score < 0.5, true);
  assert.equal(report.layers.baseline.coverage, 0);
  const issues = report.issues.join(" ");
  assert.match(issues, /必需内容「教学目标」未通过/);
  assert.match(issues, /占位标记/);
  assert.match(issues, /证据引用未通过/);
  assert.match(issues, /基准比对缺少要点：分数的意义、分层练习/);
});

test("does not treat legitimate 占位 wording as a placeholder", () => {
  const verifier = new LayeredVerifier(() => 0.9);
  const base = {
    node: {
      id: "check",
      kind: "verify" as const,
      verifier: "observer-verifier",
      rubric: ["目标达成", "证据支撑"],
      threshold: 0.8
    },
    attempt: 1,
    agents: VERIFIERS
  };
  const legitimate = verifier.evaluate({
    ...base,
    artifact: {
      summary: "书写“思”字时，心字底占位恰当，末两点对称。",
      citations: [{ id: "c1", title: "语文课程标准", source: "课标解读" }]
    }
  });
  const metaDiscussion = verifier.evaluate({
    ...base,
    artifact: {
      summary: "评审结论：开题报告模板中仍保留占位符，需要替换为具体研究内容后再提交。",
      citations: [{ id: "c1", title: "开题报告规范", source: "学院模板" }]
    }
  });
  const placeholder = verifier.evaluate({
    ...base,
    artifact: { summary: "【占位】TODO 待补充", citations: [] }
  });

  const checkOf = (report: typeof legitimate) =>
    report.layers.rule.checks.find((check) => check.key === "placeholder");
  assert.equal(checkOf(legitimate)?.passed, true);
  assert.equal(checkOf(metaDiscussion)?.passed, true);
  assert.equal(checkOf(placeholder)?.passed, false);
});

test("baseline comparison lowers the score when standard points are missing", () => {
  const verifier = new LayeredVerifier(() => 0.9);
  const base = {
    node: {
      id: "check",
      kind: "verify" as const,
      verifier: "observer-verifier",
      rubric: ["目标达成"],
      threshold: 0.8
    },
    artifact: GOOD_ARTIFACT,
    agents: VERIFIERS
  };

  const matched = verifier.evaluate({ ...base, node: { ...base.node, expectedKeywords: ["分数", "分层练习"] } });
  const missed = verifier.evaluate({ ...base, node: { ...base.node, expectedKeywords: ["负数", "函数"] } });

  assert.equal(matched.layers.baseline.coverage, 1);
  assert.equal(missed.layers.baseline.coverage, 0);
  assert.ok(missed.score < matched.score);
  assert.match(missed.issues.join(" "), /基准比对缺少要点：负数、函数/);
});

test("same artifact and verifiers produce the same report", () => {
  const verifier = new LayeredVerifier();
  const request = {
    node: {
      id: "check",
      kind: "verify" as const,
      verifier: "observer-verifier",
      rubric: ["目标达成", "互动覆盖", "证据支撑"],
      threshold: 0.8
    },
    artifact: GOOD_ARTIFACT,
    attempt: 1,
    agents: VERIFIERS
  };

  assert.deepEqual(verifier.evaluate(request), verifier.evaluate(request));
});

test("divergent verifier scores lower confidence than aligned ones", () => {
  const request = {
    node: {
      id: "check",
      kind: "verify" as const,
      verifier: "observer-verifier",
      rubric: ["目标达成", "证据支撑"],
      threshold: 0.8
    },
    artifact: GOOD_ARTIFACT,
    attempt: 1,
    agents: VERIFIERS
  };
  const aligned = new LayeredVerifier(() => 0.8).evaluate(request);
  const divergent = new LayeredVerifier((context) => (context.agentIndex === 0 ? 1 : 0.5)).evaluate(request);

  assert.ok(divergent.confidence < aligned.confidence, `${divergent.confidence} < ${aligned.confidence}`);
  assert.equal(divergent.layers.crossCheck.agreement, false);
  assert.match(divergent.issues.join(" "), /交叉验证分歧较大/);
});

test("single verifier degrades cross-check and caps confidence", () => {
  const report = new LayeredVerifier(() => 0.9).evaluate({
    node: {
      id: "check",
      kind: "verify",
      verifier: "observer-verifier",
      rubric: ["目标达成"],
      threshold: 0.8,
      verifiers: ["observer-verifier"]
    },
    artifact: GOOD_ARTIFACT,
    attempt: 1,
    agents: VERIFIERS
  });

  assert.equal(report.layers.crossCheck.verifiers.length, 1);
  assert.ok(report.confidence <= 0.5);
  assert.match(report.issues.join(" "), /仅 1 名验证器/);
});

test("counts knowledge citations passed as objects as evidence", () => {
  const report = new LayeredVerifier(() => 0.86).evaluate({
    node: {
      id: "check",
      kind: "verify",
      verifier: "observer-verifier",
      rubric: ["证据支撑"],
      threshold: 0.8,
      requireEvidence: true
    },
    artifact: { summary: "教学设计正文" },
    evidence: [
      {
        id: "citation-1",
        documentName: "义务教育数学课程标准（2022年版）",
        knowledgeBaseName: "课标库",
        snippet: "分数的意义在于把单位“1”平均分。",
        source: "local"
      }
    ],
    attempt: 1,
    agents: VERIFIERS
  });

  const evidenceCheck = report.layers.rule.checks.find((check) => check.key === "evidence");
  assert.equal(evidenceCheck?.passed, true);
  assert.ok(report.evidence.some((item) => item.includes("义务教育数学课程标准")));
  assert.doesNotMatch(report.issues.join(" "), /没有可追溯引用/);
});
