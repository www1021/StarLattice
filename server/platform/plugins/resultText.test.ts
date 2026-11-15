import assert from "node:assert/strict";
import test from "node:test";
import { buildPluginResultText } from "./resultText.js";

/** 造一条 OpenAlex 形状的记录：真实响应的关键字段都在。 */
function paper(index: number, title = `A Complete Paper Title Number ${index}`) {
  return {
    id: `https://openalex.org/W${index}`,
    doi: `https://doi.org/10.1000/demo-${index}`,
    title,
    display_name: title,
    publication_year: 2024,
    cited_by_count: 100 + index,
    type: "article",
    authorships: [
      { author: { display_name: "Alice Zhang" } },
      { author: { display_name: "Bob Li" } }
    ],
    primary_location: { source: { display_name: "Nature Machine Intelligence" } },
    // 真实题录带摘要，一条就接近千字；预算不够时应该整条省略。
    abstract: `Abstract ${"large language model survey ".repeat(20)}`
  };
}

test("题录按字段完整展开，标题不会被拦腰截断", () => {
  const title = "Principles of Artificial Intelligence: A Comprehensive Survey of Methods";
  const text = buildPluginResultText({
    detail: { meta: { count: 42 }, results: [paper(1, title)] },
    query: "artificial intelligence"
  });

  assert.match(text, /共 42 条/);
  // 以前的 bug：只给模型 1200 字原始 JSON，标题停在 “Principles of Arti...”。
  assert.ok(text.includes(title), "完整标题应该在结果里");
  assert.match(text, /Alice Zhang、Bob Li/);
  assert.match(text, /年份：2024/);
  assert.match(text, /来源：Nature Machine Intelligence/);
  assert.match(text, /被引：101/);
  assert.match(text, /DOI：https:\/\/doi.org\/10.1000\/demo-1/);
});

test("条数超出预算时整条省略，不会把某一条切成半截", () => {
  const results = Array.from({ length: 10 }, (_, index) => paper(index + 1));
  const text = buildPluginResultText({ detail: { results }, query: "demo" });

  assert.ok(text.length <= 6000, `文本不应超过工具上限，实际 ${text.length}`);
  assert.match(text, /条省略/);
  // 每一条都以编号开头、以 DOI 结尾，说明没有半条记录。
  const blocks = text.split("\n\n").filter((block) => /^\d+\. /.test(block));
  assert.ok(blocks.length >= 1);
  for (const block of blocks) {
    assert.match(block, /DOI：/);
  }
});

test("中文检索词会提示换成英文再查", () => {
  const text = buildPluginResultText({
    detail: { results: [] },
    query: "人工智能"
  });

  assert.match(text, /本次检索词是中文/);
  assert.match(text, /artificial intelligence/);
  assert.match(text, /没有命中任何记录/);
});

test("英文检索词不附加提示", () => {
  const text = buildPluginResultText({ detail: { results: [] }, query: "large language model" });
  assert.doesNotMatch(text, /本次检索词是中文/);
});

test("不认识的结构退回压缩 JSON，保证模型拿到的是完整对象", () => {
  const text = buildPluginResultText({
    detail: { temperature: 21, status: "ok", items: [{ name: "a" }] },
    query: ""
  });

  assert.match(text, /"temperature": 21/);
  assert.match(text, /"status": "ok"/);
});

test("拿不到结构化结果时退回 preview 文本，不会返回空", () => {
  const text = buildPluginResultText({ detail: undefined, preview: "纯文本结果" });
  assert.match(text, /纯文本结果/);
});
