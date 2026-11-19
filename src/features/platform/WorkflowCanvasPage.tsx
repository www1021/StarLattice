import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { accountSessionStorage } from "../auth/accountStorage";
import { useStore } from "zustand";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
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
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Copy,
  Ellipsis,
  FileText,
  LayoutGrid,
  Loader2,
  Maximize2,
  MessageSquareText,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
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
  containerChildCount,
  createNode,
  defaultEdgeLabel,
  expandedContainerSizes,
  isActiveRun,
  layoutContainer,
  runStatusLabel,
  runStatusTone,
  selfLoopActionLabel,
  stepStatusLabel,
  uniqueNodeId,
  type RunNodeStatus
} from "./layout";
import { WorkflowDebugPanel } from "./WorkflowDebugPanel";
import { PlatformNodeCard, type PlatformFlowNode, type PlatformNodeData } from "./PlatformNodeCard";
import {
  PlatformContainerNode,
  type PlatformContainerData,
  type PlatformContainerFlowNode
} from "./PlatformContainerNode";
import { NodeInspector } from "./NodeInspector";
import { EdgeInspector } from "./EdgeInspector";
import { NodePalette } from "./NodePalette";
import { CanvasContainerContext } from "./canvasContainerContext";
import { CanvasEdgeContext } from "./canvasEdgeContext";
import { CanvasEdgeMarkers, WorkflowEdge } from "./WorkflowEdge";
import { choiceOptionsOf, inferChoicePorts, migrateChoiceEdgePorts } from "./choicePorts";
import { applyTemplate, WORKFLOW_TEMPLATES, type WorkflowTemplate } from "./templates";
import {
  FLAGSHIP_WORKFLOW_BY_SCENE,
  SCENARIO_PACK_FILTERS,
  SCENARIO_PACK_ITEMS,
  filterByPack,
  readScenePreference,
  type ScenarioPackFilter
} from "../../../shared/scenarioPacks";
import { NODE_VISUALS } from "./nodeVisuals";
import { definitionTemporal, useDefinitionHistory } from "./useDefinitionHistory";
import type {
  NodeKind,
  NodeTypeSpec,
  NodeTypesResponse,
  PlatformIssue,
  RunRecord,
  StepRecord,
  TraceResponse,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowNode,
  WorkflowSummary,
  WorkflowVariable
} from "./types";
import "./platform.css";

const nodeTypes = { platform: PlatformNodeCard, container: PlatformContainerNode };
const edgeTypes = { workflow: WorkflowEdge };
type CanvasNode = PlatformFlowNode | PlatformContainerFlowNode;
const EMPTY_SPECS: NodeTypeSpec[] = [];
const EDGE_COLOR = "#bdb0a0";
const PENDING_NODE_KEY = "platform:pending-node";
const CORE_WORKFLOW_IDS = new Set<string>(SCENARIO_PACK_ITEMS.core.workflows);
const FLAGSHIP_WORKFLOW_IDS = new Set<string>(Object.values(FLAGSHIP_WORKFLOW_BY_SCENE));
/** 旗舰地图默认展开的容器；会话流程默认展开循环体，让编排结构一眼可见。 */
const DEMO_CONTAINER_IDS: Record<string, string[]> = {
  "classroom-map-v1": ["rehearse", "quality-gate"],
  "business-map-v1": ["dimensions", "calibration"],
  "classroom-session-v1": ["turns"],
  "counseling-session-v1": ["turns"]
};

/**
 * 当前场景的旗舰地图排最前，其次才是通用流水线与其他流程；
 * 「通用模板」分组里保留 task-report-v1，避免它抢占默认视图。
 */
function orderWorkflowsByPack(
  workflows: WorkflowSummary[],
  preferredFlagship: string
): WorkflowSummary[] {
  const rank = (id: string) =>
    id === preferredFlagship
      ? 0
      : FLAGSHIP_WORKFLOW_IDS.has(id)
        ? 1
        : CORE_WORKFLOW_IDS.has(id)
          ? 2
          : 3;
  return [...workflows].sort((left, right) => rank(left.id) - rank(right.id));
}

function demoContainersFor(definition: WorkflowDefinition): Set<string> {
  const configured = DEMO_CONTAINER_IDS[definition.id] ?? [];
  const available = new Set(
    definition.nodes.filter((node) => containerChildCount(node) > 0).map((node) => node.id)
  );
  return new Set(configured.filter((id) => available.has(id)));
}

function allContainerIds(definition: WorkflowDefinition): string[] {
  return definition.nodes.filter((node) => containerChildCount(node) > 0).map((node) => node.id);
}

function childNodesOf(node: WorkflowNode): WorkflowNode[] {
  return [
    ...(node.branches ?? []),
    ...(node.then ?? []),
    ...(node.else ?? []),
    ...(node.body ?? [])
  ];
}

/** 找到包含目标节点的顶层节点（节点本身或最近的容器）。 */
function topLevelAncestorFor(definition: WorkflowDefinition, nodeId: string): WorkflowNode | undefined {
  const contains = (node: WorkflowNode): boolean =>
    node.id === nodeId || childNodesOf(node).some(contains);
  return definition.nodes.find(contains);
}

type Banner = {
  tone: "error" | "success" | "info";
  text: string;
  issues?: PlatformIssue[];
};

/** 危险操作的二次确认：统一走页内弹层，不用浏览器原生 confirm。 */
type ConfirmRequest =
  | { kind: "delete-workflow"; workflow: WorkflowSummary }
  | { kind: "apply-template"; template: WorkflowTemplate };

type WorkflowCanvasPageProps = {
  newTaskToken?: number;
  openWorkflowId?: string;
  openWorkflowToken?: number;
  openNodeId?: string;
};

export function WorkflowCanvasPage({
  newTaskToken,
  openWorkflowId,
  openWorkflowToken,
  openNodeId
}: WorkflowCanvasPageProps) {
  return (
    <ReactFlowProvider>
      <PlatformWorkspace
        newTaskToken={newTaskToken}
        openWorkflowId={openWorkflowId}
        openWorkflowToken={openWorkflowToken}
        openNodeId={openNodeId}
      />
    </ReactFlowProvider>
  );
}

function PlatformWorkspace({
  newTaskToken,
  openWorkflowId,
  openWorkflowToken,
  openNodeId
}: WorkflowCanvasPageProps) {
  const { fitView, getZoom, setCenter, screenToFlowPosition } = useReactFlow();
  const [contract, setContract] = useState<NodeTypesResponse>();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [workflowId, setWorkflowId] = useState<string>();
  const scenePreference = useMemo(() => readScenePreference(), []);
  const preferredFlagship = FLAGSHIP_WORKFLOW_BY_SCENE[scenePreference];
  const definition = useDefinitionHistory((state) => state.definition);
  const setDefinition = useDefinitionHistory((state) => state.setDefinition);
  const canUndo = useStore(definitionTemporal, (state) => state.pastStates.length > 0);
  const canRedo = useStore(definitionTemporal, (state) => state.futureStates.length > 0);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  /** 点击错误提示跳转到「参数提取」节点时，顺手把检查器滚到出问题的那一行参数。 */
  const [focusParam, setFocusParam] = useState<number | null>(null);
  /** 同一下标连点两次也要重新滚动，用自增计数强制 effect 触发。 */
  const [focusNonce, setFocusNonce] = useState(0);
  const [expandedContainers, setExpandedContainers] = useState<Set<string>>(new Set());
  const [issuesByNode, setIssuesByNode] = useState<Record<string, PlatformIssue[]>>({});
  const [banner, setBanner] = useState<Banner>();
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [debugMode, setDebugMode] = useState(false);
  const [debugState, setDebugState] = useState<"idle" | "checking">("idle");
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const [runState, setRunState] = useState<"idle" | "running">("idle");
  const [runOpen, setRunOpen] = useState(false);
  const [trialTarget, setTrialTarget] = useState<string>();
  const [inputsOpen, setInputsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest>();
  const [subflowPreview, setSubflowPreview] = useState<{ workflowId: string; version?: number }>();
  const [layouting, setLayouting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [trace, setTrace] = useState<TraceResponse>();
  /** 点节点卡片右上角「详情」时，展示哪个节点的运行结果。 */
  const [resultNodeId, setResultNodeId] = useState<string>();
  const [runValues, setRunValues] = useState<Record<string, string>>({});
  const [loadToken, setLoadToken] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [flowMenuOpen, setFlowMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string>();
  /** 悬停的节点：它的出入线会整条变蓝，用来数清这个节点连了几条线。 */
  const [hoveredNodeId, setHoveredNodeId] = useState<string>();
  const [pendingInsertEdge, setPendingInsertEdge] = useState<string>();
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const fittedTokenRef = useRef(0);
  const runTokenRef = useRef(0);
  const layoutTokenRef = useRef(0);
  const fitTimerRef = useRef<number | undefined>(undefined);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const pendingAppliedRef = useRef(false);
  const definitionRef = useRef<WorkflowDefinition | undefined>(undefined);
  definitionRef.current = definition;
  const newTaskTokenRef = useRef(0);
  const requestedWorkflowRef = useRef(openWorkflowId);
  requestedWorkflowRef.current = openWorkflowId;
  const requestedNodeRef = useRef(openNodeId);
  requestedNodeRef.current = openNodeId;
  const openWorkflowTokenRef = useRef(openWorkflowToken);
  openWorkflowTokenRef.current = openWorkflowToken;
  const handledOpenTokenRef = useRef<number | undefined>(openWorkflowToken);

  useEffect(() => {
    if (!newTaskToken || newTaskToken === newTaskTokenRef.current || !definition) {
      return;
    }
    newTaskTokenRef.current = newTaskToken;
    setTrialTarget(undefined);
    setTrace(undefined);
    setRunValues(initialRunValues(definition));
    setRunOpen(true);
  }, [newTaskToken, definition]);

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const specs = contract?.nodeTypes ?? EMPTY_SPECS;
  const specByKind = useMemo(() => new Map(specs.map((spec) => [spec.kind, spec])), [specs]);
  const topLevelIds = useMemo(() => new Set(definition?.nodes.map((node) => node.id) ?? []), [definition]);
  const runStatuses = useMemo(
    () => (trace ? aggregateStatuses(trace.steps) : new Map<string, RunNodeStatus>()),
    [trace]
  );
  /** 选中节点最近一次的报错，挂在输出变量的 Error 分支下展示。 */
  const selectedNodeError = useMemo(() => {
    if (!selectedId) {
      return undefined;
    }
    const steps = trace?.steps ?? [];
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (step.nodeId === selectedId && step.error) {
        return step.error;
      }
    }
    return undefined;
  }, [trace, selectedId]);
  const nodeDurations = useMemo(() => {
    const durations = new Map<string, number>();
    for (const step of trace?.steps ?? []) {
      if (step.status === "skipped") {
        continue;
      }
      const root = step.path.split("/")[0];
      if (!root) {
        continue;
      }
      durations.set(root, (durations.get(root) ?? 0) + (step.durationMs ?? 0));
    }
    return durations;
  }, [trace]);
  /**
   * 出边上挂的分支条件。画布上不再把条件铺在连线旁，统一收进来源节点的卡片里，
   * 免得一串长表达式糊在桌面上把连线和节点都盖住。
   */
  const branchConditions = useMemo(() => {
    const map = new Map<string, Array<{ key: string; when: string }>>();
    for (const edge of definition?.edges ?? []) {
      const when = edge.when?.trim();
      if (!when) {
        continue;
      }
      const list = map.get(edge.from) ?? [];
      list.push({ key: edge.label?.trim() || `条件 ${list.length + 1}`, when });
      map.set(edge.from, list);
    }
    return map;
  }, [definition]);
  const childStatuses = useMemo(() => {
    const statuses = new Map<string, RunNodeStatus>();
    for (const step of trace?.steps ?? []) {
      const parts = step.path.split("/");
      if (parts.length < 2) {
        continue;
      }
      const current = statuses.get(parts[1]);
      if (step.status === "failed") {
        statuses.set(parts[1], "failed");
      } else if (
        (step.status === "running" || step.status === "waiting") &&
        current !== "succeeded" &&
        current !== "failed"
      ) {
        statuses.set(parts[1], "running");
      } else if (step.status === "succeeded" && !current) {
        statuses.set(parts[1], "succeeded");
      } else if (step.status === "skipped" && !current) {
        statuses.set(parts[1], "skipped");
      }
    }
    return statuses;
  }, [trace]);
  const childDurations = useMemo(() => {
    const durations = new Map<string, number>();
    for (const step of trace?.steps ?? []) {
      const parts = step.path.split("/");
      if (parts.length < 2) {
        continue;
      }
      durations.set(parts[1], (durations.get(parts[1]) ?? 0) + (step.durationMs ?? 0));
    }
    return durations;
  }, [trace]);
  /**
   * 本次运行真正跑过的节点。节点的「详情」入口和耗时徽标只对它们显示，
   * 没跑过的节点不该出现一个 0 ms 的假耗时和点开空白的详情。
   */
  const ranNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const step of trace?.steps ?? []) {
      // 被跳过的节点也有一条 step 记录（记跳过原因），但它一秒都没跑，
      // 不能因此挂上 0 ms 的耗时徽标和空白的详情入口。
      if (step.status === "skipped") {
        continue;
      }
      ids.add(step.nodeId);
      const root = step.path.split("/")[0];
      if (root) {
        ids.add(root);
      }
    }
    return ids;
  }, [trace]);
  /** 正卡在人工输入上的节点：不能给它挂耗时，否则会显示成「0 ms 就跑完了」。 */
  const waitingNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const step of trace?.steps ?? []) {
      if (step.status === "waiting") {
        ids.add(step.nodeId);
      }
    }
    return ids;
  }, [trace]);
  const containerBoxes = useMemo(() => {
    const boxes = new Map<string, NonNullable<ReturnType<typeof layoutContainer>>>();
    for (const id of expandedContainers) {
      const node = definition?.nodes.find((item) => item.id === id);
      if (!node) {
        continue;
      }
      const box = layoutContainer(node);
      if (box) {
        boxes.set(id, box);
      }
    }
    return boxes;
  }, [definition, expandedContainers]);
  const expandedKey = useMemo(
    () => [...expandedContainers].sort().join("|"),
    [expandedContainers]
  );
  const nodeById = useMemo(
    () => new Map(definition?.nodes.map((node) => [node.id, node]) ?? []),
    [definition]
  );
  const selectedNode = definition?.nodes.find((node) => node.id === selectedId);
  const selectedEdge = selectedEdgeId
    ? definition?.edges.find((edge) => edgeIdOf(edge) === selectedEdgeId)
    : undefined;
  const pendingEdge = pendingInsertEdge
    ? definition?.edges.find((edge) => edgeIdOf(edge) === pendingInsertEdge)
    : undefined;
  const runScore = trace ? finalScoreOf(trace.run, trace) : undefined;
  const flagshipWorkflows = useMemo(
    () => workflows.filter((workflow) => FLAGSHIP_WORKFLOW_IDS.has(workflow.id)),
    [workflows]
  );
  const coreWorkflows = useMemo(
    () =>
      workflows.filter(
        (workflow) => !FLAGSHIP_WORKFLOW_IDS.has(workflow.id) && CORE_WORKFLOW_IDS.has(workflow.id)
      ),
    [workflows]
  );
  const otherWorkflows = useMemo(
    () =>
      workflows.filter(
        (workflow) => !FLAGSHIP_WORKFLOW_IDS.has(workflow.id) && !CORE_WORKFLOW_IDS.has(workflow.id)
      ),
    [workflows]
  );

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
        const ordered = orderWorkflowsByPack(listResponse.workflows, preferredFlagship);
        setWorkflows(ordered);
        const requested = requestedWorkflowRef.current;
        const first = (requested && ordered.find((item) => item.id === requested)) || ordered[0];
        if (first) {
          handledOpenTokenRef.current = openWorkflowTokenRef.current;
          const detail = await platformApi.getWorkflow(first.id);
          if (cancelled) {
            return;
          }
          setWorkflowId(detail.workflow.definition.id);
          positionsRef.current = new Map();
          const { definition: loaded } = adoptDefinition(detail.workflow.definition);
          definitionTemporal.getState().clear();
          setExpandedContainers(demoContainersFor(loaded));
          focusNodeInDefinition(loaded, requestedNodeRef.current);
          setRunValues(initialRunValues(loaded));
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
    if (
      !openWorkflowId ||
      !openWorkflowToken ||
      openWorkflowToken === handledOpenTokenRef.current ||
      !workflows.some((item) => item.id === openWorkflowId)
    ) {
      return;
    }
    handledOpenTokenRef.current = openWorkflowToken;
    handleSelectWorkflow(openWorkflowId, openNodeId);
  }, [openWorkflowId, openWorkflowToken, openNodeId, workflows]);

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
      const topLevel = definition.nodes.map((node): CanvasNode => {
        const spec = specByKind.get(node.kind);
        const accent = spec?.accent ?? "#a8552c";
        const existing = currentById.get(node.id);
        const position = existing?.position ?? positions.get(node.id) ?? { x: 60, y: 80 };
        const box = containerBoxes.get(node.id);
        if (box) {
          const data: PlatformContainerData = {
            definition: node,
            accent,
            width: box.width,
            height: box.height,
            childCount: containerChildCount(node),
            columns: box.columns,
            onRename: renameNode
          };
          return {
            id: node.id,
            type: "container",
            position,
            data,
            style: { width: box.width, height: box.height },
            zIndex: 0
          };
        }
        const data: PlatformNodeData = {
          definition: node,
          label: spec?.label ?? node.kind,
          accent,
          status: runStatuses.get(node.id),
          waitingForInput: waitingNodeIds.has(node.id),
          durationMs: ranNodeIds.has(node.id) ? nodeDurations.get(node.id) ?? 0 : undefined,
          issues: issuesByNode[node.id] ?? [],
          inputs: inputNamesOf(node, definition),
          branches: branchConditions.get(node.id),
          onShowDetail: ranNodeIds.has(node.id) ? () => setResultNodeId(node.id) : undefined,
          canExpand: containerChildCount(node) > 0,
          expanded: false,
          childCount: containerChildCount(node),
          onRename: renameNode
        };
        return existing && existing.type === "platform"
          ? { ...existing, data }
          : {
              id: node.id,
              type: "platform",
              position,
              data
            };
      });

      const children = [...containerBoxes].flatMap(([ownerId, box]) => {
        return box.children.map((child): CanvasNode => {
          const spec = specByKind.get(child.node.kind);
          const data: PlatformNodeData = {
            definition: child.node,
            label: spec?.label ?? child.node.kind,
            accent: spec?.accent ?? "#a8552c",
            status: childStatuses.get(child.node.id),
            waitingForInput: waitingNodeIds.has(child.node.id),
            durationMs: ranNodeIds.has(child.node.id)
              ? childDurations.get(child.node.id) ?? 0
              : undefined,
            issues: issuesByNode[child.node.id] ?? [],
            inputs: inputNamesOf(child.node, definition),
            branches: branchConditions.get(child.node.id),
            onShowDetail: ranNodeIds.has(child.node.id)
              ? () => setResultNodeId(child.node.id)
              : undefined,
            innerLabel: child.label,
            ownerId,
            canExpand: false,
            expanded: false,
            childCount: 0,
            readOnly: true
          };
          return {
            id: child.node.id,
            type: "platform",
            parentId: ownerId,
            extent: "parent",
            position: { x: child.x, y: child.y },
            data,
            draggable: false,
            deletable: false,
            connectable: false,
            selectable: false,
            focusable: false,
            zIndex: 1
          };
        });
      });

      return [...topLevel, ...children];
    });
    const activeRun = trace ? isActiveRun(trace.run.status) : false;
    // 老流程的选项卡出边没绑端口，按「边上的选项条件 → 剩余端口顺序」补一次，
    // 连线才会落在对应那一行上；规则和运行期共用同一份实现。
    const choiceOptions = new Map<string, string[]>();
    for (const node of definition.nodes) {
      const options = choiceOptionsOf(node);
      if (options.length > 0) {
        choiceOptions.set(node.id, options);
      }
    }
    const inferredPorts = inferChoicePorts(definition.edges, choiceOptions);
    setEdges((current) => {
      const selected = new Set(current.filter((edge) => edge.selected).map((edge) => edge.id));
      const topLevel = definition.edges.map((edge, edgeIndex) => {
        const sourceNode = nodeById.get(edge.from);
        const accent = (sourceNode && specByKind.get(sourceNode.kind)?.accent) || EDGE_COLOR;
        /**
         * 连线的状态只看「上游走完之后有没有把下游推起来」：
         * 上游还在跑（尤其是选项卡在等人输入）时这条边根本没分派，
         * 提前点亮会让用户以为所有分支都在跑。
         */
        const sourceStatus = runStatuses.get(edge.from);
        const targetStatus = runStatuses.get(edge.to);
        const dispatched = sourceStatus === "succeeded";
        // 只有「正在走」需要 activeRun：跑完之后走过的路要留着变蓝，方便回看这一轮怎么走的。
        const running = activeRun && dispatched && targetStatus === "running";
        const done = dispatched && targetStatus === "succeeded";
        // 上游走完了、下游却跳过：这条分支这一轮没被选中，画成灰虚线。
        const skipped = dispatched && targetStatus === "skipped";
        return {
          id: edgeIdOf(edge),
          source: edge.from,
          target: edge.to,
          // 选项卡的一条分支挂在具体选项端口上，连线才能从那一行出发。
          sourceHandle: edge.fromPort ?? inferredPorts.get(edgeIndex),
          type: "workflow",
          // 条件表达式不铺到桌面上：已收进来源节点的卡片，编辑仍在连线面板。
          data: { accent, running, done, skipped },
          selected: selected.has(edgeIdOf(edge)),
          markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: "#c3b7a3" },
          label: edge.label ?? defaultEdgeLabel(sourceNode)
        };
      });
      const inner = [...containerBoxes].flatMap(([ownerId, box]) => {
        const owner = nodeById.get(ownerId);
        const accent = (owner && specByKind.get(owner.kind)?.accent) || EDGE_COLOR;
        return box.edges.map((edge) => ({
          id: `inner:${ownerId}:${edge.from}->${edge.to}`,
          source: edge.from,
          target: edge.to,
          type: "workflow",
          data: {
            accent,
            inner: true,
            ...(() => {
              const fromStatus = childStatuses.get(edge.from);
              const toStatus = childStatuses.get(edge.to);
              const dispatched = fromStatus === "succeeded";
              return {
                running: activeRun && dispatched && toStatus === "running",
                done: dispatched && toStatus === "succeeded",
                skipped: dispatched && toStatus === "skipped"
              };
            })()
          },
          markerEnd: { type: MarkerType.ArrowClosed, width: 11, height: 11, color: "#c3b7a3" },
          selectable: false,
          deletable: false,
          focusable: false,
          zIndex: 0
        }));
      });
      return [...topLevel, ...inner];
    });
  }, [
    definition,
    specByKind,
    nodeById,
    runStatuses,
    nodeDurations,
    branchConditions,
    childStatuses,
    childDurations,
    ranNodeIds,
    waitingNodeIds,
    containerBoxes,
    issuesByNode,
    trace,
    setNodes,
    setEdges
  ]);

  useEffect(() => {
    if (
      selectedEdgeId &&
      !definition?.edges.some((edge) => edgeIdOf(edge) === selectedEdgeId)
    ) {
      setSelectedEdgeId(undefined);
    }
  }, [definition, selectedEdgeId]);

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
    const sizes = expandedContainerSizes(current, expandedContainers);
    void (async () => {
      try {
        const positions = await computeElkLayout(current, sizes);
        if (layoutTokenRef.current !== token || definitionRef.current?.id !== definitionId) {
          return;
        }
        applyElkPositions(positions);
      } catch {
        // ELK 失败时保留 computeLayout 的同步结果
      }
    })();
  }, [loadToken, expandedKey]);

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
    if (!pendingInsertEdge) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPendingInsertEdge(undefined);
        setBanner(undefined);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingInsertEdge]);

  useEffect(() => () => window.clearTimeout(hoverTimerRef.current), []);

  // MCP 服务页「加入画布」把节点写入 sessionStorage，回到画布后落到当前流程。
  useEffect(() => {
    // 等当前工作流真正加载完再落节点，否则重进画布时会用旧定义把补丁覆盖掉。
    if (loading || !definition || pendingAppliedRef.current) {
      return;
    }
    pendingAppliedRef.current = true;
    const raw = accountSessionStorage.getItem(PENDING_NODE_KEY);
    if (!raw) {
      return;
    }
    accountSessionStorage.removeItem(PENDING_NODE_KEY);
    try {
      const pending = JSON.parse(raw) as {
        title?: string;
        tool?: string;
        args?: Record<string, unknown>;
      };
      if (!pending.tool) {
        return;
      }
      const id = uniqueNodeId("mcp-tool", collectNodeIds(definition.nodes));
      const node: WorkflowNode = {
        id,
        kind: "tool",
        title: pending.title || "MCP 工具",
        tool: pending.tool,
        args: pending.args ?? {}
      };
      positionsRef.current.set(id, { x: 80, y: 80 });
      patchDefinition((current) => ({ ...current, nodes: [...current.nodes, node] }));
      window.setTimeout(() => selectNode(id), 220);
      setBanner({ tone: "success", text: `已从 MCP 服务加入工具节点「${node.title}」。` });
    } catch {
      setBanner({ tone: "error", text: "MCP 节点导入失败：数据格式不正确。" });
    }
  }, [definition, loading]);

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
      if (runOpen || subflowPreview || debugMode || isEditableTarget(event.target)) {
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
  }, [runOpen, subflowPreview, debugMode]);

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
        setWorkflows(
          orderWorkflowsByPack((await platformApi.listWorkflows()).workflows, preferredFlagship)
        );
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
        const positions = await computeElkLayout(
          current,
          expandedContainerSizes(current, expandedContainers)
        );
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

  function handleSaveSettings(name: string, description: string) {
    patchDefinition((current) => ({
      ...current,
      name,
      ...(description ? { description } : { description: undefined })
    }));
    setSettingsOpen(false);
    setBanner({ tone: "success", text: "已更新流程信息，记得保存让改动生效。" });
  }

  function handleCreateWorkflow(draft: WorkflowDefinition) {
    setNewOpen(false);
    setWorkflowId(draft.id);
    positionsRef.current = new Map();
    setDefinition(draft);
    definitionTemporal.getState().clear();
    setSelectedId(undefined);
    setSelectedEdgeId(undefined);
    setExpandedContainers(new Set());
    setIssuesByNode({});
    setTrace(undefined);
    setRunValues(initialRunValues(draft));
    setDirty(true);
    setLoadToken((value) => value + 1);
    setBanner({ tone: "success", text: "已新建空白流程：添加节点并保存后才会出现在下拉列表里。" });
  }

  function selectNode(id: string) {
    setSelectedId(id);
    setSelectedEdgeId(undefined);
    const position = positionsRef.current.get(id);
    if (position) {
      void setCenter(position.x + 126, position.y + 80, {
        zoom: Math.max(getZoom(), 0.55),
        duration: 240
      });
    }
  }

  /** 从会话页或运行监控深链到画布时，展开目标节点所在容器并选中它。 */
  function focusNodeInDefinition(current: WorkflowDefinition, nodeId?: string) {
    if (!nodeId) {
      return;
    }
    const ancestor = topLevelAncestorFor(current, nodeId);
    if (!ancestor) {
      return;
    }
    if (containerChildCount(ancestor) > 0) {
      setExpandedContainers((existing) => new Set(existing).add(ancestor.id));
    }
    setSelectedId(ancestor.id);
    setSelectedEdgeId(undefined);
    window.setTimeout(() => {
      const position = positionsRef.current.get(ancestor.id);
      if (position) {
        void setCenter(position.x + 126, position.y + 80, {
          zoom: Math.max(getZoom(), 0.55),
          duration: 240
        });
      }
    }, 360);
  }

  /** 点击错误提示跳转到对应节点：顶层直接选中，容器内的展开祖先容器再选中。 */
  function locateNode(nodeId: string | undefined, paramIndex?: number) {
    if (!nodeId) {
      return;
    }
    if (paramIndex !== undefined) {
      setFocusParam(paramIndex);
      setFocusNonce((value) => value + 1);
    }
    if (topLevelIds.has(nodeId)) {
      selectNode(nodeId);
    } else if (definition) {
      focusNodeInDefinition(definition, nodeId);
    }
  }

  function selectEdge(id: string) {
    setSelectedEdgeId(id);
    setSelectedId(undefined);
  }

  function toggleContainer(id: string) {
    setExpandedContainers((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
    setSelectedId(id);
    setSelectedEdgeId(undefined);
  }

  function applyExpandedView(ids: Iterable<string>) {
    setExpandedContainers(new Set(ids));
    setSelectedId(undefined);
    setSelectedEdgeId(undefined);
    // 等 ELK 按展开尺寸重排后再聚焦，避免视图停在折叠布局的坐标上。
    window.setTimeout(() => {
      void fitView({ padding: 0.08, minZoom: 0.35, duration: 280 });
    }, 520);
  }

  function handleDemoView() {
    const current = definitionRef.current;
    if (!current) {
      return;
    }
    applyExpandedView(demoContainersFor(current));
  }

  function handleExpandAll() {
    const current = definitionRef.current;
    if (!current) {
      return;
    }
    applyExpandedView(allContainerIds(current));
  }

  function updateEdge(
    edgeId: string,
    patch: Partial<Pick<WorkflowDefinition["edges"][number], "label" | "when">>
  ) {
    patchDefinition((current) => ({
      ...current,
      edges: current.edges.map((edge) =>
        edgeIdOf(edge) === edgeId ? { ...edge, ...patch } : edge
      )
    }));
  }

  function deleteEdge(edgeId: string) {
    patchDefinition((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edgeIdOf(edge) !== edgeId)
    }));
    setSelectedEdgeId(undefined);
  }

  /**
   * 打开流程时先把选项卡的老连线补上选项端口。
   * 这些线是「一选项一端口」之前画的，只有 ${节点.choice} == 某选项 的条件、没有 fromPort，
   * 运行期认不出它属于哪个选项，就会出现「选第一项却走兜底」。
   * 这里把推断结果写回定义，保存后即固化；推断不出端口的一律不动，宁可留空也不接到错的选项上。
   */
  function adoptDefinition(raw: WorkflowDefinition): { definition: WorkflowDefinition; migrated: boolean } {
    const { definition: next, changed } = migrateChoiceEdgePorts(raw);
    setDefinition(next);
    if (changed) {
      setDirty(true);
    }
    return { definition: next, migrated: changed };
  }

  function handleSelectWorkflow(id: string, focusNodeId?: string) {
    if (id === workflowId) {
      return;
    }
    setLoading(true);
    void platformApi
      .getWorkflow(id)
      .then((response) => {
        setWorkflowId(response.workflow.definition.id);
        positionsRef.current = new Map();
        const { definition: loaded, migrated } = adoptDefinition(response.workflow.definition);
        definitionTemporal.getState().clear();
        setSelectedId(undefined);
        setSelectedEdgeId(undefined);
        setExpandedContainers(demoContainersFor(loaded));
        focusNodeInDefinition(loaded, focusNodeId);
        setIssuesByNode({});
        setTrace(undefined);
        setBanner(
          migrated
            ? {
                tone: "info",
                text: "已把选项卡的旧连线自动挂到对应选项端口上，保存后生效。"
              }
            : undefined
        );
        setRunValues(initialRunValues(loaded));
        setDirty(false);
        setLoadToken((value) => value + 1);
      })
      .catch((error) => setBanner({ tone: "error", text: describe(error) }))
      .finally(() => setLoading(false));
  }

  function handleAddNode(
    kind: WorkflowNode["kind"],
    options: { position?: { x: number; y: number }; insertEdgeId?: string } = {}
  ) {
    const current = definitionRef.current;
    if (!current) {
      return;
    }
    const insertEdgeId = options.insertEdgeId ?? pendingInsertEdge;
    const insertEdge = insertEdgeId
      ? current.edges.find((edge) => edgeIdOf(edge) === insertEdgeId)
      : undefined;
    if (insertEdgeId && !insertEdge) {
      setPendingInsertEdge(undefined);
      setBanner({ tone: "error", text: "找不到要插入的连线，可能已被删除。" });
      return;
    }
    if (insertEdge && (kind === "start" || kind === "end")) {
      setBanner({ tone: "error", text: "开始 / 结束节点只能位于流程两端，不能插入连线中间。" });
      return;
    }
    if (kind === "start" && current.nodes.some((node) => node.kind === "start")) {
      const existing = current.nodes.find((node) => node.kind === "start");
      setBanner({ tone: "info", text: "每个流程只保留一个开始节点。" });
      if (existing) {
        window.setTimeout(() => selectNode(existing.id), 80);
      }
      return;
    }

    const used = collectNodeIds(current.nodes);
    const id = uniqueNodeId(kind, used);
    const sourceId = insertEdge?.from ?? (kind === "start" ? undefined : selectedId);
    const fieldOptions = (specKind: WorkflowNode["kind"], key: string) =>
      specByKind.get(specKind)?.fields.find((field) => field.key === key)?.options ?? [];
    const agentOptions = fieldOptions("agent", "agent");
    const toolOptions = fieldOptions("tool", "tool");
    const verifierOptions = fieldOptions("verify", "verifier");
    const node = createNode(kind, id, {
      input: current.inputs[0]?.name,
      sourceId,
      agent: agentOptions.includes("lesson-plan-agent") ? "lesson-plan-agent" : agentOptions[0],
      tool: toolOptions.includes("knowledge.search") ? "knowledge.search" : toolOptions[0],
      verifier: verifierOptions.includes("observer-verifier") ? "observer-verifier" : verifierOptions[0]
    });
    // 接在已有节点后面时，新节点默认读取上游产物，而不是继续引用流程输入。
    if (sourceId && kind === "knowledge") {
      node.query = `\${${sourceId}.output}`;
      node.inputs = {};
    }

    const sourcePosition = sourceId ? positionsRef.current.get(sourceId) : undefined;
    const targetPosition = insertEdge ? positionsRef.current.get(insertEdge.to) : undefined;
    const position =
      options.position ??
      (insertEdge
        ? midpoint(sourcePosition, targetPosition)
        : sourcePosition
          ? { x: sourcePosition.x + 330, y: sourcePosition.y }
          : { x: 120, y: 120 });
    positionsRef.current.set(id, position);

    patchDefinition((next) => {
      const rest = insertEdge
        ? next.edges.filter((edge) => edgeIdOf(edge) !== edgeIdOf(insertEdge))
        : next.edges;
      const added = insertEdge
        ? [
            // 插在选项卡分支中间时，前半段继续挂在原来那个选项端口上。
            {
              from: insertEdge.from,
              to: id,
              ...(insertEdge.fromPort ? { fromPort: insertEdge.fromPort } : {})
            },
            { from: id, to: insertEdge.to, ...(insertEdge.label ? { label: insertEdge.label } : {}) }
          ]
        : sourceId && kind !== "start"
          ? [{ from: sourceId, to: id }]
          : [];
      return {
        ...next,
        nodes: [...next.nodes, node],
        edges: [...rest, ...added]
      };
    });
    setPendingInsertEdge(undefined);
    window.setTimeout(() => selectNode(id), 140);
  }

  function validateConnection(
    source?: string | null,
    target?: string | null,
    sourceHandle?: string | null
  ): string | undefined {
    const current = definitionRef.current;
    if (!current) {
      return "画布尚未就绪。";
    }
    if (!source || !target) {
      return "连线缺少起点或终点。";
    }
    if (source === target) {
      return "不能把节点连接到自身。";
    }
    const sourceNode = current.nodes.find((node) => node.id === source);
    const targetNode = current.nodes.find((node) => node.id === target);
    if (!sourceNode || !targetNode) {
      return "连线端点不存在。";
    }
    if (targetNode.kind === "start") {
      return "开始节点只能有出边，不能接收入边。";
    }
    if (sourceNode.kind === "end") {
      return "结束节点只能接收入边，不能再往后连线。";
    }
    if (
      current.edges.some(
        (edge) =>
          edge.from === source &&
          edge.to === target &&
          (edge.fromPort ?? "") === (sourceHandle ?? "")
      )
    ) {
      return "这条连线已经存在。";
    }
    if (pathExists(current.edges, target, source)) {
      return "这条连线会形成环；需要重复执行请改用循环容器。";
    }
    return undefined;
  }

  function handleConnect(connection: Connection) {
    if (debugMode) {
      return;
    }
    const { source, target, sourceHandle } = connection;
    const issue = validateConnection(source, target, sourceHandle);
    if (issue) {
      setBanner({ tone: "error", text: issue });
      return;
    }
    if (!source || !target) {
      return;
    }
    patchDefinition((current) => ({
      ...current,
      edges: [
        ...current.edges,
        // sourceHandle 就是选项卡的选项端口；从卡片中部拖出来的线不带端口，按原语义走。
        { from: source, to: target, ...(sourceHandle ? { fromPort: sourceHandle } : {}) }
      ]
    }));
  }

  function handleEdgeHover(edgeId: string) {
    window.clearTimeout(hoverTimerRef.current);
    setHoveredEdgeId(edgeId);
  }

  function keepEdgeHover(edgeId: string) {
    window.clearTimeout(hoverTimerRef.current);
    setHoveredEdgeId(edgeId);
  }

  function scheduleEdgeLeave() {
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => setHoveredEdgeId(undefined), 160);
  }

  function insertOnEdge(edgeId: string) {
    if (debugMode) {
      return;
    }
    window.clearTimeout(hoverTimerRef.current);
    setHoveredEdgeId(edgeId);
    setPendingInsertEdge(edgeId);
    setSelectedId(undefined);
    setBanner({
      tone: "info",
      text: "已选定连线：在左侧节点库点一个节点，或直接拖到画布，即可插入两端之间。按 Esc 取消。"
    });
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const kind = event.dataTransfer.getData("application/x-platform-node") as NodeKind;
    if (!kind || !NODE_VISUALS[kind]) {
      return;
    }
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    handleAddNode(kind, { position });
  }

  function handleApplyTemplate(template: WorkflowTemplate) {
    const current = definitionRef.current;
    if (!current) {
      return;
    }
    if (current.nodes.length > 0) {
      setConfirmRequest({ kind: "apply-template", template });
      return;
    }
    applyTemplateToCanvas(template);
  }

  function applyTemplateToCanvas(template: WorkflowTemplate) {
    const current = definitionRef.current;
    if (!current) {
      return;
    }
    const next = applyTemplate(current, template);
    positionsRef.current = new Map();
    setDefinition(next);
    definitionTemporal.getState().clear();
    setSelectedId(undefined);
    setSelectedEdgeId(undefined);
    setExpandedContainers(new Set());
    setIssuesByNode({});
    setTrace(undefined);
    setRunValues(initialRunValues(next));
    setDirty(true);
    setTemplateOpen(false);
    setLoadToken((value) => value + 1);
    setBanner({ tone: "success", text: `已应用模板「${template.name}」，保存后才会写入工作流版本。` });
  }

  function handleRemoveNodes(ids: string[]) {
    const removed = new Set(ids);
    patchDefinition((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => !removed.has(node.id)),
      edges: current.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to))
    }));
    setSelectedId((current) => (current && removed.has(current) ? undefined : current));
    setSelectedEdgeId((current) =>
      current && definitionRef.current?.edges.some(
        (edge) => edgeIdOf(edge) === current && (removed.has(edge.from) || removed.has(edge.to))
      )
        ? undefined
        : current
    );
    setExpandedContainers((current) => {
      const next = new Set(current);
      for (const id of removed) {
        next.delete(id);
      }
      return next;
    });
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

  /** 节点标题就地改名：只改展示名，引用走节点 ID，不会断链。 */
  function renameNode(nodeId: string, title: string) {
    patchDefinition((current) => ({
      ...current,
      nodes: renameNodeInTree(current.nodes, nodeId, title)
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
    // 保存前再补一次端口：用户可能是从别的入口拿到的旧定义，落库时必须是带 fromPort 的版本。
    const { definition: prepared } = adoptDefinition(definition);
    try {
      const response = await platformApi.saveWorkflow(prepared);
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

  /** 静态诊断：调试门禁与试跑共用，问题同时挂到画布节点上标红。 */
  async function checkDefinition(target: WorkflowDefinition) {
    const result = await platformApi.diagnoseWorkflow(target);
    const ids = new Set(target.nodes.map((node) => node.id));
    const grouped: Record<string, PlatformIssue[]> = {};
    for (const issue of result.issues) {
      const nodeId = issueNodeId(issue.path, ids);
      if (nodeId) {
        grouped[nodeId] = [...(grouped[nodeId] ?? []), issue];
      }
    }
    setIssuesByNode(grouped);
    return {
      issues: result.issues,
      grouped,
      errors: result.issues.filter((issue) => issue.severity !== "warning")
    };
  }

  /** 调试门禁：先做静态诊断，无阻断问题才进入左画布右聊天的调试视图。 */
  async function handleDebug() {
    if (!definition || debugState === "checking") {
      return;
    }
    setDebugState("checking");
    setIssuesByNode({});
    setBanner(undefined);
    try {
      const { issues, grouped, errors } = await checkDefinition(definition);
      if (errors.length > 0) {
        setBanner({
          tone: "error",
          text: `调试前检查发现 ${errors.length} 处问题，请先修复标红节点`,
          issues
        });
        return;
      }
      const warnings = issues.length - errors.length;
      // startRun 只认已入库的 workflowId：未保存改动或新建草稿都要先落库。
      const isStored = workflows.some((workflow) => workflow.id === definition?.id);
      const saved = dirty || !isStored ? await handleSave() : definition;
      if (!saved) {
        return;
      }
      // handleSave 会清空 issuesByNode，这里恢复 warning 的节点高亮。
      setIssuesByNode(grouped);
      setTrace(undefined);
      setSelectedEdgeId(undefined);
      setDebugMode(true);
      setBanner({
        tone: warnings > 0 ? "info" : "success",
        text:
          warnings > 0
            ? `静态检查通过，有 ${warnings} 条提示，已进入调试视图`
            : "静态检查通过，已进入调试视图",
        ...(warnings > 0 ? { issues } : {})
      });
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    } finally {
      setDebugState("idle");
    }
  }

  /**
   * 退出调试：连带把这一轮运行的痕迹清掉。
   * 否则关掉对话面板后画布上还挂着耗时、详情按钮和状态点，像刚跑过一样。
   */
  function handleExitDebug() {
    setDebugMode(false);
    setTrace(undefined);
    setResultNodeId(undefined);
    setIssuesByNode({});
    setSelectedEdgeId(undefined);
  }

  async function handleRun() {
    // 没有未保存修改时直接运行已存版本，避免每次试跑都无谓地升一个版本。
    const saved = dirty ? await handleSave() : definition;
    if (!saved) {
      return;
    }

    // 试跑同样要过门禁：没连线、必填项为空的工作流不允许跑。
    try {
      const { issues, errors } = await checkDefinition(saved);
      if (errors.length > 0) {
        setBanner({
          tone: "error",
          text: `运行前检查发现 ${errors.length} 处问题，请先修复标红节点`,
          issues
        });
        return;
      }
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
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

  const resultStep = resultNodeId
    ? [...(trace?.steps ?? [])].reverse().find((step) => step.nodeId === resultNodeId)
    : undefined;
  const resultNodeTitle = resultNodeId
    ? definition.nodes.find((node) => node.id === resultNodeId)?.title ?? resultNodeId
    : "";

  function handleDeleteWorkflow(workflow: WorkflowSummary) {
    if (workflow.source !== "custom") {
      return;
    }
    setConfirmRequest({ kind: "delete-workflow", workflow });
  }

  async function runDeleteWorkflow(workflow: WorkflowSummary) {
    try {
      await platformApi.deleteWorkflow(workflow.id);
      const remaining = workflows.filter((item) => item.id !== workflow.id);
      setWorkflows(remaining);
      setFlowMenuOpen(false);
      setBanner({ tone: "success", text: `已删除工作流「${workflow.name}」。` });
      if (workflow.id === definition?.id) {
        const next = remaining[0];
        if (next) handleSelectWorkflow(next.id);
      }
    } catch (error) {
      setBanner({ tone: "error", text: describe(error) });
    }
  }

  function handleConfirmRequest(request: ConfirmRequest) {
    setConfirmRequest(undefined);
    if (request.kind === "delete-workflow") {
      void runDeleteWorkflow(request.workflow);
      return;
    }
    applyTemplateToCanvas(request.template);
  }

  function renderFlowItem(workflow: WorkflowSummary) {
    const isCustom = workflow.source === "custom";
    return (
      <div className="platform-flow-item" key={workflow.id}>
        <button
          type="button"
          role="menuitem"
          className={`platform-flow-select${workflow.id === definition?.id ? " is-current" : ""}`}
          title={workflow.description || workflow.name}
          onClick={() => {
            setFlowMenuOpen(false);
            handleSelectWorkflow(workflow.id);
          }}
        >
          <span className="platform-flow-item-name">{workflow.name}</span>
          {isCustom && <em className="platform-flow-own">我的</em>}
        </button>
        {isCustom && (
          <button
            type="button"
            className="platform-flow-delete"
            title="删除这条工作流"
            aria-label={`删除 ${workflow.name}`}
            onClick={() => void handleDeleteWorkflow(workflow)}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="platform-page">
      <header className="platform-head">
        <div className="platform-head-main">
          <div className="platform-flow-picker">
            <button
              type="button"
              className="platform-flow-name"
              title={definition.description || "切换工作流"}
              aria-expanded={flowMenuOpen}
              onClick={() => setFlowMenuOpen((value) => !value)}
            >
              {definition.name}
              <ChevronDown size={15} />
            </button>
            <span className={`platform-save-state ${dirty ? "is-dirty" : ""}`}>
              {saveState === "saving" ? "保存中…" : dirty ? "有未保存修改" : "已同步"}
            </span>

            {flowMenuOpen && (
              <div className="platform-flow-menu" role="menu">
                <div className="platform-flow-menu-head">
                  <span>切换到其他流程</span>
                  <button
                    type="button"
                    className="platform-link"
                    onClick={() => {
                      setFlowMenuOpen(false);
                      setNewOpen(true);
                    }}
                  >
                    <Plus size={12} /> 新建
                  </button>
                </div>
                <div className="platform-flow-menu-list">
                  {flagshipWorkflows.length > 0 && <h5>旗舰地图</h5>}
                  {flagshipWorkflows.map(renderFlowItem)}
                  {coreWorkflows.length > 0 && <h5>通用模板</h5>}
                  {coreWorkflows.map(renderFlowItem)}
                  {otherWorkflows.length > 0 && <h5>其他流程</h5>}
                  {otherWorkflows.map(renderFlowItem)}
                </div>
              </div>
            )}
          </div>
          <p className="platform-head-meta">
            {definition.nodes.length} 节点 · {definition.edges.length} 连线 ·{" "}
            {scenePreference === "education" ? "教育场景" : "经营分析"}
            {workflows.find((item) => item.id === definition.id)?.source === "custom"
              ? " · 我的流程"
              : " · 内置流程"}
          </p>
        </div>
        <div className="platform-head-actions">
          <button
            type="button"
            className="platform-button is-ghost"
            onClick={() => void handleSave()}
            disabled={saveState === "saving" || runState === "running" || debugMode}
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
            disabled={runState === "running" || saveState === "saving" || debugMode}
          >
            {runState === "running" ? <Loader2 size={14} className="is-spinning" /> : <Play size={14} />}
            运行
          </button>
          <div className="platform-more">
            <button
              type="button"
              className="platform-icon-button"
              aria-label="更多操作"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((value) => !value)}
            >
              <Ellipsis size={16} />
            </button>
            {moreOpen && (
              <div className="platform-more-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreOpen(false);
                    setSettingsOpen(true);
                  }}
                >
                  <Settings size={13} />
                  流程设置
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={runState === "running" || debugMode}
                  onClick={() => {
                    setMoreOpen(false);
                    setInputsOpen(true);
                  }}
                >
                  <FileText size={13} />
                  输入定义 · {definition.inputs.length}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={debugState === "checking" || runState === "running"}
                  onClick={() => {
                    setMoreOpen(false);
                    if (debugMode) {
                      handleExitDebug();
                    } else {
                      void handleDebug();
                    }
                  }}
                >
                  {debugState === "checking" ? (
                    <Loader2 size={13} className="is-spinning" />
                  ) : debugMode ? (
                    <X size={13} />
                  ) : (
                    <MessageSquareText size={13} />
                  )}
                  {debugMode ? "退出调试" : "调试运行"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={refreshing}
                  onClick={() => {
                    setMoreOpen(false);
                    handleRefreshRegistry();
                  }}
                >
                  {refreshing ? (
                    <Loader2 size={13} className="is-spinning" />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  刷新注册项
                </button>
                <span className="platform-more-sep" />
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canUndo || debugMode}
                  onClick={() => runHistory("undo")}
                >
                  <Undo2 size={13} />
                  撤销
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!canRedo || debugMode}
                  onClick={() => runHistory("redo")}
                >
                  <Redo2 size={13} />
                  重做
                </button>
              </div>
            )}
          </div>
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
                const targetId = issue.nodeId ?? issueNodeId(issue.path, topLevelIds);
                const locatable = Boolean(targetId);
                return (
                  <li key={`${issue.path}-${index}`}>
                    <button
                      type="button"
                      onClick={() => locateNode(targetId, issue.paramIndex)}
                      disabled={!locatable}
                      title={locatable ? "点击跳转到对应节点修改" : "工作流级问题，请在画布或输入映射里检查"}
                    >
                      <code>{issue.path}</code>
                      <span>{issue.message}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {trace && (
        <div className={`platform-run-strip is-${runStatusTone(trace.run.status)}`}>
          <span className="platform-run-strip-dot" />
          <strong>{runStatusLabel(trace.run.status)}</strong>
          <span className="platform-run-strip-mode">
            {trace.run.mode === "live" ? "Live 模型" : "Stub 演示"}
          </span>
          <div className="platform-run-strip-metrics">
            <span>
              <Activity size={12} /> {trace.steps.length} 步
            </span>
            <span>
              <Clock3 size={12} /> {trace.run.durationMs ?? 0} ms
            </span>
            <span>
              <ShieldCheck size={12} /> {runScore === undefined ? "未评分" : runScore.toFixed(2)}
            </span>
          </div>
          <button type="button" className="platform-run-strip-link" onClick={() => setRunOpen(true)}>
            查看轨迹
          </button>
          <button
            type="button"
            className="platform-icon-button"
            title="收起运行摘要"
            aria-label="收起运行摘要"
            onClick={() => setTrace(undefined)}
          >
            <X size={13} />
          </button>
        </div>
      )}

      <div
        className={`platform-canvas-wrap ${paletteOpen && !debugMode ? "has-palette" : "is-palette-collapsed"}${
          debugMode ? " is-debugging" : ""
        }`}
      >
        {!debugMode && (
          <NodePalette
            specs={specs}
            open={paletteOpen}
            onToggle={() => setPaletteOpen((value) => !value)}
            onAdd={(kind) => handleAddNode(kind)}
            inputs={definition.inputs}
            onOpenInputs={() => setInputsOpen(true)}
            templateSlot={<TemplateCards compact onApply={handleApplyTemplate} />}
          />
        )}
        <div
          className="platform-canvas"
          onDragOver={(event) => {
            if (debugMode) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            if (!debugMode) {
              handleDrop(event);
            }
          }}
        >
          <CanvasContainerContext.Provider
            value={{ isExpanded: (id) => expandedContainers.has(id), toggle: toggleContainer }}
          >
            <CanvasEdgeContext.Provider
              value={{ hoveredEdgeId, hoveredNodeId, keepEdgeHover, scheduleEdgeLeave, insertOnEdge }}
            >
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={handleConnect}
                // 从端口拖线时浏览器会顺手把卡片上的文字整片选中，拖完还挂着蓝色高亮。
                // 拖线期间全局禁选，结束（无论连没连上）再放开。
                onConnectStart={() => {
                  document.body.classList.add("is-linking");
                  window.getSelection()?.removeAllRanges();
                  // 兜一层：手势被意外打断时 onConnectEnd 可能不触发，
                  // 否则整张画布会一直处于禁止选中的状态。
                  window.addEventListener(
                    "pointerup",
                    () => document.body.classList.remove("is-linking"),
                    { once: true }
                  );
                }}
                onConnectEnd={() => {
                  document.body.classList.remove("is-linking");
                  window.getSelection()?.removeAllRanges();
                }}
                isValidConnection={(connection) =>
                  validateConnection(connection.source, connection.target, connection.sourceHandle) ===
                  undefined
                }
                onNodesDelete={(deleted) => {
                  if (!debugMode) {
                    handleRemoveNodes(deleted.map((node) => node.id));
                  }
                }}
                onEdgesDelete={(deleted) => {
                  if (debugMode) {
                    return;
                  }
                  const removable = deleted.filter((edge) => !edge.data?.inner);
                  const removed = new Set(
                    removable.map((edge) => edgeKeyOf(edge.source, edge.target, edge.sourceHandle))
                  );
                  if (removed.size === 0) {
                    return;
                  }
                  patchDefinition((current) => ({
                    ...current,
                    edges: current.edges.filter((edge) => !removed.has(edgeIdOf(edge)))
                  }));
                  setSelectedEdgeId((current) =>
                    current && removed.has(current) ? undefined : current
                  );
                }}
                onNodeClick={(_event, node) => {
                  const data = node.data as PlatformNodeData | PlatformContainerData;
                  selectNode("ownerId" in data && data.ownerId ? data.ownerId : node.id);
                }}
                nodesDraggable={!debugMode}
                nodesConnectable={!debugMode}
                elementsSelectable
                onNodeDragStop={(_event, node) => {
                  if (!node.parentId) {
                    positionsRef.current.set(node.id, node.position);
                  }
                }}
                onEdgeClick={(_event, edge) => {
                  if (!edge.data?.inner) {
                    selectEdge(edge.id);
                  }
                }}
                onPaneClick={() => {
                  setSelectedId(undefined);
                  setSelectedEdgeId(undefined);
                  setHoveredNodeId(undefined);
                }}
                onEdgeMouseEnter={(_event, edge) => handleEdgeHover(edge.id)}
                onEdgeMouseLeave={scheduleEdgeLeave}
                onNodeMouseEnter={(_event, node) => setHoveredNodeId(node.id)}
                onNodeMouseLeave={() => setHoveredNodeId(undefined)}
                connectionLineStyle={{ stroke: "var(--edge-focus)", strokeWidth: 2, strokeDasharray: "6 5" }}
                minZoom={0.25}
                maxZoom={1.6}
                deleteKeyCode={debugMode ? null : ["Backspace", "Delete"]}
              >
                <CanvasEdgeMarkers />
                <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#dbd0be" />
                <Controls showInteractive={false} />
                <MiniMap
                  className="platform-minimap"
                  pannable
                  zoomable
                  nodeBorderRadius={7}
                  nodeStrokeWidth={2}
                  maskColor="rgba(247, 249, 252, 0.78)"
                  nodeColor={() => "#b9bec6"}
                  nodeStrokeColor={() => "#c8ccd2"}
                />
                {pendingEdge && (
                  <div className="platform-insert-hint">
                    <Sparkles size={13} />
                    <span>
                      正在为 <code>{pendingEdge.from}</code> → <code>{pendingEdge.to}</code> 选择插入节点
                    </span>
                    <button type="button" onClick={() => setPendingInsertEdge(undefined)}>
                      取消
                    </button>
                  </div>
                )}
              </ReactFlow>
            </CanvasEdgeContext.Provider>
          </CanvasContainerContext.Provider>
          {!debugMode && (
            <div className={`platform-canvas-tools${selectedNode || selectedEdge ? " is-shifted" : ""}`}>
              <button
                type="button"
                title="自动布局：用 ELK 重算节点位置，不改变编排内容"
                aria-label="自动布局"
                disabled={layouting}
                onClick={handleAutoLayout}
              >
                {layouting ? <Loader2 size={14} className="is-spinning" /> : <LayoutGrid size={14} />}
              </button>
              <button
                type="button"
                title="展开全部容器，查看完整编排"
                aria-label="展开全部容器"
                onClick={handleExpandAll}
              >
                <Maximize2 size={14} />
              </button>
              <button
                type="button"
                title="演示视图：展开关键容器并聚焦整张地图"
                aria-label="演示视图"
                onClick={handleDemoView}
              >
                <Sparkles size={14} />
              </button>
            </div>
          )}
          <div className="platform-canvas-badge">
            {definition.nodes.length} 个顶层节点 · {definition.edges.length} 条边
            {expandedContainers.size > 0 ? ` · 展开 ${expandedContainers.size} 个容器` : ""}
            {trace && ` · 上次运行 ${runStatusLabel(trace.run.status)}`}
          </div>
          {definition.nodes.length === 0 && (
            <CanvasEmptyState onApply={handleApplyTemplate} onOpenPalette={() => setPaletteOpen(true)} />
          )}
        </div>

        {debugMode ? (
          <WorkflowDebugPanel
            definition={definition}
            workflowId={definition.id}
            onTrace={setTrace}
            onRunningChange={(running) => setRunState(running ? "running" : "idle")}
            onSelectNode={(id, paramIndex) => locateNode(id, paramIndex)}
            onClose={handleExitDebug}
          />
        ) : selectedEdge ? (
          <div className="platform-side">
            <div className="platform-side-bar">
              <button type="button" className="platform-link" onClick={() => setSelectedEdgeId(undefined)}>
                收起连线面板
              </button>
            </div>
            <EdgeInspector
              edge={selectedEdge}
              source={nodeById.get(selectedEdge.from)}
              target={nodeById.get(selectedEdge.to)}
              siblingGated={(definition?.edges ?? []).some(
                (edge) =>
                  edge.from === selectedEdge.from &&
                  edge !== selectedEdge &&
                  Boolean(edge.when?.trim())
              )}
              onChange={(patch) => updateEdge(selectedEdgeId!, patch)}
              onDelete={() => deleteEdge(selectedEdgeId!)}
              onClose={() => setSelectedEdgeId(undefined)}
            />
          </div>
        ) : selectedNode ? (
          <div className="platform-side">
            <NodeInspector
              definition={selectedNode}
              workflow={definition}
              spec={specByKind.get(selectedNode.kind)}
              specs={specs}
              commonFields={contract?.commonFields ?? []}
              usedIds={collectNodeIds(definition.nodes)}
              status={runStatuses.get(selectedNode.id)}
              lastError={selectedNodeError}
              onChange={updateSelectedNode}
              onDelete={() => handleRemoveNodes([selectedNode.id])}
              onOpenSubflow={(workflowId, version) => setSubflowPreview({ workflowId, version })}
              onTrialRun={() => handleStartTrial(selectedNode.id)}
              trialState={runState}
              focusParamIndex={focusParam}
              focusParamNonce={focusNonce}
              onClose={() => {
                setFocusParam(null);
                setSelectedId(undefined);
              }}
            />
          </div>
        ) : null}
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

      {settingsOpen && (
        <div
          className="platform-modal-backdrop"
          role="presentation"
          onClick={(event) => event.target === event.currentTarget && setSettingsOpen(false)}
        >
          <div className="platform-modal" role="dialog" aria-modal="true" aria-label="流程设置">
            <WorkflowSettingsForm
              definition={definition}
              onSave={handleSaveSettings}
              onClose={() => setSettingsOpen(false)}
            />
          </div>
        </div>
      )}

      {resultNodeId && (
        <div
          className="platform-modal-backdrop"
          role="presentation"
          onClick={(event) => event.target === event.currentTarget && setResultNodeId(undefined)}
        >
          <div
            className="platform-modal platform-node-result"
            role="dialog"
            aria-modal="true"
            aria-label="运行结果"
          >
            <div className="nr-panel">
              <header className="nr-head">
                <div>
                  <strong>运行结果</strong>
                  <span>{resultNodeTitle}</span>
                </div>
                <button
                  type="button"
                  className="platform-modal-close"
                  title="关闭"
                  onClick={() => setResultNodeId(undefined)}
                >
                  <X size={14} />
                </button>
              </header>
              {resultStep ? (
                <>
                  <p className="nr-meta">
                    状态 {resultStep.status} · 耗时 {resultStep.durationMs ?? 0} ms
                    {resultStep.error ? ` · ${resultStep.error}` : ""}
                  </p>
                  <ResultSection title="输入变量" value={resultStep.input} />
                  <ResultSection title="输出变量" value={resultStep.output} />
                </>
              ) : (
                <p className="nr-empty">这个节点还没有运行记录，先跑一轮工作流再看。</p>
              )}
            </div>
          </div>
        </div>
      )}

      {templateOpen && (
        <div
          className="platform-modal-backdrop"
          role="presentation"
          onClick={(event) => event.target === event.currentTarget && setTemplateOpen(false)}
        >
          <div
            className="platform-modal platform-template-modal"
            role="dialog"
            aria-modal="true"
            aria-label="模板库"
          >
            <aside className="platform-run-panel platform-template-panel">
              <header>
                <div>
                  <span className="platform-inspector-kind">模板库</span>
                  <h2>从模板开始</h2>
                </div>
                <button
                  type="button"
                  className="platform-modal-close"
                  aria-label="关闭模板库"
                  onClick={() => setTemplateOpen(false)}
                >
                  <X size={16} />
                </button>
              </header>
              <p className="platform-inspector-note">
                模板会替换当前画布的输入、节点与连线。应用后先检查 Agent / 验证器是否已注册，再保存为新版本。
              </p>
              <TemplateCards onApply={handleApplyTemplate} />
            </aside>
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

      {confirmRequest && (
        <div
          className="platform-modal-backdrop platform-confirm-backdrop"
          role="presentation"
          onClick={(event) => event.target === event.currentTarget && setConfirmRequest(undefined)}
        >
          <ConfirmDialog
            request={confirmRequest}
            onConfirm={() => handleConfirmRequest(confirmRequest)}
            onClose={() => setConfirmRequest(undefined)}
          />
        </div>
      )}
    </div>
  );
}

type ConfirmDialogProps = {
  request: ConfirmRequest;
  onConfirm: () => void;
  onClose: () => void;
};

function ConfirmDialog({ request, onConfirm, onClose }: ConfirmDialogProps) {
  const isDelete = request.kind === "delete-workflow";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <aside
      className="platform-confirm-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="platform-confirm-title"
    >
      <span className={`platform-confirm-icon${isDelete ? " is-danger" : ""}`} aria-hidden="true">
        {isDelete ? <Trash2 size={17} /> : <Sparkles size={17} />}
      </span>
      <div className="platform-confirm-body">
        <h2 id="platform-confirm-title">{isDelete ? "删除工作流" : "覆盖当前画布"}</h2>
        <p>
          {isDelete
            ? `「${request.workflow.name}」的所有版本都会移除，运行记录会保留，此操作无法撤销。`
            : `应用「${request.template.name}」会替换画布上现有的节点与连线，未保存的改动将丢失。`}
        </p>
      </div>
      <div className="platform-confirm-actions">
        <button type="button" className="platform-button is-ghost" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className={`platform-button ${isDelete ? "is-danger" : "is-primary"}`}
          onClick={onConfirm}
        >
          {isDelete ? "删除" : "覆盖并应用"}
        </button>
      </div>
    </aside>
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
              <span className="platform-subflow-dot" style={{ background: spec?.accent ?? "#bdb0a0" }} />
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
            placeholder="我的任务流程"
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

const DESCRIPTION_MAX = 200;

/** 流程设置弹窗：改工作流名称和描述，保存后随下一次「保存」一起落库。 */
function WorkflowSettingsForm({
  definition,
  onSave,
  onClose
}: {
  definition: WorkflowDefinition;
  onSave: (name: string, description: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(definition.name);
  const [description, setDescription] = useState(definition.description ?? "");
  const nameInvalid = !name.trim();

  return (
    <aside className="platform-run-panel platform-settings-panel">
      <header>
        <div>
          <span className="platform-inspector-kind">设置</span>
          <h2>编辑工作流</h2>
        </div>
        <button type="button" className="platform-modal-close" aria-label="关闭流程设置" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      <label className="platform-field">
        <span>工作流名称</span>
        <input
          value={name}
          placeholder="给流程起个名字"
          spellCheck={false}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !nameInvalid) {
              onSave(name.trim(), description.trim());
            }
          }}
        />
      </label>

      <label className="platform-field is-wide">
        <span>工作流描述</span>
        <textarea
          value={description}
          rows={4}
          maxLength={DESCRIPTION_MAX}
          placeholder="一句话说明这个流程做什么、什么时候用"
          onChange={(event) => setDescription(event.target.value)}
        />
        <small className="platform-field-counter">
          {description.length} / {DESCRIPTION_MAX}
        </small>
      </label>

      <p className="platform-inspector-note">
        名称和描述只影响展示；改完要点右上角「保存」，才会同步到流程列表和对话页的流程选择器。
      </p>

      <div className="platform-inputs-actions">
        <button type="button" className="platform-button is-ghost" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="platform-button is-primary"
          disabled={nameInvalid}
          onClick={() => onSave(name.trim(), description.trim())}
        >
          保存
        </button>
      </div>
    </aside>
  );
}

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
        ...(item.description?.trim() ? { description: item.description.trim() } : {}),
        // 编辑输入参数时别把声明好的默认值抹掉（之前保存一次就全变空）。
        ...(item.defaultValue === undefined ? {} : { defaultValue: item.defaultValue })
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

/** 深度改名：容器 body 里的节点也改得到；引用走节点 ID，改标题不断链。 */
function renameNodeInTree(nodes: WorkflowNode[], nodeId: string, title: string): WorkflowNode[] {
  return nodes.map((node) => {
    if (node.id === nodeId) {
      return { ...node, title };
    }
    if (node.body?.length) {
      return { ...node, body: renameNodeInTree(node.body, nodeId, title) };
    }
    return node;
  });
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
  const clarifyStep = trace
    ? [...trace.steps].reverse().find((step) => step.nodeKind === "clarify" && step.status === "succeeded")
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

          {clarifyStep && <ClarifyTraceCard step={clarifyStep} />}

          {trace.run.status === "waiting_input" && (
            <p className="platform-inspector-note">
              运行在意图澄清处暂停：请到「运行监控」回答澄清问题后继续。
            </p>
          )}

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
                    {iteration.modelBefore &&
                      iteration.modelAfter &&
                      iteration.modelBefore !== iteration.modelAfter &&
                      ` · 模型 ${iteration.modelBefore} → ${iteration.modelAfter}`}
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

/** 原 Prompt 与改写后 Prompt 必须同屏可见，澄清问题、假设与数值守门结果一并留痕。 */
function ClarifyTraceCard({ step }: { step: StepRecord }) {
  const record = plainRecord(step.output);
  const intent = plainRecord(record?.intent);
  const ambiguities = arrayOfRecords(intent?.ambiguities);
  const assumptions = stringArray(intent?.assumptions);
  const constraints = stringArray(intent?.constraints);
  const changes = stringArray(record?.changes);
  const clarification = plainRecord(record?.clarification);
  const guardrail = plainRecord(record?.guardrail);
  const unexpected = stringArray(guardrail?.unexpected);
  const rawPrompt = typeof record?.rawPrompt === "string" ? record.rawPrompt : "";
  const rewrittenPrompt = typeof record?.rewrittenPrompt === "string" ? record.rewrittenPrompt : "";

  return (
    <section className="platform-trace-section platform-clarify-card">
      <h3>意图与 Prompt</h3>
      <div className="platform-clarify-meta">
        <span>任务类型 {typeof intent?.taskType === "string" ? intent.taskType : "—"}</span>
        <span>
          置信度{" "}
          {typeof intent?.confidence === "number" ? intent.confidence.toFixed(2) : "—"}
        </span>
        <span>{clarification ? "已人工澄清" : record?.needsClarification ? "自动补假设" : "无需澄清"}</span>
      </div>

      {(constraints.length > 0 || assumptions.length > 0 || ambiguities.length > 0) && (
        <div className="platform-clarify-notes">
          {constraints.length > 0 && <p>约束：{constraints.join("；")}</p>}
          {assumptions.length > 0 && <p>假设：{assumptions.join("；")}</p>}
          {ambiguities.map((item, index) => (
            <p key={`${item.slot}-${index}`}>
              <span className={`platform-clarify-impact is-${item.impact}`}>{String(item.impact)}</span>
              {String(item.question)}
            </p>
          ))}
        </div>
      )}

      <div className="platform-clarify-grid">
        <div>
          <h4>原始需求</h4>
          <pre>{rawPrompt || "（未记录）"}</pre>
        </div>
        <div>
          <h4>改写后 Prompt</h4>
          <pre>{rewrittenPrompt || "（未记录）"}</pre>
        </div>
      </div>

      {clarification && (
        <p className="platform-clarify-answer">
          澄清补充：{typeof clarification.answer === "string" && clarification.answer ? clarification.answer : "（未填写）"}
        </p>
      )}
      {changes.length > 0 && <p className="platform-clarify-notes">改写动作：{changes.join("；")}</p>}
      {guardrail?.ok === false && (
        <p className="platform-error-text">
          数值守门未通过：改写稿出现原文没有的数字 {unexpected.join("、")}。
        </p>
      )}
    </section>
  );
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item)
      )
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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

function edgeIdOf(edge: WorkflowDefinition["edges"][number]): string {
  // 同一个选项卡可能有多条出边，端口要参与 id，否则选中 / 删除会互相打架。
  return `${edge.from}|${edge.fromPort ?? ""}->${edge.to}`;
}

/** 与 edgeIdOf 同构，用于从画布回调（只有 source / sourceHandle）反查 DSL 边。 */
function edgeKeyOf(source: string, target: string, sourceHandle?: string | null): string {
  return `${source}|${sourceHandle ?? ""}->${target}`;
}

function pathExists(edges: WorkflowDefinition["edges"], from: string, to: string): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  }
  const stack = [from];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    if (current === to) {
      return true;
    }
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function midpoint(
  a: { x: number; y: number } | undefined,
  b: { x: number; y: number } | undefined
): { x: number; y: number } {
  if (a && b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 30 };
  }
  if (a) {
    return { x: a.x + 330, y: a.y };
  }
  if (b) {
    return { x: b.x - 330, y: b.y };
  }
  return { x: 120, y: 120 };
}

const REF_PATTERN = /\$\{([^}\s]+)\}/g;

function collectRefs(value: unknown, refs: Set<string>) {
  if (typeof value === "string") {
    for (const match of value.matchAll(REF_PATTERN)) {
      if (match[1]) {
        refs.add(match[1]);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectRefs(item, refs);
    }
  }
}

function inputNamesOf(node: WorkflowNode, definition: WorkflowDefinition): string[] {
  if (node.kind === "start") {
    return definition.inputs.map((variable) => `input.${variable.name}`);
  }
  const refs = new Set<string>();
  collectRefs(node.inputs, refs);
  collectRefs(node.args, refs);
  collectRefs(node.outputs, refs);
  collectRefs(node.prompt, refs);
  collectRefs(node.query, refs);
  collectRefs(node.template, refs);
  collectRefs(node.url, refs);
  collectRefs(node.when, refs);
  collectRefs(node.instructions, refs);
  return [...refs].slice(0, 6);
}

/** 节点声明了参数表就用声明，否则回退到契约里的端口预设。 */
type TemplateCardsProps = {
  onApply: (template: WorkflowTemplate) => void;
  compact?: boolean;
};

function TemplateCards({ onApply, compact }: TemplateCardsProps) {
  const [pack, setPack] = useState<ScenarioPackFilter | "all">("all");
  const templates = filterByPack("templates", WORKFLOW_TEMPLATES, (template) => template.id, pack);

  return (
    <>
      {!compact && (
        <div className="registry-pack-filter" role="group" aria-label="按场景包筛选模板">
          <button
            type="button"
            className={`registry-pack-chip ${pack === "all" ? "is-active" : ""}`}
            aria-pressed={pack === "all"}
            onClick={() => setPack("all")}
          >
            全部
            <span>{WORKFLOW_TEMPLATES.length}</span>
          </button>
          {SCENARIO_PACK_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`registry-pack-chip ${pack === item.id ? "is-active" : ""}`}
              aria-pressed={pack === item.id}
              onClick={() => setPack(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {templates.length === 0 && <p className="registry-pack-empty">该场景包还没有模板。</p>}
      <div className={`platform-template-grid ${compact ? "is-compact" : ""}`}>
        {templates.map((template) => {
        const kinds = [...new Set(template.nodes.map((node) => node.kind))];
        return (
          <button
            key={template.id}
            type="button"
            className="platform-template-card"
            onClick={() => onApply(template)}
          >
            <span className="platform-template-top">
              <span className="platform-template-badge">
                <FileText size={11} />
                {template.badge}
              </span>
              <span className="platform-template-count">
                {template.nodes.length} 节点 · {template.inputs.length} 输入
              </span>
            </span>
            <strong>{template.name}</strong>
            <p>{template.description}</p>
            <span className="platform-template-icons" aria-hidden>
              {kinds.slice(0, 7).map((kind) => {
                const visual = NODE_VISUALS[kind];
                const Icon = visual.icon;
                return (
                  <span
                    key={kind}
                    className="platform-template-icon"
                    style={{ background: `${visual.tint}14`, color: visual.tint }}
                  >
                    <Icon size={12} strokeWidth={2} />
                  </span>
                );
              })}
            </span>
          </button>
        );
        })}
      </div>
    </>
  );
}

function CanvasEmptyState({
  onApply,
  onOpenPalette
}: {
  onApply: (template: WorkflowTemplate) => void;
  onOpenPalette: () => void;
}) {
  return (
    <div className="platform-canvas-empty">
      <span className="platform-canvas-empty-icon">
        <Sparkles size={19} />
      </span>
      <h3>从第一个节点开始</h3>
      <p>从左侧节点库拖入，或选择一套模板快速搭出可运行的业务流程。</p>
      <div className="platform-canvas-empty-actions">
        <button type="button" className="platform-button is-ghost" onClick={onOpenPalette}>
          <Plus size={14} /> 打开节点库
        </button>
      </div>
      <span className="platform-canvas-empty-label">或从模板开始</span>
      <TemplateCards onApply={onApply} compact />
    </div>
  );
}

/** 运行结果弹窗里的一节：root 下按层级展开，右侧可复制整段 JSON。 */
function ResultSection({ title, value }: { title: string; value: unknown }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        typeof value === "string" ? value : JSON.stringify(value ?? null, null, 2)
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  const keys =
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.length
        : Object.keys(value).length
      : 0;
  return (
    <section className="nr-section">
      <div className="nr-section-head">
        <h3>{title}</h3>
        <button type="button" className="nr-copy" onClick={() => void copy()}>
          <Copy size={13} /> {copied ? "已复制" : "复制"}
        </button>
      </div>
      {value === undefined || value === null ? (
        <p className="nr-empty">（无数据）</p>
      ) : (
        <div className="nr-tree">
          <div className="nr-root">
            <span>root</span>
            <em>
              {keys} {Array.isArray(value) ? "items" : "keys"}
            </em>
          </div>
          <ResultTree value={value} />
        </div>
      )}
    </section>
  );
}

function ResultTree({ value }: { value: unknown }) {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const entries: Array<[string, unknown]> = Array.isArray(value)
    ? value.map((item, index): [string, unknown] => [String(index), item])
    : Object.entries(value as Record<string, unknown>);
  return (
    <ul className="nr-branch">
      {entries.map(([key, item]) => (
        <li key={key}>
          <span className="nr-key">{key}</span>
          {item !== null && typeof item === "object" ? (
            <>
              <em className="nr-count">
                {Array.isArray(item) ? `${item.length} items` : `${Object.keys(item).length} keys`}
              </em>
              <ResultTree value={item} />
            </>
          ) : (
            <span className={`nr-value is-${typeof item}`}>
              {typeof item === "string" ? `"${item}"` : String(item)}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
