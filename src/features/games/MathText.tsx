import { useMemo } from "react";
import { renderInlineMarkdown, renderMarkdown } from "../chat/markdown";
// 副作用导入：把 KaTeX 注册成公式渲染器，题干里的 \frac 才能真排成分数。
import "../chat/katexMath";
import { ensureMathDelimiters } from "./mathSource";

/**
 * 卡片里的文字渲染。题干、选项都夹着公式，
 * 而且比正文短得多，所以默认走行内模式，不套 <p>。
 */
export function MathText({
  text,
  block,
  className
}: {
  text: string;
  /** 独占一行的题干用块级渲染，跟正文排版一致。 */
  block?: boolean;
  className?: string;
}) {
  const html = useMemo(() => {
    const source = ensureMathDelimiters(text);
    return block ? renderMarkdown(source) : renderInlineMarkdown(source);
  }, [text, block]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** 把 LaTeX 式子转成能读的纯文本，用在发给 AI 的消息里（聊天输入框不渲染公式）。 */
export function plainMath(text: string): string {
  return text
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\times/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\sqrt\{([^{}]*)\}/g, "√$1")
    .replace(/\\neq/g, "≠")
    .replace(/\$/g, "")
    .trim();
}
