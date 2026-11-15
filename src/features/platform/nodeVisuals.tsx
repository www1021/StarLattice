import type { CSSProperties } from "react";
import {
  Bot,
  BrainCircuit,
  Database,
  FileText,
  GitBranch,
  Globe,
  MessageSquare,
  Play,
  Repeat,
  ScanText,
  ShieldCheck,
  Sparkles,
  Split,
  Square,
  UserCheck,
  Workflow,
  Wrench,
  type LucideIcon
} from "lucide-react";
import type { NodeKind } from "./types";

export type NodeCategory = "entry" | "ai" | "logic" | "data" | "integration" | "quality";

export const NODE_CATEGORIES: Array<{ id: NodeCategory; label: string }> = [
  { id: "entry", label: "入口 / 出口" },
  { id: "ai", label: "AI 节点" },
  { id: "logic", label: "逻辑控制" },
  { id: "data", label: "数据处理" },
  { id: "integration", label: "集成 / 工具" },
  { id: "quality", label: "验证与人机" }
];

type NodeVisual = {
  icon: LucideIcon;
  category: NodeCategory;
  tint: string;
};

/**
 * 一类节点一个颜色，同类同色、不同类不同色，靠图标区分具体节点。
 * 六个色相彼此拉开（绿 / 紫 / 蓝 / 橙 / 青 / 玫红），
 * 图标块是同色 13% 的浅底 + 同色描边，跟腾讯云那个侧栏是一个路子。
 */
export const CATEGORY_TINT: Record<NodeCategory, string> = {
  entry: "#2f7a4f",
  ai: "#6f5bd4",
  logic: "#2f6fd0",
  data: "#c9761c",
  integration: "#0f7f8f",
  quality: "#c04a63"
};

export const NODE_VISUALS: Record<NodeKind, NodeVisual> = {
  start: { icon: Play, category: "entry", tint: CATEGORY_TINT.entry },
  end: { icon: Square, category: "entry", tint: CATEGORY_TINT.entry },
  agent: { icon: Bot, category: "ai", tint: CATEGORY_TINT.ai },
  llm: { icon: Sparkles, category: "ai", tint: CATEGORY_TINT.ai },
  clarify: { icon: BrainCircuit, category: "ai", tint: CATEGORY_TINT.ai },
  extract: { icon: ScanText, category: "ai", tint: CATEGORY_TINT.ai },
  knowledge: { icon: Database, category: "ai", tint: CATEGORY_TINT.ai },
  condition: { icon: GitBranch, category: "logic", tint: CATEGORY_TINT.logic },
  parallel: { icon: Split, category: "logic", tint: CATEGORY_TINT.logic },
  loop: { icon: Repeat, category: "logic", tint: CATEGORY_TINT.logic },
  template: { icon: FileText, category: "data", tint: CATEGORY_TINT.data },
  tool: { icon: Wrench, category: "integration", tint: CATEGORY_TINT.integration },
  http: { icon: Globe, category: "integration", tint: CATEGORY_TINT.integration },
  subworkflow: { icon: Workflow, category: "integration", tint: CATEGORY_TINT.integration },
  verify: { icon: ShieldCheck, category: "quality", tint: CATEGORY_TINT.quality },
  approve: { icon: UserCheck, category: "quality", tint: CATEGORY_TINT.quality },
  human: { icon: MessageSquare, category: "quality", tint: CATEGORY_TINT.quality }
};

/**
 * 给图标块用的样式变量。颜色只在 CSS 里消费（浅底 + 同色前景），
 * 深浅两套主题各写一份混合比例，组件里只管把色相传下去。
 */
export function nodeTintStyle(kind: NodeKind): CSSProperties {
  return { "--node-tint": NODE_VISUALS[kind].tint } as CSSProperties;
}

export function categoryOf(kind: NodeKind): NodeCategory {
  return NODE_VISUALS[kind].category;
}

export function categoryLabel(category: NodeCategory): string {
  return NODE_CATEGORIES.find((item) => item.id === category)?.label ?? category;
}
