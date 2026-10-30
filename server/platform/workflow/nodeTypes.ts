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
    description: "首轮必跑；while 从第二轮起在每轮开始前判断，可读取 body 上一轮的验证分数。",
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
        help: "留空则跑满最大轮次。"
      }
    ],
    blocks: [{ key: "body", label: "循环体", required: true, multiple: true }]
  },
  {
    kind: "verify",
    label: "验证节点",
    description: "调用验证器打分并写入 platform_verify_results，分数和置信度进入 trace。",
    shape: "node",
    accent: "#ef4444",
    fields: [
      { key: "verifier", label: "验证器 ID", type: "select", required: true, placeholder: "observer-verifier" },
      { key: "rubric", label: "评分维度", type: "list", placeholder: "目标达成 / 互动覆盖 / 证据支撑" },
      { key: "threshold", label: "通过阈值", type: "number", defaultValue: 0.8, help: "0 到 1。" },
      { key: "inputs", label: "输入映射", type: "json", supportsRefs: true }
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
