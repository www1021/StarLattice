import { randomUUID } from "node:crypto";
import type { ArtifactRequest } from "./artifactService.js";
import type {
  EvaluationDimension,
  StoredCitation,
  TrainingEvaluation
} from "./storage/chatRepository.js";

export type InternshipReflectionInput = {
  schoolClass: string;
  subjectTopic: string;
  internshipDate: string;
  classroomSegment: string;
  observationFocus: string;
  problems: string;
  personalFeeling: string;
  improvementDirection: string;
  knowledgeBaseIds: string[];
};

export type InternshipEvidenceItem = {
  id: string;
  name: string;
  type: "image" | "document" | "text";
  summary: string;
  observationPoints: string[];
  privacyNote?: string;
};

export type InternshipReflectionSection = {
  heading: string;
  body?: string;
  bullets?: string[];
};

export type InternshipReflectionDraft = {
  title: string;
  input: InternshipReflectionInput;
  evidence: InternshipEvidenceItem[];
  sections: InternshipReflectionSection[];
  sourceNote: string;
  version: number;
  createdAt: string;
};

export type InternshipReflectionDiagnostic = {
  overallScore: number;
  dimensions: EvaluationDimension[];
  diagnosis: string[];
  suggestions: string[];
  nextTask: string;
};

const defaultInternshipReflectionInput: InternshipReflectionInput = {
  schoolClass: "教育实习班级",
  subjectTopic: "课堂观察与教学片段",
  internshipDate: "实习日期待补充",
  classroomSegment: "记录一次课堂导入、提问互动或学生练习反馈片段。",
  observationFocus: "关注学生参与、教师提问、课堂反馈和目标达成情况。",
  problems: "课堂观察中发现学生表达不够充分，教师追问和评价支架仍可优化。",
  personalFeeling: "作为实习教师，能够感受到真实课堂中教学设计与现场生成之间的差异。",
  improvementDirection: "下一次实习中准备提前设计问题链、观察记录表和分层反馈语。",
  knowledgeBaseIds: []
};

export function normalizeInternshipReflectionInput(
  value: unknown
): InternshipReflectionInput {
  const record = isRecord(value) ? value : {};

  return {
    schoolClass: readText(record.schoolClass, defaultInternshipReflectionInput.schoolClass),
    subjectTopic: readText(record.subjectTopic, defaultInternshipReflectionInput.subjectTopic),
    internshipDate: readText(
      record.internshipDate,
      defaultInternshipReflectionInput.internshipDate
    ),
    classroomSegment: readText(
      record.classroomSegment,
      defaultInternshipReflectionInput.classroomSegment
    ),
    observationFocus: readText(
      record.observationFocus,
      defaultInternshipReflectionInput.observationFocus
    ),
    problems: readText(record.problems, defaultInternshipReflectionInput.problems),
    personalFeeling: readText(
      record.personalFeeling,
      defaultInternshipReflectionInput.personalFeeling
    ),
    improvementDirection: readText(
      record.improvementDirection,
      defaultInternshipReflectionInput.improvementDirection
    ),
    knowledgeBaseIds: Array.isArray(record.knowledgeBaseIds)
      ? record.knowledgeBaseIds.filter((item): item is string => typeof item === "string")
      : []
  };
}

export function normalizeInternshipEvidence(value: unknown): InternshipEvidenceItem[] {
  const values = Array.isArray(value) ? value : [];

  return values
    .map((item, index): InternshipEvidenceItem | undefined => {
      if (!isRecord(item)) {
        return undefined;
      }

      const type = readEvidenceType(item.type);
      const privacyNote =
        typeof item.privacyNote === "string" && item.privacyNote.trim()
          ? item.privacyNote.trim()
          : undefined;
      const evidence: InternshipEvidenceItem = {
        id: readText(item.id, `evidence_${index + 1}`),
        name: readText(item.name, `证据材料${index + 1}`),
        type,
        summary: readText(item.summary, "已上传课堂证据，等待结合反思文本分析。"),
        observationPoints: Array.isArray(item.observationPoints)
          ? item.observationPoints
              .filter((point): point is string => typeof point === "string")
              .slice(0, 5)
          : ["提取课堂情境信息", "定位可反思的教学行为"],
      };

      if (privacyNote) {
        evidence.privacyNote = privacyNote;
      }

      return evidence;
    })
    .filter((item): item is InternshipEvidenceItem => Boolean(item));
}

export function buildInternshipReflectionSearchQuery(
  input: InternshipReflectionInput
) {
  return [
    input.schoolClass,
    input.subjectTopic,
    input.classroomSegment,
    input.observationFocus,
    input.problems,
    "教育实习 课堂观察 教学反思 师范生 专业成长 改进计划"
  ]
    .filter(Boolean)
    .join(" ");
}

export function generateInternshipReflectionDraft({
  input,
  evidence,
  citations,
  priorTrainingLinks = [],
  version = 1
}: {
  input: InternshipReflectionInput;
  evidence: InternshipEvidenceItem[];
  citations: StoredCitation[];
  priorTrainingLinks?: string[];
  version?: number;
}): InternshipReflectionDraft {
  const reflectionEvidence = buildInternshipEvidence(input, evidence, citations);
  const trainingLinks = buildPriorTrainingLinkBullets(priorTrainingLinks);
  const evidenceLine = reflectionEvidence.length
    ? `已整理 ${reflectionEvidence.length} 条课堂证据，反思将围绕实习日志、听课记录和课堂事件展开。`
    : "未提取到课堂证据，以下内容使用师范生实习反思默认框架生成，可继续补充课堂图片、板书或听课记录。";
  const citationLine = citations.length
    ? `已参考 ${citations.length} 条知识库资料，用于补充专业表达和改进建议。`
    : "未引用外部知识库资料。";

  return {
    title: `${input.subjectTopic}实习日志与反思`,
    input,
    evidence: reflectionEvidence,
    version,
    createdAt: new Date().toISOString(),
    sourceNote: `${evidenceLine}${citationLine}`,
    sections: [
      {
        heading: "一、实习基本信息",
        bullets: [
          `实习学校/班级：${input.schoolClass}`,
          `实习日期：${input.internshipDate}`,
          `学科课题：${input.subjectTopic}`
        ]
      },
      {
        heading: "二、事件描述与课堂观察记录",
        body: `${ensureSentence(input.classroomSegment)}本次观察重点为：${ensureSentence(input.observationFocus)}`
      },
      {
        heading: "三、证据链摘要",
        bullets: reflectionEvidence.length
          ? reflectionEvidence.flatMap((item) => [
              `${item.name}：${item.summary}`,
              ...item.observationPoints.map((point) => `观察点：${point}`)
            ])
          : ["本次未提取到明确证据，建议后续补充板书、学生作业、听课记录或课堂照片。"]
      },
      {
        heading: "四、问题分析",
        body: `本次实习中较突出的现象是：${ensureSentence(input.problems)}这些问题提示实习教师需要从学生反应、教师提问、课堂评价和活动组织之间寻找关联。`
      },
      {
        heading: "五、原因分析",
        bullets: [
          "教学设计与现场生成之间可能存在落差，需要把课堂观察转化为可验证证据。",
          "教师追问、等待时间和评价语言会影响学生表达的深度与参与感。",
          "如果课堂目标、活动任务和评价标准不够一致，学生容易停留在表层完成。"
        ]
      },
      {
        heading: "六、理论依据",
        bullets: [
          "证据驱动反思要求先还原课堂事实，再解释问题原因，最后提出可验证改进。",
          "以学生为中心的课堂观察应关注学生参与、表达机会、学习困难和教师支架是否匹配。",
          citations.length
            ? `本次知识库资料可作为理论依据补充：${citations.slice(0, 2).map((item) => item.documentName).join("、")}。`
            : "后续可补充课标、优秀课例或听课评价标准，增强理论连接。"
        ]
      },
      {
        heading: "七、前序训练关联",
        bullets: trainingLinks
      },
      {
        heading: "八、改进策略",
        bullets: [
          `下一次实践前：${input.improvementDirection}`,
          "课堂实施中：记录至少三个学生真实回应，并标注教师追问后的变化。",
          "课后复盘时：按“现象证据—原因分析—改进行动”三段式修订反思。"
        ]
      },
      {
        heading: "九、后续行动",
        bullets: [
          "带着改进问题再次进入课堂，重点观察学生参与和教师反馈。",
          "补充一张板书、作业或课堂记录作为证据，验证改进是否发生。",
          "将本次反思中的一个改进动作迁移到下一节课或下一次听课。"
        ]
      },
      {
        heading: "十、师德育人反思",
        body: "实习教师需要在课堂观察中关注每一位学生的学习状态，避免只记录表现突出的学生；在评价中使用具体、鼓励且公平的反馈语言，把专业成长与育人责任结合起来。"
      },
      {
        heading: "十一、教师职业成长与师德师风",
        bullets: [
          `职业成长：本次经历提醒实习教师从“完成教学环节”转向“观察学生证据、调整教学行为、验证改进效果”。${ensureSentence(input.personalFeeling)}`,
          "师德师风：在真实课堂中坚持公平对待、尊重差异、保护学生表达意愿，避免只关注答得快或表现突出的学生。",
          "网络育人：涉及课堂照片、学生作品或反思成果时，应先做隐私脱敏，再用于班级空间/易班社群的正向展示和理性互评。"
        ]
      },
      {
        heading: "十二、可迁移经验",
        body: "从本次实习可以提炼出一条可迁移经验：高质量反思不只写感受，而是用课堂证据说明问题、解释原因，并提出下一次能执行的具体动作。"
      }
    ]
  };
}

export function refineInternshipReflectionDraft({
  input,
  currentDraft,
  evidence,
  citations,
  priorTrainingLinks = []
}: {
  input: InternshipReflectionInput;
  currentDraft?: InternshipReflectionDraft;
  evidence: InternshipEvidenceItem[];
  citations: StoredCitation[];
  priorTrainingLinks?: string[];
}) {
  const draft = generateInternshipReflectionDraft({
    input,
    evidence,
    citations,
    priorTrainingLinks: priorTrainingLinks.length
      ? priorTrainingLinks
      : extractPriorTrainingLinks(currentDraft),
    version: Math.max(2, (currentDraft?.version || 1) + 1)
  });
  const planSection = draft.sections.find((section) =>
    /改进计划|改进策略/.test(section.heading)
  );

  if (planSection?.bullets) {
    planSection.bullets.push(
      "优化补充：把改进计划拆成课前准备、课堂观察和课后复盘三个检查点，便于下一轮验证。"
    );
  }

  draft.sourceNote = `${draft.sourceNote} 本版本已根据诊断建议强化证据链、原因解释和可执行改进动作。`;
  return draft;
}

function buildPriorTrainingLinkBullets(priorTrainingLinks: string[]) {
  if (priorTrainingLinks.length) {
    return priorTrainingLinks.slice(0, 5);
  }

  return [
    "关联教案诊断：回看教学目标、活动任务和评价证据是否一致，把课堂中暴露的问题反推到下一版教案修订。",
    "关联说课陪练：把说课中较弱的理论依据、学情解释或答辩风险，转化为本次反思的原因分析和专业表达。",
    "关联模拟课堂：将学生沉默、错误回答、跑题或控场波动等模拟薄弱项，对照真实课堂事件设计下一次追问与反馈动作。"
  ];
}

function extractPriorTrainingLinks(currentDraft?: InternshipReflectionDraft) {
  return (
    currentDraft?.sections.find((section) => section.heading.includes("前序训练关联"))
      ?.bullets || []
  );
}

export function diagnoseInternshipReflectionDraft(
  draft: InternshipReflectionDraft,
  citations: StoredCitation[]
): InternshipReflectionDiagnostic {
  const text = renderInternshipReflectionText(draft);
  const evidenceBonus = Math.min(12, draft.evidence.length * 3);
  const citationBonus = citations.length ? 2 : 0;
  const dimensions: EvaluationDimension[] = [
    scoreDimension("证据质量", text, ["证据", "实习日志", "听课记录", "课堂事件", "观察", "记录", "板书"], "能够基于多来源课堂证据展开反思。", evidenceBonus),
    scoreDimension("问题分析", text, ["问题", "现象", "不足", "困难", "分析"], "能够发现并分析具体课堂问题。", 0),
    scoreDimension("原因分析", text, ["原因", "因为", "影响", "关联", "落差"], "能解释问题背后的教学原因。", 0),
    scoreDimension("理论连接", text, ["理论", "依据", "课标", "以学生为中心", "支架", "专业"], "能把课堂事实与教育理论或评价标准连接。", citationBonus),
    scoreDimension("改进闭环", text, ["改进", "下一次", "行动", "计划", "验证", "后续"], "改进动作较明确，便于下一轮实践验证。", 0),
    scoreDimension("师德师风", text, ["师德", "师风", "公平", "关怀", "尊重差异", "责任"], "能把专业反思与师德师风要求结合。", 0),
    scoreDimension("教师职业成长", text, ["职业成长", "专业成长", "实习教师", "观察学生", "教学行为", "验证改进"], "能把实习经历转化为教师职业成长路径。", 0)
  ].map((dimension) => ({
    ...dimension,
    score: Math.min(96, dimension.score)
  }));
  const overallScore = Math.round(
    dimensions.reduce((total, dimension) => total + dimension.score, 0) /
      dimensions.length
  );
  const weak = dimensions.filter((dimension) => dimension.score < 82);

  return {
    overallScore,
    dimensions,
    diagnosis: [
      weak.length
        ? `当前反思仍需重点强化：${weak.map((item) => item.name).join("、")}。`
        : "当前反思已经形成较完整的观察、诊断、改进闭环。",
      draft.evidence.length
        ? `已纳入 ${draft.evidence.length} 条课堂证据，覆盖实习日志、听课记录或课堂事件等来源。`
        : "当前缺少课堂证据，建议补充板书、听课记录或作业截图。"
    ],
    suggestions: [
      "把感受改写成“现象证据、原因分析、下次行动”三段式。",
      "每条问题至少对应一个课堂证据，避免空泛总结。",
      "把改进计划写成下一次实习可直接执行和检查的动作。",
      "补充教师职业成长、师德师风和网络育人边界，说明如何公平关怀学生并规范使用成果材料。"
    ],
    nextTask: "带着本次改进计划再观察一节课，并补充图片或记录证据验证变化。"
  };
}

export function internshipDiagnosticToEvaluation(
  conversationId: string,
  diagnostic: InternshipReflectionDiagnostic,
  citations: StoredCitation[]
): TrainingEvaluation {
  return {
    id: `eval_${randomUUID()}`,
    conversationId,
    trainingType: "实习反思",
    overallScore: diagnostic.overallScore,
    dimensions: diagnostic.dimensions,
    diagnosis: diagnostic.diagnosis,
    suggestions: diagnostic.suggestions,
    nextTask: diagnostic.nextTask,
    citations: citations.slice(0, 3),
    createdAt: new Date().toISOString()
  };
}

export function buildInternshipReflectionArtifact(
  draft: InternshipReflectionDraft
): ArtifactRequest {
  const safeDate = draft.input.internshipDate || "实习日期";
  const safeTopic = draft.input.subjectTopic || "课堂观察";

  return {
    name: `${safeDate}-${safeTopic}-实习反思.docx`,
    type: "docx",
    title: draft.title,
    content: [
      `实习学校/班级：${draft.input.schoolClass}`,
      `实习日期：${draft.input.internshipDate}`,
      `生成说明：${draft.sourceNote}`
    ].join("\n"),
    sections: draft.sections.map((section) => ({
      heading: section.heading,
      body: section.body,
      bullets: section.bullets
    }))
  };
}

export function renderInternshipReflectionText(draft: InternshipReflectionDraft) {
  return [
    draft.title,
    `实习学校/班级：${draft.input.schoolClass}`,
    `实习日期：${draft.input.internshipDate}`,
    `学科课题：${draft.input.subjectTopic}`,
    draft.sourceNote,
    ...draft.sections.map((section) =>
      [
        section.heading,
        section.body,
        ...(section.bullets || []).map((bullet) => `- ${bullet}`)
      ]
        .filter(Boolean)
        .join("\n")
    )
  ].join("\n\n");
}

function scoreDimension(
  name: string,
  text: string,
  signals: string[],
  strongComment: string,
  bonus: number
): EvaluationDimension {
  const matched = signals.filter((signal) => text.includes(signal)).length;
  const score = Math.max(68, Math.min(94, 70 + matched * 5 + bonus));

  return {
    name,
    score,
    comment:
      score >= 82 ? strongComment : `${name}还需要更具体，建议补充课堂证据和可执行细节。`
  };
}

function buildInternshipEvidence(
  input: InternshipReflectionInput,
  evidence: InternshipEvidenceItem[],
  citations: StoredCitation[]
) {
  const existing = evidence.map((item) => ({
    ...item,
    observationPoints: normalizeObservationPoints(item.observationPoints)
  }));
  const generated: InternshipEvidenceItem[] = [
    {
      id: `evidence_log_${randomUUID()}`,
      name: "实习日志片段",
      type: "text",
      summary: summarizeEvidenceText(
        `${input.internshipDate} ${input.schoolClass} ${input.subjectTopic}：${input.classroomSegment}`,
        "已从实习日志中提取课堂片段。"
      ),
      observationPoints: [
        "还原课堂发生的时间、对象和教学片段",
        "定位可用于反思的教师行为或学生反应"
      ]
    },
    {
      id: `evidence_observation_${randomUUID()}`,
      name: "听课记录要点",
      type: "text",
      summary: summarizeEvidenceText(
        `${input.observationFocus} ${input.personalFeeling}`,
        "已从听课记录中提取观察重点。"
      ),
      observationPoints: [
        `观察重点：${input.observationFocus}`,
        "连接实习教师现场感受和课堂观察事实"
      ]
    },
    {
      id: `evidence_event_${randomUUID()}`,
      name: "课堂事件与问题",
      type: "text",
      summary: summarizeEvidenceText(
        `${input.problems} ${input.improvementDirection}`,
        "已从课堂事件中提取问题和改进方向。"
      ),
      observationPoints: [
        `问题现象：${input.problems}`,
        `后续行动：${input.improvementDirection}`
      ]
    }
  ];

  if (citations[0]) {
    generated.push({
      id: `evidence_citation_${randomUUID()}`,
      name: "知识库理论依据",
      type: "document",
      summary: `${citations[0].documentName}：${citations[0].snippet}`,
      observationPoints: ["为反思中的理论连接和改进策略提供外部依据"]
    });
  }

  return [...existing, ...generated]
    .filter((item, index, all) => {
      const key = `${item.name}-${item.summary}`;
      return all.findIndex((candidate) => `${candidate.name}-${candidate.summary}` === key) === index;
    })
    .slice(0, 8);
}

function normalizeObservationPoints(points: string[]) {
  const nextPoints = points.filter((point) => point.trim()).slice(0, 5);
  return nextPoints.length
    ? nextPoints
    : ["提取课堂情境信息", "定位可反思的教学行为"];
}

function summarizeEvidenceText(text: string, fallback: string) {
  const compact = text.replace(/\s+/g, " ").trim();

  if (!compact) {
    return fallback;
  }

  return compact.length > 180 ? `${compact.slice(0, 180)}...` : compact;
}

function readEvidenceType(value: unknown): InternshipEvidenceItem["type"] {
  return value === "image" || value === "document" || value === "text"
    ? value
    : "text";
}

function readText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function ensureSentence(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  return /[。！？.!?]$/.test(trimmed) ? trimmed : `${trimmed}。`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
