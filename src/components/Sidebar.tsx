import type { ComponentType } from "react";
import {
  BookOpen,
  Clock3,
  Ellipsis,
  GraduationCap,
  HeartHandshake,
  Mic,
  PanelLeft,
  SquareChartGantt,
  SquarePen
} from "lucide-react";
import avatarUrl from "../images/avatar.png";

type SidebarIcon = ComponentType<{
  size?: number;
  strokeWidth?: number;
  className?: string;
}>;

type MenuItem = {
  label: string;
  icon: SidebarIcon;
  section?:
    | "chat"
    | "knowledge"
    | "history"
    | "growth"
    | "speak"
    | "counseling"
    | "classroom";
};

type SidebarProps = {
  activeSection:
    | "chat"
    | "knowledge"
    | "history"
    | "growth"
    | "speak"
    | "counseling"
    | "classroom";
  collapsed: boolean;
  onOpenGrowth: () => void;
  onOpenHistory: () => void;
  onOpenKnowledge: () => void;
  onOpenClassroom: () => void;
  onOpenCounselingTraining: () => void;
  onOpenSpeakTraining: () => void;
  onNewConversation: () => void;
  onToggle: () => void;
  user?: SidebarUser;
};

export type SidebarUser = {
  name: string;
  description?: string;
  avatarUrl?: string;
  initials?: string;
};

const menuItems: MenuItem[] = [
  { label: "新对话", icon: SquarePen, section: "chat" },
  { label: "说课训练", icon: Mic, section: "speak" },
  { label: "虚拟课堂", icon: GraduationCap, section: "classroom" },
  { label: "谈心谈话", icon: HeartHandshake, section: "counseling" },
  { label: "知识库", icon: BookOpen, section: "knowledge" },
  { label: "历史记录", icon: Clock3, section: "history" },
  { label: "成长报告", icon: SquareChartGantt, section: "growth" }
];

const defaultUser: SidebarUser = {
  name: "实训用户",
  description: "个人空间",
  avatarUrl,
  initials: "师"
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
  onNewConversation,
  onToggle,
  user = defaultUser
}: SidebarProps) {
  const avatarLabel = user.initials ?? user.name.slice(0, 1);

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
          const isActive =
            item.section === "chat"
              ? activeSection === "chat"
              : item.section === activeSection;

          return (
            <button
              className={`nav-item ${isActive ? "nav-item-active" : ""}`}
              key={item.label}
              type="button"
              onClick={
                item.label === "新对话"
                  ? onNewConversation
                  : item.label === "说课训练"
                    ? onOpenSpeakTraining
                    : item.label === "虚拟课堂"
                      ? onOpenClassroom
                      : item.label === "谈心谈话"
                        ? onOpenCounselingTraining
                    : item.label === "知识库"
                        ? onOpenKnowledge
                        : item.label === "历史记录"
                          ? onOpenHistory
                          : item.label === "成长报告"
                            ? onOpenGrowth
                            : undefined
              }
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
          <span className="user-avatar" aria-hidden="true">
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt="" />
            ) : (
              <span>{avatarLabel}</span>
            )}
          </span>
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
