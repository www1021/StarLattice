import type { NodeKind, NodePortType } from "../types.js";
import { getModelCatalog } from "../models/catalog.js";

export const NODE_TYPE_CONTRACT_VERSION = 3;

/**
 * 静态兜底：模型列表本身由 /api/platform/node-types 每次请求时按设置动态注入，
 * 这里只保证字段定义始终有个合法选项，避免空数组导致 select 字段不可用。
 */
const MODEL_OPTIONS = [
  "platform-default",
  ...getModelCatalog()
    .filter((profile) => !profile.hidden)
    .map((profile) => profile.id)
];
const COST_TIER_LABELS: Record<string, string> = {
  low: "低成本",
  medium: "中等成本",
  high: "高成本"
};
/** 下拉里直接带上成本档位，选模型时能看出这次调用贵不贵。 */
const MODEL_OPTION_LABELS: Record<string, string> = {
  "platform-default": "跟随默认",
  ...Object.fromEntries(
    getModelCatalog()
      .filter((profile) => !profile.hidden)
      .map((profile) => [
        profile.id,
        `${profile.label} · ${COST_TIER_LABELS[profile.costTier] ?? profile.costTier}`
      ])
  )
};

export type NodeFieldType = "text" | "textarea" | "number" | "boolean" | "json" | "list" | "select";

export type NodeField = {
  key: string;
  label: string;
  type: NodeFieldType;
  required?: boolean;
  defaultValue?: unknown;
  placeholder?: string;
  help?: string;
  /** 文本类字段是否允许插入上游变量（会渲染「插入变量」下拉）。 */
  supportsRefs?: boolean;
  options?: string[];
  /** 选项显示名；未命中时前端回退显示 value 本身。 */
  optionLabels?: Record<string, string>;
  /** 属性面板里的分组标题；由 GROUP_RULES 自动补齐。 */
  group?: string;
};

/** 节点端口预设：输入侧给出推荐参数，输出侧列出可被下游引用的字段。 */
export type NodePortSpec = {
  name: string;
  label: string;
  type: NodePortType;
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
};

export type NodePortsSpec = {
  inputs: NodePortSpec[];
  outputs: NodePortSpec[];
};

export type NodeBlock = {
  key: string;
  label: string;
  required: boolean;
  multiple: boolean;
};

export type NodeTypeSpec = {
  kind: NodeKind;
  label: string;
  description: string;
  shape: "node" | "container";
  accent: string;
  fields: NodeField[];
  blocks: NodeBlock[];
  ports: NodePortsSpec;
};

export const COMMON_NODE_FIELDS: NodeField[] = [
  {
    key: "id",
    label: "节点 ID",
    type: "text",
    required: true,
    placeholder: "task-1",
    help: "全流程唯一，只允许字母、数字、下划线和短横线；变量引用靠它定位。"
  },
  { key: "title", label: "显示名称", type: "text", placeholder: "任务执行" },
  { key: "description", label: "说明", type: "textarea" }
];

/**
 * 每类节点的默认端口。
 * 输出端口的 name 会拼成 ${节点ID.name} 供下游引用；OBJECT 类型可用
 * ${节点ID.name.子字段} 引用用户声明在 outputSchema 里的 properties。
 */
const port = (
  name: string,
  label: string,
  type: NodePortType,
  description: string,
  required = false
): NodePortSpec => ({ name, label, type, description, required });

const OUTPUT_TEXT = port("output", "主产物", "string", "节点的主要输出，文本或结构化对象");
const OUTPUT_SUMMARY = port("summary", "摘要", "string", "执行器写入的一句话摘要");
const OUTPUT_THINKING = port("thinking", "思考摘要", "string", "模型开启思考时写入");

export const NODE_PORT_SPECS: Record<NodeKind, NodePortsSpec> = {
  start: {
    inputs: [],
    outputs: [port("output", "运行输入", "object", "本次运行的全部输入参数"), OUTPUT_SUMMARY]
  },
  end: {
    inputs: [port("inputs", "结果映射", "object", "键为对外字段名，值支持 ${节点.字段} 引用", true)],
    outputs: [port("outputs", "最终结果", "object", "汇总后的流程输出")]
  },
  agent: {
    inputs: [
      port("task", "任务描述", "string", "传给 Agent 的任务内容，支持 ${input.x} 与上游引用"),
      port("context", "上下文", "object", "补充给 Agent 的结构化上下文")
    ],
    outputs: [OUTPUT_TEXT, OUTPUT_SUMMARY, OUTPUT_THINKING]
  },
  tool: {
    inputs: [port("args", "工具参数", "object", "与工具 schema 对应的参数对象")],
    outputs: [OUTPUT_TEXT, port("status", "调用状态", "string", "succeeded / failed")]
  },
  knowledge: {
    inputs: [port("query", "检索问题", "string", "检索用的问题文本", true)],
    outputs: [
      port("hits", "召回结果", "array", "命中的知识片段列表"),
      port("citations", "引用", "array", "可追溯的引用信息"),
      OUTPUT_TEXT
    ]
  },
  http: {
    inputs: [port("requestBody", "请求体", "object", "JSON 请求体，支持引用插值")],
    outputs: [
      port("status", "HTTP 状态码", "number", "响应状态码"),
      port("body", "响应体", "object", "解析后的响应数据"),
      OUTPUT_TEXT
    ]
  },
  llm: {
    inputs: [
      port("query", "用户提示词", "string", "本次调用的用户侧输入，可直接引用上游产物"),
      port("context", "上下文", "object", "拼进提示词的补充上下文")
    ],
    outputs: [OUTPUT_TEXT, OUTPUT_SUMMARY, OUTPUT_THINKING]
  },
  clarify: {
    inputs: [port("request", "原始需求", "string", "待拆解的用户需求")],
    outputs: [
      port("rewrittenPrompt", "改写后提示词", "string", "结构化、消除歧义后的 Prompt"),
      port("needsClarification", "是否需要澄清", "boolean", "高影响歧义时暂停"),
      OUTPUT_TEXT
    ]
  },
  template: {
    inputs: [port("template", "模板变量", "object", "供 ${…} 插值的数据")],
    outputs: [OUTPUT_TEXT, port("value", "原始值", "string", "模板插值结果")]
  },
  extract: {
    inputs: [port("context", "待抽取内容", "object", "用户输入与上游变量；留空默认取本次运行输入")],
    outputs: [
      port("output", "抽取结果", "string", "按参数表拼出的可读文本"),
      port("missing", "未取到的参数", "array", "轮次用尽仍缺的必填参数名"),
      OUTPUT_SUMMARY
    ]
  },
  subworkflow: {
    inputs: [port("inputs", "子流程入参", "object", "键为子流程输入名", true)],
    outputs: [port("outputs", "子流程出参", "object", "输出映射的结果"), OUTPUT_TEXT]
  },
  parallel: {
    inputs: [],
    outputs: [OUTPUT_TEXT]
  },
  condition: {
    inputs: [port("when", "判断依据", "string", "只支持引用 + 运算符 + 值", true)],
    outputs: [OUTPUT_TEXT]
  },
  loop: {
    inputs: [port("while", "继续条件", "string", "每轮结束后的判断表达式")],
    outputs: [OUTPUT_TEXT]
  },
  verify: {
    inputs: [port("artifact", "待验产物", "string", "默认取最近一个非验证节点的输出")],
    outputs: [
      port("score", "得分", "number", "三层验证的加权得分"),
      port("confidence", "置信度", "number", "交叉验证一致性"),
      port("issues", "问题清单", "array", "规则层与基准层发现的问题"),
      OUTPUT_TEXT
    ]
  },
  approve: {
    inputs: [port("context", "待审上下文", "object", "展示在审批卡片上的数据")],
    outputs: [port("decision", "审批结论", "string", "approved / rejected"), OUTPUT_TEXT]
  },
  human: {
    inputs: [port("context", "交互上下文", "object", "展示在待输入卡片上的数据")],
    outputs: [port("response", "用户输入", "object", "提交的表单字段"), OUTPUT_TEXT]
  }
};

/** 属性面板分组顺序；未命中的字段归到「基础设置」。 */
export const NODE_FIELD_GROUPS = ["基础设置", "提示词", "模型与输出", "输入与参数", "高级设置"] as const;

const GROUP_KEYS: Record<string, string[]> = {
  提示词: ["prompt", "system", "askPrompt"],
  模型与输出: ["model", "temperature", "topP", "maxTokens", "thinking", "outputFormat", "outputContract"],
  输入与参数: ["inputs", "args", "query", "url", "headers", "requestBody", "fields", "template", "outputs", "when", "params"],
  高级设置: [
    "timeoutMs", "assignee", "budget", "patience", "stubOutput", "loopRole", "promoteToAgent",
    "capabilities", "toolCalling", "while", "maxIterations", "threshold", "rubric", "verifiers",
    "required", "expectedKeywords", "minChars", "requireEvidence", "checks", "knowledgeBaseIds",
    "topK", "agentVersion", "workflowVersion", "instructions", "submitLabel", "clarifyOn",
    "maxQuestions", "loopRole", "verifier", "maxRounds", "onMissing"
  ]
};

function groupOf(key: string): string {
  for (const [group, keys] of Object.entries(GROUP_KEYS)) {
    if (keys.includes(key)) {
      return group;
    }
  }
  return "基础设置";
}

const BASE_NODE_TYPE_SPECS: Omit<NodeTypeSpec, "ports">[] = [
  {
    kind: "start",
    label: "开始节点",
    description: "流程入口：把本次运行输入原样传入画布，不覆盖最近一次真实产物。",
    shape: "node",
    accent: "#4f7a57",
    fields: [],
    blocks: []
  },
  {
    kind: "end",
    label: "结束节点",
    description: "流程出口：把输入映射汇总为最终结果，适合声明对外返回字段。",
    shape: "node",
    accent: "#4f7a57",
    fields: [
      {
        key: "inputs",
        label: "结果映射",
        type: "json",
        supportsRefs: true,
        placeholder: "{\"plan\":\"${report.output}\"}",
        help: "键为对外字段名，值支持 ${节点.字段} 引用；留空则汇总整个上下文。"
      }
    ],
    blocks: []
  },
  {
    kind: "agent",
    label: "Agent 节点",
    description: "调用一个已注册 Agent，读取 inputs 并把输出写入自己的节点 id。",
    shape: "node",
    accent: "#a8552c",
    fields: [
      {
        key: "agent",
        label: "Agent",
        type: "select",
        required: true,
        placeholder: "planner-agent",
        help: "从注册中心选择；新注册的 Agent 点右上角「⋯ → 刷新注册项」即可出现。"
      },
      {
        key: "agentVersion",
        label: "指定 Agent 版本",
        type: "select",
        placeholder: "留空使用最新版本",
        help: "列出所选 Agent 的版本快照；留空跟随最新版。"
      },
      { key: "prompt", label: "附加提示词", type: "textarea", supportsRefs: true, placeholder: "围绕 ${input.topic} 生成任务初稿。" },
      {
        key: "model",
        label: "节点模型覆盖",
        type: "select",
        options: MODEL_OPTIONS,
        optionLabels: MODEL_OPTION_LABELS,
        help: "优先级：节点模型 → Agent 记录的 model → 平台默认；仅 live 模式生效，解析结果写入步骤 trace。"
      },
      {
        key: "outputFormat",
        label: "输出格式",
        type: "select",
        defaultValue: "text",
        options: ["text", "json"],
        optionLabels: { text: "文本", json: "结构化 JSON" },
        help: "JSON 模式会解析并校验 Agent 输出；下游可用 ${节点.output.字段} 直接引用。"
      },
      {
        key: "outputContract",
        label: "输出契约",
        type: "json",
        placeholder: "{\"required\":[\"rootCause\",\"action\"],\"enums\":{\"action\":[\"rewrite_agent\",\"swap_agent\",\"swap_model\"]}}",
        help: "JSON 模式生效：required 为必填字段，enums 限定枚举取值；不合法会直接判定该步失败。"
      },
      {
        key: "loopRole",
        label: "循环角色",
        type: "select",
        options: ["diagnose", "revise"],
        optionLabels: { diagnose: "诊断（不参与换 Agent）", revise: "修订（调度目标）" },
        help: "仅循环体有意义：诊断 Agent 只分析问题，修订 Agent 才会被 Self-Loop 换 Agent 策略覆盖。"
      },
      {
        key: "promoteToAgent",
        label: "补丁晋升目标",
        type: "text",
        placeholder: "analysis-planner",
        help: "诊断 Agent 专用：验证得分提升后，把生成的 promptPatch 写入该 Agent 的新版本；未提升则不写入。"
      },
      {
        key: "capabilities",
        label: "节点能力要求",
        type: "list",
        placeholder: "教学设计\n学情分析",
        help: "每行一个能力标签；留空时继承所选 Agent 的能力标签。填写后调度按节点任务要求匹配候选 Agent。"
      },
      {
        key: "toolCalling",
        label: "工具调用",
        type: "select",
        options: ["true"],
        optionLabels: { true: "开启" },
        help: "留空为关闭；开启后 Agent 会在输出前自主调用其声明的知识库 / MCP 工具，最多 4 轮，工具参数自动生成并记录到 trace。"
      },
      { key: "inputs", label: "输入映射", type: "json", supportsRefs: true, help: "键值对，值支持 ${节点.字段} 引用。" }
    ],
    blocks: []
  },
  {
    kind: "tool",
    label: "工具节点",
    description: "调用一个已注册工具，读取 args 并把输出写入自己的节点 id。",
    shape: "node",
    accent: "#8a5f72",
    fields: [
      {
        key: "tool",
        label: "工具",
        type: "select",
        required: true,
        placeholder: "knowledge.search",
        help: "从注册中心选择；新注册的工具点右上角「⋯ → 刷新注册项」即可出现。"
      },
      { key: "args", label: "调用参数", type: "json", supportsRefs: true }
    ],
    blocks: []
  },
  {
    kind: "knowledge",
    label: "知识库检索节点",
    description: "确定性知识库检索，不需要生成；可选范围留空时使用工作流默认知识库。",
    shape: "node",
    accent: "#a8552c",
    fields: [
      {
        key: "query",
        label: "检索问题",
        type: "textarea",
        required: true,
        supportsRefs: true,
        placeholder: "${input.topic}"
      },
      {
        key: "knowledgeBaseIds",
        label: "知识库范围",
        type: "list",
        placeholder: "kb-xxxx",
        help: "留空时使用工作流绑定的知识库；多个 ID 每行一个。"
      },
      {
        key: "topK",
        label: "召回条数",
        type: "number",
        defaultValue: 5,
        help: "1 到 20，默认 5。"
      },
      { key: "inputs", label: "输入映射", type: "json", supportsRefs: true }
    ],
    blocks: []
  },
  {
    kind: "http",
    label: "HTTP 请求节点",
    description: "调用外部 HTTP API；仅允许公网 http/https，拒绝内网、回环与云元数据地址。",
    shape: "node",
    accent: "#8a5f72",
    fields: [
      {
        key: "method",
        label: "请求方法",
        type: "select",
        required: true,
        defaultValue: "GET",
        options: ["GET", "POST", "PUT", "PATCH", "DELETE"]
      },
      {
        key: "url",
        label: "请求地址",
        type: "text",
        required: true,
        supportsRefs: true,
        placeholder: "https://api.example.com/v1/query",
        help: "只允许 http / https 公网地址；本地与内网地址会被拒绝。"
      },
      {
        key: "headers",
        label: "请求头",
        type: "json",
        supportsRefs: true,
        placeholder: "{\"Content-Type\":\"application/json\"}",
        help: "键值对；运行轨迹里只记录键名，不记录值。"
      },
      {
        key: "requestBody",
        label: "请求体",
        type: "json",
        supportsRefs: true,
        placeholder: "{\"query\":\"${input.topic}\"}",
        help: "JSON 对象会序列化后发送；GET / DELETE 可留空。"
      },
      {
        key: "timeoutMs",
        label: "超时时间（毫秒）",
        type: "number",
        placeholder: "默认 15000",
        help: "1000 到 120000。"
      },
      { key: "inputs", label: "输入映射", type: "json", supportsRefs: true }
    ],
    blocks: []
  },
  {
    kind: "llm",
    label: "模型思考节点",
    description: "直接完成一次思考/写作，不依赖注册中心 Agent；可打开思考摘要，产物写入节点 id。",
    shape: "node",
    accent: "#a8552c",
    fields: [
      {
        key: "prompt",
        label: "提示词",
        type: "textarea",
        required: true,
        supportsRefs: true,
        placeholder: "根据 ${input.topic} 分析产物的薄弱点，并给出三条改进建议。"
      },
      {
        key: "system",
        label: "系统提示词",
        type: "textarea",
        supportsRefs: true,
        placeholder: "你是一名评审专家，回答要具体、可执行。"
      },
      {
        key: "model",
        label: "模型",
        type: "select",
        options: MODEL_OPTIONS,
        optionLabels: MODEL_OPTION_LABELS,
        help: "从平台模型目录选择；留空使用平台默认模型，仅 live 模式生效。"
      },
      {
        key: "thinking",
        label: "模型思考",
        type: "boolean",
        defaultValue: true,
        help: "打开后产物包含 thinking 摘要，便于在监控台展示推理过程。"
      },
      { key: "temperature", label: "温度 Temperature", type: "number", placeholder: "0 ~ 2，留空使用平台默认值" },
      { key: "topP", label: "核采样 TopP", type: "number", placeholder: "0 ~ 1，留空使用上游默认值" },
      { key: "maxTokens", label: "最大 Token", type: "number", placeholder: "1 ~ 32768，留空使用平台默认值" },
      { key: "inputs", label: "输入映射", type: "json", supportsRefs: true }
    ],
    blocks: []
  },
  {
    kind: "clarify",
    label: "意图澄清节点",
    description:
      "读取本次运行输入，先拆解任务类型、目标、约束与歧义；存在高影响歧义时可暂停人工澄清，再输出可执行的结构化 Prompt 与改写记录。",
    shape: "node",
    accent: "#a8552c",
    fields: [
      {
        key: "prompt",
        label: "领域提示",
        type: "textarea",
        supportsRefs: true,
        placeholder: "这是经营分析任务，关注退款口径与区域归因。",
        help: "可选的额外约束或领域背景，支持 ${input.x} 引用；留空时只依据本次运行输入。"
      },
      {
        key: "model",
        label: "分析模型",
        type: "select",
        options: MODEL_OPTIONS,
        optionLabels: MODEL_OPTION_LABELS,
        help: "留空使用平台默认模型；分析用的是轻量模型，不参与后续调度。"
      },
      {
        key: "clarifyOn",
        label: "暂停条件",
        type: "select",
        defaultValue: "high",
        options: ["high", "any", "never"],
        optionLabels: { high: "仅高影响歧义", any: "任何歧义", never: "不暂停" },
        help: "演示建议 high：只有缺失信息会改变交付结果时才暂停，避免拖慢主线。"
      },
      {
        key: "maxQuestions",
        label: "澄清问题上限",
        type: "number",
        defaultValue: 2,
        help: "1 到 3；超过上限的歧义只写入记录，不阻塞运行。"
      },
      {
        key: "assignee",
        label: "澄清人/角色",
        type: "text",
        placeholder: "需求提出人",
        help: "仅作展示与记录，当前版本不做权限校验。"
      },
      {
        key: "timeoutMs",
        label: "澄清超时（毫秒）",
        type: "number",
        placeholder: "默认 1800000（30 分钟）",
        help: "超时未补充则运行失败；范围 1000 到 86400000。"
      },
      {
        key: "stubOutput",
        label: "离线夹具",
        type: "json",
        help: "仅 stub 模式：可强制 needsClarification 或指定 rewrittenPrompt，用于离线演练澄清分支。"
      },
      {
        key: "inputs",
        label: "输入映射",
        type: "json",
        supportsRefs: true,
        help: "留空时默认读取本次运行输入；可覆盖 request 字段或补充领域上下文。"
      }
    ],
    blocks: []
  },
  {
    kind: "extract",
    label: "参数提取",
    description:
      "按参数表从用户输入或上游变量里抽值；必填参数没抽到就先暂停追问，用户补齐、抽到了才继续往下走。",
    shape: "node",
    accent: "#a8552c",
    fields: [
      {
        key: "params",
        label: "参数信息",
        type: "json",
        placeholder: "[{\"name\":\"title\",\"label\":\"论文题目\",\"description\":\"完整的论文标题\",\"required\":true}]",
        help: "要提取的参数：名字（下游引用用）、描述（告诉模型找什么）、是否必填。表格在「参数信息」区编辑。"
      },
      {
        key: "prompt",
        label: "抽取提示词",
        type: "textarea",
        supportsRefs: true,
        group: "提示词",
        placeholder: "从用户的补充说明里识别完整论文题目；没有就留空，不要编造。",
        help: "给模型的额外规则；留空使用平台默认抽取指令（只输出 JSON，不编造）。"
      },
      {
        key: "askPrompt",
        label: "追问话术",
        type: "textarea",
        supportsRefs: true,
        placeholder: "请提供您的论文题目，我将为您模拟开题答辩。",
        help: "缺参数时展示在待输入卡片顶部；留空按参数标签自动拼，如「论文题目」。"
      },
      {
        key: "model",
        label: "模型",
        type: "select",
        options: MODEL_OPTIONS,
        optionLabels: MODEL_OPTION_LABELS,
        help: "抽取用的轻量模型；留空跟随平台默认，仅 live 模式生效。"
      },
      {
        key: "maxRounds",
        label: "最多追问轮次",
        type: "number",
        defaultValue: 3,
        group: "高级设置",
        help: "1 到 5，默认 3；每轮都重新抽取一次，抽到就继续。"
      },
      {
        key: "onMissing",
        label: "轮次用尽仍缺参数",
        type: "select",
        options: ["fail", "continue"],
        optionLabels: { fail: "判定失败并提示补充", continue: "带空缺继续" },
        group: "高级设置",
        help: "默认 fail：宁可停下也不让下游拿到空参数。"
      },
      {
        key: "assignee",
        label: "补充人/角色",
        type: "text",
        group: "高级设置",
        placeholder: "参训教师",
        help: "仅作展示与记录，当前版本不做权限校验。"
      },
      {
        key: "timeoutMs",
        label: "追问超时（毫秒）",
        type: "number",
        group: "高级设置",
        placeholder: "默认 1800000（30 分钟）",
        help: "超时未补充则运行失败；范围 1000 到 86400000。"
      },
      {
        key: "stubOutput",
        label: "离线夹具",
        type: "json",
        group: "高级设置",
        help: "仅 stub 模式：直接给定抽取结果，用于离线演练缺参分支。"
      },
      {
        key: "inputs",
        label: "输入映射",
        type: "json",
        supportsRefs: true,
        help: "要抽取的内容来源，可映射 ${input.input}、上游节点产物等；留空默认取本次运行输入。"
      }
    ],
    blocks: []
  },
  {
    kind: "template",
    label: "文本模板节点",
    description: "用 ${节点.字段} 组装确定性文本，不需要生成；适合拼接报告、提示词或交付物。",
    shape: "node",
    accent: "#7a6a52",
    fields: [
      {
        key: "template",
        label: "模板内容",
        type: "textarea",
        required: true,
        supportsRefs: true,
        placeholder: "# ${input.topic} 任务报告\n\n${draft.output}"
      },
      { key: "inputs", label: "输入映射", type: "json", supportsRefs: true }
    ],
    blocks: []
  },
  {
    kind: "subworkflow",
    label: "子工作流节点",
    description: "引用另一个已保存工作流并内联执行：独立输入作用域、编译期展开、父子 trace；支持输出映射。",
    shape: "node",
    accent: "#8a5f72",
    fields: [
      {
        key: "workflowId",
        label: "子工作流",
        type: "select",
        required: true,
        placeholder: "lesson-design-v1",
        help: "编译时会读取最新版本；保存前请先保存被引用的子流程。"
      },
      {
        key: "workflowVersion",
        label: "固定版本",
        type: "number",
        placeholder: "留空使用最新版本"
      },
      {
        key: "inputs",
        label: "输入映射",
        type: "json",
        supportsRefs: true,
        help: "键为子流程输入名，值为父流程作用域内可解析的引用。"
      },
      {
        key: "outputs",
        label: "输出映射",
        type: "json",
        supportsRefs: true,
        placeholder: "{\"result\":\"${task-1.output}\",\"score\":\"${verify-task.score}\"}",
        help: "值为子流程作用域内的引用；映射结果会挂到父流程对本节点的引用上。"
      }
    ],
    blocks: []
  },
  {
    kind: "parallel",
    label: "并行容器",
    description: "多个分支同时执行；分支之间不能互相引用输出，汇聚后才能被后续节点使用。",
    shape: "container",
    accent: "#b8760a",
    fields: [],
    blocks: [{ key: "branches", label: "并行分支", required: true, multiple: true }]
  },
  {
    kind: "condition",
    label: "条件容器",
    description: "按 when 表达式选择 then 或 else 分支；表达式只支持“引用 + 运算符 + 值”。",
    shape: "container",
    accent: "#b8760a",
    fields: [
      {
        key: "when",
        label: "条件表达式",
        type: "text",
        required: true,
        supportsRefs: true,
        placeholder: "${verify-initial.score} >= 0.85"
      }
    ],
    blocks: [
      { key: "then", label: "满足时执行", required: true, multiple: true },
      { key: "else", label: "不满足时执行", required: false, multiple: true }
    ]
  },
  {
    kind: "loop",
    label: "循环容器",
    description: "首轮必跑；之后由 Self-Loop 控制器根据分数、提升幅度和预算决定是否继续。",
    shape: "container",
    accent: "#b8760a",
    fields: [
      { key: "maxIterations", label: "最大轮次", type: "number", required: true, defaultValue: 2, help: "1 到 20。" },
      {
        key: "while",
        label: "继续条件",
        type: "text",
        supportsRefs: true,
        placeholder: "${verify-loop.score} < 0.85",
        help: "留空则只受轮次、无提升和预算约束。"
      },
      {
        key: "patience",
        label: "无提升轮次上限",
        type: "number",
        defaultValue: 2,
        help: "连续多少轮没有超过最低增益就停止，默认 2。"
      },
      {
        key: "budget",
        label: "预算",
        type: "json",
        placeholder: "{\"maxDurationMs\":120000,\"maxTokens\":0}",
        help: "时间与 token 预算；0 或不填表示不限制，token 为估算值。"
      }
    ],
    blocks: [{ key: "body", label: "循环体", required: true, multiple: true }]
  },
  {
    kind: "verify",
    label: "验证节点",
    description: "三层验证：规则校验 → 多 Agent 交叉验证 → 基准比对；分数、置信度与问题清单写入 trace。",
    shape: "node",
    accent: "#9a4030",
    fields: [
      { key: "verifier", label: "主验证器 ID", type: "select", required: true, placeholder: "observer-verifier" },
      {
        key: "model",
        label: "验证器模型",
        type: "select",
        options: MODEL_OPTIONS,
        optionLabels: MODEL_OPTION_LABELS,
        help: "留空时依次取验证 Agent 的 model、PLATFORM_VERIFY_MODEL、平台默认；建议指向独立模型以避免自评。"
      },
      { key: "rubric", label: "评分维度", type: "list", placeholder: "目标达成 / 互动覆盖 / 证据支撑" },
      { key: "threshold", label: "通过阈值", type: "number", defaultValue: 0.8, help: "0 到 1。" },
      {
        key: "verifiers",
        label: "交叉验证 Agent",
        type: "list",
        placeholder: "quality-verifier / reviewer-agent",
        help: "留空时自动选主验证器 + 其他带 verify.rubric 工具的 Agent，最多 3 个。"
      },
      {
        key: "required",
        label: "必需内容",
        type: "list",
        placeholder: "结论 / 证据",
        help: "规则层：输出必须包含的字段或小节名称。"
      },
      {
        key: "expectedKeywords",
        label: "标准要点",
        type: "list",
        placeholder: "关键结论 / 支撑证据",
        help: "基准层：标准答案关键词，缺失会直接列入问题清单。"
      },
      {
        key: "minChars",
        label: "最小篇幅",
        type: "number",
        help: "规则层：正文最少字符数，0 或不填表示不检查。"
      },
      {
        key: "requireEvidence",
        label: "要求证据引用",
        type: "boolean",
        help: "留空时根据评分维度是否含“证据/引用/来源”自动判断。"
      },
      {
        key: "checks",
        label: "数值核对",
        type: "json",
        placeholder: "[{\"type\":\"number_match\",\"tolerance\":0.01,\"anchors\":[\"毛利额\",\"毛利率\"]}]",
        help: "规则层：tolerance 为相对容差（0–1）。配置 anchors 时只核对各指标标签后的首个数字，忽略序号与派生数字；不配置时产物中的每个数字都必须能在 reference 里找到。"
      },
      { key: "inputs", label: "输入映射", type: "json", supportsRefs: true, help: "可不填 artifact，默认验证最近一个非验证节点的输出；checks 需要 reference。" }
    ],
    blocks: []
  },
  {
    kind: "approve",
    label: "人工审批节点",
    description: "运行在此暂停并生成待审任务；审批人通过后继续后续节点，驳回或超时则终止运行。",
    shape: "node",
    accent: "#9a4030",
    fields: [
      {
        key: "instructions",
        label: "审批说明",
        type: "textarea",
        placeholder: "确认产出目标、内容与评价一致后通过。",
        help: "会展示在运行监控的待审卡片上。"
      },
      {
        key: "assignee",
        label: "审批人/角色",
        type: "text",
        placeholder: "负责人",
        help: "仅作展示与记录，当前版本不做权限校验。"
      },
      {
        key: "timeoutMs",
        label: "超时时间（毫秒）",
        type: "number",
        placeholder: "默认 600000（10 分钟）",
        help: "超时未审批则运行失败；范围 1000 到 86400000。"
      },
      {
        key: "inputs",
        label: "待审上下文",
        type: "json",
        supportsRefs: true,
        help: "把产物、验证分或问题清单映射进待审卡片，审批人据此判断。"
      }
    ],
    blocks: []
  },
  {
    kind: "human",
    label: "选项卡",
    description: "运行在此暂停，把引导语与选项交给用户；选完可按提示词继续生成回复，选择结果同时传给下游。",
    shape: "node",
    accent: "#9a4030",
    fields: [
      {
        key: "model",
        label: "模型",
        type: "select",
        options: MODEL_OPTIONS,
        optionLabels: MODEL_OPTION_LABELS,
        help: "用户选完选项后用它生成回复；留空跟随平台默认模型，仅 live 模式生效。"
      },
      {
        key: "prompt",
        label: "引导语",
        type: "textarea",
        placeholder: "你想通过什么方式来模拟开题答辩？",
        help: "提问本身：展示在待输入卡片顶部，用户在这里看到要选什么。"
      },
      {
        key: "fields",
        label: "输入字段（高级）",
        type: "json",
        placeholder: "[{\"key\":\"text\",\"label\":\"发言\",\"type\":\"textarea\"}]",
        help: "除了选项之外的附加输入；支持 text / textarea / number / boolean / select。"
      },
      {
        key: "generatePrompt",
        label: "提示词",
        type: "textarea",
        supportsRefs: true,
        group: "提示词",
        placeholder: "若选择【根据论文题目进行模拟开题答辩】：先提取论文题目，再进入答辩模拟流程…",
        help: "选中后交给模型的指令，可用 ${choice} 取用户选的那一项；留空则只把选择结果传给下游。"
      },
      {
        key: "submitLabel",
        label: "提交按钮文案",
        type: "text",
        placeholder: "提交"
      },
      {
        key: "assignee",
        label: "操作人/角色",
        type: "text",
        placeholder: "参训教师",
        help: "仅作展示与记录，当前版本不做权限校验。"
      },
      {
        key: "timeoutMs",
        label: "超时时间（毫秒）",
        type: "number",
        placeholder: "默认 1800000（30 分钟）",
        help: "超时未输入则运行失败；范围 1000 到 86400000。"
      },
      {
        key: "inputs",
        label: "交互上下文",
        type: "json",
        supportsRefs: true,
        help: "把会话、课堂状态或上游产物映射进待输入卡片。"
      }
    ],
    blocks: []
  }
];

/** 对外契约：给每个节点补齐端口预设与字段分组，前端据此渲染参数表。 */
export const NODE_TYPE_SPECS: NodeTypeSpec[] = BASE_NODE_TYPE_SPECS.map((spec) => ({
  ...spec,
  ports: NODE_PORT_SPECS[spec.kind],
  fields: spec.fields.map((field) => ({ ...field, group: field.group ?? groupOf(field.key) }))
}));

export const CANVAS_CONTRACT = {
  model: "top-level-dag",
  containers: "collapsed",
  edgeScope: "top-level",
  containerEditing: "list",
  refSyntax: "${节点ID.字段} / ${input.字段名}",
  nodePorts: "inputBindings / outputSchema（编辑器写回 inputs，执行器按引用解析）",
  operators: ["<", "<=", ">", ">=", "==", "!="],
  variableExprForms: ["${ref}", "${ref} 运算符 值"]
} as const;
