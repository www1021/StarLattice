import { randomUUID } from "node:crypto";
import { PlatformError, type AgentRecord, type WorkflowDefinition } from "../types.js";
import type { PlatformStateStore } from "../runtime/stateStore.js";
import type { WorkflowExecutor } from "../runtime/executor.js";
import type {
  EvaluationDataset,
  EvaluationRun,
  EvolutionAlert,
  EvolutionCandidate,
  EvolutionChange,
  GateDecision,
  GatePolicy,
  ReleaseArtifact,
  ReleaseManifest,
  ReleaseRollout,
  ResolvedRelease,
  RolloutArm,
  RunReleaseAssignment
} from "./types.js";
import { DEFAULT_GATE_POLICY } from "./types.js";
import { applyEvolutionChanges } from "./changes.js";
import { evaluateGate } from "./evaluator.js";
import { scanChanges } from "./security.js";
import {
  canonicalJson,
  envFlag,
  envNumber,
  newId,
  round4,
  sha256,
  shortHash,
  slug,
  trafficBucket
} from "./util.js";

export type EvolutionServiceOptions = {
  store: PlatformStateStore;
  /** 真实模型执行器；门禁 live 模式与线上流量共用。 */
  liveExecutor?: WorkflowExecutor;
  /** 无模型的确定性执行器；默认门禁模式，避免日常验证消耗 token。 */
  stubExecutor?: WorkflowExecutor;
};

export type CreateCandidateInput = {
  workflowId: string;
  baseReleaseId?: string;
  title: string;
  summary?: string;
  changes: EvolutionChange[];
  source?: EvolutionCandidate["source"];
  proposedBy?: string;
};

export type GateRequest = {
  mode?: "stub" | "live";
  policy?: Partial<GatePolicy>;
  datasetId?: string;
  maxCases?: number;
};

export type RolloutRequest = {
  percent?: number;
  minSamplesPerArm?: number;
  maxScoreDrop?: number;
  maxErrorRateDelta?: number;
  createdBy?: string;
};

export type RunReleasePick = {
  releaseId: string;
  baseReleaseId?: string;
  experimentId?: string;
  arm: RolloutArm;
  rolloutId?: string;
  assignmentKey: string;
};

const DEMO_WORKFLOW_LABEL: Record<string, string> = {
  "business-analysis-v1": "经营分析（自愈旗舰）",
  "classroom-v1": "课堂设计"
};

export class EvolutionService {
  private readonly store: PlatformStateStore;
  private liveExecutor?: WorkflowExecutor;
  private stubExecutor?: WorkflowExecutor;

  constructor(options: EvolutionServiceOptions) {
    this.store = options.store;
    this.liveExecutor = options.liveExecutor;
    this.stubExecutor = options.stubExecutor;
  }

  /** 执行器与演化服务互相依赖，先建服务再挂执行器，避免构造函数环。 */
  attachExecutors(executors: { live?: WorkflowExecutor; stub?: WorkflowExecutor }) {
    this.liveExecutor = executors.live ?? this.liveExecutor;
    this.stubExecutor = executors.stub ?? this.stubExecutor;
  }

  enabled(): boolean {
    return envFlag("PLATFORM_EVOLUTION_ENABLED", true);
  }

  /** 由执行器注入：只返回快照，不执行任何写操作。 */
  resolveRelease(releaseId: string): ResolvedRelease | undefined {
    const manifest = this.store.getRelease(releaseId);
    if (!manifest) {
      return undefined;
    }
    const hash = sha256(canonicalJson(manifest.artifact));
    if (hash !== manifest.artifactHash) {
      throw new PlatformError(
        `发布「${releaseId}」快照哈希不一致，可能被篡改；已拒绝运行。`,
        409
      );
    }
    const workflows = new Map(manifest.artifact.workflows.map((workflow) => [workflow.id, workflow]));
    return {
      manifest,
      workflow: manifest.artifact.workflow,
      workflows,
      agents: manifest.artifact.agents
    };
  }

  // -------------------------------------------------------------------------
  // 发布
  // -------------------------------------------------------------------------

  createBaselineRelease(input: {
    workflowId: string;
    version?: number;
    createdBy?: string;
    label?: string;
  }): ReleaseManifest {
    const stored = this.store.getWorkflow(input.workflowId, input.version);
    if (!stored) {
      throw new PlatformError(`工作流「${input.workflowId}」不存在，请先保存 DSL。`, 404);
    }
    const existing = this.store.activeReleaseFor(input.workflowId);
    if (existing) {
      // 已有发布承接流量时把基线创建做成幂等操作，避免出现两个 active 版本。
      return existing;
    }
    const artifact = this.snapshotArtifact(stored.definition);
    return this.insertRelease({
      workflowId: input.workflowId,
      artifact,
      status: "active",
      origin: "baseline",
      label:
        input.label ??
        `${DEMO_WORKFLOW_LABEL[input.workflowId] ?? stored.definition.name} 基线 v${stored.definition.version}`,
      changeSummary: "从当前注册中心与工作流台账创建的只读基线。",
      createdBy: input.createdBy?.trim() || "system"
    });
  }

  listReleases(workflowId = "", limit = 100): ReleaseManifest[] {
    return this.store.listReleases(workflowId, limit);
  }

  getRelease(releaseId: string): ReleaseManifest {
    const manifest = this.store.getRelease(releaseId);
    if (!manifest) {
      throw new PlatformError(`发布「${releaseId}」不存在。`, 404);
    }
    return manifest;
  }

  /** 人工回滚：目标发布标记 rolled_back，父发布重新承接流量。 */
  rollbackRelease(releaseId: string, input: { reviewer?: string; reason?: string } = {}) {
    const manifest = this.getRelease(releaseId);
    if (!["active", "canary"].includes(manifest.status)) {
      throw new PlatformError(
        `只有生效中或金丝雀发布可以回滚，当前状态：${manifest.status}。`,
        409
      );
    }
    if (!manifest.parentReleaseId) {
      throw new PlatformError("基线发布没有父版本，不能回滚。", 409);
    }
    const parent = this.store.getRelease(manifest.parentReleaseId);
    if (!parent) {
      throw new PlatformError("父发布不存在，无法回滚。", 409);
    }
    const now = new Date().toISOString();
    this.store.updateReleaseStatus(manifest.id, "rolled_back", { retiredAt: now });
    this.store.updateReleaseStatus(parent.id, "active", { activatedAt: now });
    const rollout = this.store
      .listRollouts(manifest.workflowId, 50)
      .find((item) => item.releaseId === manifest.id && item.status === "canary");
    if (rollout) {
      this.store.updateRollout(rollout.id, {
        status: "rolled_back",
        rollbackReason: input.reason?.trim() || "人工回滚",
        finishedAt: now
      });
    }
    const event = this.store.appendLedgerEvent("release.rolled_back", "release", manifest.id, {
      from: manifest.id,
      to: parent.id,
      reviewer: input.reviewer ?? "system",
      reason: input.reason ?? "人工回滚"
    });
    this.raiseAlert({
      severity: "medium",
      kind: "system",
      entityType: "release",
      entityId: manifest.id,
      title: `人工回滚 ${manifest.label}`,
      detail: input.reason?.trim() || "未填写原因"
    });
    return { release: this.getRelease(manifest.id), restored: parent, ledgerSeq: event.seq };
  }

  // -------------------------------------------------------------------------
  // 候选与门禁
  // -------------------------------------------------------------------------

  createCandidate(input: CreateCandidateInput): EvolutionCandidate {
    if (!Array.isArray(input.changes) || input.changes.length === 0) {
      throw new PlatformError("候选至少需要一条变更。", 400);
    }
    const workflowId = input.workflowId?.trim();
    if (!workflowId) {
      throw new PlatformError("缺少 workflowId。", 400);
    }
    const base = input.baseReleaseId
      ? this.getRelease(input.baseReleaseId)
      : this.store.activeReleaseFor(workflowId) ?? this.createBaselineRelease({ workflowId });
    if (base.workflowId !== workflowId) {
      throw new PlatformError("基线发布与候选工作流不一致。", 400);
    }

    const title = input.title?.trim();
    if (!title) {
      throw new PlatformError("候选标题不能为空。", 400);
    }
    const changes = input.changes.map((change, index) => normalizeChange(change, index));
    const duplicate = this.store
      .listCandidates(workflowId, 100)
      .find(
        (candidate) =>
          candidate.baseReleaseId === base.id &&
          candidate.status !== "rejected" &&
          candidate.status !== "withdrawn" &&
          canonicalJson(candidate.changes) === canonicalJson(changes)
      );
    if (duplicate) {
      return duplicate;
    }

    const security = scanChanges(changes, {
      workflow: base.artifact.workflow,
      agents: base.artifact.agents,
      knownTools: new Set(this.store.listTools().map((tool) => tool.id))
    });

    const count = this.store.listCandidates(workflowId, 200).length + 1;
    const candidateId = `cand_${slug(workflowId)}_${String(count).padStart(4, "0")}_${shortHash(
      `${workflowId}:${title}:${canonicalJson(changes)}`,
      4
    )}`;
    const now = new Date().toISOString();
    let draftReleaseId: string | undefined;
    if (security.passed) {
      const applied = applyEvolutionChanges(
        base.artifact,
        changes,
        `演化候选 ${candidateId}（待门禁）`
      );
      const draft = this.insertRelease({
        workflowId,
        artifact: applied.artifact,
        artifactHash: applied.hash,
        status: "draft",
        origin: "promotion",
        label: `候选 ${title}`,
        changeSummary: summarize(changes),
        createdBy: input.proposedBy?.trim() || "system",
        parentReleaseId: base.id
      });
      draftReleaseId = draft.id;
    }

    const candidate: EvolutionCandidate = {
      id: candidateId,
      workflowId,
      baseReleaseId: base.id,
      source: input.source ?? "manual",
      title,
      summary: input.summary?.trim() ?? summarize(changes),
      changes,
      proposedBy: input.proposedBy?.trim() || "system",
      status: "draft",
      security,
      draftReleaseId,
      createdAt: now,
      updatedAt: now
    };
    this.store.saveCandidate(candidate);
    this.store.appendLedgerEvent("candidate.created", "candidate", candidate.id, {
      workflowId,
      baseReleaseId: base.id,
      source: candidate.source,
      changes: changes.map((change) => change.kind),
      securityPassed: security.passed
    });
    if (!security.passed) {
      this.store.updateCandidate(candidate.id, {
        status: "gate_failed",
        decisionComment: "安全扫描未通过，候选不进入评测。"
      });
      this.raiseAlert({
        severity: "high",
        kind: "security",
        entityType: "candidate",
        entityId: candidate.id,
        title: `候选被安全扫描拒绝：${candidate.title}`,
        detail: security.findings
          .filter((item) => item.severity === "critical" || item.severity === "high")
          .map((item) => item.message)
          .join("；")
      });
      return this.getCandidate(candidate.id);
    }
    return candidate;
  }

  /** 自循环在发布运行里发现的补丁：自动登记候选，不直接改注册表。 */
  createCandidateFromSelfLoop(signal: {
    workflowId: string;
    runId: string;
    agentId: string;
    patch: string;
    iteration: number;
    scoreBefore?: number;
    scoreAfter?: number;
    baseReleaseId?: string;
  }): EvolutionCandidate | undefined {
    if (!this.enabled()) {
      return undefined;
    }
    const base = signal.baseReleaseId
      ? this.store.getRelease(signal.baseReleaseId)
      : this.store.activeReleaseFor(signal.workflowId);
    if (!base) {
      return undefined;
    }
    const agent = base.artifact.agents.find((item) => item.id === signal.agentId);
    if (!agent) {
      return undefined;
    }
    return this.createCandidate({
      workflowId: signal.workflowId,
      baseReleaseId: base.id,
      title: `自循环补丁 ${agent.name} · 第 ${signal.iteration} 轮`,
      summary: `运行 ${signal.runId} 的验证分 ${formatScore(signal.scoreBefore)} → ${formatScore(
        signal.scoreAfter
      )}；补丁需通过离线回归门禁后才能进入人工审批。`,
      source: "self_loop",
      proposedBy: `self-loop:${signal.runId}`,
      changes: [
        {
          id: `chg_${randomUUID()}`,
          kind: "prompt_patch",
          target: signal.agentId,
          before: agent.prompt,
          after: signal.patch,
          rationale: `模型诊断在第 ${signal.iteration} 轮提出，验证分提升 ${formatScore(
            signal.scoreBefore
          )} → ${formatScore(signal.scoreAfter)}。单次运行提升不能作为长期有效证据。`
        }
      ]
    });
  }

  getCandidate(candidateId: string): EvolutionCandidate {
    const candidate = this.store.getCandidate(candidateId);
    if (!candidate) {
      throw new PlatformError(`候选「${candidateId}」不存在。`, 404);
    }
    return candidate;
  }

  listCandidates(workflowId = "", limit = 50): EvolutionCandidate[] {
    return this.store.listCandidates(workflowId, limit);
  }

  listEvaluationRuns(candidateId = "", limit = 50): EvaluationRun[] {
    return this.store.listEvaluationRuns(candidateId, limit);
  }

  async runGate(candidateId: string, request: GateRequest = {}) {
    const candidate = this.getCandidate(candidateId);
    if (candidate.status === "promoted") {
      throw new PlatformError("候选已晋升，不能重复门禁。", 409);
    }
    if (candidate.status === "rejected") {
      throw new PlatformError("候选已被拒绝，如需重试请新建候选。", 409);
    }
    if (!candidate.security?.passed) {
      const security =
        candidate.security ??
        scanChanges(candidate.changes, {
          workflow: this.getRelease(candidate.baseReleaseId).artifact.workflow,
          agents: this.getRelease(candidate.baseReleaseId).artifact.agents,
          knownTools: new Set(this.store.listTools().map((tool) => tool.id))
        });
      this.store.updateCandidate(candidate.id, {
        status: "gate_failed",
        security,
        decisionComment: "安全扫描未通过，候选不进入评测。"
      });
      throw new PlatformError("安全扫描未通过，不能进入离线门禁。", 409);
    }
    if (!candidate.draftReleaseId) {
      throw new PlatformError("候选缺少草稿发布，无法评测。", 409);
    }
    const mode = request.mode ?? envGateMode();
    const executor = this.executorFor(mode);
    const dataset = this.datasetFor(candidate.workflowId, request.datasetId);
    const base = this.getRelease(candidate.baseReleaseId);
    const draft = this.getRelease(candidate.draftReleaseId);
    const policy: GatePolicy = {
      ...DEFAULT_GATE_POLICY,
      ...request.policy,
      targetCaseIds: request.policy?.targetCaseIds ?? DEFAULT_GATE_POLICY.targetCaseIds
    };
    const evalRunId = `eval_${candidate.id}_${this.store.listEvaluationRuns(candidate.id, 100).length + 1}`;
    const startedAt = new Date().toISOString();
    this.store.saveEvaluationRun({
      id: evalRunId,
      candidateId: candidate.id,
      datasetId: dataset.id,
      baseReleaseId: base.id,
      candidateReleaseId: draft.id,
      mode,
      status: "running",
      startedAt
    });
    this.store.updateCandidate(candidate.id, { status: "gating", evalRunId });
    this.store.appendLedgerEvent("candidate.gating", "candidate", candidate.id, {
      evalRunId,
      mode,
      datasetId: dataset.id
    });

    try {
      const { evaluationRun, decision } = await evaluateGate({
        store: this.store,
        executor,
        dataset,
        base,
        candidate: draft,
        candidateId: candidate.id,
        evalRunId,
        mode,
        policy,
        maxCases: request.maxCases ?? envNumber("PLATFORM_EVOLUTION_GATE_MAX_CASES", 6)
      });
      this.store.saveEvaluationRun(evaluationRun);
      const updated = this.store.updateCandidate(candidate.id, {
        status: decision.passed ? "gate_passed" : "gate_failed",
        gate: decision
      });
      this.store.appendLedgerEvent(
        decision.passed ? "candidate.gate_passed" : "candidate.gate_failed",
        "candidate",
        candidate.id,
        {
          evalRunId,
          mode,
          meanDelta: decision.stats.meanDelta,
          ciLow: decision.stats.ciLow,
          reasons: decision.reasons
        }
      );
      if (!decision.passed) {
        this.raiseAlert({
          severity: "medium",
          kind: "gate",
          entityType: "candidate",
          entityId: candidate.id,
          title: `门禁拒绝：${candidate.title}`,
          detail: decision.reasons.join("；")
        });
      }
      return { candidate: updated ?? this.getCandidate(candidate.id), evaluationRun, decision };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.saveEvaluationRun({
        id: evalRunId,
        candidateId: candidate.id,
        datasetId: dataset.id,
        baseReleaseId: base.id,
        candidateReleaseId: draft.id,
        mode,
        status: "error",
        error: message,
        startedAt,
        finishedAt: new Date().toISOString()
      });
      this.store.updateCandidate(candidate.id, {
        status: "gate_failed",
        decisionComment: `评测异常：${message}`
      });
      throw error;
    }
  }

  approveCandidate(candidateId: string, input: { reviewer?: string; comment?: string }) {
    const reviewer = input.reviewer?.trim();
    if (!reviewer) {
      throw new PlatformError("人工批准必须填写 reviewer。", 400);
    }
    const candidate = this.getCandidate(candidateId);
    if (candidate.status !== "gate_passed") {
      throw new PlatformError(
        `只有门禁通过的候选可以批准，当前状态：${candidate.status}。`,
        409
      );
    }
    const updated = this.store.updateCandidate(candidate.id, {
      status: "approved",
      decidedAt: new Date().toISOString(),
      decidedBy: reviewer,
      decisionComment: input.comment?.trim()
    });
    this.store.appendLedgerEvent("candidate.approved", "candidate", candidate.id, {
      reviewer,
      comment: input.comment?.trim() ?? ""
    });
    return updated!;
  }

  rejectCandidate(candidateId: string, input: { reviewer?: string; comment?: string }) {
    const candidate = this.getCandidate(candidateId);
    if (candidate.status === "promoted") {
      throw new PlatformError("候选已晋升，不能再拒绝。", 409);
    }
    const updated = this.store.updateCandidate(candidate.id, {
      status: "rejected",
      decidedAt: new Date().toISOString(),
      decidedBy: input.reviewer?.trim() || "system",
      decisionComment: input.comment?.trim()
    });
    this.store.appendLedgerEvent("candidate.rejected", "candidate", candidate.id, {
      reviewer: input.reviewer?.trim() || "system",
      comment: input.comment?.trim() ?? ""
    });
    return updated!;
  }

  /**
   * 晋升必须满足两个条件：门禁通过 + 已人工批准。
   * percent > 0 时先进入金丝雀，不直接全量；金丝雀晋升同样需要人工操作。
   */
  promoteCandidate(
    candidateId: string,
    input: { reviewer?: string; comment?: string; canaryPercent?: number } = {}
  ) {
    const reviewer = input.reviewer?.trim();
    if (!reviewer) {
      throw new PlatformError("晋升必须由人工确认，请填写 reviewer。", 400);
    }
    const candidate = this.getCandidate(candidateId);
    if (candidate.status !== "approved") {
      throw new PlatformError(
        `候选必须先通过门禁并人工批准，当前状态：${candidate.status}。`,
        409
      );
    }
    if (!candidate.draftReleaseId) {
      throw new PlatformError("候选缺少草稿发布。", 409);
    }
    const draft = this.getRelease(candidate.draftReleaseId);
    const base = this.getRelease(candidate.baseReleaseId);
    const percent = clampPercent(
      input.canaryPercent ?? envNumber("PLATFORM_EVOLUTION_CANARY_PERCENT", 10)
    );
    const now = new Date().toISOString();
    const release = this.insertRelease({
      workflowId: candidate.workflowId,
      artifact: draft.artifact,
      artifactHash: draft.artifactHash,
      status: percent > 0 ? "canary" : "active",
      origin: "promotion",
      label: `${DEMO_WORKFLOW_LABEL[candidate.workflowId] ?? candidate.workflowId} · ${candidate.title}`,
      changeSummary: candidate.summary,
      createdBy: reviewer,
      parentReleaseId: base.id,
      candidateId: candidate.id
    });

    let rollout: ReleaseRollout | undefined;
    if (percent > 0) {
      // 基线保持 active 作为对照臂；候选以 canary 状态接收 percent% 流量。
      rollout = this.store.saveRollout({
        id: `roll_${slug(candidate.workflowId)}_${release.version}`,
        workflowId: candidate.workflowId,
        releaseId: release.id,
        baseReleaseId: base.id,
        percent,
        status: "canary",
        minSamplesPerArm: Math.max(
          1,
          Math.trunc(envNumber("PLATFORM_EVOLUTION_MIN_SAMPLES", 3))
        ),
        maxErrorRateDelta: envNumber("PLATFORM_EVOLUTION_MAX_ERROR_DELTA", 0.05),
        maxScoreDrop: envNumber("PLATFORM_EVOLUTION_MAX_SCORE_DROP", 0.05),
        createdBy: reviewer,
        createdAt: now,
        updatedAt: now
      });
      this.store.appendLedgerEvent("rollout.started", "rollout", rollout.id, {
        releaseId: release.id,
        baseReleaseId: base.id,
        percent
      });
    } else {
      // 全量晋升：当前 active/canary 全部归档，确保同一工作流只有一个 active。
      for (const current of this.store.listReleases(candidate.workflowId, 200)) {
        if (current.id !== release.id && ["active", "canary"].includes(current.status)) {
          this.store.updateReleaseStatus(current.id, "archived", { retiredAt: now });
        }
      }
      const stale = this.store
        .listRollouts(candidate.workflowId, 50)
        .find((item) => item.status === "canary");
      if (stale) {
        this.store.updateRollout(stale.id, {
          status: "stopped",
          rollbackReason: "被全量晋升替代",
          finishedAt: now
        });
      }
    }

    this.store.updateCandidate(candidate.id, {
      status: "promoted",
      promotedReleaseId: release.id,
      decidedAt: now,
      decidedBy: reviewer,
      decisionComment: input.comment?.trim()
    });
    this.store.appendLedgerEvent("candidate.promoted", "candidate", candidate.id, {
      releaseId: release.id,
      reviewer,
      canaryPercent: percent
    });
    this.store.appendLedgerEvent("release.activated", "release", release.id, {
      from: base.id,
      status: release.status,
      candidateId: candidate.id
    });
    return { candidate: this.getCandidate(candidate.id), release: this.getRelease(release.id), rollout };
  }

  // -------------------------------------------------------------------------
  // 金丝雀与护栏
  // -------------------------------------------------------------------------

  /** 内部运行入口：显式发布优先，其次活跃金丝雀，再次当前生效发布。 */
  pickRelease(workflowId: string, assignmentKey?: string): RunReleasePick | undefined {
    if (!this.enabled()) {
      return undefined;
    }
    const key = assignmentKey?.trim() || randomUUID();
    const rollout = this.store.activeRolloutFor(workflowId);
    if (rollout) {
      const treatment = trafficBucket(key) < rollout.percent;
      return {
        releaseId: treatment ? rollout.releaseId : rollout.baseReleaseId,
        baseReleaseId: rollout.baseReleaseId,
        experimentId: rollout.id,
        arm: treatment ? "treatment" : "control",
        rolloutId: rollout.id,
        assignmentKey: key
      };
    }
    const active = this.store.activeReleaseFor(workflowId);
    if (!active) {
      return undefined;
    }
    return {
      releaseId: active.id,
      arm: "treatment",
      assignmentKey: key
    };
  }

  recordAssignment(runId: string, pick: RunReleasePick, workflowId: string) {
    const assignment: RunReleaseAssignment = {
      runId,
      workflowId,
      releaseId: pick.releaseId,
      baseReleaseId: pick.baseReleaseId,
      experimentId: pick.experimentId,
      arm: pick.arm,
      rolloutId: pick.rolloutId,
      assignmentKey: pick.assignmentKey,
      createdAt: new Date().toISOString()
    };
    this.store.saveAssignment(assignment);
    return assignment;
  }

  /** 运行结束后记录一条观测；达到最小样本后自动判定金丝雀护栏。 */
  observeRun(runId: string) {
    const run = this.store.getRun(runId);
    const assignment = this.store.getAssignment(runId);
    if (!run || !assignment?.rolloutId) {
      return undefined;
    }
    const verify = this.store.listVerifyResults(runId).at(-1);
    const observation = this.store.recordObservation({
      id: newId("obs"),
      rolloutId: assignment.rolloutId,
      runId,
      arm: assignment.arm,
      workflowId: run.workflowId,
      releaseId: assignment.releaseId,
      status: run.status,
      passed: run.status === "succeeded" && (verify?.score ?? 0) >= 0.7,
      score: verify?.score,
      durationMs: run.durationMs,
      tokens: this.store
        .listSteps(runId)
        .reduce((sum, step) => sum + roughTokens(step.input) + roughTokens(step.output), 0),
      createdAt: new Date().toISOString()
    });
    const rollout = this.store.getRollout(assignment.rolloutId);
    if (rollout && rollout.status === "canary") {
      this.checkGuardrails(rollout.id);
    }
    return observation;
  }

  checkGuardrails(rolloutId: string) {
    const rollout = this.store.getRollout(rolloutId);
    if (!rollout || rollout.status !== "canary") {
      return undefined;
    }
    const observations = this.store.listObservations(rolloutId);
    const control = observations.filter((item) => item.arm === "control");
    const treatment = observations.filter((item) => item.arm === "treatment");
    if (control.length < rollout.minSamplesPerArm || treatment.length < rollout.minSamplesPerArm) {
      return { status: "collecting", control: control.length, treatment: treatment.length };
    }

    const controlErrors = control.filter((item) => item.status !== "succeeded").length / control.length;
    const treatmentErrors =
      treatment.filter((item) => item.status !== "succeeded").length / treatment.length;
    const controlScores = control
      .map((item) => item.score)
      .filter((score): score is number => typeof score === "number");
    const treatmentScores = treatment
      .map((item) => item.score)
      .filter((score): score is number => typeof score === "number");
    const controlMean = average(controlScores);
    const treatmentMean = average(treatmentScores);
    const reasons: string[] = [];
    if (treatmentErrors - controlErrors > rollout.maxErrorRateDelta) {
      reasons.push(
        `失败率 ${(treatmentErrors * 100).toFixed(1)}% 比对照 ${(controlErrors * 100).toFixed(1)}% 高 ${(
          (treatmentErrors - controlErrors) * 100
        ).toFixed(1)} 个百分点`
      );
    }
    if (
      controlScores.length > 0 &&
      treatmentScores.length > 0 &&
      treatmentMean < controlMean - rollout.maxScoreDrop
    ) {
      reasons.push(
        `平均验证分 ${treatmentMean.toFixed(3)} 比对照 ${controlMean.toFixed(3)} 低 ${(
          controlMean - treatmentMean
        ).toFixed(3)}`
      );
    }
    if (reasons.length > 0) {
      return this.autoRollback(rollout, reasons.join("；"), {
        control: control.length,
        treatment: treatment.length,
        controlMean: round4(controlMean),
        treatmentMean: round4(treatmentMean)
      });
    }

    // 未越界时只提示"可人工晋升"，不自动晋升，人工批准仍是硬门槛。
    const existing = this.store
      .listAlerts({ limit: 100 })
      .find(
        (alert) =>
          alert.entityId === rollout.id && alert.title === "金丝雀已收集足够样本，等待人工晋升"
      );
    if (!existing) {
      this.raiseAlert({
        severity: "low",
        kind: "guardrail",
        entityType: "rollout",
        entityId: rollout.id,
        title: "金丝雀已收集足够样本，等待人工晋升",
        detail: `对照 ${control.length} 次 / 候选 ${treatment.length} 次，未触发回滚护栏。`
      });
    }
    return {
      status: "healthy",
      control: control.length,
      treatment: treatment.length,
      controlMean: round4(controlMean),
      treatmentMean: round4(treatmentMean)
    };
  }

  promoteRollout(rolloutId: string, input: { reviewer?: string }) {
    const reviewer = input.reviewer?.trim();
    if (!reviewer) {
      throw new PlatformError("结束金丝雀必须由人工确认，请填写 reviewer。", 400);
    }
    const rollout = this.store.getRollout(rolloutId);
    if (!rollout || rollout.status !== "canary") {
      throw new PlatformError("金丝雀不存在或已结束。", 409);
    }
    const observations = this.store.listObservations(rolloutId);
    const treatment = observations.filter((item) => item.arm === "treatment").length;
    if (treatment < rollout.minSamplesPerArm) {
      throw new PlatformError(
        `候选臂样本 ${treatment} 次，少于 ${rollout.minSamplesPerArm} 次，不能晋升。`,
        409
      );
    }
    const now = new Date().toISOString();
    this.store.updateReleaseStatus(rollout.baseReleaseId, "archived", { retiredAt: now });
    this.store.updateReleaseStatus(rollout.releaseId, "active", { activatedAt: now });
    const updated = this.store.updateRollout(rolloutId, {
      status: "promoted",
      percent: 100,
      finishedAt: now
    });
    this.store.appendLedgerEvent("rollout.promoted", "rollout", rolloutId, {
      releaseId: rollout.releaseId,
      reviewer
    });
    return { rollout: updated, release: this.getRelease(rollout.releaseId) };
  }

  stopRollout(rolloutId: string, input: { reviewer?: string; reason?: string } = {}) {
    const rollout = this.store.getRollout(rolloutId);
    if (!rollout || rollout.status !== "canary") {
      throw new PlatformError("金丝雀不存在或已结束。", 409);
    }
    const now = new Date().toISOString();
    this.store.updateReleaseStatus(rollout.releaseId, "rolled_back", { retiredAt: now });
    this.store.updateReleaseStatus(rollout.baseReleaseId, "active", { activatedAt: now });
    const updated = this.store.updateRollout(rolloutId, {
      status: "rolled_back",
      rollbackReason: input.reason?.trim() || "人工停止",
      finishedAt: now
    });
    this.store.appendLedgerEvent("rollout.rolled_back", "rollout", rolloutId, {
      releaseId: rollout.releaseId,
      reviewer: input.reviewer ?? "system",
      reason: input.reason ?? "人工停止",
      automatic: false
    });
    return { rollout: updated, release: this.getRelease(rollout.baseReleaseId) };
  }

  private autoRollback(
    rollout: ReleaseRollout,
    reason: string,
    metrics: Record<string, unknown>
  ) {
    const now = new Date().toISOString();
    this.store.updateRollout(rollout.id, {
      status: "rolled_back",
      rollbackReason: reason,
      finishedAt: now
    });
    this.store.updateReleaseStatus(rollout.releaseId, "rolled_back", { retiredAt: now });
    this.store.updateReleaseStatus(rollout.baseReleaseId, "active", { activatedAt: now });
    this.store.appendLedgerEvent("rollout.rolled_back", "rollout", rollout.id, {
      releaseId: rollout.releaseId,
      restored: rollout.baseReleaseId,
      reason,
      automatic: true,
      metrics
    });
    this.raiseAlert({
      severity: "critical",
      kind: "guardrail",
      entityType: "rollout",
      entityId: rollout.id,
      title: "金丝雀护栏越界，已自动回滚",
      detail: reason
    });
    const candidate = this.store
      .listCandidates(rollout.workflowId, 100)
      .find((item) => item.promotedReleaseId === rollout.releaseId);
    if (candidate) {
      this.store.updateCandidate(candidate.id, {
        decisionComment: `金丝雀自动回滚：${reason}`
      });
    }
    return { status: "rolled_back", reason, metrics, restored: rollout.baseReleaseId };
  }

  // -------------------------------------------------------------------------
  // 数据集 / 概览
  // -------------------------------------------------------------------------

  datasetFor(workflowId: string, datasetId?: string): EvaluationDataset {
    if (datasetId) {
      const dataset = this.store.getDataset(datasetId);
      if (!dataset || dataset.workflowId !== workflowId) {
        throw new PlatformError(`回归集「${datasetId}」不存在或不属于该工作流。`, 404);
      }
      return dataset;
    }
    const dataset = this.store.listDatasets(workflowId)[0];
    if (!dataset) {
      throw new PlatformError(
        `工作流「${workflowId}」还没有固定回归集，请先通过 POST /api/evolution/datasets 导入。`,
        400
      );
    }
    return dataset;
  }

  listDatasets(workflowId = ""): EvaluationDataset[] {
    return this.store.listDatasets(workflowId);
  }

  saveDataset(input: {
    id?: string;
    workflowId: string;
    name: string;
    description?: string;
    cases: EvaluationDataset["cases"];
  }): EvaluationDataset {
    if (!this.store.getWorkflow(input.workflowId)) {
      throw new PlatformError(`工作流「${input.workflowId}」不存在。`, 404);
    }
    if (!Array.isArray(input.cases) || input.cases.length === 0) {
      throw new PlatformError("回归集至少需要一个用例。", 400);
    }
    const cases = input.cases.map((item, index) => {
      if (!item.id || !isRecord(item.input)) {
        throw new PlatformError(`cases[${index}] 需要 id 与 input 对象。`, 400);
      }
      return {
        id: item.id,
        datasetId: input.id ?? `evalset_${slug(input.workflowId)}_${shortHash(input.name, 4)}`,
        title: item.title ?? item.id,
        input: item.input,
        expected: item.expected ?? {},
        rubric: Array.isArray(item.rubric) ? item.rubric : [],
        threshold: typeof item.threshold === "number" ? item.threshold : 0.8,
        tags: Array.isArray(item.tags) ? item.tags : []
      };
    });
    const existing = input.id ? this.store.getDataset(input.id) : undefined;
    const dataset: EvaluationDataset = {
      id: input.id ?? `evalset_${slug(input.workflowId)}_${shortHash(input.name, 4)}`,
      workflowId: input.workflowId,
      name: input.name,
      version: existing ? existing.version + 1 : 1,
      description: input.description ?? "",
      cases,
      createdAt: existing?.createdAt ?? new Date().toISOString()
    };
    return this.store.saveDataset(dataset);
  }

  listRollouts(workflowId = "", limit = 50): ReleaseRollout[] {
    return this.store.listRollouts(workflowId, limit);
  }

  listObservations(rolloutId: string) {
    return this.store.listObservations(rolloutId);
  }

  listAlerts(options: { acknowledged?: boolean; limit?: number } = {}): EvolutionAlert[] {
    return this.store.listAlerts(options);
  }

  acknowledgeAlert(id: string) {
    return this.store.acknowledgeAlert(id);
  }

  listLedger(limit = 200) {
    return this.store.listLedger(limit);
  }

  verifyLedger() {
    return this.store.verifyLedger();
  }

  overview() {
    const releases = this.store.listReleases("", 500);
    const candidates = this.store.listCandidates("", 200);
    const rollouts = this.store.listRollouts("", 200);
    return {
      enabled: this.enabled(),
      releases: {
        total: releases.length,
        active: releases.filter((item) => item.status === "active").length,
        canary: releases.filter((item) => item.status === "canary").length,
        byWorkflow: groupCount(releases, (item) => item.workflowId)
      },
      candidates: {
        total: candidates.length,
        byStatus: groupCount(candidates, (item) => item.status)
      },
      rollouts: {
        total: rollouts.length,
        canary: rollouts.filter((item) => item.status === "canary").length,
        rolledBack: rollouts.filter((item) => item.status === "rolled_back").length
      },
      alerts: {
        open: this.store.listAlerts({ acknowledged: false, limit: 200 }).length
      },
      ledger: this.store.verifyLedger()
    };
  }

  // -------------------------------------------------------------------------
  // 内部构造
  // -------------------------------------------------------------------------

  private executorFor(mode: "stub" | "live"): WorkflowExecutor {
    if (mode === "live") {
      if (!this.liveExecutor) {
        throw new PlatformError("当前进程没有接入真实模型执行器，不能运行 live 门禁。", 400);
      }
      return this.liveExecutor;
    }
    if (!this.stubExecutor) {
      throw new PlatformError("演化服务缺少 stub 执行器。", 500);
    }
    return this.stubExecutor;
  }

  private snapshotArtifact(workflow: WorkflowDefinition): ReleaseArtifact {
    const workflows: WorkflowDefinition[] = [];
    const visited = new Set<string>();
    const visit = (definition: WorkflowDefinition) => {
      if (visited.has(definition.id)) {
        return;
      }
      visited.add(definition.id);
      workflows.push(clone(definition));
      for (const node of definition.nodes) {
        if (node.kind !== "subworkflow") {
          continue;
        }
        const child = this.store.getWorkflow(node.workflowId, node.workflowVersion)?.definition;
        if (!child) {
          throw new PlatformError(
            `子工作流「${node.workflowId}」未能解析，无法创建发布快照。`,
            400
          );
        }
        visit(child);
      }
    };
    visit(workflow);
    const agents: AgentRecord[] = this.store.listAgents().map((agent) => clone(agent));
    const artifact: ReleaseArtifact = {
      workflow: workflows.find((item) => item.id === workflow.id) ?? clone(workflow),
      workflows,
      agents
    };
    return artifact;
  }

  private insertRelease(input: {
    workflowId: string;
    artifact: ReleaseArtifact;
    artifactHash?: string;
    status: ReleaseManifest["status"];
    origin: ReleaseManifest["origin"];
    label: string;
    changeSummary: string;
    createdBy: string;
    parentReleaseId?: string;
    candidateId?: string;
  }): ReleaseManifest {
    const version = this.store.nextReleaseVersion(input.workflowId);
    const now = new Date().toISOString();
    const manifest: ReleaseManifest = {
      id: `rel_${slug(input.workflowId)}_v${version}_${shortHash(
        `${input.workflowId}:${version}:${input.label}:${canonicalJson(input.artifact)}`,
        6
      )}`,
      workflowId: input.workflowId,
      version,
      label: input.label,
      status: input.status,
      origin: input.origin,
      parentReleaseId: input.parentReleaseId,
      candidateId: input.candidateId,
      artifact: input.artifact,
      artifactHash: input.artifactHash ?? sha256(canonicalJson(input.artifact)),
      changeSummary: input.changeSummary,
      createdBy: input.createdBy,
      createdAt: now,
      activatedAt: input.status === "active" ? now : undefined
    };
    this.store.saveRelease(manifest);
    this.store.appendLedgerEvent(
      input.status === "active" ? "release.activated" : "release.created",
      "release",
      manifest.id,
      {
        workflowId: manifest.workflowId,
        version: manifest.version,
        status: manifest.status,
        origin: manifest.origin,
        artifactHash: manifest.artifactHash,
        parentReleaseId: manifest.parentReleaseId
      }
    );
    return manifest;
  }

  private raiseAlert(input: Omit<EvolutionAlert, "id" | "acknowledged" | "createdAt">) {
    return this.store.appendAlert({
      ...input,
      id: newId("alert"),
      acknowledged: false,
      createdAt: new Date().toISOString()
    });
  }
}

function normalizeChange(change: EvolutionChange, index: number): EvolutionChange {
  if (!change || typeof change !== "object") {
    throw new PlatformError(`changes[${index}] 必须是对象。`, 400);
  }
  const kinds = ["prompt_patch", "model_route", "tool_policy", "agent_swap", "workflow_path"];
  if (!kinds.includes(change.kind)) {
    throw new PlatformError(`changes[${index}].kind 不支持：${change.kind}`, 400);
  }
  const target = typeof change.target === "string" ? change.target.trim() : "";
  if (!target) {
    throw new PlatformError(`changes[${index}].target 不能为空。`, 400);
  }
  const after = typeof change.after === "string" ? change.after : "";
  if (!after.trim()) {
    throw new PlatformError(`changes[${index}].after 不能为空。`, 400);
  }
  return {
    id: change.id?.trim() || `chg_${randomUUID()}`,
    kind: change.kind,
    target,
    before: typeof change.before === "string" ? change.before : "",
    after,
    rationale: typeof change.rationale === "string" ? change.rationale : undefined
  };
}

function summarize(changes: EvolutionChange[]) {
  return changes
    .map((change) => `${change.kind} → ${change.target}`)
    .join("；")
    .slice(0, 240);
}

function envGateMode(): "stub" | "live" {
  return process.env.PLATFORM_EVOLUTION_GATE_MODE?.trim() === "live" ? "live" : "stub";
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.trunc(value)));
}

function average(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roughTokens(value: unknown) {
  if (value === undefined) {
    return 0;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(text.length / 2);
}

function formatScore(value: number | undefined) {
  return typeof value === "number" ? value.toFixed(3) : "—";
}

function groupCount<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
