import {
  Bot,
  Database,
  FileText,
  GitBranch,
  Globe,
  Play,
  Repeat,
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

export const NODE_VISUALS: Record<NodeKind, NodeVisual> = {
  start: { icon: Play, category: "entry", tint: "#16a34a" },
  end: { icon: Square, category: "entry", tint: "#0f766e" },
  agent: { icon: Bot, category: "ai", tint: "#6366f1" },
  llm: { icon: Sparkles, category: "ai", tint: "#8b5cf6" },
  knowledge: { icon: Database, category: "ai", tint: "#0284c7" },
  condition: { icon: GitBranch, category: "logic", tint: "#f59e0b" },
  parallel: { icon: Split, category: "logic", tint: "#14b8a6" },
  loop: { icon: Repeat, category: "logic", tint: "#a855f7" },
  template: { icon: FileText, category: "data", tint: "#64748b" },
  tool: { icon: Wrench, category: "integration", tint: "#0ea5e9" },
  http: { icon: Globe, category: "integration", tint: "#f97316" },
  subworkflow: { icon: Workflow, category: "integration", tint: "#0d9488" },
  verify: { icon: ShieldCheck, category: "quality", tint: "#ef4444" },
  approve: { icon: UserCheck, category: "quality", tint: "#0891b2" }
};

export function categoryOf(kind: NodeKind): NodeCategory {
  return NODE_VISUALS[kind].category;
}

export function categoryLabel(category: NodeCategory): string {
  return NODE_CATEGORIES.find((item) => item.id === category)?.label ?? category;
}
