import { randomUUID } from "node:crypto";
import type { ArtifactRequest } from "./artifactService.js";
import type {
  EvaluationDimension,
  StoredCitation,
  TrainingEvaluation
} from "./storage/chatRepository.js";

export type LessonPlanInput = {
  subject: string;
  grade: string;
  topic: string;
  duration: string;
  textbookContext: string;
  studentProfile: string;
  knowledgeBaseIds: string[];
  skills: string[];
};

export type LessonPlanSection = {
  heading: string;
  body?: string;
  bullets?: string[];
};

export type LessonPlanDraft = {
  title: string;
  input: LessonPlanInput;
  sections: LessonPlanSection[];
  sourceNote: string;
  version: number;
  createdAt: string;
};

export type LessonPlanDiagnostic = {
  overallScore: number;
  dimensions: EvaluationDimension[];
  diagnosis: string[];
  suggestions: string[];
  nextTask: string;
};

export type LessonPlanComparisonDimension =
  | "目标"
  | "学情"
  | "活动"
  | "评价"
  | "育人融入";

export type LessonPlanComparisonItem = {
  dimension: LessonPlanComparisonDimension;
  before: string;
  after: string;
  improvement: string;
};

export type LessonPlanComparison = {
  summary: string;
  items: LessonPlanComparisonItem[];
  evidence: string[];
};

const defaultLessonPlanInput: LessonPlanInput = {
  subject: "语文",
  grade: "小学五年级",
  topic: "草船借箭",
  duration: "1课时",
  textbookContext: "统编版教材相关课文或教师提供的知识点",
  studentProfile: "学生具备基础阅读能力，但对文本人物形象、情节推进和历史语境的理解需要支架。",
  knowledgeBaseIds: [],
  skills: ["minimaxskill"]
};

export function normalizeLessonPlanInput(value: unknown): LessonPlanInput {
  const record = isRecord(value) ? value : {};

  return {
    subject: readText(record.subject, defaultLessonPlanInput.subject),
    grade: readText(record.grade, defaultLessonPlanInput.grade),
    topic: readText(record.topic, defaultLessonPlanInput.topic),
    duration: readText(record.duration, defaultLessonPlanInput.duration),
    textbookContext: readText(
      record.textbookContext,
      defaultLessonPlanInput.textbookContext
    ),
    studentProfile: readText(record.studentProfile, defaultLessonPlanInput.studentProfile),
    knowledgeBaseIds: Array.isArray(record.knowledgeBaseIds)
      ? record.knowledgeBaseIds.filter((item): item is string => typeof item === "string")
      : [],
    skills: normalizeLessonPlanSkills(record.skills)
  };
}

export function buildLessonPlanSearchQuery(input: LessonPlanInput) {
  return [
    input.subject,
    input.grade,
    input.topic,
    input.textbookContext,
    input.studentProfile,
    "课程标准 教学目标 学情分析 教学活动"
  ]
    .filter(Boolean)
    .join(" ");
}

export function generateLessonPlanDraft(
  input: LessonPlanInput,
  citations: StoredCitation[],
  version = 1
): LessonPlanDraft {
  const referenceLine = citations.length
    ? `已结合 ${citations.length} 条知识库片段，生成时优先参考课程标准、课例或教材资料。`
    : "未引用知识库资料，以下内容使用师范生实训演示默认框架生成，可继续补充课程标准或教材资料。";
  const skillLine = buildSkillSourceNote(input.skills);
  const activityFocus = inferActivityFocus(input);
  const blueprint = buildLessonPlanBlueprint(input, activityFocus);

  return {
    title: `${input.subject}《${input.topic}》教案`,
    input,
    version,
    createdAt: new Date().toISOString(),
    sourceNote: `${referenceLine}${skillLine}`,
    sections: [
      {
        heading: "一、教学目标",
        bullets: blueprint.objectives
      },
      {
        heading: "二、学情分析",
        body: `${input.grade}学生处于从已有经验走向学科化表达的阶段。${ensureSentence(input.studentProfile)}本课需要通过问题链、合作交流、课堂支架和即时评价降低理解难度。`
      },
      {
        heading: "三、教学重难点",
        bullets: blueprint.keyDifficulties
      },
      {
        heading: "四、教学准备",
        bullets: [
          `教师准备：${input.textbookContext}、任务单、板书框架、分层追问和课堂评价语。`,
          blueprint.studentPreparation
        ]
      },
      {
        heading: "五、教学过程",
        body: blueprint.process.join("\n")
      },
      {
        heading: "六、课堂提问与预设回答",
        bullets: blueprint.questions
      },
      {
        heading: "七、板书设计",
        body: blueprint.blackboard
      },
      {
        heading: "八、作业设计",
        bullets: blueprint.homework
      },
      {
        heading: "九、教学反思建议",
        bullets: blueprint.reflection
      },
      {
        heading: "十、师德育人融入点",
        body: blueprint.moralEducation,
        bullets: [
          `育人目标：围绕《${input.topic}》把学科理解、责任意识、合作表达和尊重证据统一到课堂任务中。`,
          "师德师风：教师通过公平提问、等待时间、鼓励性反馈和差异化支架，保证不同基础学生都有被看见和被支持的机会。",
          "网络育人延展：优秀学习成果可在班级空间或易班社群中作正向展示，引导学生规范表达、理性互评、尊重原创和事实依据。"
        ]
      }
    ]
  };
}

export function refineLessonPlanDraft(
  input: LessonPlanInput,
  currentDraft: LessonPlanDraft | undefined,
  citations: StoredCitation[]
) {
  const currentDiagnostic = currentDraft
    ? diagnoseLessonPlanDraft(currentDraft, citations)
    : undefined;
  const weakDimensions =
    currentDiagnostic?.dimensions
      .filter((dimension) => dimension.score < 84)
      .map((dimension) => dimension.name) || [];
  const draft = generateLessonPlanDraft(
    input,
    citations,
    Math.max(2, (currentDraft?.version || 1) + 1)
  );
  const processSection = draft.sections.find((section) => section.heading.includes("教学过程"));

  if (processSection?.body) {
    processSection.body = `${processSection.body}\n6. 即时评价：用“目标达成、证据表达、合作参与”三个维度进行课堂反馈。\n7. 针对薄弱项二次调整：${buildRefinementActionLine(weakDimensions, input)}。`;
  }

  draft.sections.push({
    heading: "十一、诊断问题对应优化说明",
    bullets: buildRefinementNotes(weakDimensions, input, citations)
  });
  draft.sourceNote = `${draft.sourceNote} 本版本已根据诊断建议强化目标达成、互动预设、评价闭环和反思改进。`;
  return draft;
}

export function diagnoseLessonPlanDraft(
  draft: LessonPlanDraft,
  citations: StoredCitation[]
): LessonPlanDiagnostic {
  const text = renderLessonPlanText(draft);
  const dimensions: EvaluationDimension[] = [
    scoreDimension("教学目标", text, ["知识与能力", "过程与方法", "情感态度", "达成"], "目标维度完整，能支持活动和评价设计。"),
    scoreDimension("学情分析", text, ["学生", "已有经验", "困难", "支架", "学情"], "能联系学生基础和学习困难。"),
    scoreDimension("活动流程", text, ["导入", "初读", "精读", "展示", "总结", "评价"], "教学流程清楚，课堂推进较完整。"),
    scoreDimension("课堂互动", text, ["问题", "追问", "预设", "小组", "交流"], "有提问、追问和预设回答，互动设计可演示。"),
    scoreDimension("反思改进", text, ["反思", "记录", "复盘", "优化", "下一轮"], "能把课堂观察转化为改进动作。"),
    scoreDimension("师德育人", text, ["师德", "育人", "育人目标", "网络育人", "公平", "关怀", "鼓励", "责任", "合作"], "能自然融入价值引导、教师关怀和网络育人延展。")
  ].map((dimension) => ({
    ...dimension,
    score: Math.min(96, dimension.score + (citations.length ? 3 : 0))
  }));
  const overallScore = Math.round(
    dimensions.reduce((total, dimension) => total + dimension.score, 0) /
      dimensions.length
  );
  const weak = dimensions.filter((dimension) => dimension.score < 82);
  const defaultedFields = findDefaultedLessonFields(draft.input);

  return {
    overallScore,
    dimensions,
    diagnosis: [
      weak.length
        ? `当前教案仍需重点优化：${weak.map((item) => item.name).join("、")}。`
        : "当前教案结构完整，已经具备比赛演示所需的生成与诊断闭环。",
      citations.length
        ? `已引用 ${citations.length} 条知识库资料，能够体现 RAG 支撑。`
        : "当前未引用知识库资料，建议上传课程标准或优秀课例后再生成一版。",
      defaultedFields.length
        ? `以下输入仍使用默认值或偏泛化：${defaultedFields.join("、")}，建议补充真实课程信息。`
        : "学科、年级、课题、课时、教材背景、学情、知识库和技能等关键输入已形成完整生成上下文。"
    ],
    suggestions: buildLessonPlanSuggestions(weak, citations, defaultedFields),
    nextTask: "按诊断建议优化一版教案，并导出 Word 作为实训成果。"
  };
}

export function lessonDiagnosticToEvaluation(
  conversationId: string,
  diagnostic: LessonPlanDiagnostic,
  citations: StoredCitation[]
): TrainingEvaluation {
  return {
    id: `eval_${randomUUID()}`,
    conversationId,
    trainingType: "教案诊断",
    overallScore: diagnostic.overallScore,
    dimensions: diagnostic.dimensions,
    diagnosis: diagnostic.diagnosis,
    suggestions: diagnostic.suggestions,
    nextTask: diagnostic.nextTask,
    citations: citations.slice(0, 3),
    createdAt: new Date().toISOString()
  };
}

export function compareLessonPlanDrafts({
  previousDraft,
  currentDraft,
  diagnostic,
  citations
}: {
  previousDraft?: LessonPlanDraft;
  currentDraft: LessonPlanDraft;
  diagnostic: LessonPlanDiagnostic;
  citations: StoredCitation[];
}): LessonPlanComparison {
  const weakDimensionNames = diagnostic.dimensions
    .filter((dimension) => dimension.score < 84)
    .map((dimension) => dimension.name);
  const comparisonItems: LessonPlanComparisonItem[] = [
    buildComparisonItem({
      dimension: "目标",
      previousDraft,
      currentDraft,
      headingPattern: /教学目标/,
      fallbackBefore: "初稿已建立三维目标，但目标、活动和评价之间的对应关系仍需在优化稿中继续压实。",
      fallbackAfter: "优化稿将目标改写为可观察的学习表现，并在课堂任务和评价环节中回扣目标达成。",
      improvement: weakDimensionNames.includes("教学目标")
        ? "回应诊断中“教学目标”薄弱项，把目标转化为学生能说、能做、能展示的结果。"
        : "保留已有目标结构，进一步强化目标与课堂证据的对应。"
    }),
    buildComparisonItem({
      dimension: "学情",
      previousDraft,
      currentDraft,
      headingPattern: /学情分析/,
      fallbackBefore: "初稿能描述学生基础，但对常见误区、学习支架和差异支持仍偏概括。",
      fallbackAfter: "优化稿补充已有经验、可能困难、课堂支架和差异化追问，让设计更贴近真实学生。",
      improvement: weakDimensionNames.includes("学情分析")
        ? "针对诊断中的学情不足，增加学生基础、误区和支架安排。"
        : "继续把学生画像作为活动设计和追问设计的依据。"
    }),
    buildComparisonItem({
      dimension: "活动",
      previousDraft,
      currentDraft,
      headingPattern: /教学过程/,
      fallbackBefore: "初稿已形成导入、探究、练习和总结流程，但部分环节的学生产出和时间安排可再明确。",
      fallbackAfter: "优化稿补充活动任务、时间节奏、学生产出、追问和即时反馈，形成更可执行的课堂流程。",
      improvement: weakDimensionNames.includes("活动流程")
        ? "直接回应活动流程薄弱项，补足任务、产出和课堂推进证据。"
        : "让活动从流程描述升级为可观察、可复盘的训练任务。"
    }),
    buildComparisonItem({
      dimension: "评价",
      previousDraft,
      currentDraft,
      headingPattern: /作业设计|课堂提问|诊断问题对应优化说明/,
      fallbackBefore: "初稿包含作业和提问，但评价标准与目标达成之间的闭环还不够显性。",
      fallbackAfter: "优化稿加入目标达成、证据表达、合作参与等评价维度，并把反馈写入课堂过程。",
      improvement: "标注评价闭环，把课堂即时评价、作业评价和诊断建议连接起来。"
    }),
    buildComparisonItem({
      dimension: "育人融入",
      previousDraft,
      currentDraft,
      headingPattern: /师德育人/,
      fallbackBefore: "初稿已设置育人融入点，但可能停留在价值表述，和具体课堂行为连接不够紧。",
      fallbackAfter: "优化稿把公平提问、鼓励性评价、同伴互助和尊重证据写入课堂行为。",
      improvement: weakDimensionNames.includes("师德育人")
        ? "回应师德育人薄弱项，让育人目标从口号落到教师提问、反馈和支持差异的动作。"
        : "保持育人主线，并把它嵌入学生合作和教师评价。"
    })
  ];
  const citationEvidence = citations.length
    ? `知识库证据：本轮引用 ${citations.length} 条资料，主要来自 ${[
        ...new Set(citations.map((citation) => citation.documentName))
      ]
        .slice(0, 3)
        .join("、")}。`
    : "知识库证据：本轮未引用知识库资料，建议补充课程标准、教材页或优秀课例后再次优化。";

  return {
    summary: previousDraft
      ? `V${previousDraft.version} -> V${currentDraft.version} 已完成目标、学情、活动、评价、育人融入五类优化标注，优化内容与诊断建议保持对应。`
      : `V${currentDraft.version} 已建立教案初稿基线，并标注后续可围绕目标、学情、活动、评价、育人融入继续优化。`,
    items: comparisonItems,
    evidence: [
      `诊断证据：综合得分 ${diagnostic.overallScore}，最低维度为 ${getWeakestDimensionName(diagnostic)}。`,
      citationEvidence,
      `版本证据：当前教案为 V${currentDraft.version}，生成时间 ${currentDraft.createdAt}。`
    ]
  };
}

export function buildLessonPlanArtifact(draft: LessonPlanDraft): ArtifactRequest {
  const safeSubject = draft.input.subject || "学科";
  const safeTopic = draft.input.topic || "课题";

  return {
    name: `${safeSubject}-${safeTopic}-教案.docx`,
    type: "docx",
    title: draft.title,
    content: [
      `学段/年级：${draft.input.grade}`,
      `课时：${draft.input.duration}`,
      `生成技能：${formatLessonPlanSkills(draft.input.skills || [])}`,
      `生成说明：${draft.sourceNote}`
    ].join("\n"),
    sections: draft.sections.map((section) => ({
      heading: section.heading,
      body: section.body,
      bullets: section.bullets
    }))
  };
}

export function renderLessonPlanText(draft: LessonPlanDraft) {
  return [
    draft.title,
    `学科：${draft.input.subject}`,
    `年级：${draft.input.grade}`,
    `课时：${draft.input.duration}`,
    `生成技能：${formatLessonPlanSkills(draft.input.skills || [])}`,
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
  strongComment: string
): EvaluationDimension {
  const matched = signals.filter((signal) => text.includes(signal)).length;
  const score = Math.max(68, Math.min(94, 70 + matched * 5));

  return {
    name,
    score,
    comment:
      score >= 82 ? strongComment : `${name}还需要更具体，建议在优化版中补足证据和操作细节。`
  };
}

function inferActivityFocus(input: LessonPlanInput) {
  if (/语文|课文|阅读|古诗|小说/.test(`${input.subject}${input.textbookContext}`)) {
    return "人物形象、情节线索和文本证据";
  }

  if (/数学|公式|计算|图形/.test(`${input.subject}${input.textbookContext}`)) {
    return "概念理解、方法迁移和错因分析";
  }

  return "核心问题、学习任务和表达证据";
}

function buildLessonPlanBlueprint(input: LessonPlanInput, activityFocus: string) {
  if (/数学|函数|分数|几何|代数|计算/.test(`${input.subject}${input.topic}${input.textbookContext}`)) {
    return {
      objectives: [
        `知识与能力：理解《${input.topic}》的核心概念，能用图示、语言和例子说明概念含义。`,
        "过程与方法：经历观察情境、提出猜想、比较辨析和归纳表达的过程，形成数学抽象与推理意识。",
        "情感态度与价值观：在同伴交流中尊重不同思路，体验用数学语言解释生活现象的价值。"
      ],
      keyDifficulties: [
        `教学重点：理解《${input.topic}》中的关键概念、表示方式和适用条件。`,
        "教学难点：区分相似概念或常见误区，并能说清判断依据。"
      ],
      studentPreparation: "学生准备：回忆生活中平均分、比较和表示数量关系的经验，准备一个可解释的生活例子。",
      process: [
        `1. 导入新课（5分钟）：用生活情境引出《${input.topic}》，让学生先用自己的话描述问题。`,
        `2. 操作感知（8分钟）：借助图形、实物或数轴呈现“${activityFocus}”，记录学生初始想法。`,
        "3. 概念建构（12分钟）：组织学生比较正确例子与反例，追问“为什么可以这样表示”。",
        "4. 分层练习（10分钟）：基础题检查概念理解，变式题暴露误区，小组互评说明理由。",
        "5. 总结提升（5分钟）：教师和学生共同归纳概念条件、表达方式和易错点。"
      ],
      questions: [
        `问题1：这个情境中哪些条件说明可以使用《${input.topic}》的概念？预设：学生能说出现象，但可能漏掉关键条件。`,
        "追问：如果少了这个条件，结论还成立吗？请举一个反例说明。",
        "问题2：你能用图示、算式和一句话分别解释自己的判断吗？预设：基础薄弱学生可能只能给出算式，需要教师补支架。"
      ],
      blackboard: `${input.topic}\n生活情境 -> 操作图示 -> 关键条件 -> 数学表达\n易错提醒：先判断条件，再写结论；先说依据，再做计算`,
      homework: [
        "基础作业：完成 3 道概念判断题，并圈出判断依据。",
        "提升作业：自选一个生活情境，用图示和语言解释本课概念。",
        "拓展作业：设计一道容易出错的题，并写出错因提醒。"
      ],
      reflection: [
        "观察学生是否能同时说出结论和依据。",
        "记录学生在哪类反例中最容易出错，下一轮优化问题链。",
        "复盘板书是否帮助学生从生活语言过渡到数学语言。"
      ],
      moralEducation: "教师在课堂中关注不同基础学生的表达机会，用鼓励性评价支持学生敢于暴露思路；通过同伴互助和错因分析，引导学生形成严谨、合作、尊重证据的学习品质。课后可将规范表达、错因提醒或优秀解法整理为班级空间/易班社群资源，延展网络育人价值。"
    };
  }

  if (/语文|课文|阅读|古诗|小说/.test(`${input.subject}${input.textbookContext}`)) {
    return {
      objectives: [
        `知识与能力：理解《${input.topic}》的核心内容，能够提取关键情节和重要信息。`,
        "过程与方法：通过朗读、圈画、讨论和任务探究，学习围绕问题分析文本的方法。",
        "情感态度与价值观：在文本学习中体会人物品质，形成积极的学习态度和责任意识。"
      ],
      keyDifficulties: [
        `教学重点：把握《${input.topic}》的主要内容、结构线索和关键语句。`,
        "教学难点：引导学生用文本证据解释人物行为、情节推进和主题意义。"
      ],
      studentPreparation: "学生准备：预习文本，标注不理解的词句，尝试概括主要内容。",
      process: [
        `1. 导入新课：用情境问题引出课题《${input.topic}》，激活学生已有经验。`,
        "2. 初读感知：学生快速阅读文本，完成“人物、事件、结果”信息提取。",
        `3. 精读探究：围绕“${activityFocus}”组织小组讨论，要求学生用文本证据说明观点。`,
        "4. 展示交流：小组代表汇报，教师追问观点依据，引导学生修正表达。",
        "5. 总结提升：回扣教学目标，形成课堂小结，并迁移到新的阅读任务。"
      ],
      questions: [
        `问题1：课文中哪些细节最能体现《${input.topic}》的核心矛盾？预设：学生能找到关键情节，但理由可能较笼统。`,
        "追问：你能从具体词句中找到依据吗？这个细节说明了什么？",
        "问题2：如果换一个人物视角讲述，故事重点会发生什么变化？预设：学生能表达初步想法，教师引导其关注文本证据。"
      ],
      blackboard: `${input.topic}\n主要人物 -> 关键事件 -> 文本证据 -> 品质/主题\n学习方法：读文本、找依据、说理由`,
      homework: [
        "基础作业：整理本课关键词句，完成主要内容概括。",
        "提升作业：选择一个人物，写一段有文本依据的人物评价。",
        "拓展作业：搜集相关背景资料，说明它如何帮助理解课文。"
      ],
      reflection: [
        "观察学生是否能从“说感受”转向“用证据说明”。",
        "记录课堂追问中学生卡住的位置，下一轮优化问题链和任务单。",
        "复盘板书是否帮助学生形成结构化理解。"
      ],
      moralEducation: "教师在课堂中关注不同学生的表达机会，用鼓励性评价保护学生探究兴趣；同时结合文本主题，引导学生理解责任、合作与智慧解决问题的价值。课后可引导学生在班级空间/易班社群中发布规范阅读札记，学会尊重文本证据和同伴观点。"
    };
  }

  return {
    objectives: [
      `知识与能力：理解《${input.topic}》的核心概念、关键问题和基本方法。`,
      "过程与方法：通过问题探究、小组合作和证据表达，形成分析与解决问题的能力。",
      "情感态度与价值观：在真实任务中形成责任意识、合作意识和反思意识。"
    ],
    keyDifficulties: [
      `教学重点：把握《${input.topic}》的关键知识和学习任务。`,
      "教学难点：引导学生用证据说明观点，并把学习结果迁移到新情境。"
    ],
    studentPreparation: "学生准备：回顾已有知识，准备一个与课题相关的问题或例子。",
    process: [
      `1. 情境导入：围绕《${input.topic}》提出真实问题，激活已有经验。`,
      `2. 任务探究：围绕“${activityFocus}”组织个人思考和同伴交流。`,
      "3. 证据表达：学生展示观点，教师追问依据并补充关键支架。",
      "4. 评价反馈：按目标达成、合作参与和表达证据进行即时评价。",
      "5. 总结迁移：归纳本课方法，并布置迁移任务。"
    ],
    questions: [
      `问题1：解决《${input.topic}》这个任务需要先抓住什么关键点？`,
      "追问：你这样判断的依据是什么？有没有反例或补充证据？",
      "问题2：如果换一个情境，这个方法还适用吗？为什么？"
    ],
    blackboard: `${input.topic}\n情境问题 -> 核心任务 -> 证据表达 -> 方法迁移\n评价：目标达成、合作参与、反思改进`,
    homework: [
      "基础作业：整理本课关键词和核心方法。",
      "提升作业：完成一个迁移任务，并说明解决依据。",
      "拓展作业：记录一个仍有疑问的问题，下一课交流。"
    ],
    reflection: [
      "观察学生是否能用证据支撑观点。",
      "记录活动组织和评价反馈是否对应教学目标。",
      "复盘任务难度是否适合当前学情。"
    ],
    moralEducation: "教师通过公平提问、同伴互助和过程性评价，支持每位学生参与学习；同时引导学生在真实问题中形成责任、合作和持续改进意识。课后可把学生成果转化为班级空间/易班社群的正向展示材料，强调规范表达、理性互评和网络育人责任。"
  };
}

function buildRefinementActionLine(weakDimensions: string[], input: LessonPlanInput) {
  if (!weakDimensions.length) {
    return "保留原有结构，进一步压实学生可观察表现、课堂追问和评价证据";
  }

  return weakDimensions
    .map((name) => {
      if (name.includes("目标")) {
        return "把目标改写为学生能说、能做、能展示的学习结果";
      }
      if (name.includes("学情")) {
        return `针对${input.grade}学生基础补充支架和易错提醒`;
      }
      if (name.includes("活动")) {
        return "给每个活动补充时间、任务、产出和评价标准";
      }
      if (name.includes("互动")) {
        return "增加追问、同伴补充和错误答案引导";
      }
      if (name.includes("反思")) {
        return "把课堂观察转化为下一轮可执行改进任务";
      }
      if (name.includes("师德")) {
        return "补充育人目标、公平提问、鼓励性评价和网络育人价值引导";
      }

      return `补强${name}`;
    })
    .join("；");
}

function buildRefinementNotes(
  weakDimensions: string[],
  input: LessonPlanInput,
  citations: StoredCitation[]
) {
  const dimensions = weakDimensions.length
    ? weakDimensions
    : ["教学目标", "课堂互动", "反思改进"];

  return [
    ...dimensions.map((dimension) => `${dimension}：${buildRefinementActionLine([dimension], input)}。`),
    citations.length
      ? `知识库引用：保留 ${citations.length} 条资料依据，优化版继续围绕课程标准和课例证据展开。`
      : "知识库引用：当前未接入资料，建议补充课程标准或优秀课例后再生成参照版。",
    `闭环说明：本优化稿已把诊断薄弱项写入教学过程、评价反馈和反思建议，便于后续导出 Word 并进入成长档案。`
  ];
}

function buildLessonPlanSuggestions(
  weakDimensions: EvaluationDimension[],
  citations: StoredCitation[],
  defaultedFields: string[]
) {
  const suggestions = weakDimensions.map((dimension) => {
    if (dimension.name.includes("目标")) {
      return "把教学目标改写成可观察、可评价的学生表现，并在评价环节逐项回应。";
    }
    if (dimension.name.includes("学情")) {
      return "补充学生已有基础、常见误区和学习支架，避免只写泛化学情。";
    }
    if (dimension.name.includes("活动")) {
      return "在教学过程中补充时间分配、学生任务、产出形式和评价标准。";
    }
    if (dimension.name.includes("互动")) {
      return "补充教师追问、学生可能回答、错误答案引导和同伴互评。";
    }
    if (dimension.name.includes("反思")) {
      return "把课堂观察点转化为下一轮可执行改进任务。";
    }
    if (dimension.name.includes("师德")) {
      return "在活动与评价中体现育人目标、公平提问、尊重差异、网络育人和学科育人价值。";
    }

    return `继续补强${dimension.name}。`;
  });

  if (!suggestions.length) {
    suggestions.push("保持当前结构，导出前检查板书、作业和反思是否与教学目标一致。");
  }

  if (!citations.length) {
    suggestions.push("补充课程标准、教材页或优秀课例到知识库，再生成一版有引用依据的教案。");
  }

  if (defaultedFields.length) {
    suggestions.push(`补充真实${defaultedFields.join("、")}，让诊断和优化更贴合课堂。`);
  }

  return suggestions.slice(0, 5);
}

function buildComparisonItem({
  dimension,
  previousDraft,
  currentDraft,
  headingPattern,
  fallbackBefore,
  fallbackAfter,
  improvement
}: {
  dimension: LessonPlanComparisonDimension;
  previousDraft?: LessonPlanDraft;
  currentDraft: LessonPlanDraft;
  headingPattern: RegExp;
  fallbackBefore: string;
  fallbackAfter: string;
  improvement: string;
}): LessonPlanComparisonItem {
  return {
    dimension,
    before: summarizeLessonPlanSection(previousDraft, headingPattern, fallbackBefore),
    after: summarizeLessonPlanSection(currentDraft, headingPattern, fallbackAfter),
    improvement
  };
}

function summarizeLessonPlanSection(
  draft: LessonPlanDraft | undefined,
  headingPattern: RegExp,
  fallback: string
) {
  if (!draft) {
    return fallback;
  }

  const section = draft.sections.find((item) => headingPattern.test(item.heading));
  const text = [
    section?.body,
    ...(section?.bullets || [])
  ]
    .filter(Boolean)
    .join(" ");

  return summarizeText(text || fallback, 96);
}

function getWeakestDimensionName(diagnostic: LessonPlanDiagnostic) {
  return [...diagnostic.dimensions].sort((a, b) => a.score - b.score)[0]?.name || "暂无";
}

function summarizeText(value: string, maxLength: number) {
  const text = value.replace(/\s+/g, " ").trim();

  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function findDefaultedLessonFields(input: LessonPlanInput) {
  const pairs: Array<[string, string, string]> = [
    ["学科", input.subject, defaultLessonPlanInput.subject],
    ["年级", input.grade, defaultLessonPlanInput.grade],
    ["课题", input.topic, defaultLessonPlanInput.topic],
    ["课时", input.duration, defaultLessonPlanInput.duration],
    ["教材背景", input.textbookContext, defaultLessonPlanInput.textbookContext],
    ["学情", input.studentProfile, defaultLessonPlanInput.studentProfile]
  ];
  const defaulted = pairs
    .filter(([, value, fallback]) => value.trim() === fallback.trim())
    .map(([label]) => label);

  if (!input.knowledgeBaseIds.length) {
    defaulted.push("知识库");
  }

  if (!input.skills.length) {
    defaulted.push("技能");
  }

  return defaulted;
}

function readText(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeLessonPlanSkills(value: unknown) {
  const skills = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : defaultLessonPlanInput.skills;
  const normalized = Array.from(new Set(skills.map((item) => item.trim().toLowerCase())));

  return normalized.includes("minimaxskill")
    ? normalized
    : ["minimaxskill", ...normalized];
}

function formatLessonPlanSkills(skills: string[]) {
  return skills.length ? skills.join("、") : "未启用专用技能";
}

function buildSkillSourceNote(skills: string[]) {
  return skills.includes("minimaxskill")
    ? " 已启用 minimaxskill 教案生成技能，用于增强结构化生成、诊断式优化和 Word 成果输出。"
    : "";
}

function ensureSentence(value: string) {
  return /[。！？.!?]$/.test(value) ? value : `${value}。`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
