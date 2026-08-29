import type {
  ClassroomEvent,
  ClassroomState,
  StudentReaction,
  TeacherActionAnalysis
} from "./classroomTypes.js";

export function generateObserverTips({
  state,
  action,
  reactions,
  newEvents
}: {
  state: ClassroomState;
  action: TeacherActionAnalysis;
  reactions: StudentReaction[];
  newEvents: ClassroomEvent[];
}) {
  const tips: string[] = [];
  const recentObserverCount = state.timeline
    .slice(-6)
    .filter((item) => item.role === "observer").length;

  if (recentObserverCount >= 2) {
    return tips;
  }

  const metrics = state.metrics;
  const hasWeakConfusion = reactions.some(
    (reaction) => reaction.studentType === "weak_student" && reaction.eventType === "confused"
  );
  const hasWrongAnswer = newEvents.some((event) => event.type === "wrong_answer");
  const hasNoResponse = newEvents.some((event) => event.type === "no_response");
  const hasOffTopic = newEvents.some((event) => event.type === "off_topic");
  const hasDisciplineIssue = newEvents.some((event) => event.type === "discipline_issue");
  const hasTimeRisk = newEvents.some((event) => event.type === "time_risk");

  if (hasNoResponse || metrics.participation < 45) {
    tips.push("当前课堂参与度偏低，建议设置一个更具体、入口更低的问题。");
  }

  if (metrics.understanding < 55 || hasWeakConfusion) {
    tips.push("基础薄弱学生出现困惑，建议补充生活化例子或拆成更小步骤。");
  }

  if (hasDisciplineIssue || metrics.discipline < 58) {
    tips.push("课堂纪律出现波动，建议先暂停活动并明确规则。");
  }

  if (hasOffTopic) {
    tips.push("有学生把话题带离主线，建议用一句话确认其想法，再把回答拉回当前任务。");
  }

  if (hasTimeRisk || (metrics.progress < 45 && state.turnCount >= 4)) {
    tips.push("当前教学进度偏慢，建议压缩后续活动并保留核心目标。");
  }

  if (hasWrongAnswer || action.actionType === "feedback" || action.actionType === "follow_up") {
    tips.push("学生答错后，建议先追问其思路，再通过关键问题帮助其修正理解。");
  }

  return tips.slice(0, 2);
}
