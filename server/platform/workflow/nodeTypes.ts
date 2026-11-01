import type { NodeKind } from "../types.js";

export const NODE_TYPE_CONTRACT_VERSION = 1;

export type NodeFieldType = "text" | "textarea" | "number" | "boolean" | "json" | "list" | "select";

export type NodeField = {
  key: string;
  label: string;
  type: NodeFieldType;
  required?: boolean;
  defaultValue?: unknown;
  placeholder?: string;
  help?: string;
  supportsRefs?: boolean;
  options?: string[];
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
};

export const COMMON_NODE_FIELDS: NodeField[] = [
  {
    key: "id",
    label: "节点 ID",
    type: "text",
    required: true,
    placeholder: "lesson-plan",
    help: "全流程唯一，只允许字母、数字、下划线和短横线；变量引用靠它定位。"
  },
  { key: "title", label: "显示名称", type: "text", placeholder: "教案生成" },
  { key: "description", label: "说明", type: "textarea" }
];

export const NODE_TYPE_SPECS: NodeTypeSpec[] = [
  {
    kind: "agent",
    label: "Agent 节点",
    description: "调用一个已注册 Agent，读取 inputs 并把输出写入自己的节点 id。",
    shape: "node",
    accent: "#6366f1",
    fields: [
      {
        key: "agent",
        label: "Agent ID",
        type: "select",
        required: true,
        placeholder: "lesson-plan-agent",
        help: "T1.3 注册中心上线后改用下拉；当前按字符串填写。"
      },
      {
        key: "agentVersion",
        label: "指定 Agent 版本",
        type: "number",
        placeholder: "留空使用最新版本",
        help: "填注册中心里的版本号，运行与 trace 会固定使用该版本快照。"
      },
      { key: "prompt", label: "附加提示词", type: "textarea", supportsRefs: true, placeholder: "围绕 ${input.topic} 生成教案初稿。" },
      { key: "inputs", label: "输入映射", type: "json", supportsRefs: true, help: "键值对，值支持 ${节点.字段} 引用。" }
    ],
    blocks: []
  },
  {
    kind: "tool",
    label: "工具节点",
    description: "调用一个已注册工具，读取 args 并把输出写入自己的节点 id。",
    shape: "node",
    accent: "#0ea5e9",
    fields: [
      {
        key: "tool",
        label: "工具 ID",
        type: "select",
        required: true,
        placeholder: "knowledge.search",
        help: "T1.3 注册中心上线后改用下拉；当前按字符串填写。"
      },
      { key: "args", label: "调用参数", type: "json", supportsRefs: true }
    ],
    blocks: []
  },
  {
    kind: "llm",
    label: "模型思考节点",
    description: "直接调用模型完成一次思考/写作，不依赖注册中心 Agent；可打开思考摘要，产物写入节点 id。",
    shape: "node",
    accent: "#8b5cf6",
    fields: [
      {
        key: "prompt",
        label: "提示词",
        type: "textarea",
        required: true,
        supportsRefs: true,
        placeholder: "根据 ${input.topic} 分析教案的薄弱点，并给出三条改进建议。"
      },
      {
        key: "system",
        label: "系统提示词",
        type: "textarea",
        supportsRefs: true,
        placeholder: "你是一名教研专家，回答要具体、可执行。"
      },
      {
        key: "model",
        label: "模型",
        type: "text",
        placeholder: "留空使用平台默认模型",
        help: "live 模式生效；stub 模式始终返回确定性结果。"
      },
      {
        key: "thinking",
        label: "模型思考",
        type: "boolean",
        defaultValue: true,
        help: "打开后产物包含 thinking 摘要，便于在监控台展示推理过程。"
      },
      { key: "temperature", label: "温度", type: "number", placeholder: "留空使用平台默认值" },
      { key: "maxTokens", label: "最大 Token", type: "number", placeholder: "留空使用平台默认值" },
      { key: "inputs", label: "输入映射", type: "json", supportsRefs: true }
    ],
    blocks: []
  },
  {
    kind: "template",
    label: "文本模板节点",
    description: "用 ${节点.字段} 组装确定性文本，不调用模型；适合拼接报告、提示词或交付物。",
    shape: "node",
    accent: "#64748b",
    fields: [
      {
        key: "template",
        label: "模板内容",
        type: "textarea",
        required: true,
        supportsRefs: true,
        placeholder: "# ${input.topic} 教学设计\n\n${lesson-design.plan}"
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
    accent: "#0d9488",
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
        placeholder: "{\"plan\":\"${lesson-plan.output}\",\"score\":\"${verify-plan.score}\"}",
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
    accent: "#14b8a6",
    fields: [],
    blocks: [{ key: "branches", label: "并行分支", required: true, multiple: true }]
  },
  {
    kind: "condition",
    label: "条件容器",
    description: "按 when 表达式选择 then 或 else 分支；表达式只支持“引用 + 运算符 + 值”。",
    shape: "container",
    accent: "#f59e0b",
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
    accent: "#a855f7",
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
    accent: "#ef4444",
    fields: [
      { key: "verifier", label: "主验证器 ID", type: "select", required: true, placeholder: "observer-verifier" },
      { key: "rubric", label: "评分维度", type: "list", placeholder: "目标达成 / 互动覆盖 / 证据支撑" },
      { key: "threshold", label: "通过阈值", type: "number", defaultValue: 0.8, help: "0 到 1。" },
      {
        key: "verifiers",
        label: "交叉验证 Agent",
        type: "list",
        placeholder: "observer-verifier / teaching-expert-agent",
        help: "留空时自动选主验证器 + 其他带 verify.rubric 工具的 Agent，最多 3 个。"
      },
      {
        key: "required",
        label: "必需内容",
        type: "list",
        placeholder: "教学目标 / 学生活动",
        help: "规则层：输出必须包含的字段或小节名称。"
      },
      {
        key: "expectedKeywords",
        label: "标准要点",
        type: "list",
        placeholder: "分数的意义 / 分层练习",
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
      { key: "inputs", label: "输入映射", type: "json", supportsRefs: true, help: "可不填 artifact，默认验证最近一个非验证节点的输出。" }
    ],
    blocks: []
  },
  {
    kind: "approve",
    label: "人工审批节点",
    description: "运行在此暂停并生成待审任务；审批人通过后继续后续节点，驳回或超时则终止运行。",
    shape: "node",
    accent: "#0891b2",
    fields: [
      {
        key: "instructions",
        label: "审批说明",
        type: "textarea",
        placeholder: "确认教案目标、活动与评价一致后通过。",
        help: "会展示在运行监控的待审卡片上。"
      },
      {
        key: "assignee",
        label: "审批人/角色",
        type: "text",
        placeholder: "教研组长",
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
  }
];

export const CANVAS_CONTRACT = {
  model: "top-level-dag",
  containers: "collapsed",
  edgeScope: "top-level",
  containerEditing: "list",
  refSyntax: "${节点ID.字段} / ${input.字段名}",
  operators: ["<", "<=", ">", ">=", "==", "!="],
  variableExprForms: ["${ref}", "${ref} 运算符 值"]
} as const;
