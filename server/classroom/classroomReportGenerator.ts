import { randomUUID } from "node:crypto";
import type {
  AgentCollaborationStep,
  AgentDecisionEvidence,
  ClassroomEvidenceChain,
  ClassroomReport,
  ClassroomState
} from "./classroomTypes.js";

export function generateClassroomReport(
  state: ClassroomState,
  options: { modelInsight?: string; providerMode?: "rule" | "llm" } = {}
): ClassroomReport {
  const metrics = state.metrics;
  const handledRate = state.events.length
    ? state.events.filter((event) => event.handled).length / state.events.length
    : 0.8;
  const questionCount = state.timeline.filter((item) =>
    item.eventType === "teacher_question" || item.eventType === "teacher_follow_up"
  ).length;
  const activityCount = state.timeline.filter((item) => item.eventType === "teacher_instruction").length;
  const managementCount = state.timeline.filter((item) => item.eventType === "teacher_management").length;
  const careSignals = calculateClassroomCareSignals(state, questionCount);

  const dimensionScores = [
    {
      name: "教学语言清晰度",
      score: scoreFrom(metrics.understanding, 4),
      comment: metrics.understanding >= 70 ? "讲解能被多数学生理解。" : "讲解仍偏抽象，需要增加例子和步骤。"
    },
    {
      name: "提问质量",
      score: scoreFrom(metrics.interactionQuality + questionCount * 4, 0),
      comment: questionCount >= 2 ? "有提问意识，能够引发学生回应。" : "提问轮次偏少，互动入口不够充分。"
    },
    {
      name: "学生参与调动",
      score: scoreFrom(metrics.participation, 0),
      comment: metrics.participation >= 65 ? "多数学生保持参与。" : "沉默学生和基础薄弱学生尚未被充分带动。"
    },
    {
      name: "课堂控场能力",
      score: scoreFrom(metrics.discipline + managementCount * 5, 0),
      comment: metrics.discipline >= 65 ? "课堂秩序整体可控。" : "面对跑题和纪律波动时需要更快明确规则。"
    },
    {
      name: "活动组织能力",
      score: scoreFrom(58 + activityCount * 12, 0),
      comment: activityCount ? "已尝试组织课堂活动。" : "本轮活动组织较少，可加入同桌讨论或小组任务。"
    },
    {
      name: "课堂应变能力",
      score: scoreFrom(55 + handledRate * 35, 0),
      comment: handledRate >= 0.7 ? "能回应部分课堂突发情况。" : "突发事件处理不足，需练习追问和控场。"
    },
    {
      name: "公平提问与课堂关怀",
      score: scoreFrom(careSignals.score, 0),
      comment:
        careSignals.score >= 75
          ? "能够关注不同学生状态，提问和反馈体现公平与关怀。"
          : "还需要更明确地照顾沉默、误解和基础薄弱学生，避免只回应少数活跃学生。"
    }
  ];
  const overallScore = Math.round(
    dimensionScores.reduce((sum, item) => sum + item.score, 0) / dimensionScores.length
  );
  const evidenceChains = buildEvidenceChains(state);
  const strengths = buildStrengths(state, questionCount, activityCount, evidenceChains, careSignals);
  const issues = buildIssues(state, questionCount, evidenceChains, careSignals);
  const suggestions = buildSuggestions(state, questionCount, activityCount, evidenceChains, careSignals);
  const agentDecisionEvidence = buildAgentDecisionEvidence(state, evidenceChains);
  const agentCollaboration = buildAgentCollaboration(
    state,
    dimensionScores.length,
    evidenceChains.length,
    options.providerMode || "rule"
  );

  return {
    sessionId: state.sessionId,
    overallScore,
    dimensionScores,
    eventReview: state.events.map((event) => ({
      type: event.type,
      description: event.description,
      handled: event.handled,
      comment: event.handled ? "已通过后续教学行为进行回应。" : "尚未看到充分处理，需要在下一轮训练中补足。"
    })),
    strengths,
    issues,
    suggestions: options.modelInsight
      ? [...suggestions, `AI教研员补充：${options.modelInsight}`]
      : suggestions,
    evidenceChains,
    agentDecisionEvidence,
    agentCollaboration,
    agentRunStats: state.agentRunStats,
    nextTrainingTask: pickNextTask(state, questionCount, careSignals),
    summary: `本次试讲围绕“${state.topic}”展开，整体得分 ${overallScore}。报告同时检查公平提问、学生差异和课堂关怀；你已经完成了基本课堂推进，但还需要继续强化学生差异回应、事件处理和课堂节奏控制。`,
    modelInsight: options.modelInsight,
    providerMode: options.providerMode || "rule",
    savedConversationId: state.savedConversationId,
    generatedAt: Date.now()
  };
}

function buildEvidenceChains(state: ClassroomState): ClassroomEvidenceChain[] {
  const chains: ClassroomEvidenceChain[] = [];
  const timeline = state.timeline;

  for (let index = 0; index < timeline.length; index += 1) {
    const teacherMove = timeline[index];

    if (teacherMove.role !== "teacher") {
      continue;
    }

    const nextItems = timeline.slice(index + 1, index + 7);
    const studentResponse = nextItems.find((item) => item.role === "student");
    const observerAdvice = nextItems.find((item) => item.role === "observer");
    const event = nextItems.find((item) => item.role === "system");

    if (!studentResponse && !observerAdvice && !event) {
      continue;
    }

    chains.push({
      id: randomUUID(),
      teacherMove: compactText(teacherMove.content, 96),
      studentAgent: studentResponse?.speaker || "学生 Agent 群体",
      studentResponse: compactText(studentResponse?.content || "学生暂未形成有效回应", 110),
      eventOrMetric:
        compactText(event?.content || "", 110) ||
        inferMetricEvidence(state, studentResponse?.eventType || teacherMove.eventType),
      observerAdvice:
        compactText(observerAdvice?.content || "", 110) ||
        "课堂观察员 Agent 建议继续追踪学生理解和参与变化。"
    });

    if (chains.length >= 5) {
      break;
    }
  }

  const eventChains = [
    ...chains,
    ...state.events.slice(0, 5 - chains.length).map((event) => ({
      id: randomUUID(),
      teacherMove: "课堂事件 Agent 捕捉到训练风险",
      studentAgent: "学生 Agent 群体",
      studentResponse: compactText(event.description, 110),
      eventOrMetric: `事件类型：${event.type}，处理状态：${event.handled ? "已处理" : "待处理"}`,
      observerAdvice: event.handled
        ? "后续教师行为已回应该风险，可沉淀为处理经验。"
        : "下一轮需要通过追问、支架或控场语言进行回应。"
    }))
  ].slice(0, 5);

  if (eventChains.length >= 3) {
    return eventChains;
  }

  const memoryChains = (state.studentMemoryTimeline || [])
    .slice(-5)
    .map((memory) => ({
      id: randomUUID(),
      teacherMove: compactText(memory.trigger, 96),
      studentAgent: memory.studentName,
      studentResponse: compactText(memory.reaction, 110),
      eventOrMetric: `学生状态：${memory.fromStatus} -> ${memory.toStatus}；课堂阶段：${memory.stage}`,
      observerAdvice: `学生 Agent 判断：${compactText(memory.agentReason, 96)}`
    }));
  const metricFallbacks: ClassroomEvidenceChain[] = [
    {
      id: randomUUID(),
      teacherMove: "课堂指标 Agent 汇总当前训练状态",
      studentAgent: "学生 Agent 群体",
      studentResponse: `参与度 ${state.metrics.participation}%，理解度 ${state.metrics.understanding}%`,
      eventOrMetric: `互动质量 ${state.metrics.interactionQuality}%，目标达成度 ${state.metrics.goalAchievement}%`,
      observerAdvice: "下一轮应把教师发言与学生可观察表现继续绑定。"
    },
    {
      id: randomUUID(),
      teacherMove: "课堂观察员 Agent 检查训练闭环",
      studentAgent: "课堂观察员 Agent",
      studentResponse: `当前已完成 ${state.turnCount} 轮教师输入和 ${state.agentRunStats.studentAgentActivations} 次学生 Agent 激活。`,
      eventOrMetric: `事件 Agent 触发 ${state.agentRunStats.eventAgentTriggers} 次，观察员建议 ${state.agentRunStats.observerAgentTips} 条。`,
      observerAdvice: "建议继续用追问、控场或活动组织动作补足证据链。"
    }
  ];

  return [...eventChains, ...memoryChains, ...metricFallbacks].slice(0, 5);
}

function buildAgentDecisionEvidence(
  state: ClassroomState,
  evidenceChains: ClassroomEvidenceChain[]
): AgentDecisionEvidence[] {
  const openEvents = state.events.filter((event) => !event.handled);
  const memoryTimeline = state.studentMemoryTimeline || [];
  const latestMemory = memoryTimeline.slice(-5);
  const latestObserverTips = state.timeline
    .filter((item) => item.role === "observer")
    .slice(-3)
    .map((item) => item.content);
  const weakestMetric = [
    { name: "参与度", value: state.metrics.participation },
    { name: "理解度", value: state.metrics.understanding },
    { name: "纪律", value: state.metrics.discipline },
    { name: "互动质量", value: state.metrics.interactionQuality }
  ].sort((a, b) => a.value - b.value)[0];

  return [
    {
      id: randomUUID(),
      agentName: "教师行为分析 Agent",
      decision: `将课堂阶段判定为“${state.currentStage}”，用于选择后续评分维度。`,
      basis: state.timeline
        .filter((item) => item.role === "teacher")
        .slice(-2)
        .map((item) => item.content)
        .join("；") || "尚无教师发言，保持初始状态。",
      impact: `影响课堂进度与目标达成判断，当前目标达成度为 ${state.metrics.goalAchievement}%。`
    },
    {
      id: randomUUID(),
      agentName: "学生 Agent 群体",
      decision: "依据学生画像与最近记忆生成差异化回应。",
      basis: latestMemory.length
        ? latestMemory
            .map((item) => `${item.studentName}：${item.fromStatus} -> ${item.toStatus}`)
            .join("；")
        : "尚未形成多轮学生记忆。",
      impact: `累计形成 ${memoryTimeline.length} 条学生状态变化记录。`
    },
    {
      id: randomUUID(),
      agentName: "课堂事件 Agent",
      decision: openEvents.length
        ? `保留 ${openEvents.length} 个待处理课堂风险。`
        : "当前课堂事件已基本得到回应。",
      basis: state.events.length
        ? state.events
            .slice(-4)
            .map((event) => `${event.description}（${event.handled ? "已处理" : "待处理"}）`)
            .join("；")
        : "本轮尚未触发明显课堂事件。",
      impact: `影响课堂应变能力评分，当前最弱指标为${weakestMetric.name} ${weakestMetric.value}%。`
    },
    {
      id: randomUUID(),
      agentName: "课堂观察员 Agent",
      decision: "把实时观察建议纳入报告证据链，优先提示可马上调整的教学动作。",
      basis: latestObserverTips.length
        ? latestObserverTips.map((tip) => compactText(tip, 80)).join("；")
        : "本轮观察建议较少，报告使用课堂指标和学生状态作为补充依据。",
      impact: `影响优势、问题和建议的具体化表达，当前已形成 ${state.agentRunStats.observerAgentTips} 条观察建议。`
    },
    {
      id: randomUUID(),
      agentName: "评价报告 Agent",
      decision: "汇总协作链路、事件处理和能力分数，生成下一轮训练任务。",
      basis: evidenceChains.length
        ? `已抽取 ${evidenceChains.length} 条课堂证据链。`
        : "证据链不足，使用事件与指标作为 fallback。",
      impact: `输出综合评分和专项建议，报告模式为 ${state.agentRunStats.reportAgentRuns} 次报告 Agent 运行。`
    }
  ];
}

function inferMetricEvidence(state: ClassroomState, eventType: string) {
  if (/wrong|confused|misunderstanding/.test(eventType)) {
    return `理解度 ${state.metrics.understanding}%，说明需要继续暴露学生思维过程。`;
  }

  if (/off_topic|discipline/.test(eventType)) {
    return `纪律状态 ${state.metrics.discipline}%，课堂事件 Agent 判断需明确规则边界。`;
  }

  if (/active|question|activity/.test(eventType)) {
    return `参与度 ${state.metrics.participation}%，互动质量 ${state.metrics.interactionQuality}%。`;
  }

  return `当前阶段 ${state.currentStage}，目标达成度 ${state.metrics.goalAchievement}%。`;
}

function buildAgentCollaboration(
  state: ClassroomState,
  dimensionCount: number,
  evidenceCount: number,
  providerMode: "rule" | "llm"
): AgentCollaborationStep[] {
  return [
    {
      agentName: "教师行为分析 Agent",
      role: "识别教师发言意图、课堂阶段与清晰度",
      output: `已分析 ${state.agentRunStats.teacherAnalyzerRuns} 轮教师行为，当前阶段为${state.currentStage}。`
    },
    {
      agentName: "学生 Agent 群体",
      role: "依据学生画像生成差异化回应",
      output: `累计激活 ${state.agentRunStats.studentAgentActivations} 次学生反应，覆盖沉默、误解、活跃和基础薄弱画像。`
    },
    {
      agentName: "课堂事件 Agent",
      role: "捕捉错误答案、沉默、跑题、纪律与进度风险",
      output: `识别 ${state.agentRunStats.eventAgentTriggers} 个课堂事件，未处理事件 ${state.events.filter((event) => !event.handled).length} 个。`
    },
    {
      agentName: "课堂观察员 Agent",
      role: "给出实时、克制、可执行的教学建议",
      output: `已输出 ${state.agentRunStats.observerAgentTips} 条观察建议，并形成 ${evidenceCount} 条证据链。`
    },
    {
      agentName: "评价报告 Agent",
      role: "汇总维度评分、证据链和下一轮训练任务",
      output: `以${providerMode === "llm" ? "LLM 增强" : "规则增强"}模式生成 ${dimensionCount} 项能力评分。`
    }
  ];
}

function buildStrengths(
  state: ClassroomState,
  questionCount: number,
  activityCount: number,
  evidenceChains: ClassroomEvidenceChain[],
  careSignals: ReturnType<typeof calculateClassroomCareSignals>
) {
  const strengths = [];
  const effectiveResponse = evidenceChains.find((chain) =>
    /正确|能|回答|说明|理解|参与|active|correct/.test(chain.studentResponse)
  );

  if (questionCount > 0) {
    strengths.push("具备提问意识，能够尝试引导学生参与课堂。");
  }

  if (state.metrics.understanding >= 65) {
    strengths.push("讲解清晰度较好，多数学生能够跟上课堂推进。");
  }

  if (activityCount > 0) {
    strengths.push("能够通过活动组织提升课堂参与度。");
  }

  if (effectiveResponse) {
    strengths.push(
      `能从学生反应中获得即时反馈，例如${effectiveResponse.studentAgent}回应“${compactText(
        effectiveResponse.studentResponse,
        42
      )}”。`
    );
  }

  if (careSignals.signalCount >= 2) {
    strengths.push(
      `课堂语言已出现公平与关怀信号：${careSignals.evidence.slice(0, 3).join("、")}。`
    );
  }

  if (!strengths.length) {
    strengths.push("能够完成基本试讲流程，课堂目标意识初步形成。");
  }

  return strengths;
}

function buildIssues(
  state: ClassroomState,
  questionCount: number,
  evidenceChains: ClassroomEvidenceChain[],
  careSignals: ReturnType<typeof calculateClassroomCareSignals>
) {
  const issues = [];
  const weakResponse = evidenceChains.find((chain) =>
    /错误|不会|沉默|跑题|误解|partial|silent|off_topic|待处理/.test(
      `${chain.studentResponse}${chain.eventOrMetric}`
    )
  );

  if (questionCount < 2) {
    issues.push("课堂提问不足，学生参与主要依赖教师单向讲解。");
  }

  if (careSignals.score < 75) {
    issues.push("公平提问和课堂关怀证据不足，需要明确照顾沉默、误解和基础薄弱学生。");
  }

  if (state.events.some((event) => event.type === "wrong_answer" && !event.handled)) {
    issues.push("学生答错后追问不足，未充分暴露学生思维过程。");
  }

  if (state.metrics.discipline < 60) {
    issues.push("课堂纪律出现波动，控场语言和活动规则需要更明确。");
  }

  if (state.metrics.progress < 65) {
    issues.push("教学进度偏慢，需要压缩非核心环节。");
  }

  if (weakResponse) {
    issues.push(
      `证据链显示仍有理解或参与风险：${weakResponse.studentAgent}的反应是“${compactText(
        weakResponse.studentResponse,
        48
      )}”。`
    );
  }

  return issues.length ? issues : ["本轮没有明显失控问题，下一步可提升提问层次和生成性互动。"];
}

function buildSuggestions(
  state: ClassroomState,
  questionCount: number,
  activityCount: number,
  evidenceChains: ClassroomEvidenceChain[],
  careSignals: ReturnType<typeof calculateClassroomCareSignals>
) {
  const concreteChain = evidenceChains.find((chain) => chain.teacherMove && chain.studentResponse);
  const suggestions = [
    "设计由易到难的连续问题，让沉默学生也能进入课堂。",
    "学生答错时先追问“你为什么这样想”，再引导其修正。",
    "每轮提问至少安排一次基础薄弱学生可回答的问题、一次同伴补充和一次鼓励性反馈。"
  ];

  if (concreteChain) {
    suggestions.push(
      `围绕教师发言“${compactText(concreteChain.teacherMove, 42)}”，下一轮要求学生先说依据、再举例，避免只停留在零散回答“${compactText(
        concreteChain.studentResponse,
        36
      )}”。`
    );
  }

  if (state.metrics.understanding < 65) {
    suggestions.push("讲解抽象概念时补充生活化例子，并拆成更小步骤。");
  }

  if (activityCount === 0) {
    suggestions.push("加入同桌讨论或小组合作，让学生产生可观察的学习产出。");
  }

  if (questionCount < 2) {
    suggestions.push("每个讲解节点后设置一个具体问题，避免长时间单向讲授。");
  }

  if (careSignals.score < 75) {
    suggestions.push("下一轮显式点名关注不同学生：先给等待时间，再给提示卡或例子，最后邀请同伴补充。");
  }

  return suggestions;
}

function pickNextTask(
  state: ClassroomState,
  questionCount: number,
  careSignals: ReturnType<typeof calculateClassroomCareSignals>
) {
  if (state.specialTrainingMode === "错误答案引导训练") {
    return "下一轮重点训练：错误答案引导，要求至少完成一次“追问思路—同伴补充—教师归纳”。";
  }

  if (state.specialTrainingMode === "控场专项训练") {
    return "下一轮重点训练：活动规则发布和纪律波动处理。";
  }

  if (state.specialTrainingMode === "基础薄弱学生讲解训练") {
    return "下一轮重点训练：用生活化例子重讲同一概念。";
  }

  if (state.events.some((event) => event.type === "wrong_answer" && !event.handled)) {
    return "下一轮重点训练：错误答案引导与分层追问。";
  }

  if (questionCount < 2) {
    return "下一轮重点训练：课堂提问设计。";
  }

  if (careSignals.score < 75) {
    return "下一轮重点训练：公平提问与课堂关怀，要求覆盖沉默学生、误解学生和基础薄弱学生各一次。";
  }

  if (state.metrics.discipline < 60) {
    return "下一轮重点训练：课堂控场与规则明确。";
  }

  return "下一轮重点训练：基础薄弱学生讲解与参与调动。";
}

function scoreFrom(value: number, bonus: number) {
  return Math.max(40, Math.min(96, Math.round(value + bonus)));
}

function compactText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function calculateClassroomCareSignals(state: ClassroomState, questionCount: number) {
  const text = state.timeline
    .filter((item) => item.role === "teacher" || item.role === "observer")
    .map((item) => item.content)
    .join("\n");
  const signalWords = [
    "公平",
    "每位",
    "不同",
    "差异",
    "基础薄弱",
    "沉默",
    "等待",
    "鼓励",
    "关怀",
    "支架",
    "同伴补充",
    "先想一想"
  ];
  const evidence = signalWords.filter((word) => text.includes(word));
  const studentDifferenceEvidence = (state.studentMemoryTimeline || []).filter((memory) =>
    /沉默|误解|薄弱|困惑|焦虑|参与/.test(
      `${memory.studentName}${memory.fromStatus}${memory.toStatus}${memory.reaction}${memory.agentReason}`
    )
  ).length;
  const score =
    52 +
    Math.min(20, questionCount * 5) +
    Math.min(20, evidence.length * 4) +
    Math.min(12, studentDifferenceEvidence * 3);

  return {
    score,
    signalCount: evidence.length + studentDifferenceEvidence,
    evidence: [
      ...evidence,
      studentDifferenceEvidence ? `学生差异记录 ${studentDifferenceEvidence} 条` : ""
    ].filter(Boolean)
  };
}
