/**
 * 插件返回给模型的文本。
 *
 * 之前直接拿 `preview`（原始响应截前 1200 字）回灌，OpenAlex 这种一条记录就上千字符的
 * 接口，模型看到的永远是「Principles of Arti...」这种断头标题，于是只能回一句
 * 「内容被截断了，无法给出完整信息」。这里改成按字段投影：题录该有的字段一个不少，
 * 条数按预算砍，而不是从中间一刀切断。
 */

/** 留一点余量给调用方的硬截断（6000），避免省略提示被切掉。 */
const MAX_TEXT_CHARS = 5400;
const MAX_ROWS = 10;
const MAX_TITLE_CHARS = 300;
const MAX_AUTHORS = 5;

/** 有 results 数组、元素带标题和年份的，按题录投影；其余走通用压缩。 */
export function buildPluginResultText(input: {
  detail: unknown;
  preview?: string;
  /** 本次检索词，用来判断是否需要提示换成英文。 */
  query?: string;
}): string {
  const body = formatRecords(input.detail) ?? compactJson(input.detail ?? input.preview ?? "");
  const text = body.trim() || "（插件执行成功，但没有返回可读内容）";
  const hint = nonEnglishHint(input.query);
  return hint ? `${hint}\n\n${text}` : text;
}

/** 识别「一批文献记录」的两种常见形状：OpenAlex 的 results、通用 data/items。 */
function formatRecords(detail: unknown): string | undefined {
  if (!isRecord(detail)) {
    return undefined;
  }
  const rows = firstRecordList(detail);
  if (!rows) {
    return undefined;
  }
  const total = numberValue(detail.meta && isRecord(detail.meta) ? detail.meta.count : undefined);

  const lines: string[] = [
    `检索结果：共 ${total ?? rows.length} 条，本次返回 ${Math.min(rows.length, MAX_ROWS)} 条`
  ];
  if (rows.length === 0) {
    lines.push("没有命中任何记录。可以换更宽的关键词，或改用英文检索词再试。");
    return lines.join("\n");
  }

  // 按预算加，不按条数硬切：一条被拦腰切断，模型就又只能回「内容不完整」。
  let used = lines[0].length;
  let shown = 0;
  for (const row of rows.slice(0, MAX_ROWS)) {
    const block = formatRecord(row, shown + 1);
    const size = block.join("\n").length;
    if (shown > 0 && used + size > MAX_TEXT_CHARS) {
      break;
    }
    lines.push("", ...block);
    used += size;
    shown += 1;
  }
  if (shown < Math.min(rows.length, MAX_ROWS)) {
    lines.push("", `（本轮只列出 ${shown} 条，其余 ${rows.length - shown} 条省略；需要更多可调小 per_page 或缩小检索范围重查）`);
  }
  return lines.join("\n");
}

function firstRecordList(detail: Record<string, unknown>): Record<string, unknown>[] | undefined {
  for (const key of ["results", "data", "items", "works", "records"]) {
    const value = detail[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const records = value.filter(isRecord);
    if (records.length === 0) {
      // 空数组只有学术库的标准字段才算「查到了 0 条」，别把空 items 也说成检索结果。
      if (value.length === 0 && (key === "results" || key === "works" || key === "records")) {
        return [];
      }
      continue;
    }
    // 真有标题字段才按题录展开：{name:"a"} 这种普通对象数组交回压缩 JSON，字段才不会丢。
    if (records.some((row) => stringValue(row.title) || stringValue(row.display_name))) {
      return records;
    }
  }
  return undefined;
}

function formatRecord(row: Record<string, unknown>, index: number): string[] {
  const title = stringValue(row.title) || stringValue(row.display_name) || stringValue(row.name);
  if (!title) {
    return [`${index}. ${compactJson(row).slice(0, 400)}`];
  }
  const lines = [`${index}. ${truncate(title, MAX_TITLE_CHARS)}`];

  const authors = collectAuthors(row);
  if (authors.length > 0) {
    const shown = authors.slice(0, MAX_AUTHORS).join("、");
    lines.push(`   作者：${authors.length > MAX_AUTHORS ? `${shown} 等 ${authors.length} 人` : shown}`);
  }

  const meta: string[] = [];
  const year = numberValue(row.publication_year) ?? numberValue(row.year);
  if (year) {
    meta.push(`年份：${year}`);
  }
  const source = recordSource(row);
  if (source) {
    meta.push(`来源：${source}`);
  }
  const cited = numberValue(row.cited_by_count) ?? numberValue(row.citations);
  if (cited !== undefined) {
    meta.push(`被引：${cited}`);
  }
  const type = stringValue(row.type);
  if (type) {
    meta.push(`类型：${type}`);
  }
  if (meta.length > 0) {
    lines.push(`   ${meta.join(" ｜ ")}`);
  }

  const doi = stringValue(row.doi);
  const link = stringValue(row.id) || stringValue(row.url) || stringValue(row.link);
  const tail: string[] = [];
  if (doi) {
    tail.push(`DOI：${doi}`);
  }
  if (link && link !== doi) {
    tail.push(`链接：${link}`);
  }
  if (tail.length > 0) {
    lines.push(`   ${tail.join(" ｜ ")}`);
  }

  const abstract = stringValue(row.abstract) || abstractFromInvertedIndex(row.abstract_inverted_index);
  if (abstract) {
    lines.push(`   摘要：${truncate(abstract, 600)}`);
  }
  return lines;
}

function collectAuthors(row: Record<string, unknown>): string[] {
  const names: string[] = [];
  const raw = row.authorships ?? row.authors;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === "string") {
        names.push(item);
        continue;
      }
      if (!isRecord(item)) {
        continue;
      }
      const author = isRecord(item.author) ? item.author : item;
      const name = stringValue(author.display_name) || stringValue(author.name);
      if (name) {
        names.push(name);
      }
    }
  }
  return names;
}

function recordSource(row: Record<string, unknown>): string {
  const direct = stringValue(row.journal) || stringValue(row.venue) || stringValue(row.source);
  if (direct) {
    return direct;
  }
  const location = row.primary_location;
  if (isRecord(location)) {
    if (isRecord(location.source)) {
      return (
        stringValue(location.source.display_name) ||
        stringValue(location.source.name) ||
        stringValue(location.landing_page_url) ||
        ""
      );
    }
    return stringValue(location.landing_page_url) || "";
  }
  return "";
}

/** OpenAlex 摘要是可还原的倒排索引，模型看不懂原始对象，展开成句子。 */
function abstractFromInvertedIndex(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const slots: Array<[number, string]> = [];
  for (const [word, positions] of Object.entries(value)) {
    if (!Array.isArray(positions)) {
      continue;
    }
    for (const position of positions) {
      const index = numberValue(position);
      if (index !== undefined) {
        slots.push([index, word]);
      }
    }
  }
  if (slots.length === 0) {
    return "";
  }
  return slots
    .sort((left, right) => left[0] - right[0])
    .map(([, word]) => word)
    .join(" ");
}

/** 中文检索词查英文库基本查不出东西，先提醒模型换关键词，别拿空结果硬凑。 */
function nonEnglishHint(query: string | undefined): string {
  const text = (query ?? "").trim();
  if (!text || !/[\u4e00-\u9fa5]/.test(text)) {
    return "";
  }
  return [
    `提示：本次检索词是中文（${text}），OpenAlex 以英文文献为主，中文检索通常只能命中少量非英文文献。`,
    "请先用英文关键词重新检索（例如「人工智能」→ artificial intelligence），再根据英文结果作答；查不到就说明查不到，不要凭记忆补。"
  ].join("");
}

/** 通用兜底：结构照搬但裁掉长数组、长字符串，保证模型拿到的是完整 JSON 而不是断句。 */
function compactJson(value: unknown, budget = MAX_TEXT_CHARS): string {
  if (typeof value === "string") {
    return truncate(value, budget);
  }
  try {
    const text = JSON.stringify(clip(value, 0), null, 2);
    return truncate(text, budget);
  } catch {
    return truncate(String(value), budget);
  }
}

function clip(value: unknown, depth: number): unknown {
  if (depth > 5) {
    return "…";
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, 12).map((item) => clip(item, depth + 1));
    return value.length > 12 ? [...head, `…共 ${value.length} 项`] : head;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = clip(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return truncate(value, 500);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
