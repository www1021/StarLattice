/**
 * 师者工作台的确定性工具：班级档案查询与安全风险分级。
 *
 * 这里刻意不调用模型。档案查询做的是表驱动筛选与排序，
 * 风险分级做的是关键词命中的硬规则判定 —— 安全红线不能交给模型自由发挥，
 * 也不能让「先观察看看」这类措辞把红线降级。
 */

export type StudentProfileInput = {
  id: string;
  name: string;
  level?: string;
  scores?: number[];
  tags: string[];
  missedAssignments?: number;
  mutedTurns?: number;
  note?: string;
};

export type ProfileQuery = {
  students: StudentProfileInput[];
  /** 只看低于该分数的学生。 */
  scoreBelow?: number;
  /** 只看带这些标签的学生，命中任一即入。 */
  tags?: string[];
  /** 按平均分升序或降序，默认不排序。 */
  order?: "asc" | "desc";
  limit?: number;
};

export type StudentProfileResult = {
  total: number;
  matched: number;
  filter: { scoreBelow?: number; tags: string[] };
  students: Array<{
    id: string;
    name: string;
    average: number | null;
    tags: string[];
    reasons: string[];
  }>;
  summary: string;
};

function averageOf(values: number[] | undefined): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return null;
  return Number((valid.reduce((sum, value) => sum + value, 0) / valid.length).toFixed(2));
}

function normalizeStudents(raw: unknown): StudentProfileInput[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const item = (entry ?? {}) as Record<string, unknown>;
      return {
        id: String(item.id ?? "").trim(),
        name: String(item.name ?? "").trim(),
        level: typeof item.level === "string" ? item.level.trim() : undefined,
        scores: Array.isArray(item.scores) ? (item.scores as unknown[]).map(Number).filter(Number.isFinite) : [],
        tags: Array.isArray(item.tags) ? (item.tags as unknown[]).map((tag) => String(tag).trim()).filter(Boolean) : [],
        missedAssignments: Number.isFinite(Number(item.missedAssignments)) ? Number(item.missedAssignments) : 0,
        mutedTurns: Number.isFinite(Number(item.mutedTurns)) ? Number(item.mutedTurns) : 0,
        note: typeof item.note === "string" ? item.note.trim() : undefined
      };
    })
    .filter((item) => item.id && item.name);
}

export function queryStudentProfiles(query: ProfileQuery): StudentProfileResult {
  const students = normalizeStudents(query.students);
  const tags = Array.isArray(query.tags) ? query.tags.map((tag) => String(tag).trim()).filter(Boolean) : [];
  const below =
    typeof query.scoreBelow === "number" && Number.isFinite(query.scoreBelow)
      ? query.scoreBelow
      : undefined;

  const matches = students
    .map((student) => {
      const average = averageOf(student.scores);
      const reasons: string[] = [];
      if (below !== undefined && average !== null && average < below) {
        reasons.push(`平均分 ${average} 低于 ${below}`);
      }
      const hitTags = tags.filter((tag) => student.tags.includes(tag));
      if (hitTags.length > 0) {
        reasons.push(`带有标记 ${hitTags.join("、")}`);
      }
      return { student, average, reasons, hitTags };
    })
    .filter((entry) => entry.reasons.length > 0 || (below === undefined && tags.length === 0));

  if (query.order === "asc" || query.order === "desc") {
    const sign = query.order === "asc" ? 1 : -1;
    matches.sort((a, b) => {
      const av = a.average ?? -1;
      const bv = b.average ?? -1;
      return sign * (av - bv);
    });
  }

  const limit = Number.isFinite(query.limit) && query.limit && query.limit > 0 ? query.limit : matches.length;
  const picked = matches.slice(0, limit);

  return {
    total: students.length,
    matched: matches.length,
    filter: { scoreBelow: below, tags },
    students: picked.map((entry) => ({
      id: entry.student.id,
      name: entry.student.name,
      average: entry.average,
      tags: entry.student.tags,
      reasons: entry.reasons
    })),
    summary:
      picked.length === 0
        ? "没有匹配的学生。"
        : `共 ${students.length} 人，命中 ${matches.length} 人，列出 ${picked.length} 人。`
  };
}

export type RiskInput = {
  text: string;
  /** 已有事件记录，用于判断是否重复出现。 */
  history?: Array<{ date?: string; level?: string; note?: string }>;
};

export type RiskResult = {
  level: "红线" | "橙线" | "黄线" | "无风险";
  code: string;
  hits: Array<{ keyword: string; category: string }>;
  /** 命中信号的人话版本，模板里直接打印，免得把 JSON 数组糊到老师面前。 */
  hitText: string;
  repeat: boolean;
  allowedActions: string[];
  forbiddenActions: string[];
  reportTemplate: string[];
  rationale: string;
};

/**
 * 词表匹配分两类：纯关键词和句式。
 * 「被同学打了」「打了他两下」这类原话里，关键词「被打」对不上——中间插了主语，
 * 只靠 includes 会把明显的肢体伤害判成无风险。句式规则补的就是这一层。
 */
type Rule = { keyword?: string; pattern?: RegExp; category: string };

const RED_RULES: Rule[] = [
  { keyword: "自伤", category: "自伤自残" },
  { keyword: "自残", category: "自伤自残" },
  { keyword: "不想活", category: "自伤自残" },
  { keyword: "自杀", category: "自伤自残" },
  { keyword: "欺负", category: "校园欺凌" },
  { keyword: "霸凌", category: "校园欺凌" },
  { keyword: "威胁", category: "人身威胁" },
  { keyword: "打我", category: "人身伤害" },
  { keyword: "被打", category: "人身伤害" },
  { keyword: "家庭暴力", category: "家庭暴力" },
  { keyword: "打我爸妈", category: "家庭暴力" },
  { keyword: "拐走", category: "走失风险" },
  { keyword: "不回家", category: "走失风险" },
  { pattern: /被[^，。；！？\s]{0,6}(打|踹|踢|扇|推倒|揍|掐|咬)/, category: "人身伤害" },
  { pattern: /(打|踹|踢|扇|揍|掐)[了伤](我|他|她|同学|学生|人)/, category: "人身伤害" },
  { pattern: /(打架|打群架|动手打人)/, category: "肢体冲突" },
  { pattern: /(勒索|抢钱|收保护费|要保护费)/, category: "敲诈勒索" },
  { pattern: /(轻生|跳楼|割腕|上吊|喝药)/, category: "自伤自残" },
  { pattern: /(性侵|猥亵|摸我)/, category: "性侵害" },
  { pattern: /(离家出走|走丢|失联)/, category: "走失风险" }
];

const ORANGE_RULES: Rule[] = [
  { keyword: "没人在乎", category: "持续情绪低落" },
  { keyword: "没人管我", category: "持续情绪低落" },
  { keyword: "情绪崩溃", category: "情绪崩溃" },
  { keyword: "哭了一节课", category: "情绪崩溃" },
  { keyword: "不想上学", category: "持续抗拒" },
  { keyword: "三天没交", category: "持续缺交作业" },
  { keyword: "连续三天", category: "持续异常" }
];

const YELLOW_RULES: Rule[] = [
  { keyword: "吵架", category: "单次口角" },
  { keyword: "争执", category: "单次口角" },
  { keyword: "推搡", category: "肢体冲突" },
  { keyword: "没交作业", category: "单次缺交作业" },
  { keyword: "走神", category: "注意力问题" },
  { keyword: "睡不好", category: "身体状态" }
];

const RED_ACTIONS = [
  "立即上报德育处与校安全办",
  "同步家长并记录通知时间",
  "保留原话记录，不做修饰",
  "一小时内形成书面事件记录"
];

const RED_FORBIDDEN = [
  "教师单独处理或承诺保密",
  "用「先观察」「再聊聊」降低等级",
  "由模型自行生成处置意见",
  "等待家长主动联系"
];

const ORANGE_ACTIONS = [
  "24 小时内约谈并记录",
  "通知心理老师介入",
  "一周内跟进两次"
];

const YELLOW_ACTIONS = ["当次沟通并记录", "一周内留意是否复现"];

export function classifyRisk(input: RiskInput): RiskResult {
  const result = gradeRisk(input);
  return {
    ...result,
    hitText: result.hits.map((hit) => `${hit.keyword}（${hit.category}）`).join("；")
  };
}

function gradeRisk(input: RiskInput): Omit<RiskResult, "hitText"> {
  const text = typeof input.text === "string" ? input.text : "";
  const history = Array.isArray(input.history) ? input.history : [];

  const collect = (rules: Rule[]): Array<{ keyword: string; category: string }> =>
    rules.flatMap((rule) => {
      if (rule.pattern) {
        const hit = text.match(rule.pattern);
        return hit ? [{ keyword: hit[0], category: rule.category }] : [];
      }
      const keyword = rule.keyword ?? "";
      return keyword && text.includes(keyword) ? [{ keyword, category: rule.category }] : [];
    });

  const red = collect(RED_RULES);
  const orange = collect(ORANGE_RULES);
  const yellow = collect(YELLOW_RULES);
  const repeat = history.some((item) => {
    const level = typeof item.level === "string" ? item.level : "";
    return level.includes("红") || level.includes("橙");
  });

  if (red.length > 0) {
    return {
      level: "红线",
      code: "safety-red",
      hits: red,
      repeat,
      allowedActions: RED_ACTIONS,
      forbiddenActions: RED_FORBIDDEN,
      reportTemplate: [
        "事件时间：",
        "事件地点：",
        "在场人员：",
        "当事人原话（逐字）：",
        "初判等级：红线",
        "判定依据：红线关键词命中「%s」",
        "已采取措施：",
        "上报对象：德育处、校安全办",
        "家长通知时间：",
        "反馈时限：一小时内"
      ],
      rationale: `命中红线关键词：${red.map((item) => item.keyword).join("、")}。红线为硬判定，模型不得改写等级或处置意见。`
    };
  }

  if (orange.length > 0 || repeat) {
    const hits = orange.length > 0 ? orange : [{ keyword: "历史记录", category: "既往红线或橙线" }];
    return {
      level: "橙线",
      code: "safety-orange",
      hits,
      repeat,
      allowedActions: ORANGE_ACTIONS,
      forbiddenActions: ["仅当次口头提醒后不再跟进", "把既往记录当作已关闭"],
      reportTemplate: ["事件时间：", "事件原话：", "初判等级：橙线", "判定依据：", "约谈时间：", "心理老师对接：", "一周跟进记录："],
      rationale: repeat ? "既往有红线或橙线记录，本次按橙线处理。" : `命中橙线关键词：${hits.map((item) => item.keyword).join("、")}。`
    };
  }

  if (yellow.length > 0) {
    return {
      level: "黄线",
      code: "safety-yellow",
      hits: yellow,
      repeat: false,
      allowedActions: YELLOW_ACTIONS,
      forbiddenActions: ["把单次事件直接上报为红线"],
      reportTemplate: ["事件时间：", "事件原话：", "初判等级：黄线", "当次沟通：", "一周观察："],
      rationale: `命中黄线关键词：${yellow.map((item) => item.keyword).join("、")}。`
    };
  }

  return {
    level: "无风险",
    code: "safety-none",
    hits: [],
    repeat: false,
    allowedActions: ["记入常规观察记录"],
    forbiddenActions: [],
    reportTemplate: [],
    rationale: "未命中任何风险关键词。注意：无关键词不等于无风险，教师仍可基于专业判断升级。"
  };
}
