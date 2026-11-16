import { create } from "zustand";
import type { PetMood } from "./petCast";

/** 被转交方出场时的形象与名字 */
type Helper = {
  castId: string;
  name: string;
};

type PetState = {
  mood: PetMood;
  /** 头顶气泡文案。空字符串就不显示气泡——没有真实步骤可讲时宁可不说。 */
  caption: string;
  /** 转交给专项 Agent 时出场的那位；null 表示只有主角 */
  helper: Helper | null;
  /** 点击压缩动画的令牌，每点一次加一 */
  pressToken: number;
  /** 闭眼帧是否正在显示 */
  blinking: boolean;
  running: (caption?: string) => void;
  success: () => void;
  error: (caption?: string) => void;
  rest: () => void;
  helperIn: (target: Helper) => void;
  helperOut: () => void;
  press: (caption?: string) => void;
};

const PRESS_LINES = ["别按我…", "压扁啦", "咯咯", "轻点…", "哎呀"];

let settleTimer: ReturnType<typeof setTimeout> | undefined;
let blinkTimer: ReturnType<typeof setTimeout> | undefined;
let captionTimer: ReturnType<typeof setTimeout> | undefined;

function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
  if (timer) clearTimeout(timer);
}

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

export const usePetStore = create<PetState>()((set, get) => ({
  mood: "idle",
  caption: "",
  helper: null,
  pressToken: 0,
  blinking: false,

  running(caption) {
    clearTimer(settleTimer);
    settleTimer = undefined;
    // 没有新文案就沿用旧的，免得连着两条工具进度把气泡闪来闪去
    set((state) => ({ mood: "running", caption: caption ?? state.caption }));
  },

  success() {
    clearTimer(settleTimer);
    // 完成时不硬编一句话，直接蹦起来，两秒多后回待机。
    // 借来的人当场就让她溜回去，主角弹回中间欢呼。
    set({ mood: "success", caption: "", helper: null });
    settleTimer = setTimeout(() => {
      set({ mood: "idle" });
      settleTimer = undefined;
    }, 2400);
  },

  error(caption) {
    clearTimer(settleTimer);
    set({ mood: "error", caption: caption ?? "", helper: null });
  },

  rest() {
    clearTimer(settleTimer);
    clearTimer(captionTimer);
    set({ mood: "idle", caption: "", helper: null });
  },

  helperIn(target) {
    const current = get().helper;
    if (current && current.castId === target.castId && current.name === target.name) {
      return;
    }
    set({ helper: target, mood: "running" });
  },

  helperOut() {
    set({ helper: null });
  },

  press(caption) {
    clearTimer(blinkTimer);
    clearTimer(captionTimer);
    set((state) => ({
      pressToken: state.pressToken + 1,
      blinking: true,
      caption: caption ?? pick(PRESS_LINES)
    }));
    blinkTimer = setTimeout(() => {
      set({ blinking: false });
      blinkTimer = undefined;
    }, 150);
    // 点击的气泡留一会儿就清掉，不跟真实步骤混在一起
    captionTimer = setTimeout(() => {
      if (get().mood === "idle") set({ caption: "" });
      captionTimer = undefined;
    }, 1800);
  }
}));

/** 组件外部（事件回调里）直接驱动，不用把它塞进 React 状态链。 */
export const pet = {
  running: (caption?: string) => usePetStore.getState().running(caption),
  success: () => usePetStore.getState().success(),
  error: (caption?: string) => usePetStore.getState().error(caption),
  rest: () => usePetStore.getState().rest(),
  helperIn: (target: Helper) => usePetStore.getState().helperIn(target),
  helperOut: () => usePetStore.getState().helperOut(),
  press: (caption?: string) => usePetStore.getState().press(caption)
};
