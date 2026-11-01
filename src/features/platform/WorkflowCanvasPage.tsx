import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  CheckCircle2,
  LayoutGrid,
  Loader2,
  Play,
  Plus,
  Redo2,
  Save,
  Undo2,
  X,
  XCircle
} from "lucide-react";
import { PlatformApiError, platformApi } from "./api";
import {
  aggregateStatuses,
  collectNodeIds,
  computeElkLayout,
  computeLayout,
  createNode,
  firstInputName,
  isActiveRun,
  runStatusLabel,
  runStatusTone,
  selfLoopActionLabel,
  stepStatusLabel,
  uniqueNodeId,
  type RunNodeStatus
} from "./layout";
import { PlatformNodeCard, type PlatformFlowNode, type PlatformNodeData } from "./PlatformNodeCard";
import { NodeInspector } from "./NodeInspector";
import { definitionTemporal, useDefinitionHistory } from "./useDefinitionHistory";
import type {
  NodeTypeSpec,
  NodeTypesResponse,
  PlatformIssue,
  RunRecord,
  TraceResponse,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowNode,
  WorkflowSummary,
  WorkflowVariable
} from "./types";
import "./platform.css";

const nodeTypes = { platform: PlatformNodeCard };
const EDGE_COLOR = "#94a3b8";

type Banner = {
  tone: "error" | "success" | "info";
  text: string;
  issues?: PlatformIssue[];
};

export function WorkflowCanvasPage() {
  return (
    <ReactFlowProvider>
      <PlatformWorkspace />
    </ReactFlowProvider>
  );
}

function PlatformWorkspace() {
  const { fitView, getZoom, setCenter } = useReactFlow();
  const [contract, setContract] = useState<NodeTypesResponse>();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflowId, setWorkflowId] = useState<string>();
  const definition = useDefinitionHistory((state) => state.definition);
  const setDefinition = useDefinitionHistory((state) => state.setDefinition);
  const canUndo = useStore(definitionTemporal, (state) => state.pastStates.length > 0);
  const canRedo = useStore(definitionTemporal, (state) => state.futureStates.length > 0);
  const [selectedId, setSelectedId] = useState<string>();
  const [issuesByNode, setIssuesByNode] = useState<Record<string, PlatformIssue[]>>({});
  const [banner, setBanner] = useState<Banner>();
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const [runState, setRunState] = useState<"idle" | "running">("idle");
  const [runOpen, setRunOpen] = useState(false);
  const [subflowPreview, setSubflowPreview] = useState<{ workflowId: string; version?: number }>();
  const [layouting, setLayouting] = useState(false);
  const [trace, setTrace] = useState<TraceResponse>();
  const [runValues, setRunValues] = useState<Record<string, string>>({});
  const [loadToken, setLoadToken] = useState(0);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const fittedTokenRef = useRef(0);
  const runTokenRef = useRef(0);
  const layoutTokenRef = useRef(0);
  const fitTimerRef = useRef<number | undefined>(undefined);
  const definitionRef = useRef<WorkflowDefinition | undefined>(undefined);
  definitionRef.current = definition;

  const [nodes, setNodes, onNodesChange] = useNodesState<PlatformFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const specs = contract?.nodeTypes ?? [];
  const specByKind = useMemo(() => new Map(specs.map((spec) => [spec.kind, spec])), [specs]);
  const topLevelIds = useMemo(() => new Set(definition?.nodes.map((node) => node.id) ?? []), [definition]);
  const runStatuses = useMemo(
    () => (trace ? aggregateStatuses(trace.steps) : new Map<string, RunNodeStatus>()),
    [trace]
  );
  const selectedNode = definition?.nodes.find((node) => node.id === selectedId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [contractResponse, listResponse] = await Promise.all([
          platformApi.nodeTypes(),
          platformApi.listWorkflows()
        ]);
        if (cancelled) {
          return;
        }
        setContract(contractResponse);
        setWorkflows(listResponse.workflows);
        const first = listResponse.workflows[0];
        if (first) {
          const detail = await platformApi.getWorkflow(first.id);
          if (cancelled) {
            return;
          }
          setWorkflowId(detail.workflow.definition.id);
          positionsRef.current = new Map();
          setDefinition(detail.workflow.definition);
          definitionTemporal.getState().clear();
          setRunValues(initialRunValues(detail.workflow.definition));
          setLoadToken((value) => value + 1);
        }
      } catch (error) {
        if (!cancelled) {
          setBanner({ tone: "error", text: describe(error) });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!definition) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const positions = computeLayout(definition);
    // 已上画布的节点（可能来自 ELK 布局）保留真实坐标，新节点才用同步布局兜底
    positionsRef.current = new Map([...positions, ...positionsRef.current]);
    setNodes((current) => {
      const currentById = new Map(current.map((node) => [node.id, node]));
      return definition.nodes.map((node): PlatformFlowNode => {
        const spec = specByKind.get(node.kind);
        const data: PlatformNodeData = {
          definition: node,
          label: spec?.label ?? node.kind,
          accent: spec?.accent ?? "#6366f1",
          status: runStatuses.get(node.id),
          issues: issuesByNode[node.id] ?? []
        };
        const existing = currentById.get(node.id);
        return existing
          ? { ...existing, data }
          : {
              id: node.id,
              type: "platform",
              position: positions.get(node.id) ?? { x: 60, y: 80 },
              data
            };
      });
    });
    setEdges(
      definition.edges.map((edge) => ({
        id: `${edge.from}->${edge.to}`,
        source: edge.from,
        target: edge.to,
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: EDGE_COLOR },
        style: { stroke: EDGE_COLOR, strokeWidth: 1.8 },
        label: edge.label
      }))
    );
  }, [definition, specByKind, runStatuses, issuesByNode, setNodes, setEdges]);

  useEffect(() => {
    if (!loadToken || nodes.length === 0 || fittedTokenRef.current === loadToken) {
      return;
    }
    fittedTokenRef.current = loadToken;
    const timer = window.setTimeout(() => {
      void fitView({ padding: 0.12, duration: 280 });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [loadToken, nodes.length, fitView]);

  useEffect(() => {
    if (!loadToken) {
      return;
    }
    const current = definitionRef.current;
    if (!current || current.nodes.length === 0) {
      return;
    }
    const token = layoutTokenRef.current + 1;
    layoutTokenRef.current = token;
    const definitionId = current.id;
    void (async () => {
      try {
        const positions = await computeElkLayout(current);
        if (layoutTokenRef.current !== token || definitionRef.current?.id !== definitionId) {
          return;
        }
        applyElkPositions(positions);
      } catch {
        // ELK 失败时保留 computeLayout 的同步结果
      }
    })();
  }, [loadToken]);

  useEffect(() => () => window.clearTimeout(fitTimerRef.current), []);

  useEffect(() => {
    if (!runOpen) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRunOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runOpen]);

  useEffect(() => {
    if (!subflowPreview) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSubflowPreview(undefined);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [subflowPreview]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
      if (!isUndo && !isRedo) {
        return;
      }
      if (runOpen || subflowPreview || isEditableTarget(event.target)) {
        return;
      }
      const history = definitionTemporal.getState();
      if (isUndo ? history.pastStates.length === 0 : history.futureStates.length === 0) {
        return;
      }
      event.preventDefault();
      runHistory(isUndo ? "undo" : "redo");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [runOpen, subflowPreview]);

  function applyElkPositions(positions: Map<string, { x: number; y: number }>) {
    if (positions.size === 0) {
      return;
    }
    positionsRef.current = new Map([...positionsRef.current, ...positions]);
    setNodes((current) =>
      current.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position } : node;
      })
    );
    window.clearTimeout(fitTimerRef.current);
    fitTimerRef.current = window.setTimeout(() => {
      void fitView({ padding: 0.12, duration: 280 });
    }, 80);
  }

  function handleAutoLayout() {
    const current = definitionRef.current;
    if (!current || current.nodes.length === 0 || layouting) {
      return;
    }
    const token = layoutTokenRef.current + 1;
    layoutTokenRef.current = token;
    setLayouting(true);
    void (async () => {
      try {
        const positions = await computeElkLayout(current);
        if (layoutTokenRef.current === token && definitionRef.current?.id === current.id) {
          applyElkPositions(positions);
        }
      } catch (error) {
        if (layoutTokenRef.current === token) {
          setBanner({ tone: "error", text: `自动布局失败：${describe(error)}` });
        }
      } finally {
        if (layoutTokenRef.current === token) {
          setLayouting(false);
        }
      }
    })();
  }

  function runHistory(direction: "undo" | "redo") {
    const history = definitionTemporal.getState();
    if (direction === "undo") {
      if (history.pastStates.length === 0) {
        return;
      }
      history.undo();
    } else {
      if (history.futureStates.length === 0) {
        return;
      }
      history.redo();
    }
    setIssuesByNode({});
    setSelectedId(undefined);
    setDirty(true);
  }

  function patchDefinition(updater: (current: WorkflowDefinition) => WorkflowDefinition) {
    setDefinition((current) => (current ? updater(current) : current));
    setIssuesByNode({});
    setDirty(true);
  }

  function selectNode(id: string) {
    setSelectedId(id);
    const position = positionsRef.current.get(id);
    if (position) {
      void setCenter(position.x + 108, position.y + 60, {
        zoom: Math.max(getZoom(), 0.55),
        duration: 240
      });
    }
  }

  function handleSelectWorkflow(id: string) {
    if (id === workflowId) {
      return;
    }
    setLoading(true);
    void platformApi
      .getWorkflow(id)
      .then((response) => {
        setWorkflowId(response.workflow.definition.id);
        positionsRef.current = new Map();
        setDefinition(response.workflow.definition);
        definitionTemporal.getState().clear();
        setSelectedId(undefined);
        setIssuesByNode({});
        setTrace(undefined);
        setBanner(undefined);
        setRunValues(initialRunValues(response.workflow.definition));
        setDirty(false);
        setLoadToken((value) => value + 1);
      })
      .catch((error) => setBanner({ tone: "error", text: describe(error) }))
      .finally(() => setLoading(false));
  }

  function handleAddNode(kind: WorkflowNode["kind"]) {
    if (!definition) {
      return;
    }
    const used = collectNodeIds(definition.nodes);
    const id = uniqueNodeId(kind, used);
    const node = createNode(kind, id, firstInputName(definition));
    patchDefinition((current) => ({
      ...current,
      nodes: [...current.nodes, node],
      edges: selectedId ? [...current.edges, { from: selectedId, to: id }] : current.edges
    }));
    window.setTimeout(() => selectNode(id), 140);
  }

  function handleConnect(connection: Connection) {
    const { source, target } = connection;
    if (!source || !target || source === target) {
      return;
    }
    patchDefinition((current) => ({
      ...current,
      edges: [
        ...current.edges.filter((edge) => !(edge.from === source && edge.to === target)),
        { from: source, to: target }
      ]
    }));
  }

  function handleRemoveNodes(ids: string[]) {
    const removed = new Set(ids);
    patchDefinition((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !removed.has(node.id)),
      edges: current.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to))
    }));
    setSelectedId((current) => (current && removed.has(current) ? undefined : current));
  }

  function updateSelectedNode(next: WorkflowNode) {
    if (!selectedId) {
      return;
    }
    patchDefinition((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (node.id === selectedId ? next : node))
    }));
  }

  async function refreshWorkflows() {
    try {
      const response = await platformApi.listWorkflows();
      setWorkflows(response.workflows);
    } catch {
      // workflow list refresh failure should not block editing
    }
  }

  async function handleSave(): Promise<WorkflowDefinition | undefined> {
    if (!definition) {
      return undefined;
    }
    setSaveState("saving");
    setIssuesByNode({});
    setBanner(undefined);
    try {
      const response = await platformApi.saveWorkflow(definition);
      setDefinition(response.workflow.definition);
      definitionTemporal.getState().clear();
      setWorkflowId(response.workflow.definition.id);
      setDirty(false);
      setBanner({
        tone: "success",
        text: `已保存 · ${response.plan.rootNodes} 个顶层节点 / ${response.plan.stepCount} 个执行步骤 / 最大嵌套 ${response.plan.maxDepth} 层${
          response.plan.subWorkflows ? ` · 引用 ${response.plan.subWorkflows} 个子流程` : ""
        }`
      });
      await refreshWorkflows();
      return response.workflow.definition;
    } catch (error) {
      if (error instanceof PlatformApiError) {
        const ids = new Set(definition.nodes.map((node) => node.id));
        const grouped: Record<string, PlatformIssue[]> = {};
        for (const issue of error.issues) {
          const nodeId = issueNodeId(issue.path, ids);
          if (nodeId) {
            grouped[nodeId] = [...(grouped[nodeId] ?? []), issue];
          }
        }
        setIssuesByNode(grouped);
        setBanner({
          tone: "error",
          text: error.issues.length ? `${error.message}` : error.message,
          issues: error.issues
        });
      } else {
        setBanner({ tone: "error", text: describe(error) });
      }
      return undefined;
    } finally {
      setSaveState("idle");
    }
  }

  async function handleRun() {
    const saved = await handleSave();
    if (!saved) {
      return;
    }

    let input: Record<string, unknown>;
    try {
      input = buildRunInput(saved, runValues);
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
      return;
    }

    const token = runTokenRef.current + 1;
    runTokenRef.current = token;
    setRunState("running");
    setTrace(undefined);
    try {
      const { run } = await platformApi.startRun(saved.id, input);
      let current = await platformApi.trace(run.id);
      if (runTokenRef.current !== token) {
        return;
      }
      setTrace(current);
      while (runTokenRef.current === token && isActiveRun(current.run.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 600));
        current = await platformApi.trace(run.id);
        if (runTokenRef.current === token) {
          setTrace(current);
        }
      }
      setBanner({
        tone: current.run.status === "succeeded" ? "success" : "error",
        text: `${runStatusLabel(current.run.status)} · ${current.steps.length} 条执行记录 · ${current.run.durationMs ?? 0} ms`
      });
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      if (runTokenRef.current === token) {
        setRunState("idle");
      }
    }
  }

  if (loading && !definition) {
    return (
      <div className="platform-page">
        <div className="platform-loading">
          <Loader2 size={18} className="is-spinning" />
          正在加载编排画布…
        </div>
      </div>
    );
  }

  if (!definition) {
    return (
      <div className="platform-page">
        <div className="platform-empty">
          <AlertTriangle size={20} />
          <strong>还没有可编辑的工作流</strong>
          <p>{banner?.text ?? "内置工作流尚未就绪，请检查 /api/platform/health。"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="platform-page">
      <header className="platform-head">
        <div className="platform-head-main">
          <span className="platform-eyebrow">
            Agent 编排平台
            {contract && <em>节点契约 v{contract.version} · {specs.length} 类节点</em>}
          </span>
          <h1>
            {definition.name}
            <span className="platform-version">v{definition.version}</span>
          </h1>
          {definition.description && <p>{definition.description}</p>}
        </div>
        <div className="platform-head-actions">
          <select
            className="platform-select"
            value={workflowId}
            onChange={(event) => handleSelectWorkflow(event.target.value)}
          >
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
          <span className={`platform-save-state ${dirty ? "is-dirty" : ""}`}>
            {saveState === "saving" ? "保存中…" : dirty ? "有未保存修改" : "已同步"}
          </span>
          <button
            type="button"
            className="platform-button is-ghost"
            onClick={() => void handleSave()}
            disabled={saveState === "saving" || runState === "running"}
          >
            {saveState === "saving" ? <Loader2 size={14} className="is-spinning" /> : <Save size={14} />}
            保存
          </button>
          <button
            type="button"
            className="platform-button is-primary"
            onClick={() => setRunOpen(true)}
            disabled={runState === "running" || saveState === "saving"}
          >
            {runState === "running" ? <Loader2 size={14} className="is-spinning" /> : <Play size={14} />}
            运行
          </button>
        </div>
      </header>

      {banner && (
        <div className={`platform-banner is-${banner.tone}`}>
          <div className="platform-banner-line">
            {banner.tone === "error" ? <XCircle size={15} /> : <CheckCircle2 size={15} />}
            <span>{banner.text}</span>
          </div>
          {banner.issues && banner.issues.length > 0 && (
            <ul>
              {banner.issues.map((issue, index) => {
                const nodeId = issueNodeId(issue.path, topLevelIds);
                return (
                  <li key={`${issue.path}-${index}`}>
                    <button type="button" onClick={() => nodeId && selectNode(nodeId)} disabled={!nodeId}>
                      <code>{issue.path}</code>
                      {issue.message}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="platform-toolbar">
        <span className="platform-toolbar-label">添加节点</span>
        {specs.map((spec) => (
          <button
            key={spec.kind}
            type="button"
            className="platform-chip"
            onClick={() => handleAddNode(spec.kind)}
            title={spec.description}
          >
            <span className="platform-chip-dot" style={{ background: spec.accent }} />
            {spec.label}
            <Plus size={12} />
          </button>
        ))}
        <span
          className="platform-toolbar-hint"
          title="只渲染顶层 DAG；并行 / 条件 / 循环容器折叠显示，内部步骤在右侧面板按列表编辑。变量引用 ${节点ID.字段}，条件形如 ${verify.score} < 0.85。"
        >
          选中节点后添加会自动连线 · 画布只渲染顶层 DAG
        </span>
        <div className="platform-toolbar-actions">
          <button
            type="button"
            className="platform-chip"
            onClick={handleAutoLayout}
            disabled={layouting}
            title="用 ELK 重新计算顶层节点位置（不改变 DSL，不会标记未保存）"
          >
            {layouting ? <Loader2 size={12} className="is-spinning" /> : <LayoutGrid size={12} />}
            自动布局
          </button>
          <button
            type="button"
            className="platform-chip"
            onClick={() => runHistory("undo")}
            disabled={!canUndo}
            title="撤销 (⌘/Ctrl+Z)"
          >
            <Undo2 size={12} />
            撤销
          </button>
          <button
            type="button"
            className="platform-chip"
            onClick={() => runHistory("redo")}
            disabled={!canRedo}
            title="重做 (⇧⌘/Ctrl+Shift+Z 或 Ctrl+Y)"
          >
            <Redo2 size={12} />
            重做
          </button>
        </div>
      </div>

      <div className="platform-canvas-wrap">
        <div className="platform-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onNodesDelete={(deleted) => handleRemoveNodes(deleted.map((node) => node.id))}
            onEdgesDelete={(deleted) => {
              const removed = new Set(deleted.map((edge) => `${edge.source}->${edge.target}`));
              patchDefinition((current) => ({
                ...current,
                edges: current.edges.filter((edge) => !removed.has(`${edge.from}->${edge.to}`))
              }));
            }}
            onNodeClick={(_event, node) => selectNode(node.id)}
            onPaneClick={() => setSelectedId(undefined)}
            minZoom={0.25}
            maxZoom={1.6}
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background gap={22} size={1.4} color="#e2e7f0" />
            <Controls showInteractive={false} />
          </ReactFlow>
          <div className="platform-canvas-badge">
            {definition.nodes.length} 个顶层节点 · {definition.edges.length} 条边
            {trace && ` · 上次运行 ${runStatusLabel(trace.run.status)}`}
          </div>
        </div>

        {selectedNode && (
          <div className="platform-side">
            <div className="platform-side-bar">
              <button type="button" className="platform-link" onClick={() => setSelectedId(undefined)}>
                收起节点面板
              </button>
            </div>
            <NodeInspector
              definition={selectedNode}
              spec={specByKind.get(selectedNode.kind)}
              specs={specs}
              commonFields={contract?.commonFields ?? []}
              usedIds={collectNodeIds(definition.nodes)}
              status={runStatuses.get(selectedNode.id)}
              onChange={updateSelectedNode}
              onDelete={() => handleRemoveNodes([selectedNode.id])}
              onOpenSubflow={(workflowId, version) => setSubflowPreview({ workflowId, version })}
            />
          </div>
        )}
      </div>

      {runOpen && (
        <div
          className="platform-modal-backdrop"
          role="presentation"
          onClick={(event) => event.target === event.currentTarget && setRunOpen(false)}
        >
          <div className="platform-modal" role="dialog" aria-modal="true" aria-label="运行工作流">
            <RunPanel
              definition={definition}
              values={runValues}
              runState={runState}
              trace={trace}
              specs={specs}
              onValuesChange={setRunValues}
              onRun={() => void handleRun()}
              onClose={() => setRunOpen(false)}
            />
          </div>
        </div>
      )}

      {subflowPreview && (
        <div
          className="platform-modal-backdrop"
          role="presentation"
          onClick={(event) => event.target === event.currentTarget && setSubflowPreview(undefined)}
        >
          <div
            className="platform-modal platform-subflow-modal"
            role="dialog"
            aria-modal="true"
            aria-label="子工作流只读视图"
          >
            <SubflowPreviewPanel
              workflowId={subflowPreview.workflowId}
              version={subflowPreview.version}
              specs={specs}
              onClose={() => setSubflowPreview(undefined)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

type SubflowPreviewProps = {
  workflowId: string;
  version?: number;
  specs: NodeTypeSpec[];
  onClose: () => void;
};

/** 子流程只读视图：展示引用的 DSL 结构与输入契约，不提供任何编辑入口。 */
function SubflowPreviewPanel({ workflowId, version, specs, onClose }: SubflowPreviewProps) {
  const [detail, setDetail] = useState<WorkflowDetail>();
  const [error, setError] = useState<string>();
  const specByKind = new Map(specs.map((spec) => [spec.kind, spec]));

  useEffect(() => {
    let cancelled = false;
    setDetail(undefined);
    setError(undefined);
    void platformApi
      .getWorkflow(workflowId, version)
      .then((response) => {
        if (!cancelled) {
          setDetail(response.workflow);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(describe(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workflowId, version]);

  const definition = detail?.definition;

  return (
    <div className="platform-subflow-preview">
      <header className="platform-inspector-head">
        <div>
          <span className="platform-inspector-kind">子工作流 · 只读</span>
          <h2>{definition?.name ?? workflowId}</h2>
        </div>
        <button type="button" className="platform-modal-close" aria-label="关闭子流程视图" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <p className="platform-inspector-note">
        子流程在独立输入作用域中执行，trace 以「父节点/子节点」路径展示。这里只查看结构；修改请回到工作流下拉中切换。
      </p>

      {error && <div className="platform-banner is-error">{error}</div>}
      {!definition && !error && (
        <div className="platform-loading">
          <Loader2 size={16} className="is-spinning" />
          正在读取子流程结构…
        </div>
      )}

      {definition && (
        <>
          <div className="platform-subflow-meta">
            <span>ID {definition.id}</span>
            <span>v{definition.version}</span>
            <span>{definition.nodes.length} 个顶层节点</span>
            <span>{definition.inputs.length} 个输入</span>
            <span>{definition.edges.length} 条边</span>
          </div>
          {definition.description && <p className="platform-subflow-desc">{definition.description}</p>}

          {definition.inputs.length > 0 && (
            <section className="platform-subflow-section">
              <h3>输入契约</h3>
              <div className="platform-subflow-inputs">
                {definition.inputs.map((variable) => (
                  <span key={variable.name} data-required={variable.required ? "true" : "false"}>
                    <code>{variable.name}</code>
                    {variable.type}
                    {variable.required ? " · 必填" : ""}
                  </span>
                ))}
              </div>
            </section>
          )}

          <section className="platform-subflow-section">
            <h3>节点结构</h3>
            <SubflowNodeTree nodes={definition.nodes} depth={0} specByKind={specByKind} />
          </section>
        </>
      )}
    </div>
  );
}

function SubflowNodeTree({
  nodes,
  depth,
  specByKind
}: {
  nodes: WorkflowNode[];
  depth: number;
  specByKind: Map<string, NodeTypeSpec>;
}) {
  return (
    <>
      {nodes.map((node) => {
        const spec = specByKind.get(node.kind);
        const children = [
          ...(node.branches ?? []),
          ...(node.then ?? []),
          ...(node.else ?? []),
          ...(node.body ?? [])
        ];
        return (
          <div className="platform-subflow-branch" key={`${node.id}-${depth}`}>
            <div className="platform-subflow-node" style={{ marginLeft: depth * 16 }}>
              <span className="platform-subflow-dot" style={{ background: spec?.accent ?? "#94a3b8" }} />
              <span className="platform-subflow-kind">{spec?.label ?? node.kind}</span>
              <strong>{node.title || node.id}</strong>
              <code>{node.id}</code>
              {children.length > 0 && <small>{children.length} 个内部节点</small>}
            </div>
            {children.length > 0 && (
              <SubflowNodeTree nodes={children} depth={depth + 1} specByKind={specByKind} />
            )}
          </div>
        );
      })}
    </>
  );
}

type RunPanelProps = {
  definition: WorkflowDefinition;
  values: Record<string, string>;
  runState: "idle" | "running";
  trace?: TraceResponse;
  specs: NodeTypesResponse["nodeTypes"];
  onValuesChange: (values: Record<string, string>) => void;
  onRun: () => void;
  onClose: () => void;
};

function RunPanel({
  definition,
  values,
  runState,
  trace,
  specs,
  onValuesChange,
  onRun,
  onClose
}: RunPanelProps) {
  const kindLabels = new Map(specs.map((spec) => [spec.kind, spec.label]));
  const finalScore = trace ? finalScoreOf(trace.run, trace) : undefined;

  return (
    <aside className="platform-run-panel">
      <header>
        <div>
          <span className="platform-inspector-kind">运行</span>
          <h2>运行参数</h2>
        </div>
        <div className="platform-run-head-actions">
          {trace && (
            <span className={`platform-run-status is-${runStatusTone(trace.run.status)}`}>
              {runStatusLabel(trace.run.status)}
            </span>
          )}
          <button type="button" className="platform-modal-close" aria-label="关闭运行面板" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>

      <p className="platform-inspector-note">
        填写参数后运行；执行轨迹与验证分数会写回平台台账，并在画布上给节点着色。
      </p>

      <div className="platform-field-list">
        {definition.inputs.map((variable) => (
          <RunInputField
            key={variable.name}
            variable={variable}
            value={values[variable.name] ?? ""}
            onChange={(value) => onValuesChange({ ...values, [variable.name]: value })}
          />
        ))}
      </div>

      <button
        type="button"
        className="platform-button is-primary platform-run-button"
        onClick={onRun}
        disabled={runState === "running"}
      >
        {runState === "running" ? <Loader2 size={14} className="is-spinning" /> : <Play size={14} />}
        {runState === "running" ? "运行中…" : "运行工作流"}
      </button>

      {trace && (
        <>
          <section className="platform-run-summary">
            <div>
              <span>状态</span>
              <strong>{runStatusLabel(trace.run.status)}</strong>
            </div>
            <div>
              <span>用时</span>
              <strong>{trace.run.durationMs ?? 0} ms</strong>
            </div>
            <div>
              <span>步骤</span>
              <strong>{trace.steps.length}</strong>
            </div>
            <div>
              <span>最终评分</span>
              <strong>{finalScore === undefined ? "—" : finalScore.toFixed(2)}</strong>
            </div>
            <div>
              <span>循环</span>
              <strong>{trace.loopIterations.length} 轮</strong>
            </div>
          </section>

          {trace.verifyResults.length > 0 && (
            <section className="platform-trace-section">
              <h3>验证结果</h3>
              {trace.verifyResults.map((result, index) => (
                <div className="platform-verify-item" key={result.id}>
                  <strong>
                    第 {index + 1} 次验证 · {result.score.toFixed(2)}
                  </strong>
                  <span>置信度 {result.confidence.toFixed(2)}</span>
                  {result.issues[0] && <p>{result.issues[0]}</p>}
                </div>
              ))}
            </section>
          )}

          {trace.loopIterations.length > 0 && (
            <section className="platform-trace-section">
              <h3>循环轮次</h3>
              {trace.loopIterations.map((iteration) => (
                <div className="platform-loop-item" key={iteration.id}>
                  <strong>
                    {iteration.loopNodeId} · 第 {iteration.iteration} 轮
                  </strong>
                  <span>
                    {iteration.scoreBefore === undefined ? "—" : iteration.scoreBefore.toFixed(2)} →{" "}
                    {iteration.scoreAfter === undefined ? "—" : iteration.scoreAfter.toFixed(2)} ·{" "}
                    {selfLoopActionLabel(iteration.action)}
                  </span>
                </div>
              ))}
            </section>
          )}

          <section className="platform-trace-section">
            <h3>执行轨迹</h3>
            <div className="platform-trace-list">
              {trace.steps.map((step) => (
                <div className="platform-trace-step" key={step.id}>
                  <span className="platform-trace-seq">{step.sequence}</span>
                  <div>
                    <code>{step.path}</code>
                    <small>
                      {kindLabels.get(step.nodeKind) ?? step.nodeKind} · {step.durationMs ?? 0} ms
                    </small>
                  </div>
                  <span className={`platform-step-status is-${step.status}`}>{stepStatusLabel(step.status)}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </aside>
  );
}

type RunInputFieldProps = {
  variable: WorkflowVariable;
  value: string;
  onChange: (value: string) => void;
};

function RunInputField({ variable, value, onChange }: RunInputFieldProps) {
  if (variable.type === "boolean") {
    return (
      <label className="platform-field">
        <span>
          {variable.name}
          {variable.required ? " *" : ""}
        </span>
        <select value={value || "false"} onChange={(event) => onChange(event.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>
    );
  }

  if (variable.type === "object") {
    return (
      <label className="platform-field">
        <span>
          {variable.name}
          {variable.required ? " *" : ""}
        </span>
        <textarea
          rows={2}
          value={value}
          placeholder={variable.description ?? 'JSON，例如 ["kb-1"]'}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        <small>{variable.description ?? "按 JSON 填写，留空则不传。"}</small>
      </label>
    );
  }

  return (
    <label className="platform-field">
      <span>
        {variable.name}
        {variable.required ? " *" : ""}
      </span>
      <input
        type={variable.type === "number" ? "number" : "text"}
        value={value}
        placeholder={variable.description ?? variable.name}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
      <small>{variable.type}</small>
    </label>
  );
}

function initialRunValues(definition: WorkflowDefinition): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of definition.inputs) {
    values[variable.name] = variable.type === "boolean" ? "false" : "";
  }
  return values;
}

function buildRunInput(
  definition: WorkflowDefinition,
  values: Record<string, string>
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const variable of definition.inputs) {
    const raw = (values[variable.name] ?? "").trim();
    if (!raw) {
      if (variable.required) {
        throw new Error(`请填写必填输入 ${variable.name}`);
      }
      continue;
    }
    if (variable.type === "number") {
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) {
        throw new Error(`输入 ${variable.name} 需要数字`);
      }
      input[variable.name] = parsed;
    } else if (variable.type === "boolean") {
      input[variable.name] = raw === "true";
    } else if (variable.type === "object") {
      try {
        input[variable.name] = JSON.parse(raw) as unknown;
      } catch {
        throw new Error(`输入 ${variable.name} 不是合法 JSON`);
      }
    } else {
      input[variable.name] = raw;
    }
  }
  return input;
}

function issueNodeId(path: string, ids: Set<string>): string | undefined {
  for (const segment of path.split("/")) {
    if (ids.has(segment)) {
      return segment;
    }
    const head = segment.split(".")[0];
    if (ids.has(head)) {
      return head;
    }
  }
  return undefined;
}

function finalScoreOf(run: RunRecord, trace: TraceResponse): number | undefined {
  const output = run.output as Record<string, unknown> | undefined;
  if (output && typeof output.score === "number") {
    return output.score;
  }
  const last = trace.verifyResults[trace.verifyResults.length - 1];
  return last?.score;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
