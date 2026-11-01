import type { ComponentType } from "react";
import {
  Activity,
  BookOpen,
  Cable,
  ClipboardCheck,
  Clock3,
  Database,
  Ellipsis,
  GraduationCap,
  HeartHandshake,
  Mic,
  PanelLeft,
  SquareChartGantt,
  SquarePen,
  Users,
  Workflow
} from "lucide-react";

type SidebarIcon = ComponentType<{
  size?: number;
  strokeWidth?: number;
  className?: string;
}>;

type SidebarSection =
  | "chat"
  | "knowledge"
  | "history"
  | "growth"
  | "speak"
  | "counseling"
  | "classroom"
  | "platform"
  | "registry"
  | "library"
  | "mcp"
  | "monitor"
  | "report";

type MenuItem = {
  label: string;
  icon: SidebarIcon;
  section: SidebarSection;
};

type SidebarProps = {
  activeSection: SidebarSection;
  collapsed: boolean;
  onOpenGrowth: () => void;
  onOpenHistory: () => void;
  onOpenKnowledge: () => void;
  onOpenClassroom: () => void;
  onOpenCounselingTraining: () => void;
  onOpenSpeakTraining: () => void;
  onOpenPlatform: () => void;
  onOpenRegistry: () => void;
  onOpenLibrary: () => void;
  onOpenMcp: () => void;
  onOpenMonitor: () => void;
  onOpenReport: () => void;
  onNewConversation: () => void;
  onToggle: () => void;
  user?: SidebarUser;
};

export type SidebarUser = {
  name: string;
  description?: string;
};

const menuItems: MenuItem[] = [
  { label: "新对话", icon: SquarePen, section: "chat" },
  { label: "说课训练", icon: Mic, section: "speak" },
  { label: "虚拟课堂", icon: GraduationCap, section: "classroom" },
  { label: "谈心谈话", icon: HeartHandshake, section: "counseling" },
  { label: "知识库", icon: BookOpen, section: "knowledge" },
  { label: "历史记录", icon: Clock3, section: "history" },
  { label: "成长报告", icon: SquareChartGantt, section: "growth" },
  { label: "编排画布", icon: Workflow, section: "platform" },
  { label: "注册中心", icon: Users, section: "registry" },
  { label: "知识库管理", icon: Database, section: "library" },
  { label: "MCP 连接", icon: Cable, section: "mcp" },
  { label: "运行监控", icon: Activity, section: "monitor" },
  { label: "验证报告", icon: ClipboardCheck, section: "report" }
];

const defaultUser: SidebarUser = {
  name: "实训用户",
  description: "个人空间"
};

export function Sidebar({
  activeSection,
  collapsed,
  onOpenGrowth,
  onOpenHistory,
  onOpenKnowledge,
  onOpenClassroom,
  onOpenCounselingTraining,
  onOpenSpeakTraining,
  onOpenPlatform,
  onOpenRegistry,
  onOpenLibrary,
  onOpenMcp,
  onOpenMonitor,
  onOpenReport,
  onNewConversation,
  onToggle,
  user = defaultUser
}: SidebarProps) {
  const sectionHandlers: Record<SidebarSection, () => void> = {
    chat: onNewConversation,
    speak: onOpenSpeakTraining,
    classroom: onOpenClassroom,
    counseling: onOpenCounselingTraining,
    knowledge: onOpenKnowledge,
    history: onOpenHistory,
    growth: onOpenGrowth,
    platform: onOpenPlatform,
    registry: onOpenRegistry,
    library: onOpenLibrary,
    mcp: onOpenMcp,
    monitor: onOpenMonitor,
    report: onOpenReport
  };

  return (
    <aside className="sidebar" aria-label="主导航" data-collapsed={collapsed}>
      <div className="sidebar-top">
        <button
          className="sidebar-toggle"
          type="button"
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-expanded={!collapsed}
          onClick={onToggle}
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          <PanelLeft size={23} strokeWidth={2} />
        </button>
        <div className="brand">师范生实训平台</div>
      </div>

      <nav className="nav-list">
        {menuItems.map((item) => {
          const Icon = item.icon;
          const isActive = item.section === activeSection;

          return (
            <button
              className={`nav-item ${isActive ? "nav-item-active" : ""}`}
              key={item.label}
              type="button"
              onClick={sectionHandlers[item.section]}
              title={collapsed ? item.label : undefined}
            >
              <Icon size={22} strokeWidth={2.1} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <button
          className="user-button"
          type="button"
          title={collapsed ? user.name : undefined}
        >
          <span className="user-details">
            <span className="user-name">{user.name}</span>
            {user.description ? (
              <span className="user-description">{user.description}</span>
            ) : null}
          </span>
          <Ellipsis className="user-more" size={20} strokeWidth={2.1} />
        </button>
      </div>
    </aside>
  );
}
