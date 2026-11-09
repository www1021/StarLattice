#!/usr/bin/env node
/**
 * 验证器准确率评估（构造式标注，非人工标注）。
 *
 * 50 条样本由本脚本按固定规则生成：每条样本只注入一类已知缺陷，
 * 因此标签来自“构造方式”而不是人工判断，可由任何人重跑复现。
 * 局限：标签与验证器规则同源，客观缺陷项的准确率会偏高；
 * 本评估不调用外部模型，也不能替代人工语义判断。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LayeredVerifier } from "../server/platform/verify/verifier.js";
import type { AgentRecord, VerifyNode } from "../server/platform/types.js";

type DefectKey =
  | "clean"
  | "missing_section"
  | "placeholder"
  | "too_short"
  | "fabricated_citation"
  | "missing_citation"
  | "empty_output"
  | "number_mismatch";

type Sample = {
  id: string;
  defect: DefectKey;
  goldPass: boolean;
  artifact: unknown;
  node: VerifyNode;
  reference?: unknown;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, "results");

const SECTIONS = ["教学目标", "活动流程", "分层练习", "课堂演练分析"];
const KEYWORDS = ["目标达成", "同桌合作", "分层练习", "课堂演练"];

const SENTENCES: Record<string, string[]> = {
  教学目标: [
    "本节课围绕分数的意义展开，学生能够用分数描述生活中的份额，能比较同分母分数的大小。",
    "目标达成以课堂检测、口头解释与同桌互评三重证据确认，教师记录未达标学生名单。",
    "学习目标拆成读懂情境、写出分数、说明理由三个可观察动作，便于当堂判定。"
  ],
  活动流程: [
    "导入用分蛋糕情境唤起经验，学生先独立写出自己分到的份额，再同桌交换核对。",
    "新授环节组织同桌合作折纸、涂色并记录结果，教师巡视收集典型错例用于集体讲评。",
    "练习环节进行限时闯关，小结环节由学生用一句话概括分数的意义，教师补充分母的含义。"
  ],
  分层练习: [
    "基础层完成教材口算与看图写分数，要求写出分母与分子的实际含义。",
    "提高层比较同分母分数并说明理由，鼓励用画图或实物操作作为证据。",
    "挑战层设计一个用分数描述的校园场景并解释，允许学生自主选择表达方式。",
    "分层练习按学生当堂表现动态调整，完成基础层的学生在教师确认后进入提高层。"
  ],
  课堂演练分析: [
    "演练中基础薄弱学生能借助折纸完成看图写分数，说明操作经验对抽象概念有支撑作用。",
    "沉默型学生被点名后能说出同分母分数比较的方法，教师用追问把回答扩展成完整句子。",
    "学霸型学生提出跨组分母不同时的疑问，教师顺势把问题写成下节课的探究任务。",
    "课堂演练暴露的问题是追问节奏偏快，后续需要给沉默学生留出更长的思考等待时间。"
  ]
};

const CITATIONS = ["[1]", "[2]"];
const METRICS = "课时：45\n作业时长：15";

function baseBody(sectionOverrides: Partial<Record<string, string[]>> = {}) {
  return SECTIONS.map((section) => {
    const lines = sectionOverrides[section] ?? SENTENCES[section];
    const citations = section === "活动流程" ? ` ${CITATIONS.join("")}` : "";
    return `## ${section}\n${lines.join("")}${citations}`;
  }).join("\n\n");
}

function longBody() {
  const body = baseBody();
  const followUp = [
    "## 学情与后续调整",
    "本班学生已经具备平均分与简单分数的生活经验，但在用语言解释分母含义时仍依赖具体图形。",
    "教师需要在下一课时提供更多口头表达机会，并把本课收集的错例整理成新的演练材料。",
    "对于基础薄弱学生，课后安排一对一同伴互助；对于学有余力的学生，提供跨分母比较的探究单。",
    "作业设计延续课堂分层，基础层记录三题完成情况，提高层写一段比较理由，挑战层拍摄生活中的分数并说明。",
    "教师在课后根据作业反馈调整下一课时的起点，并把典型错例整理成新的演练材料，供下一轮课堂使用。",
    "评价方式采用课堂观察、作业批改与学生自评三种来源，三者不一致时以课堂观察为准并补做一次口头检测。"
  ].join("");
  return `${body}\n\n${followUp}\n\n${METRICS}\n`;
}

function shortBody() {
  const lines = [
    "## 教学目标\n学生能认识分数。目标达成。",
    "## 活动流程\n同桌合作折纸。",
    "## 分层练习\n分层练习一页。",
    "## 课堂演练分析\n课堂演练一句。[1][2]"
  ];
  return `${lines.join("\n")}\n`;
}

const EVIDENCE = [
  "《义务教育数学课程标准》指出：分数的教学应结合具体情境，帮助学生理解分数的意义。",
  "教材第三单元分析：同分母分数比较适合借助图形直观，先操作后抽象。",
  "课堂观察记录模板：记录学生回答次数、操作完成度与错误类型。"
];

function nodeOf(extra: Partial<VerifyNode> = {}): VerifyNode {
  return {
    id: "verify-eval",
    kind: "verify",
    verifier: "verifier-a",
    verifiers: ["verifier-a", "verifier-b"],
    rubric: ["目标达成", "互动覆盖", "证据支撑"],
    threshold: 0.85,
    requiredSections: SECTIONS,
    minChars: 800,
    requireEvidence: true,
    minCitations: 2,
    expectedKeywords: KEYWORDS,
    ...extra
  };
}

function agentsOf(): AgentRecord[] {
  return ["verifier-a", "verifier-b"].map((id) => ({
    id,
    name: id,
    version: 1,
    role: "验证",
    prompt: "",
    tools: ["verify.rubric"],
    model: "",
    capabilities: [
      { tag: "目标达成", weight: 0.8 },
      { tag: "互动覆盖", weight: 0.8 },
      { tag: "证据支撑", weight: 0.8 }
    ],
    memory: {},
    enabled: true,
    createdAt: "",
    updatedAt: ""
  }));
}

function buildSamples(): Sample[] {
  const samples: Sample[] = [];
  const push = (defect: DefectKey, count: number, make: (index: number) => Omit<Sample, "id" | "defect" | "goldPass">) => {
    for (let index = 0; index < count; index += 1) {
      samples.push({
        id: `${defect}-${String(index + 1).padStart(2, "0")}`,
        defect,
        goldPass: defect === "clean",
        ...make(index)
      });
    }
  };

  push("clean", 20, () => ({ artifact: { output: longBody() }, node: nodeOf() }));

  push("missing_section", 5, (index) => {
    const section = SECTIONS[index % SECTIONS.length];
    const body = longBody().replace(`## ${section}`, `## 本节说明`);
    return { artifact: { output: body }, node: nodeOf() };
  });

  push("placeholder", 5, () => ({
    artifact: { output: `${longBody()}\n（此处填写具体学情）` },
    node: nodeOf()
  }));

  push("too_short", 5, () => ({ artifact: { output: shortBody() }, node: nodeOf() }));

  push("fabricated_citation", 4, () => ({
    artifact: { output: longBody().replace("[2]", "[9]") },
    node: nodeOf()
  }));

  push("missing_citation", 4, () => ({
    artifact: { output: longBody().replace(/\[1\]|\[2\]/g, "") },
    node: nodeOf()
  }));

  push("empty_output", 3, () => ({ artifact: { output: "" }, node: nodeOf() }));

  push("number_mismatch", 4, () => ({
    artifact: { output: longBody().replace("课时：45", "课时：30") },
    node: nodeOf({
      checks: [{ type: "number_match", tolerance: 0, anchors: ["课时", "作业时长"] }]
    }),
    reference: "课时：45\n作业时长：15"
  }));

  return samples;
}

const verifier = new LayeredVerifier();
const rows = buildSamples().map((sample) => {
  const report = verifier.evaluate({
    node: sample.node,
    artifact: sample.artifact,
    evidence: EVIDENCE,
    reference: sample.reference,
    mode: "live",
    agents: agentsOf()
  });
  const critical = report.layers.rule.checks
    .filter((check) => check.critical && !check.passed)
    .map((check) => check.key);
  return {
    id: sample.id,
    defect: sample.defect,
    goldPass: sample.goldPass,
    predictedPass: report.passed,
    correct: report.passed === sample.goldPass,
    score: report.score,
    ruleScore: report.layers.rule.score,
    confidence: report.confidence,
    criticalFailed: critical,
    failedChecks: report.layers.rule.checks
      .filter((check) => !check.passed && !check.informational)
      .map((check) => check.key)
  };
});

const total = rows.length;
const correct = rows.filter((row) => row.correct).length;
const cleanRows = rows.filter((row) => row.defect === "clean");
const defectRows = rows.filter((row) => row.defect !== "clean");
const cleanAccepted = cleanRows.filter((row) => row.predictedPass).length;
const defectsCaught = defectRows.filter((row) => !row.predictedPass).length;

const perDefect = [...new Set(rows.map((row) => row.defect))].map((defect) => {
  const subset = rows.filter((row) => row.defect === defect);
  const hit = subset.filter((row) => row.correct).length;
  return {
    defect,
    n: subset.length,
    correct: hit,
    accuracy: hit / subset.length,
    avgScore: average(subset.map((row) => row.score)),
    criticalFailed: subset.filter((row) => row.criticalFailed.length > 0).length
  };
});

const falseNegatives = rows.filter((row) => row.goldPass === false && row.predictedPass);
const falsePositives = rows.filter((row) => row.goldPass === true && !row.predictedPass);

const markdown = [
  "# 验证器准确率评估（构造式标注，非人工标注）",
  "",
  "- 生成时间：脚本运行时求值，本文件由 `npm run bench:verifier` 重建",
  "- 样本数：50（20 条合格产物 + 30 条已知缺陷产物）",
  "- 判定路径：`LayeredVerifier` live 模式，规则层 + 基准比对 + 启发式维度分；不调用外部模型",
  "- 标签来源：脚本按“注入哪类缺陷”确定性生成，任何人重跑可复现；**不是人工标注**",
  "",
  "## 总体",
  "",
  "| 指标 | 数值 |",
  "| --- | ---: |",
  `| 与构造标签一致 | ${correct}/${total}（${pct(correct / total)}） |`,
  `| 合格产物被接受 | ${cleanAccepted}/${cleanRows.length}（${pct(cleanAccepted / cleanRows.length)}） |`,
  `| 缺陷产物被拦截 | ${defectsCaught}/${defectRows.length}（${pct(defectsCaught / defectRows.length)}） |`,
  `| 假阴性（缺陷被放过） | ${falseNegatives.length} |`,
  `| 假阳性（合格被拦截） | ${falsePositives.length} |`,
  "",
  "## 分类别",
  "",
  "| 缺陷类型 | 样本 | 判定正确 | 准确率 | 平均分 | 触发硬性封顶 |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...perDefect.map(
    (item) =>
      `| ${item.defect} | ${item.n} | ${item.correct} | ${pct(item.accuracy)} | ${item.avgScore.toFixed(3)} | ${item.criticalFailed}/${item.n} |`
  ),
  "",
  "## 假阴性明细",
  "",
  ...(falseNegatives.length === 0
    ? ["- 无"]
    : falseNegatives.map(
        (row) =>
          `- ${row.id}：得分 ${row.score.toFixed(3)}，规则分 ${row.ruleScore.toFixed(3)}，未通过检查 ${row.failedChecks.join("、") || "无"}`
      )),
  "",
  "## 本次评估发现并修复的判定缺口",
  "",
  "- 小节检查原先按全文子串匹配：正文顺带提到「分层练习」就能顶替缺失的小节标题，缺陷样本因此漏判。现改为行首标题匹配（支持 `##`、`**`、列表与编号前缀）。",
  "- 占位内容原先只扣规则分、不触发硬性封顶：篇幅更长时占位产物仍可能越过阈值。现与固定裁判一致，把占位标记在 live 模式列为硬性缺陷。",
  "- 这两处是先有缺陷样本、后有修复；修复后 50/50 是回归基线，不是“验证器已经能判断教学质量”的证据。",
  "",
  "## 边界",
  "",
  "- 客观缺陷（缺小节、篇幅不足、伪造引用、数值不一致）与验证器规则同源，100% 不代表能判断教学语义质量。",
  "- 只使用启发式维度分，未覆盖 live 模型打分；模型打分的准确率需要独立实验。",
  "- 若后续改动规则，重跑本脚本即可看到构造样本上的回归。",
  ""
].join("\n");

mkdirSync(resultsDir, { recursive: true });
const jsonPath = path.join(resultsDir, "verifier-accuracy.json");
const mdPath = path.join(resultsDir, "verifier-accuracy.md");
writeFileSync(
  jsonPath,
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      labeling: "constructed-not-human",
      mode: "live-rule-plus-heuristic",
      total,
      correct,
      cleanAccepted,
      defectsCaught,
      falseNegatives: falseNegatives.map((row) => row.id),
      falsePositives: falsePositives.map((row) => row.id),
      perDefect,
      rows
    },
    null,
    2
  )}\n`
);
writeFileSync(mdPath, markdown);
console.log(markdown);
console.log(`报告：${mdPath}`);
console.log(`JSON：${jsonPath}`);

function average(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pct(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}
