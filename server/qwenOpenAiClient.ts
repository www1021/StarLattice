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
  system?: string;
  messages: ChatMessage[];
  enableThinking?: boolean;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta: (content: string) => void;
  onThinkingDelta: (content: string) => void;
};

export type CompleteChatOptions = {
  system?: string;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  enableThinking?: boolean;
  onThinking?: (content: string) => void;
  signal?: AbortSignal;
};

type OpenAiContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

type OpenAiMessage = {
  role: "system" | ChatRole;
  content: string | OpenAiContentPart[];
};

type OpenAiStreamEvent = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

type OpenAiChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

export type StreamQwenChatResult = {
  rawAssistantContent: string;
  visibleAssistantContent: string;
  artifactRequests: unknown[];
};

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3-vl-plus";

export class UpstreamModelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "UpstreamModelError";
  }
}

export function isQwenConfigured() {
  return Boolean(getQwenApiKey());
}

export function getQwenModel() {
  return process.env.QWEN_MODEL || process.env.AI_MODEL || DEFAULT_MODEL;
}

/** 平台工作流节点可单独指定文本模型，避免与聊天/多模态场景共用同一个高成本模型。 */
export function getPlatformLiveModel() {
  return process.env.PLATFORM_LIVE_MODEL || getQwenModel();
}

export async function streamQwenChat({
  system,
  messages,
  enableThinking = false,
  maxTokens = 2048,
  signal,
  onDelta,
  onThinkingDelta
}: StreamChatOptions): Promise<StreamQwenChatResult> {
  const apiKey = getQwenApiKey();

  if (!apiKey) {
    throw new UpstreamModelError("QWEN_API_KEY or DASHSCOPE_API_KEY is not configured");
  }

  const baseUrl = getQwenBaseUrl();
  const model = getQwenModel();
  const compactedMessages = compactMessages(messages);

  return observeGeneration(
    "qwen.chat.stream",
    {
      input: summarizeMessages(compactedMessages),
      model,
      modelParameters: {
        maxTokens,
        stream: "true",
        enableThinking: String(enableThinking)
      },
      metadata: {
        provider: "qwen",
        baseUrl
      }
    },
    async (generation) => {
      const artifactExtractor = new ArtifactExtractor();

      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            stream: true,
            messages: [
              {
                role: "system",
                content: system || buildSystemPrompt()
              },
              ...toOpenAiMessages(compactedMessages)
            ]
          }),
          signal
        });

        if (!response.ok || !response.body) {
          const details = await response.text().catch(() => "");
          throw new UpstreamModelError(
            details || `Qwen model request failed with status ${response.status}`,
            response.status
          );
        }

        let rawAssistantContent = "";
        let visibleAssistantContent = "";

        await parseOpenAiStream(response.body, {
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
            error instanceof Error ? error.message : "Qwen stream failed",
          output: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    }
  );
}

export async function completeQwenChat({
  system,
  messages,
  model: requestedModel,
  maxTokens = 4096,
  temperature = 0.35,
  enableThinking = false,
  onThinking,
  signal
}: CompleteChatOptions) {
  const apiKey = getQwenApiKey();

  if (!apiKey) {
    throw new UpstreamModelError("QWEN_API_KEY or DASHSCOPE_API_KEY is not configured");
  }

  const baseUrl = getQwenBaseUrl();
  const model = requestedModel?.trim() || getQwenModel();
  const compactedMessages = compactMessages(messages);

  return observeGeneration(
    "qwen.chat.complete",
    {
      input: {
        system: summarizeText(system || "", 900),
        messages: summarizeMessages(compactedMessages)
      },
      model,
      modelParameters: {
        temperature,
        maxTokens
      },
      metadata: {
        provider: "qwen",
        baseUrl,
        stream: false
      }
    },
    async (generation) => {
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model,
            temperature,
            max_tokens: maxTokens,
            enable_thinking: enableThinking,
            messages: [
              ...(system ? [{ role: "system" as const, content: system }] : []),
              ...toOpenAiMessages(compactedMessages)
            ]
          }),
          signal
        });

        if (!response.ok) {
          const details = await response.text().catch(() => "");
          throw new UpstreamModelError(
            details || `Qwen model request failed with status ${response.status}`,
            response.status
          );
        }

        const payload = (await response.json()) as OpenAiChatCompletionResponse;

        if (payload.error?.message) {
          throw new UpstreamModelError(payload.error.message);
        }

        const content = payload.choices?.[0]?.message?.content?.trim() || "";

        if (!content) {
          throw new UpstreamModelError("Qwen did not return content");
        }

        const thinking = payload.choices?.[0]?.message?.reasoning_content?.trim();
        if (thinking && onThinking) {
          onThinking(thinking);
        }

        generation.update({
          output: {
            content: summarizeText(content),
            thinking: thinking ? summarizeText(thinking, 900) : undefined,
            characterCount: content.length
          }
        });

        return content;
      } catch (error) {
        generation.update({
          level: "ERROR",
          statusMessage:
            error instanceof Error ? error.message : "Qwen completion failed",
          output: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    }
  );
}

function getQwenApiKey() {
  return process.env.QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.AI_API_KEY;
}

function getQwenBaseUrl() {
  return trimTrailingSlash(
    process.env.QWEN_BASE_URL ||
      process.env.DASHSCOPE_BASE_URL ||
      process.env.AI_BASE_URL ||
      DEFAULT_BASE_URL
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

function toOpenAiMessages(messages: ChatMessage[]): OpenAiMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((block): OpenAiContentPart => {
            if (block.type === "text") {
              return {
                type: "text",
                text: block.text
              };
            }

            return {
              type: "image_url",
              image_url: {
                url: `data:${block.source.media_type};base64,${block.source.data}`
              }
            };
          })
  }));
}

async function parseOpenAiStream(
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

    const payload = JSON.parse(line) as OpenAiStreamEvent;

    if (payload.error?.message) {
      throw new UpstreamModelError(payload.error.message);
    }

    for (const choice of payload.choices || []) {
      const reasoningDelta = choice.delta?.reasoning_content;
      const contentDelta = choice.delta?.content;

      if (reasoningDelta) {
        handlers.onThinkingDelta(reasoningDelta);
      }

      if (contentDelta) {
        handlers.onDelta(contentDelta);
      }
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
