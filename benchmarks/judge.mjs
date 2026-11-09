#!/usr/bin/env node
/**
 * 固定裁判（与平台验证器无关）。
 *
 * 设计目标：同一份产物，无论来自哪个基线、第几次运行，都得到同一分数。
 * - rules 模式：结构 / 引用 / 篇幅 / 占位符硬规则 + expectedPoints 字符 bigram 覆盖率 + 维度启发式，完全离线可复现。
 * - llm 模式：同一裁判模型、temperature=0、同一提示词；硬规则仍然生效并封顶。
 *
 * 裁判只读取产物正文与用例元数据，不读取基线标签、平台验证分或自循环记录，避免自证。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const JUDGE_VERSION = "fixed-judge-rules-v2";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(HERE, ".tmp", "judge-llm-cache.json");

const PLACEHOLDER_PATTERN =
  /TODO|待补充|待完善|此处填写|此处插入|此处占位|请填写|lorem ipsum|示例占位|占位符未替换|占位待替换|[（(【\[]\s*(?:占位|待填|填写)[）)】\]]/i;

const EDUCATION_SECTIONS = [
  { key: "objective", label: "教学目标", pattern: /教学目标|学习目标|素养目标|目标设计/ },
  { key: "activity", label: "活动流程", pattern: /活动流程|教学过程|教学活动|教学流程|课堂活动/ },
  { key: "practice", label: "分层练习", pattern: /分层练习|分层作业|练习设计|作业分层|分层任务/ },
  { key: "sources", label: "引用来源", pattern: /引用来源|参考文献|参考资料|资料来源/ }
];

const TOPIC_SECTIONS = [
  { key: "conclusion", label: "总体结论", pattern: /总体结论|综合结论|总体评价|结论与建议/ },
  { key: "must", label: "必须修改项", pattern: /必须修改项|必须修改|关键修改|必改项/ },
  { key: "should", label: "建议修改项", pattern: /建议修改项|建议修改|优化建议|改进建议/ },
  { key: "sources", label: "引用来源", pattern: /引用来源|参考文献|参考资料|资料来源/ }
];

const MEASURABLE_VERBS = /说出|解释|描述|设计|运用|分析|比较|列举|完成|掌握|区分|归纳|评价|迁移/g;
const INTERACTION_MARKERS =
  /提问|追问|讨论|小组|同桌|活动|演示|练习|互动|回答|展示|评价|反馈|角色扮演|实验操作/g;
const EVIDENCE_MARKERS =
  /知识库|检索|资料|证据|文献|来源|引用|课程标准|教材|数据/g;
const INNOVATION_MARKERS =
  /创新|首次|新方法|新视角|差异|空白|贡献|突破|改进|原创|尚未见/g;
const FEASIBILITY_MARKERS =
  /数据|样本|实验|周期|预算|团队|合作|基础|风险|进度|可行性|资源|条件|方法/g;

export function extractArtifact(trace) {
  const steps = Array.isArray(trace?.steps) ? trace.steps : [];
  const succeeded = steps
    .filter((step) => step && step.status === "succeeded")
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0));
  const pick = (matcher) =>
    [...succeeded].reverse().find((step) => matcher(String(step.nodeId ?? ""), step));

  const deliverable = pick((nodeId, step) => /(^|\.)deliverable$/.test(nodeId));
  if (deliverable) return artifactOf(deliverable, "deliverable");

  const finalize = pick((nodeId, step) => step.nodeKind === "agent" && isFinalizer(nodeId));
  if (finalize) return artifactOf(finalize, "finalize");

  // 历史 A0 没有 finalize，取初稿作为交付物；不替它补结构。
  const plan = pick((nodeId, step) => step.nodeKind === "agent" && /(^|\.)lesson-plan$/.test(nodeId));
  if (plan) return artifactOf(plan, "lesson-plan");

  const review = pick(
    (nodeId, step) =>
      step.nodeKind === "agent" && /(^|\.)(report|summary|review)$/.test(nodeId)
  );
  if (review) return artifactOf(review, "review");

  const report = pick((nodeId) => /(^|\.)report$/.test(nodeId));
  if (report) return artifactOf(report, "report");

  const lastAgent = pick((_nodeId, step) => step.nodeKind === "agent");
  return lastAgent ? artifactOf(lastAgent, "last-agent") : { text: "", source: "missing", step: null };
}

function isFinalizer(nodeId) {
  return /(^|\.)finalize$/.test(nodeId);
}

function artifactOf(step, source) {
  return {
    text: textOf(step.output).trim(),
    source,
    nodeId: step.nodeId ?? null,
    path: step.path ?? null,
    sequence: step.sequence ?? null
  };
}

export function textOf(value, depth = 0) {
  if (value === undefined || value === null || depth > 6) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => textOf(item, depth + 1)).join("\n");
  if (typeof value === "object") {
    const record = value;
    if (typeof record.output === "string") return record.output;
    if (record.output !== undefined) return textOf(record.output, depth + 1);
    return Object.values(record)
      .map((item) => textOf(item, depth + 1))
      .join("\n");
  }
  return "";
}

export function judgeArtifact(task, text, options = {}) {
  const mode = options.mode ?? process.env.BENCH_JUDGE_MODE ?? "rules";
  const threshold = Number(task.threshold ?? 0.85);
  const rules = rulesJudge(task, text, threshold);
  if (mode !== "llm") {
    return { ...rules, judgeMode: "rules", judgeModel: null, judgeFallback: false };
  }
  const llm = llmJudgeSync(task, text, rules, options);
  return llm;
}

export function rulesJudge(task, text, threshold = Number(task.threshold ?? 0.85)) {
  const normalized = String(text ?? "");
  const scenario = task.scenario === "topic" ? "topic" : "education";
  const sections = scenario === "topic" ? TOPIC_SECTIONS : EDUCATION_SECTIONS;
  const minChars = scenario === "topic" ? 1200 : 800;
  const goldDocs = relevantDocsOf(task);
  // 要求引用的来源数不能超过该任务实际可用的金标证据数，否则单文档任务永远无法满足契约。
  const topicCitationFloor = goldDocs.length > 0 ? Math.min(2, goldDocs.length) : 2;
  const minCitations = scenario === "topic" ? Math.max(1, topicCitationFloor) : 1;
  const minSourceEntries = scenario === "topic" ? Math.max(1, topicCitationFloor) : 1;
  const chars = countChars(normalized);
  const citations = citationSummary(normalized);
  const relevance = relevanceOf(citations, task);
  const missingSections = sections.filter((section) => !hasSection(normalized, section.pattern));
  const coverage = coverageOf(normalized, task.expectedPoints ?? []);
  const hasPlaceholder = PLACEHOLDER_PATTERN.test(normalized);
  const dims =
    scenario === "topic"
      ? topicDimensions(normalized, { chars, citations, missingSections, coverage, relevance })
      : educationDimensions(normalized, { chars, citations, missingSections, coverage, relevance });

  const hardRules = [];
  if (normalized.trim() === "") hardRules.push("产物为空");
  if (missingSections.length > 0) {
    hardRules.push(`缺少必需小节：${missingSections.map((item) => item.label).join("、")}`);
  }
  if (
    citations.markers.length < minCitations ||
    citations.sourceEntries < minSourceEntries
  ) {
    hardRules.push(
      `引用不足：正文标记 ${citations.markers.length}/${minCitations}，来源条目 ${citations.sourceEntries}/${minSourceEntries}`
    );
  }
  // 检索已经给出相关来源却一条都没引用，属于证据错配；若检索本身没命中相关来源，则不把检索缺陷算到产物头上。
  if (relevance.applicable && relevance.available && relevance.relevantCited.length === 0) {
    hardRules.push("未引用相关证据");
  }
  if (chars < minChars) {
    hardRules.push(`篇幅不足：${chars} < ${minChars}`);
  }
  if (hasPlaceholder) {
    hardRules.push("含占位内容");
  }

  let score = round4(average(Object.values(dims)));
  for (const failure of hardRules) {
    if (failure.startsWith("产物为空")) score = 0;
    else if (failure.startsWith("含占位")) score = Math.min(score, 0.5);
    else if (failure.startsWith("缺少必需小节")) score = Math.min(score, 0.6);
    else if (failure.startsWith("引用不足")) score = Math.min(score, 0.7);
    else if (failure.startsWith("未引用相关证据")) score = Math.min(score, 0.7);
    else if (failure.startsWith("篇幅不足")) score = Math.min(score, 0.75);
  }
  score = round4(score);

  return {
    evalScore: score,
    evalPassed: score >= threshold && hardRules.length === 0,
    evalDimensions: dims,
    hardRules,
    evalMeta: {
      threshold,
      chars,
      minChars,
      citations,
      minCitations,
      minSourceEntries,
      missingSections: missingSections.map((section) => section.label),
      coverage: round4(coverage.covered),
      coverageAvg: round4(coverage.average),
      relevance: {
        applicable: relevance.applicable,
        available: relevance.available,
        docs: relevance.docs,
        retrieved: relevance.retrieved,
        cited: relevance.relevantCited,
        score: round4(relevance.score)
      }
    }
  };
}

function educationDimensions(text, context) {
  const { chars, citations, missingSections, coverage, relevance } = context;
  const missing = new Set(missingSections.map((section) => section.key));
  const measurable = countMatches(text, MEASURABLE_VERBS);
  const interactions = countMatches(text, INTERACTION_MARKERS);
  const evidenceWords = countMatches(text, EVIDENCE_MARKERS);
  return {
    目标达成: round4(
      0.45 * coverage.covered +
        0.25 * coverage.average +
        0.15 * (missing.has("objective") ? 0 : 1) +
        0.15 * Math.min(1, measurable / 10)
    ),
    互动覆盖: round4(
      0.5 * Math.min(1, interactions / 16) +
        0.25 * (missing.has("activity") ? 0 : 1) +
        0.25 * Math.min(1, chars / 1500)
    ),
    证据支撑: round4(
      0.3 * Math.min(1, citations.count / 3) +
        0.15 * (missing.has("sources") ? 0 : 1) +
        0.15 * Math.min(1, citations.sourceEntries / 2) +
        0.22 * Math.min(1, evidenceWords / 10) +
        0.18 * relevance.score
    ),
    可执行性: round4(
      0.35 * (missing.has("practice") ? 0 : 1) +
        0.35 * Math.min(1, chars / 1600) +
        0.3 * Math.min(1, interactions / 12)
    )
  };
}

function topicDimensions(text, context) {
  const { chars, citations, missingSections, coverage, relevance } = context;
  const missing = new Set(missingSections.map((section) => section.key));
  const innovation = countMatches(text, INNOVATION_MARKERS);
  const feasibility = countMatches(text, FEASIBILITY_MARKERS);
  const sectionScore =
    (missing.has("conclusion") ? 0 : 0.4) +
    (missing.has("must") ? 0 : 0.3) +
    (missing.has("should") ? 0 : 0.3);
  return {
    创新性: round4(
      0.35 * coverage.covered +
        0.3 * Math.min(1, innovation / 10) +
        0.2 * (missing.has("conclusion") ? 0 : 1) +
        0.15 * Math.min(1, chars / 1500)
    ),
    可行性: round4(
      0.35 * Math.min(1, feasibility / 12) +
        0.3 * coverage.average +
        0.2 * (missing.has("must") ? 0 : 1) +
        0.15 * Math.min(1, chars / 1600)
    ),
    规范性: round4(
      0.4 * sectionScore +
        0.25 * Math.min(1, citations.count / 3) +
        0.2 * Math.min(1, chars / 1600) +
        0.15 * Math.min(1, citations.sourceEntries / 2)
    ),
    证据支撑: round4(
      0.32 * Math.min(1, citations.count / 3) +
        0.16 * (missing.has("sources") ? 0 : 1) +
        0.18 * Math.min(1, citations.sourceEntries / 2) +
        0.34 * relevance.score
    )
  };
}

function coverageOf(text, expectedPoints) {
  const artifact = bigrams(text);
  const points = expectedPoints.map((point) => {
    const target = bigrams(point);
    if (target.size === 0) return 1;
    let hit = 0;
    for (const gram of target) if (artifact.has(gram)) hit += 1;
    return hit / target.size;
  });
  if (points.length === 0) return { covered: 1, average: 1 };
  return {
    covered: points.filter((value) => value >= 0.34).length / points.length,
    average: average(points)
  };
}

function bigrams(value) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
  const grams = new Set();
  const chars = [...normalized];
  for (let index = 0; index + 1 < chars.length; index += 1) {
    grams.add(chars[index] + chars[index + 1]);
  }
  if (chars.length === 1) grams.add(chars[0]);
  return grams;
}

/** 小节是否真的存在：只认标题行，避免正文里“提到过某词”就算覆盖。 */
function hasSection(text, pattern) {
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!pattern.test(line)) continue;
    if (/^#{1,6}\s/.test(line)) return true;
    if (/^\*\*[^*]{2,24}\*\*/.test(line)) return true;
    if (/^[一二三四五六七八九十]+[、.]\s*\S/.test(line) && line.length <= 40) return true;
    if (/^【[^】]{2,20}】/.test(line) && line.length <= 40) return true;
  }
  return false;
}

export function citationSummary(text) {
  const markers = new Set();
  for (const match of bodyWithoutSources(text).matchAll(/\[(\d{1,3})\]|【(\d{1,3})】|［(\d{1,3})］/g)) {
    markers.add(match[1] ?? match[2] ?? match[3]);
  }
  const byIndex = new Map();
  for (const line of sourceLinesOf(text)) {
    const match = line.match(
      /^(?:[-*+]\s*)?(?:\[(\d{1,3})\]|【(\d{1,3})】|［(\d{1,3})］|(\d{1,3})[.、)])\s*(\S.*)$/
    );
    if (!match) continue;
    const index = match[1] ?? match[2] ?? match[3] ?? match[4];
    const title = docTitleOf(match[5]);
    if (!title) continue;
    const key = index ?? String(byIndex.size + 1);
    const existing = byIndex.get(key);
    // 同一编号出现两次（模型自写来源 + 平台追加来源）时，优先保留带文档扩展名的真实文件名。
    if (!existing || (looksLikeFile(title) && !looksLikeFile(existing.title))) {
      byIndex.set(key, { index: key, title });
    }
  }
  const sources = [...byIndex.values()].sort((left, right) => Number(left.index) - Number(right.index));
  return {
    count: Math.max(markers.size, sources.length),
    markers: [...markers],
    sourceEntries: sources.length,
    sources
  };
}

function docTitleOf(raw) {
  const text = String(raw ?? "").trim();
  const cut = text.split(/\s+[—–-]\s+|[（(：:]/)[0].trim();
  if (!cut) return "";
  const file = cut.match(/[^\s，,。；;]+\.(?:md|txt|pdf)\b/i);
  return file ? file[0] : cut.slice(0, 60);
}

function looksLikeFile(title) {
  return /\.(?:md|txt|pdf)\b/i.test(String(title));
}

function relevantDocsOf(task) {
  if (Array.isArray(task?.relevantDocs)) return task.relevantDocs.filter(Boolean);
  if (Array.isArray(task?.vars?.relevantDocs)) return task.vars.relevantDocs.filter(Boolean);
  return [];
}

function relevanceOf(citations, task) {
  const docs = relevantDocsOf(task);
  if (docs.length === 0) {
    return { applicable: false, available: false, docs: [], retrieved: [], relevantCited: [], score: 1 };
  }
  const normalize = (value) =>
    String(value ?? "")
      .toLowerCase()
      .replace(/\.md$/i, "")
      .replace(/\s+/g, "")
      .trim();
  const targets = docs.map(normalize).filter(Boolean);
  const matches = (title) =>
    targets.some((target) => normalize(title).includes(target) || target.includes(normalize(title)));
  const retrieved = citations.sources.filter((source) => matches(source.title));
  const citedSources = citations.sources.filter((source) =>
    citations.markers.includes(String(source.index))
  );
  const relevantCited = citedSources.filter((source) => matches(source.title));
  const available = retrieved.length > 0;
  let score = 0.5;
  if (available) {
    const recall = Math.min(1, uniqueTitles(relevantCited).length / Math.min(docs.length, 2));
    const precision = citedSources.length === 0 ? 0 : uniqueTitles(relevantCited).length / uniqueTitles(citedSources).length;
    score = clamp01(0.75 * recall + 0.25 * precision);
  }
  return {
    applicable: true,
    available,
    docs: [...docs],
    retrieved: uniqueTitles(retrieved),
    relevantCited: uniqueTitles(relevantCited),
    score
  };
}

function uniqueTitles(sources) {
  return [...new Set(sources.map((source) => source.title))];
}

function sourceLinesOf(text) {
  const lines = [];
  let inSources = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (/^#{1,6}\s*.*(引用来源|参考文献|参考资料|资料来源|检索来源)/.test(line)) {
      inSources = true;
      continue;
    }
    if (inSources && /^#{1,6}\s+/.test(line)) {
      inSources = false;
    }
    if (inSources && line) lines.push(line);
  }
  return lines;
}

/**
 * 正文引用标记只认来源列表之前的正文。
 * 来源列表里的 “[1] 文档名” 是条目编号，不是正文引用；混在一起会把“列了来源但没引用”误判为已引用。
 */
function bodyWithoutSources(text) {
  const kept = [];
  let inSources = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^#{1,6}\s*.*(引用来源|参考文献|参考资料|资料来源|检索来源)/.test(trimmed)) {
      inSources = true;
      continue;
    }
    if (inSources && /^#{1,6}\s+/.test(trimmed)) {
      inSources = false;
    }
    if (!inSources) kept.push(line);
  }
  return kept.join("\n");
}

function countChars(text) {
  return String(text).replace(/[\s#>*_`|-]/g, "").length;
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round4(value) {
  return Number(Number(value).toFixed(4));
}

/* ------------------------------ 可选 LLM 裁判 ------------------------------ */

function llmJudgeSync(task, text, rules, options) {
  const config = judgeModelConfig();
  if (!config) {
    return { ...rules, judgeMode: "rules-fallback", judgeModel: null, judgeFallback: true, judgeError: "未配置裁判模型" };
  }
  const hash = createHash("sha256").update(`${config.model}\n${task.id}\n${text}`).digest("hex");
  const cache = readCache();
  if (cache[hash]) {
    return { ...cache[hash], judgeMode: "llm", judgeModel: config.model, judgeFallback: false, cached: true };
  }
  const prompt = buildJudgePrompt(task, text);
  const payload = {
    model: config.model,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "你是独立评审裁判。只输出 JSON，不解释。评分必须基于产物正文。" },
      { role: "user", content: prompt }
    ]
  };
  try {
    const response = syncPost(`${config.baseUrl}/chat/completions`, payload, config.apiKey);
    const content = response?.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(stripCodeFence(content));
    const dims = {};
    for (const name of task.rubric ?? []) {
      const value = Number(parsed.dimensions?.[name]);
      if (Number.isFinite(value)) dims[name] = round4(clamp01(value));
    }
    if (Object.keys(dims).length === 0) throw new Error("裁判未返回有效维度分");
    let score = round4(average(Object.values(dims)));
    for (const failure of rules.hardRules) {
      if (failure.startsWith("产物为空")) score = 0;
      else if (failure.startsWith("含占位")) score = Math.min(score, 0.5);
      else if (failure.startsWith("缺少必需小节")) score = Math.min(score, 0.6);
      else if (failure.startsWith("引用不足")) score = Math.min(score, 0.7);
      else if (failure.startsWith("未引用相关证据")) score = Math.min(score, 0.7);
      else if (failure.startsWith("篇幅不足")) score = Math.min(score, 0.75);
    }
    const result = {
      evalScore: round4(score),
      evalPassed: score >= Number(task.threshold ?? 0.85) && rules.hardRules.length === 0,
      evalDimensions: dims,
      hardRules: rules.hardRules,
      evalMeta: rules.evalMeta,
      judgeIssues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 8) : [],
      judgeMode: "llm",
      judgeModel: config.model,
      judgeFallback: false
    };
    cache[hash] = result;
    writeCache(cache);
    return result;
  } catch (error) {
    return {
      ...rules,
      judgeMode: "rules-fallback",
      judgeModel: config.model,
      judgeFallback: true,
      judgeError: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildJudgePrompt(task, text) {
  const rubric = Array.isArray(task.rubric) ? task.rubric : [];
  const points = Array.isArray(task.expectedPoints) ? task.expectedPoints : [];
  return [
    `任务：${task.id}（${task.scenario === "topic" ? "选题评审" : "教学设计"}）`,
    `用例输入：${JSON.stringify(task.vars ?? {}, null, 2)}`,
    `必须覆盖的要点：\n${points.map((point, index) => `${index + 1}. ${point}`).join("\n")}`,
    `评分维度：${rubric.join("、")}`,
    "每个维度给 0 到 1 的小数；缺内容、空话、与要点不符要扣分；引用编号与来源列表必须真实对应。",
    '输出 JSON：{"dimensions":{"维度名":0.0},"issues":["问题1"]}',
    `产物正文：\n<<<\n${String(text).slice(0, 12000)}\n>>>`
  ].join("\n\n");
}

function judgeModelConfig() {
  const apiKey = process.env.QWEN_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = (process.env.QWEN_BASE_URL || process.env.OPENAI_BASE_URL || "").replace(/\/$/, "");
  if (!apiKey || !baseUrl) return null;
  return {
    apiKey,
    baseUrl,
    model: process.env.BENCH_JUDGE_MODEL || process.env.QWEN_MODEL || process.env.PLATFORM_LIVE_MODEL || "qwen-plus"
  };
}

function syncPost(url, body, apiKey) {
  const script = [
    "const chunks=[];",
    "process.stdin.on('data',(c)=>chunks.push(c));",
    "process.stdin.on('end',async()=>{",
    "const text=Buffer.concat(chunks).toString('utf8');",
    "const res=await fetch(process.argv[1],{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.BENCH_JUDGE_KEY},body:text});",
    "process.stdout.write(await res.text());",
    "});"
  ].join("");
  const output = execFileSync(process.execPath, ["-e", script, url], {
    input: JSON.stringify(body),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: Number(process.env.BENCH_JUDGE_TIMEOUT_MS || 120000),
    env: { ...process.env, BENCH_JUDGE_KEY: apiKey }
  });
  return JSON.parse(output);
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

function stripCodeFence(value) {
  const text = String(value).trim();
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match ? match[1].trim() : text;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}
