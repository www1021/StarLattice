import { create } from "zustand";

/**
 * 桌宠的四种状态，对应同一套形象的四张立绘。
 * - idle：待机，缓慢呼吸和轻晃
 * - running：正在回答，左右摆动加小跳
 * - success：回答完成，蹦起来欢呼
 * - error：请求失败，发抖委屈
 */
export type PetMood = "idle" | "running" | "success" | "error";

const RUNNING_LINES = [
  "翻资料中…",
  "让我看看…",
  "正在连线知识库",
  "这个我得查一下",
  "稍微等我一下"
];

const SUCCESS_LINES = ["搞定！", "找到啦！", "答完了～", "这题我会！"];

const ERROR_LINES = ["唔…出错了", "没连上，再来一次", "这个我没搞懂", "出岔子了"];

function pick(lines: string[]): string {
  return lines[Math.floor(Math.random() * lines.length)];
}

type PetState = {
  mood: PetMood;
  caption: string;
  /** 切换到某个状态；不传文案时按状态随机挑一句。 */
  bump: (mood: PetMood, caption?: string) => void;
  /** 回到待机并清空气泡。 */
  rest: () => void;
};

let settleTimer: ReturnType<typeof setTimeout> | undefined;

function clearSettle() {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = undefined;
  }
}

export const usePetStore = create<PetState>()((set, get) => ({
  mood: "idle",
  caption: "",
  bump(mood, caption) {
    // 已经在跑的时候再来一条工具进度，不换标语，免得气泡一直跳字
    if (mood === "running" && get().mood === "running" && !caption) {
      return;
    }
    clearSettle();
    if (mood === "idle") {
      set({ mood: "idle", caption: "" });
      return;
    }
    const text =
      caption ??
      (mood === "running"
        ? pick(RUNNING_LINES)
        : mood === "success"
          ? pick(SUCCESS_LINES)
          : pick(ERROR_LINES));
    set({ mood, caption: text });
    // 成功欢呼两秒多就自己退回待机；报错和运行中留给调用方收尾。
    if (mood === "success") {
      settleTimer = setTimeout(() => {
        set({ mood: "idle", caption: "" });
        settleTimer = undefined;
      }, 2600);
    }
  },
  rest() {
    clearSettle();
    set({ mood: "idle", caption: "" });
  }
}));

/** 组件外部（事件回调里）直接驱动，不用把它塞进 React 状态链。 */
export const pet = {
  running: (caption?: string) => usePetStore.getState().bump("running", caption),
  success: (caption?: string) => usePetStore.getState().bump("success", caption),
  error: (caption?: string) => usePetStore.getState().bump("error", caption),
  rest: () => usePetStore.getState().rest()
};
