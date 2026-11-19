import type {
  AnswerQuality,
  ClassroomMetrics,
  ClassroomState,
  QuestionKind,
  StudentAnswerPlan,
  StudentAnswerGenerationMode,
  StudentAgent,
  StudentReaction,
  TeacherActionAnalysis
} from "./classroomTypes.js";
import type { LlmProvider } from "./llmProvider.js";

type ReactionResult = {
  students: StudentAgent[];
  metrics: ClassroomMetrics;
  reactions: StudentReaction[];
};

type GenerateReactionOptions = {
  targetStudentId?: string;
  targetOnly?: boolean;
};

export function generateStudentReactions(
  state: ClassroomState,
  teacherText: string,
  action: TeacherActionAnalysis,
  llmProvider: LlmProvider,
  options: GenerateReactionOptions = {}
): Promise<ReactionResult> {
  const students = state.students.map((student) => ({ ...student }));
  const metrics = { ...state.metrics };
  const text = teacherText.trim();

  applyMetricShift(metrics, action, state);
  const reactions = planStudentResponses({
    students,
    metrics,
    state,
    teacherText: text,
    action,
    options
  });

  return enhanceStudentResponsesWithLlm({
    llmProvider,
    state,
    teacherText: text,
    action,
    students,
    reactions
  }).then((enhancedReactions) => ({
    students,
    metrics: clampMetrics(metrics),
    reactions: enhancedReactions
  }));
}

function planStudentResponses({
  students,
  metrics,
  state,
  teacherText,
  action,
  options
}: {
  students: StudentAgent[];
  metrics: ClassroomMetrics;
  state: ClassroomState;
  teacherText: string;
  action: TeacherActionAnalysis;
  options: GenerateReactionOptions;
}) {
  const baseResponders = options.targetOnly && options.targetStudentId
    ? students.filter((student) => student.id === options.targetStudentId).slice(0, 1)
    : selectUniversalResponders(students, state, teacherText, action);
  const driftStudent = findScriptedDriftStudent({ students, state, action, options });
  const responders =
    driftStudent && !baseResponders.some((student) => student.id === driftStudent.id)
      ? [...baseResponders, driftStudent]
      : baseResponders;
  const reactions: StudentReaction[] = [];

  for (const student of responders) {
    const isDrift = driftStudent?.id === student.id;
    const answerQuality: AnswerQuality = isDrift
      ? "off_topic"
      : inferUniversalResponseQuality(student, state, teacherText, action);
    const content = isDrift
      ? scriptedDriftContent(state, teacherText) ||
        buildPersonaFallbackResponse({ student, state, teacherText, action, answerQuality })
      : buildPersonaFallbackResponse({
          student,
          state,
          teacherText,
          action,
          answerQuality
        });
    const eventType = eventTypeForResponse(action, answerQuality, options.targetOnly);
    const triggeredBy = options.targetOnly ? "点名后的课堂回应" : `教师${describeAction(action.actionType)}`;

    pushReaction(
      reactions,
      student,
      content,
      eventType,
      buildDynamicAgentReason(student, action, answerQuality, state),
      triggeredBy,
      {
        answerQuality,
        questionKind: action.questionKind,
        topicKeywords: action.topicKeywords
      }
    );
    student.currentStatus = statusForAnswerQuality(answerQuality);
    applyAnswerQualityMetrics(metrics, answerQuality, action);
  }

  if (driftStudent) {
    const driftReaction = reactions.find(
      (reaction) => reaction.studentId === driftStudent.id
    );

    if (driftReaction) {
      driftReaction.scripted = true;
    }
  }

  applyAmbientReactions({ students, responders, state, teacherText });

  return reactions;
}

const AMBIENT_REACTIONS: Record<StudentAgent["type"], string[]> = {
  top_student: [
    "边听边整理思路，准备补充例子。",
    "点头跟随，已经在心里给出答案。"
  ],
  weak_student: [
    "跟着课题慢慢想，还有点拿不准。",
    "低头记了一下关键词，表情不太确定。"
  ],
  silent_student: [
    "安静听讲，没有举手。",
    "目光跟随教师，暂时没有表达。"
  ],
  naughty_student: [
    "走神了一下，被提醒后回头看黑板。",
    "摆弄笔袋，余光还在听。"
  ],
  misunderstanding_student: [
    "皱着眉，对刚才的说法有点犹豫。",
    "小声嘀咕，似乎还按自己的理解在想。"
  ]
};

function applyAmbientReactions({
  students,
  responders,
  state,
  teacherText
}: {
  students: StudentAgent[];
  responders: StudentAgent[];
  state: ClassroomState;
  teacherText: string;
}) {
  const responderIds = new Set(responders.map((student) => student.id));

  for (const student of students) {
    if (responderIds.has(student.id)) {
      continue;
    }

    const seed = stableResponseSeed(
      `${state.turnCount}:${teacherText}:${student.id}:ambient`
    );
    const options = AMBIENT_REACTIONS[student.type];

    student.lastReaction = options[Math.abs(seed) % options.length];

    if (student.currentStatus === "distracted" && seed % 3 !== 0) {
      student.currentStatus = "focused";
    } else if (student.currentStatus === "silent" && seed % 2 === 0) {
      student.currentStatus = "focused";
    }
  }
}

function findScriptedDriftStudent({
  students,
  state,
  action,
  options
}: {
  students: StudentAgent[];
  state: ClassroomState;
  action: TeacherActionAnalysis;
  options: GenerateReactionOptions;
}): StudentAgent | undefined {
  if (options.targetOnly) {
    return undefined;
  }

  if (!isQuestionLike(action)) {
    return undefined;
  }

  if (state.turnCount < 2) {
    return undefined;
  }

  if (state.events.some((event) => event.type === "off_topic")) {
    return undefined;
  }

  return students.find((student) => student.type === "naughty_student");
}

function scriptedDriftContent(
  state: ClassroomState,
  teacherText: string
): string | undefined {
  const mentionsApple =
    state.topic.includes("苹果") ||
    teacherText.includes("苹果") ||
    state.timeline.some(
      (item) => item.role === "teacher" && item.content.includes("苹果")
    );

  if (!mentionsApple) {
    return undefined;
  }

  return "老师，那如果把苹果吃掉一口，剩下的部分还能不能用分数表示？";
}

function selectUniversalResponders(
  students: StudentAgent[],
  state: ClassroomState,
  teacherText: string,
  action: TeacherActionAnalysis
) {
  const recentSpeakerIds = new Set(
    state.timeline
      .slice(-8)
      .filter((item) => item.role === "student" && item.studentId)
      .map((item) => item.studentId)
  );
  const desiredCount = responseCountFor(action, teacherText);

  return [...students]
    .sort((left, right) => {
      const leftRecentPenalty = recentSpeakerIds.has(left.id) ? 34 : 0;
      const rightRecentPenalty = recentSpeakerIds.has(right.id) ? 34 : 0;
      const leftScore =
        responseContextScore(left, state, action, teacherText) +
        responsePriority(left) * 18 +
        nameMentionBonus(left, teacherText) -
        leftRecentPenalty;
      const rightScore =
        responseContextScore(right, state, action, teacherText) +
        responsePriority(right) * 18 +
        nameMentionBonus(right, teacherText) -
        rightRecentPenalty;

      return rightScore - leftScore;
    })
    .slice(0, desiredCount);
}

function responseCountFor(action: TeacherActionAnalysis, teacherText: string) {
  if (["greeting", "casual", "ambiguous", "transition", "management"].includes(action.actionType)) {
    return 1;
  }

  const asksWholeClass = /同学们|大家|谁来|哪位|还有谁|补充一下|其他同学/.test(teacherText);
  const asksForOne = /谁来|哪位|请.*同学|请你/.test(teacherText) && !/还有谁|补充|其他同学/.test(teacherText);

  if (asksForOne) {
    return 1;
  }

  if (asksWholeClass || action.difficultyLevel === "hard" || action.actionType === "instruction") {
    return 2;
  }

  return 1;
}

function inferUniversalResponseQuality(
  student: StudentAgent,
  state: ClassroomState,
  teacherText: string,
  action: TeacherActionAnalysis
): AnswerQuality {
  if (isQuestionLike(action)) {
    return inferDynamicAnswerQuality(student, state, teacherText, action);
  }

  if (action.actionType === "explanation" && (student.currentStatus === "confused" || action.clarity < 62)) {
    return "partial";
  }

  return "acknowledgement";
}

function eventTypeForResponse(
  action: TeacherActionAnalysis,
  answerQuality: AnswerQuality,
  targetOnly?: boolean
) {
  if (answerQuality === "correct") return targetOnly ? "called_correct_answer" : "active_answer";
  if (answerQuality === "misconception") return "wrong_answer";
  if (answerQuality === "silent") return "no_response";
  if (answerQuality === "off_topic") return "off_topic";
  if (answerQuality === "partial") return "partial_answer";
  return `student_${action.actionType}`;
}

function describeAction(actionType: TeacherActionAnalysis["actionType"]) {
  const labels: Record<TeacherActionAnalysis["actionType"], string> = {
    greeting: "问候",
    casual: "闲聊",
    ambiguous: "表达澄清",
    transition: "课堂衔接",
    explanation: "讲解",
    question: "提问",
    follow_up: "追问",
    instruction: "组织活动",
    feedback: "反馈",
    management: "控场",
    summary: "总结"
  };

  return labels[actionType];
}

function buildPersonaFallbackResponse({
  student,
  state,
  teacherText,
  action,
  answerQuality
}: {
  student: StudentAgent;
  state: ClassroomState;
  teacherText: string;
  action: TeacherActionAnalysis;
  answerQuality: AnswerQuality;
}) {
  const topic = state.topic || "这节课";

  if (isQuestionLike(action)) {
    if (answerQuality === "silent") {
      return "老师，我还在想，能不能先给我一点提示？";
    }

    return personalizeReaction(student, buildQuestionAnswer(student, action, answerQuality).content);
  }

  if (action.actionType === "greeting") {
    return student.type === "silent_student" ? "老师好。" : "老师好，我们准备好了。";
  }

  if (action.actionType === "casual") {
    if (student.type === "naughty_student") {
      return `老师，我喜欢有意思的例子，不过我们接下来要继续聊“${topic}”吗？`;
    }

    return `老师，我平时也有自己的爱好，不过我们接下来是不是继续学习“${topic}”？`;
  }

  if (action.actionType === "ambiguous") {
    return student.type === "silent_student"
      ? "老师，我没太听清，您希望我们先做什么？"
      : `老师，我有点没听明白，接下来要围绕“${topic}”做什么呢？`;
  }

  if (action.actionType === "transition") {
    return `好的老师，我们会跟着您的节奏继续学习“${topic}”。`;
  }

  if (action.actionType === "instruction") {
    return student.type === "top_student"
      ? "好的老师，我们会先按要求分工，再把结果整理出来。"
      : "好的老师，我会先按要求完成，再和同伴交流。";
  }

  if (action.actionType === "management") {
    return "好的老师，我们先安静下来，回到现在的学习任务。";
  }

  if (action.actionType === "summary") {
    return `老师，我会记住今天“${topic}”的核心结论。`;
  }

  if (action.actionType === "feedback") {
    return student.currentStatus === "confused"
      ? "老师，我明白一点了，我再按您的提示想一想。"
      : "谢谢老师，我会根据您的提示把刚才的想法补完整。";
  }

  if (answerQuality === "partial") {
    return `老师，我听到您刚才说的“${teacherText.slice(0, 24)}”，但“${topic}”这里我还想再确认一下。`;
  }

  return student.type === "top_student"
    ? `老师，我能跟上您的讲解，想继续看看“${topic}”怎么应用。`
    : `老师，我在跟着听，“${topic}”这里如果能再举个例子会更清楚。`;
}

async function enhanceStudentResponsesWithLlm({
  llmProvider,
  state,
  teacherText,
  action,
  students,
  reactions
}: {
  llmProvider: LlmProvider;
  state: ClassroomState;
  teacherText: string;
  action: TeacherActionAnalysis;
  students: StudentAgent[];
  reactions: StudentReaction[];
}) {
  if (llmProvider.mode !== "llm") {
    return reactions.map((reaction) => ({
      ...reaction,
      generationMode: reaction.generationMode || "rule",
      validationPassed: reaction.validationPassed ?? true
    }));
  }

  const enhanced: StudentReaction[] = [];

  for (const reaction of reactions) {
    if (reaction.scripted) {
      enhanced.push({
        ...reaction,
        generationMode: reaction.generationMode || "rule",
        validationPassed: reaction.validationPassed ?? true
      });
      continue;
    }

    const student = students.find((item) => item.id === reaction.studentId);

    if (!student) {
      enhanced.push({
        ...reaction,
        generationMode: "rule",
        validationPassed: true
      });
      continue;
    }

    const plan = buildStudentAnswerPlan(student, action, reaction.answerQuality);
    const fallbackContent = reaction.content;
    let validationIssues: string[] = [];
    let shouldRetry = true;

    for (let attempt = 0; attempt < 2 && shouldRetry; attempt += 1) {
      try {
        const raw = await llmProvider.generateStudentReaction(
          buildStudentResponsePrompt({
            state,
            teacherText,
            action,
            student,
            plan,
            fallbackContent,
            previousIssues: validationIssues
          }),
          { timeoutMs: 4500 }
        );
        const parsed = parseGeneratedStudentAnswer(raw);
        const validation = validateStudentAnswer(parsed, {
          action,
          plan,
          student,
          fallbackContent
        });

        if (validation.passed) {
          const content = normalizeStudentAnswer(parsed.content);
          const nextReaction = {
            ...reaction,
            content,
            answerQuality: plan.answerQuality,
            agentReason: parsed.reason
              ? `${reaction.agentReason}；LLM 受控表达：${parsed.reason}`
              : reaction.agentReason,
            generationMode: "llm" as StudentAnswerGenerationMode,
            validationPassed: true,
            validationIssues: []
          };

          updateStudentMemoryContent(student, fallbackContent, content);
          enhanced.push(nextReaction);
          break;
        }

        validationIssues = validation.issues;
      } catch (error) {
        validationIssues = [formatStudentAnswerGenerationError(error)];
        shouldRetry = false;
      }
    }

    if (enhanced.some((item) => item.studentId === reaction.studentId)) {
      continue;
    }

    enhanced.push({
      ...reaction,
      generationMode: "fallback",
      validationPassed: false,
      validationIssues: validationIssues.length
        ? validationIssues
        : ["模型回答未通过贴题或画像校验，已回退规则答案。"]
    });
  }

  return enhanced;
}

function formatStudentAnswerGenerationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  if (/abort|timeout|timed out|The operation was aborted/i.test(message)) {
    return "生成超时，已回退规则答案。";
  }

  if (/api key|invalid_key|401|unauthorized/i.test(message)) {
    return "配置不可用，已回退规则答案。";
  }

  return "生成暂不可用，已回退规则答案。";
}

function capReactions(
  reactions: StudentReaction[],
  action: TeacherActionAnalysis,
  options: GenerateReactionOptions
) {
  if (options.targetOnly) {
    return reactions.slice(0, 1);
  }

  if (isQuestionLike(action)) {
    return [...reactions]
      .sort((left, right) => reactionPriority(left) - reactionPriority(right))
      .slice(0, 3);
  }

  return reactions.slice(0, 5);
}

function buildStudentAnswerPlan(
  student: StudentAgent,
  action: TeacherActionAnalysis,
  answerQuality: AnswerQuality
): StudentAnswerPlan {
  const mustMention = buildMustMention(action, answerQuality);
  const mustAvoid =
    answerQuality === "off_topic"
      ? []
      : ["考试会考", "不考", "不用学", "换个话题", "游戏", "加分"];

  return {
    studentId: student.id,
    answerQuality,
    mustMention,
    mustAvoid,
    style: buildStudentAnswerStyle(student, answerQuality)
  };
}

function buildMustMention(action: TeacherActionAnalysis, answerQuality: AnswerQuality) {
  if (answerQuality === "acknowledgement") {
    return [];
  }

  const topicTerms = action.topicKeywords
    .map((keyword) => keyword.trim())
    .filter(Boolean)
    .slice(0, answerQuality === "correct" ? 4 : 2);
  const pointTerms = action.expectedPoints
    .flatMap(extractKnowledgeTerms)
    .filter((term) => !topicTerms.includes(term));

  if (answerQuality === "misconception") {
    return [...topicTerms.slice(0, 2), ...pointTerms.slice(0, 1)];
  }

  if (answerQuality === "partial") {
    return [...topicTerms.slice(0, 2), ...pointTerms.slice(0, 1)];
  }

  return [...topicTerms, ...pointTerms.slice(0, 2)].slice(0, 5);
}

function extractKnowledgeTerms(text: string) {
  return text
    .replace(/[，。！？；：、,.!?;:\s]/g, " ")
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && term.length <= 8)
    .filter((term) => !/说明|指出|结合|为什么|本课|问题|当前|先|再|最后/.test(term));
}

function buildStudentAnswerStyle(student: StudentAgent, answerQuality: AnswerQuality) {
  if (answerQuality === "acknowledgement") {
    return student.type === "silent_student"
      ? "像沉默型学生一样，简短、礼貌、自然回应。"
      : "像真实课堂学生一样，结合自己的性格自然回应，不要像教师总结。";
  }

  if (answerQuality === "correct") {
    return "像学霸型学生一样，回答完整、贴题，可以包含一个短因果链，但不要像教师总结。";
  }

  if (answerQuality === "partial") {
    return student.type === "silent_student"
      ? "像沉默型学生一样，短句、谨慎、只说自己确定的一部分。"
      : "像基础薄弱型学生一样，抓住一个要点，但表达不完整，保留一点不确定。";
  }

  if (answerQuality === "misconception") {
    return "像误解型学生一样，说出一个与题目相关但错误的理解，错误点必须来自常见误区。";
  }

  if (answerQuality === "off_topic") {
    return "像调皮型学生一样轻微跑题，但仍要和教师问题里的一个词有关。";
  }

  return "像不太敢发言的学生一样，只给很短的回应。";
}

function buildStudentResponsePrompt({
  state,
  teacherText,
  action,
  student,
  plan,
  fallbackContent,
  previousIssues
}: {
  state: ClassroomState;
  teacherText: string;
  action: TeacherActionAnalysis;
  student: StudentAgent;
  plan: StudentAnswerPlan;
  fallbackContent: string;
  previousIssues: string[];
}) {
  return [
    "任务：理解教师上一句课堂表达，生成一名虚拟学生的自然回应。",
    "硬性要求：",
    "1. 只能输出 JSON 对象，字段为 content、answerQuality、mentionedKeywords、reason。",
    "2. content 必须是中文一句话，问候可为 2-30 字，其他回应为 8-90 字；不要换行，不要解释系统规则。",
    "3. 不能改变指定的 answerQuality，不能改变学生类型。",
    `4. 必须先回应教师这句话的真实意图，再符合当前课程“${state.grade}${state.subject}《${state.topic}》”、学生画像和最近互动。`,
    "5. 闲聊时先自然回应，再礼貌拉回课堂；表达模糊时请澄清下一步任务；不要编造不存在的课堂事实。",
    "",
    `课程：${state.grade}${state.subject}《${state.topic}》`,
    `最近课堂上下文：${formatRecentDialogue(state)}`,
    `教师本轮表达：${teacherText}`,
    `课堂意图：${describeAction(action.actionType)}`,
    `互动类型：${action.questionKind}`,
    `关键知识点：${action.topicKeywords.join("、") || action.contentFocus}`,
    `期望答案要点：${action.expectedPoints.join("；")}`,
    `常见误区：${action.commonMisconceptions.join("；")}`,
    `学生画像：姓名${student.name}，类型${student.type}，基础${student.knowledgeFoundation}，性格${student.personality}，当前状态${student.currentStatus}`,
    `回应规划：answerQuality=${plan.answerQuality}；mustMention=${plan.mustMention.join("、") || "无"}；mustAvoid=${plan.mustAvoid.join("、") || "无"}；style=${plan.style}`,
    `同画像保底回应参考：${fallbackContent}`,
    previousIssues.length
      ? `上次无效原因：${previousIssues.join("；")}。请修正后重新输出 JSON。`
      : "",
    '输出示例：{"content":"老师，我觉得要先确定整体，再看平均分成了几份。","answerQuality":"partial","mentionedKeywords":["整体","平均分"],"reason":"基础薄弱学生抓住了部分关键词，但没有完整说明几分之几。"}'
  ]
    .filter(Boolean)
    .join("\n");
}

type ParsedStudentAnswer = {
  content: string;
  answerQuality: AnswerQuality;
  mentionedKeywords: string[];
  reason?: string;
};

function parseGeneratedStudentAnswer(raw: string): ParsedStudentAnswer {
  const jsonText = extractJsonObject(raw);

  if (!jsonText) {
    throw new Error("模型未返回 JSON 对象");
  }

  const parsed = JSON.parse(jsonText) as Partial<ParsedStudentAnswer>;

  if (!parsed.content || !parsed.answerQuality) {
    throw new Error("模型 JSON 缺少 content 或 answerQuality");
  }

  if (!isAnswerQuality(parsed.answerQuality)) {
    throw new Error("模型 answerQuality 非法");
  }

  return {
    content: String(parsed.content),
    answerQuality: parsed.answerQuality,
    mentionedKeywords: Array.isArray(parsed.mentionedKeywords)
      ? parsed.mentionedKeywords.map(String)
      : [],
    reason: parsed.reason ? String(parsed.reason) : undefined
  };
}

function extractJsonObject(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced || raw;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");

  if (start < 0 || end <= start) {
    return undefined;
  }

  return source.slice(start, end + 1);
}

function validateStudentAnswer(
  answer: ParsedStudentAnswer,
  context: {
    action: TeacherActionAnalysis;
    plan: StudentAnswerPlan;
    student: StudentAgent;
    fallbackContent: string;
  }
) {
  const issues: string[] = [];
  const content = normalizeStudentAnswer(answer.content);
  const requiresKnowledgeAlignment = isQuestionLike(context.action) || context.action.actionType === "explanation";
  const coreKeywords = context.action.topicKeywords.slice(0, 4);
  const mentionedKeywords = answer.mentionedKeywords.map((keyword) => keyword.trim());
  const containsCoreKeyword =
    !requiresKnowledgeAlignment ||
    coreKeywords.length === 0 ||
    coreKeywords.some((keyword) => content.includes(keyword)) ||
    mentionedKeywords.some((keyword) => coreKeywords.includes(keyword));

  const minimumLength = context.action.actionType === "greeting" ? 2 : 6;

  if (!content || content.length < minimumLength) {
    issues.push("回答过短或为空");
  }

  if (content.length > 120) {
    issues.push("回答过长，不像学生课堂短回应");
  }

  if (answer.answerQuality !== context.plan.answerQuality) {
    issues.push(`回答质量被模型改成了 ${answer.answerQuality}`);
  }

  if (!containsCoreKeyword) {
    issues.push("回答没有命中教师问题的核心关键词");
  }

  const missingMustMention = context.plan.mustMention.filter(
    (keyword) => keyword && !content.includes(keyword)
  );

  if (
    requiresKnowledgeAlignment &&
    context.plan.answerQuality === "correct" &&
    context.plan.mustMention.length > 0 &&
    missingMustMention.length >= context.plan.mustMention.length
  ) {
    issues.push("学霸型回答没有覆盖必须知识点");
  }

  const forbidden = context.plan.mustAvoid.find((keyword) => content.includes(keyword));

  if (forbidden && context.action.actionType !== "casual") {
    issues.push(`回答出现禁止跑题内容：${forbidden}`);
  }

  if (
    isQuestionLike(context.action) &&
    context.student.type === "top_student" &&
    /是不是|不一定|随便|不用|只要.*就|我猜|好像/.test(content)
  ) {
    issues.push("学霸型回答出现明显不确定或错误表达");
  }

  if (
    isQuestionLike(context.action) &&
    context.plan.answerQuality === "misconception" &&
    !/是不是|我以为|只要|不用|直接|随便|不一定|都可以|应该让/.test(content)
  ) {
    issues.push("误解型回答没有体现相关误区");
  }

  if (
    isQuestionLike(context.action) &&
    context.plan.answerQuality !== "off_topic" &&
    /游戏|加分|换个话题|不考|不用学/.test(content)
  ) {
    issues.push("非调皮跑题场景出现无关内容");
  }

  return {
    passed: issues.length === 0,
    issues
  };
}

function normalizeStudentAnswer(content: string) {
  return content.replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").trim();
}

function formatRecentDialogue(state: ClassroomState) {
  const dialogue = state.timeline
    .slice(-6)
    .map((item) => `${item.role === "teacher" ? "教师" : item.speaker}：${item.content}`)
    .join(" / ");

  return dialogue || "这是本次课堂的第一轮互动。";
}

function isAnswerQuality(value: unknown): value is AnswerQuality {
  return (
    value === "acknowledgement" ||
    value === "correct" ||
    value === "partial" ||
    value === "misconception" ||
    value === "silent" ||
    value === "off_topic"
  );
}

function updateStudentMemoryContent(
  student: StudentAgent,
  fallbackContent: string,
  nextContent: string
) {
  student.lastReaction = nextContent;
  student.recentMemory = (student.recentMemory || []).map((memory, index) =>
    index === 0 ? memory.replace(fallbackContent, nextContent) : memory
  );
}

function addTargetedQuestionReaction(
  students: StudentAgent[],
  reactions: StudentReaction[],
  metrics: ClassroomMetrics,
  action: TeacherActionAnalysis,
  targetStudentId: string
) {
  const student = students.find((item) => item.id === targetStudentId);

  if (!student) {
    return;
  }

  const answerQuality = inferTargetedAnswerQuality(student, action);
  const answer =
    answerQuality === "silent"
      ? { content: "……老师，我还没想好。" }
      : buildQuestionAnswer(student, action, answerQuality);
  const eventType =
    answerQuality === "correct"
      ? "called_correct_answer"
      : answerQuality === "misconception"
        ? "wrong_answer"
        : answerQuality === "silent"
          ? "no_response"
          : answerQuality === "off_topic"
            ? "off_topic"
            : "called_partial_answer";

  pushReaction(
    reactions,
    student,
    personalizeReaction(student, answer.content),
    eventType,
    buildTargetedAgentReason(student, action, answerQuality),
    "点名回答上一句问题",
    {
      answerQuality,
      questionKind: action.questionKind,
      topicKeywords: action.topicKeywords
    }
  );
  student.currentStatus =
    answerQuality === "correct"
      ? "active"
      : answerQuality === "misconception"
        ? "confused"
        : answerQuality === "silent"
          ? "silent"
          : answerQuality === "off_topic"
            ? "distracted"
            : "focused";
  applyAnswerQualityMetrics(metrics, answerQuality, action);
}

function addQuestionReactions(
  students: StudentAgent[],
  reactions: StudentReaction[],
  metrics: ClassroomMetrics,
  state: ClassroomState,
  teacherText: string,
  action: TeacherActionAnalysis
) {
  const responders = selectQuestionResponders(students, state, teacherText, action);

  for (const student of responders) {
    const answerQuality = inferDynamicAnswerQuality(student, state, teacherText, action);
    const answerContent =
      answerQuality === "silent"
        ? "……老师，我还想再想一想。"
        : buildQuestionAnswer(student, action, answerQuality).content;
    const eventType =
      answerQuality === "correct"
        ? "active_answer"
        : answerQuality === "misconception"
          ? "wrong_answer"
          : answerQuality === "silent"
            ? "no_response"
            : answerQuality === "off_topic"
              ? "off_topic"
              : "partial_answer";
    const trigger = responders.length > 1 ? "全班提问后的自主回应" : "当前问题的优先回应";

    pushReaction(
      reactions,
      student,
      personalizeReaction(student, answerContent),
      eventType,
      buildDynamicAgentReason(student, action, answerQuality, state),
      trigger,
      {
        answerQuality,
        questionKind: action.questionKind,
        topicKeywords: action.topicKeywords
      }
    );
    student.currentStatus = statusForAnswerQuality(answerQuality);
    applyAnswerQualityMetrics(metrics, answerQuality, action);
  }
}

function addGreetingReaction(
  students: StudentAgent[],
  reactions: StudentReaction[],
  state: ClassroomState
) {
  const responder = [...students]
    .sort((left, right) => greetingPriority(right, state) - greetingPriority(left, state))[0];

  if (!responder) {
    return;
  }

  const content = responder.type === "silent_student"
    ? "老师好。"
    : responder.type === "naughty_student"
      ? "老师好，我们准备开始了吗？"
      : "老师好，我们准备好了。";

  pushReaction(
    reactions,
    responder,
    content,
    "classroom_greeting",
    `${responder.name} 以自然问候回应教师，没有进入知识问答或课堂事件。`,
    "课堂问候",
    {
      answerQuality: "acknowledgement",
      questionKind: "greeting",
      topicKeywords: []
    }
  );
  responder.currentStatus = "focused";
}

function resetForTransition(students: StudentAgent[]) {
  for (const student of students) {
    if (student.currentStatus === "distracted") {
      student.currentStatus = "focused";
    }
  }
}

function selectQuestionResponders(
  students: StudentAgent[],
  state: ClassroomState,
  teacherText: string,
  action: TeacherActionAnalysis
) {
  const recentSpeakerIds = new Set(
    state.timeline
      .slice(-8)
      .filter((item) => item.role === "student" && item.studentId)
      .map((item) => item.studentId)
  );
  const asksWholeClass = /同学们|大家|谁来|哪位|还有谁|补充一下|其他同学/.test(teacherText);
  const asksForOne = /谁来|哪位|请.*同学|请你/.test(teacherText) && !/还有谁|补充|其他同学/.test(teacherText);
  const desiredCount = asksForOne ? 1 : asksWholeClass ? 2 : action.specificity >= 72 ? 2 : 1;

  return [...students]
    .sort((left, right) => {
      const leftRecentPenalty = recentSpeakerIds.has(left.id) ? 34 : 0;
      const rightRecentPenalty = recentSpeakerIds.has(right.id) ? 34 : 0;
      const leftScore =
        responseContextScore(left, state, action, teacherText) +
        responsePriority(left) * 18 +
        nameMentionBonus(left, teacherText) -
        leftRecentPenalty;
      const rightScore =
        responseContextScore(right, state, action, teacherText) +
        responsePriority(right) * 18 +
        nameMentionBonus(right, teacherText) -
        rightRecentPenalty;

      return rightScore - leftScore;
    })
    .slice(0, Math.min(3, desiredCount));
}

function responsePriority(student: StudentAgent) {
  if (student.currentStatus === "active" || student.currentStatus === "confused") {
    return 2;
  }

  if (student.currentStatus === "focused") {
    return 1;
  }

  return 0;
}

function nameMentionBonus(student: StudentAgent, teacherText: string) {
  return teacherText.includes(student.name) ? 100 : 0;
}

function responseContextScore(
  student: StudentAgent,
  state: ClassroomState,
  action: TeacherActionAnalysis,
  teacherText: string
) {
  const baseline: Record<StudentAgent["type"], number> = {
    top_student: 68,
    weak_student: 55,
    misunderstanding_student: 52,
    silent_student: 37,
    naughty_student: 31
  };
  const seed = stableResponseSeed(`${state.turnCount}:${teacherText}:${student.id}`);
  let score = baseline[student.type] + seed;

  if (action.actionType === "follow_up" && student.currentStatus === "confused") {
    score += 35;
  }

  if (action.difficultyLevel === "hard" && student.type === "top_student") {
    score += 18;
  }

  if (action.specificity < 52 && (student.type === "silent_student" || student.type === "naughty_student")) {
    score += 16;
  }

  if (state.events.some((event) => event.type === "wrong_answer" && !event.handled) && student.type === "misunderstanding_student") {
    score += 28;
  }

  if (/举例|生活中|说一个/.test(teacherText) && student.type === "weak_student") {
    score += 12;
  }

  return score;
}

function inferDynamicAnswerQuality(
  student: StudentAgent,
  state: ClassroomState,
  teacherText: string,
  action: TeacherActionAnalysis
): AnswerQuality {
  const seed = stableResponseSeed(`${student.id}:${state.turnCount}:${teacherText}`);
  const questionIsUnclear = action.specificity < 52;

  if (student.type === "top_student") {
    return "correct";
  }

  if (student.type === "misunderstanding_student") {
    return action.actionType === "follow_up" && state.events.some((event) => event.type === "wrong_answer" && !event.handled)
      ? "partial"
      : seed > 8 || questionIsUnclear
        ? "misconception"
        : "partial";
  }

  if (student.type === "silent_student") {
    return questionIsUnclear || state.metrics.participation < 48 || seed > 15 ? "silent" : "partial";
  }

  if (student.type === "naughty_student") {
    return questionIsUnclear && (state.metrics.discipline < 64 || seed > 12) ? "off_topic" : "partial";
  }

  return "partial";
}

function buildDynamicAgentReason(
  student: StudentAgent,
  action: TeacherActionAnalysis,
  answerQuality: AnswerQuality,
  state: ClassroomState
) {
  const focus = action.contentFocus || "当前问题";
  const recentMention = state.timeline.some(
    (item) => item.role === "student" && item.studentId === student.id
  )
    ? "结合其前序发言状态"
    : "为扩大本轮参与面";

  if (answerQuality === "correct") {
    return `${recentMention}，${student.name} 围绕“${focus}”给出较完整回答。`;
  }

  if (answerQuality === "misconception") {
    return `${recentMention}，${student.name} 暴露出与“${focus}”相关的理解误区，适合继续追问。`;
  }

  if (answerQuality === "silent") {
    return `${recentMention}，${student.name} 对“${focus}”仍缺少表达把握，暂未形成完整回答。`;
  }

  if (answerQuality === "off_topic") {
    return `${recentMention}，${student.name} 将“${focus}”轻微带离任务主线，需要教师收束。`;
  }

  return `${recentMention}，${student.name} 抓住了“${focus}”的一部分信息，仍可补充或澄清。`;
}

function statusForAnswerQuality(answerQuality: AnswerQuality): StudentAgent["currentStatus"] {
  if (answerQuality === "correct") return "active";
  if (answerQuality === "misconception") return "confused";
  if (answerQuality === "silent") return "silent";
  if (answerQuality === "off_topic") return "distracted";
  return "focused";
}

function greetingPriority(student: StudentAgent, state: ClassroomState) {
  const recentPenalty = state.timeline.some(
    (item) => item.role === "student" && item.studentId === student.id
  )
    ? 20
    : 0;

  return student.participationWillingness - recentPenalty + stableResponseSeed(student.id);
}

function stableResponseSeed(value: string) {
  let hash = 0;

  for (const character of value) {
    hash = (hash * 31 + character.charCodeAt(0)) % 997;
  }

  return (hash % 31) - 15;
}

function addActivityReactions(
  students: StudentAgent[],
  reactions: StudentReaction[],
  metrics: ClassroomMetrics,
  action: TeacherActionAnalysis
) {
  const topStudent = findStudent(students, "top_student");
  const naughtyStudent = findStudent(students, "naughty_student");
  const focus = action.topicKeywords.slice(0, 3).join("、") || action.contentFocus;

  if (topStudent) {
    pushReaction(
      reactions,
      topStudent,
      `我们小组可以围绕“${focus}”先分工，一个人操作或画图，一个人记录结论，一个人准备展示。`,
      "activity_positive",
      "高基础学生在活动任务中承担组织角色",
      "小组活动"
    );
    topStudent.currentStatus = "active";
  }

  if (naughtyStudent) {
    pushReaction(
      reactions,
      naughtyStudent,
      personalizeReaction(naughtyStudent, `老师，我们组能不能换一个和“${focus}”有关但更有意思的例子？`),
      "off_topic",
      "活动边界不够明确，活跃学生把任务转向个人兴趣",
      "活动组织"
    );
    naughtyStudent.currentStatus = "distracted";
  }

  metrics.participation += 12;
  metrics.discipline -= 7;
  metrics.interactionQuality += 5;
}

function addManagementReaction(
  students: StudentAgent[],
  reactions: StudentReaction[],
  metrics: ClassroomMetrics
) {
  const naughtyStudent = findStudent(students, "naughty_student");

  if (naughtyStudent) {
    pushReaction(
      reactions,
      naughtyStudent,
      "好的老师，我们先听规则。",
      "discipline_recovered",
      "教师明确规则后，活跃学生注意力回到课堂任务",
      "控场提醒"
    );
    naughtyStudent.currentStatus = "focused";
  }

  metrics.discipline += 14;
  metrics.interactionQuality += 3;
}

function addSummaryReaction(
  students: StudentAgent[],
  reactions: StudentReaction[],
  metrics: ClassroomMetrics,
  action: TeacherActionAnalysis
) {
  const topStudent = findStudent(students, "top_student");
  const focus = action.topicKeywords.slice(0, 3).join("、") || action.contentFocus;
  const content = /分数|单位 ?1|整体|平均分|四分之一/.test(action.topicKeywords.join(" "))
    ? "老师，我明白了，今天的关键是先确定单位1，再看是不是平均分，最后用分母表示平均分成几份、分子表示取了几份。"
    : `老师，我明白了，今天要围绕“${focus}”先抓住核心条件，再说明结论和适用边界。`;

  if (topStudent) {
    pushReaction(
      reactions,
      topStudent,
      content,
      "summary_response",
      "总结阶段激活高基础学生的结构化复述",
      "课堂总结"
    );
    topStudent.currentStatus = "focused";
  }

  metrics.progress += 12;
  metrics.goalAchievement += 12;
  metrics.understanding += 5;
}

function addFeedbackReaction(
  students: StudentAgent[],
  reactions: StudentReaction[],
  metrics: ClassroomMetrics,
  state: ClassroomState
) {
  const misunderstandingStudent = findStudent(students, "misunderstanding_student");
  const hasWrongAnswer = state.events.some(
    (event) => event.type === "wrong_answer" && !event.handled
  );

  if (misunderstandingStudent && hasWrongAnswer) {
    pushReaction(
      reactions,
      misunderstandingStudent,
      "我刚才是把条件顺序看反了，现在能对应上了。",
      "misunderstanding_repaired",
      "教师反馈回应了未处理的错误答案，误解学生完成修正",
      "错误答案反馈"
    );
    misunderstandingStudent.currentStatus = "focused";
    metrics.understanding += 12;
    metrics.interactionQuality += 12;
  } else {
    addExplanationReactions(students, reactions, metrics, {
      actionType: "explanation",
      clarity: 72,
      difficultyLevel: "medium",
      questionKind: "concept",
      specificity: 55,
      contentFocus: "当前概念",
      topicKeywords: [],
      expectedAnswerFrame: "解释当前概念，并说明它和本课主题的关系。",
      expectedPoints: ["解释当前概念", "说明和本课主题的关系"],
      commonMisconceptions: ["只理解字面意思"],
      interactionIntent: false,
      stage: "讲解"
    });
  }
}

function addExplanationReactions(
  students: StudentAgent[],
  reactions: StudentReaction[],
  metrics: ClassroomMetrics,
  action: TeacherActionAnalysis
) {
  if (action.clarity >= 75) {
    const weakStudent = findStudent(students, "weak_student");
    const topStudent = findStudent(students, "top_student");
    students.forEach((student) => {
      student.currentStatus = student.type === "silent_student" ? "silent" : "focused";
    });

    if (weakStudent) {
      pushReaction(
        reactions,
        weakStudent,
        "老师，这样一步一步讲我能跟上了。",
        "understood",
        "清晰讲解降低认知负荷，基础薄弱学生获得步骤支架",
        "分步讲解"
      );
      weakStudent.currentStatus = "focused";
    }

    if (topStudent) {
      pushReaction(
        reactions,
        topStudent,
        "老师，这个方法还能不能用另一种方式证明？",
        "extension_question",
        "高基础学生在理解后提出拓展性问题",
        "清晰讲解"
      );
      topStudent.currentStatus = "active";
    }

    metrics.understanding += 9;
    metrics.participation += 3;
    metrics.goalAchievement += 5;
    return;
  }

  const weakStudent = findStudent(students, "weak_student");
  const misunderstandingStudent = findStudent(students, "misunderstanding_student");

  if (weakStudent) {
    pushReaction(
      reactions,
      weakStudent,
      personalizeReaction(weakStudent, "老师，我还是不太明白，可以再举一个例子吗？"),
      "confused",
      "讲解清晰度不足，基础薄弱学生需要更具体支架",
      "抽象讲解"
    );
    weakStudent.currentStatus = "confused";
  }

  if (misunderstandingStudent) {
    pushReaction(
      reactions,
      misunderstandingStudent,
      personalizeReaction(misunderstandingStudent, "老师，我是不是可以直接把两个概念等同起来理解？"),
      "wrong_answer",
      "抽象讲解放大既有误区，误解学生给出错误迁移",
      "概念讲解"
    );
    misunderstandingStudent.currentStatus = "confused";
  }

  metrics.understanding -= action.difficultyLevel === "hard" ? 10 : 5;
  metrics.participation -= 3;
}

function maybeNaughtyOffTopic(students: StudentAgent[], reactions: StudentReaction[]) {
  const naughtyStudent = findStudent(students, "naughty_student");

  if (!naughtyStudent) {
    return;
  }

  pushReaction(
    reactions,
    naughtyStudent,
    "老师，这个考试会考吗？不考是不是不用学？",
    "off_topic",
    "长时间单向讲解导致注意力转移，活跃学生跑题",
    "缺少互动"
  );
  naughtyStudent.currentStatus = "distracted";
}

function buildQuestionAnswer(
  student: StudentAgent,
  action: TeacherActionAnalysis,
  answerQuality: AnswerQuality
) {
  const focus = action.topicKeywords.slice(0, 3).join("、") || action.contentFocus;
  const firstKeyword = action.topicKeywords[0] || action.contentFocus;
  const topicAnswer = buildTopicGroundedAnswer(action, answerQuality, student);

  if (topicAnswer) {
    return { content: topicAnswer };
  }

  if (answerQuality === "correct") {
    if (action.questionKind === "reason") {
      return {
        content: `老师，我觉得要从“${focus}”之间的关系来看。${action.expectedAnswerFrame}`
      };
    }

    if (action.questionKind === "example") {
      return {
        content: `老师，可以用“${firstKeyword}”相关的具体例子说明，再回到概念本身。${action.expectedAnswerFrame}`
      };
    }

    if (action.questionKind === "comparison") {
      return {
        content: `老师，我会先比较相同点，再说不同点，这样能把“${focus}”的边界说清楚。`
      };
    }

    if (action.questionKind === "procedure") {
      return {
        content: `老师，我觉得可以先判断条件，再按步骤处理“${focus}”，最后检查结果是否符合题意。`
      };
    }

    if (action.questionKind === "value") {
      return {
        content: `老师，我认为要结合具体情境判断“${focus}”，不能只看个人想法，还要看对集体或任务的影响。`
      };
    }

    return {
      content: `老师，我理解“${focus}”的关键是先说明它是什么，再说明它和本课问题有什么关系。`
    };
  }

  if (answerQuality === "misconception") {
    if (action.questionKind === "reason") {
      return {
        content: `老师，我是不是可以理解成只要出现“${firstKeyword}”，原因就一定是它造成的？`
      };
    }

    if (action.questionKind === "comparison") {
      return {
        content: `老师，我感觉“${firstKeyword}”和另一个概念差不多，可以直接当成一样的吗？`
      };
    }

    if (action.questionKind === "procedure") {
      return {
        content: `老师，我是不是可以不用先看条件，直接套刚才那个步骤？`
      };
    }

    if (action.questionKind === "value") {
      return {
        content: `老师，我觉得只要自己方便就可以了，集体里的责任是不是也能这样理解？`
      };
    }

    return {
      content: `老师，我是不是可以把“${firstKeyword}”直接理解成它表面的意思？`
    };
  }

  if (student.type === "silent_student") {
    return {
      content: `老师，我觉得可能和“${firstKeyword}”有关，但我还说不完整。`
    };
  }

  return {
    content: `老师，我知道一点，应该和“${firstKeyword}”有关，但后面的原因或者步骤我还没完全想清楚。`
  };
}

function buildTopicGroundedAnswer(
  action: TeacherActionAnalysis,
  answerQuality: AnswerQuality,
  student: StudentAgent
) {
  const keywords = action.topicKeywords.join(" ");
  const focus = action.contentFocus;

  if (/分数|单位 ?1|整体|部分|平均分|四分之一|几分之几|非平均分|分子|分母/.test(keywords)) {
    if (answerQuality === "correct") {
      if (action.questionKind === "reason") {
        return "老师，因为分数的意义是把单位1平均分成若干份，表示其中的一份或几份。四分之一成立，是因为先确定一个整体，再平均分成4份并取其中1份。";
      }

      if (action.questionKind === "example") {
        return "老师，比如把一个圆平均分成4份，其中1份就是四分之一，3份就是四分之三；如果不是平均分，就不能直接说每份都是四分之一。";
      }

      if (action.questionKind === "comparison") {
        return "老师，平均分和随便分的区别在于每份大小是否相等。只有平均分后，分母才能表示平均分成的份数，分子才表示取了几份。";
      }

      return "老师，分数的关键是单位1、平均分和取其中几份。没有先确定整体，或者不是平均分，就不能准确用几分之几表示。";
    }

    if (answerQuality === "partial") {
      return student.type === "silent_student"
        ? "老师，我觉得要先有一个单位1，再分出一部分，但我还不太会说分母和平均分成几份的关系。"
        : "老师，我知道分数和整体的一部分有关，好像要把一个东西分成几份，但我容易忘记必须平均分，还会混淆分子分母。";
    }

    if (answerQuality === "misconception") {
      return "老师，我是不是可以理解成只要把一个东西随便分成4块，其中1块都能叫四分之一？我觉得不一定要每块一样大。";
    }

    if (answerQuality === "off_topic") {
      return "老师，那分数考试是不是主要背公式？如果不考画图是不是就不用管整体了？";
    }

    return "……老师，我知道和分东西有关，但我还没想清楚。";
  }

  if (/责任|集体|班干部|承担/.test(keywords) || /责任|集体/.test(focus)) {
    if (answerQuality === "correct") {
      return "老师，集体里的责任不能只靠班干部承担，因为班级事务和每个人都有关系。班干部可以组织和提醒，但每个成员都要完成自己的角色，比如遵守规则、参与活动、帮助同伴，这样集体才能运转。";
    }

    if (answerQuality === "partial") {
      return student.type === "silent_student"
        ? "老师，我觉得不能只靠班干部，因为班级是大家的，但我还说不清每个人具体要做什么。"
        : "老师，应该是大家都要帮忙，班干部不能一个人做完所有事，不过我还没想好怎么分工。";
    }

    if (answerQuality === "misconception") {
      return "老师，我觉得班干部本来就是负责管理班级的，那是不是大部分责任都应该让班干部承担，其他同学配合一下就行？";
    }

    if (answerQuality === "off_topic") {
      return "老师，那是不是当班干部会更容易加分？如果不当班干部是不是责任就少一点？";
    }

    return "……老师，我觉得和大家都有关系，但我还没组织好语言。";
  }

  if (/函数|图像/.test(keywords)) {
    if (answerQuality === "correct") {
      return "老师，函数图像能把自变量和因变量的变化关系画出来。看图像时要关注横轴、纵轴、变化趋势和特殊点，这样才能判断函数关系。";
    }

    if (answerQuality === "partial") {
      return "老师，我知道图像能看出变化趋势，但我容易只看线的形状，忘记先看横轴和纵轴表示什么。";
    }

    if (answerQuality === "misconception") {
      return "老师，我是不是只要看到图像往上升，就说明所有情况下函数值都变大？";
    }
  }

  return undefined;
}

function inferTargetedAnswerQuality(
  student: StudentAgent,
  action: TeacherActionAnalysis
): AnswerQuality {
  if (student.type === "top_student") {
    return "correct";
  }

  if (student.type === "misunderstanding_student") {
    return "misconception";
  }

  if (student.type === "weak_student") {
    return "partial";
  }

  if (student.type === "silent_student") {
    return action.specificity >= 62 ? "partial" : "silent";
  }

  if (student.type === "naughty_student") {
    return action.specificity < 45 ? "off_topic" : "partial";
  }

  return "partial";
}

function buildTargetedAgentReason(
  student: StudentAgent,
  action: TeacherActionAnalysis,
  answerQuality: AnswerQuality
) {
  const focus = action.contentFocus || action.topicKeywords.join("、") || "上一句问题";

  if (answerQuality === "correct") {
    return `被点名后，${student.name} 依据较强知识基础围绕“${focus}”作出较完整回答。`;
  }

  if (answerQuality === "misconception") {
    return `被点名后，${student.name} 围绕“${focus}”暴露出典型误区，适合教师追问纠偏。`;
  }

  if (answerQuality === "silent") {
    return `被点名后，${student.name} 因问题仍偏开放或表达信心不足而短暂停顿。`;
  }

  if (answerQuality === "off_topic") {
    return `被点名后，${student.name} 因问题边界不清把“${focus}”带向无关话题。`;
  }

  return `被点名后，${student.name} 抓住“${focus}”的部分信息，但回答还不完整。`;
}

function applyAnswerQualityMetrics(
  metrics: ClassroomMetrics,
  answerQuality: AnswerQuality,
  action: TeacherActionAnalysis
) {
  if (answerQuality === "correct") {
    metrics.participation += 8;
    metrics.understanding += 7;
    metrics.interactionQuality += 8;
    metrics.goalAchievement += 4;
  } else if (answerQuality === "partial") {
    metrics.participation += 4;
    metrics.interactionQuality += action.specificity >= 58 ? 3 : 1;
    metrics.understanding += action.specificity >= 58 ? 1 : -2;
  } else if (answerQuality === "misconception") {
    metrics.understanding -= 8;
    metrics.interactionQuality += 2;
  } else if (answerQuality === "silent") {
    metrics.participation -= 7;
    metrics.interactionQuality -= 4;
  } else if (answerQuality === "off_topic") {
    metrics.discipline -= 9;
    metrics.interactionQuality -= 5;
  }
}

function applyMetricShift(
  metrics: ClassroomMetrics,
  action: TeacherActionAnalysis,
  state: ClassroomState
) {
  if (isQuestionLike(action)) {
    metrics.progress += 5;
    metrics.participation += 5;
  } else if (action.actionType === "explanation") {
    metrics.progress += 7;
  } else if (action.actionType === "summary") {
    metrics.progress += 10;
  }

  if (action.clarity < 60) {
    metrics.understanding -= 5;
  }

  if (state.difficulty === "挑战") {
    metrics.discipline -= 2;
  }
}

function isQuestionLike(action: TeacherActionAnalysis) {
  return action.actionType === "question" || action.actionType === "follow_up";
}

function findStudent(students: StudentAgent[], type: StudentAgent["type"]) {
  return students.find((student) => student.type === type);
}

function pushReaction(
  reactions: StudentReaction[],
  student: StudentAgent,
  content: string,
  eventType: string,
  agentReason: string,
  triggeredBy: string,
  meta: Partial<{
    answerQuality: AnswerQuality;
    questionKind: QuestionKind;
    topicKeywords: string[];
    generationMode: StudentAnswerGenerationMode;
    validationPassed: boolean;
    validationIssues: string[];
  }> = {}
) {
  student.lastReaction = content;
  student.recentMemory = [
    `因“${triggeredBy}”作出反应：${content}`,
    ...(student.recentMemory || [])
  ].slice(0, 3);
  reactions.push({
    studentId: student.id,
    studentName: student.name,
    studentType: student.type,
    content,
    eventType,
    answerQuality: meta.answerQuality || inferAnswerQuality(eventType),
    questionKind: meta.questionKind || "concept",
    topicKeywords: meta.topicKeywords || [],
    agentReason,
    triggeredBy,
    generationMode: meta.generationMode,
    validationPassed: meta.validationPassed,
    validationIssues: meta.validationIssues
  });
}

function inferAnswerQuality(eventType: string): AnswerQuality {
  if (/wrong|misunderstanding/.test(eventType)) {
    return "misconception";
  }

  if (/no_response/.test(eventType)) {
    return "silent";
  }

  if (/off_topic/.test(eventType)) {
    return "off_topic";
  }

  if (/understood|active_answer|summary_response|extension_question/.test(eventType)) {
    return "correct";
  }

  return "partial";
}

function reactionPriority(reaction: StudentReaction) {
  if (reaction.answerQuality === "misconception" || reaction.eventType === "wrong_answer") {
    return 1;
  }

  if (reaction.answerQuality === "silent" || reaction.eventType === "no_response") {
    return 2;
  }

  if (reaction.answerQuality === "off_topic" || reaction.eventType === "off_topic") {
    return 3;
  }

  if (reaction.answerQuality === "correct") {
    return 4;
  }

  return 5;
}

function personalizeReaction(student: StudentAgent, fallback: string) {
  if (student.type === "weak_student" && student.emotionState === "谨慎") {
    return fallback.replace("老师，", "老师，我有点跟不上，");
  }

  if (student.type === "misunderstanding_student") {
    return fallback.replace("老师，", "老师，我想确认一下，");
  }

  return fallback;
}

function clampMetrics(metrics: ClassroomMetrics): ClassroomMetrics {
  return {
    participation: clamp(metrics.participation),
    understanding: clamp(metrics.understanding),
    discipline: clamp(metrics.discipline),
    progress: clamp(metrics.progress),
    interactionQuality: clamp(metrics.interactionQuality),
    goalAchievement: clamp(metrics.goalAchievement)
  };
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
