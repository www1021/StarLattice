import {
  observeGeneration,
  summarizeMessages,
  summarizeText
} from "./observability.js";

export type ChatRole = "user" | "assistant";

export type TextContentBlock = {
  type: "text";
  text: string;
};

export type ImageContentBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

export type MessageContent = string | Array<TextContentBlock | ImageContentBlock>;

export type ChatMessage = {
  role: ChatRole;
  content: MessageContent;
};

export type StreamChatOptions = {
  messages: ChatMessage[];
  enableThinking?: boolean;
  signal?: AbortSignal;
  onDelta: (content: string) => void;
  onThinkingDelta: (content: string) => void;
};

type AnthropicStreamEvent = {
  type?: string;
  content_block?: {
    type?: string;
    thinking?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    reasoning_content?: string;
  };
  error?: {
    message?: string;
  };
};

export type StreamMimoAnthropicResult = {
  rawAssistantContent: string;
  visibleAssistantContent: string;
  artifactRequests: unknown[];
};

const DEFAULT_BASE_URL = "https://token-plan-cn.xiaomimimo.com/anthropic";
const DEFAULT_MODEL = "mimo-v2.5";

export class UpstreamModelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "UpstreamModelError";
  }
}

export async function streamMimoAnthropicChat({
  messages,
  enableThinking = false,
  signal,
  onDelta,
  onThinkingDelta
}: StreamChatOptions): Promise<StreamMimoAnthropicResult> {
  const apiKey = process.env.MIMO_ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new UpstreamModelError("MIMO_ANTHROPIC_API_KEY is not configured");
  }

  const baseUrl = trimTrailingSlash(
    process.env.MIMO_ANTHROPIC_BASE_URL || DEFAULT_BASE_URL
  );
  const model = process.env.MIMO_MODEL || DEFAULT_MODEL;
  const compactedMessages = compactMessages(messages);

  return observeGeneration(
    "mimo.anthropic.stream",
    {
      input: summarizeMessages(compactedMessages),
      model,
      modelParameters: {
        maxTokens: enableThinking ? 4096 : 2048,
        thinkingBudgetTokens: enableThinking ? 1024 : 0
      },
      metadata: {
        enableThinking,
        provider: "mimo-anthropic",
        baseUrl
      }
    },
    async (generation) => {
      const artifactExtractor = new ArtifactExtractor();

      try {
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "x-api-key": apiKey
          },
          body: JSON.stringify({
            model,
            max_tokens: enableThinking ? 4096 : 2048,
            stream: true,
            system: buildSystemPrompt(),
            ...(enableThinking
              ? { thinking: { type: "enabled", budget_tokens: 1024 } }
              : {}),
            messages: compactedMessages
          }),
          signal
        });

        if (!response.ok || !response.body) {
          const details = await response.text().catch(() => "");
          throw new UpstreamModelError(
            details || `MiMo model request failed with status ${response.status}`,
            response.status
          );
        }

        let rawAssistantContent = "";
        let visibleAssistantContent = "";

        await parseAnthropicStream(response.body, {
          onDelta(content) {
            rawAssistantContent += content;
            const visibleDelta = artifactExtractor.push(content);

            if (visibleDelta) {
              visibleAssistantContent += visibleDelta;
              onDelta(visibleDelta);
            }
          },
          onThinkingDelta
        });

        const flushedVisibleContent = artifactExtractor.flush();

        if (flushedVisibleContent) {
          visibleAssistantContent += flushedVisibleContent;
          onDelta(flushedVisibleContent);
        }

        const result = {
          rawAssistantContent,
          visibleAssistantContent,
          artifactRequests: artifactExtractor.getArtifactRequests()
        };

        generation.update({
          output: {
            visibleAssistantContent: summarizeText(visibleAssistantContent),
            rawCharacterCount: rawAssistantContent.length,
            artifactRequestCount: result.artifactRequests.length
          }
        });

        return result;
      } catch (error) {
        generation.update({
          level: "ERROR",
          statusMessage:
            error instanceof Error ? error.message : "MiMo stream failed",
          output: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    }
  );
}

function compactMessages(messages: ChatMessage[]) {
  return messages
    .map((message) => {
      if (typeof message.content === "string") {
        return {
          role: message.role,
          content: message.content.trim()
        };
      }

      return {
        role: message.role,
        content: message.content.filter((block) => {
          if (block.type === "text") {
            return block.text.trim().length > 0;
          }

          return block.source.data.length > 0;
        })
      };
    })
    .filter((message) =>
      typeof message.content === "string"
        ? message.content.length > 0
        : message.content.length > 0
    );
}

async function parseAnthropicStream(
  stream: ReadableStream<Uint8Array>,
  handlers: {
    onDelta: (content: string) => void;
    onThinkingDelta: (content: string) => void;
  }
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";

    for (const event of events) {
      handleStreamEvent(event, handlers);
    }
  }

  if (buffer.trim()) {
    handleStreamEvent(buffer, handlers);
  }
}

function handleStreamEvent(
  event: string,
  handlers: {
    onDelta: (content: string) => void;
    onThinkingDelta: (content: string) => void;
  }
) {
  const dataLines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, ""));

  for (const line of dataLines) {
    if (!line || line === "[DONE]") {
      continue;
    }

    const payload = JSON.parse(line) as AnthropicStreamEvent;
    const thinkingDelta =
      payload.delta?.thinking ||
      payload.delta?.reasoning_content ||
      payload.content_block?.thinking;

    if (payload.type === "content_block_delta" && payload.delta?.text) {
      handlers.onDelta(payload.delta.text);
    }

    if (thinkingDelta) {
      handlers.onThinkingDelta(thinkingDelta);
    }

    if (payload.type === "error") {
      throw new UpstreamModelError(
        payload.error?.message || "MiMo stream returned an error"
      );
    }
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function buildSystemPrompt() {
  return [
    "你是师范生实训平台的教学助手。请用中文回答，面向师范生完成教案、说课、课堂观察、实习反思等教学任务。",
    "如果用户明确要求生成可下载文件、文档、PPT、Word 或 Markdown，请在正常回答之后追加一个 artifacts JSON 块。",
    "artifacts JSON 块必须严格使用以下格式，并且不要在块外解释 JSON：",
    "<artifacts_json>",
    "{\"artifacts\":[{\"name\":\"文件名.docx\",\"type\":\"docx\",\"title\":\"标题\",\"content\":\"正文\",\"sections\":[{\"heading\":\"小节标题\",\"body\":\"段落正文\",\"bullets\":[\"要点\"]}],\"slides\":[{\"title\":\"幻灯片标题\",\"bullets\":[\"要点\"],\"notes\":\"讲稿备注\"}]}]}",
    "</artifacts_json>",
    "type 只能是 md、docx、pptx。没有文件需求时不要输出 artifacts JSON 块。"
  ].join("\n");
}

class ArtifactExtractor {
  private readonly startMarker = "<artifacts_json>";
  private readonly endMarker = "</artifacts_json>";
  private mode: "visible" | "artifact" | "done" = "visible";
  private tail = "";
  private artifactBuffer = "";

  push(chunk: string) {
    if (this.mode === "done") {
      return chunk;
    }

    if (this.mode === "artifact") {
      return this.pushArtifact(chunk);
    }

    const combined = this.tail + chunk;
    const startIndex = combined.indexOf(this.startMarker);

    if (startIndex >= 0) {
      this.mode = "artifact";
      this.tail = "";
      const visible = combined.slice(0, startIndex).trimEnd();
      return visible + this.pushArtifact(
        combined.slice(startIndex + this.startMarker.length)
      );
    }

    const keepLength = Math.max(this.startMarker.length - 1, 0);

    if (combined.length <= keepLength) {
      this.tail = combined;
      return "";
    }

    const visible = combined.slice(0, combined.length - keepLength);
    this.tail = combined.slice(combined.length - keepLength);
    return visible;
  }

  flush() {
    if (this.mode === "visible") {
      const visible = this.tail;
      this.tail = "";
      return visible;
    }

    return "";
  }

  getArtifactRequests() {
    if (!this.artifactBuffer.trim()) {
      return [];
    }

    try {
      const parsed = JSON.parse(this.artifactBuffer.trim()) as {
        artifacts?: unknown[];
      };
      return Array.isArray(parsed.artifacts) ? parsed.artifacts : [];
    } catch {
      return [];
    }
  }

  private pushArtifact(chunk: string) {
    const combined = this.artifactBuffer + chunk;
    const endIndex = combined.indexOf(this.endMarker);

    if (endIndex >= 0) {
      this.artifactBuffer = combined.slice(0, endIndex);
      this.mode = "done";
      return combined.slice(endIndex + this.endMarker.length).trimStart();
    }

    this.artifactBuffer = combined;
    return "";
  }
}
