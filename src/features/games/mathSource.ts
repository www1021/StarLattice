/**
 * 出题器给的选项是裸 LaTeX（`\frac{4}{2}`），没有 `$` 包着——题干带 `$`，选项不带。
 * 单独放一个不 import katex 的小模块，服务端测试才跑得起来（katex 的 CSS 只有浏览器认）。
 */

const BARE_TEX = /\\(?:frac|sqrt|times|div|cdot|pm|neq|leq|geq|approx|pi|left|right)\b/;

/**
 * 整串没有 `$` 且确实像公式时才包一层 `$`。
 * 像「2」「3.5」这种纯数字选项不动它——包上会变成公式字体，看着反而怪。
 */
export function ensureMathDelimiters(text: string): string {
  if (!text || text.includes("$")) {
    return text;
  }
  return BARE_TEX.test(text) ? `$${text.trim()}$` : text;
}
