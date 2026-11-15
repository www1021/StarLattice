import { useEffect, useRef, useState } from "react";
import { accountStorage } from "../features/auth/accountStorage";
import { createPortal } from "react-dom";
import type { ComponentType } from "react";
import {
  Activity,
  Blocks,
  Cable,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Clock3,
  Database,
  Ellipsis,
  GraduationCap,
  Gauge,
  GitBranch,
  HeartHandshake,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Layers,
  MessageSquare,
  Mic,
  PanelLeft,
  Plus,
  Repeat2,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareChartGantt,
  SquarePen,
  Users,
  Workflow
} from "lucide-react";
import { SCENE_STORAGE_KEY } from "../../shared/scenarioPacks";
import { USER_DISPLAY_NAME } from "../features/profile";
import brandLogo from "../images/男老师.png";
import defaultUserAvatar from "../images/默认用户.png";

type SidebarIcon = ComponentType<{
  size?: number;
  strokeWidth?: number;
  className?: string;
}>;

type SidebarSection =
  | "workbench"
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
  | "plugins"
  | "monitor"
  | "report"
  | "evolution";

type MenuItem = {
  label: string;
  icon: SidebarIcon;
  section: SidebarSection;
};

type NavGroup = {
  label: string;
  items: MenuItem[];
};

type ScenePack = {
  id: string;
  label: string;
  available: boolean;
  items: MenuItem[];
};

type SidebarProps = {
  activeSection: SidebarSection;
  chatMode: "office" | "education" | "workflow";
  collapsed: boolean;
  onOpenWorkbench: () => void;
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
  onOpenPlugins: () => void;
  onOpenMonitor: () => void;
  onOpenReport: () => void;
  onOpenEvolution: () => void;
  onNewTask: () => void;
  onOpenChat: () => void;
  onNewConversation: (mode: "education" | "office" | "workflow") => void;
  onToggle: () => void;
  /** 打开设置并直接落到指定页签（用户菜单里的「设置 / 模型与密钥」）。 */
  onOpenSettings: (tab: "appearance" | "models") => void;
  /** 账号与安全弹窗、退出登录、切换账号。 */
  onOpenAccount: () => void;
  onLogout: () => void;
  onSwitchAccount: () => void;
  user?: SidebarUser;
};

export type SidebarUser = {
  name: string;
  description?: string;
};

/** 主入口按「干什么」分组，工程能力降到次级，避免十几个入口平铺在同一层。 */
const navGroups: NavGroup[] = [
  {
    label: "工作区",
    items: [
      { label: "工作台", icon: LayoutDashboard, section: "workbench" },
      { label: "对话", icon: MessageSquare, section: "chat" },
      { label: "工作流", icon: Workflow, section: "platform" },
      { label: "运行记录", icon: Activity, section: "monitor" },
      { label: "对话历史", icon: Clock3, section: "history" }
    ]
  },
  {
    label: "资产与连接",
    items: [
      { label: "知识库", icon: Database, section: "library" },
      { label: "Agent", icon: Users, section: "registry" },
      { label: "MCP 连接", icon: Cable, section: "mcp" },
      { label: "插件", icon: Blocks, section: "plugins" }
    ]
  },
  {
    label: "质量",
    items: [
      { label: "场景验证", icon: Gauge, section: "scenarios" },
      { label: "验证报告", icon: ClipboardCheck, section: "report" },
      { label: "优化实验", icon: GitBranch, section: "evolution" }
    ]
  }
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
  name: USER_DISPLAY_NAME,
  description: "本地工作区"
};

function readStoredScene(): string {
  try {
    const stored = accountStorage.getItem(SCENE_STORAGE_KEY);
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
  onOpenWorkbench,
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
  onOpenPlugins,
  onOpenMonitor,
  onOpenReport,
  onOpenEvolution,
  onNewTask,
  onOpenChat,
  onNewConversation,
  onToggle,
  onOpenSettings,
  onOpenAccount,
  onLogout,
  onSwitchAccount,
  user = defaultUser
}: SidebarProps) {
  const [sceneId, setSceneId] = useState(readStoredScene);
  const [sceneOpen, setSceneOpen] = useState(false);
  const [taskMenu, setTaskMenu] = useState<{ top: number; left: number; width: number } | null>(null);
  const taskButtonRef = useRef<HTMLButtonElement>(null);
  const taskMenuRef = useRef<HTMLDivElement>(null);
  const [userMenu, setUserMenu] = useState<{ bottom: number; left: number; width: number } | null>(null);
  const userButtonRef = useRef<HTMLButtonElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const scene = scenePacks.find((pack) => pack.id === sceneId) ?? scenePacks[0];
  const sceneActive = scene.items.some((item) => item.section === activeSection);

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

  // 账号菜单：点在左下角，所以菜单往上弹。侧栏有 overflow，必须挂到 body 上。
  useEffect(() => {
    if (!userMenu) {
      return;
    }
    const close = () => setUserMenu(null);
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (userMenuRef.current?.contains(target) || userButtonRef.current?.contains(target)) {
        return;
      }
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      close();
      userButtonRef.current?.focus();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    const frame = requestAnimationFrame(() => {
      userMenuRef.current?.querySelector<HTMLButtonElement>(".user-menu-item")?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [userMenu]);

  const openUserMenu = () => {
    if (userMenu) {
      setUserMenu(null);
      return;
    }
    const rect = userButtonRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }
    const width = Math.max(214, Math.min(248, collapsed ? 232 : rect.width + 12));
    setUserMenu({
      bottom: window.innerHeight - rect.top + 8,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width
    });
  };

  const sectionHandlers: Record<SidebarSection, () => void> = {
    workbench: onOpenWorkbench,
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
    plugins: onOpenPlugins,
    monitor: onOpenMonitor,
    report: onOpenReport,
    evolution: onOpenEvolution
  };

  function handleSceneChange(nextId: string) {
    const next = scenePacks.find((pack) => pack.id === nextId);
    if (!next?.available) {
      return;
    }
    setSceneId(next.id);
    setSceneOpen(true);
    try {
      accountStorage.setItem(SCENE_STORAGE_KEY, next.id);
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

  /** 新建分两类：通用对话与平台任务；对话要不要走工作流在空状态页上选。 */
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
    const isActive = item.section === activeSection;
    return (
      <button
        className={`nav-item ${isActive ? "nav-item-active" : ""}`}
        key={`${item.section}-${item.label}`}
        type="button"
        onClick={sectionHandlers[item.section]}
        title={collapsed ? item.label : undefined}
      >
        <Icon size={16} strokeWidth={1.7} />
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
          <PanelLeft size={18} strokeWidth={1.8} />
        </button>
        <div className="brand">
          <img className="brand-logo" src={brandLogo} alt="" aria-hidden="true" />
          <span className="brand-name">StarLattice</span>
        </div>
      </div>

      <label className="nav-scene-pill" title="切换场景包">
        <span className="nav-scene-pill-dot" />
        <span className="nav-scene-pill-label">{scene.label}</span>
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
          <Plus size={16} strokeWidth={2} />
          <span>新建</span>
          <ChevronDown className="nav-task-caret" size={13} strokeWidth={1.8} />
        </button>

        {navGroups.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            {group.items.map(renderNavItem)}
          </div>
        ))}

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
              <Layers size={13} strokeWidth={1.8} />
              <span>场景实践</span>
              <ChevronRight
                size={12}
                className={`nav-scene-chevron ${sceneOpen ? "is-open" : ""}`}
              />
            </button>
          </div>
          {sceneOpen ? (
            <div className="nav-scene-items">{scene.items.map(renderNavItem)}</div>
          ) : null}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button
          ref={userButtonRef}
          className={`user-button${userMenu ? " is-open" : ""}`}
          type="button"
          aria-haspopup="menu"
          aria-expanded={Boolean(userMenu)}
          title={collapsed ? user.name : undefined}
          onClick={openUserMenu}
        >
          <img className="user-avatar" src={defaultUserAvatar} alt={user.name} />
          <span className="user-details">
            <span className="user-name">{user.name}</span>
            {user.description ? (
              <span className="user-description">{user.description}</span>
            ) : null}
          </span>
          <Ellipsis className="user-more" size={18} strokeWidth={1.8} />
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
                <SquarePen size={16} strokeWidth={1.8} />
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
                <Workflow size={16} strokeWidth={1.8} />
                <span>
                  <strong>新建任务</strong>
                  <small>选择流程、填写参数，创建可追踪的任务</small>
                </span>
              </button>
            </div>,
            document.body
          )
        : null}

      {userMenu
        ? createPortal(
            <div
              ref={userMenuRef}
              className="user-menu"
              role="menu"
              aria-label="账号与设置"
              style={{ bottom: userMenu.bottom, left: userMenu.left, width: userMenu.width }}
            >
              <div className="user-menu-head">
                <img className="user-avatar" src={defaultUserAvatar} alt={user.name} />
                <span className="user-menu-id">
                  <strong>{user.name}</strong>
                  <small>{user.description || "本地工作区"}</small>
                </span>
              </div>
              <div className="user-menu-group">
                <button
                  className="user-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserMenu(null);
                    onOpenSettings("appearance");
                  }}
                >
                  <Settings2 size={15} strokeWidth={1.8} />
                  <span>设置</span>
                  <em>主题与背景</em>
                </button>
                <button
                  className="user-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserMenu(null);
                    onOpenSettings("models");
                  }}
                >
                  <KeyRound size={15} strokeWidth={1.8} />
                  <span>模型与密钥</span>
                  <em>接入模型</em>
                </button>
                <button
                  className="user-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserMenu(null);
                    onOpenEvolution();
                  }}
                >
                  <Sparkles size={15} strokeWidth={1.8} />
                  <span>记忆与进化</span>
                  <em>偏好沉淀</em>
                </button>
              </div>
              <div className="user-menu-group">
                <button
                  className="user-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserMenu(null);
                    onOpenAccount();
                  }}
                >
                  <ShieldCheck size={15} strokeWidth={1.8} />
                  <span>账号与安全</span>
                  <em>密码 · 成员</em>
                </button>
                <button
                  className="user-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserMenu(null);
                    onSwitchAccount();
                  }}
                >
                  <Repeat2 size={15} strokeWidth={1.8} />
                  <span>切换账号</span>
                </button>
                <button
                  className="user-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setUserMenu(null);
                    onLogout();
                  }}
                >
                  <LogOut size={15} strokeWidth={1.8} />
                  <span>退出登录</span>
                </button>
              </div>
              <div className="user-menu-foot">
                <span>本地工作区</span>
                <span>数据仅存本机</span>
              </div>
            </div>,
            document.body
          )
        : null}
    </aside>
  );
}
