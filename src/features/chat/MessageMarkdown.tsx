import { useMemo } from "react";
import { renderMarkdown } from "./markdown";
import "./message-markdown.css";

export function MessageMarkdown({
  text,
  className
}: {
  text: string;
  className?: string;
}) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={`message-markdown${className ? ` ${className}` : ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
