import { randomUUID } from "node:crypto";
import type { ClassroomConfig, ClassroomMetrics, ClassroomState } from "./classroomTypes.js";
import { buildClassProfile, generateVirtualStudents } from "./studentAgentFactory.js";

export function createClassroomState(input: Partial<ClassroomConfig>): ClassroomState {
  const config = normalizeClassroomConfig(input);
  const students = generateVirtualStudents(config);
  const now = Date.now();

  return {
    ...config,
    sessionId: randomUUID(),
    classProfile: buildClassProfile(config, students),
    currentStage: "未知",
    students,
    metrics: buildInitialMetrics(config),
    timeline: [
      {
        id: randomUUID(),
        role: "system",
        speaker: "系统",
        content: "虚拟课堂已生成，请以教师身份开始试讲。",
        timestamp: now,
        eventType: "classroom_created"
      }
    ],
    studentMemoryTimeline: [],
    events: [],
    agentRunStats: {
      teacherAnalyzerRuns: 0,
      studentAgentActivations: 0,
      eventAgentTriggers: 0,
      observerAgentTips: 0,
      reportAgentRuns: 0
    },
    turnCount: 0,
    createdAt: now,
    updatedAt: now
  };
}

export function normalizeClassroomConfig(input: Partial<ClassroomConfig>): ClassroomConfig {
  const subject = clean(input.subject) || "数学";
  const grade = clean(input.grade) || "初中";
  const topic = clean(input.topic) || "待定课题";
  const topicKeywords = normalizeTopicKeywords(input.topicKeywords, {
    subject,
    grade,
    topic
  });

  return {
    subject,
    grade,
    topic,
    classType: clean(input.classType) || "普通班",
    trainingGoal: clean(input.trainingGoal) || "提问训练",
    difficulty: clean(input.difficulty) || "普通",
    specialTrainingMode: clean(input.specialTrainingMode) || "综合训练",
    topicKeywords,
    commonMisconceptions: normalizeCommonMisconceptions(input.commonMisconceptions, {
      subject,
      grade,
      topic,
      topicKeywords
    })
  };
}

function normalizeTopicKeywords(
  value: unknown,
  context: Pick<ClassroomConfig, "subject" | "grade" | "topic">
) {
  const provided = Array.isArray(value) ? value.filter(isCleanText) : [];
  const defaults = inferDefaultTopicKeywords(context);

  return [...new Set([...provided, ...defaults])].slice(0, 12);
}

function inferDefaultTopicKeywords({
  subject,
  grade,
  topic
}: Pick<ClassroomConfig, "subject" | "grade" | "topic">) {
  if (/数学/.test(subject) && /初中|七年级/.test(grade) && /分数的意义|分数/.test(topic)) {
    return [
      "分数的意义",
      "单位1",
      "平均分",
      "整体",
      "部分",
      "若干份",
      "取几份",
      "分子",
      "分母",
      "四分之一",
      "非平均分",
      "几分之几"
    ];
  }

  return topic && topic !== "待定课题" ? [topic] : [];
}

function normalizeCommonMisconceptions(
  value: unknown,
  context: Pick<ClassroomConfig, "subject" | "grade" | "topic" | "topicKeywords">
) {
  const provided = Array.isArray(value) ? value.filter(isCleanText) : [];
  const defaults = inferDefaultMisconceptions(context);

  return [...new Set([...provided, ...defaults])].slice(0, 8);
}

function inferDefaultMisconceptions({
  subject,
  grade,
  topic,
  topicKeywords
}: Pick<ClassroomConfig, "subject" | "grade" | "topic" | "topicKeywords">) {
  const source = `${subject} ${grade} ${topic} ${topicKeywords.join(" ")}`;

  if (/数学/.test(source) && /分数|单位1|平均分/.test(source)) {
    return [
      "把随便分当成平均分",
      "没有先确定单位1",
      "把分子和分母含义说反",
      "只看到一份，忽略平均分成几份",
      "把不同整体中的四分之一直接比较大小"
    ];
  }

  return [];
}

function isCleanText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function buildInitialMetrics(config: ClassroomConfig): ClassroomMetrics {
  const base =
    config.classType === "基础薄弱班"
      ? { participation: 52, understanding: 48, discipline: 68 }
      : config.classType === "活跃班"
        ? { participation: 72, understanding: 66, discipline: 58 }
        : config.classType === "纪律较差班"
          ? { participation: 60, understanding: 58, discipline: 44 }
          : { participation: 64, understanding: 62, discipline: 70 };
  const difficultyShift = config.difficulty === "挑战" ? -6 : config.difficulty === "简单" ? 5 : 0;

  return {
    participation: clamp(base.participation + difficultyShift),
    understanding: clamp(base.understanding + difficultyShift),
    discipline: clamp(base.discipline + difficultyShift),
    progress: 12,
    interactionQuality: 58,
    goalAchievement: 18
  };
}

function clean(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
