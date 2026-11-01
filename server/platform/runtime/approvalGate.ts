import type { ApprovalDecision } from "../types.js";

export type ApprovalOutcome = {
  decision: ApprovalDecision | "expired";
  reviewer?: string;
  comment?: string;
};

type Waiter = {
  settle: (outcome: ApprovalOutcome) => void;
};

/**
 * 进程内审批等待点。执行器在 approve 节点挂起并注册 waiter，
 * API 决策时唤醒对应运行；服务重启后内存等待点丢失，属于当前版本的已知边界。
 */
export class ApprovalGate {
  private readonly waiters = new Map<string, Waiter>();

  wait(approvalId: string, timeoutMs: number): Promise<ApprovalOutcome> {
    return new Promise((resolve) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.waiters.delete(approvalId);
              resolve({ decision: "expired" });
            }, timeoutMs)
          : undefined;
      timer?.unref?.();

      this.waiters.set(approvalId, {
        settle: (outcome) => {
          if (timer) {
            clearTimeout(timer);
          }
          this.waiters.delete(approvalId);
          resolve(outcome);
        }
      });
    });
  }

  decide(
    approvalId: string,
    decision: ApprovalDecision,
    reviewer?: string,
    comment?: string
  ): boolean {
    const waiter = this.waiters.get(approvalId);
    if (!waiter) {
      return false;
    }
    waiter.settle({ decision, reviewer, comment });
    return true;
  }

  has(approvalId: string) {
    return this.waiters.has(approvalId);
  }
}
