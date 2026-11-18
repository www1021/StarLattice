import { useMemo } from "react";
import { renderMarkdown, streamSafeMarkdown } from "./markdown";
import "./message-markdown.css";

export function MessageMarkdown({
  text,
  className,
  streaming
}: {
  text: string;
  className?: string;
  /** 还在逐字生成：先擦掉半截的 ** / ` / $$，别让星号和美元符号闪出来。 */
  streaming?: boolean;
}) {
  const html = useMemo(
    () => renderMarkdown(streaming ? streamSafeMarkdown(text) : text),
    [text, streaming]
  );
  return (
    <div
      className={`message-markdown${className ? ` ${className}` : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
