/**
 * 聊天正文的轻量 Markdown 渲染。
 *
 * 只做「模型实际会写」的那几样：标题、列表、表格、引用、代码块、分割线，
 * 行内加粗/斜体/行内代码/链接。不引第三方解析器——一是体积，二是这些内容
 * 全部来自模型输出，必须自己转义，不能把 HTML 直接塞进 DOM。
 */

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPE[char]);
}

/**
 * 数学片段：数字/字母用运算符连起来的组合，比如 `(3 + 5) × 4`、`a × c + b × c`。
 * 这类内容混在中文里换行会被从中间劈开（`3×4 +` / `5×4`），是「看起来乱」的主要来源，
 * 所以要单独包一层，给它们不折行的排版。
 */
const MATH_TERM = String.raw`[（(]?\s*(?:\d+(?:\.\d+)?|[a-zA-Zα-ωΑ-Ω])[\s)）]*`;
const MATH_OP = String.raw`\s*[+\-×÷=<>≤≥≠≈±/]\s*`;
const MATH_CHUNK = new RegExp(`${MATH_TERM}(?:${MATH_OP}${MATH_TERM}){1,5}`, "g");

/**
 * 真正的公式排版。前端注册 KaTeX 后，`$...$` 这类记号会排成分数、根号、上下标；
 * 没注册（服务端测试、或脚本里跑渲染）就退回纯文本排版，行为跟以前一致。
 */
export type MathRenderer = (tex: string, displayMode: boolean) => string | null;

let mathRenderer: MathRenderer | null = null;

/** 由前端注入公式渲染器。传 null 恢复纯文本排版。 */
export function setMathRenderer(renderer: MathRenderer | null): void {
  mathRenderer = renderer;
}

/**
 * 数学模式排不了中文。`$100 到 200$` 这种其实是价格，硬排出来是一串怪字形，
 * 直接说不认识、退回纯文本更稳。`\text{米}` 里的中文是合法的，检查前先摘掉。
 */
const CJK_IN_MATH = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const TEXT_WRAPPER = /\\text\{[^{}]*\}/g;

/** 渲染一段 TeX；渲染器不在或这段根本不是公式（KaTeX 抛错）时返回 null。 */
function renderMath(tex: string, displayMode: boolean): string | null {
  const source = tex.trim();
  if (!source || !mathRenderer) return null;
  if (CJK_IN_MATH.test(source.replace(TEXT_WRAPPER, ""))) return null;
  try {
    return mathRenderer(source, displayMode);
  } catch {
    return null;
  }
}

/** 行内公式：能真排就真排，排不了原样显示，别把半截记号吞掉。 */
function inlineMath(tex: string, displayMode = false): string {
  const html = renderMath(tex, displayMode);
  if (html) {
    return `<span class="md-math-inline">${html}</span>`;
  }
  return `<span class="md-math">${escapeHtml(tex.trim())}</span>`;
}

/** 行内格式。先抽走代码/链接/公式，再整体转义，最后只加我们自己生成的标签。 */
function inline(raw: string): string {
  const slots: string[] = [];
  const hold = (html: string) => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };

  let text = raw;

  // 行内代码先抽出来，避免里面的 * 被当成加粗、公式识别也不该钻进去。
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    return hold(`<code class="md-inline-code">${escapeHtml(code)}</code>`);
  });

  // 链接也先抽走：URL 里的 / 和字母会被后面的公式识别误伤。
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, href: string) =>
      hold(
        `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(
          label
        )}</a>`
      )
  );

  // 显式公式：$...$、\(...\)、\[...\]。必须放在转义之前抽——
  // TeX 里的 < > & 一转义就解析不了了（`$a < b$`）。
  text = text.replace(/\$\$([\s\S]{1,400}?)\$\$/g, (_match, body: string) =>
    hold(inlineMath(body, true))
  );
  text = text.replace(/\$([^$\n]{1,200})\$/g, (_match, body: string) => hold(inlineMath(body)));
  text = text.replace(/\\\(([^)\n]{1,200})\\\)/g, (_match, body: string) => hold(inlineMath(body)));
  text = text.replace(/\\\[([^\]\n]{1,300})\\\]/g, (_match, body: string) =>
    hold(inlineMath(body, true))
  );

  text = escapeHtml(text);

  // 没标记的算式也要稳住：认得出来就包成公式，太长的不锁行，免得撑破一列。
  text = text.replace(MATH_CHUNK, (match) => {
    const body = match.trim();
    if (body.length < 3) return match;
    // 只靠一个等号连着的字母串（`src=x`、`c=x`）多半是代码或英文，不当公式；
    // 要有数字，或者 × ÷ ≤ ≥ 这种真·数学符号才算。
    if (!/\d/.test(body) && !/[×÷≤≥≈±√]/.test(body)) return match;
    const wrap = body.length > 22 ? " md-math-wrap" : "";
    return hold(`<span class="md-math${wrap}">${body}</span>`);
  });

  text = text.replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  // 模型偶尔用 __强调__ 这种写法，一起收掉。
  text = text.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");

  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
    return slots[Number(index)] ?? "";
  });
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const FENCE = /^\s{0,3}```/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SPLIT = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/;
/** 模型很爱用中文方括号当小标题：【题意与缺的条件】【错因定位】。 */
const KICKER = /^\s*【([^】\n]{1,30})】\s*(.*)$/;
/** 箭头开头的行是分步说明，按步骤排，别混在段落里。 */
const ARROW = /^\s*(→|⇒|➜|➔)\s*(.*)$/;
/** 块级公式：$$ ... $$，单行或跨行都可能。 */
const MATH_BLOCK = /^\s*\$\$/;

function isBlockStart(line: string): boolean {
  return (
    FENCE.test(line) ||
    MATH_BLOCK.test(line) ||
    HEADING.test(line) ||
    KICKER.test(line) ||
    ARROW.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    TABLE_ROW.test(line) ||
    LIST_ITEM.test(line)
  );
}

/** 表格：只认 `| a | b |` 这种管道风格，首行表头 + 分隔行。 */
function renderTable(rows: string[]): string {
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  const headHtml = head.map((cell) => `<th>${inline(cell)}</th>`).join("");
  const bodyHtml = body
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
    .join("");

  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

/** 列表：按缩进认嵌套，够用了，再深的模型也很少写。 */
function renderList(items: Array<{ indent: number; ordered: boolean; text: string }>): string {
  let out = "";
  const stack: Array<{ indent: number; ordered: boolean }> = [];

  for (const item of items) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (item.indent > top.indent) {
        break;
      }
      // 同级或更浅：先收掉当前这一项，再决定是继续同层还是往上退。
      out += "</li>";
      if (item.indent < top.indent) {
        out += top.ordered ? "</ol>" : "</ul>";
        stack.pop();
        continue;
      }
      if (top.ordered !== item.ordered) {
        out += top.ordered ? "</ol>" : "</ul>";
        stack.pop();
      }
      break;
    }

    const parent = stack[stack.length - 1];
    if (!parent || item.indent > parent.indent) {
      out += item.ordered ? "<ol>" : "<ul>";
      stack.push({ indent: item.indent, ordered: item.ordered });
    }
    out += `<li>${inline(item.text)}`;
  }

  while (stack.length > 0) {
    out += "</li>";
    const top = stack.pop()!;
    out += top.ordered ? "</ol>" : "</ul>";
  }

  return out;
}

/**
 * 行内渲染：游戏卡片里的题干、选项都是半行文字，套一层 <p> 会把格子撑开。
 * 只走 inline()，模型自己写的换行用 <br /> 保留。
 */
export function renderInlineMarkdown(source: string): string {
  return inline(source.replace(/\r\n?/g, "\n")).replace(/\n/g, "<br />");
}

export function renderMarkdown(source: string): string {  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (FENCE.test(line)) {
      const fence = line.trim().replace(/^`+/, "");
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      html.push(
        `<pre class="md-pre"${
          fence ? ` data-lang="${escapeHtml(fence)}"` : ""
        }><code>${escapeHtml(body.join("\n"))}</code></pre>`
      );
      continue;
    }

    if (RULE.test(line)) {
      html.push('<hr class="md-rule" />');
      index += 1;
      continue;
    }

    // 块级公式：整段独立排，居中、不跟正文挤在一行。
    if (MATH_BLOCK.test(line)) {
      let tex = "";
      const single = /^\s*\$\$(.+?)\$\$\s*$/.exec(line);
      if (single) {
        tex = single[1].trim();
        index += 1;
      } else {
        const body: string[] = [];
        index += 1;
        while (index < lines.length && !MATH_BLOCK.test(lines[index])) {
          body.push(lines[index]);
          index += 1;
        }
        index += 1;
        tex = body.join("\n").trim();
      }
      const rendered = renderMath(tex, true);
      html.push(
        rendered
          ? `<div class="md-math-block md-math-rendered">${rendered}</div>`
          : `<div class="md-math-block">${escapeHtml(tex)}</div>`
      );
      continue;
    }

    // 中文方括号小标题：独占一段，带一点层级感。
    const kicker = KICKER.exec(line);
    if (kicker) {
      html.push(`<p class="md-kicker">${inline(kicker[1].trim())}</p>`);
      const rest = kicker[2].trim();
      if (rest) html.push(`<p class="md-p">${inline(rest)}</p>`);
      index += 1;
      continue;
    }

    // 箭头步骤：一行一步，符号单独一列，读起来是对齐的。
    if (ARROW.test(line)) {
      const rows: string[] = [];
      while (index < lines.length && ARROW.test(lines[index])) {
        const match = ARROW.exec(lines[index])!;
        rows.push(
          `<div class="md-step"><span class="md-step-mark">${match[1]}</span><span class="md-step-text">${inline(
            match[2]
          )}</span></div>`
        );
        index += 1;
      }
      html.push(`<div class="md-steps">${rows.join("")}</div>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1].length + 2);
      html.push(`<h${level} class="md-heading">${inline(heading[2].trim())}</h${level}>`);
      index += 1;
      continue;
    }

    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_SPLIT.test(lines[index + 1])) {
      const rows: string[] = [];
      while (index < lines.length && TABLE_ROW.test(lines[index])) {
        rows.push(lines[index]);
        index += 1;
      }
      html.push(renderTable(rows));
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoted.push(lines[index].replace(QUOTE, ""));
        index += 1;
      }
      html.push(`<blockquote class="md-quote">${inline(quoted.join("\n")).replace(/\n/g, "<br />")}</blockquote>`);
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const items: Array<{ indent: number; ordered: boolean; text: string }> = [];
      while (index < lines.length && LIST_ITEM.test(lines[index])) {
        const match = LIST_ITEM.exec(lines[index])!;
        items.push({
          indent: Math.floor(match[1].replace(/\t/g, "  ").length / 2),
          ordered: /\d/.test(match[2]),
          text: match[3].trim()
        });
        index += 1;
      }
      html.push(`<div class="md-list">${renderList(items)}</div>`);
      continue;
    }

    // 普通段落：连续非空、且不是其他块起始的行，用 <br /> 保留模型自己的断行。
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    if (paragraph.length > 0) {
      html.push(`<p class="md-p">${inline(paragraph.join("\n")).replace(/\n/g, "<br />")}</p>`);
      continue;
    }

    // 兜底：认不出的行原样输出，避免死循环。
    html.push(`<p class="md-p">${inline(line.trim())}</p>`);
    index += 1;
  }

  return html.join("");
}

/**
 * 流式预览用的「半截记号清理」。逐块往外放的时候，** 或 ``` 常常只出了一半，
 * 直接渲染会把星号原样显示，未闭合的栅栏还会把后面整段吞进代码块。
 * 把最后一个未闭合的记号擦掉，等它配对后再交回 renderMarkdown 正常排版。
 */
export function streamSafeMarkdown(source: string): string {
  let safe = source;
  if ((safe.match(/^\s*```/gm) ?? []).length % 2 === 1) {
    const last = safe.lastIndexOf("```");
    safe = safe.slice(0, last) + safe.slice(last + 3);
  }
  // 块级公式只写了一半：连内容一起先藏起来，等闭合后一次排出来。
  // 只摘掉 $$ 的话，`\frac{1}{2}` 会以源码形态在屏幕上一闪。
  if ((safe.match(/\$\$/g) ?? []).length % 2 === 1) {
    safe = safe.slice(0, safe.lastIndexOf("$$"));
  }
  if ((safe.match(/\*\*/g) ?? []).length % 2 === 1) {
    const last = safe.lastIndexOf("**");
    safe = safe.slice(0, last) + safe.slice(last + 2);
  }
  if ((safe.match(/`/g) ?? []).length % 2 === 1) {
    const last = safe.lastIndexOf("`");
    safe = safe.slice(0, last) + safe.slice(last + 1);
  }
  return truncateOpenInlineMath(safe);
}

/**
 * 行内公式写了一半（`$\frac{a}{`）同样先藏起来。
 * 但只有一个落单的「$100」时不能藏——那会把后面半段正文一起吞掉，
 * 所以要求残段里确实有 TeX 痕迹（\ ^ _ { }）才动手。
 */
function truncateOpenInlineMath(source: string): string {
  // 成对的 $$ 已在上一步摘掉；这里把遗留的替换掉，避免把 $$ 当单个 $ 数。
  const scan = source.replace(/\$\$/g, "\u0001\u0001");
  if ((scan.match(/\$/g) ?? []).length % 2 === 0) {
    return source;
  }
  const index = scan.lastIndexOf("$");
  const tail = source.slice(index + 1);
  if (!/[\\^_{}]/.test(tail) || tail.length > 200) {
    return source;
  }
  return source.slice(0, index);
}
