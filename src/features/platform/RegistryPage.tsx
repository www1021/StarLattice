import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  CheckCircle2,
  History,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Users,
  Wrench,
  X,
  XCircle
} from "lucide-react";
import { platformApi } from "./api";
import {
  SCENARIO_PACK_FILTERS,
  filterByPack,
  packLabel,
  packOf,
  type ScenarioPackFilter
} from "../../../shared/scenarioPacks";
import type {
  AgentVersionsResponse,
  RegistryAgentView,
  RegistryOverview,
  ToolRecord,
  WorkflowSummary
} from "./types";
import "./platform.css";

type Banner = {
  tone: "info" | "success" | "error";
  text: string;
};

type TeamForm = {
  id: string;
  name: string;
  description: string;
  workflowId: string;
  knowledgeBaseIds: string;
  agentIds: string[];
};

const EMPTY_FORM: TeamForm = {
  id: "task-team",
  name: "通用任务团队",
  description: "",
  workflowId: "",
  knowledgeBaseIds: "",
  agentIds: []
};

export function RegistryPage() {
  const [overview, setOverview] = useState<RegistryOverview>();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [tools, setTools] = useState<ToolRecord[]>([]);
  const [agentPack, setAgentPack] = useState<ScenarioPackFilter | "all">("all");
  const [toolPack, setToolPack] = useState<ScenarioPackFilter | "all">("all");
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner>();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<TeamForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [versionAgent, setVersionAgent] = useState<RegistryAgentView>();
  const [versions, setVersions] = useState<AgentVersionsResponse>();
  const [versionLoading, setVersionLoading] = useState(false);
  const [rollingBack, setRollingBack] = useState<number>();

  async function load() {
    try {
      const [registry, workflowResponse, toolResponse] = await Promise.all([
        platformApi.registry(),
        platformApi.listWorkflows(),
        platformApi.listTools()
      ]);
      setOverview(registry);
      setWorkflows(workflowResponse.workflows);
      setTools(toolResponse.tools);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const workflowNames = useMemo(
    () => new Map(workflows.map((workflow) => [workflow.id, workflow.name])),
    [workflows]
  );

  const filteredAgents = useMemo(
    () =>
      overview
        ? filterByPack("agents", overview.agents, (agent) => agent.id, agentPack)
        : [],
    [overview, agentPack]
  );

  const filteredTools = useMemo(
    () => filterByPack("tools", tools, (tool) => tool.id, toolPack),
    [tools, toolPack]
  );

  const groups = useMemo(() => {
    if (!overview) {
      return { teams: [] as Array<{ id: string; name: string; agents: RegistryAgentView[] }>, ungrouped: [] as RegistryAgentView[] };
    }
    const teams = overview.teams
      .map((team) => ({
        id: team.id,
        name: team.name,
        agents: filteredAgents.filter((agent) => team.agentIds.includes(agent.id))
      }))
      .filter((team) => agentPack === "all" || team.agents.length > 0);
    const grouped = new Set(overview.teams.flatMap((team) => team.agentIds));
    return {
      teams,
      ungrouped: filteredAgents.filter((agent) => !grouped.has(agent.id))
    };
  }, [overview, filteredAgents, agentPack]);

  async function submitTeam() {
    if (saving) {
      return;
    }
    setSaving(true);
    try {
      const saved = await platformApi.saveTeam({
        id: form.id.trim(),
        name: form.name.trim(),
        description: form.description.trim(),
        workflowId: form.workflowId || undefined,
        knowledgeBaseIds: form.knowledgeBaseIds
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        agentIds: form.agentIds
      });
      setBanner({
        tone: "success",
        text: `${saved.created ? "已创建" : "已更新"}团队「${saved.team.name}」，包含 ${saved.team.agentIds.length} 个 Agent。`
      });
      setShowForm(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setSaving(false);
    }
  }

  function toggleMember(agentId: string) {
    setForm((current) => ({
      ...current,
      agentIds: current.agentIds.includes(agentId)
        ? current.agentIds.filter((id) => id !== agentId)
        : [...current.agentIds, agentId]
    }));
  }

  async function openVersions(agent: RegistryAgentView) {
    setVersionAgent(agent);
    setVersions(undefined);
    setVersionLoading(true);
    try {
      setVersions(await platformApi.listAgentVersions(agent.id));
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
      setVersionAgent(undefined);
    } finally {
      setVersionLoading(false);
    }
  }

  async function rollback(version: number) {
    if (!versionAgent || rollingBack !== undefined) {
      return;
    }
    setRollingBack(version);
    try {
      const response = await platformApi.rollbackAgent(versionAgent.id, version);
      setBanner({
        tone: "success",
        text: `「${response.agent.name}」已回滚到 v${response.rolledBackTo}；历史版本仍保留，下次修改从 v${Math.max(response.rolledBackTo, versions?.versions[0]?.version ?? 0) + 1} 继续。`
      });
      setVersionAgent({ ...versionAgent, ...response.agent });
      setVersions(await platformApi.listAgentVersions(versionAgent.id));
      await load();
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setRollingBack(undefined);
    }
  }

  if (loading) {
    return (
      <div className="platform-page">
        <div className="platform-loading">
          <Loader2 size={18} className="is-spinning" />
          正在加载注册中心…
        </div>
      </div>
    );
  }

  return (
    <div className="platform-page registry-page">
      <header className="platform-head">
        <div className="platform-head-main">
          <span className="platform-eyebrow">Agent 注册中心</span>
          <h1>
            团队与版本
            <span className="platform-version">{overview?.agents.length ?? 0} 个 Agent</span>
          </h1>
          <p>
            按团队查看成员的角色、能力、工具与记忆；每次修改自动写版本快照，可随时回滚；工作流节点填写版本号即可按指定版本运行。
          </p>
        </div>
        <div className="platform-head-actions">
          <button type="button" className="platform-button is-ghost" onClick={() => void load()}>
            <RefreshCw size={14} />
            刷新
          </button>
          <button
            type="button"
            className="platform-button is-primary"
            onClick={() => setShowForm((value) => !value)}
          >
            <Plus size={14} />
            新建团队
          </button>
        </div>
      </header>

      {banner && (
        <div className={`platform-banner is-${banner.tone}`}>
          <div className="platform-banner-line">
            {banner.tone === "error" ? <XCircle size={15} /> : <CheckCircle2 size={15} />}
            <span>{banner.text}</span>
          </div>
        </div>
      )}

      <div className="registry-body">
        {showForm && (
          <section className="registry-form">
            <header>
              <div>
                <strong>新建团队</strong>
                <small>勾选成员后保存；团队 ID 保存后不可修改。</small>
              </div>
              <button type="button" className="registry-icon-button" aria-label="关闭" onClick={() => setShowForm(false)}>
                <X size={16} />
              </button>
            </header>

            <div className="registry-form-grid">
              <label>
                团队 ID
                <input
                  value={form.id}
                  placeholder="task-team"
                  onChange={(event) => setForm({ ...form, id: event.target.value })}
                />
              </label>
              <label>
                团队名称
                <input
                  value={form.name}
                  placeholder="通用任务团队"
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </label>
              <label className="is-wide">
                团队描述
                <input
                  value={form.description}
                  placeholder="负责任务规划、执行与复核"
                  onChange={(event) => setForm({ ...form, description: event.target.value })}
                />
              </label>
              <label>
                默认工作流
                <select
                  value={form.workflowId}
                  onChange={(event) => setForm({ ...form, workflowId: event.target.value })}
                >
                  <option value="">不指定</option>
                  {workflows.map((workflow) => (
                    <option key={workflow.id} value={workflow.id}>
                      {workflow.name}（{workflow.id}）
                    </option>
                  ))}
                </select>
              </label>
              <label>
                绑定知识库 ID
                <input
                  value={form.knowledgeBaseIds}
                  placeholder="逗号分隔，例：kb-core, kb-demo"
                  onChange={(event) => setForm({ ...form, knowledgeBaseIds: event.target.value })}
                />
              </label>
            </div>

            <fieldset className="registry-members">
              <legend>
                成员 Agent <span>{form.agentIds.length}</span>
              </legend>
              <div className="registry-member-list">
                {filteredAgents.map((agent) => {
                  const checked = form.agentIds.includes(agent.id);
                  return (
                    <label key={agent.id} className={`registry-member ${checked ? "is-on" : ""}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleMember(agent.id)} />
                      <span>
                        <strong>{agent.name}</strong>
                        <small>
                          {agent.role || "未设置角色"} · v{agent.version}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <footer>
              <button type="button" className="platform-button is-ghost" onClick={() => setShowForm(false)}>
                取消
              </button>
              <button
                type="button"
                className="platform-button is-primary"
                disabled={saving || !form.id.trim() || !form.name.trim()}
                onClick={() => void submitTeam()}
              >
                {saving ? <Loader2 size={14} className="is-spinning" /> : <Plus size={14} />}
                {saving ? "保存中…" : "保存团队"}
              </button>
            </footer>
          </section>
        )}

        <section className="registry-section">
          <div className="registry-section-head">
            <Users size={16} />
            <h2>团队</h2>
            <span>{overview?.teams.length ?? 0}</span>
          </div>
          {overview && overview.teams.length === 0 ? (
            <p className="registry-hint">还没有团队。点右上角「新建团队」，勾选成员 Agent 即可。</p>
          ) : (
            <div className="registry-team-grid">
              {overview?.teams.map((team) => {
                const members = overview.agents.filter((agent) => team.agentIds.includes(agent.id));
                return (
                  <article className="registry-team" key={team.id}>
                    <header>
                      <div>
                        <strong>{team.name}</strong>
                        <small>
                          <code>{team.id}</code>
                        </small>
                      </div>
                      <span>{members.length} 人</span>
                    </header>
                    <p>{team.description || "未填写团队描述"}</p>
                    <div className="registry-team-meta">
                      <span>
                        默认工作流：{team.workflowId ? workflowNames.get(team.workflowId) ?? team.workflowId : "未指定"}
                      </span>
                      <span>
                        知识库：{team.knowledgeBaseIds.length > 0 ? team.knowledgeBaseIds.join("、") : "未绑定"}
                      </span>
                    </div>
                    <div className="registry-member-chips">
                      {members.length === 0 ? (
                        <small>暂无成员</small>
                      ) : (
                        members.map((agent) => (
                          <span key={agent.id}>
                            {agent.name}
                            <em>v{agent.version}</em>
                          </span>
                        ))
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section className="registry-section">
          <div className="registry-section-head">
            <Boxes size={16} />
            <h2>Agent 成员</h2>
            <span>{filteredAgents.length}</span>
          </div>
          <PackFilterRow value={agentPack} onChange={setAgentPack} total={overview?.agents.length ?? 0} />
          {filteredAgents.length === 0 && (
            <p className="registry-pack-empty">当前场景包没有 Agent。</p>
          )}
          {groups.teams.map((team) => (
            <div className="registry-group" key={team.id}>
              <h3>
                {team.name}
                <span>{team.agents.length}</span>
              </h3>
              <div className="registry-agent-grid">
                {team.agents.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} onVersions={() => void openVersions(agent)} />
                ))}
              </div>
            </div>
          ))}
          {groups.ungrouped.length > 0 && (
            <div className="registry-group">
              <h3>
                未分组
                <span>{groups.ungrouped.length}</span>
              </h3>
              <div className="registry-agent-grid">
                {groups.ungrouped.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} onVersions={() => void openVersions(agent)} />
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="registry-section">
          <div className="registry-section-head">
            <Wrench size={16} />
            <h2>工具注册</h2>
            <span>{filteredTools.length}</span>
          </div>
          <PackFilterRow value={toolPack} onChange={setToolPack} total={tools.length} />
          {filteredTools.length === 0 ? (
            <p className="registry-pack-empty">当前场景包没有注册工具。</p>
          ) : (
            <div className="registry-tool-grid">
              {filteredTools.map((tool) => (
                <article className="registry-tool-card" key={tool.id}>
                  <header>
                    <strong>{tool.name}</strong>
                    <span className="registry-tool-type">{tool.type}</span>
                  </header>
                  <p>{tool.description || "未填写描述"}</p>
                  <footer>
                    <code>{tool.id}</code>
                    <span>{packLabel(packOf("tools", tool.id))}</span>
                    <span className={tool.enabled ? "is-on" : "is-off"}>
                      {tool.enabled ? "启用" : "停用"}
                    </span>
                  </footer>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      {versionAgent && (
        <div className="registry-modal" role="dialog" aria-modal="true" aria-label="版本历史">
          <div className="registry-modal-card">
            <header>
              <div>
                <span>版本历史</span>
                <h2>{versionAgent.name}</h2>
                <small>
                  <code>{versionAgent.id}</code> · 当前 v{versionAgent.version}
                </small>
              </div>
              <button
                type="button"
                className="registry-icon-button"
                aria-label="关闭"
                onClick={() => setVersionAgent(undefined)}
              >
                <X size={16} />
              </button>
            </header>

            <p className="registry-modal-note">
              回滚会把当前版本切到该快照；历史版本不删除，后续修改从最大版本 +1 继续。
            </p>

            {versionLoading ? (
              <div className="registry-modal-loading">
                <Loader2 size={16} className="is-spinning" />
                正在加载版本…
              </div>
            ) : (
              <div className="registry-version-list">
                {versions?.versions.map((item) => {
                  const isCurrent = item.version === versions.currentVersion;
                  return (
                    <article key={item.version} className={`registry-version ${isCurrent ? "is-current" : ""}`}>
                      <div className="registry-version-head">
                        <strong>v{item.version}</strong>
                        <span>{formatTime(item.createdAt)}</span>
                        {isCurrent && <em>当前</em>}
                      </div>
                      <p>
                        {item.snapshot.role || "未设置角色"} · {item.snapshot.tools.length} 个工具 ·{" "}
                        {item.snapshot.capabilities.length} 项能力
                      </p>
                      <p className="registry-version-prompt">{preview(item.snapshot.prompt)}</p>
                      <button
                        type="button"
                        className="platform-button is-ghost"
                        disabled={isCurrent || rollingBack !== undefined}
                        onClick={() => void rollback(item.version)}
                      >
                        {rollingBack === item.version ? (
                          <Loader2 size={14} className="is-spinning" />
                        ) : (
                          <RotateCcw size={14} />
                        )}
                        {rollingBack === item.version ? "回滚中…" : "回滚到此版本"}
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type AgentCardProps = {
  agent: RegistryAgentView;
  onVersions: () => void;
};

function AgentCard({ agent, onVersions }: AgentCardProps) {
  const memoryKeys = Object.keys(agent.memory);
  return (
    <article className="registry-agent">
      <header>
        <div>
          <strong>{agent.name}</strong>
          <small>
            <code>{agent.id}</code> · {agent.role || "未设置角色"}
          </small>
        </div>
        <div className="registry-agent-badges">
          <span className="registry-badge">v{agent.version}</span>
          {agent.modelProfile && (
            <span
              className="registry-badge"
              title={`${agent.modelProfile.model} · ${agent.modelProfile.provider} · ${agent.modelProfile.costTier}`}
            >
              {agent.modelProfile.label}
            </span>
          )}
          <span className={`registry-badge ${agent.enabled ? "is-on" : "is-off"}`}>
            {agent.enabled ? "启用" : "停用"}
          </span>
        </div>
      </header>

      <div className="registry-agent-stats">
        <span>
          <strong>{agent.callCount}</strong> 次调用
        </span>
        <span>
          <strong>{agent.tools.length}</strong> 个工具
        </span>
        <span>
          <strong>{memoryKeys.length}</strong> 项记忆
        </span>
      </div>

      <div className="registry-tags">
        {agent.capabilities.length === 0 ? (
          <small>未声明能力标签</small>
        ) : (
          agent.capabilities.map((capability) => (
            <span key={capability.tag}>
              {capability.tag}
              <em>{capability.weight.toFixed(2)}</em>
            </span>
          ))
        )}
      </div>

      <div className="registry-tools">
        {agent.tools.length === 0 ? (
          <small>未挂载工具</small>
        ) : (
          agent.tools.map((tool) => <code key={tool}>{tool}</code>)
        )}
      </div>

      {memoryKeys.length > 0 && <p className="registry-memory">记忆字段：{memoryKeys.join("、")}</p>}

      <footer>
        <span>更新于 {formatTime(agent.updatedAt)}</span>
        <button type="button" className="platform-button is-ghost" onClick={onVersions}>
          <History size={14} />
          版本历史
        </button>
      </footer>
    </article>
  );
}

function PackFilterRow({
  value,
  onChange,
  total
}: {
  value: ScenarioPackFilter | "all";
  onChange: (value: ScenarioPackFilter | "all") => void;
  total: number;
}) {
  return (
    <div className="registry-pack-filter" role="group" aria-label="按场景包筛选">
      <button
        type="button"
        className={`registry-pack-chip ${value === "all" ? "is-active" : ""}`}
        aria-pressed={value === "all"}
        onClick={() => onChange("all")}
      >
        全部
        <span>{total}</span>
      </button>
      {SCENARIO_PACK_FILTERS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`registry-pack-chip ${value === item.id ? "is-active" : ""}`}
          aria-pressed={value === item.id}
          onClick={() => onChange(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function preview(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 110 ? `${compact.slice(0, 110)}…` : compact;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", { hour12: false });
}

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
