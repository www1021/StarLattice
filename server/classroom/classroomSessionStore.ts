import type { ClassroomState } from "./classroomTypes.js";

export class ClassroomSessionStore {
  private readonly sessions = new Map<string, ClassroomState>();

  get(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  save(state: ClassroomState) {
    this.sessions.set(state.sessionId, state);
    return state;
  }

  update(state: ClassroomState) {
    const nextState = {
      ...state,
      updatedAt: Date.now()
    };
    this.sessions.set(nextState.sessionId, nextState);
    return nextState;
  }
}
