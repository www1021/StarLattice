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
 * 一句话播报节点结果。标题由调用方给出（工作流 DSL 里写好的 title）。
 * 返回空串表示这个节点没什么可说的（如开始/结束节点），调用方跳过即可。
 */
export function narrateNodeResult(nodeId: string, title: string, rawExcerpt?: string): string {
  const data = payload(parseExcerpt(rawExcerpt));
  if (!data) return "";

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

  // 分层评价题目。
  const items = countField(data, "items");
  if (items !== undefined) return `出了 ${items} 道分层评价题，附评分要点。`;

  // 错因诊断。
  const category = firstText(data, ["category", "rootCause", "type"]);
  if (category) return `错因判定为「${category}」，已写明依据。`;

  // 安全风险分级：等级 + 禁止动作，这是确定性工具结果，必须原样播报。
  const level = firstText(data, ["level", "riskLevel", "severity"]);
  if (level) {
    return `风险等级判定为${level}，处置动作已按规则生成。`;
  }

  // 兜底：节点自己的标题 + 状态，不再展开内容。
  const summary = firstText(data, ["summary", "message", "text"]);
  if (summary) {
    const flat = summary.replace(/\s+/g, " ").slice(0, 60);
    return `${title}完成：${flat}${summary.length > 60 ? "…" : ""}`;
  }
  return `${title}完成。`;
}
