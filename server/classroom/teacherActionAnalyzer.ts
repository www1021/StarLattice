import type {
  ClassroomStage,
  ClassroomState,
  DifficultyLevel,
  QuestionKind,
  TeacherActionAnalysis,
  TeacherActionType
} from "./classroomTypes.js";

const questionKeywords = [
  "同学们想一想",
  "谁来回答",
  "为什么",
  "请你说说",
  "你怎么看",
  "能不能",
  "可不可以",
  "是不是",
  "请说明",
  "大家觉得",
  "哪位同学",
  "问题"
];

const followUpKeywords = [
  "追问",
  "接着说",
  "再想一想",
  "再补充",
  "为什么这样想",
  "你的理由",
  "你的依据",
  "能不能再",
  "请说明理由",
  "如果不是",
  "有没有不同"
];
const activityKeywords = ["分组", "讨论", "小组合作", "同桌交流", "展示", "活动", "操作", "摆一摆", "画一画"];
const summaryKeywords = ["总结", "本节课", "我们学到", "回顾", "归纳", "小结", "收束"];
const managementKeywords = ["安静", "注意听讲", "不要说话", "看黑板", "先停一下", "规则", "坐好", "回到任务"];
const feedbackKeywords = [
  "很好",
  "不错",
  "你的思路",
  "再试试",
  "我们一起分析",
  "先肯定",
  "不急",
  "答得",
  "说得",
  "这个想法"
];
const abstractKeywords = ["本质", "抽象", "性质", "概念", "逻辑", "结构", "内涵", "外延"];
const exampleKeywords = ["例如", "比如", "举个例子", "生活中", "一步一步", "先", "再"];
const greetingPattern = /^(?:老师)?(?:同学们|大家|同学)?[，,、\s]*(?:你们)?(?:好|早上好|上午好|下午好|晚上好)[！!。.]?$/;
const transitionPattern = /^(?:好[,，]?|那么[,，]?|接下来|下面|现在我们|首先|然后|接着|进入).*(?:环节|部分|内容|一起|来看|继续|学习|讲解|讨论)?[。！!]?$/;
const ambiguousPattern = /^(?:嗯|啊|哦|额|呃|这个|那个|这样|好吧|行|好的|……|\.\.\.)[，,、\s！!。.]?$/;
const casualPattern = /喜欢什么|喜欢吗|天气|吃什么|好吃|周末|游戏|电影|动画|爱好|叫什么名字|几岁/;

export function analyzeTeacherAction(
  teacherText: string,
  state?: ClassroomState
): TeacherActionAnalysis {
  const text = teacherText.trim();
  const actionType = inferActionType(text, state);
  const stage = inferStage(actionType, text, state);
  const difficultyLevel = inferDifficulty(text);
  const clarity = inferClarity(text, difficultyLevel);
  const questionKind = inferQuestionKind(actionType, text);
  const isSocialMove =
    actionType === "greeting" ||
    actionType === "casual" ||
    actionType === "ambiguous" ||
    actionType === "transition";
  const topicKeywords = isSocialMove ? [] : extractTopicKeywords(text, state);
  const specificity = isSocialMove ? 100 : inferSpecificity(text, topicKeywords, questionKind);
  const expectedAnswerFrame = buildExpectedAnswerFrame({
    questionKind,
    topicKeywords,
    topic: state?.topic,
    subject: state?.subject
  });
  const expectedPoints = buildExpectedPoints(questionKind, topicKeywords, state);
  const commonMisconceptions = buildCommonMisconceptions(
    questionKind,
    topicKeywords,
    state
  );

  return {
    stage,
    actionType,
    difficultyLevel,
    clarity,
    questionKind,
    specificity,
    contentFocus:
      actionType === "greeting"
        ? "课堂问候"
        : actionType === "casual"
          ? "课堂闲聊"
          : actionType === "ambiguous"
            ? "表达澄清"
        : actionType === "transition"
          ? "课堂衔接"
          : topicKeywords.join("、") || state?.topic || "当前问题",
    topicKeywords,
    expectedAnswerFrame,
    expectedPoints,
    commonMisconceptions,
    interactionIntent:
      actionType === "greeting" ||
      actionType === "casual" ||
      actionType === "ambiguous" ||
      actionType === "question" ||
      actionType === "follow_up" ||
      actionType === "instruction" ||
      text.includes("请") ||
      text.includes("大家")
  };
}

function inferActionType(text: string, state?: ClassroomState): TeacherActionType {
  if (isGreeting(text)) {
    return "greeting";
  }

  if (ambiguousPattern.test(text)) {
    return "ambiguous";
  }

  if (casualPattern.test(text)) {
    return "casual";
  }

  if (containsAny(text, managementKeywords)) {
    return "management";
  }

  if (containsAny(text, summaryKeywords)) {
    return "summary";
  }

  if (containsAny(text, activityKeywords)) {
    return "instruction";
  }

  if (
    containsAny(text, followUpKeywords) ||
    ((state?.turnCount || 0) > 0 &&
      (text.includes("？") || text.includes("?")) &&
      /刚才|上一个|继续|如果|那么|所以|这个回答|这种想法/.test(text))
  ) {
    return "follow_up";
  }

  if (containsAny(text, questionKeywords) || text.includes("？") || text.includes("?")) {
    return "question";
  }

  if (transitionPattern.test(text)) {
    return "transition";
  }

  if (containsAny(text, feedbackKeywords)) {
    return "feedback";
  }

  if (isLikelyCasualStatement(text)) {
    return "casual";
  }

  return "explanation";
}

function inferStage(
  actionType: TeacherActionType,
  text: string,
  state?: ClassroomState
): ClassroomStage {
  if (actionType === "greeting") {
    return "导入";
  }

  if (actionType === "casual" || actionType === "ambiguous") {
    return state?.currentStage === "未知" ? "导入" : state?.currentStage || "导入";
  }

  if (actionType === "transition") {
    return state?.currentStage === "未知" ? "讲解" : state?.currentStage || "讲解";
  }

  if (text.includes("导入") || text.includes("上课") || text.includes("今天我们")) {
    return "导入";
  }

  if (actionType === "question" || actionType === "follow_up") {
    return "提问";
  }

  if (actionType === "instruction") {
    return "活动组织";
  }

  if (actionType === "summary") {
    return "总结";
  }

  if (actionType === "management") {
    return state?.currentStage || "未知";
  }

  return "讲解";
}

function inferDifficulty(text: string): DifficultyLevel {
  const abstractCount = abstractKeywords.filter((keyword) => text.includes(keyword)).length;
  const lengthScore = text.length > 120 ? 2 : text.length > 70 ? 1 : 0;
  const hasSupport = containsAny(text, exampleKeywords);
  const score = abstractCount + lengthScore - (hasSupport ? 1 : 0);

  if (score >= 3) {
    return "hard";
  }

  if (score >= 1) {
    return "medium";
  }

  return "easy";
}

function inferClarity(text: string, difficultyLevel: DifficultyLevel) {
  let clarity = difficultyLevel === "hard" ? 52 : difficultyLevel === "medium" ? 68 : 82;

  if (containsAny(text, exampleKeywords)) {
    clarity += 10;
  }

  if (text.includes("首先") || text.includes("其次") || text.includes("最后")) {
    clarity += 6;
  }

  if (text.length > 160) {
    clarity -= 12;
  }

  return clamp(clarity);
}

function inferQuestionKind(actionType: TeacherActionType, text: string): QuestionKind {
  if (actionType === "greeting") {
    return "greeting";
  }

  if (actionType === "casual") {
    return "casual";
  }

  if (actionType === "ambiguous") {
    return "ambiguous";
  }

  if (actionType === "management") {
    return "management";
  }

  if (actionType === "instruction") {
    return "activity";
  }

  if (actionType === "summary") {
    return "summary";
  }

  if (/为什么|原因|意义|作用|怎么会|为何/.test(text)) {
    return "reason";
  }

  if (/举例|例子|比如|例如|生活中/.test(text)) {
    return "example";
  }

  if (/区别|相同|不同|比较|联系|关系/.test(text)) {
    return "comparison";
  }

  if (/步骤|方法|怎么算|怎么做|先.*再|流程|过程/.test(text)) {
    return "procedure";
  }

  if (/怎么看|价值|责任|应该|能不能|是否|认同|选择/.test(text)) {
    return "value";
  }

  return "concept";
}

function extractTopicKeywords(text: string, state?: ClassroomState) {
  const source = `${state?.topic || ""} ${text} ${text.replace(/\s+/g, "")}`;
  const knownKeywords = [
    ...(state?.topicKeywords || []),
    state?.topic || "",
    "分数的意义",
    "分数",
    "单位1",
    "单位 1",
    "整体",
    "部分",
    "平均分",
    "若干份",
    "取几份",
    "分子",
    "分母",
    "四分之一",
    "几分之几",
    "非平均分",
    "责任",
    "集体",
    "班干部",
    "承担",
    "诚信",
    "函数",
    "图像",
    "古诗",
    "意象",
    "生态",
    "系统",
    "规则",
    "小组",
    "合作",
    "方法",
    "条件",
    "概念",
    "原因",
    "意义",
    "例子"
  ];
  const found = knownKeywords
    .map((keyword) => normalizeKeyword(keyword))
    .filter(Boolean)
    .filter((keyword) => source.includes(keyword));
  const chunks = source
    .replace(/[，。！？；：、,.!?;:\s]/g, " ")
    .split(" ")
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 8)
    .filter((item) => !/同学|老师|大家|请你|我们|为什么|能不能|想一想|有没有|说明理由/.test(item));

  return [...new Set([...found, ...chunks])].slice(0, 8);
}

function inferSpecificity(text: string, topicKeywords: string[], questionKind: QuestionKind) {
  let score = 35;

  score += Math.min(30, topicKeywords.length * 8);

  if (/为什么|怎么|举例|区别|步骤|说说|请你/.test(text)) {
    score += 18;
  }

  if (questionKind === "concept" && topicKeywords.length <= 1) {
    score -= 12;
  }

  if (/这个|那个|它|这样/.test(text) && topicKeywords.length === 0) {
    score -= 16;
  }

  if (text.length > 90) {
    score += 8;
  }

  return clamp(score);
}

function buildExpectedAnswerFrame({
  questionKind,
  topicKeywords,
  topic,
  subject
}: {
  questionKind: QuestionKind;
  topicKeywords: string[];
  topic?: string;
  subject?: string;
}) {
  const focus = topicKeywords.slice(0, 3).join("、") || topic || "这个知识点";

  if (questionKind === "greeting") {
    return "以简短、自然的课堂问候回应教师，不进入知识问答。";
  }

  if (questionKind === "casual") {
    return "先自然回应教师的闲聊，再以轻松、礼貌的方式拉回当前课堂任务。";
  }

  if (questionKind === "ambiguous") {
    return "礼貌澄清教师的表达，并询问下一步课堂任务。";
  }

  if (questionKind === "reason") {
    return `围绕“${focus}”说明原因，先指出关键关系，再结合${subject || "本课"}情境解释为什么成立。`;
  }

  if (questionKind === "example") {
    return `围绕“${focus}”举出具体例子，并说明例子如何对应概念。`;
  }

  if (questionKind === "comparison") {
    return `比较“${focus}”中的相同点和不同点，明确概念边界。`;
  }

  if (questionKind === "procedure") {
    return `按步骤说明“${focus}”的处理方法，先判断条件，再说明操作顺序。`;
  }

  if (questionKind === "value") {
    return `表达对“${focus}”的判断，并给出理由和情境依据。`;
  }

  if (questionKind === "activity") {
    return `明确活动目标、分工、时间和产出要求。`;
  }

  if (questionKind === "management") {
    return `回到课堂规则，确认注意力和任务边界。`;
  }

  if (questionKind === "summary") {
    return `归纳“${focus}”的核心结论和使用条件。`;
  }

  return `解释“${focus}”是什么，并说明它和本课主题的关系。`;
}

function buildExpectedPoints(
  questionKind: QuestionKind,
  topicKeywords: string[],
  state?: ClassroomState
) {
  const focus = topicKeywords.slice(0, 3);

  if (questionKind === "greeting" || questionKind === "casual" || questionKind === "ambiguous") {
    return [];
  }

  if (topicKeywords.some((keyword) => /分数|单位 ?1|整体|部分|平均分|四分之一|几分之几/.test(keyword))) {
    return [
      "先确定单位1或整体",
      "必须平均分",
      "说明平均分成若干份",
      "说明取了其中几份",
      "用几分之几表示整体的一部分"
    ];
  }

  if (topicKeywords.some((keyword) => /责任|集体|班干部|承担/.test(keyword))) {
    return ["班级是共同体", "班干部负责组织提醒", "每个成员都要承担角色", "共同承担才能让集体运转"];
  }

  if (topicKeywords.some((keyword) => /函数|图像/.test(keyword))) {
    return ["看清横轴和纵轴", "描述变量关系", "关注变化趋势", "结合特殊点判断"];
  }

  if (questionKind === "reason") {
    return [
      `指出${focus[0] || state?.topic || "问题"}的关键关系`,
      "说明原因链条",
      "结合课堂情境解释为什么成立"
    ];
  }

  if (questionKind === "example") {
    return [
      `围绕${focus[0] || state?.topic || "知识点"}举例`,
      "说明例子和概念的对应关系",
      "回到本课结论"
    ];
  }

  if (questionKind === "comparison") {
    return ["先说相同点", "再说不同点", "明确概念边界"];
  }

  if (questionKind === "procedure") {
    return ["先判断条件", "再说明步骤", "最后检查结果或结论"];
  }

  if (questionKind === "value") {
    return ["表达判断", "说明理由", "结合具体情境或集体影响"];
  }

  return [
    `解释${focus[0] || state?.topic || "当前知识点"}是什么`,
    "说明它和本课主题的关系"
  ];
}

function buildCommonMisconceptions(
  questionKind: QuestionKind,
  topicKeywords: string[],
  state?: ClassroomState
) {
  const configuredMisconceptions = state?.commonMisconceptions || [];

  if (questionKind === "greeting" || questionKind === "casual" || questionKind === "ambiguous") {
    return [];
  }

  if (topicKeywords.some((keyword) => /分数|单位 ?1|整体|部分|平均分|四分之一|几分之几/.test(keyword))) {
    return [...new Set([
      ...configuredMisconceptions,
      "没有先确定单位1",
      "把随便分当成平均分",
      "把分子和分母含义说反",
      "把一份和几份混淆",
      "忽略不同整体不能直接比较"
    ])].slice(0, 8);
  }

  if (topicKeywords.some((keyword) => /责任|集体|班干部|承担/.test(keyword))) {
    return ["认为班干部应该承担大部分责任", "把配合理解成不用承担", "只从个人方便判断"];
  }

  if (topicKeywords.some((keyword) => /函数|图像/.test(keyword))) {
    return ["只看图像形状不看坐标含义", "把局部上升理解成全程上升", "忽略特殊点"];
  }

  if (questionKind === "reason") {
    return ["把现象当原因", "只抓住一个关键词就下结论"];
  }

  if (questionKind === "comparison") {
    return ["只看表面相似就认为完全相同", "忽略适用条件"];
  }

  if (questionKind === "procedure") {
    return ["不看条件直接套步骤", "跳过检查过程"];
  }

  if (questionKind === "value") {
    return ["只从个人感受判断", "忽略具体情境"];
  }

  return ["只理解字面意思", "没有说明概念边界"];
}

function containsAny(text: string, keywords: string[]) {
  return keywords.some((keyword) => text.includes(keyword));
}

function isGreeting(text: string) {
  return greetingPattern.test(text) && !/[？?]|为什么|怎么|请问|能不能/.test(text);
}

function isLikelyCasualStatement(text: string) {
  return (
    text.length <= 40 &&
    /我|你|大家|同学/.test(text) &&
    /今天|累|开心|难过|心情|休息|周末|吃|喝|天气|电影|游戏|爱好/.test(text)
  );
}

function normalizeKeyword(keyword: string) {
  return keyword.replace(/\s+/g, "").trim();
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
