import {
  generateLessonPlanDraft,
  type LessonPlanDraft,
  type LessonPlanInput,
  type LessonPlanSection,
  renderLessonPlanText
} from "./lessonPlanService.js";
import { observeGeneration, summarizeText } from "./observability.js";
import {
  completeQwenChat,
  isQwenConfigured,
  streamQwenChat,
  UpstreamModelError
} from "./qwenOpenAiClient.js";
import type { StoredCitation } from "./storage/chatRepository.js";

type GenerateMiniMaxLessonPlanOptions = {
  input: LessonPlanInput;
  citations: StoredCitation[];
  currentDraft?: LessonPlanDraft;
  mode: "generate" | "refine";
};

type StreamMiniMaxLessonPlanOptions = GenerateMiniMaxLessonPlanOptions & {
  signal?: AbortSignal;
  onDelta?: (content: string) => void;
  onThinkingDelta?: (content: string) => void;
};

type MiniMaxChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
  error?: {
    message?: string;
  };
};

type MimoAnthropicMessageResponse = {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  error?: {
    message?: string;
  };
};

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io";
const DEFAULT_MINIMAX_MODEL = "MiniMax-M3";
const DEFAULT_MIMO_ANTHROPIC_BASE_URL = "https://token-plan-cn.xiaomimimo.com/anthropic";
const DEFAULT_MIMO_MODEL = "mimo-v2.5";
const requiredHeadings = [
  "一、教学目标",
  "二、学情分析",
  "三、教学重难点",
  "四、教学准备",
  "五、教学过程",
  "六、课堂提问与预设回答",
  "七、板书设计",
  "八、作业设计",
  "九、教学反思建议",
  "十、师德育人融入点"
];

export class MiniMaxLessonPlanError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MiniMaxLessonPlanError";
  }
}

export function isMiniMaxLessonPlanConfigured() {
  return Boolean(
    isQwenConfigured() ||
      process.env.MINIMAX_API_KEY ||
      process.env.MIMO_ANTHROPIC_API_KEY
  );
}

export async function generateMiniMaxLessonPlanDraft({
  input,
  citations,
  currentDraft,
  mode
}: GenerateMiniMaxLessonPlanOptions): Promise<LessonPlanDraft | undefined> {
  const apiKey = process.env.MINIMAX_API_KEY;
  const fallbackDraft = generateLessonPlanDraft(
    input,
    citations,
    mode === "refine" ? Math.max(2, (currentDraft?.version || 1) + 1) : 1
  );

  if (!isQwenConfigured() && !apiKey && !process.env.MIMO_ANTHROPIC_API_KEY) {
    return undefined;
  }

  const prompt = {
    system: buildLessonPlanSystemPrompt(),
    user: buildLessonPlanUserPrompt(input, citations, currentDraft, mode)
  };

  let content = "";

  if (isQwenConfigured()) {
    try {
      content = await requestQwenLessonPlan(prompt);
    } catch (error) {
      if (!apiKey && !process.env.MIMO_ANTHROPIC_API_KEY) {
        throw error;
      }
      const message =
        error instanceof Error ? error.message : "Qwen lesson plan request failed";
      console.warn(`Qwen lesson plan failed, trying legacy providers: ${message}`);
    }
  }

  if (apiKey && apiKey !== process.env.MIMO_ANTHROPIC_API_KEY) {
    try {
      content = await requestMiniMaxOpenAiCompatible(prompt);
    } catch (error) {
      if (!process.env.MIMO_ANTHROPIC_API_KEY) {
        throw error;
      }
      const message =
        error instanceof Error ? error.message : "MiniMax OpenAI-compatible request failed";
      console.warn(`MiniMax OpenAI-compatible lesson plan failed, trying MIMO Anthropic: ${message}`);
    }
  }

  if (!content && process.env.MIMO_ANTHROPIC_API_KEY) {
    content = await requestMimoAnthropicLessonPlan(prompt);
  }

  if (!content) {
    throw new MiniMaxLessonPlanError("MiniMax skill did not return lesson plan content");
  }

  return normalizeAiLessonPlanDraft({
    rawText: content,
    fallbackDraft,
    input,
    citations,
    mode
  });
}

export async function generateStreamingMiniMaxLessonPlanDraft({
  input,
  citations,
  currentDraft,
  mode,
  signal,
  onDelta,
  onThinkingDelta
}: StreamMiniMaxLessonPlanOptions): Promise<LessonPlanDraft | undefined> {
  const fallbackDraft = generateLessonPlanDraft(
    input,
    citations,
    mode === "refine" ? Math.max(2, (currentDraft?.version || 1) + 1) : 1
  );

  if (!isMiniMaxLessonPlanConfigured()) {
    return undefined;
  }

  const prompt = {
    system: buildLessonPlanSystemPrompt(),
    user: buildLessonPlanUserPrompt(input, citations, currentDraft, mode)
  };

  if (isQwenConfigured()) {
    try {
      const streamResult = await streamQwenChat({
        system: prompt.system,
        messages: [
          {
            role: "user",
            content: prompt.user
          }
        ],
        enableThinking: true,
        maxTokens: 4096,
        signal,
        onDelta(content) {
          onDelta?.(content);
        },
        onThinkingDelta(content) {
          onThinkingDelta?.(content);
        }
      });

      return normalizeAiLessonPlanDraft({
        rawText: streamResult.rawAssistantContent || streamResult.visibleAssistantContent,
        fallbackDraft,
        input,
        citations,
        mode
      });
    } catch (error) {
      if (!process.env.MINIMAX_API_KEY && !process.env.MIMO_ANTHROPIC_API_KEY) {
        throw error;
      }

      const message =
        error instanceof Error ? error.message : "Qwen lesson plan stream failed";
      console.warn(`Qwen lesson plan stream failed, trying legacy providers: ${message}`);
    }
  }

  return generateMiniMaxLessonPlanDraft({
    input,
    citations,
    currentDraft,
    mode
  });
}

async function requestQwenLessonPlan(prompt: {
  system: string;
  user: string;
}) {
  try {
    return await completeQwenChat({
      system: prompt.system,
      messages: [
        {
          role: "user",
          content: prompt.user
        }
      ],
      temperature: 0.35,
      maxTokens: 4096
    });
  } catch (error) {
    throw new MiniMaxLessonPlanError(
      error instanceof Error ? error.message : "Qwen lesson plan failed",
      error instanceof UpstreamModelError ? error.status : undefined
    );
  }
}

async function requestMiniMaxOpenAiCompatible(prompt: {
  system: string;
  user: string;
}) {
  const apiKey = process.env.MINIMAX_API_KEY;

  if (!apiKey) {
    return "";
  }

  const baseUrl = trimTrailingSlash(
    process.env.MINIMAX_BASE_URL || DEFAULT_MINIMAX_BASE_URL
  );
  const model = process.env.MINIMAX_MODEL || DEFAULT_MINIMAX_MODEL;

  return observeGeneration(
    "minimax.lesson_plan.generate",
    {
      input: {
        system: summarizeText(prompt.system, 900),
        user: summarizeText(prompt.user, 1400)
      },
      model,
      modelParameters: {
        temperature: 0.35,
        maxCompletionTokens: 4200
      },
      metadata: {
        provider: "minimax",
        baseUrl,
        thinking: "adaptive",
        reasoningSplit: true
      }
    },
    async (generation) => {
      try {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content: prompt.system
              },
              {
                role: "user",
                content: prompt.user
              }
            ],
            temperature: 0.35,
            max_completion_tokens: 4200,
            thinking: { type: "adaptive" },
            reasoning_split: true
          })
        });

        if (!response.ok) {
          const details = await response.text().catch(() => "");
          throw new MiniMaxLessonPlanError(
            details || `MiniMax request failed with status ${response.status}`,
            response.status
          );
        }

        const payload = (await response.json()) as MiniMaxChatCompletionResponse;
        const content = payload.choices?.[0]?.message?.content?.trim();
        const statusCode = payload.base_resp?.status_code ?? 0;

        if (payload.error?.message) {
          throw new MiniMaxLessonPlanError(payload.error.message);
        }

        if (statusCode !== 0) {
          throw new MiniMaxLessonPlanError(
            payload.base_resp?.status_msg || "MiniMax returned a non-zero status"
          );
        }

        if (!content) {
          throw new MiniMaxLessonPlanError("MiniMax did not return lesson plan content");
        }

        generation.update({
          output: {
            content: summarizeText(content),
            characterCount: content.length,
            statusCode
          }
        });

        return content;
      } catch (error) {
        generation.update({
          level: "ERROR",
          statusMessage:
            error instanceof Error ? error.message : "MiniMax request failed",
          output: {
            error: error instanceof Error ? error.message : String(error),
            status:
              error instanceof MiniMaxLessonPlanError ? error.status : undefined
          }
        });
        throw error;
      }
    }
  );
}

async function requestMimoAnthropicLessonPlan(prompt: {
  system: string;
  user: string;
}) {
  const apiKey = process.env.MIMO_ANTHROPIC_API_KEY;

  if (!apiKey) {
    return "";
  }

  const baseUrl = trimTrailingSlash(
    process.env.MIMO_ANTHROPIC_BASE_URL || DEFAULT_MIMO_ANTHROPIC_BASE_URL
  );
  const model = process.env.MIMO_MODEL || DEFAULT_MIMO_MODEL;

  return observeGeneration(
    "mimo.lesson_plan.generate",
    {
      input: {
        system: summarizeText(prompt.system, 900),
        user: summarizeText(prompt.user, 1400)
      },
      model,
      modelParameters: {
        maxTokens: 4096
      },
      metadata: {
        provider: "mimo-anthropic",
        baseUrl,
        stream: false
      }
    },
    async (generation) => {
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
            max_tokens: 4096,
            stream: false,
            system: prompt.system,
            messages: [
              {
                role: "user",
                content: prompt.user
              }
            ]
          })
        });

        if (!response.ok) {
          const details = await response.text().catch(() => "");
          throw new MiniMaxLessonPlanError(
            details || `MIMO Anthropic request failed with status ${response.status}`,
            response.status
          );
        }

        const payload = (await response.json()) as MimoAnthropicMessageResponse;

        if (payload.error?.message) {
          throw new MiniMaxLessonPlanError(payload.error.message);
        }

        const content = (payload.content || [])
          .filter((block) => block.type === "text" && block.text)
          .map((block) => block.text)
          .join("\n")
          .trim();

        generation.update({
          output: {
            content: summarizeText(content),
            characterCount: content.length
          }
        });

        return content;
      } catch (error) {
        generation.update({
          level: "ERROR",
          statusMessage:
            error instanceof Error ? error.message : "MIMO lesson plan failed",
          output: {
            error: error instanceof Error ? error.message : String(error),
            status:
              error instanceof MiniMaxLessonPlanError ? error.status : undefined
          }
        });
        throw error;
      }
    }
  );
}

function buildLessonPlanSystemPrompt() {
  return [
    "你是“易师训”平台的教案生成智能体，服务对象是师范生。",
    "你的任务是生成可直接进入实训诊断与 Word 导出的结构化教案。",
    "教案必须体现“设计—演练—反馈—修改—再实践”的训练闭环。",
    "请优先结合用户输入、课程标准、教材资料、优秀课例和知识库片段。",
    "输出必须是严格 JSON，不要输出 Markdown，不要包裹代码块，不要额外解释。",
    "JSON 结构：{\"title\":\"...\",\"sourceNote\":\"...\",\"sections\":[{\"heading\":\"一、教学目标\",\"body\":\"...\",\"bullets\":[\"...\"]}]}",
    "sections 必须包含十个章节：一、教学目标；二、学情分析；三、教学重难点；四、教学准备；五、教学过程；六、课堂提问与预设回答；七、板书设计；八、作业设计；九、教学反思建议；十、师德育人融入点。",
    "教学目标要可观察、可评价；教学过程要有教师活动、学生活动、时间建议、评价方式；课堂提问要有追问和预设回答；师德育人要自然融入，不要口号化。"
  ].join("\n");
}

function buildLessonPlanUserPrompt(
  input: LessonPlanInput,
  citations: StoredCitation[],
  currentDraft: LessonPlanDraft | undefined,
  mode: "generate" | "refine"
) {
  const citationText = citations.length
    ? citations
        .slice(0, 4)
        .map(
          (citation, index) =>
            `${index + 1}. 来源：${citation.documentName}｜片段：${citation.snippet}`
        )
        .join("\n")
    : "暂无知识库片段，请使用师范生实训默认教学设计框架。";
  const currentDraftText =
    mode === "refine" && currentDraft
      ? `\n\n当前第一版教案如下，请根据诊断取向优化，不要只做同义改写：\n${renderLessonPlanText(currentDraft)}`
      : "";

  return [
    `任务类型：${mode === "refine" ? "按诊断建议优化教案" : "生成第一版教案"}`,
    `学科：${input.subject}`,
    `年级/学段：${input.grade}`,
    `课题：${input.topic}`,
    `课时：${input.duration}`,
    `教材或知识点：${input.textbookContext}`,
    `学情特点：${input.studentProfile}`,
    `启用技能：${input.skills.length ? input.skills.join("、") : "未启用专用技能"}`,
    "",
    "可参考知识库片段：",
    citationText,
    currentDraftText,
    "",
    "请返回严格 JSON。每个章节可以使用 body、bullets 或两者结合；不要遗漏章节。"
  ].join("\n");
}

function normalizeAiLessonPlanDraft({
  rawText,
  fallbackDraft,
  input,
  citations,
  mode
}: {
  rawText: string;
  fallbackDraft: LessonPlanDraft;
  input: LessonPlanInput;
  citations: StoredCitation[];
  mode: "generate" | "refine";
}) {
  const parsed = parseJsonObject(rawText);
  const aiSections = Array.isArray(parsed?.sections)
    ? parsed.sections.map(normalizeSection).filter(Boolean)
    : extractSectionsFromText(rawText);
  const sections = mergeRequiredSections(
    aiSections as LessonPlanSection[],
    fallbackDraft.sections
  );
  const sourceNote =
    readString(parsed?.sourceNote) ||
    (citations.length
      ? `MiniMax-M3 已结合 ${citations.length} 条知识库片段生成，并保留本地诊断规则。`
      : "MiniMax-M3 已按师范生实训框架生成；当前未引用知识库资料，可继续补充课程标准或优秀课例。");
  const skillNote = input.skills.includes("minimaxskill")
    ? " 已启用 minimaxskill 技能。"
    : "";

  return {
    title: readString(parsed?.title) || `${input.subject}《${input.topic}》教案`,
    input,
    sections,
    sourceNote:
      mode === "refine"
        ? `${sourceNote}${skillNote} 本版本已按诊断建议进行优化。`
        : `${sourceNote}${skillNote}`,
    version: fallbackDraft.version,
    createdAt: new Date().toISOString()
  };
}

function normalizeSection(value: unknown): LessonPlanSection | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const heading = readString(value.heading);

  if (!heading) {
    return undefined;
  }

  const body = readString(value.body);
  const bullets = Array.isArray(value.bullets)
    ? value.bullets.map(readString).filter(Boolean)
    : undefined;

  return {
    heading,
    ...(body ? { body } : {}),
    ...(bullets?.length ? { bullets } : {})
  };
}

function mergeRequiredSections(
  aiSections: LessonPlanSection[],
  fallbackSections: LessonPlanSection[]
) {
  return requiredHeadings.map((requiredHeading) => {
    const aiSection = aiSections.find((section) =>
      section.heading.includes(requiredHeading.replace(/^.+?、/, ""))
    );
    const fallbackSection =
      fallbackSections.find((section) => section.heading === requiredHeading) ||
      fallbackSections.find((section) =>
        section.heading.includes(requiredHeading.replace(/^.+?、/, ""))
      );

    return {
      ...(fallbackSection || { heading: requiredHeading }),
      ...(aiSection || {}),
      heading: requiredHeading
    };
  });
}

function parseJsonObject(rawText: string): Record<string, unknown> | undefined {
  const cleaned = rawText
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  const jsonText = cleaned.slice(start, end + 1);

  try {
    return JSON.parse(jsonText) as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(repairJsonText(jsonText)) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

function repairJsonText(value: string) {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      repaired += char;
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      repaired += char;
      continue;
    }

    if (inString && (char === "\n" || char === "\r")) {
      repaired += "\\n";
      continue;
    }

    repaired += char;
  }

  return repaired.replace(/,\s*([}\]])/g, "$1");
}

function extractSectionsFromText(rawText: string): LessonPlanSection[] {
  const text = rawText
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .replace(/\\n/g, "\n");
  const sections: LessonPlanSection[] = [];

  requiredHeadings.forEach((heading, index) => {
    const headingLabel = heading.replace(/^.+?、/, "");
    const start = findHeadingIndex(text, heading, headingLabel);

    if (start === -1) {
      return;
    }

    const nextHeading = requiredHeadings
      .slice(index + 1)
      .map((item) => ({
        heading: item,
        label: item.replace(/^.+?、/, "")
      }))
      .map((item) => findHeadingIndex(text.slice(start + heading.length), item.heading, item.label))
      .filter((position) => position >= 0)
      .sort((left, right) => left - right)[0];
    const contentStart = start + heading.length;
    const contentEnd =
      nextHeading === undefined ? text.length : contentStart + nextHeading;
    const content = cleanExtractedSectionText(text.slice(contentStart, contentEnd));

    if (content) {
      sections.push({
        heading,
        body: content
      });
    }
  });

  return sections;
}

function findHeadingIndex(text: string, heading: string, label: string) {
  const exact = text.indexOf(heading);

  if (exact >= 0) {
    return exact;
  }

  return text.indexOf(label);
}

function cleanExtractedSectionText(value: string) {
  return value
    .split(/\n+/)
    .map((line) =>
      line
        .replace(/^[\s"',:{}\[\]-]+/, "")
        .replace(/["',:{}\[\]]+$/, "")
        .replace(/^(body|bullets|heading)\s*["']?\s*:\s*/i, "")
        .trim()
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
