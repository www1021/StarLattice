import assert from "node:assert/strict";
import test from "node:test";
import { extractArtifact, rulesJudge } from "./judge.mjs";

const educationTask = {
  id: "edu-test",
  scenario: "education",
  difficulty: "easy",
  threshold: 0.85,
  expectedPoints: [
    "结合具体情境解释分数表示部分与整体的关系",
    "说明分子、分母与分数单位的含义",
    "设计学生可操作的活动与分层练习"
  ],
  rubric: ["目标达成", "互动覆盖", "证据支撑", "可执行性"],
  vars: { topic: "分数的意义", subject: "数学", grade: "五年级" }
};

const topicTask = {
  id: "topic-test",
  scenario: "topic",
  difficulty: "medium",
  threshold: 0.85,
  expectedPoints: [
    "创新点聚焦在乡村学情与个性化作业生成",
    "数据来源与教研合作使方案可落地",
    "给出可测量的作业质量与学习效果指标"
  ],
  rubric: ["创新性", "可行性", "规范性", "证据支撑"],
  vars: { title: "乡村初中数学个性化作业生成", field: "教育技术学" }
};

function educationArtifact() {
  const body = [
    "# 《分数的意义》教学设计",
    "",
    "## 教学目标",
    "学生能结合具体情境解释分数表示部分与整体的关系，说明分子、分母与分数单位的含义；能设计学生可操作的活动与分层练习，并解释每一步的分数含义 [1]。",
    "",
    "## 活动流程",
    "环节一：提问与讨论，学生用折纸表示二分之一；环节二：小组活动，比较同一个分数在不同整体中的大小；环节三：学生展示并互相评价，教师追问并反馈。",
    "",
    "## 分层练习",
    "基础层完成填空与判断；提升层画图并说明单位“1”；拓展层设计生活应用题，覆盖基础薄弱与学有余力的学生。",
    "",
    "## 课堂演练分析",
    "沉默型学生在小组活动中需要教师点名复述，薄弱型学生需要实物演示支撑。",
    "",
    "## 引用来源",
    "[1] g5-math-fractions.md，基准评测知识库：课标要求与教材定位。",
    "",
    "设计说明：围绕分数意义展开，活动、练习与评价均指向同一个可测目标，避免只讲概念不练应用。教师需要在每个环节收集学生回答作为形成性评价证据，并根据错误类型即时调整追问。分层练习要给出明确的完成标准与反馈方式，确保不同基础的学生都能获得可操作的下一步任务。"
  ].join("\n");
  return [body, body, body, body].join("\n\n");
}

function topicArtifact() {
  const body = [
    "# 选题评审报告",
    "",
    "## 总体结论",
    "选题聚焦乡村初中数学个性化作业生成，问题界定清楚，创新点成立但需要进一步收窄研究范围 [1][2]。",
    "",
    "## 必须修改项",
    "必须补充数据来源与教研合作的书面证明，明确样本学校数量、作业样本规模与采集周期；必须给出可测量的作业质量与学习效果指标。",
    "",
    "## 建议修改项",
    "建议增加对照班设计，补充教师访谈与作业错因编码方案，明确风险与进度安排。",
    "",
    "## 引用来源",
    "[1] 选题规范.md，基准评测知识库：选题需明确研究问题与数据来源。",
    "[2] 教育研究设计.md，基准评测知识库：准实验设计需要对照与前后测。",
    "",
    "补充说明：本报告从创新性、可行性、规范性与证据支撑四方面给出结论，所有判断均可追溯到引用的评审规范。可行性判断需要同时说明样本获取、教研合作、时间安排与风险应对；规范性判断需要检查研究伦理、数据脱敏与学术表述。"
  ].join("\n");
  return [body, body, body, body].join("\n\n");
}

test("compliant education artifact passes the fixed judge", () => {
  const result = rulesJudge(educationTask, educationArtifact());
  assert.equal(result.evalPassed, true);
  assert.ok(result.evalScore >= 0.85, `score=${result.evalScore}`);
  assert.deepEqual(result.hardRules, []);
});

test("citation markers without a source list fail", () => {
  const text = educationArtifact().split("[1] g5-math-fractions.md，基准评测知识库：课标要求与教材定位。").join("（来源略）");
  const result = rulesJudge(educationTask, text);
  assert.equal(result.evalPassed, false);
  assert.match(result.hardRules.join(" "), /引用不足/);
  assert.ok(result.evalScore <= 0.7);
});

test("missing required section caps the score below the threshold", () => {
  const text = educationArtifact().split("## 分层练习").join("## 练习");
  const result = rulesJudge(educationTask, text);
  assert.equal(result.evalPassed, false);
  assert.match(result.hardRules.join(" "), /缺少必需小节/);
  assert.ok(result.evalScore <= 0.6);
});

test("placeholder content caps the score", () => {
  const text = `${educationArtifact()}\nTODO 待补充`;
  const result = rulesJudge(educationTask, text);
  assert.equal(result.evalPassed, false);
  assert.ok(result.evalScore <= 0.5);
});

test("short artifact is capped even when structure is present", () => {
  const result = rulesJudge(educationTask, "## 教学目标\n讲分数\n## 活动流程\n讲练\n## 分层练习\n做题\n## 引用来源\n[1] x");
  assert.equal(result.evalPassed, false);
  assert.match(result.hardRules.join(" "), /篇幅不足/);
  assert.ok(result.evalScore <= 0.75);
});

test("topic judging requires two source entries", () => {
  const text = topicArtifact().split("[2] 教育研究设计.md，基准评测知识库：准实验设计需要对照与前后测。").join("");
  const result = rulesJudge(topicTask, text);
  assert.equal(result.evalPassed, false);
  assert.match(result.hardRules.join(" "), /来源条目 1\/2/);
});

test("single-gold-document topic tasks do not demand two sources", () => {
  const task = { ...topicTask, relevantDocs: ["topic-heritage-curriculum.md"] };
  const text = topicArtifact()
    .split("[1][2]。").join("[1]。")
    .split("[2] 教育研究设计.md，基准评测知识库：准实验设计需要对照与前后测。").join("")
    .split("[1] 选题规范.md，基准评测知识库：选题需明确研究问题与数据来源。")
    .join("[1] topic-heritage-curriculum.md，基准评测知识库：选题需明确研究问题与数据来源。");
  const result = rulesJudge(task, text);
  assert.equal(result.hardRules.some((rule) => rule.startsWith("引用不足")), false);
  assert.equal(result.evalMeta.minSourceEntries, 1);
});

test("compliant topic artifact passes", () => {
  const result = rulesJudge(topicTask, topicArtifact());
  assert.equal(result.evalPassed, true, result.hardRules.join(" "));
  assert.ok(result.evalScore >= 0.85, `score=${result.evalScore}`);
});

test("same artifact always gets the same score", () => {
  const text = educationArtifact();
  const first = rulesJudge(educationTask, text);
  const second = rulesJudge(educationTask, text);
  assert.equal(first.evalScore, second.evalScore);
  assert.deepEqual(first.evalDimensions, second.evalDimensions);
});

test("artifact extraction prefers the finalizer over the raw draft", () => {
  const trace = {
    steps: [
      { nodeId: "lesson-plan", nodeKind: "agent", status: "succeeded", sequence: 2, output: { output: "DRAFT" } },
      { nodeId: "finalize", nodeKind: "agent", status: "succeeded", sequence: 5, output: { output: "FINAL" } },
      { nodeId: "deliverable", nodeKind: "template", status: "succeeded", sequence: 6, output: "FINAL\n\n## 引用来源\n[1] SRC" },
      { nodeId: "report", nodeKind: "tool", status: "succeeded", sequence: 7, output: { output: "REPORT" } }
    ]
  };
  const artifact = extractArtifact(trace);
  assert.match(artifact.text, /## 引用来源/);
  assert.equal(artifact.source, "deliverable");
});

test("artifact extraction falls back to the historical lesson plan", () => {
  const trace = {
    steps: [
      { nodeId: "lesson-plan", nodeKind: "agent", status: "succeeded", sequence: 2, output: { output: "DRAFT" } },
      { nodeId: "verify", nodeKind: "verify", status: "succeeded", sequence: 3, output: {} }
    ]
  };
  const artifact = extractArtifact(trace);
  assert.equal(artifact.text, "DRAFT");
  assert.equal(artifact.source, "lesson-plan");
});

const relevantTask = {
  ...topicTask,
  relevantDocs: ["topic-homework-policy.md", "topic-genai-education.md"]
};

function topicWithSources(markers, sources) {
  const body = [
    "# 选题评审报告",
    "",
    "## 总体结论",
    `选题聚焦乡村初中数学个性化作业生成，创新点与可行性均已说明 ${markers}。`,
    "",
    "## 必须修改项",
    "必须补充数据来源与教研合作证明，明确样本规模、采集周期与作业质量指标。",
    "",
    "## 建议修改项",
    "建议增加对照班、教师访谈与错因编码，明确风险与进度安排。",
    "",
    "## 引用来源",
    ...sources,
    "",
    "补充说明：报告从创新性、可行性、规范性与证据支撑四方面给出结论；可行性判断覆盖样本、合作、时间与风险，规范性判断覆盖伦理、数据脱敏与学术表述。"
  ].join("\n");
  return [body, body, body, body, body, body].join("\n\n");
}

test("citing a retrieved relevant source clears the relevance rule", () => {
  const text = topicWithSources("[1][2]", [
    "[1] topic-homework-policy.md（local）：义务教育作业管理与分层作业。",
    "[2] topic-genai-education.md（local）：生成式人工智能在教育中的应用。"
  ]);
  const result = rulesJudge(relevantTask, text);
  assert.deepEqual(result.hardRules, []);
  assert.equal(result.evalMeta.relevance.available, true);
  assert.equal(result.evalMeta.relevance.cited.length, 2);
  assert.ok(result.evalMeta.relevance.score >= 0.9);
});

test("citing only irrelevant sources is capped even when citations exist", () => {
  const text = topicWithSources("[1]", [
    "[1] g7-bio-photosynthesis.md（local）：光合作用。",
    "[2] topic-homework-policy.md（local）：作业管理与分层作业。"
  ]);
  const result = rulesJudge(relevantTask, text);
  assert.match(result.hardRules.join(" "), /未引用相关证据/);
  assert.ok(result.evalScore <= 0.7);
  assert.equal(result.evalMeta.relevance.available, true);
  assert.equal(result.evalMeta.relevance.cited.length, 0);
});

test("retrieval miss does not blame the artifact", () => {
  const text = topicWithSources("[1]", [
    "[1] g7-bio-photosynthesis.md（local）：光合作用。",
    "[2] g8-history-xinhai-revolution.md（local）：辛亥革命。"
  ]);
  const result = rulesJudge(relevantTask, text);
  assert.ok(!result.hardRules.some((rule) => rule.includes("未引用相关证据")));
  assert.equal(result.evalMeta.relevance.available, false);
  assert.equal(result.evalMeta.relevance.score, 0.5);
});
