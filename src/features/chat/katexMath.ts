/**
 * 把 KaTeX 接到聊天正文的公式记号上（`$...$` / `$$...$$` / `\(...\)` / `\[...\]`）。
 *
 * katex 只在这里 import：markdown.ts 自己不依赖它，服务端跑渲染测试、
 * 或者脚本里调 renderMarkdown 时仍走纯文本排版，不会把 280KB 的脚本拽进 Node。
 */
import katex from "katex";
import "katex/dist/katex.min.css";
import { setMathRenderer } from "./markdown";

/**
 * 流式输出时每来一段字都会整篇重排，同一个公式会被反复要求渲染。
 * 按「行内/块级 + TeX」缓存结果，公式没变就直接复用上一份 HTML。
 */
const cache = new Map<string, string>();
const CACHE_LIMIT = 400;

setMathRenderer((tex, displayMode) => {
  const key = `${displayMode ? "d" : "i"}:${tex}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    return hit;
  }
  try {
    const html = katex.renderToString(tex, {
      displayMode,
      // 写错就抛错，由外层退回纯文本：一处语法错不该在正文里印一坨红字。
      throwOnError: true,
      // 中文里夹公式时模型常写全角括号、×，KaTeX 默认会警告，这里放行。
      strict: "ignore",
      // \href、\html 这类能注入标记的命令一律不许用。
      trust: false,
      // 公式里塞 \rule{999em} 能把版面撑爆，给个上限。
      maxSize: 16,
      maxExpand: 400
    });
    if (cache.size >= CACHE_LIMIT) {
      cache.clear();
    }
    cache.set(key, html);
    return html;
  } catch {
    // 不是真公式（比如「$100 到 $200」这种价格），交回纯文本。
    return null;
  }
});
