import { randomUUID } from "node:crypto";
import type {
  ClassroomConfig,
  StudentAgent,
  StudentLevel,
  StudentStatus,
  StudentType
} from "./classroomTypes.js";

type StudentTemplate = {
  type: StudentType;
  level: StudentLevel;
  status: StudentStatus;
  personality: string;
  behaviorTendency: string;
  knowledgeFoundation: string;
  participationWillingness: number;
  misconception: string;
  emotionState: string;
};

const names = [
  "林一诺",
  "陈思远",
  "周雨桐",
  "王子涵",
  "赵明轩",
  "许嘉宁",
  "何若溪",
  "孙浩然",
  "李知夏",
  "吴承泽",
  "郑可欣",
  "刘奕辰"
];

const templates: StudentTemplate[] = [
  {
    type: "top_student",
    level: "high",
    status: "focused",
    personality: "思维敏捷，喜欢把问题追问到底",
    behaviorTendency: "主动回答，并提出拓展性问题",
    knowledgeFoundation: "能快速抓住知识结构，已掌握大部分前置概念",
    participationWillingness: 92,
    misconception: "容易提前给结论，忽略同伴还没有跟上的过程",
    emotionState: "自信"
  },
  {
    type: "weak_student",
    level: "low",
    status: "confused",
    personality: "认真但基础薄弱，遇到抽象概念容易卡住",
    behaviorTendency: "需要例子、步骤和更慢的讲解",
    knowledgeFoundation: "前置知识不稳，依赖具体例子建立理解",
    participationWillingness: 48,
    misconception: "容易把相近概念混为一谈，步骤一多就失去线索",
    emotionState: "谨慎"
  },
  {
    type: "silent_student",
    level: "middle",
    status: "silent",
    personality: "内向谨慎，不确定时通常保持沉默",
    behaviorTendency: "被点名或问题足够具体时才回应",
    knowledgeFoundation: "有一定基础，但缺少表达信心",
    participationWillingness: 34,
    misconception: "担心答错，常把自己的疑问隐藏起来",
    emotionState: "观望"
  },
  {
    type: "naughty_student",
    level: "middle",
    status: "distracted",
    personality: "反应快但注意力不稳定，喜欢插话",
    behaviorTendency: "容易跑题，也可能带动课堂气氛",
    knowledgeFoundation: "理解力尚可，但需要明确规则和任务边界",
    participationWillingness: 76,
    misconception: "容易把课堂任务转成个人兴趣话题",
    emotionState: "兴奋"
  },
  {
    type: "misunderstanding_student",
    level: "middle",
    status: "focused",
    personality: "愿意表达，但常把关键概念理解反",
    behaviorTendency: "给出典型错误答案，暴露学习误区",
    knowledgeFoundation: "能参与讨论，但关键概念边界不清",
    participationWillingness: 68,
    misconception: "常把条件关系、因果顺序或概念包含关系看反",
    emotionState: "急于确认"
  }
];

export function generateVirtualStudents(config: ClassroomConfig): StudentAgent[] {
  return templates.map((template, index) => {
    const classTypeShift =
      config.classType === "基础薄弱班" && template.type === "weak_student"
        ? -8
        : config.classType === "活跃班" && template.type === "naughty_student"
          ? 8
          : config.classType === "纪律较差班" && template.type === "naughty_student"
            ? 12
            : 0;

    return {
      id: randomUUID(),
      name: names[index % names.length],
      type: template.type,
      level: template.level,
      personality: template.personality,
      behaviorTendency: template.behaviorTendency,
      knowledgeFoundation: personalize(template.knowledgeFoundation, config, index),
      participationWillingness: Math.max(
        12,
        Math.min(96, template.participationWillingness + classTypeShift)
      ),
      misconception: personalizeMisconception(template, config),
      emotionState: template.emotionState,
      recentMemory: ["等待教师首次互动"],
      currentStatus: template.status,
      lastReaction: "等待课堂开始"
    };
  });
}

export function buildClassProfile(config: ClassroomConfig, students: StudentAgent[]) {
  const weakCount = students.filter((student) => student.type === "weak_student").length;
  const activeCount = students.filter((student) =>
    student.type === "top_student" || student.type === "naughty_student"
  ).length;
  const silentCount = students.filter((student) => student.type === "silent_student").length;
  const disciplineText =
    config.classType === "纪律较差班"
      ? "课堂纪律波动较明显，需要教师及时明确规则"
      : config.classType === "活跃班"
        ? "课堂气氛活跃，但学生容易延伸话题"
        : config.classType === "基础薄弱班"
          ? "学生需要更具体的例子和分层提示"
          : "整体课堂秩序一般，适合进行常规微格训练";

  const topicKeywordText = config.topicKeywords.length
    ? `本轮课题关键词：${config.topicKeywords.slice(0, 6).join("、")}。`
    : "";

  return `${config.grade}${config.subject}${config.classType}五人微格课堂，围绕“${config.topic || "待定课题"}”开展${config.trainingGoal}。班级固定包含学霸型、基础薄弱型、沉默型、调皮型和误解型各 1 名学生 Agent，其中有 ${weakCount} 名基础薄弱学生、${activeCount} 名活跃学生、${silentCount} 名低参与学生，${disciplineText}。${topicKeywordText}专项训练重点：${config.specialTrainingMode || "综合训练"}。本课堂由教师行为分析 Agent、学生 Agent 群体、课堂事件 Agent、课堂观察员 Agent 和评价报告 Agent 协同运行。`;
}

function personalize(base: string, config: ClassroomConfig, index: number) {
  const topicHint = config.topic && config.topic !== "待定课题"
    ? `，对“${config.topic}”的经验第 ${index % 2 ? "一" : "二"}层较弱`
    : "";

  return `${base}${topicHint}`;
}

function personalizeMisconception(template: StudentTemplate, config: ClassroomConfig) {
  if (template.type !== "misunderstanding_student" || config.commonMisconceptions.length === 0) {
    return template.misconception;
  }

  return `${template.misconception}；本课典型误区：${config.commonMisconceptions.slice(0, 3).join("、")}`;
}
