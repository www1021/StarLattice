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
  agentWithModel("observer-verifier", "课堂交叉验证器", "reasoning"),
  agentWithModel("teaching-expert-agent", "教研专家 Agent", "fast")
];

const GOOD_ARTIFACT = {
  summary: "本课围绕分数的意义展开，设置了分层练习，并给出课标依据。",
  citations: [{ id: "c1", title: "数学课程标准", source: "课标解读" }]
};

test("runs rule, cross-check and baseline layers with evidence", () => {
  const restore = withEnv({
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_MODEL_REASONING: "reasoning-model"
  });
  try {
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
    assert.equal(report.independence.level, "model");
    assert.ok(report.confidence > 0.8);
    assert.equal(report.layers.rule.score, 1);
    assert.equal(report.layers.baseline.coverage, 1);
    assert.equal(report.layers.crossCheck.verifiers.length, 2);
    assert.equal(report.layers.crossCheck.agreement, true);
    assert.ok(report.evidence.some((item) => item.includes("数学课程标准")));
  } finally {
    restore();
  }
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

test("placeholder content is a hard failure in live mode", () => {
  const verifier = new LayeredVerifier(() => 0.98);
  const node = {
    id: "placeholder-hard",
    kind: "verify" as const,
    verifier: "observer-verifier",
    rubric: ["目标达成"],
    threshold: 0.8,
    minChars: 100
  };
  const body =
    "## 教学目标\n" +
    "本课围绕分数的意义展开，学生能结合分蛋糕情境解释分母与分子的含义。".repeat(20);
  const clean = verifier.evaluate({
    node,
    artifact: { output: body },
    attempt: 1,
    agents: VERIFIERS
  });
  const dirty = verifier.evaluate({
    node,
    artifact: { output: `${body}\n（此处填写具体学情）` },
    attempt: 1,
    agents: VERIFIERS
  });

  assert.equal(clean.passed, true);
  assert.equal(dirty.passed, false);
  assert.ok(dirty.score < node.threshold, `score=${dirty.score}`);
  assert.match(dirty.issues.join(" "), /确定性检查未通过：无占位内容/);
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
    artifact: {
      summary: "教学设计正文",
      citations: [
        {
          id: "citation-1",
          title: "义务教育数学课程标准（2022年版）",
          source: "课标库"
        }
      ]
    },
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

const NUMBER_NODE = {
  id: "check",
  kind: "verify" as const,
  verifier: "observer-verifier",
  rubric: ["数据一致性"],
  threshold: 0.8,
  checks: [{ type: "number_match" as const, tolerance: 0.01 }]
};

test("number_match passes when every artifact number matches the reference within tolerance", () => {
  const report = new LayeredVerifier(() => 0.9).evaluate({
    node: NUMBER_NODE,
    artifact: { summary: "华东区营收 1,234.56 万元，同比增长 12.5%，毛利率 32.1%。" },
    reference: "华东区营收 1234.56 万元，同比增长 12.5%，毛利率 32.0%。",
    attempt: 1,
    agents: VERIFIERS
  });

  const check = report.layers.rule.checks.find((item) => item.key === "number_match:0");
  assert.equal(check?.passed, true);
  assert.match(check?.detail ?? "", /全部匹配对照数据/);
  assert.equal(report.layers.rule.score, 1);
});

test("number_match fails and reports the first mismatched number", () => {
  const report = new LayeredVerifier(() => 0.9).evaluate({
    node: NUMBER_NODE,
    artifact: { summary: "本期毛利率 32.1%。" },
    reference: "本期毛利率 30.0%。",
    attempt: 1,
    agents: VERIFIERS
  });

  const check = report.layers.rule.checks.find((item) => item.key === "number_match:0");
  assert.equal(check?.passed, false);
  assert.match(check?.detail ?? "", /32\.1/);
  assert.ok(report.layers.rule.score < 1);
});

test("number_match failure caps the total score below the threshold", () => {
  const report = new LayeredVerifier(() => 0.95).evaluate({
    node: NUMBER_NODE,
    artifact: { summary: "本期营收 1,234.56 万元，毛利率 32.1%，区域与品类均已复核。" },
    reference: "本期营收 1234.56 万元，毛利率 30.0%。",
    attempt: 1,
    agents: VERIFIERS
  });

  assert.equal(report.layers.rule.checks.find((item) => item.key === "number_match:0")?.passed, false);
  assert.ok(report.score < report.threshold, `score=${report.score} threshold=${report.threshold}`);
  assert.equal(report.passed, false);
});

test("stub mode keeps scores content-based and caps confidence", () => {
  const verifier = new LayeredVerifier();
  const base = {
    node: {
      id: "check",
      kind: "verify" as const,
      verifier: "observer-verifier",
      rubric: ["目标达成", "互动覆盖", "证据支撑"],
      threshold: 0.8
    },
    artifact: GOOD_ARTIFACT,
    agents: VERIFIERS,
    mode: "stub" as const
  };

  const first = verifier.evaluate({ ...base, attempt: 1 });
  const fourth = verifier.evaluate({ ...base, attempt: 4 });

  assert.deepEqual(first, fourth);
  assert.ok(first.confidence <= 0.5);
  assert.match(first.issues.join(" "), /stub 演练/);
});

test("number_match fails when no reference data is supplied", () => {
  const report = new LayeredVerifier(() => 0.9).evaluate({
    node: NUMBER_NODE,
    artifact: { summary: "本期毛利率 32.1%。" },
    attempt: 1,
    agents: VERIFIERS
  });

  const check = report.layers.rule.checks.find((item) => item.key === "number_match:0");
  assert.equal(check?.passed, false);
  assert.match(check?.detail ?? "", /对照数据为空/);
});

const ANCHORED_NODE = {
  ...NUMBER_NODE,
  checks: [
    {
      type: "number_match" as const,
      tolerance: 0.01,
      anchors: ["销售额基准", "毛利额", "毛利率"]
    }
  ]
};

const ANCHORED_REFERENCE = [
  "毛利核算（销售额口径：net）",
  "销售额基准：113,400.00 元",
  "销货成本：71,110.00 元",
  "毛利额：42,290.00 元",
  "毛利率：37.29%"
].join("\n");

test("anchored number_match catches a wrong revenue basis on the metric line", () => {
  const report = new LayeredVerifier(() => 0.95).evaluate({
    node: ANCHORED_NODE,
    artifact: {
      output: [
        "毛利核算（销售额口径：gross）",
        "销售额基准：117,100.00 元",
        "销货成本：71,110.00 元",
        "毛利额：45,990.00 元",
        "毛利率：39.27%"
      ].join("\n")
    },
    reference: ANCHORED_REFERENCE,
    attempt: 1,
    agents: VERIFIERS
  });

  const check = report.layers.rule.checks.find((item) => item.key === "number_match:0");
  assert.equal(check?.passed, false);
  assert.match(check?.detail ?? "", /117,100/);
  assert.match(check?.detail ?? "", /对照值 113,400/);
  assert.equal(report.passed, false);
});

test("anchored number_match ignores ordinals and derived numbers outside the metric value", () => {
  const report = new LayeredVerifier(() => 0.9).evaluate({
    node: ANCHORED_NODE,
    artifact: {
      output: [
        "1. 销售额基准：113,400.00 元，较初稿下调 3,700.00 元。",
        "2. 毛利额：42,290.00 元（初稿为 45,990.00 元）。",
        "3. 毛利率：37.29%，区域占比 42.78%。",
        "4. 智能音箱品类毛利率偏低（35.21%），华东区毛利率为 37.79%。",
        "5. 华东与华南贡献主要净销售额。"
      ].join("\n")
    },
    reference: ANCHORED_REFERENCE,
    attempt: 1,
    agents: VERIFIERS
  });

  const check = report.layers.rule.checks.find((item) => item.key === "number_match:0");
  assert.equal(check?.passed, true, check?.detail);
  assert.match(check?.detail ?? "", /关键指标 3 项/);
});

test("anchored number_match fails when an anchored metric is missing", () => {
  const report = new LayeredVerifier(() => 0.9).evaluate({
    node: ANCHORED_NODE,
    artifact: { output: "销售额基准：113,400.00 元，销货成本：71,110.00 元。" },
    reference: ANCHORED_REFERENCE,
    attempt: 1,
    agents: VERIFIERS
  });

  const check = report.layers.rule.checks.find((item) => item.key === "number_match:0");
  assert.equal(check?.passed, false);
  assert.match(check?.detail ?? "", /缺少「毛利额」/);
});

test("number_match normalizes percent signs, thousands separators and negatives", () => {
  const report = new LayeredVerifier(() => 0.9).evaluate({
    node: NUMBER_NODE,
    artifact: { summary: "净亏损 -3,200 万元，环比 -12.5%，统计日期 2026-01-15。" },
    reference: "净亏损 -3200 万元，环比 -0.125",
    attempt: 1,
    agents: VERIFIERS
  });

  const check = report.layers.rule.checks.find((item) => item.key === "number_match:0");
  assert.equal(check?.passed, true, check?.detail);
});

test("verification nodes can pin an independent verifier model", () => {
  const restore = withEnv({
    QWEN_API_KEY: "test-key",
    PLATFORM_LIVE_MODEL: "default-model",
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_MODEL_REASONING: "strong-model"
  });
  try {
    const report = new LayeredVerifier(() => 0.86).evaluate({
      node: {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        model: "reasoning",
        rubric: ["目标达成", "证据支撑"],
        threshold: 0.8,
        required: ["summary"]
      },
      artifact: GOOD_ARTIFACT,
      attempt: 1,
      agents: [
        agentWithModel("observer-verifier", "课堂交叉验证器", "verifier"),
        agentWithModel("teaching-expert-agent", "教研专家 Agent", "verifier")
      ]
    });

    for (const score of report.layers.crossCheck.verifiers) {
      assert.equal(score.model, "reasoning");
      assert.equal(score.resolvedModel, "strong-model");
      assert.equal(score.modelSource, "node");
    }
  } finally {
    restore();
  }
});

test("verifiers default to their own model so execution and review stay independent", () => {
  const restore = withEnv({
    QWEN_API_KEY: "test-key",
    PLATFORM_LIVE_MODEL: "default-model",
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_VERIFY_MODEL: "verify-model"
  });
  try {
    const report = new LayeredVerifier(() => 0.86).evaluate({
      node: {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        rubric: ["目标达成", "证据支撑"],
        threshold: 0.8
      },
      artifact: GOOD_ARTIFACT,
      attempt: 1,
      agents: [
        agentWithModel("observer-verifier", "课堂交叉验证器", "verifier"),
        agentWithModel("teaching-expert-agent", "教研专家 Agent", "verifier")
      ]
    });

    for (const score of report.layers.crossCheck.verifiers) {
      assert.equal(score.model, "verifier");
      assert.equal(score.resolvedModel, "verify-model");
      assert.equal(score.modelSource, "agent");
    }
    assert.notEqual(
      report.layers.crossCheck.verifiers[0].resolvedModel,
      "fast-model",
      "验证器不能复用执行侧快速模型"
    );
  } finally {
    restore();
  }
});

test("verifier falls back to PLATFORM_VERIFY_MODEL when the agent keeps the default", () => {
  const restore = withEnv({
    QWEN_API_KEY: "test-key",
    PLATFORM_LIVE_MODEL: "default-model",
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_VERIFY_MODEL: "fast"
  });
  try {
    const report = new LayeredVerifier(() => 0.86).evaluate({
      node: {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        rubric: ["目标达成"],
        threshold: 0.8
      },
      artifact: GOOD_ARTIFACT,
      attempt: 1,
      agents: [
        agentWithModel("observer-verifier", "课堂交叉验证器", "platform-default"),
        agentWithModel("teaching-expert-agent", "教研专家 Agent", "platform-default")
      ]
    });

    assert.equal(report.layers.crossCheck.verifiers[0].model, "fast");
    assert.equal(report.layers.crossCheck.verifiers[0].resolvedModel, "fast-model");
    assert.equal(report.layers.crossCheck.verifiers[0].modelSource, "verifier");
  } finally {
    restore();
  }
});

test("verifier downgrades to a low-cost model when the run budget is exhausted", () => {
  const restore = withEnv({
    QWEN_API_KEY: "test-key",
    PLATFORM_LIVE_MODEL: "default-model",
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_MODEL_REASONING: "strong-model"
  });
  try {
    const report = new LayeredVerifier(() => 0.86).evaluate({
      node: {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        model: "reasoning",
        rubric: ["目标达成"],
        threshold: 0.8
      },
      artifact: GOOD_ARTIFACT,
      attempt: 1,
      budgetExceeded: true,
      agents: [agentWithModel("observer-verifier", "课堂交叉验证器", "verifier")]
    });

    const score = report.layers.crossCheck.verifiers[0];
    assert.equal(score.model, "fast");
    assert.equal(score.resolvedModel, "fast-model");
    assert.equal(score.modelSource, "budget-downgrade");
  } finally {
    restore();
  }
});

test("same upstream model caps confidence at prompt-level independence", () => {
  const restore = withEnv({
    PLATFORM_MODEL_FAST: "shared-model",
    PLATFORM_MODEL_REASONING: "shared-model"
  });
  try {
    const report = new LayeredVerifier(() => 0.86).evaluate({
      node: {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        rubric: ["目标达成", "证据支撑"],
        threshold: 0.8
      },
      artifact: GOOD_ARTIFACT,
      evidence: ["数学课程标准"],
      attempt: 1,
      agents: VERIFIERS
    });

    assert.equal(report.independence.level, "prompt");
    assert.ok(report.confidence <= 0.6);
    assert.match(report.issues.join(" "), /提示词级/);
  } finally {
    restore();
  }
});

test("different evidence views reach evidence-level independence", () => {
  const restore = withEnv({
    PLATFORM_MODEL_FAST: "shared-model",
    PLATFORM_MODEL_REASONING: "shared-model"
  });
  try {
    const report = new LayeredVerifier(() => 0.86).evaluate({
      node: {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        rubric: ["目标达成", "证据支撑"],
        threshold: 0.8,
        evidenceView: "split"
      },
      artifact: { summary: "总体结论：方案可行[1]。" },
      evidence: ["数学课程标准 · 课标解读", "课堂观察记录 · 校本数据"],
      attempt: 1,
      agents: [
        agentWithModel("observer-verifier", "课堂交叉验证器", "reasoning"),
        agentWithModel("teaching-expert-agent", "教研专家 Agent", "reasoning")
      ]
    });

    assert.equal(report.independence.level, "evidence");
    assert.equal(report.independence.evidenceDistinct, true);
    assert.deepEqual(
      report.layers.crossCheck.verifiers.map((item) => item.evidenceView),
      ["pool", "cited"]
    );
    assert.ok(report.confidence <= 0.7);
  } finally {
    restore();
  }
});

test("missing citations are a hard failure that caps the total score", () => {
  const report = new LayeredVerifier(() => 0.92).evaluate({
    node: {
      id: "check",
      kind: "verify",
      verifier: "observer-verifier",
      rubric: ["证据支撑"],
      threshold: 0.8,
      requireEvidence: true,
      minCitations: 2,
      requiredSections: ["总体结论"],
      minChars: 120
    },
    artifact: { output: `总体结论\n${"本课题围绕分数意义展开分层练习。".repeat(12)}` },
    evidence: ["数学课程标准 · 课标解读", "课堂观察记录 · 校本数据"],
    attempt: 1,
    agents: VERIFIERS
  });

  assert.equal(report.citations.total, 0);
  assert.ok(report.score < report.threshold, `score=${report.score}`);
  assert.equal(report.passed, false);
  assert.match(report.issues.join(" "), /证据引用未通过/);
  assert.match(report.issues.join(" "), /确定性检查未通过/);
  assert.ok(report.confidence <= 0.6);
});

test("fabricated citation markers cannot bind to the evidence pool", () => {
  const report = new LayeredVerifier(() => 0.92).evaluate({
    node: {
      id: "check",
      kind: "verify",
      verifier: "observer-verifier",
      rubric: ["证据支撑"],
      threshold: 0.8,
      requireEvidence: true,
      minCitations: 1,
      minChars: 120
    },
    artifact: { output: `总体结论：${"方案论证充分，数据来源可靠。".repeat(12)}参见[99]。` },
    evidence: ["数学课程标准 · 课标解读", "课堂观察记录 · 校本数据"],
    attempt: 1,
    agents: VERIFIERS
  });

  const binding = report.layers.rule.checks.find((check) => check.key === "citation_binding");
  assert.equal(binding?.passed, false);
  assert.match(binding?.detail ?? "", /无法绑定/);
  assert.ok(report.score < report.threshold);
});

test("section and length defects are hard failures in live mode", () => {
  const report = new LayeredVerifier(() => 0.92).evaluate({
    node: {
      id: "check",
      kind: "verify",
      verifier: "observer-verifier",
      rubric: ["目标达成"],
      threshold: 0.8,
      requiredSections: ["总体结论"],
      minChars: 300
    },
    artifact: { output: "总体结论\n内容过短。" },
    evidence: ["课堂观察记录"],
    attempt: 1,
    agents: VERIFIERS
  });

  assert.ok(report.score < report.threshold, `score=${report.score}`);
  assert.match(report.issues.join(" "), /最小篇幅 300 字/);
  assert.match(report.issues.join(" "), /确定性检查未通过/);
});

test("heuristic fallback is reported and removes model-level independence", async () => {
  const restore = withEnv({
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_MODEL_REASONING: "reasoning-model"
  });
  try {
    const verifier = new LayeredVerifier(async (context) => {
      context.diagnostics?.push({ key: "llm-fallback", detail: "upstream error" });
      return 0.9;
    });
    const report = await verifier.evaluateAsync({
      node: {
        id: "check",
        kind: "verify",
        verifier: "observer-verifier",
        rubric: ["目标达成"],
        threshold: 0.8
      },
      artifact: GOOD_ARTIFACT,
      attempt: 1,
      agents: VERIFIERS
    });

    assert.equal(report.independence.heuristicFallback, true);
    assert.equal(report.independence.level, "prompt");
    assert.ok(report.confidence <= 0.6);
    assert.match(report.issues.join(" "), /回退启发式打分/);
  } finally {
    restore();
  }
});

function agentWithModel(id: string, name: string, model: string): AgentRecord {
  return { ...agent(id, name, ["verify.rubric"]), model };
}

function withEnv(values: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}
