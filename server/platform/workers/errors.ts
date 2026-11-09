/** Worker 进程失联或被终止：当前步骤按可重试失败处理，由执行器重派。 */
export class WorkerLostError extends Error {
  constructor(message = "Worker 被终止，任务将重新调度。") {
    super(message);
    this.name = "WorkerLostError";
  }
}
