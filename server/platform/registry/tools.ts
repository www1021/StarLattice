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
