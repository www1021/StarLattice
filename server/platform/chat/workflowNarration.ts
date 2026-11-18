/**
 * 把工作流节点产物压成一句给人看的中文，供聊天区「边跑边说」。
 *
 * 只做展示：从节点 output 里挑最关键的字段（档位、目标、活动、问题等），
 * 拼成短句。解析失败就退回通用句式，绝不把整段 JSON 倒进正文。
 */

type Excerpt = Record<string, unknown>;

function asRecord(value: unknown): Excerpt | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Excerpt)
    : undefined;
}

function parseExcerpt(raw: string | undefined): Excerpt | undefined {
  if (!raw) return undefined;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** 节点产物常被 executor 包一层 {output:{...}}，这里取真正的业务载荷。 */
function payload(record: Excerpt | undefined): Excerpt | undefined {
  if (!record) return undefined;
  const inner = asRecord(record.output);
  return inner ?? record;
}

function countField(record: Excerpt | undefined, key: string): number | undefined {
  const value = record?.[key];
  return Array.isArray(value) ? value.length : undefined;
}

function firstText(record: Excerpt | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * 只负责流程、不产出内容的节点：播报了反而是一堆「开始」「条件判断」的流水账。
 * 并行/子流程本身是用户能理解的一步（「三路并行命题」），保留。
 */
const SILENT_KINDS = new Set(["start", "end", "condition", "loop"]);

/** 节点标题里的流程术语，念出来太生硬，播报前抹掉。 */
function humanTitle(title: string): string {
  return title.replace(/(子流程|子工作流|节点)$/u, "").trim() || title;
}

/**
 * 节点开跑时的一句话：「正在课标检索…」。
 * 只交代在做什么，不带工具端点、耗时、状态字。
 */
export function narrateStepRunning(kind: string, title: string): string {
  if (SILENT_KINDS.has(kind)) return "";
  return `正在${humanTitle(title)}…`;
}

/** 节点失败时的一句话：说清哪一步卡了，别把堆栈甩给用户。 */
export function narrateStepFailure(kind: string, title: string, error?: string): string {
  if (SILENT_KINDS.has(kind)) return "";
  const detail = (error ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return detail
    ? `${humanTitle(title)}这步卡住了：${detail}，我先用已有的部分往下走。`
    : `${humanTitle(title)}这步没跑通，我先用已有的部分往下走。`;
}

/**
 * 节点跑完、但产物里没有能给用户看的要点时，至少给个收尾句。
 * 否则上面那行「正在…」会一直悬着，看起来像卡住了。
 */
export function narrateStepSettled(kind: string, title: string): string {
  if (SILENT_KINDS.has(kind)) return "";
  return `${humanTitle(title)}完成。`;
}

/** 工具摘要里常见的技术串：MCP 服务器名、函数名、毫秒耗时。这些不出现在人话里。 */
const TECH_SUMMARY = /(?:ms）|\d+\s*ms|MCP|_search|\.search|·)/i;

/**
 * 一句话播报节点结果。标题由调用方给出（工作流 DSL 里写好的 title）。
 * 返回空串表示这个节点没什么可说的（开始/结束、或产物只有技术串），调用方跳过即可。
 */
export function narrateNodeResult(
  nodeId: string,
  title: string,
  rawExcerpt?: string,
  kind?: string
): string {
  if (kind && SILENT_KINDS.has(kind)) return "";
  const data = payload(parseExcerpt(rawExcerpt));
  if (!data) return "";

  // 知识库检索：说清翻了什么、有没有翻到，别把 query 原样倒出来。
  const citations = countField(data, "citations");
  if (citations !== undefined) {
    const query = firstText(data, ["query", "topic"]) ?? "";
    const short = query.replace(/\s+/g, " ").slice(0, 16);
    const where = short ? `「${short}」` : "资料";
    return citations > 0
      ? `在${where}里翻到 ${citations} 条可用依据。`
      : `${where}没有现成依据，我按学科常识继续，答案里会说明这点。`;
  }

  // 校验类：通过 / 未通过，附问题数。
  const passed = data.passed;
  if (typeof passed === "boolean") {
    const issues = countField(data, "issues");
    return passed
      ? "方案校验通过，可以继续。"
      : `方案校验发现 ${issues ?? 1} 处问题，正在自动修订。`;
  }

  // 分层档位（学情档案子流）。
  const tiers = countField(data, "tiers");
  const misconceptions = countField(data, "misconceptions");
  if (tiers !== undefined || misconceptions !== undefined) {
    const parts: string[] = [];
    if (tiers !== undefined) parts.push(`学情分成 ${tiers} 档`);
    if (misconceptions !== undefined) parts.push(`锁定 ${misconceptions} 个易错点`);
    return parts.length ? `${parts.join("，")}。` : "";
  }

  // 教学目标。
  const objectives = countField(data, "objectives");
  if (objectives !== undefined) return `拆出 ${objectives} 条可观测教学目标。`;

  // 课堂活动。
  const activities = countField(data, "activities");
  if (activities !== undefined) {
    const minutes = data.minutesSum ?? data.totalMinutes;
    const suffix = typeof minutes === "number" ? `，合计 ${minutes} 分钟` : "";
    return `排出 ${activities} 个课堂环节${suffix}。`;
  }

  // 分层评价题目。同一个 items 字段在细目表节点里指的是「条目」不是「题目」。
  const items = countField(data, "items");
  if (items !== undefined) {
    if (/细目|双向表|蓝图/u.test(title)) return `把细目表拆成 ${items} 条。`;
    return `出了 ${items} 道分层评价题，附评分要点。`;
  }

  // 错因诊断。
  const category = firstText(data, ["category", "rootCause", "type"]);
  if (category) return `错因判定为「${category}」，已写明依据。`;

  // 安全风险分级：等级 + 禁止动作，这是确定性工具结果，必须原样播报。
  const level = firstText(data, ["level", "riskLevel", "severity"]);
  if (level) {
    return `风险等级判定为${level}，处置动作已按规则生成。`;
  }

  // 兜底：只有在产物本身是给用户看的一句话时才念，技术串一律不念。
  const summary = firstText(data, ["summary", "message", "text"]);
  if (summary && !TECH_SUMMARY.test(summary)) {
    const flat = summary.replace(/\s+/g, " ").slice(0, 60);
    return `${flat}${summary.length > 60 ? "…" : ""}`;
  }
  return "";
}
