const ACTIVE_STATUSES = new Set(["queued", "running", "verifying", "revising"]);
const TERMINAL_TIMEOUT_MS = Number(process.env.BENCH_RUN_TIMEOUT_MS || 600_000);
const POLL_INTERVAL_MS = 50;

export default class PlatformWorkflowProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
    this.baseUrl = String(
      process.env.BENCH_BASE_URL || this.config.baseUrl || "http://127.0.0.1:8790"
    ).replace(/\/$/, "");
    this.workflowId = this.config.workflowId;
    this.workflowIds = this.config.workflowIds ?? {};
    this.threshold = Number(this.config.threshold ?? 0.85);
  }

  id() {
    return `platform:${this.config.label ?? this.workflowId}`;
  }

  async callApi(_prompt, context = {}) {
    const vars = context.vars ?? {};
    const workflowId = this.workflowIds[vars.scenario] ?? this.workflowId;
    if (!workflowId) {
      return failure(`未配置场景 ${vars.scenario ?? "(empty)"} 的工作流`);
    }
    const knowledgeBaseIds = (process.env.BENCH_KNOWLEDGE_BASE_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const input = {
      ...vars,
      knowledgeBaseIds: Array.isArray(vars.knowledgeBaseIds)
        ? vars.knowledgeBaseIds
        : knowledgeBaseIds.length > 0
          ? knowledgeBaseIds
          : ["kb-demo"]
    };

    const created = await fetch(`${this.baseUrl}/api/platform/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflowId, input, async: true })
    });
    if (!created.ok) {
      return failure(`创建运行失败 HTTP ${created.status}`, await safeText(created));
    }
    const { run } = await created.json();
    const finished = await this.waitForRun(run.id);
    const trace = await this.fetchTrace(run.id);
    return {
      output: JSON.stringify(summarize(workflowId, vars, finished, trace, this.threshold))
    };
  }

  async waitForRun(runId) {
    const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
    let last;
    while (Date.now() < deadline) {
      const response = await fetch(`${this.baseUrl}/api/platform/runs/${encodeURIComponent(runId)}`);
      if (!response.ok) {
        throw new Error(`查询运行失败 HTTP ${response.status}`);
      }
      last = (await response.json()).run;
      if (!ACTIVE_STATUSES.has(last.status)) {
        return last;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return { ...last, status: "failed", error: `超时：${TERMINAL_TIMEOUT_MS}ms 内未结束` };
  }

  async fetchTrace(runId) {
    const response = await fetch(`${this.baseUrl}/api/platform/runs/${encodeURIComponent(runId)}/trace`);
    if (!response.ok) {
      return { steps: [], verifyResults: [], loopIterations: [] };
    }
    return response.json();
  }
}

function summarize(workflowId, vars, run, trace, threshold) {
  const verifyResults = Array.isArray(trace?.verifyResults) ? trace.verifyResults : [];
  const lastVerify = verifyResults.at(-1);
  const finalOutput = run?.output === undefined ? null : run.output;
  // D1.1 之后平台保留最优轮产物，最终分应读运行输出里的保留分，而不是最后一次验证分。
  const outputVerify = finalOutput && typeof finalOutput === "object" ? finalOutput.verify : null;
  const retainedScore =
    outputVerify && typeof outputVerify.score === "number"
      ? outputVerify.score
      : finalOutput && typeof finalOutput.score === "number"
        ? finalOutput.score
        : null;
  const score =
    retainedScore ?? (lastVerify && typeof lastVerify.score === "number" ? lastVerify.score : null);
  const retainedPassed =
    outputVerify && typeof outputVerify.passed === "boolean" ? outputVerify.passed : null;
  return {
    taskId: vars.taskId ?? null,
    scenario: vars.scenario ?? null,
    difficulty: vars.difficulty ?? null,
    category: vars.category ?? null,
    workflowId,
    runId: run?.id ?? null,
    status: run?.status ?? "failed",
    mode: run?.mode ?? null,
    success: run?.status === "succeeded",
    score,
    confidence: lastVerify && typeof lastVerify.confidence === "number" ? lastVerify.confidence : null,
    verifyCount: verifyResults.length,
    verifyPassed: retainedPassed ?? (score === null ? null : score >= threshold),
    threshold,
    steps: Array.isArray(trace?.steps) ? trace.steps.length : (run?.stepCount ?? 0),
    iterations: Array.isArray(trace?.loopIterations) ? trace.loopIterations.length : 0,
    tokens: finalOutput && typeof finalOutput.tokensUsed === "number" ? finalOutput.tokensUsed : 0,
    durationMs: run?.durationMs ?? null,
    error: run?.error ?? null,
    outputPreview:
      finalOutput === null
        ? null
        : typeof finalOutput === "string"
          ? finalOutput.slice(0, 400)
          : JSON.stringify(finalOutput).slice(0, 400)
  };
}

function failure(message, detail) {
  return {
    output: JSON.stringify({
      status: "failed",
      success: false,
      error: detail ? `${message}: ${detail.slice(0, 400)}` : message
    })
  };
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
