export type HumanOutcome =
  | { status: "answered"; values: Record<string, unknown>; actor?: string }
  | { status: "expired" }
  | { status: "cancelled" };

type Waiter = {
  settle: (outcome: HumanOutcome) => void;
};

/**
 * 进程内人工输入等待点。执行器在 human 节点挂起并注册 waiter，
 * 训练页或监控台提交后唤醒运行；服务重启后等待点丢失，属于当前版本的已知边界。
 */
export class HumanGate {
  private readonly waiters = new Map<string, Waiter>();

  wait(interactionId: string, timeoutMs: number): Promise<HumanOutcome> {
    return new Promise((resolve) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.waiters.delete(interactionId);
              resolve({ status: "expired" });
            }, timeoutMs)
          : undefined;
      timer?.unref?.();

      this.waiters.set(interactionId, {
        settle: (outcome) => {
          if (timer) {
            clearTimeout(timer);
          }
          this.waiters.delete(interactionId);
          resolve(outcome);
        }
      });
    });
  }

  answer(interactionId: string, values: Record<string, unknown>, actor?: string): boolean {
    const waiter = this.waiters.get(interactionId);
    if (!waiter) {
      return false;
    }
    waiter.settle({ status: "answered", values, actor });
    return true;
  }

  cancel(interactionId: string): boolean {
    const waiter = this.waiters.get(interactionId);
    if (!waiter) {
      return false;
    }
    waiter.settle({ status: "cancelled" });
    return true;
  }

  has(interactionId: string) {
    return this.waiters.has(interactionId);
  }
}
