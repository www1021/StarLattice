#!/usr/bin/env node
/**
 * 验证器灵敏度审计（无人工锚点）。
 *
 * 从隔离库取一份真实产物，按可控缺陷做定向删改（去掉证据 / 去掉行动建议 / 去掉结论 / 截断），
 * 用同一套验证 Agent 重新打分。若验证器只对"措辞"敏感而不对"报告质量"敏感，删改后的分数应基本不变；
 * 反之分数应随缺陷单调下降。这是对验证器方向性的操纵检验，不需要人工标注。
 *
 * 用法：npx tsx benchmarks/audit-verifier-sensitivity.ts <platform-*.db> [taskId] [repeats]
 */
import "dotenv/config";
import Database from "better-sqlite3";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LayeredVerifier, type VerifyRequest } from "../server/platform/verify/verifier.js";
import { createLlmDimensionScorer, isLlmVerifyEnabled } from "../server/platform/verify/liveScorer.js";
import { BUILTIN_AGENTS } from "../server/platform/registry/agents.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, "results");
const dbPath = process.argv[2];
const taskId = process.argv[3] || "topic-01";
const repeats = Number(process.argv[4] || 2);
if (!dbPath) {
  console.error("用法：npx tsx benchmarks/audit-verifier-sensitivity.ts <platform-*.db> [taskId] [repeats]");
  process.exit(1);
}
if (!isLlmVerifyEnabled()) {
  console.error("需要 PLATFORM_LIVE_AGENTS=1 且配置模型 key（不打印具体值）");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const run = db
  .prepare("select id from platform_runs where workflow_id = ? and status = 'succeeded' order by started_at")
  .all("bench-topic-full-platform")
  .map((row) => ({ id: row.id, input: JSON.parse(db.prepare("select input from platform_runs where id = ?").get(row.id).input) }))
  .find((row) => row.input.taskId === taskId);
if (!run) {
  console.error(`库里没有 ${taskId} 的完整平台运行`);
  process.exit(1);
}
const summaryStep = JSON.parse(
  db.prepare("select output from platform_run_steps where run_id = ? and node_id = 'summary'").get(run.id).output
);
const retrieveStep = JSON.parse(
  db.prepare("select output from platform_run_steps where run_id = ? and node_id = 'retrieve'").get(run.id).output
);
db.close();

const original: string = summaryStep.output ?? summaryStep.summary ?? "";
const evidence: string[] = (retrieveStep.citations ?? []).map(
  (item: { title?: string; knowledgeBaseName?: string }) => `${item.title ?? "未命名文档"}（${item.knowledgeBaseName ?? "知识库"}）`
);

const variants: Array<{ name: string; label: string; text: string }> = [
  { name: "original", label: "原始产物", text: original },
  {
    name: "no-citations",
    label: "删除引用标记与引用来源节",
    text: removeSections(original, /引用来源|参考文献/).replace(/\[\d+\]/g, "").replace(/（来源：[^）]*）/g, "")
  },
  {
    name: "no-action",
    label: "删除必须修改项与建议修改项",
    text: removeSections(original, /必须修改|建议修改|改进建议/)
  },
  {
    name: "no-conclusion",
    label: "删除总体结论与开题判断",
    text: removeSections(original, /总体结论|是否建议进入开题|开题结论/)
  },
  { name: "truncated", label: "只保留前 60% 字句", text: truncateBlocks(original, 0.6) }
];

const agents = BUILTIN_AGENTS.filter((agent) =>
  ["topic-review-verifier", "topic-review-auditor"].includes(agent.id)
).map((agent) => ({
  id: agent.id,
  name: agent.name,
  version: 1,
  role: agent.role,
  prompt: agent.prompt,
  tools: agent.tools ?? [],
  model: "classroom-llm",
  capabilities: agent.capabilities,
  memory: agent.memory ?? {},
  enabled: true,
  createdAt: "",
  updatedAt: ""
}));

const verifier = new LayeredVerifier(createLlmDimensionScorer());
// 与生产 verify-report 节点保持一致，含必需的结论与最小篇幅检查。
const node = {
  id: "sensitivity",
  kind: "verify" as const,
  verifier: "topic-review-verifier",
  verifiers: ["topic-review-verifier", "topic-review-auditor"],
  rubric: ["创新性", "可行性", "规范性", "证据支撑"],
  required: ["结论"],
  minChars: 600,
  threshold: 0.85
};

async function main() {
const rows: Array<{ variant: string; label: string; chars: number; scores: number[]; spreads: number[] }> = [];
for (const variant of variants) {
  const scores: number[] = [];
  const spreads: number[] = [];
  for (let attempt = 0; attempt < repeats; attempt += 1) {
    const request: VerifyRequest = {
      node,
      artifact: { output: variant.text },
      evidence,
      attempt: attempt + 1,
      mode: "live",
      agents
    };
    const report = await verifier.evaluateAsync(request);
    scores.push(report.score);
    const verifierScores = report.layers.crossCheck.verifiers.map((item) => item.score);
    spreads.push(Math.max(...verifierScores) - Math.min(...verifierScores));
  }
  rows.push({ variant: variant.name, label: variant.label, chars: variant.text.length, scores, spreads });
  console.log(`${variant.label}: ${scores.map((value) => value.toFixed(3)).join(" / ")}`);
}

const base = mean(rows[0].scores) ?? 0;
const lines = [
  "# 验证器灵敏度审计（缺陷注入）",
  "",
  `- 生成时间：${new Date().toISOString()}`,
  `- 样本：${taskId} 的完整平台产物（${original.length} 字），模型：${process.env.PLATFORM_LIVE_MODEL || "default"}`,
  `- 方法：对真实产物做定向删改，复用生产验证 Agent 重新打分，每个变体重复 ${repeats} 次。`,
  "- 口径：若验证器对报告质量有方向性，删改后的分数应下降；如果删改前后基本不变，说明验证器对措辞而非内容敏感。",
  "",
  "| 变体 | 字数 | 验证分（各次） | 均值 | 相对原始 | 验证器分歧均值 |",
  "| --- | ---: | --- | ---: | ---: | ---: |"
];
for (const row of rows) {
  const avg = mean(row.scores) ?? 0;
  lines.push(
    `| ${row.label} | ${row.chars} | ${row.scores.map((value) => value.toFixed(3)).join(" / ")} | ${avg.toFixed(3)} | ${(avg - base).toFixed(3)} | ${(mean(row.spreads) ?? 0).toFixed(3)} |`
  );
}
const markdown = lines.join("\n") + "\n";
mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(path.join(resultsDir, `verify-sensitivity-${stamp}.md`), markdown);
writeFileSync(path.join(resultsDir, "verify-sensitivity-latest.md"), markdown);
console.log(markdown);
}

void main();

// 按 Markdown 二级标题切节，删掉标题匹配的整节，保留其余内容原样。
function removeSections(text: string, pattern: RegExp) {
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } | null = null;
  for (const line of text.split("\n")) {
    if (/^##\s/.test(line)) {
      current = { heading: line, body: [line] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      current = { heading: "", body: [line] };
      sections.push(current);
    }
  }
  return sections
    .filter((section) => !pattern.test(section.heading))
    .map((section) => section.body.join("\n"))
    .join("\n")
    .trim();
}

function truncateBlocks(text: string, ratio: number) {
  const blocks = text.split(/\n{2,}/);
  return blocks.slice(0, Math.max(1, Math.round(blocks.length * ratio))).join("\n\n");
}

function mean(values: number[]) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}
