import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  FlaskConical,
  GitBranch,
  Layers,
  Loader2,
  RefreshCw,
  Rocket,
  ScrollText,
  ShieldCheck,
  Undo2,
  XCircle
} from "lucide-react";
import { platformApi } from "./api";
import type {
  EvolutionAlert,
  EvolutionCandidate,
  EvolutionDataset,
  EvolutionLedger,
  EvolutionOverview,
  EvolutionRelease,
  EvolutionRollout,
  WorkflowSummary
} from "./types";
import "./platform.css";

const CANDIDATE_STATUS_LABEL: Record<EvolutionCandidate["status"], string> = {
  draft: "待门禁",
  gating: "门禁中",
  gate_passed: "门禁通过",
  gate_failed: "门禁拒绝",
  approved: "已批准",
  rejected: "已拒绝",
  promoted: "已晋升",
  withdrawn: "已撤回"
};

const RELEASE_STATUS_LABEL: Record<EvolutionRelease["status"], string> = {
  draft: "草稿",
  active: "生效中",
  canary: "金丝雀",
  rolled_back: "已回滚",
  archived: "已归档"
};

const ROLLOUT_STATUS_LABEL: Record<EvolutionRollout["status"], string> = {
  canary: "灰度中",
  promoted: "已全量",
  rolled_back: "已回滚",
  stopped: "已停止"
};

function toneOf(value: string): string {
  if (["active", "gate_passed", "approved", "promoted", "succeeded", "canary"].includes(value)) {
    return "good";
  }
  if (["failed", "gate_failed", "rejected", "rolled_back", "critical", "high"].includes(value)) {
    return "bad";
  }
  if (["gating", "draft", "medium", "canary"].includes(value)) {
    return "warn";
  }
  return "idle";
}

function shortHash(value: string): string {
  return value.slice(0, 10);
}

function formatTime(value?: string): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function formatScore(value?: number): string {
  return typeof value === "number" ? value.toFixed(3) : "—";
}

function preferredWorkflowId(workflows: WorkflowSummary[]): string {
  return (
    workflows.find((workflow) => workflow.id === "business-analysis-v1")?.id ??
    workflows.find((workflow) => workflow.id === "classroom-v1")?.id ??
    workflows[0]?.id ??
    ""
  );
}

export function EvolutionPage() {
  const [overview, setOverview] = useState<EvolutionOverview | undefined>();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [releases, setReleases] = useState<EvolutionRelease[]>([]);
  const [candidates, setCandidates] = useState<EvolutionCandidate[]>([]);
  const [rollouts, setRollouts] = useState<EvolutionRollout[]>([]);
  const [alerts, setAlerts] = useState<EvolutionAlert[]>([]);
  const [ledger, setLedger] = useState<EvolutionLedger | undefined>();
  const [datasets, setDatasets] = useState<EvolutionDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [expandedCandidate, setExpandedCandidate] = useState<string | undefined>();
  const [baselineWorkflow, setBaselineWorkflow] = useState("");
  const [candidateForm, setCandidateForm] = useState({
    workflowId: "",
    baseReleaseId: "",
    title: "",
    kind: "prompt_patch" as EvolutionCandidate["changes"][number]["kind"],
    target: "",
    after: "",
    rationale: ""
  });
  const [canaryPercent, setCanaryPercent] = useState(10);
  const [gateMode, setGateMode] = useState<"stub" | "live">("stub");

  async function load(silent = false) {
    if (!silent) {
      setLoading(true);
    }
    try {
      const [
        nextOverview,
        workflowList,
        releaseList,
        candidateList,
        rolloutList,
        alertList,
        ledgerView,
        datasetList
      ] = await Promise.all([
        platformApi.evolution.overview(),
        platformApi.listWorkflows(),
        platformApi.evolution.releases(),
        platformApi.evolution.candidates(),
        platformApi.evolution.rollouts(),
        platformApi.evolution.alerts(),
        platformApi.evolution.ledger(40),
        platformApi.evolution.datasets()
      ]);
      setOverview(nextOverview);
      setWorkflows(workflowList.workflows);
      setReleases(releaseList.releases);
      setCandidates(candidateList.candidates);
      setRollouts(rolloutList.rollouts);
      setAlerts(alertList.alerts);
      setLedger(ledgerView);
      setDatasets(datasetList.datasets);
      setError("");
      setBaselineWorkflow((current) => current || preferredWorkflowId(workflowList.workflows));
      setCandidateForm((current) => ({
        ...current,
        workflowId: current.workflowId || preferredWorkflowId(workflowList.workflows)
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "演化控制面读取失败。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const activeReleases = useMemo(
    () => releases.filter((release) => release.status === "active"),
    [releases]
  );
  const canaryReleases = useMemo(
    () => releases.filter((release) => release.status === "canary"),
    [releases]
  );
  const openAlerts = useMemo(() => alerts.filter((alert) => !alert.acknowledged), [alerts]);
  const workflowName = (workflowId: string) =>
    workflows.find((workflow) => workflow.id === workflowId)?.name ?? workflowId;

  const formReleases = useMemo(
    () =>
      releases.filter(
        (release) =>
          release.workflowId === candidateForm.workflowId &&
          (release.status === "active" || release.status === "canary")
      ),
    [releases, candidateForm.workflowId]
  );

  async function act(label: string, run: () => Promise<void>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await run();
      await load(true);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "操作失败。");
    } finally {
      setBusy("");
    }
  }

  function requireReviewer(): string | undefined {
    const value = reviewer.trim();
    if (!value) {
      setError("请先在右上角填写审批人，再执行批准、晋升或回滚。");
      return undefined;
    }
    return value;
  }

  async function createBaseline() {
    if (!baselineWorkflow) {
      setError("请选择工作流。");
      return;
    }
    await act("baseline", async () => {
      const result = await platformApi.evolution.createBaseline({
        workflowId: baselineWorkflow,
        createdBy: reviewer.trim() || "system"
      });
      setNotice(`已建立基线发布：${result.release.label}`);
    });
  }

  async function createCandidate() {
    const title = candidateForm.title.trim();
    const target = candidateForm.target.trim();
    const after = candidateForm.after.trim();
    if (!candidateForm.workflowId || !title || !target || !after) {
      setError("新建候选需要工作流、标题、变更目标与变更后内容。");
      return;
    }
    await act("candidate", async () => {
      const result = await platformApi.evolution.createCandidate({
        workflowId: candidateForm.workflowId,
        baseReleaseId: candidateForm.baseReleaseId || undefined,
        title,
        source: "manual",
        proposedBy: reviewer.trim() || "system",
        changes: [
          {
            kind: candidateForm.kind,
            target,
            before: "",
            after,
            rationale: candidateForm.rationale.trim() || undefined
          }
        ]
      });
      setNotice(
        result.candidate.security?.passed === false
          ? `候选被安全扫描拒绝：${result.candidate.security.findings.map((item) => item.message).join("；")}`
          : `候选已建立：${result.candidate.id}`
      );
      setCandidateForm((current) => ({ ...current, title: "", target: "", after: "", rationale: "" }));
      setExpandedCandidate(result.candidate.id);
    });
  }

  async function runGate(candidate: EvolutionCandidate) {
    await act(`gate:${candidate.id}`, async () => {
      const result = await platformApi.evolution.gate(candidate.id, { mode: gateMode });
      setExpandedCandidate(candidate.id);
      setNotice(
        result.decision.passed
          ? `门禁通过：平均分变化 ${result.decision.stats.meanDelta.toFixed(3)}，等待人工批准。`
          : `门禁拒绝：${result.decision.reasons.join("；")}`
      );
    });
  }

  async function approve(candidate: EvolutionCandidate) {
    const value = requireReviewer();
    if (!value) {
      return;
    }
    await act(`approve:${candidate.id}`, async () => {
      await platformApi.evolution.approve(candidate.id, { reviewer: value });
      setNotice(`候选已人工批准：${candidate.title}`);
    });
  }

  async function reject(candidate: EvolutionCandidate) {
    await act(`reject:${candidate.id}`, async () => {
      await platformApi.evolution.reject(candidate.id, {
        reviewer: reviewer.trim() || "system",
        comment: "人工评审拒绝"
      });
      setNotice(`候选已拒绝：${candidate.title}`);
    });
  }

  async function promote(candidate: EvolutionCandidate) {
    const value = requireReviewer();
    if (!value) {
      return;
    }
    await act(`promote:${candidate.id}`, async () => {
      const result = await platformApi.evolution.promote(candidate.id, {
        reviewer: value,
        canaryPercent
      });
      setNotice(
        result.rollout
          ? `已进入金丝雀：${result.rollout.percent}% 流量走候选，护栏自动回滚已启用。`
          : "已全量晋升，旧版本归档。"
      );
    });
  }

  async function rollbackRelease(release: EvolutionRelease) {
    const value = requireReviewer();
    if (!value) {
      return;
    }
    await act(`rollback:${release.id}`, async () => {
      await platformApi.evolution.rollbackRelease(release.id, {
        reviewer: value,
        reason: "演化中心人工回滚"
      });
      setNotice(`已回滚到父版本：${release.parentReleaseId ?? "—"}`);
    });
  }

  async function promoteRollout(rollout: EvolutionRollout) {
    const value = requireReviewer();
    if (!value) {
      return;
    }
    await act(`rollout:${rollout.id}`, async () => {
      await platformApi.evolution.promoteRollout(rollout.id, { reviewer: value });
      setNotice("金丝雀已人工晋升为全量版本。");
    });
  }

  async function stopRollout(rollout: EvolutionRollout) {
    const value = requireReviewer();
    if (!value) {
      return;
    }
    await act(`stop:${rollout.id}`, async () => {
      await platformApi.evolution.stopRollout(rollout.id, {
        reviewer: value,
        reason: "人工停止金丝雀"
      });
      setNotice("金丝雀已停止，基线重新承接全部流量。");
    });
  }

  async function acknowledge(alert: EvolutionAlert) {
    await act(`alert:${alert.id}`, async () => {
      await platformApi.evolution.acknowledgeAlert(alert.id);
    });
  }

  if (loading && !overview) {
    return (
      <div className="platform-page">
        <div className="platform-loading">
          <Loader2 size={18} className="is-spinning" />
          正在读取发布快照、候选门禁与账本…
        </div>
      </div>
    );
  }

  return (
    <div className="platform-page evolution-page">
      <header className="platform-head">
        <div className="platform-head-main">
          <h1>
            优化实验
            <span className="platform-version">{candidates.length} 个候选</span>
          </h1>
          <p className="platform-head-meta">
            改进闭环：发布快照做基线 → 自循环补丁成为候选 → 门禁通过后金丝雀灰度；快照不可变，护栏越界自动回滚。
          </p>
        </div>
        <div className="platform-head-actions">
          <label className="evolution-reviewer">
            <span>审批人</span>
            <input
              value={reviewer}
              onChange={(event) => setReviewer(event.target.value)}
              placeholder="填写姓名后才能批准或回滚"
            />
          </label>
          <button
            type="button"
            className="platform-button is-ghost"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? "is-spinning" : undefined} />
            刷新
          </button>
        </div>
      </header>

      {error && (
        <div className="evolution-alert is-error" role="alert">
          <AlertTriangle size={15} />
          {error}
        </div>
      )}
      {notice && (
        <div className="evolution-alert is-ok" role="status">
          <CheckCircle2 size={15} />
          {notice}
        </div>
      )}

      <ol className="evolution-steps" aria-label="优化实验三步走">
        <li>
          <strong>① 建基线</strong>
          <span>在「发布版本」里选择工作流发布快照，作为后续对比的固定基线</span>
        </li>
        <li>
          <strong>② 产候选</strong>
          <span>运行工作流触发自循环补丁，补丁进入候选列表等待配对门禁</span>
        </li>
        <li>
          <strong>③ 上金丝雀</strong>
          <span>门禁通过并人工批准后灰度承接流量，护栏越界自动回滚</span>
        </li>
      </ol>

      <div className="evolution-kpis">
        <div className="evolution-kpi">
          <span>生效发布</span>
          <strong>{overview?.releases.active ?? activeReleases.length}</strong>
          <small>同一工作流只允许一个 active</small>
        </div>
        <div className="evolution-kpi">
          <span>金丝雀</span>
          <strong>{overview?.rollouts.canary ?? 0}</strong>
          <small>灰度中创建，护栏自动回滚</small>
        </div>
        <div className="evolution-kpi">
          <span>候选总数</span>
          <strong>{overview?.candidates.total ?? candidates.length}</strong>
          <small>
            门禁通过 {overview?.candidates.byStatus.gate_passed ?? 0} · 拒绝{" "}
            {overview?.candidates.byStatus.gate_failed ?? 0}
          </small>
        </div>
        <div className={`evolution-kpi ${openAlerts.length ? "has-warn" : ""}`}>
          <span>待处理告警</span>
          <strong>{openAlerts.length}</strong>
          <small>门禁、安全扫描与护栏</small>
        </div>
        <div className="evolution-kpi">
          <span>账本完整性</span>
          <strong>{overview?.ledger.valid ? "通过" : "断裂"}</strong>
          <small>
            {overview?.ledger.events ?? 0} 条哈希链事件
            {overview?.ledger.brokenAt ? ` · 断裂于 #${overview.ledger.brokenAt}` : ""}
          </small>
        </div>
      </div>

      <div className="evolution-grid">
        <section className="evolution-card">
          <header className="evolution-card-head">
            <div>
              <h2>
                <GitBranch size={16} />
                发布版本
              </h2>
              <p>发布快照包含根工作流、全部子工作流与 Agent；运行只认快照。</p>
            </div>
            <div className="evolution-inline-form">
              <select
                value={baselineWorkflow}
                onChange={(event) => setBaselineWorkflow(event.target.value)}
              >
                {workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="platform-button is-ghost"
                onClick={() => void createBaseline()}
                disabled={busy === "baseline"}
              >
                {busy === "baseline" ? <Loader2 size={14} className="is-spinning" /> : <Layers size={14} />}
                建立基线
              </button>
            </div>
          </header>
          {releases.length === 0 ? (
            <p className="evolution-empty">还没有发布快照。先选择一个工作流建立基线。</p>
          ) : (
            <div className="evolution-table-wrap">
              <table className="evolution-table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>状态</th>
                    <th>快照哈希</th>
                    <th>来源</th>
                    <th>变更摘要</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {releases.slice(0, 12).map((release) => (
                    <tr key={release.id}>
                      <td>
                        <strong>{release.label}</strong>
                        <small>{workflowName(release.workflowId)} · v{release.version}</small>
                      </td>
                      <td>
                        <span className={`evolution-tag is-${toneOf(release.status)}`}>
                          {RELEASE_STATUS_LABEL[release.status]}
                        </span>
                      </td>
                      <td className="is-mono" title={release.artifactHash}>
                        {shortHash(release.artifactHash)}
                      </td>
                      <td>{release.origin === "baseline" ? "基线" : "晋升"}</td>
                      <td className="is-clamp">{release.changeSummary}</td>
                      <td>
                        {release.parentReleaseId && ["active", "canary"].includes(release.status) ? (
                          <button
                            type="button"
                            className="platform-button is-ghost is-compact"
                            onClick={() => void rollbackRelease(release)}
                            disabled={busy === `rollback:${release.id}`}
                          >
                            <Undo2 size={13} />
                            回滚
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="evolution-card">
          <header className="evolution-card-head">
            <div>
              <h2>
                <ShieldCheck size={16} />
                金丝雀与护栏
              </h2>
              <p>对照臂保持基线，候选臂按哈希桶分流；样本足够后越界即自动回滚。</p>
            </div>
          </header>
          {rollouts.length === 0 ? (
            <p className="evolution-empty">暂无金丝雀。候选晋升时填写灰度比例即可创建。</p>
          ) : (
            <ul className="evolution-rollouts">
              {rollouts.map((rollout) => {
                const failed = rollout.status === "rolled_back";
                return (
                  <li key={rollout.id} className={`evolution-rollout is-${toneOf(rollout.status)}`}>
                    <div className="evolution-rollout-head">
                      <div>
                        <strong>{rollout.percent}% 流量 · {workflowName(rollout.workflowId)}</strong>
                        <small>
                          {rollout.releaseId} · 最小样本 {rollout.minSamplesPerArm}/臂
                        </small>
                      </div>
                      <span className={`evolution-tag is-${toneOf(rollout.status)}`}>
                        {ROLLOUT_STATUS_LABEL[rollout.status]}
                      </span>
                    </div>
                    <div className="evolution-rollout-guard">
                      <span>失败率上限 +{(rollout.maxErrorRateDelta * 100).toFixed(1)}pp</span>
                      <span>均分下降上限 {rollout.maxScoreDrop.toFixed(2)}</span>
                      {rollout.rollbackReason && <span className="is-danger">{rollout.rollbackReason}</span>}
                    </div>
                    {rollout.status === "canary" && (
                      <div className="evolution-rollout-actions">
                        <button
                          type="button"
                          className="platform-button is-primary is-compact"
                          onClick={() => void promoteRollout(rollout)}
                          disabled={busy === `rollout:${rollout.id}`}
                        >
                          <Rocket size={13} />
                          人工晋升
                        </button>
                        <button
                          type="button"
                          className="platform-button is-ghost is-compact"
                          onClick={() => void stopRollout(rollout)}
                          disabled={busy === `stop:${rollout.id}`}
                        >
                          <Undo2 size={13} />
                          停止灰度
                        </button>
                      </div>
                    )}
                    {failed && (
                      <p className="evolution-rollout-foot">
                        已自动回滚，基线恢复承接流量，候选版本标记为 rolled_back。
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>

      <section className="evolution-card">
        <header className="evolution-card-head">
          <div>
            <h2>
              <FlaskConical size={16} />
              演化候选与离线门禁
            </h2>
            <p>
              门禁在固定回归集上逐用例配对比较；未指定目标用例时要求整体平均提升，并限制单例退化与成本上涨。
            </p>
          </div>
          <div className="evolution-inline-form">
            <select
              value={candidateForm.workflowId}
              onChange={(event) =>
                setCandidateForm((current) => ({
                  ...current,
                  workflowId: event.target.value,
                  baseReleaseId: ""
                }))
              }
            >
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                </option>
              ))}
            </select>
            <span className="evolution-hint">
              {datasets.filter((dataset) => dataset.workflowId === candidateForm.workflowId).length} 个固定回归集
            </span>
            <label className="evolution-canary-input">
              门禁模式
              <select
                value={gateMode}
                onChange={(event) => setGateMode(event.target.value as "stub" | "live")}
              >
                <option value="stub">stub（零成本契约演练）</option>
                <option value="live">live（真实模型，消耗 token）</option>
              </select>
            </label>
          </div>
        </header>

        <div className="evolution-candidate-form">
          <input
            value={candidateForm.title}
            onChange={(event) => setCandidateForm((current) => ({ ...current, title: event.target.value }))}
            placeholder="候选标题，例如：补强口径核对"
          />
          <select
            value={candidateForm.baseReleaseId}
            onChange={(event) =>
              setCandidateForm((current) => ({ ...current, baseReleaseId: event.target.value }))
            }
          >
            <option value="">基线：当前生效发布</option>
            {formReleases.map((release) => (
              <option key={release.id} value={release.id}>
                {release.label}
              </option>
            ))}
          </select>
          <select
            value={candidateForm.kind}
            onChange={(event) =>
              setCandidateForm((current) => ({
                ...current,
                kind: event.target.value as typeof current.kind
              }))
            }
          >
            <option value="prompt_patch">Prompt 补丁</option>
            <option value="model_route">模型路由</option>
            <option value="tool_policy">工具策略</option>
            <option value="agent_swap">Agent 替换</option>
            <option value="workflow_path">工作流路径（会被安全扫描拒绝）</option>
          </select>
          <input
            value={candidateForm.target}
            onChange={(event) => setCandidateForm((current) => ({ ...current, target: event.target.value }))}
            placeholder={
              candidateForm.kind === "agent_swap" || candidateForm.kind === "workflow_path"
                ? "节点路径 / 工作流 id"
                : "Agent id"
            }
          />
          <textarea
            value={candidateForm.after}
            onChange={(event) => setCandidateForm((current) => ({ ...current, after: event.target.value }))}
            placeholder="变更后内容：Prompt 补丁文本、模型 id、工具列表或替换后的 Agent id"
            rows={2}
          />
          <button
            type="button"
            className="platform-button is-primary"
            onClick={() => void createCandidate()}
            disabled={busy === "candidate"}
          >
            {busy === "candidate" ? <Loader2 size={14} className="is-spinning" /> : <ArrowUpRight size={14} />}
            登记候选
          </button>
        </div>

        {candidates.length === 0 ? (
          <p className="evolution-empty">还没有候选。自循环补丁会从这里出现，也可以手动登记。</p>
        ) : (
          <div className="evolution-candidates">
            {candidates.map((candidate) => {
              const expanded = expandedCandidate === candidate.id;
              const gate = candidate.gate;
              return (
                <article
                  key={candidate.id}
                  className={`evolution-candidate is-${toneOf(candidate.status)} ${expanded ? "is-open" : ""}`}
                >
                  <button
                    type="button"
                    className="evolution-candidate-head"
                    onClick={() => setExpandedCandidate(expanded ? undefined : candidate.id)}
                  >
                    <div>
                      <strong>{candidate.title}</strong>
                      <small>
                        {workflowName(candidate.workflowId)} · {candidate.source} · 基线 v
                        {releases.find((release) => release.id === candidate.baseReleaseId)?.version ?? "?"}
                      </small>
                    </div>
                    <span className={`evolution-tag is-${toneOf(candidate.status)}`}>
                      {CANDIDATE_STATUS_LABEL[candidate.status]}
                    </span>
                  </button>

                  {expanded && (
                    <div className="evolution-candidate-body">
                      <p className="evolution-candidate-summary">{candidate.summary}</p>
                      <div className="evolution-changes">
                        {candidate.changes.map((change) => (
                          <div key={change.id} className="evolution-change">
                            <span className="evolution-change-kind">{change.kind}</span>
                            <span className="is-mono">{change.target}</span>
                            <p>{change.after}</p>
                          </div>
                        ))}
                      </div>

                      {candidate.security && (
                        <div
                          className={`evolution-scan is-${candidate.security.passed ? "good" : "bad"}`}
                        >
                          <strong>
                            {candidate.security.passed ? "安全扫描通过" : "安全扫描拒绝"}
                          </strong>
                          {candidate.security.findings.length > 0 && (
                            <ul>
                              {candidate.security.findings.map((finding) => (
                                <li key={finding.id}>
                                  [{finding.severity}] {finding.message}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}

                      {gate && (
                        <div className="evolution-gate">
                          <div className="evolution-gate-head">
                            <strong className={gate.passed ? "is-good" : "is-bad"}>
                              {gate.passed ? "门禁通过" : "门禁拒绝"}
                            </strong>
                            <span>
                              {gate.mode} · {gate.stats.pairedCount}/{gate.stats.caseCount} 配对用例
                            </span>
                          </div>
                          <div className="evolution-gate-stats">
                            <span>基线均分 {formatScore(gate.stats.baseMean)}</span>
                            <span>候选均分 {formatScore(gate.stats.candidateMean)}</span>
                            <span>平均变化 {gate.stats.meanDelta >= 0 ? "+" : ""}{formatScore(gate.stats.meanDelta)}</span>
                            <span>
                              置信区间 [{formatScore(gate.stats.ciLow)}, {formatScore(gate.stats.ciHigh)}]
                            </span>
                            <span>
                              胜/负/平 {gate.stats.win}/{gate.stats.loss}/{gate.stats.tie}
                            </span>
                            <span>成本变化 {(gate.stats.costIncreasePct * 100).toFixed(1)}%</span>
                          </div>
                          <div className="evolution-table-wrap">
                            <table className="evolution-table is-compact">
                              <thead>
                                <tr>
                                  <th>用例</th>
                                  <th>基线</th>
                                  <th>候选</th>
                                  <th>变化</th>
                                  <th>状态</th>
                                </tr>
                              </thead>
                              <tbody>
                                {gate.perCase.map((item) => (
                                  <tr key={item.caseId}>
                                    <td>{item.title}</td>
                                    <td>{formatScore(item.baseScore)}</td>
                                    <td>{formatScore(item.candidateScore)}</td>
                                    <td className={(item.delta ?? 0) < 0 ? "is-bad" : (item.delta ?? 0) > 0 ? "is-good" : ""}>
                                      {typeof item.delta === "number"
                                        ? `${item.delta >= 0 ? "+" : ""}${item.delta.toFixed(3)}`
                                        : "—"}
                                    </td>
                                    <td>
                                      {item.baseStatus === item.candidateStatus
                                        ? item.baseStatus
                                        : `${item.baseStatus} → ${item.candidateStatus}`}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {!gate.passed && (
                            <ul className="evolution-reasons">
                              {gate.reasons.map((reason) => (
                                <li key={reason}>{reason}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}

                      <div className="evolution-candidate-actions">
                        {(candidate.status === "draft" || candidate.status === "gate_failed") && (
                          <button
                            type="button"
                            className="platform-button is-primary is-compact"
                            onClick={() => void runGate(candidate)}
                            disabled={busy === `gate:${candidate.id}`}
                          >
                            {busy === `gate:${candidate.id}` ? (
                              <Loader2 size={13} className="is-spinning" />
                            ) : (
                              <FlaskConical size={13} />
                            )}
                            运行离线门禁
                          </button>
                        )}
                        {candidate.status === "gate_passed" && (
                          <button
                            type="button"
                            className="platform-button is-primary is-compact"
                            onClick={() => void approve(candidate)}
                            disabled={busy === `approve:${candidate.id}`}
                          >
                            <CheckCircle2 size={13} />
                            人工批准
                          </button>
                        )}
                        {candidate.status === "approved" && (
                          <>
                            <label className="evolution-canary-input">
                              灰度
                              <input
                                type="number"
                                min={0}
                                max={100}
                                value={canaryPercent}
                                onChange={(event) => setCanaryPercent(Number(event.target.value))}
                              />
                              %
                            </label>
                            <button
                              type="button"
                              className="platform-button is-primary is-compact"
                              onClick={() => void promote(candidate)}
                              disabled={busy === `promote:${candidate.id}`}
                            >
                              <Rocket size={13} />
                              晋升为金丝雀
                            </button>
                          </>
                        )}
                        {!["promoted", "rejected"].includes(candidate.status) && (
                          <button
                            type="button"
                            className="platform-button is-reject is-compact"
                            onClick={() => void reject(candidate)}
                            disabled={busy === `reject:${candidate.id}`}
                          >
                            <XCircle size={13} />
                            拒绝
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <div className="evolution-grid">
        <section className="evolution-card">
          <header className="evolution-card-head">
            <div>
              <h2>
                <AlertTriangle size={16} />
                告警
              </h2>
              <p>安全扫描、门禁拒绝与护栏自动回滚都会在这里留痕。</p>
            </div>
          </header>
          {alerts.length === 0 ? (
            <p className="evolution-empty">没有告警。</p>
          ) : (
            <ul className="evolution-alerts">
              {alerts.map((alert) => (
                <li key={alert.id} className={`is-${toneOf(alert.severity)}`}>
                  <div>
                    <strong>{alert.title}</strong>
                    <p>{alert.detail}</p>
                    <small>
                      {alert.kind} · {alert.entityType} · {formatTime(alert.createdAt)}
                    </small>
                  </div>
                  {!alert.acknowledged && (
                    <button
                      type="button"
                      className="platform-button is-ghost is-compact"
                      onClick={() => void acknowledge(alert)}
                      disabled={busy === `alert:${alert.id}`}
                    >
                      确认
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="evolution-card">
          <header className="evolution-card-head">
            <div>
              <h2>
                <ScrollText size={16} />
                演化账本
              </h2>
              <p>每次候选、门禁、晋升与回滚都写入哈希链，可按序号复核。</p>
            </div>
            <span className={`evolution-integrity is-${ledger?.integrity.valid ? "good" : "bad"}`}>
              {ledger?.integrity.valid ? "哈希链完整" : `断裂于 #${ledger?.integrity.brokenAt ?? "?"}`}
            </span>
          </header>
          {!ledger || ledger.events.length === 0 ? (
            <p className="evolution-empty">账本为空。</p>
          ) : (
            <ol className="evolution-ledger">
              {[...ledger.events].reverse().map((event) => (
                <li key={event.seq}>
                  <span className="is-mono">#{event.seq}</span>
                  <div>
                    <strong>{event.type}</strong>
                    <small>
                      {event.entityType} · {event.entityId}
                    </small>
                    <small title={event.hash}>
                      {formatTime(event.createdAt)} · {shortHash(event.hash)}
                    </small>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {(activeReleases.length > 0 || canaryReleases.length > 0) && (
        <footer className="evolution-foot">
          <Activity size={13} />
          内部流量只从平台运行入口进入：显式 releaseId 必须属于同一工作流；未指定时按金丝雀哈希桶分流，
          releaseId 为空串的旧调用继续绕过演化。
        </footer>
      )}
    </div>
  );
}
