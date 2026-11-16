/** 三栏布局的宽度与右侧面板状态：纯逻辑，便于单独测试。 */

export type DockTab = "agents" | "workflows" | "insight";

export type PaneLayout = {
  sidebarWidth: number;
  dockWidth: number;
  dockOpen: boolean;
  dockTab: DockTab;
};

export const SIDEBAR_MIN = 208;
export const SIDEBAR_MAX = 420;
export const SIDEBAR_DEFAULT = 260;
export const SIDEBAR_COLLAPSED = 72;

export const DOCK_MIN = 320;
export const DOCK_MAX = 620;
export const DOCK_DEFAULT = 408;

export const LAYOUT_STORAGE_KEY = "starlattice.layout.v1";

export const DEFAULT_LAYOUT: PaneLayout = {
  sidebarWidth: SIDEBAR_DEFAULT,
  dockWidth: DOCK_DEFAULT,
  dockOpen: false,
  dockTab: "agents"
};

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? clamp(Math.round(parsed), min, max) : fallback;
}

function isDockTab(value: unknown): value is DockTab {
  return value === "agents" || value === "workflows" || value === "insight";
}

/** 从 localStorage 读布局；任何异常都回退到默认值，绝不让坏数据卡住页面。 */
export function readLayout(storage?: Pick<Storage, "getItem">): PaneLayout {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    const raw = store?.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_LAYOUT };
    }
    const parsed = JSON.parse(raw) as Partial<PaneLayout> | null;
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_LAYOUT };
    }
    return {
      sidebarWidth: readNumber(parsed.sidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX),
      dockWidth: readNumber(parsed.dockWidth, DOCK_DEFAULT, DOCK_MIN, DOCK_MAX),
      dockOpen: typeof parsed.dockOpen === "boolean" ? parsed.dockOpen : DEFAULT_LAYOUT.dockOpen,
      dockTab: isDockTab(parsed.dockTab) ? parsed.dockTab : DEFAULT_LAYOUT.dockTab
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** 写布局；隐私模式或存储被禁用时静默失败。 */
export function writeLayout(
  layout: PaneLayout,
  storage?: Pick<Storage, "setItem">
): void {
  try {
    const store = storage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
    store?.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // 存不进去就算了，不影响使用
  }
}

/** 窄屏时禁用拖拽，让 CSS 媒体查询接管，避免把中间对话区挤没。 */
export function isCompactViewport(width: number): boolean {
  return width < 960;
}
