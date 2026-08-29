import { randomUUID } from "node:crypto";
import type {
  ClassroomEvent,
  ClassroomEventType,
  ClassroomMetrics,
  ClassroomState,
  EventSeverity,
  StudentReaction,
  TeacherActionAnalysis
} from "./classroomTypes.js";

export function updateHandledEvents(
  events: ClassroomEvent[],
  teacherText: string,
  action: TeacherActionAnalysis
) {
  const text = teacherText.trim();
  const isManagementMove = action.actionType === "management";
  const isQuestionSupportMove =
    action.actionType === "follow_up" ||
    action.actionType === "feedback" ||
    /为什么这样想|你的思路|一起分析|重新判断|先确定.*平均分|关键条件|修正/.test(text);
  const isParticipationSupportMove =
    action.actionType === "instruction" ||
    /同桌|小组|先讨论|选择|二选一|先写|举手|每人|低声说给同伴/.test(text);
  const isFocusRecoveryMove =
    isManagementMove || /回到任务|围绕|先停一下|活动规则|注意听讲|看黑板|不跑题/.test(text);
  const isProgressRecoveryMove =
    action.actionType === "summary" || /压缩|总结|核心结论|最后|保留核心|收束/.test(text);

  return events.map((event) => {
    if (event.handled) {
      return event;
    }

    if (
      event.type === "wrong_answer" &&
      isQuestionSupportMove
    ) {
      return { ...event, handled: true };
    }

    if (
      (event.type === "discipline_issue" || event.type === "off_topic") &&
      isFocusRecoveryMove
    ) {
      return { ...event, handled: true };
    }

    if (
      event.type === "no_response" &&
      isParticipationSupportMove
    ) {
      return { ...event, handled: true };
    }

    if (event.type === "time_risk" && isProgressRecoveryMove) {
      return { ...event, handled: true };
    }

    return event;
  });
}

export function triggerClassroomEvents({
  state,
  action,
  reactions,
  metrics
}: {
  state: ClassroomState;
  action: TeacherActionAnalysis;
  reactions: StudentReaction[];
  metrics: ClassroomMetrics;
}) {
  const existingOpenTypes = new Set(
    state.events.filter((event) => !event.handled).map((event) => event.type)
  );
  const events: ClassroomEvent[] = [];
  const hasWrongAnswer = reactions.some(
    (reaction) =>
      reaction.answerQuality === "misconception" || reaction.eventType === "wrong_answer"
  );
  const hasSilent = reactions.some(
    (reaction) => reaction.answerQuality === "silent" || reaction.eventType === "no_response"
  );
  const hasOffTopic = reactions.some(
    (reaction) => reaction.answerQuality === "off_topic" || reaction.eventType === "off_topic"
  );
  const hasWeakParticipation =
    reactions.length <= 1 ||
    reactions.some((reaction) => reaction.answerQuality === "silent") ||
    metrics.participation < 50;
  const questionLike = action.actionType === "question" || action.actionType === "follow_up";
  const isManagementMove = action.actionType === "management";
  const unresolvedEventPressure = state.events.filter((event) => !event.handled).length;
  const expectedProgress = Math.min(92, 16 + (state.turnCount + 1) * 10);

  if (hasWrongAnswer && !existingOpenTypes.has("wrong_answer")) {
    events.push(createEvent("wrong_answer", buildWrongAnswerDescription(action), "medium"));
  }

  if (
    questionLike &&
    (hasSilent || hasWeakParticipation || action.specificity < 50) &&
    !existingOpenTypes.has("no_response")
  ) {
    events.push(createEvent("no_response", buildNoResponseDescription(action, reactions.length), "medium"));
  }

  if (
    (hasOffTopic || metrics.discipline < 62) &&
    !existingOpenTypes.has("off_topic") &&
    !isManagementMove
  ) {
    events.push(createEvent("off_topic", buildOffTopicDescription(action), "low"));
  }

  if (
    (metrics.discipline < 50 ||
      (hasOffTopic && (action.actionType === "instruction" || metrics.discipline < 64))) &&
    !existingOpenTypes.has("discipline_issue") &&
    !isManagementMove
  ) {
    events.push(createEvent("discipline_issue", buildDisciplineDescription(action), "high"));
  }

  if (
    (metrics.progress < expectedProgress - 16 ||
      (state.turnCount >= 4 && action.actionType !== "summary" && metrics.progress < 68) ||
      (state.turnCount >= 3 && unresolvedEventPressure >= 2)) &&
    !existingOpenTypes.has("time_risk")
  ) {
    events.push(createEvent("time_risk", buildTimeRiskDescription(state, expectedProgress), "medium"));
  }

  return events;
}

function buildWrongAnswerDescription(action: TeacherActionAnalysis) {
  const focus = action.topicKeywords.slice(0, 3).join("、") || action.contentFocus;

  return `误解型学生围绕“${focus}”给出了典型错误答案，需要教师追问其思路并引导修正。`;
}

function buildNoResponseDescription(action: TeacherActionAnalysis, reactionCount: number) {
  const focus = action.topicKeywords.slice(0, 2).join("、") || action.contentFocus;

  return `围绕“${focus}”的提问只有 ${reactionCount} 名学生形成有效回应，课堂参与度偏低。`;
}

function buildOffTopicDescription(action: TeacherActionAnalysis) {
  const focus = action.topicKeywords.slice(0, 2).join("、") || action.contentFocus;

  return `有学生围绕“${focus}”延伸到无关话题，课堂注意力被带离当前任务。`;
}

function buildDisciplineDescription(action: TeacherActionAnalysis) {
  const stage = action.stage === "未知" ? "当前环节" : action.stage;

  return `${stage}中出现插话、跑题或规则执行不稳，课堂纪律下降，需要教师明确任务边界。`;
}

function buildTimeRiskDescription(state: ClassroomState, expectedProgress: number) {
  return `当前教学进度为 ${state.metrics.progress}%，低于第 ${state.turnCount + 1} 轮预期进度 ${expectedProgress}%，可能出现拖堂风险。`;
}

function createEvent(
  type: ClassroomEventType,
  description: string,
  severity: EventSeverity
): ClassroomEvent {
  return {
    id: randomUUID(),
    type,
    description,
    severity,
    handled: false,
    timestamp: Date.now(),
    sourceAgent: "课堂事件Agent"
  };
}
