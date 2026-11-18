import { PlatformError, type ToolKind, type ToolWrite } from "../types.js";

const TOOL_KINDS: ToolKind[] = ["builtin", "mcp", "http"];

function jsonSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

export const BUILTIN_TOOLS: ToolWrite[] = [
  {
    id: "knowledge.search",
    name: "知识库检索",
    type: "builtin",
    endpoint: "builtin://knowledge/search",
    description: "按任务在指定知识库中召回片段，返回引用来源与相似度，供检索增强与证据引用使用。",
    schema: jsonSchema(
      {
        query: { type: "string", description: "检索问题或任务" },
        knowledgeBaseIds: { type: "array", items: { type: "string" }, description: "参与检索的知识库 id" },
        topK: { type: "number", minimum: 1, maximum: 20, default: 5 }
      },
      ["query"]
    ),
    enabled: true
  },
  {
    id: "report.build",
    name: "训练报告生成",
    type: "builtin",
    endpoint: "builtin://report/build",
    description: "汇总观察员结论、验证分数与循环轮次，生成课堂训练报告的数据结构与摘要。",
    schema: jsonSchema(
      {
        observer: { type: "object", description: "观察员输出" },
        score: { type: "number", minimum: 0, maximum: 1 },
        iterations: { type: "number", minimum: 0 }
      },
      ["observer", "score"]
    ),
    enabled: true
  },
  {
    id: "verify.rubric",
    name: "Rubric 评分",
    type: "builtin",
    endpoint: "builtin://verify/rubric",
    description: "按评分维度对输出打分，返回总分、维度分、置信度、问题清单与证据。",
    schema: jsonSchema(
      {
        output: { type: "object", description: "待评分输出" },
        rubric: { type: "array", items: { type: "string" } },
        threshold: { type: "number", minimum: 0, maximum: 1, default: 0.8 }
      },
      ["output", "rubric"]
    ),
    enabled: true
  },
  {
    id: "classroom.simulate",
    name: "课堂互动模拟",
    type: "builtin",
    endpoint: "builtin://classroom/simulate",
    description: "用一个教师发言驱动全部学生 Agent 生成反应，并返回事件与课堂指标变化。",
    schema: jsonSchema(
      {
        teacherText: { type: "string" },
        studentIds: { type: "array", items: { type: "string" } },
        turn: { type: "number", minimum: 1 }
      },
      ["teacherText"]
    ),
    enabled: true
  },
  {
    id: "classroom.create",
    name: "虚拟课堂创建",
    type: "builtin",
    endpoint: "builtin://classroom/create",
    description: "按学科、学段、课题与训练目标生成虚拟班级画像，返回会话 id 与课堂状态。",
    schema: jsonSchema(
      {
        subject: { type: "string" },
        grade: { type: "string" },
        topic: { type: "string" },
        classType: { type: "string" },
        trainingGoal: { type: "string" },
        difficulty: { type: "string" },
        specialTrainingMode: { type: "string" },
        knowledgeBaseIds: { type: "array", items: { type: "string" } }
      },
      ["subject", "grade", "topic"]
    ),
    enabled: true
  },
  {
    id: "classroom.turn",
    name: "虚拟课堂互动",
    type: "builtin",
    endpoint: "builtin://classroom/turn",
    description: "提交一次教师发言，驱动全部学生 Agent 生成反应并更新课堂事件与指标。",
    schema: jsonSchema(
      {
        sessionId: { type: "string" },
        teacherText: { type: "string" }
      },
      ["sessionId", "teacherText"]
    ),
    enabled: true
  },
  {
    id: "classroom.feedback",
    name: "课堂观察员点评",
    type: "builtin",
    endpoint: "builtin://classroom/feedback",
    description: "基于本轮学生反应与课堂指标，生成观察员点评、风险提示与下一步教学建议。",
    schema: jsonSchema({ sessionId: { type: "string" } }, ["sessionId"]),
    enabled: true
  },
  {
    id: "classroom.report",
    name: "虚拟课堂诊断报告",
    type: "builtin",
    endpoint: "builtin://classroom/report",
    description: "汇总课堂证据链、观察员结论与评分，生成诊断报告、引用与可下载成果。",
    schema: jsonSchema({ sessionId: { type: "string" } }, ["sessionId"]),
    enabled: true
  },
  {
    id: "counseling.create",
    name: "谈心谈话个案创建",
    type: "builtin",
    endpoint: "builtin://counseling/create",
    description: "按虚拟个案与情绪状态创建谈心谈话会话，返回学生、状态与事件时间线。",
    schema: jsonSchema({
      config: {
        type: "object",
        description: "个案配置。最少只给 caseId 即可，其余字段自动按个案预设补齐；也可给一段中文描述自动匹配个案。",
        properties: {
          caseId: {
            type: "string",
            enum: ["academic", "dormitory", "relationship", "financial", "conflict", "safety"],
            description: "academic 成绩压力、dormitory 宿舍冲突、relationship 关系结束、financial 经济困难、conflict 处分对抗、safety 安全演练"
          },
          mode: {
            type: "string",
            enum: ["guided", "assessment"],
            description: "guided 引导训练 / assessment 评估训练，默认 guided"
          },
          risk: {
            type: "string",
            enum: ["ordinary", "screening", "urgent"],
            description: "风险演练级别，缺省按个案预设"
          },
          emotion: {
            type: "string",
            enum: ["焦虑", "低落", "愤怒", "委屈", "麻木"],
            description: "初始情绪，缺省按个案预设"
          },
          intensity: { type: "number", minimum: 1, maximum: 5, description: "情绪强度 1 至 5" },
          trust: { type: "number", minimum: 0, maximum: 100, description: "初始信任 0 至 100" },
          openness: { type: "number", minimum: 0, maximum: 100, description: "初始开放度 0 至 100" },
          note: { type: "string", description: "中文情况描述，caseId 缺省时按关键词匹配个案" }
        }
      }
    }, ["config"]),
    enabled: true
  },
  {
    id: "counseling.turn",
    name: "谈心谈话发言",
    type: "builtin",
    endpoint: "builtin://counseling/turn",
    description: "提交一次辅导员发言，生成学生回应并更新信任、开放与紧张状态。",
    schema: jsonSchema(
      {
        sessionId: { type: "string" },
        text: { type: "string" },
        turnId: { type: "string" }
      },
      ["sessionId", "text"]
    ),
    enabled: true
  },
  {
    id: "counseling.feedback",
    name: "督导即时提示",
    type: "builtin",
    endpoint: "builtin://counseling/feedback",
    description: "基于本轮关系状态与事件，给出督导视角的下一步表达建议与风险提醒。",
    schema: jsonSchema({ sessionId: { type: "string" } }, ["sessionId"]),
    enabled: true
  },
  {
    id: "counseling.finish",
    name: "谈心谈话复盘",
    type: "builtin",
    endpoint: "builtin://counseling/finish",
    description: "结束谈话并生成复盘报告，保存到历史记录与成长档案。",
    schema: jsonSchema({ sessionId: { type: "string" } }, ["sessionId"]),
    enabled: true
  },
  {
    id: "export.docx",
    name: "Word 导出",
    type: "builtin",
    endpoint: "builtin://export/docx",
    description: "把产物导出为 docx 文件，返回下载地址与文件大小。",
    schema: jsonSchema(
      {
        title: { type: "string" },
        sections: { type: "array", items: { type: "object" } },
        fileName: { type: "string" }
      },
      ["title", "sections"]
    ),
    enabled: true
  },
  {
    id: "web.search",
    name: "网页检索（MCP）",
    type: "mcp",
    endpoint: "mcp://builtin/web-search",
    description: "通过 MCP 客户端调用网页检索，用于补充教材之外的公开资料；当前为预留连接。",
    schema: jsonSchema(
      {
        query: { type: "string" },
        topK: { type: "number", minimum: 1, maximum: 10, default: 3 }
      },
      ["query"]
    ),
    enabled: true
  },
  {
    id: "mcp.teaching-resources.teaching_resource_search",
    name: "教学资源 MCP · 资源检索",
    type: "mcp",
    endpoint: "mcp://teaching-resources/teaching_resource_search",
    description: "通过真实 MCP 服务器检索教案片段、课堂提问链与实验设计资源；首次调用会自动启动本地示例服务器。",
    schema: jsonSchema(
      {
        query: { type: "string", description: "课题或关键词" },
        subject: { type: "string", description: "学科，可选" },
        limit: { type: "number", minimum: 1, maximum: 5, default: 3 }
      },
      ["query"]
    ),
    enabled: true
  },
  {
    id: "mcp.teaching-resources.lesson_timing_check",
    name: "教学资源 MCP · 课时校验",
    type: "mcp",
    endpoint: "mcp://teaching-resources/lesson_timing_check",
    description: "校验教学环节时长与总课时是否匹配，并返回可执行的压缩/补充建议。",
    schema: jsonSchema(
      {
        durationMinutes: { type: "number", minimum: 10, maximum: 120 },
        phases: { type: "array", items: { type: "object" } }
      },
      ["durationMinutes", "phases"]
    ),
    enabled: true
  },
  {
    id: "mcp.teaching-resources.classroom_feedback",
    name: "教学资源 MCP · 课堂反馈",
    type: "mcp",
    endpoint: "mcp://teaching-resources/classroom_feedback",
    description: "根据训练得分、优势与问题清单生成结构化课堂改进反馈。",
    schema: jsonSchema(
      {
        score: { type: "number", minimum: 0, maximum: 1 },
        strengths: { type: "array", items: { type: "string" } },
        issues: { type: "array", items: { type: "string" } }
      },
      ["score"]
    ),
    enabled: true
  },
  {
    id: "mcp.data-analysis.profile",
    name: "经营数据 MCP · 销售概况",
    type: "mcp",
    endpoint: "mcp://data-analysis/profile",
    description: "读取固定销售明细，返回订单数、销量、毛销售额、退款、净销售额、销货成本、毛利额与毛利率等确定性指标。",
    schema: jsonSchema({
      source: { type: "string", description: "data/demo 下的 CSV 相对路径，默认 data/demo/sales.csv" }
    }),
    enabled: true
  },
  {
    id: "mcp.data-analysis.metric_calc",
    name: "经营数据 MCP · 毛利核算",
    type: "mcp",
    endpoint: "mcp://data-analysis/metric_calc",
    description: "按指定销售额口径计算毛利额与毛利率；gross 不扣退款，net 扣除退款，用于演示口径错误被验证拦截。",
    schema: jsonSchema(
      {
        source: { type: "string", description: "data/demo 下的 CSV 相对路径" },
        revenueBasis: {
          type: "string",
          enum: ["gross", "net"],
          description: "销售额口径：gross 为毛销售额，net 为扣除退款后的净销售额"
        }
      },
      ["revenueBasis"]
    ),
    enabled: true
  },
  {
    id: "mcp.data-analysis.groupby",
    name: "经营数据 MCP · 分组汇总",
    type: "mcp",
    endpoint: "mcp://data-analysis/groupby",
    description: "按区域、品类、渠道或月份汇总净销售额、毛利额、退款与销量。",
    schema: jsonSchema(
      {
        source: { type: "string", description: "data/demo 下的 CSV 相对路径" },
        dimension: { type: "string", enum: ["region", "product", "channel", "month"] }
      },
      ["dimension"]
    ),
    enabled: true
  },
  {
    id: "mcp.data-analysis.trend",
    name: "经营数据 MCP · 销售趋势",
    type: "mcp",
    endpoint: "mcp://data-analysis/trend",
    description: "按月份或日期输出净销售额与毛利额趋势。",
    schema: jsonSchema({
      source: { type: "string", description: "data/demo 下的 CSV 相对路径" },
      granularity: { type: "string", enum: ["month", "day"], default: "month" }
    }),
    enabled: true
  },
  {
    id: "mcp.data-analysis.chart",
    name: "经营数据 MCP · 文本图表",
    type: "mcp",
    endpoint: "mcp://data-analysis/chart",
    description: "把分组结果渲染为终端文本柱状图或折线示意，便于在纯文本 trace 中比较。",
    schema: jsonSchema(
      {
        source: { type: "string", description: "data/demo 下的 CSV 相对路径" },
        dimension: { type: "string", enum: ["region", "product", "channel", "month"] },
        chartType: { type: "string", enum: ["bar", "line"], default: "bar" }
      },
      ["dimension"]
    ),
    enabled: true
  },
  {
    id: "exam.psychometrics",
    name: "试卷质量测量",
    type: "builtin",
    endpoint: "builtin://exam/psychometrics",
    description:
      "按教育测量学口径计算每题难度 P（全体平均得分/满分）与区分度 D（高分组得分率与低分组得分率之差），汇总整卷难度、平均区分度、难度分布与认知层级覆盖，并按阈值列出必须返工的题号。",
    schema: jsonSchema(
      {
        items: {
          type: "array",
          description: "每题测量数据；高分组与低分组通常各取总分前 27% 与后 27%",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "题号" },
              fullScore: { type: "number", description: "该题满分" },
              highGroupAvg: { type: "number", description: "高分组平均得分" },
              lowGroupAvg: { type: "number", description: "低分组平均得分" },
              overallAvg: { type: "number", description: "全体平均得分，缺省取高低分组均值" },
              level: { type: "string", description: "认知层级，如识记/理解/应用/迁移" }
            },
            required: ["id", "fullScore", "highGroupAvg", "lowGroupAvg"]
          }
        },
        difficultyRange: {
          type: "array",
          items: { type: "number" },
          description: "可接受的整卷难度区间，默认 0.55 到 0.75"
        },
        discriminationMin: { type: "number", description: "区分度下限，默认 0.3" }
      },
      ["items"]
    ),
    enabled: true
  },
  {
    id: "classroom.evidence",
    name: "课堂实录证据统计",
    type: "builtin",
    endpoint: "builtin://classroom/evidence",
    description:
      "从结构化的课堂发言记录计算话语轮次、师生话语占比、提问次数、平均发言长度、最长发言时长与超过 3 秒的冷场段，并给出可引用的发言摘录。数字由代码统计，供观察员引用与证据核验使用。",
    schema: jsonSchema(
      {
        utterances: {
          type: "array",
          description: "按时间顺序排列的发言；speaker 为 teacher/教师/老师或学生标识",
          items: {
            type: "object",
            properties: {
              speaker: { type: "string" },
              text: { type: "string" },
              startSec: { type: "number" },
              endSec: { type: "number" }
            },
            required: ["speaker", "text"]
          }
        }
      },
      ["utterances"]
    ),
    enabled: true
  },
  {
    id: "rubric.check",
    name: "量表一致性与红线判定",
    type: "builtin",
    endpoint: "builtin://rubric/check",
    description:
      "按各观察员在每维的打分计算共识分、极差与标准差，点名分歧超过阈值的维度；任一红线命中即一票否决。只做确定性判定，不生成改进建议。",
    schema: jsonSchema(
      {
        dimensions: {
          type: "array",
          description: "每个维度及其各观察员分数（统一按 0-100 计）",
          items: {
            type: "object",
            properties: {
              dimension: { type: "string" },
              scores: { type: "array", items: { type: "number" } }
            },
            required: ["dimension", "scores"]
          }
        },
        redlines: {
          type: "array",
          description: "一票否决项，如科学性错误、师德问题",
          items: {
            type: "object",
            properties: {
              code: { type: "string" },
              hit: { type: "boolean" },
              evidence: { type: "string" }
            },
            required: ["code", "hit"]
          }
        },
        maxSpread: { type: "number", description: "同一维度允许的最大极差，默认 25" },
        passScore: { type: "number", description: "共识分达标线，默认 70" }
      },
      ["dimensions"]
    ),
    enabled: true
  },
  {
    id: "td.student-profile",
    name: "班级档案查询",
    type: "builtin",
    endpoint: "builtin://teacher/student-profile",
    description:
      "按分数线或标记从结构化班级档案中筛选学生，给出平均分与命中原因。分数由代码计算，供备课分层、课后跟进与关注名单使用；不涉及真实隐私数据。",
    schema: jsonSchema(
      {
        students: {
          type: "array",
          description: "学生档案数组，含 id、name、scores、tags 等字段",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              level: { type: "string" },
              scores: { type: "array", items: { type: "number" } },
              tags: { type: "array", items: { type: "string" } },
              missedAssignments: { type: "number" },
              mutedTurns: { type: "number" },
              note: { type: "string" }
            },
            required: ["id", "name"]
          }
        },
        scoreBelow: { type: "number", description: "只看平均分低于该值的学生" },
        tags: { type: "array", items: { type: "string" }, description: "只看带这些标记的学生，命中任一即可" },
        order: { type: "string", enum: ["asc", "desc"], description: "按平均分排序" },
        limit: { type: "number", description: "最多返回人数" }
      },
      ["students"]
    ),
    enabled: true
  },
  {
    id: "td.risk-classify",
    name: "学生安全风险分级",
    type: "builtin",
    endpoint: "builtin://teacher/risk-classify",
    description:
      "按硬规则关键词与学生既往记录判定风险为红线、橙线、黄线或无风险，输出允许动作、禁止动作与上报模板。红线为一票否决，模型不得改写等级或自行生成处置意见。",
    schema: jsonSchema(
      {
        text: { type: "string", description: "事件原话或事实描述" },
        history: {
          type: "array",
          description: "既往事件记录，用于判断是否重复出现",
          items: {
            type: "object",
            properties: {
              date: { type: "string" },
              level: { type: "string" },
              note: { type: "string" }
            }
          }
        }
      },
      ["text"]
    ),
    enabled: true
  },
  {
    id: "lms.publish",
    name: "学习平台发布（HTTP）",
    type: "http",
    endpoint: "https://lms.example.edu/api/v1/publish",
    description: "把教案发布到第三方学习管理平台的 HTTP 接口示例，未接入前保持停用。",
    schema: jsonSchema(
      {
        courseId: { type: "string" },
        lessonPlan: { type: "object" }
      },
      ["courseId", "lessonPlan"]
    ),
    enabled: false
  },
  {
    id: "game.play",
    name: "学科小游戏",
    type: "builtin",
    endpoint: "builtin://game/play",
    description:
      "开一局学科小游戏：数学速算、24 点、数独；语文诗句拼句、飞花令；英语单词拼写。" +
      "学生说想练一练、想挑战一下、想玩个游戏、想拼诗句、想背单词时调用。" +
      "题目会以可玩卡片的形式发到界面，调用后不要复述题目、不要报答案。",
    schema: jsonSchema(
      {
        game: {
          type: "string",
          enum: [
            "math_sprint",
            "twenty_four",
            "sudoku",
            "flying_flower",
            "poetry_order",
            "word_spell"
          ],
          description:
            "math_sprint=数学速算，twenty_four=24 点，sudoku=数独，flying_flower=飞花令（学生自己接诗句），" +
            "poetry_order=诗句拼句（字块打乱排成一句，比飞花令简单，小学低年级优先用这个），" +
            "word_spell=单词拼写（给中文意思拼英文单词）"
        },
        grade: {
          type: "number",
          minimum: 1,
          maximum: 9,
          description: "年级 1-9（初一记 7）。学生没提就按六年级算"
        },
        topic: { type: "string", description: "知识点，如「分数」「小数」「一元一次方程」" },
        difficulty: {
          type: "string",
          enum: ["easy", "normal", "hard"],
          description:
            "难度，缺省 normal（诗句拼句与单词拼写缺省按 easy 出）。小学低年级用 easy，初高中用 normal 或 hard"
        },
        count: {
          type: "number",
          minimum: 1,
          maximum: 12,
          description:
            "题量或轮数：速算 4-12 题、24 点 1-6 组、飞花令 3-8 轮、诗句拼句 3-8 句、单词拼写 3-8 个，缺省按各玩法给默认值"
        },
        char: { type: "string", description: "飞花令的令字，只能是春、月、花、风、雪、山、水、云、雨、江、酒、柳之一" }
      },
      ["game"]
    ),
    enabled: true
  }
];

const idPattern = /^[a-z0-9][a-z0-9._-]*$/i;

export function parseToolWrite(body: unknown, existing?: ToolWrite): ToolWrite {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new PlatformError("请求体必须是 JSON 对象。", 400);
  }
  const record = body as Record<string, unknown>;
  const id = requireText(record.id, "id");
  if (!idPattern.test(id)) {
    throw new PlatformError("id 只允许字母、数字、下划线和短横线，且以字母或数字开头。", 400);
  }
  const type = record.type;
  if (typeof type !== "string" || !TOOL_KINDS.includes(type as ToolKind)) {
    throw new PlatformError("type 必须是 builtin、mcp 或 http。", 400);
  }
  if (record.schema !== undefined && (typeof record.schema !== "object" || record.schema === null || Array.isArray(record.schema))) {
    throw new PlatformError("schema 必须是 JSON 对象。", 400);
  }

  return {
    id,
    name: requireText(record.name, "name"),
    type: type as ToolKind,
    schema:
      record.schema === undefined
        ? (existing?.schema ?? {})
        : (record.schema as Record<string, unknown>),
    endpoint:
      record.endpoint === undefined
        ? existing?.endpoint
        : optionalText(record.endpoint, "endpoint") || undefined,
    description:
      record.description === undefined
        ? (existing?.description ?? "")
        : optionalText(record.description, "description"),
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : (existing?.enabled ?? true)
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PlatformError(`缺少必填字段：${field}。`, 400);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value !== "string") {
    throw new PlatformError(`${field} 必须是字符串。`, 400);
  }
  return value.trim();
}
