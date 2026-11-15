import { randomUUID } from "node:crypto";
import type {
  ClassroomActionRequest,
  ClassroomConfig,
  ClassroomSpeakResponse,
  ClassroomStage,
  ClassroomTimelineItem
} from "./classroomTypes.js";
import { createClassroomState } from "./classroomGenerator.js";
import { generateObserverTips } from "./classroomObserverAgent.js";
import { generateClassroomReport } from "./classroomReportGenerator.js";
import { ClassroomSessionStore } from "./classroomSessionStore.js";
import {
  triggerClassroomEvents,
  updateHandledEvents
} from "./classroomEventEngine.js";
import { generateStudentReactions } from "./studentReactionEngine.js";
import { analyzeTeacherAction } from "./teacherActionAnalyzer.js";
import { createClassroomLlmProvider, type LlmProvider } from "./llmProvider.js";
import {
  observeOperation,
  recordClassroomMetricScores,
  recordClassroomReportScores,
  summarizeText
} from "../observability.js";

export class ClassroomService {
  constructor(
    private readonly sessions = new ClassroomSessionStore(),
    private readonly llmProvider: LlmProvider = createClassroomLlmProvider()
  ) {}

  createClassroom(input: Partial<ClassroomConfig> & { knowledgeBaseIds?: string[] }) {
    const classroomState = {
      ...createClassroomState(input),
      knowledgeBaseIds: Array.isArray(input.knowledgeBaseIds)
        ? input.knowledgeBaseIds.filter((id): id is string => typeof id === "string" && Boolean(id))
        : []
    };
    this.sessions.save(classroomState);

    return {
      sessionId: classroomState.sessionId,
      classroomState
    };
  }

  restoreClassroom(input: unknown) {
    const classroomState = normalizeRestoredClassroomState(input);
    this.sessions.save(classroomState);

    return {
      sessionId: classroomState.sessionId,
      classroomState
    };
  }

  async teacherSpeak(sessionId: string, teacherText: string): Promise<ClassroomSpeakResponse> {
    return observeOperation(
      "classroom.teacher_speak",
      {
        input: {
          sessionId,
          teacherText: summarizeText(teacherText)
        },
        metadata: {
          operation: "teacher_speak"
        }
      },
      async (observation) => {
        const state = this.sessions.get(sessionId);
        const text = teacherText.trim();

        if (!state) {
          throw new ClassroomServiceError(404, "虚拟课堂会话不存在，请重新生成课堂。");
        }

        if (!text) {
          throw new ClassroomServiceError(400, "教师发言不能为空。");
        }

        const callContext = parseTargetedCallContext(text);
        const visibleText = stripTargetedCallMarker(text);
        const analysisText = callContext?.sourceQuestion || text;
        const teacherAction = analyzeTeacherAction(analysisText, state);
        const handledEvents = updateHandledEvents(state.events, visibleText, teacherAction);
        const reactionResult = await generateStudentReactions(
          { ...state, events: handledEvents },
          analysisText,
          teacherAction,
          this.llmProvider,
          callContext
            ? {
                targetOnly: true,
                targetStudentId: callContext.targetStudentId
              }
            : undefined
        );
        const intermediateState = {
          ...state,
          events: handledEvents,
          students: reactionResult.students,
          metrics: reactionResult.metrics
        };
        const newEvents = triggerClassroomEvents({
          state: intermediateState,
          action: teacherAction,
          reactions: reactionResult.reactions,
          metrics: reactionResult.metrics
        });
        const observerTips = generateObserverTips({
          state: {
            ...intermediateState,
            events: [...handledEvents, ...newEvents]
          },
          action: teacherAction,
          reactions: reactionResult.reactions,
          newEvents
        });
        const timeline = [
          ...state.timeline,
          createTimelineItem({
            role: "teacher",
            speaker: "教师",
            content: visibleText,
            eventType: `teacher_${teacherAction.actionType}`
          }),
          ...reactionResult.reactions.map((reaction) =>
            createTimelineItem({
              role: "student",
              speaker: reaction.studentName,
              content: reaction.content,
              eventType: reaction.eventType,
              studentId: reaction.studentId,
              answerQuality: reaction.answerQuality,
              generationMode: reaction.generationMode,
              validationPassed: reaction.validationPassed
            })
          ),
          ...newEvents.map((event) =>
            createTimelineItem({
              role: "system",
              speaker: "课堂事件",
              content: event.description,
              eventType: event.type
            })
          ),
          ...observerTips.map((tip) =>
            createTimelineItem({
              role: "observer",
              speaker: "课堂观察员",
              content: tip,
              eventType: "observer_tip"
            })
          )
        ];
        const studentMemoryTimeline = appendStudentMemoryTimeline({
          currentTimeline: state.studentMemoryTimeline || [],
          previousStudents: state.students,
          nextStudents: reactionResult.students,
          reactions: reactionResult.reactions,
          teacherText: visibleText,
          stage: teacherAction.stage,
          turn: state.turnCount + 1
        });
        const classroomState = this.sessions.update({
          ...state,
          currentStage: teacherAction.stage,
          students: reactionResult.students,
          metrics: reactionResult.metrics,
          timeline,
          studentMemoryTimeline,
          events: [...handledEvents, ...newEvents],
          agentRunStats: {
            teacherAnalyzerRuns: state.agentRunStats.teacherAnalyzerRuns + 1,
            studentAgentActivations:
              state.agentRunStats.studentAgentActivations +
              reactionResult.reactions.length,
            eventAgentTriggers:
              state.agentRunStats.eventAgentTriggers + newEvents.length,
            observerAgentTips:
              state.agentRunStats.observerAgentTips + observerTips.length,
            reportAgentRuns: state.agentRunStats.reportAgentRuns
          },
          turnCount: state.turnCount + 1
        });
        const result = {
          teacherAction,
          studentReactions: reactionResult.reactions,
          observerTips,
          updatedMetrics: classroomState.metrics,
          events: classroomState.events,
          classroomState
        };

        observation.update({
          output: {
            teacherAction,
            studentReactionCount: reactionResult.reactions.length,
            observerTipCount: observerTips.length,
            newEventTypes: newEvents.map((event) => event.type),
            studentAnswerModes: reactionResult.reactions.map((reaction) => ({
              studentType: reaction.studentType,
              answerQuality: reaction.answerQuality,
              mode: reaction.generationMode || "rule",
              validationPassed: reaction.validationPassed ?? true,
              validationIssues: reaction.validationIssues || [],
              topicKeywords: reaction.topicKeywords
            })),
            agentRunStats: classroomState.agentRunStats,
            studentMemoryTimelineCount: classroomState.studentMemoryTimeline.length,
            metrics: classroomState.metrics
          }
        });
        recordClassroomMetricScores(observation, classroomState.metrics);

        return result;
      }
    );
  }

  async classroomAction(request: ClassroomActionRequest) {
    const state = this.sessions.get(request.sessionId);

    if (!state) {
      throw new ClassroomServiceError(404, "虚拟课堂会话不存在，请重新生成课堂。");
    }

    const targetStudent = request.targetStudentId
      ? state.students.find((student) => student.id === request.targetStudentId)
      : undefined;
    const teacherText = buildActionTeacherText(request, state, targetStudent);

    return this.teacherSpeak(request.sessionId, teacherText);
  }

  async generateReport(sessionId: string) {
    return observeOperation(
      "classroom.report",
      {
        input: {
          sessionId
        },
        metadata: {
          operation: "generate_report"
        }
      },
      async (observation) => {
        const state = this.sessions.get(sessionId);

        if (!state) {
          throw new ClassroomServiceError(404, "虚拟课堂会话不存在，无法生成报告。");
        }

        let modelInsight: string | undefined;
        let providerMode: "rule" | "llm" = "rule";

        if (this.llmProvider.mode === "llm") {
          try {
            modelInsight = await this.llmProvider.generateClassroomReport(
              buildReportPrompt(state),
              { timeoutMs: 6000 }
            );
            providerMode = "llm";
          } catch (error) {
            modelInsight = undefined;
            providerMode = "rule";
            observation.update({
              metadata: {
                llmFallback: true,
                llmError: error instanceof Error ? error.message : String(error)
              }
            });
          }
        }

        const reportState = {
          ...state,
          agentRunStats: {
            ...state.agentRunStats,
            reportAgentRuns: state.agentRunStats.reportAgentRuns + 1
          }
        };
        const report = generateClassroomReport(reportState, {
          modelInsight,
          providerMode
        });
        this.sessions.update(reportState);

        observation.update({
          output: {
            overallScore: report.overallScore,
            providerMode: report.providerMode,
            dimensionCount: report.dimensionScores.length,
            evidenceChainCount: report.evidenceChains.length,
            agentRunStats: report.agentRunStats,
            unresolvedEventCount: report.eventReview.filter((event) => !event.handled).length
          }
        });
        recordClassroomReportScores(observation, report, state.metrics);

        return report;
      }
    );
  }

  getClassroom(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  markSaved(sessionId: string, conversationId: string) {
    const state = this.sessions.get(sessionId);

    if (!state) {
      return;
    }

    this.sessions.update({
      ...state,
      savedConversationId: conversationId
    });
  }
}

function normalizeRestoredClassroomState(input: unknown) {
  const state = input as ReturnType<typeof createClassroomState>;

  if (
    !state ||
    typeof state !== "object" ||
    typeof state.sessionId !== "string" ||
    !Array.isArray(state.students) ||
    !Array.isArray(state.timeline) ||
    !Array.isArray(state.events) ||
    !state.metrics ||
    typeof state.subject !== "string" ||
    typeof state.grade !== "string" ||
    typeof state.topic !== "string"
  ) {
    throw new ClassroomServiceError(400, "课堂恢复数据不完整，请重新生成课堂。");
  }

  return {
    ...state,
    topicKeywords: Array.isArray(state.topicKeywords) ? state.topicKeywords : [],
    commonMisconceptions: Array.isArray(state.commonMisconceptions)
      ? state.commonMisconceptions
      : [],
    studentMemoryTimeline: Array.isArray(state.studentMemoryTimeline)
      ? state.studentMemoryTimeline
      : [],
    agentRunStats: state.agentRunStats || {
      teacherAnalyzerRuns: 0,
      studentAgentActivations: 0,
      eventAgentTriggers: 0,
      observerAgentTips: 0,
      reportAgentRuns: 0
    },
    updatedAt: Date.now()
  };
}

export class ClassroomServiceError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function createTimelineItem(
  item: Omit<ClassroomTimelineItem, "id" | "timestamp">
): ClassroomTimelineItem {
  return {
    ...item,
    id: randomUUID(),
    timestamp: Date.now()
  };
}

function appendStudentMemoryTimeline({
  currentTimeline,
  previousStudents,
  nextStudents,
  reactions,
  teacherText,
  stage,
  turn
}: {
  currentTimeline: NonNullable<ReturnType<ClassroomService["getClassroom"]>>["studentMemoryTimeline"];
  previousStudents: NonNullable<ReturnType<ClassroomService["getClassroom"]>>["students"];
  nextStudents: NonNullable<ReturnType<ClassroomService["getClassroom"]>>["students"];
  reactions: ClassroomSpeakResponse["studentReactions"];
  teacherText: string;
  stage: ClassroomStage;
  turn: number;
}) {
  const previousById = new Map(previousStudents.map((student) => [student.id, student]));
  const nextById = new Map(nextStudents.map((student) => [student.id, student]));
  const entries = reactions.map((reaction) => {
    const previous = previousById.get(reaction.studentId);
    const next = nextById.get(reaction.studentId);

    return {
      id: randomUUID(),
      studentId: reaction.studentId,
      studentName: reaction.studentName,
      fromStatus: previous?.currentStatus || "focused",
      toStatus: next?.currentStatus || previous?.currentStatus || "focused",
      trigger: `${reaction.triggeredBy}：${summarizeText(teacherText, 80)}`,
      reaction: reaction.content,
      agentReason: reaction.agentReason,
      stage,
      turn,
      timestamp: Date.now()
    };
  });

  return [...currentTimeline, ...entries].slice(-80);
}

function buildActionTeacherText(
  request: ClassroomActionRequest,
  state: NonNullable<ReturnType<ClassroomService["getClassroom"]>>,
  targetStudent?: NonNullable<ReturnType<ClassroomService["getClassroom"]>>["students"][number]
) {
  const fallbackText = request.teacherText?.trim();

  if (fallbackText) {
    return fallbackText;
  }

  const lastQuestion = findLastTeacherQuestion(state);
  const sourceQuestion = lastQuestion || "请结合刚才的课堂内容回答。";
  const topicFocus = state.topicKeywords.slice(0, 4).join("、") || state.topic;

  if (
    (request.actionType === "call_on_student" || request.actionType === "follow_up_student") &&
    !targetStudent
  ) {
    throw new ClassroomServiceError(400, "请先选择一个点名对象。");
  }

  if (request.actionType === "call_on_student") {
    const selectedStudent = targetStudent;

    if (!selectedStudent) {
      throw new ClassroomServiceError(400, "请先选择一个点名对象。");
    }

    return encodeTargetedCall({
      targetStudentId: selectedStudent.id,
      sourceQuestion,
      visibleText: `${selectedStudent.name}，请你回答刚才这个问题：${sourceQuestion}`
    });
  }

  if (request.actionType === "follow_up_student") {
    const selectedStudent = targetStudent;

    if (!selectedStudent) {
      throw new ClassroomServiceError(400, "请先选择一个点名对象。");
    }

    return encodeTargetedCall({
      targetStudentId: selectedStudent.id,
      sourceQuestion,
      visibleText: `${selectedStudent.name}，你为什么这样想？请围绕“${topicFocus}”再说清楚，并说明你的依据：${sourceQuestion}`
    });
  }

  if (request.actionType === "start_group_activity") {
    return `接下来我们进行同桌讨论，请每组用两分钟围绕“${topicFocus}”画一个例子，并选择一名同学说明自己的判断。`;
  }

  if (request.actionType === "pause_and_manage") {
    return `先安静一下，大家暂停讨论，注意听讲。我们先明确活动规则：发言必须回到“${topicFocus}”这个任务，不跑题、不插话，再继续。`;
  }

  return `我们压缩总结一下，只保留本节课的核心结论：围绕“${topicFocus}”先说判断依据，再处理拓展问题。`;
}

function findLastTeacherQuestion(
  state: NonNullable<ReturnType<ClassroomService["getClassroom"]>>
) {
  return [...state.timeline]
    .reverse()
    .find(
      (item) =>
        item.role === "teacher" &&
        (/teacher_(question|follow_up)/.test(item.eventType) ||
          /为什么|谁来|请|怎么看|能不能|说说|问题|？|\?/.test(item.content))
    )?.content;
}

function encodeTargetedCall({
  targetStudentId,
  sourceQuestion,
  visibleText
}: {
  targetStudentId: string;
  sourceQuestion: string;
  visibleText: string;
}) {
  return `${visibleText}\n[[targeted_call:${JSON.stringify({
    targetStudentId,
    sourceQuestion
  })}]]`;
}

function parseTargetedCallContext(text: string) {
  const match = text.match(/\[\[targeted_call:(.+)\]\]$/s);

  if (!match) {
    return undefined;
  }

  try {
    const payload = JSON.parse(match[1]) as {
      targetStudentId?: string;
      sourceQuestion?: string;
    };

    if (!payload.targetStudentId || !payload.sourceQuestion) {
      return undefined;
    }

    return {
      targetOnly: true,
      targetStudentId: payload.targetStudentId,
      sourceQuestion: payload.sourceQuestion
    };
  } catch {
    return undefined;
  }
}

function stripTargetedCallMarker(text: string) {
  return text.replace(/\n?\[\[targeted_call:.+\]\]$/s, "").trim();
}

function buildReportPrompt(state: NonNullable<ReturnType<ClassroomService["getClassroom"]>>) {
  const recentTimeline = state.timeline
    .slice(-12)
    .map((item) => `${item.speaker}：${item.content}`)
    .join("\n");
  const openEvents = state.events
    .filter((event) => !event.handled)
    .map((event) => event.description)
    .join("；") || "暂无未处理事件";

  return [
    `课堂画像：${state.classProfile}`,
    `专项训练：${state.specialTrainingMode || "综合训练"}`,
    `课堂指标：参与度${state.metrics.participation}，理解度${state.metrics.understanding}，纪律${state.metrics.discipline}，进度${state.metrics.progress}，互动质量${state.metrics.interactionQuality}`,
    `未处理事件：${openEvents}`,
    `最近课堂互动：\n${recentTimeline}`
  ].join("\n");
}
