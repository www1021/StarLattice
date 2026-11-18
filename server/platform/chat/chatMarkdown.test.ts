import assert from "node:assert/strict";
import test from "node:test";
import {
  renderMarkdown,
  setMathRenderer,
  streamSafeMarkdown
} from "../../../src/features/chat/markdown.js";

test("加粗与分割线：模型爱写的 **…** 和 --- 都能转成标签", () => {
  const html = renderMarkdown("**第一步：先画地图**\n\n---\n\n正文");
  assert.match(html, /<strong>第一步：先画地图<\/strong>/);
  assert.match(html, /<hr class="md-rule" \/>/);
  assert.equal((html.match(/\*\*/g) ?? []).length, 0);
});

test("表格：管道语法转成 table，不再把 | 当正文吐出来", () => {
  const html = renderMarkdown(
    ["| 层级 | 目的 |", "| --- | --- |", "| **顶层** | 找综述 |", "| 中层 | 找方法 |"].join("\n")
  );
  assert.match(html, /<table class="md-table">/);
  assert.match(html, /<th>层级<\/th>/);
  assert.equal((html.match(/\|/g) ?? []).length, 0);
});

test("列表：同级、嵌套、有序各归各位", () => {
  const html = renderMarkdown("- 一\n  - 一之一\n- 二\n\n1. 甲\n2. 乙");
  assert.equal((html.match(/<ul>/g) ?? []).length, 2);
  assert.equal((html.match(/<\/ul>/g) ?? []).length, 2);
  assert.equal((html.match(/<ol>/g) ?? []).length, 1);
  assert.equal((html.match(/<li>/g) ?? []).length, 5);
  assert.equal((html.match(/<\/li>/g) ?? []).length, 5);
});

test("代码块与行内代码：代码里的星号不当加粗", () => {
  const html = renderMarkdown("```ts\nconst a = **b;\n```\n\n行内 `x ** y` 不解析");
  assert.match(html, /<pre class="md-pre" data-lang="ts"><code>const a = \*\*b;<\/code><\/pre>/);
  assert.match(html, /<code class="md-inline-code">x \*\* y<\/code>/);
  assert.equal((html.match(/<strong>/g) ?? []).length, 0);
});

test("安全：模型输出里的 HTML 一律转义，不能变成标签", () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("流式渲染：半截表格和半截加粗不抛错", () => {
  assert.doesNotThrow(() => renderMarkdown("| 层级 | 目的 |\n| --- |"));
  assert.doesNotThrow(() => renderMarkdown("**还没写完"));
  assert.doesNotThrow(() => renderMarkdown("```ts\nconst a = 1"));
});

test("引用与标题不再以符号形式出现", () => {
  const html = renderMarkdown("### 小标题\n\n> 引一句");
  assert.match(html, /<h5 class="md-heading">小标题<\/h5>/);
  assert.match(html, /<blockquote class="md-quote">引一句<\/blockquote>/);
});

test("流式预览：未闭合的 ** / ` / ``` 先擦掉，配对后原样交回渲染", () => {
  assert.equal(streamSafeMarkdown("这是 **还没写完"), "这是 还没写完");
  assert.equal(streamSafeMarkdown("这是 **加粗** 完成"), "这是 **加粗** 完成");
  assert.equal(streamSafeMarkdown("行内 `code"), "行内 code");
  assert.equal(streamSafeMarkdown("```ts\nconst a = 1"), "ts\nconst a = 1");
  assert.equal(
    renderMarkdown(streamSafeMarkdown("这是 **还没写完")),
    '<p class="md-p">这是 还没写完</p>'
  );
  assert.match(renderMarkdown("这是 **加粗** 完成"), /<strong>加粗<\/strong>/);
});

test("中文方括号当小标题：独占一段，不再混在正文里", () => {
  const html = renderMarkdown("【题意与缺的条件】\n先说结论。\n\n【错因定位】符号脱节。");
  assert.equal((html.match(/class="md-kicker"/g) ?? []).length, 2);
  assert.match(html, /<p class="md-kicker">题意与缺的条件<\/p>/);
  assert.match(html, /<p class="md-p">先说结论。<\/p>/);
  // 同一行「标题 + 正文」也要拆开
  const inlineKicker = renderMarkdown("【答】可以这样切。");
  assert.match(inlineKicker, /<p class="md-kicker">答<\/p>/);
  assert.match(inlineKicker, /<p class="md-p">可以这样切。<\/p>/);
});

test("箭头步骤：一行一步，符号单独一列", () => {
  const html = renderMarkdown("→ 点方向：先别写算式\n→ 给方法：把动作写成一句话\n\n收尾。");
  assert.equal((html.match(/class="md-step"/g) ?? []).length, 2);
  assert.match(html, /<span class="md-step-mark">→<\/span>/);
  assert.match(html, /<p class="md-p">收尾。<\/p>/);
});

test("算式不被换行劈开：认得出来的算式包成公式", () => {
  const html = renderMarkdown("比如 (3 + 5) × 4 和 3×4 + 5×4 结果一样。");
  assert.match(html, /<span class="md-math">\(3 \+ 5\) × 4<\/span>/);
  assert.match(html, /<span class="md-math">3×4 \+ 5×4<\/span>/);
  // 中文不该被吞进去
  assert.equal((html.match(/[\u4e00-\u9fff]{1,}<\/span>/g) ?? []).length, 0);
});

test("显式公式标记优先，长的算式不锁行", () => {
  assert.match(renderMarkdown("当 $a × c + b × c$ 成立时"), /<span class="md-math">a × c \+ b × c<\/span>/);
  assert.match(renderMarkdown("$$(a + b) × c = a × c + b × c$$"), /<div class="md-math-block">/);
  assert.match(
    renderMarkdown("$$\\frac{a}{b} + \\frac{c}{d}$$"),
    /<div class="md-math-block">\\frac\{a\}\{b\} \+ \\frac\{c\}\{d\}<\/div>/
  );
  // 超过 22 字符：允许折行，避免撑破正文一列
  const long = renderMarkdown("(12 + 34) × (56 + 78) = 90 × 134 = 12060 的结果");
  assert.match(long, /md-math md-math-wrap/);
});

test("公式与代码互不干扰", () => {
  const html = renderMarkdown("行内 `a × b` 是代码，不当公式");
  assert.match(html, /<code class="md-inline-code">a × b<\/code>/);
  assert.equal((html.match(/class="md-math"/g) ?? []).length, 0);
});

test("流式时半截的公式先藏起来，闭合后再交回排版", () => {
  // 块级公式没写完：连内容一起藏，免得 \frac 的源码在屏幕上闪一下
  assert.equal(streamSafeMarkdown("结论是\n\n$$\\frac{a}{"), "结论是\n\n");
  assert.equal(streamSafeMarkdown("$$a × c + b × c$$"), "$$a × c + b × c$$");
  // 行内公式没写完，同样先不显示
  assert.equal(streamSafeMarkdown("当 $\\frac{a}{2} 时"), "当 ");
  // 落单的美元符号（价格）不能连累后文
  assert.equal(streamSafeMarkdown("价格 $100 到 200"), "价格 $100 到 200");
});

test("注册公式渲染器后走真排版：行内、块级、排不了就退回纯文本", () => {
  const calls: Array<[string, boolean]> = [];
  setMathRenderer((tex, displayMode) => {
    calls.push([tex, displayMode]);
    // 真 KaTeX 碰到写错的语法会抛错，这里用 null 模拟同一条退路。
    if (tex.includes("bad")) return null;
    return `<span class="katex">${tex}</span>`;
  });
  try {
    const inline = renderMarkdown("勾股定理 $a^2 + b^2 = c^2$ 成立");
    assert.match(
      inline,
      /<span class="md-math-inline"><span class="katex">a\^2 \+ b\^2 = c\^2<\/span><\/span>/
    );
    assert.deepEqual(calls[0], ["a^2 + b^2 = c^2", false]);

    const block = renderMarkdown("$$\\frac{1}{2}$$");
    assert.match(block, /<div class="md-math-block md-math-rendered">/);
    assert.equal(calls[calls.length - 1][1], true);

    const fallback = renderMarkdown("$\\bad$");
    assert.match(fallback, /<span class="md-math">\\bad<\/span>/);
  } finally {
    setMathRenderer(null);
  }
});

test("公式里夹中文不硬排（价格、单位写成中文），\\text{} 里的中文除外", () => {
  const seen: string[] = [];
  setMathRenderer((tex) => {
    seen.push(tex);
    return '<span class="katex"></span>';
  });
  try {
    assert.match(renderMarkdown("价格是 $100 到 200$ 之间"), /<span class="md-math">100 到 200<\/span>/);
    assert.deepEqual(seen, []);

    renderMarkdown("长度 $5\\text{米}$ 左右");
    assert.deepEqual(seen, ["5\\text{米}"]);
  } finally {
    setMathRenderer(null);
  }
});

test("TeX 里的尖括号与 & 先于转义交给渲染器，否则公式解析不了", () => {
  const seen: string[] = [];
  setMathRenderer((tex) => {
    seen.push(tex);
    return '<span class="katex"></span>';
  });
  try {
    renderMarkdown("当 $a < b$ 且 $x & y$ 时");
    assert.deepEqual(seen, ["a < b", "x & y"]);
  } finally {
    setMathRenderer(null);
  }
});
