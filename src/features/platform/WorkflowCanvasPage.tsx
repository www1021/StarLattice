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
  RefreshCw,
  Save,
  Trash2,
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
const EMPTY_SPECS: NodeTypeSpec[] = [];
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
  const [trialTarget, setTrialTarget] = useState<string>();
  const [inputsOpen, setInputsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [subflowPreview, setSubflowPreview] = useState<{ workflowId: string; version?: number }>();
  const [layouting, setLayouting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
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

  const specs = contract?.nodeTypes ?? EMPTY_SPECS;
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
      void fitView({ padding: 0.1, minZoom: 0.55, duration: 280 });
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
      void fitView({ padding: 0.1, minZoom: 0.55, duration: 280 });
    }, 80);
  }

  function handleRefreshRegistry() {
    if (refreshing) {
      return;
    }
    setRefreshing(true);
    void (async () => {
      try {
        const next = await platformApi.nodeTypes();
        setContract(next);
        setWorkflows((await platformApi.listWorkflows()).workflows);
        const count = (kind: NodeTypeSpec["kind"], key: string = kind) =>
          next.nodeTypes.find((spec) => spec.kind === kind)?.fields.find((field) => field.key === key)
            ?.options?.length ?? 0;
        setBanner({
          tone: "success",
          text: `已刷新注册项：${count("agent")} 个 Agent、${count("tool")} 个工具、${count("subworkflow", "workflowId")} 个工作流。`
        });
      } catch (error) {
        setBanner({ tone: "error", text: `刷新注册项失败：${describe(error)}` });
      } finally {
        setRefreshing(false);
      }
    })();
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

  function handleSaveInputs(inputs: WorkflowVariable[]) {
    patchDefinition((current) => ({ ...current, inputs }));
    setRunValues((current) => {
      const next: Record<string, string> = {};
      for (const variable of inputs) {
        next[variable.name] = current[variable.name] ?? (variable.type === "boolean" ? "false" : "");
      }
      return next;
    });
    setInputsOpen(false);
  }

  function handleCreateWorkflow(draft: WorkflowDefinition) {
    setNewOpen(false);
    setWorkflowId(draft.id);
    positionsRef.current = new Map();
    setDefinition(draft);
    definitionTemporal.getState().clear();
    setSelectedId(undefined);
    setIssuesByNode({});
    setTrace(undefined);
    setRunValues(initialRunValues(draft));
    setDirty(true);
    setLoadToken((value) => value + 1);
    setBanner({ tone: "success", text: "已新建空白流程：添加节点并保存后才会出现在下拉列表里。" });
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
    const options = (specKind: WorkflowNode["kind"], key: string) =>
      specByKind.get(specKind)?.fields.find((field) => field.key === key)?.options ?? [];
    const agentOptions = options("agent", "agent");
    const toolOptions = options("tool", "tool");
    const verifierOptions = options("verify", "verifier");
    const node = createNode(kind, id, {
      input: definition.inputs[0]?.name,
      agent: agentOptions.includes("lesson-plan-agent") ? "lesson-plan-agent" : agentOptions[0],
      tool: toolOptions.includes("knowledge.search") ? "knowledge.search" : toolOptions[0],
      verifier: verifierOptions.includes("observer-verifier") ? "observer-verifier" : verifierOptions[0]
    });
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
    if (definition.nodes.length === 0) {
      setBanner({ tone: "error", text: "空白流程至少添加一个节点才能保存。" });
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
    // 没有未保存修改时直接运行已存版本，避免每次试跑都无谓地升一个版本。
    const saved = dirty ? await handleSave() : definition;
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
    const target = trialTarget;
    try {
      const { run } = await platformApi.startRun(saved.id, input, target);
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
      const targetLabel = target
        ? saved.nodes.find((node) => node.id === target)?.title ?? target
        : undefined;
      setBanner({
        tone: current.run.status === "succeeded" ? "success" : "error",
        text: `${targetLabel ? `试跑到「${targetLabel}」` : ""}${runStatusLabel(current.run.status)} · ${current.steps.length} 条执行记录 · ${current.run.durationMs ?? 0} ms`
      });
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      if (runTokenRef.current === token) {
        setRunState("idle");
      }
    }
  }

  function handleStartTrial(nodeId: string) {
    setTrialTarget(nodeId);
    setTrace(undefined);
    setRunOpen(true);
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
          <button type="button" className="platform-button is-ghost" onClick={() => setNewOpen(true)}>
            <Plus size={14} /> 新建
          </button>
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
            {definition && !workflows.some((workflow) => workflow.id === definition.id) && (
              <option value={definition.id}>{definition.name}（未保存）</option>
            )}
          </select>
          <span className={`platform-save-state ${dirty ? "is-dirty" : ""}`}>
            {saveState === "saving" ? "保存中…" : dirty ? "有未保存修改" : "已同步"}
          </span>
          <button
            type="button"
            className="platform-button is-ghost"
            onClick={() => setInputsOpen(true)}
            disabled={runState === "running"}
          >
            输入定义 · {definition.inputs.length}
          </button>
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
            onClick={() => {
              setTrialTarget(undefined);
              setRunOpen(true);
            }}
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
            onClick={handleRefreshRegistry}
            disabled={refreshing}
            title="重新读取注册中心的 Agent、工具与工作流列表"
          >
            {refreshing ? <Loader2 size={12} className="is-spinning" /> : <RefreshCw size={12} />}
            刷新注册项
          </button>
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
              onTrialRun={() => handleStartTrial(selectedNode.id)}
              trialState={runState}
            />
          </div>
        )}
      </div>

      {newOpen && (
        <div
          className="platform-modal-backdrop"
          role="presentation"
          onClick={(event) => event.target === event.currentTarget && setNewOpen(false)}
        >
          <div className="platform-modal" role="dialog" aria-modal="true" aria-label="新建工作流">
            <NewWorkflowDialog
              existingIds={new Set(workflows.map((workflow) => workflow.id))}
              onCreate={handleCreateWorkflow}
              onClose={() => setNewOpen(false)}
            />
          </div>
        </div>
      )}

      {inputsOpen && (
        <div
          className="platform-modal-backdrop"
          role="presentation"
          onClick={(event) => event.target === event.currentTarget && setInputsOpen(false)}
        >
          <div className="platform-modal" role="dialog" aria-modal="true" aria-label="输入定义">
            <InputsEditor
              inputs={definition.inputs}
              onSave={handleSaveInputs}
              onClose={() => setInputsOpen(false)}
            />
          </div>
        </div>
      )}

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
              trialTarget={trialTarget}
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

type NewWorkflowDialogProps = {
  existingIds: Set<string>;
  onCreate: (draft: WorkflowDefinition) => void;
  onClose: () => void;
};

function NewWorkflowDialog({ existingIds, onCreate, onClose }: NewWorkflowDialogProps) {
  const [name, setName] = useState("");
  const [id, setId] = useState(() => `workflow-${Date.now().toString(36)}`);
  const [description, setDescription] = useState("");
  const trimmedId = id.trim();
  const issues: string[] = [];
  if (!name.trim()) {
    issues.push("请填写流程名称。");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmedId)) {
    issues.push("工作流 ID 只能包含字母、数字、下划线和短横线。");
  } else if (existingIds.has(trimmedId)) {
    issues.push(`工作流 ID "${trimmedId}" 已存在，请换一个。`);
  }

  return (
    <aside className="platform-run-panel platform-new-panel">
      <header>
        <div>
          <span className="platform-inspector-kind">新建</span>
          <h2>空白工作流</h2>
        </div>
        <button type="button" className="platform-modal-close" aria-label="关闭新建工作流" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <p className="platform-inspector-note">
        从空画布开始：拖节点、加连线、定义输入，保存后才进入工作流列表。默认带一个 <code>topic</code> 输入，可在「输入定义」里改名或删除。
      </p>

      <div className="platform-field-list">
        <label className="platform-field">
          <span>流程名称</span>
          <input
            autoFocus
            value={name}
            placeholder="我的教研流程"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="platform-field">
          <span>工作流 ID</span>
          <input value={id} spellCheck={false} onChange={(event) => setId(event.target.value)} />
          <small>创建后不可修改；变量引用与运行记录都靠它定位。</small>
        </label>
        <label className="platform-field">
          <span>说明</span>
          <textarea
            rows={2}
            value={description}
            placeholder="这个流程解决什么问题（可选）"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </div>

      {issues.length > 0 && (
        <ul className="platform-input-issues">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="platform-inputs-actions">
        <button type="button" className="platform-button is-ghost" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="platform-button is-primary"
          disabled={issues.length > 0}
          onClick={() =>
            onCreate({
              id: trimmedId,
              name: name.trim(),
              version: 1,
              ...(description.trim() ? { description: description.trim() } : {}),
              inputs: [{ name: "topic", type: "string", required: true, description: "本次任务的主题" }],
              nodes: [],
              edges: []
            })
          }
        >
          创建空白流程
        </button>
      </div>
    </aside>
  );
}

type InputsEditorProps = {
  inputs: WorkflowVariable[];
  onSave: (inputs: WorkflowVariable[]) => void;
  onClose: () => void;
};

const INPUT_TYPE_LABELS: Record<WorkflowVariable["type"], string> = {
  string: "文本",
  number: "数字",
  boolean: "布尔",
  object: "JSON 对象"
};

function InputsEditor({ inputs, onSave, onClose }: InputsEditorProps) {
  const [draft, setDraft] = useState<WorkflowVariable[]>(() => inputs.map((item) => ({ ...item })));
  const issues = validateInputDraft(draft);

  const update = (index: number, patch: Partial<WorkflowVariable>) => {
    setDraft((current) => current.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  };

  const save = () => {
    onSave(
      draft.map((item) => ({
        name: item.name.trim(),
        type: item.type,
        ...(item.required ? { required: true } : {}),
        ...(item.description?.trim() ? { description: item.description.trim() } : {})
      }))
    );
  };

  return (
    <aside className="platform-run-panel platform-inputs-panel">
      <header>
        <div>
          <span className="platform-inspector-kind">输入</span>
          <h2>输入定义</h2>
        </div>
        <button type="button" className="platform-modal-close" aria-label="关闭输入定义" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <p className="platform-inspector-note">
        运行面板按这里的定义生成字段。改名不会自动改节点里的 <code>{"${input.名称}"}</code> 引用，保存后需要手动同步。
      </p>

      <div className="platform-inputs-list">
        {draft.length === 0 && <p className="platform-inputs-empty">还没有输入。工作流可以没有任何输入。</p>}
        {draft.map((variable, index) => (
          <div className="platform-input-row" key={index}>
            <label className="platform-field">
              <span>名称</span>
              <input
                value={variable.name}
                placeholder="topic"
                spellCheck={false}
                onChange={(event) => update(index, { name: event.target.value })}
              />
            </label>
            <label className="platform-field">
              <span>类型</span>
              <select
                value={variable.type}
                onChange={(event) => update(index, { type: event.target.value as WorkflowVariable["type"] })}
              >
                {Object.entries(INPUT_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="platform-input-required">
              <input
                type="checkbox"
                checked={variable.required === true}
                onChange={(event) => update(index, { required: event.target.checked || undefined })}
              />
              必填
            </label>
            <button
              type="button"
              className="platform-input-remove"
              aria-label={`删除输入 ${variable.name || index + 1}`}
              onClick={() => setDraft((current) => current.filter((_, position) => position !== index))}
            >
              <Trash2 size={14} />
            </button>
            <label className="platform-field is-wide">
              <span>说明</span>
              <input
                value={variable.description ?? ""}
                placeholder="展示给填写者的一句话说明"
                onChange={(event) => update(index, { description: event.target.value })}
              />
            </label>
          </div>
        ))}
      </div>

      {issues.length > 0 && (
        <ul className="platform-input-issues">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}

      <div className="platform-inputs-actions">
        <button
          type="button"
          className="platform-button is-ghost"
          onClick={() => setDraft((current) => [...current, { name: "", type: "string" }])}
        >
          <Plus size={14} /> 添加输入
        </button>
        <button
          type="button"
          className="platform-button is-primary"
          disabled={issues.length > 0}
          onClick={save}
        >
          保存输入
        </button>
      </div>
    </aside>
  );
}

function validateInputDraft(draft: WorkflowVariable[]): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  draft.forEach((variable, index) => {
    const name = variable.name.trim();
    if (!name) {
      issues.push(`第 ${index + 1} 行缺少名称。`);
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      issues.push(`输入名 "${name}" 只能包含字母、数字、下划线和短横线。`);
      return;
    }
    if (seen.has(name)) {
      issues.push(`输入 "${name}" 重复声明。`);
    }
    seen.add(name);
  });
  return issues;
}

type RunPanelProps = {
  definition: WorkflowDefinition;
  values: Record<string, string>;
  runState: "idle" | "running";
  trace?: TraceResponse;
  specs: NodeTypesResponse["nodeTypes"];
  trialTarget?: string;
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
  trialTarget,
  onValuesChange,
  onRun,
  onClose
}: RunPanelProps) {
  const kindLabels = new Map(specs.map((spec) => [spec.kind, spec.label]));
  const finalScore = trace ? finalScoreOf(trace.run, trace) : undefined;
  const trialNode = trialTarget ? definition.nodes.find((node) => node.id === trialTarget) : undefined;
  const trialLabel = trialNode?.title ?? trialTarget;
  const trialStep =
    trialTarget && trace
      ? [...trace.steps].reverse().find((step) => step.nodeId === trialTarget)
      : undefined;

  return (
    <aside className="platform-run-panel">
      <header>
        <div>
          <span className="platform-inspector-kind">{trialTarget ? "试跑" : "运行"}</span>
          <h2>{trialTarget ? "试跑参数" : "运行参数"}</h2>
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
        {trialTarget
          ? `只执行到「${trialLabel}」为止，后续节点保持未执行；参数与整单运行共用。`
          : "填写参数后运行；执行轨迹与验证分数会写回平台台账，并在画布上给节点着色。"}
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
        {runState === "running"
          ? trialTarget
            ? "试跑中…"
            : "运行中…"
          : trialTarget
            ? `试跑到「${trialLabel}」`
            : "运行工作流"}
      </button>

      {trialTarget && (
        <section className="platform-trace-section">
          <h3>试跑输出 · {trialLabel}</h3>
          {trialStep ? (
            <>
              <div className="platform-trial-meta">
                <span>状态 {stepStatusLabel(trialStep.status)}</span>
                <span>用时 {trialStep.durationMs ?? 0} ms</span>
                <span>步骤 {trialStep.sequence}</span>
              </div>
              {trialStep.error && <p className="platform-error-text">{trialStep.error}</p>}
              <pre className="platform-trial-output">{formatJson(trialStep.output)}</pre>
            </>
          ) : (
            <p className="platform-inspector-note">
              {trace ? "该节点本轮没有执行（被条件跳过或运行提前结束）。" : "点击上方按钮试跑，结果会显示在这里。"}
            </p>
          )}
        </section>
      )}

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

function formatJson(value: unknown): string {
  if (value === undefined) {
    return "（无输出）";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
