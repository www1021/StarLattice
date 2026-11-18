import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown, streamSafeMarkdown } from "../../../src/features/chat/markdown.js";

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

test("流式时半截的 $$ 先摘掉，别把整段吞成公式块", () => {
  assert.equal(streamSafeMarkdown("结论是\n\n$$(a + b) × c"), "结论是\n\n(a + b) × c");
  assert.equal(
    streamSafeMarkdown("$$a × c + b × c$$"),
    "$$a × c + b × c$$"
  );
});
