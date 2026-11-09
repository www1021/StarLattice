import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { JUDGE_VERSION, extractArtifact, judgeArtifact } from "../judge.mjs";

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
    const task = { ...vars, relevantDocs: docsOf(vars.relevantDocs) };
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
      relevantDocs: task.relevantDocs,
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
    const artifact = extractArtifact(trace);
    const retrieval = retrievalOf(trace, task);
    const artifactFile = saveArtifact(this.config.label ?? workflowId, vars.taskId, artifact.text);
    const judged = judgeArtifact(task, artifact.text, { mode: process.env.BENCH_JUDGE_MODE });
    return {
      output: JSON.stringify(
        summarize(workflowId, vars, finished, trace, this.threshold, artifact, judged, artifactFile, retrieval)
      )
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

function summarize(workflowId, vars, run, trace, threshold, artifact, judged, artifactFile, retrieval) {
  const verifyResults = Array.isArray(trace?.verifyResults) ? trace.verifyResults : [];
  const lastVerify = verifyResults.at(-1);
  const finalOutput = run?.output === undefined ? null : run.output;
  // 平台自验分只作为“平台内部结论”记录，不与固定裁判分混用。
  const outputVerify = finalOutput && typeof finalOutput === "object" ? finalOutput.verify : null;
  const selfVerifyScore =
    outputVerify && typeof outputVerify.score === "number"
      ? outputVerify.score
      : finalOutput && typeof finalOutput.score === "number"
        ? finalOutput.score
        : lastVerify && typeof lastVerify.score === "number"
          ? lastVerify.score
          : null;
  const selfVerifyPassed =
    outputVerify && typeof outputVerify.passed === "boolean"
      ? outputVerify.passed
      : selfVerifyScore === null
        ? null
        : selfVerifyScore >= threshold;
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
    // 固定裁判结果：汇总口径只认这一组字段。
    evalScore: judged.evalScore,
    evalPassed: judged.evalPassed,
    evalDimensions: judged.evalDimensions,
    hardRules: judged.hardRules,
    evalMeta: judged.evalMeta,
    judgeVersion: JUDGE_VERSION,
    judgeMode: judged.judgeMode,
    judgeModel: judged.judgeModel ?? null,
    judgeFallback: judged.judgeFallback === true,
    judgeError: judged.judgeError ?? null,
    // 平台自验保留为对照，不参与达标判定。
    selfVerifyScore,
    selfVerifyPassed,
    score: selfVerifyScore,
    confidence: lastVerify && typeof lastVerify.confidence === "number" ? lastVerify.confidence : null,
    verifyCount: verifyResults.length,
    initialVerifyScore: firstVerifyScore(verifyResults),
    finalVerifyScore: lastVerifyScore(verifyResults),
    verifyPassed: selfVerifyPassed,
    threshold,
    steps: Array.isArray(trace?.steps) ? trace.steps.length : (run?.stepCount ?? 0),
    iterations: Array.isArray(trace?.loopIterations) ? trace.loopIterations.length : 0,
    tokens: finalOutput && typeof finalOutput.tokensUsed === "number" ? finalOutput.tokensUsed : 0,
    durationMs: run?.durationMs ?? null,
    artifactSource: artifact.source,
    artifactNodeId: artifact.nodeId,
    artifactChars: artifact.text.length,
    artifactFile: artifactFile ?? null,
    artifactHash: artifact.text
      ? createHash("sha256").update(artifact.text).digest("hex").slice(0, 16)
      : null,
    retrievalTitles: retrieval.titles,
    retrievalRecall5: retrieval.recall5,
    retrievalPrecision5: retrieval.precision5,
    error: run?.error ?? null,
    outputPreview:
      finalOutput === null
        ? null
        : typeof finalOutput === "string"
          ? finalOutput.slice(0, 400)
          : JSON.stringify(finalOutput).slice(0, 400)
  };
}

function firstVerifyScore(results) {
  const scored = results.find((result) => typeof result?.score === "number");
  return scored ? scored.score : null;
}

function lastVerifyScore(results) {
  const scored = [...results].reverse().find((result) => typeof result?.score === "number");
  return scored ? scored.score : null;
}

function docsOf(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split("|")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function retrievalOf(trace, vars) {
  const steps = Array.isArray(trace?.steps) ? trace.steps : [];
  const step = steps.find(
    (item) =>
      item.status === "succeeded" && /(^|\.)(retrieve|search)$/.test(String(item.nodeId ?? ""))
  );
  const docs = Array.isArray(vars.relevantDocs) ? vars.relevantDocs : [];
  if (!step) {
    return { titles: [], recall5: null, precision5: null };
  }
  let payload = step.output;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }
  const titles = (Array.isArray(payload?.citations) ? payload.citations : [])
    .map((citation) => citation?.title ?? citation?.documentName)
    .filter((title) => typeof title === "string" && title.trim() !== "");
  if (docs.length === 0 || titles.length === 0) {
    return { titles, recall5: null, precision5: null };
  }
  const normalize = (value) => String(value).toLowerCase().replace(/\.md$/i, "").replace(/\s+/g, "").trim();
  const relevant = docs.filter((doc) =>
    titles.some((title) => normalize(title).includes(normalize(doc)) || normalize(doc).includes(normalize(title)))
  );
  return {
    titles,
    recall5: relevant.length / docs.length,
    precision5: relevant.length / titles.length
  };
}

function saveArtifact(label, taskId, text) {  const dir = process.env.BENCH_ARTIFACT_DIR;
  if (!dir || !taskId) return null;
  const safeLabel = String(label ?? "unknown").replace(/[^\w\u4e00-\u9fa5.-]+/g, "_");
  const safeTask = String(taskId).replace(/[^\w.-]+/g, "_");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${safeTask}__${safeLabel}.md`);
  writeFileSync(file, text ?? "");
  return file;
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
