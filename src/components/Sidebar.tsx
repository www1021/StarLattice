import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ComponentType } from "react";
import {
  Activity,
  Cable,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Database,
  Ellipsis,
  GraduationCap,
  Gauge,
  HeartHandshake,
  Layers,
  Mic,
  PanelLeft,
  Plus,
  SquareChartGantt,
  SquarePen,
  Users,
  Workflow
} from "lucide-react";
import { SCENE_STORAGE_KEY } from "../../shared/scenarioPacks";

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
  | "scenarios"
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

type ScenePack = {
  id: string;
  label: string;
  available: boolean;
  items: MenuItem[];
};

type SidebarProps = {
  activeSection: SidebarSection;
  chatMode: "office" | "education";
  collapsed: boolean;
  onOpenGrowth: () => void;
  onOpenHistory: () => void;
  onOpenKnowledge: () => void;
  onOpenClassroom: () => void;
  onOpenCounselingTraining: () => void;
  onOpenSpeakTraining: () => void;
  onOpenPlatform: () => void;
  onOpenScenarios: () => void;
  onOpenRegistry: () => void;
  onOpenLibrary: () => void;
  onOpenMcp: () => void;
  onOpenMonitor: () => void;
  onOpenReport: () => void;
  onNewTask: () => void;
  onOpenChat: () => void;
  onNewConversation: (mode: "education" | "office") => void;
  onToggle: () => void;
  user?: SidebarUser;
};

export type SidebarUser = {
  name: string;
  description?: string;
};

const platformItems: MenuItem[] = [
  { label: "工作流编排", icon: Workflow, section: "platform" },
  { label: "场景验证", icon: Gauge, section: "scenarios" },
  { label: "Agent 注册中心", icon: Users, section: "registry" },
  { label: "知识库", icon: Database, section: "library" },
  { label: "对话历史", icon: Clock3, section: "history" },
  { label: "MCP 连接", icon: Cable, section: "mcp" },
  { label: "运行监控", icon: Activity, section: "monitor" },
  { label: "验证报告", icon: ClipboardCheck, section: "report" }
];

const scenePacks: ScenePack[] = [
  {
    id: "education",
    label: "教育场景",
    available: true,
    items: [
      { label: "说课训练", icon: Mic, section: "speak" },
      { label: "虚拟课堂", icon: GraduationCap, section: "classroom" },
      { label: "谈心谈话", icon: HeartHandshake, section: "counseling" },
      { label: "成长报告", icon: SquareChartGantt, section: "growth" }
    ]
  },
  {
    id: "business-analysis",
    label: "经营分析",
    available: true,
    items: [
      { label: "经营分析地图", icon: Workflow, section: "platform" },
      { label: "指标知识库", icon: Database, section: "library" },
      { label: "数据分析 MCP", icon: Cable, section: "mcp" },
      { label: "场景验证", icon: Gauge, section: "scenarios" }
    ]
  }
];

const defaultUser: SidebarUser = {
  name: "本地工作区",
  description: "单机 SQLite"
};

function readStoredScene(): string {
  try {
    const stored = window.localStorage.getItem(SCENE_STORAGE_KEY);
    if (scenePacks.some((pack) => pack.id === stored && pack.available)) {
      return stored as string;
    }
  } catch {
    // 隐私模式下 localStorage 可能不可用，回落到默认场景。
  }
  return "education";
}

export function Sidebar({
  activeSection,
  chatMode,
  collapsed,
  onOpenGrowth,
  onOpenHistory,
  onOpenKnowledge,
  onOpenClassroom,
  onOpenCounselingTraining,
  onOpenSpeakTraining,
  onOpenPlatform,
  onOpenScenarios,
  onOpenRegistry,
  onOpenLibrary,
  onOpenMcp,
  onOpenMonitor,
  onOpenReport,
  onNewTask,
  onOpenChat,
  onNewConversation,
  onToggle,
  user = defaultUser
}: SidebarProps) {
  const [sceneId, setSceneId] = useState(readStoredScene);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [taskMenu, setTaskMenu] = useState<{ top: number; left: number; width: number } | null>(null);
  const taskButtonRef = useRef<HTMLButtonElement>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);
  const scene = scenePacks.find((pack) => pack.id === sceneId) ?? scenePacks[0];
  const officeActive = activeSection === "chat" && chatMode === "office";
  const sceneActive = !officeActive && scene.items.some((item) => item.section === activeSection);

  useEffect(() => {
    if (sceneActive) {
      setSceneOpen(true);
    }
  }, [sceneActive]);

  useEffect(() => {
    if (!taskMenu) {
      return;
    }
    const close = () => setTaskMenu(null);
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (taskMenuRef.current?.contains(target) || taskButtonRef.current?.contains(target)) {
        return;
      }
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      close();
      taskButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    const frame = requestAnimationFrame(() => {
      taskMenuRef.current?.querySelector<HTMLButtonElement>(".nav-task-option")?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [taskMenu]);

  const sectionHandlers: Record<SidebarSection, () => void> = {
    chat: onOpenChat,
    speak: onOpenSpeakTraining,
    classroom: onOpenClassroom,
    counseling: onOpenCounselingTraining,
    knowledge: onOpenKnowledge,
    history: onOpenHistory,
    growth: onOpenGrowth,
    platform: onOpenPlatform,
    scenarios: onOpenScenarios,
    registry: onOpenRegistry,
    library: onOpenLibrary,
    mcp: onOpenMcp,
    monitor: onOpenMonitor,
    report: onOpenReport
  };

  function handleSceneChange(nextId: string) {
    const next = scenePacks.find((pack) => pack.id === nextId);
    if (!next?.available) {
      return;
    }
    setSceneId(next.id);
    setSceneOpen(true);
    try {
      window.localStorage.setItem(SCENE_STORAGE_KEY, next.id);
    } catch {
      // 场景选择仍在本会话生效，持久化失败不影响使用。
    }
  }

  function toggleTaskMenu() {
    if (taskMenu) {
      setTaskMenu(null);
      return;
    }
    const button = taskButtonRef.current;
    if (!button) {
      return;
    }
    const rect = button.getBoundingClientRect();
    const width = Math.max(rect.width, 224);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    setTaskMenu({ top: rect.bottom + 8, left, width });
  }

  /** 与 DeepSeek Harness 一致：新建分为通用对话与平台任务两类。 */
  function startTask(type: "workflow" | "chat") {
    setTaskMenu(null);
    if (type === "workflow") {
      onNewTask();
      return;
    }
    onNewConversation("office");
  }

  function renderNavItem(item: MenuItem) {
    const Icon = item.icon;
    const isActive =
      item.section === activeSection && !(officeActive && item.section === "chat");
    return (
      <button
        className={`nav-item ${isActive ? "nav-item-active" : ""}`}
        key={item.section}
        type="button"
        onClick={sectionHandlers[item.section]}
        title={collapsed ? item.label : undefined}
      >
        <Icon size={22} strokeWidth={2.1} />
        <span>{item.label}</span>
      </button>
    );
  }

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
        <div className="brand">
          <span className="brand-name">StarLattice</span>
          <span className="brand-sub">多 Agent 编排与自进化平台</span>
        </div>
      </div>

      <nav className="nav-list">
        <button
          ref={taskButtonRef}
          className="nav-item nav-primary"
          type="button"
          onClick={toggleTaskMenu}
          aria-haspopup="menu"
          aria-expanded={Boolean(taskMenu)}
          title={collapsed ? "新建" : undefined}
        >
          <Plus size={22} strokeWidth={2.2} />
          <span>新建</span>
          <ChevronDown className="nav-task-caret" size={14} strokeWidth={2.1} />
        </button>

        <div className="nav-group">
          <div className="nav-group-label">平台能力</div>
          {platformItems.map(renderNavItem)}
        </div>

        <div className={`nav-group nav-scene ${sceneActive ? "has-active" : ""}`}>
          <div className="nav-scene-head">
            <button
              className="nav-scene-toggle"
              type="button"
              aria-expanded={sceneOpen}
              aria-label="场景实践"
              onClick={() => setSceneOpen((value) => !value)}
              title={collapsed ? "场景实践" : undefined}
            >
              <Layers size={15} strokeWidth={2.1} />
              <span>场景实践</span>
              <ChevronRight
                size={13}
                className={`nav-scene-chevron ${sceneOpen ? "is-open" : ""}`}
              />
            </button>
            <label className="nav-scene-picker" title="切换场景包">
              <span>{scene.label}</span>
              <ChevronDown size={12} aria-hidden />
              <select
                aria-label="切换场景包"
                value={scene.id}
                onChange={(event) => handleSceneChange(event.target.value)}
              >
                {scenePacks.map((pack) => (
                  <option key={pack.id} value={pack.id} disabled={!pack.available}>
                    {pack.available ? pack.label : `${pack.label}（接入中）`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {sceneOpen ? <div className="nav-scene-items">{scene.items.map(renderNavItem)}</div> : null}
        </div>
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

      {taskMenu
        ? createPortal(
            <div
              ref={taskMenuRef}
              className="nav-task-menu"
              role="menu"
              aria-label="新建"
              style={{ top: taskMenu.top, left: taskMenu.left, width: taskMenu.width }}
            >
              <button
                className="nav-task-option"
                type="button"
                role="menuitem"
                onClick={() => startTask("chat")}
              >
                <SquarePen size={17} strokeWidth={2.1} />
                <span>
                  <strong>新对话</strong>
                  <small>通用办公助手 · 不绑定场景</small>
                </span>
              </button>
              <button
                className="nav-task-option"
                type="button"
                role="menuitem"
                onClick={() => startTask("workflow")}
              >
                <Workflow size={17} strokeWidth={2.1} />
                <span>
                  <strong>新建任务</strong>
                  <small>选择流程、填写参数，创建可追踪的任务</small>
                </span>
              </button>
            </div>,
            document.body
          )
        : null}
    </aside>
  );
}
