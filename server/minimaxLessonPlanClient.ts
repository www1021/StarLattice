import {
  generateLessonPlanDraft,
  type LessonPlanDraft,
  type LessonPlanInput,
  type LessonPlanSection,
  renderLessonPlanText
} from "./lessonPlanService.js";
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
  // 教案模型跟聊天用同一条路径：账号里配好的模型。环境变量不再提供兜底。
  return isQwenConfigured();
}

export async function generateMiniMaxLessonPlanDraft({
  input,
  citations,
  currentDraft,
  mode
}: GenerateMiniMaxLessonPlanOptions): Promise<LessonPlanDraft | undefined> {
  // 没配模型就不生成 AI 草稿，让调用方用本地规则版本，不再偷偷借部署方的 Key。
  if (!isQwenConfigured()) {
    return undefined;
  }

  const fallbackDraft = generateLessonPlanDraft(
    input,
    citations,
    mode === "refine" ? Math.max(2, (currentDraft?.version || 1) + 1) : 1
  );
  const prompt = {
    system: buildLessonPlanSystemPrompt(),
    user: buildLessonPlanUserPrompt(input, citations, currentDraft, mode)
  };
  const content = await requestQwenLessonPlan(prompt);

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
  if (!isQwenConfigured()) {
    return undefined;
  }

  const fallbackDraft = generateLessonPlanDraft(
    input,
    citations,
    mode === "refine" ? Math.max(2, (currentDraft?.version || 1) + 1) : 1
  );
  const prompt = {
    system: buildLessonPlanSystemPrompt(),
    user: buildLessonPlanUserPrompt(input, citations, currentDraft, mode)
  };

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

function buildLessonPlanSystemPrompt() {
  return [
    "你是 StarLattice 平台的教案生成智能体，服务对象是师范生。",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
