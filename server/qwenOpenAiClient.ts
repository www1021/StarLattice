import {
  observeGeneration,
  summarizeMessages,
  summarizeText
} from "./observability.js";
import { getModelProfile } from "./platform/models/catalog.js";
import { normalizeBaseUrl } from "./platform/models/baseUrl.js";

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
  /** 调用点可指定低成本模型；缺省沿用 QWEN_MODEL，避免为纯文本场景付多模态的钱。 */
  model?: string;
  /** 用户在设置里配好的那套地址与密钥；不传时回落到环境变量。 */
  provider?: ModelProviderConfig;
  /** 显式关闭上游思考链；部分 Flash 模型默认会先生成 reasoning_content，拖慢正文首帧。 */
  disableThinking?: boolean;
  enableThinking?: boolean;
  maxTokens?: number;
  /** 采样温度；智能体可以单独设，没设就走上游默认。 */
  temperature?: number;
  signal?: AbortSignal;
  onDelta: (content: string) => void;
  onThinkingDelta: (content: string) => void;
};

/** 平台模型目录解析出的 provider 配置；缺省时沿用 QWEN_* 环境变量。 */
export type ModelProviderConfig = {
  baseUrl: string;
  apiKey: string;
  label?: string;
};

export type CompleteChatOptions = {
  system?: string;
  messages: ChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** 节点级核采样参数；不传时沿用上游默认值，避免改变既有调用行为。 */
  topP?: number;
  enableThinking?: boolean;
  onThinking?: (content: string) => void;
  signal?: AbortSignal;
  provider?: ModelProviderConfig;
};

/** OpenAI 兼容的工具声明；name 必须是 [a-zA-Z0-9_-]，平台侧负责把工具 id 映射成安全名称。 */
export type QwenToolDefinition = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type QwenToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ToolChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: QwenToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type CompleteToolChatOptions = {
  system?: string;
  messages: ToolChatMessage[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: QwenToolDefinition[];
  /** 默认 auto；模型不肯调用工具时，可以提到 required 要求它必须选一个。 */
  toolChoice?: "auto" | "required";
  onThinking?: (content: string) => void;
  signal?: AbortSignal;
  provider?: ModelProviderConfig;
};

export type ToolChatResult = {
  content: string;
  thinking?: string;
  toolCalls: QwenToolCall[];
  finishReason?: string;
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
    finish_reason?: string;
    message?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: QwenToolCall[];
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
/** 上游长时间不返回时必须让请求失败，否则运行会永久挂起并占住并发与 Agent 槽位。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

export class UpstreamModelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "UpstreamModelError";
  }
}

/**
 * 设置面板里配好的默认模型优先于环境变量：用户在界面上显式填过的模型、地址、密钥，
 * 就应该真的生效，而不是被后端写死的变量盖住。读配置失败时静默退回环境变量。
 */
function configuredDefaultProfile() {
  try {
    const profile = getModelProfile("platform-default");
    if (profile?.apiKey && profile?.baseUrl) {
      return profile;
    }
  } catch {
    // 配置文件损坏等情况下不影响对话可用性。
  }
  return undefined;
}

export function isQwenConfigured() {
  return Boolean(getQwenApiKey());
}

export function getQwenModel() {
  return (
    configuredDefaultProfile()?.model ||
    process.env.QWEN_MODEL ||
    process.env.AI_MODEL ||
    DEFAULT_MODEL
  );
}

/** 平台工作流节点可单独指定文本模型，避免与聊天/多模态场景共用同一个高成本模型。 */
export function getPlatformLiveModel() {
  return process.env.PLATFORM_LIVE_MODEL || getQwenModel();
}

export async function streamQwenChat({
  system,
  messages,
  model: requestedModel,
  provider,
  disableThinking = false,
  enableThinking = false,
  maxTokens = 2048,
  temperature,
  signal,
  onDelta,
  onThinkingDelta
}: StreamChatOptions): Promise<StreamQwenChatResult> {
  const apiKey = provider?.apiKey || getQwenApiKey();

  if (!apiKey) {
    throw new UpstreamModelError(
      "还没有可用的模型密钥。请打开「设置 → 模型与密钥」，添加一个模型并填入自己的 API Key。"
    );
  }

  const baseUrl = trimTrailingSlash(provider?.baseUrl || getQwenBaseUrl());
  const model = requestedModel?.trim() || getQwenModel();
  const compactedMessages = compactMessages(messages);

  return observeGeneration(
    "qwen.chat.stream",
    {
      input: summarizeMessages(compactedMessages),
      model,
      modelParameters: {
        maxTokens,
        ...(typeof temperature === "number" ? { temperature } : {}),
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
            ...(typeof temperature === "number" ? { temperature } : {}),
            stream: true,
            ...(disableThinking ? { enable_thinking: false } : {}),
            messages: [
              {
                role: "system",
                content: system || buildSystemPrompt()
              },
              ...toOpenAiMessages(compactedMessages)
            ]
          }),
          signal: requestSignal(signal)
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
  topP,
  enableThinking = false,
  onThinking,
  signal,
  provider
}: CompleteChatOptions) {
  const apiKey = provider?.apiKey || getQwenApiKey();

  if (!apiKey) {
    throw new UpstreamModelError(
      `还没有可用的模型密钥。请打开「设置 → 模型与密钥」，添加一个模型并填入自己的 API Key。${
        provider?.label ? `（当前模型：${provider.label}）` : ""
      }`
    );
  }

  const baseUrl = trimTrailingSlash(provider?.baseUrl || getQwenBaseUrl());
  const providerLabel = provider?.label || "qwen";
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
        maxTokens,
        ...(topP === undefined ? {} : { topP })
      },
      metadata: {
        provider: providerLabel,
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
            ...(topP === undefined ? {} : { top_p: topP }),
            max_tokens: maxTokens,
            enable_thinking: enableThinking,
            messages: [
              ...(system ? [{ role: "system" as const, content: system }] : []),
              ...toOpenAiMessages(compactedMessages)
            ]
          }),
          signal: requestSignal(signal)
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

/**
 * 带工具调用的单轮补全：平台只负责把模型请求的 tool_calls 交给执行器，
 * 真正调用与结果回填由调用方（Agent 运行器）完成，便于记录证据与限制轮次。
 */
export async function completeQwenToolChat({
  system,
  messages,
  model: requestedModel,
  maxTokens = 2048,
  temperature = 0.2,
  tools = [],
  toolChoice = "auto",
  onThinking,
  signal,
  provider
}: CompleteToolChatOptions): Promise<ToolChatResult> {
  const apiKey = provider?.apiKey || getQwenApiKey();

  if (!apiKey) {
    throw new UpstreamModelError(
      `还没有可用的模型密钥。请打开「设置 → 模型与密钥」，添加一个模型并填入自己的 API Key。${
        provider?.label ? `（当前模型：${provider.label}）` : ""
      }`
    );
  }

  const baseUrl = trimTrailingSlash(provider?.baseUrl || getQwenBaseUrl());
  const providerLabel = provider?.label || "qwen";
  const model = requestedModel?.trim() || getQwenModel();

  return observeGeneration(
    "qwen.chat.tools",
    {
      input: {
        system: summarizeText(system || "", 900),
        messages: summarizeToolMessages(messages)
      },
      model,
      modelParameters: {
        temperature,
        maxTokens,
        toolCount: String(tools.length)
      },
      metadata: {
        provider: providerLabel,
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
            // 工具轮次不做真流式，思考内容没人看，开着只会白等几秒推理 token。
            enable_thinking: false,
            messages: [
              ...(system ? [{ role: "system" as const, content: system }] : []),
              ...messages
            ],
            ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {})
          }),
          signal: requestSignal(signal)
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

        const choice = payload.choices?.[0];
        const content = choice?.message?.content?.trim() || "";
        const thinking = choice?.message?.reasoning_content?.trim();
        const toolCalls = Array.isArray(choice?.message?.tool_calls)
          ? choice.message.tool_calls.filter((call) => call?.function?.name)
          : [];

        if (thinking && onThinking) {
          onThinking(thinking);
        }

        generation.update({
          output: {
            content: summarizeText(content),
            characterCount: content.length,
            toolCalls: toolCalls.map((call) => ({
              name: call.function.name,
              arguments: summarizeText(call.function.arguments, 300)
            }))
          }
        });

        return {
          content,
          thinking,
          toolCalls,
          finishReason: choice?.finish_reason
        };
      } catch (error) {
        generation.update({
          level: "ERROR",
          statusMessage:
            error instanceof Error ? error.message : "Qwen tool completion failed",
          output: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    }
  );
}

export type StreamToolChatOptions = CompleteToolChatOptions & {
  onDelta?: (content: string) => void;
  onThinkingDelta?: (content: string) => void;
};

/**
 * 带工具的流式补全：用来「边生成边出字」。
 *
 * 工具调用的参数在流里是碎片（同一个调用按 index 分很多片 arguments 过来），
 * 这里按 index 累加成完整调用；正文则逐段回调。
 *
 * 只在「已经有工具结果、这一轮就是写给用户看」的时候才开流式。模型如果先吐半句话
 * 再去调工具，那半句会留在屏幕上但不进存档，所以调用方要自己把握时机。
 */
export async function streamQwenToolChat({
  system,
  messages,
  model: requestedModel,
  maxTokens = 2048,
  temperature = 0.2,
  tools = [],
  toolChoice = "auto",
  onDelta,
  onThinkingDelta,
  onThinking,
  signal,
  provider
}: StreamToolChatOptions): Promise<ToolChatResult> {
  const apiKey = provider?.apiKey || getQwenApiKey();

  if (!apiKey) {
    throw new UpstreamModelError(
      `还没有可用的模型密钥。请打开「设置 → 模型与密钥」，添加一个模型并填入自己的 API Key。${
        provider?.label ? `（当前模型：${provider.label}）` : ""
      }`
    );
  }

  const baseUrl = trimTrailingSlash(provider?.baseUrl || getQwenBaseUrl());
  const providerLabel = provider?.label || "qwen";
  const model = requestedModel?.trim() || getQwenModel();

  return observeGeneration(
    "qwen.chat.tools.stream",
    {
      input: {
        system: summarizeText(system || "", 900),
        messages: summarizeToolMessages(messages)
      },
      model,
      modelParameters: {
        temperature,
        maxTokens,
        toolCount: String(tools.length),
        stream: "true"
      },
      metadata: { provider: providerLabel, baseUrl }
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
            stream: true,
            enable_thinking: false,
            messages: [
              ...(system ? [{ role: "system" as const, content: system }] : []),
              ...messages
            ],
            ...(tools.length > 0 ? { tools, tool_choice: toolChoice } : {})
          }),
          signal: requestSignal(signal)
        });

        if (!response.ok) {
          const details = await response.text().catch(() => "");
          throw new UpstreamModelError(
            details || `Qwen model request failed with status ${response.status}`,
            response.status
          );
        }

        if (!response.body) {
          throw new UpstreamModelError("模型返回了空响应流，请稍后重试。");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let content = "";
        let thinking = "";
        let finishReason: string | undefined;
        const pending = new Map<number, { id: string; name: string; arguments: string }>();

        const consume = (event: string) => {
          const dataLines = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data:\s?/, ""));

          for (const line of dataLines) {
            if (!line || line === "[DONE]") continue;
            const payload = JSON.parse(line) as {
              choices?: Array<{
                finish_reason?: string;
                delta?: {
                  content?: string | null;
                  reasoning_content?: string | null;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
              error?: { message?: string };
            };

            if (payload.error?.message) {
              throw new UpstreamModelError(payload.error.message);
            }

            for (const choice of payload.choices ?? []) {
              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
              }
              const reasoning = choice.delta?.reasoning_content;
              if (reasoning) {
                thinking += reasoning;
                onThinkingDelta?.(reasoning);
              }
              const piece = choice.delta?.content;
              if (piece) {
                content += piece;
                onDelta?.(piece);
              }
              for (const call of choice.delta?.tool_calls ?? []) {
                const index = call.index ?? 0;
                const slot = pending.get(index) ?? { id: "", name: "", arguments: "" };
                if (call.id) slot.id = call.id;
                if (call.function?.name) slot.name = call.function.name;
                if (call.function?.arguments) slot.arguments += call.function.arguments;
                pending.set(index, slot);
              }
            }
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";
          for (const event of events) {
            consume(event);
          }
        }
        if (buffer.trim()) {
          consume(buffer);
        }

        const toolCalls: QwenToolCall[] = [...pending.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, slot]) => ({
            id: slot.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            type: "function" as const,
            function: { name: slot.name, arguments: slot.arguments || "{}" }
          }))
          .filter((call) => Boolean(call.function.name));

        if (thinking && onThinking) {
          onThinking(thinking);
        }

        generation.update({
          output: {
            content: summarizeText(content),
            characterCount: content.length,
            toolCalls: toolCalls.map((call) => call.function.name)
          }
        });

        return {
          content: content.trim(),
          thinking: thinking || undefined,
          toolCalls,
          finishReason
        };
      } catch (error) {
        generation.update({
          level: "ERROR",
          statusMessage:
            error instanceof Error ? error.message : "Qwen tool stream failed",
          output: { error: error instanceof Error ? error.message : String(error) }
        });
        throw error;
      }
    }
  );
}

function summarizeToolMessages(messages: ToolChatMessage[]) {
  return messages.map((message) => {

    if (message.role === "tool") {
      return { role: message.role, content: summarizeText(message.content, 600) };
    }
    if (message.role === "assistant") {
      return {
        role: message.role,
        content: summarizeText(message.content, 600),
        toolCalls: message.tool_calls?.map((call) => call.function.name) ?? []
      };
    }
    return { role: message.role, content: summarizeText(message.content, 900) };
  });
}

/**
 * 密钥只有一个来源：这个账号在「设置 → 模型与密钥」里配好的那条模型。
 *
 * 环境变量不再参与。`QUEEN_ACCESS_KEY` 那类进程级兜底已经删掉：一把全进程共用的
 * Key 分不清是谁在用、用掉多少，等于让没配模型的账号绕开账号隔离。
 * 没配就是没配，直接报错，让人去设置里补 —— 不在响应里假装成功。
 */
function getQwenApiKey() {
  return configuredDefaultProfile()?.apiKey;
}

function getQwenBaseUrl() {
  return trimTrailingSlash(
    configuredDefaultProfile()?.baseUrl ||
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

/** 用户可能把完整端点粘进设置里，这里统一退回 /v1 这一层再拼路径。 */
function trimTrailingSlash(value: string) {
  return normalizeBaseUrl(value);
}

function requestSignal(signal?: AbortSignal): AbortSignal | undefined {
  const timeoutMs = Number(process.env.PLATFORM_MODEL_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return signal;
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) {
    return timeout;
  }
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : signal;
}

const artifactInstructions = [
  "如果用户明确要求生成可下载文件、文档、PPT、Word 或 Markdown，请在正常回答之后追加一个 artifacts JSON 块。",
  "artifacts JSON 块必须严格使用以下格式，并且不要在块外解释 JSON：",
  "<artifacts_json>",
  "{\"artifacts\":[{\"name\":\"文件名.docx\",\"type\":\"docx\",\"title\":\"标题\",\"content\":\"正文\",\"sections\":[{\"heading\":\"小节标题\",\"body\":\"段落正文\",\"bullets\":[\"要点\"]}],\"slides\":[{\"title\":\"幻灯片标题\",\"bullets\":[\"要点\"],\"notes\":\"讲稿备注\"}]}]}",
  "</artifacts_json>",
  "type 只能是 md、docx、pptx。没有文件需求时不要输出 artifacts JSON 块。"
];

function buildSystemPrompt() {
  return [
    "你是师范生实训平台的教学助手。请用中文回答，面向师范生完成教案、说课、课堂观察、实习反思等教学任务。",
    ...artifactInstructions
  ].join("\n");
}

export function buildOfficeAssistantSystemPrompt() {
  return [
    "你是 StarLattice 通用办公助手，服务教师、行政人员和业务团队的日常办公。请用中文回答，可处理写作、总结、翻译、润色、会议纪要、计划方案、表格与数据整理、邮件等任务。",
    "不要默认把问题理解为教学任务；只有用户明确谈及教学、课堂或学生时，才使用教育语境。",
    "回答尽量结构化、可直接使用；信息不足时先给出可执行版本，并列出需要补充的信息。",
    ...artifactInstructions
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
