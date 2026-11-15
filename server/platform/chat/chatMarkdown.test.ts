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
