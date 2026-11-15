import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Database,
  FileText,
  FolderPlus,
  Info,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  XCircle
} from "lucide-react";
import { platformApi, uploadKnowledgeDocument } from "./api";
import type {
  KnowledgeBaseOverview,
  KnowledgeCitation,
  KnowledgeDocument,
  StarterKnowledgePack
} from "./types";
import "./platform.css";

type Banner = {
  tone: "info" | "success" | "error";
  text: string;
};

export function KnowledgePage() {
  const [overview, setOverview] = useState<KnowledgeBaseOverview>();
  const [selectedId, setSelectedId] = useState<string>();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [citations, setCitations] = useState<KnowledgeCitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [docsLoading, setDocsLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [query, setQuery] = useState("");
  const [banner, setBanner] = useState<Banner>();
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [binding, setBinding] = useState<string>();
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [starterPacks, setStarterPacks] = useState<StarterKnowledgePack[]>([]);
  const [importingPack, setImportingPack] = useState<string>();

  async function refresh(selectId?: string) {
    try {
      const next = await platformApi.knowledgeBases();
      setOverview(next);
      setSelectedId((current) =>
        selectId ?? (current && next.bases.some((base) => base.id === current) ? current : next.bases[0]?.id)
      );
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    void platformApi
      .knowledgeStarterPacks()
      .then((response) => setStarterPacks(response.packs))
      .catch(() => setStarterPacks([]));
  }, []);

  async function importStarterPack(packId: string) {
    setImportingPack(packId);
    try {
      const { base } = await platformApi.importKnowledgeStarterPack(packId);
      setBanner({ tone: "success", text: `已复制到「${base.name}」，可直接上传补充资料或绑定到工作流。` });
      await refresh(base.id);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setImportingPack(undefined);
    }
  }

  useEffect(() => {
    if (!selectedId) {
      setDocuments([]);
      return;
    }
    let cancelled = false;
    setDocsLoading(true);
    setCitations([]);
    setSearched(false);
    setDeleteConfirm(false);
    void platformApi
      .knowledgeDocuments(selectedId)
      .then((response) => {
        if (!cancelled) {
          setDocuments(response.documents);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setBanner({ tone: "error", text: describe(error) });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDocsLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selected = useMemo(
    () => overview?.bases.find((base) => base.id === selectedId),
    [overview, selectedId]
  );
  const teamNames = useMemo(
    () => new Map((overview?.teams ?? []).map((team) => [team.id, team.name])),
    [overview]
  );
  const workflowNames = useMemo(
    () => new Map((overview?.workflows ?? []).map((workflow) => [workflow.id, workflow.name])),
    [overview]
  );
  const isIma = selected?.source === "ima";

  async function createBase() {
    const name = newName.trim();
    if (!name || creating) {
      return;
    }
    setCreating(true);
    try {
      const response = await platformApi.createKnowledgeBase(name);
      setBanner({ tone: "success", text: `已创建知识库「${response.base.name}」，可以上传资料并绑定到团队或工作流。` });
      setCreateOpen(false);
      setNewName("");
      await refresh(response.base.id);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setCreating(false);
    }
  }

  async function uploadFiles(files: FileList | null) {
    if (!selected || !files?.length || uploading) {
      return;
    }
    const picked = Array.from(files).slice(0, 5);
    setUploading(true);
    try {
      for (const file of picked) {
        await uploadKnowledgeDocument(selected.id, file);
      }
      setBanner({
        tone: "success",
        text: `已上传 ${picked.length} 份资料；工作流绑定的检索范围即时生效。`
      });
      const [documentResponse] = await Promise.all([
        platformApi.knowledgeDocuments(selected.id),
        refresh(selected.id)
      ]);
      setDocuments(documentResponse.documents);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setUploading(false);
    }
  }

  async function removeDocument(document: KnowledgeDocument) {
    if (!selected) {
      return;
    }
    try {
      await platformApi.deleteKnowledgeDocument(selected.id, document.id);
      setBanner({ tone: "success", text: `已删除资料「${document.name}」。` });
      const [documentResponse] = await Promise.all([
        platformApi.knowledgeDocuments(selected.id),
        refresh(selected.id)
      ]);
      setDocuments(documentResponse.documents);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    }
  }

  async function removeBase() {
    if (!selected || deleting) {
      return;
    }
    setDeleting(true);
    try {
      await platformApi.deleteKnowledgeBase(selected.id);
      setBanner({ tone: "success", text: `已删除知识库「${selected.name}」，团队与工作流中的绑定已同步解除。` });
      setDeleteConfirm(false);
      setSelectedId(undefined);
      await refresh();
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setDeleting(false);
    }
  }

  async function runSearch() {
    const text = query.trim();
    if (!selected || !text || searching) {
      return;
    }
    setSearching(true);
    try {
      const response = await platformApi.searchKnowledge(text, [selected.id], 6);
      setCitations(response.citations);
      setSearched(true);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setSearching(false);
    }
  }

  async function toggleBinding(target: { teamId?: string; workflowId?: string; bound: boolean }) {
    if (!selected) {
      return;
    }
    const key = target.teamId ? `team:${target.teamId}` : `workflow:${target.workflowId}`;
    if (binding === key) {
      return;
    }
    const label = target.teamId
      ? `团队「${teamNames.get(target.teamId) ?? target.teamId}」`
      : `工作流「${workflowNames.get(target.workflowId ?? "") ?? target.workflowId}」`;
    setBinding(key);
    try {
      await platformApi.bindKnowledgeBase(selected.id, target);
      setBanner({
        tone: "success",
        text: target.bound
          ? `已把「${selected.name}」绑定到${label}。`
          : `已解除「${selected.name}」与${label}的绑定。`
      });
      await refresh(selected.id);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setBinding(undefined);
    }
  }

  if (loading) {
    return (
      <div className="platform-page">
        <div className="platform-loading">
          <Loader2 size={18} className="is-spinning" />
          正在加载知识库…
        </div>
      </div>
    );
  }

  return (
    <div className="platform-page knowledge-page">
      <header className="platform-head">
        <div className="platform-head-main">
          <span className="platform-eyebrow">知识库管理</span>
          <h1>
            知识库与绑定
            <span className="platform-version">{overview?.bases.length ?? 0} 个知识库</span>
          </h1>
          <p>
            平台级创建、上传、绑定与召回测试；绑定到工作流后，知识库会成为其中 knowledge.search 节点的默认检索范围。
          </p>
        </div>
        <div className="platform-head-actions">
          <button type="button" className="platform-button is-ghost" onClick={() => void refresh(selectedId)}>
            <RefreshCw size={14} />
            刷新
          </button>
          <button
            type="button"
            className="platform-button is-primary"
            onClick={() => setCreateOpen((value) => !value)}
          >
            <Plus size={14} />
            新建知识库
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

      {createOpen && (
        <section className="knowledge-create">
          <label>
            知识库名称
            <input
              value={newName}
              placeholder="例：教育-初中数学-分数教案语料"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  void createBase();
                }
              }}
            />
            <small>用「场景-主题-用途」说明内容，不要用日期、ID 或测试编号。</small>
          </label>
          <button
            type="button"
            className="platform-button is-primary"
            disabled={creating || !newName.trim()}
            onClick={() => void createBase()}
          >
            {creating ? <Loader2 size={14} className="is-spinning" /> : <FolderPlus size={14} />}
            {creating ? "创建中…" : "创建"}
          </button>
          <button type="button" className="platform-button is-ghost" onClick={() => setCreateOpen(false)}>
            取消
          </button>
        </section>
      )}

      {starterPacks.length > 0 && (
        <section className="knowledge-starter-packs">
          <header>
            <span>示例资料包</span>
            <small>复制到本地后可直接绑定团队或工作流</small>
          </header>
          <div className="knowledge-starter-grid">
            {starterPacks.map((pack) => (
              <article key={pack.id}>
                <div>
                  <strong>{pack.name}</strong>
                  <small>{pack.documentCount} 份资料 · 适合 {pack.recommendedFor.join("、")}</small>
                </div>
                <p>{pack.description}</p>
                <button
                  type="button"
                  className="platform-button is-ghost"
                  disabled={importingPack === pack.id}
                  onClick={() => void importStarterPack(pack.id)}
                >
                  {importingPack === pack.id ? (
                    <Loader2 size={14} className="is-spinning" />
                  ) : (
                    <FolderPlus size={14} />
                  )}
                  {importingPack === pack.id ? "复制中…" : "复制到我的资料"}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="knowledge-layout">
        <aside className="knowledge-list">
          <header className="knowledge-list-head">
            <span>知识库</span>
            <small>{overview?.bases.reduce((sum, base) => sum + base.documentCount, 0) ?? 0} 份资料</small>
          </header>
          {overview?.bases.length ? (
            overview.bases.map((base) => (
              <button
                key={base.id}
                type="button"
                className={`knowledge-card ${base.id === selectedId ? "is-active" : ""}`}
                onClick={() => setSelectedId(base.id)}
              >
                <div className="knowledge-card-head">
                  {base.source === "ima" ? <Database size={16} /> : <BookOpen size={16} />}
                  <strong>{base.name}</strong>
                </div>
                <div className="knowledge-card-meta">
                  <span className={`knowledge-source is-${base.source}`}>
                    {base.source === "ima" ? "IMA" : "本地"}
                  </span>
                  <span>{base.documentCount} 份资料</span>
                  {base.teamIds.length > 0 && <span>{base.teamIds.length} 团队</span>}
                  {base.workflowIds.length > 0 && <span>{base.workflowIds.length} 工作流</span>}
                </div>
              </button>
            ))
          ) : (
            <div className="knowledge-empty">
              还没有知识库。点右上角「新建知识库」，或在左侧选择既有资料库。
            </div>
          )}
        </aside>

        <section className="knowledge-detail">
          {selected ? (
            <>
              <header className="knowledge-detail-head">
                <div>
                  <h2>{selected.name}</h2>
                  <small>
                    {selected.source === "ima" ? "IMA 知识库" : "本地知识库"} · 创建于 {formatTime(selected.createdAt)}
                  </small>
                </div>
                {deleteConfirm ? (
                  <div className="knowledge-confirm">
                    <button
                      type="button"
                      className="platform-button is-ghost"
                      disabled={deleting}
                      onClick={() => void removeBase()}
                    >
                      {deleting ? <Loader2 size={14} className="is-spinning" /> : <Trash2 size={14} />}
                      确认删除
                    </button>
                    <button type="button" className="platform-button is-ghost" onClick={() => setDeleteConfirm(false)}>
                      取消
                    </button>
                  </div>
                ) : (
                  <button type="button" className="platform-button is-ghost" onClick={() => setDeleteConfirm(true)}>
                    <Trash2 size={14} />
                    删除知识库
                  </button>
                )}
              </header>

              <section className="knowledge-section">
                <header>
                  <h3>
                    <FileText size={15} />
                    资料
                    <span>{documents.length}</span>
                  </h3>
                  {isIma ? (
                    <span className="knowledge-note">IMA 资料请在 IMA 平台维护</span>
                  ) : (
                    <label className={`platform-button is-ghost ${uploading ? "is-disabled" : ""}`}>
                      {uploading ? <Loader2 size={14} className="is-spinning" /> : <Upload size={14} />}
                      {uploading ? "上传中…" : "上传资料"}
                      <input
                        type="file"
                        multiple
                        hidden
                        disabled={uploading}
                        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.json"
                        onChange={(event) => {
                          void uploadFiles(event.target.files);
                          event.target.value = "";
                        }}
                      />
                    </label>
                  )}
                </header>

                {docsLoading ? (
                  <div className="knowledge-empty">
                    <Loader2 size={15} className="is-spinning" />
                    正在读取资料…
                  </div>
                ) : documents.length > 0 ? (
                  <div className="knowledge-doc-list">
                    {documents.map((document) => (
                      <article key={document.id} className="knowledge-doc-row">
                        <div>
                          <strong>{document.name}</strong>
                          <small>
                            {document.type || "文件"} · {formatBytes(document.size)} · {document.chunkCount} 个片段 ·{" "}
                            {formatTime(document.createdAt)}
                          </small>
                        </div>
                        <button
                          type="button"
                          className="registry-icon-button"
                          aria-label={`删除资料 ${document.name}`}
                          onClick={() => void removeDocument(document)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="knowledge-empty">
                    {isIma ? "IMA 知识库不返回文档清单，可直接用右侧召回测试验证。" : "还没有资料。上传课标、教材或课例后即可用于检索。"}
                  </div>
                )}
              </section>

              <div className="knowledge-grid">
                <section className="knowledge-section">
                  <header>
                    <h3>
                      <Search size={15} />
                      召回测试
                    </h3>
                  </header>
                  <div className="knowledge-search">
                    <input
                      value={query}
                      placeholder="输入要检索的问题"
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          void runSearch();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="platform-button is-primary"
                      disabled={searching || !query.trim()}
                      onClick={() => void runSearch()}
                    >
                      {searching ? <Loader2 size={14} className="is-spinning" /> : <Search size={14} />}
                      检索
                    </button>
                  </div>
                  {searched && citations.length === 0 && (
                    <div className="knowledge-empty">0 条命中：换一个更贴近资料内容的查询，或补充资料。</div>
                  )}
                  {citations.length > 0 && (
                    <div className="knowledge-citation-list">
                      {citations.map((citation) => (
                        <article key={citation.id} className="knowledge-citation">
                          <header>
                            <strong>{citation.documentName}</strong>
                            <span>{citation.score.toFixed(2)}</span>
                          </header>
                          <p>{citation.snippet}</p>
                          <small>
                            {citation.knowledgeBaseName}
                            {citation.source ? ` · ${citation.source}` : ""}
                          </small>
                        </article>
                      ))}
                    </div>
                  )}
                </section>

                <section className="knowledge-section">
                  <header>
                    <h3>
                      <Link2 size={15} />
                      绑定
                    </h3>
                    <span className="knowledge-note">
                      <Info size={13} />
                      工作流绑定会作为检索默认范围
                    </span>
                  </header>
                  <div className="knowledge-bind-group">
                    <h4>团队</h4>
                    {overview?.teams.length ? (
                      overview.teams.map((team) => (
                        <label
                          key={team.id}
                          className={`knowledge-bind-item ${team.knowledgeBaseIds.includes(selected.id) ? "is-on" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={team.knowledgeBaseIds.includes(selected.id)}
                            disabled={binding === `team:${team.id}`}
                            onChange={(event) =>
                              void toggleBinding({
                                teamId: team.id,
                                bound: event.target.checked
                              })
                            }
                          />
                          <span>
                            <strong>{team.name}</strong>
                            <small>
                              {team.agentIds.length} 个 Agent
                              {team.workflowId ? ` · 默认 ${workflowNames.get(team.workflowId) ?? team.workflowId}` : ""}
                            </small>
                          </span>
                        </label>
                      ))
                    ) : (
                      <div className="knowledge-empty">还没有团队，先去注册中心创建。</div>
                    )}
                  </div>
                  <div className="knowledge-bind-group">
                    <h4>工作流</h4>
                    {overview?.workflows.length ? (
                      overview.workflows.map((workflow) => (
                        <label
                          key={workflow.id}
                          className={`knowledge-bind-item ${workflow.knowledgeBaseIds.includes(selected.id) ? "is-on" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={workflow.knowledgeBaseIds.includes(selected.id)}
                            disabled={binding === `workflow:${workflow.id}`}
                            onChange={(event) =>
                              void toggleBinding({
                                workflowId: workflow.id,
                                bound: event.target.checked
                              })
                            }
                          />
                          <span>
                            <strong>{workflow.name}</strong>
                            <small>
                              v{workflow.version} · {workflow.knowledgeBaseIds.length} 个绑定
                            </small>
                          </span>
                        </label>
                      ))
                    ) : (
                      <div className="knowledge-empty">还没有工作流。</div>
                    )}
                  </div>
                </section>
              </div>
            </>
          ) : (
            <div className="knowledge-empty is-large">
              <BookOpen size={22} />
              选择左侧知识库查看资料、召回测试与绑定。
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
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
