import type { ClassroomState } from "./classroomTypes.js";
import { currentOwnerId } from "../auth/context.js";

type StoredClassroom = {
  state: ClassroomState;
  /** 创建会话时的账号；无身份的后台任务与单元测试留 null。 */
  ownerId: string | null;
};

/**
 * 虚拟课堂只活在内存里，没有落库那层 owner 条件可以兜底，
 * 所以归属得记在这张表上。真实 HTTP / WebSocket 请求一定带身份，
 * 两种都为 null 时保持老行为，免得测试脚本和后台任务被挡住。
 */
export class ClassroomSessionStore {
  private readonly sessions = new Map<string, StoredClassroom>();

  get(sessionId: string, ownerId = currentOwnerId()): ClassroomState | undefined {
    const stored = this.sessions.get(sessionId);
    if (!stored || !sameOwner(stored.ownerId, ownerId)) {
      return undefined;
    }
    return stored.state;
  }

  /** 返回 undefined 表示这个 id 已经属于别人，不能覆盖。 */
  save(state: ClassroomState, ownerId = currentOwnerId()): ClassroomState | undefined {
    const existing = this.sessions.get(state.sessionId);
    if (existing && !sameOwner(existing.ownerId, ownerId)) {
      return undefined;
    }
    this.sessions.set(state.sessionId, { state, ownerId });
    return state;
  }

  update(state: ClassroomState) {
    const existing = this.sessions.get(state.sessionId);
    const nextState = {
      ...state,
      updatedAt: Date.now()
    };
    this.sessions.set(nextState.sessionId, {
      state: nextState,
      ownerId: existing?.ownerId ?? currentOwnerId()
    });
    return nextState;
  }
}

function sameOwner(recorded: string | null, requested: string | null): boolean {
  return !recorded || !requested || recorded === requested;
}
