import type { Express, Response } from "express";
import {
  NODE_KINDS,
  PlatformError,
  type ApprovalDecision,
  type ApprovalStatus,
  type InteractionStatus,
  type WorkflowDefinition
} from "./types.js";
import { loadBuiltinWorkflows, parseWorkflowDefinition, WorkflowSyntaxError } from "./workflow/dsl.js";
import { compileWorkflow, WorkflowCompileError } from "./workflow/compiler.js";
import { diagnoseWorkflow, hasBlockingIssue, type WorkflowDiagnostic } from "./workflow/diagnostics.js";
import {
  CANVAS_CONTRACT,
  COMMON_NODE_FIELDS,
  NODE_TYPE_CONTRACT_VERSION,
  NODE_TYPE_SPECS,
  type NodeTypeSpec
} from "./workflow/nodeTypes.js";
import { PlatformStateStore } from "./runtime/stateStore.js";
import { WorkflowExecutor } from "./runtime/executor.js";
import { BUILTIN_AGENTS, parseAgentWrite } from "./registry/agents.js";
import {
  describeAgentModel,
  getModelCatalog,
  toModelView
} from "./models/catalog.js";
import { BUILTIN_TOOLS, parseToolWrite } from "./registry/tools.js";
import { parseTeamWrite } from "./registry/teams.js";
import { DATA_ANALYSIS_MCP_SERVER, DEMO_MCP_SERVER, McpManager } from "./mcp/mcpManager.js";
import { isWorkflowToolEndpoint, syncWorkflowTools } from "./mcp/workflowTools.js";
import {
  bindTeamKnowledge,
  bindWorkflowKnowledge,
  buildKnowledgeOverview,
  parseKnowledgeBaseName,
  parseKnowledgeBindingRequest,
  type KnowledgeProviderPort
} from "./knowledge/knowledgeBases.js";
import type { KnowledgeWorkflowRef, RegistryOverview } from "./types.js";
import {
  createSchedule,
  DEFAULT_SCHEDULER_WEIGHTS,
  parseScheduleRequest,
  SCHEDULER_FORMULA
} from "./scheduler/scheduler.js";
import {
  resolveSelfLoopPolicy,
  SELF_LOOP_ACTION_SPECS,
  SELF_LOOP_CONTRACT,
  SELF_LOOP_STOP_REASON_SPECS
} from "./selfLoop/controller.js";
import {
  compareReplayPolicies,
  isReplayPolicy,
  parseReplayTasks,
  replaySchedule,
  replayTasksFromQueue,
  type ReplayPolicy
} from "./scheduler/whatif.js";
import type { SchedulerReclaimer } from "./scheduler/reclaimer.js";
import {
  VERIFY_CONTRACT,
  VERIFY_DEFAULTS,
  VERIFY_FORMULA,
  VERIFY_LAYERS
} from "./verify/verifier.js";
import { collectMetrics } from "./metrics/collector.js";
import type { EvolutionService, RunReleasePick } from "./evolution/service.js";
import { randomUUID } from "node:crypto";
import { registerEvolutionRoutes } from "./evolution/routes.js";

type PlatformOptions = {
  store?: PlatformStateStore;
  executor?: WorkflowExecutor;
  knowledge?: KnowledgeProviderPort;
  mcp?: McpManager;
  evolution?: EvolutionService;
  reclaimer?: SchedulerReclaimer;
};

export function registerPlatform(app: Express, options: PlatformOptions = {}) {
  const store = options.store ?? new PlatformStateStore();
  const executor = options.executor ?? new WorkflowExecutor(store);
  const mcp = options.mcp ?? new McpManager(store);
  const evolution = options.evolution;
  const reclaimer = options.reclaimer;
  if (evolution) {
    registerEvolutionRoutes(app, evolution);
  }
  const builtinWorkflows = seedBuiltinWorkflows(store);
  const seededRegistry = seedRegistry(store);

  app.get("/api/platform/health", (_request, response) => {
    response.json({
      status: "ok",
      ...store.health(),
      nodeKinds: NODE_KINDS,
      builtinWorkflows,
      runtime: executor.runtimeConfig(),
      selfLoop: resolveSelfLoopPolicy(),
      verify: { contract: VERIFY_CONTRACT, formula: VERIFY_FORMULA, defaults: VERIFY_DEFAULTS },
      registry: store.registrySummary(),
      mcp: {
        servers: mcp.list().length,
        enabledServers: mcp.list().filter((server) => server.enabled).length,
        tools: store.listTools().filter((tool) => tool.type === "mcp").length
      },
      approvals: {
        pending: store.listApprovals({ status: "pending" }).length,
        defaultTimeoutMs: executor.runtimeConfig().approvalTimeoutMs
      },
      evolution: evolution?.overview(),
      seededRegistry
    });
  });

  app.get("/api/platform/models", (_request, response) => {
    const models = getModelCatalog().map(toModelView);
    response.json({ models, total: models.length });
  });

  app.get("/api/platform/agents", (_request, response) => {
    const agents = store.listAgents();
    response.json({ agents, total: agents.length });
  });

  app.get("/api/platform/agents/:id", (request, response) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) {
      response.status(404).json({ message: "Agent 不存在。" });
      return;
    }
    response.json({ agent });
  });

  app.post("/api/platform/agents", (request, response) => {
    try {
      const body = isRecord(request.body) ? { ...request.body } : {};
      const existing = typeof body.id === "string" ? store.getAgent(body.id) : undefined;
      if (existing && body.version === undefined) {
        // 回滚会把当前版本调低，因此新版本号必须取历史最大值 + 1，避免覆盖旧快照。
        body.version = store.maxAgentVersion(existing.id) + 1;
      }
      const agent = parseAgentWrite(body, existing);
      store.saveAgent(agent);
      response.status(existing ? 200 : 201).json({ agent: store.getAgent(agent.id), created: !existing });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/agents/:id/versions", (request, response) => {
    const agent = store.getAgent(request.params.id);
    if (!agent) {
      response.status(404).json({ message: "Agent 不存在。" });
      return;
    }
    response.json({
      agentId: agent.id,
      currentVersion: agent.version,
      versions: store.listAgentVersions(agent.id)
    });
  });

  app.post("/api/platform/agents/:id/rollback", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const version = body.version;
      if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
        throw new PlatformError("version 必须是正整数。", 400);
      }
      const agent = store.rollbackAgent(request.params.id, version);
      if (!agent) {
        throw new PlatformError("Agent 或该版本快照不存在。", 404);
      }
      response.json({ agent, rolledBackTo: version });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/registry", (_request, response) => {
    const teams = store.listTeams();
    const counts = store.agentCallCounts();
    const agents = store.listAgents().map((agent) => ({
      ...agent,
      modelProfile: describeAgentModel(agent.model),
      callCount: counts[agent.id] ?? 0,
      teamIds: teams.filter((team) => team.agentIds.includes(agent.id)).map((team) => team.id)
    }));
    const overview: RegistryOverview = { teams, agents };
    response.json(overview);
  });

  app.get("/api/platform/teams", (_request, response) => {
    const teams = store.listTeams();
    response.json({ teams, total: teams.length });
  });

  app.post("/api/platform/teams", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const existing = typeof body.id === "string" ? store.getTeam(body.id) : undefined;
      const team = parseTeamWrite(body, existing);
      const missingAgents = team.agentIds.filter((id) => !store.getAgent(id));
      if (missingAgents.length > 0) {
        throw new PlatformError(`成员 Agent 不存在：${missingAgents.join("、")}`, 400);
      }
      if (team.workflowId && !store.getWorkflow(team.workflowId)) {
        throw new PlatformError("默认工作流不存在。", 400);
      }
      const saved = store.saveTeam(team);
      response.status(existing ? 200 : 201).json({ team: saved, created: !existing });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/knowledge-bases", async (_request, response) => {
    try {
      const knowledge = requireKnowledge(options);
      const bases = await knowledge.listBases();
      const workflows: KnowledgeWorkflowRef[] = [];
      for (const summary of store.listWorkflows()) {
        const stored = store.getWorkflow(summary.id);
        if (stored) {
          workflows.push({
            id: summary.id,
            name: summary.name,
            version: summary.version,
            knowledgeBaseIds: stored.definition.knowledgeBaseIds ?? []
          });
        }
      }
      response.json(buildKnowledgeOverview(bases, store.listTeams(), workflows));
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/knowledge-bases", (request, response) => {
    try {
      const knowledge = requireKnowledge(options);
      const body = isRecord(request.body) ? request.body : {};
      const base = knowledge.createBase(parseKnowledgeBaseName(body.name));
      response.status(201).json({ base });
    } catch (error) {
      fail(response, error);
    }
  });

  app.patch("/api/platform/knowledge-bases/:id", (request, response) => {
    try {
      const knowledge = requireKnowledge(options);
      const body = isRecord(request.body) ? request.body : {};
      const base = knowledge.renameBase(request.params.id, parseKnowledgeBaseName(body.name));
      response.json({ base });
    } catch (error) {
      fail(response, error);
    }
  });

  app.delete("/api/platform/knowledge-bases/:id", async (request, response) => {
    try {
      const knowledge = requireKnowledge(options);
      const baseId = request.params.id;
      knowledge.deleteBase(baseId);
      for (const team of store.listTeams()) {
        if (team.knowledgeBaseIds.includes(baseId)) {
          store.saveTeam(bindTeamKnowledge(team, baseId, false));
        }
      }
      for (const summary of store.listWorkflows()) {
        const stored = store.getWorkflow(summary.id);
        if (!stored) {
          continue;
        }
        const next = bindWorkflowKnowledge(stored.definition, baseId, false);
        if (next !== stored.definition) {
          store.saveWorkflow(next);
        }
      }
      response.status(204).end();
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/knowledge-bases/:id/documents", async (request, response) => {
    try {
      const knowledge = requireKnowledge(options);
      response.json({ documents: await knowledge.listDocuments(request.params.id) });
    } catch (error) {
      fail(response, error);
    }
  });

  app.delete("/api/platform/knowledge-bases/:baseId/documents/:documentId", (request, response) => {
    try {
      const knowledge = requireKnowledge(options);
      knowledge.deleteDocument(request.params.baseId, request.params.documentId);
      response.status(204).end();
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/knowledge-bases/search", async (request, response) => {
    try {
      const knowledge = requireKnowledge(options);
      const body = isRecord(request.body) ? request.body : {};
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) {
        throw new PlatformError("检索内容不能为空。", 400);
      }
      const topK = Number(body.topK);
      const citations = await knowledge.search({
        query,
        knowledgeBaseIds: parseBaseIds(body.knowledgeBaseIds),
        topK: Number.isInteger(topK) && topK > 0 ? Math.min(topK, 20) : 6
      });
      response.json({ citations });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/knowledge-bases/:id/bind", async (request, response) => {
    try {
      const knowledge = requireKnowledge(options);
      const baseId = request.params.id;
      const bases = await knowledge.listBases();
      if (!bases.some((base) => base.id === baseId)) {
        throw new PlatformError("知识库不存在。", 404);
      }
      const { teamId, workflowId, bound } = parseKnowledgeBindingRequest(request.body);
      if (teamId) {
        const team = store.getTeam(teamId);
        if (!team) {
          throw new PlatformError("团队不存在。", 404);
        }
        const saved = store.saveTeam(bindTeamKnowledge(team, baseId, bound));
        response.json({ team: saved, bound });
        return;
      }
      const stored = store.getWorkflow(workflowId!);
      if (!stored) {
        throw new PlatformError("工作流不存在。", 404);
      }
      const next = bindWorkflowKnowledge(stored.definition, baseId, bound);
      if (next !== stored.definition) {
        store.saveWorkflow(next);
      }
      response.json({
        workflow: { id: next.id, version: next.version, knowledgeBaseIds: next.knowledgeBaseIds ?? [] },
        bound
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/mcp/servers", (_request, response) => {
    const servers = mcp.list();
    response.json({
      servers,
      total: servers.length,
      connected: servers.filter((server) => server.lastConnectedAt && !server.lastError).length
    });
  });

  app.get("/api/platform/mcp/servers/:id", (request, response) => {
    try {
      response.json({ server: mcp.view(request.params.id) });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/mcp/servers", async (request, response) => {
    try {
      const existing = store.getMcpServer(
        isRecord(request.body) && typeof request.body.id === "string" ? request.body.id : ""
      );
      const server = await mcp.save(request.body);
      response.status(existing ? 200 : 201).json({ server, created: !existing });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/mcp/servers/:id/refresh", async (request, response) => {
    try {
      response.json(await mcp.refresh(request.params.id));
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/mcp/servers/:id/call", async (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const tool = typeof body.tool === "string" ? body.tool.trim() : "";
      if (!tool) {
        throw new PlatformError("缺少 tool 字段。", 400);
      }
      const args = isRecord(body.args) ? body.args : {};
      response.json({ result: await mcp.call(request.params.id, tool, args) });
    } catch (error) {
      fail(response, error);
    }
  });

  app.delete("/api/platform/mcp/servers/:id", async (request, response) => {
    try {
      const removed = await mcp.remove(request.params.id);
      if (!removed) {
        throw new PlatformError("MCP 服务器不存在。", 404);
      }
      response.json({ server: removed, deleted: true });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/tools", (_request, response) => {
    const tools = store.listTools();
    response.json({ tools, total: tools.length });
  });

  app.get("/api/platform/tools/:id", (request, response) => {
    const tool = store.getTool(request.params.id);
    if (!tool) {
      response.status(404).json({ message: "工具不存在。" });
      return;
    }
    response.json({ tool });
  });

  app.post("/api/platform/tools", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const existing = typeof body.id === "string" ? store.getTool(body.id) : undefined;
      const tool = parseToolWrite(body, existing);
      store.saveTool(tool);
      response.status(existing ? 200 : 201).json({ tool: store.getTool(tool.id), created: !existing });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/scheduler", (_request, response) => {
    const agents = store.listAgents().filter((agent) => agent.enabled);
    const capabilities = [
      ...new Set(agents.flatMap((agent) => agent.capabilities.map((item) => item.tag)))
    ].sort((left, right) => left.localeCompare(right, "zh-CN"));
    const runtime = executor.runtimeConfig();
    response.json({
      formula: SCHEDULER_FORMULA,
      weights: DEFAULT_SCHEDULER_WEIGHTS,
      agentCount: agents.length,
      capabilities,
      activeLoads: store.activeLeaseLoads(),
      runtime: {
        workerId: runtime.workerId,
        leaseTtlMs: runtime.leaseTtlMs,
        agentCapacity: runtime.agentCapacity,
        schedulerCapacity: runtime.schedulerCapacity,
        schedulerPolicy: runtime.schedulerPolicy,
        workerPoolSize: runtime.workerPoolSize
      },
      leadership: store.getSchedulerLeadership(),
      reclaimer: reclaimer?.status(),
      // 跨运行全局队列：容量与排序由 SchedulerService 统一裁决，监控台直接读取。
      globalQueue: executor.schedulerSnapshot()
    });
  });

  app.get("/api/platform/scheduler/leadership", (_request, response) => {
    response.json({
      leadership: store.getSchedulerLeadership(),
      reclaimer: reclaimer?.status()
    });
  });

  app.post("/api/platform/scheduler/reclaim", async (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      if (reclaimer) {
        response.json(await reclaimer.tick({ force: body.force === true }));
        return;
      }
      response.json(await executor.requeueOrphanedRuns());
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/scheduler/whatif", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const capacity = Number(body.capacity ?? executor.runtimeConfig().schedulerCapacity);
      if (!Number.isFinite(capacity) || capacity < 1) {
        throw new PlatformError("capacity 必须是不小于 1 的数字。", 400);
      }
      const policies = Array.isArray(body.policies)
        ? (body.policies.filter(isReplayPolicy) as ReplayPolicy[])
        : undefined;
      let tasks;
      let source: Record<string, unknown>;
      if (typeof body.runId === "string" && body.runId.trim() !== "") {
        const run = store.getRun(body.runId);
        if (!run) {
          throw new PlatformError("运行记录不存在。", 404);
        }
        tasks = replayTasksFromQueue(store.listSchedulerQueue(body.runId));
        source = { kind: "trace", runId: body.runId };
      } else {
        tasks = parseReplayTasks(body.tasks);
        source = { kind: "sandbox" };
      }
      if (tasks.length === 0) {
        throw new PlatformError("没有已完成的调度任务可供回放。", 409);
      }
      const roundedCapacity = Math.max(1, Math.trunc(capacity));
      response.json({
        source,
        capacity: roundedCapacity,
        taskCount: tasks.length,
        recorded: replaySchedule(tasks, { capacity: roundedCapacity, policy: "recorded" }),
        policies: compareReplayPolicies(tasks, {
          capacity: roundedCapacity,
          policies
        })
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/scheduler/leases", (request, response) => {
    const active = request.query.active !== "false";
    const runId = typeof request.query.runId === "string" ? request.query.runId : undefined;
    const agentId = typeof request.query.agentId === "string" ? request.query.agentId : undefined;
    const limit = typeof request.query.limit === "string" ? Number(request.query.limit) : undefined;
    const runtime = executor.runtimeConfig();
    response.json({
      leases: store.listSchedulerLeases({
        active,
        runId,
        agentId,
        limit: Number.isFinite(limit) ? limit : undefined
      }),
      activeLoads: store.activeLeaseLoads(),
      runtime: {
        workerId: runtime.workerId,
        leaseTtlMs: runtime.leaseTtlMs,
        agentCapacity: runtime.agentCapacity
      }
    });
  });

  app.get("/api/platform/scheduler/workers", (_request, response) => {
    response.json({
      workers: executor.listWorkers(),
      // Worker 进程池与调度台账分开呈现：前者是可操作的活进程，后者含历史与 dead 记录。
      processes: store.listSchedulerWorkers({ lane: "process", limit: 50 }),
      workerId: executor.runtimeConfig().workerId
    });
  });

  app.post("/api/platform/scheduler/workers/:id/kill", (request, response) => {
    try {
      const result = executor.killWorker(request.params.id);
      response.status(result.killed ? 200 : 404).json(result);
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/schedule", (request, response) => {
    try {
      const { tasks, options } = parseScheduleRequest(request.body);
      const plan = createSchedule(tasks, store.listAgents(), options);
      response.json({ plan });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/self-loop", (_request, response) => {
    response.json({
      contract: SELF_LOOP_CONTRACT,
      actions: SELF_LOOP_ACTION_SPECS,
      stopReasons: SELF_LOOP_STOP_REASON_SPECS,
      defaults: resolveSelfLoopPolicy()
    });
  });

  app.get("/api/platform/verify", (_request, response) => {
    response.json({
      contract: VERIFY_CONTRACT,
      layers: VERIFY_LAYERS,
      formula: VERIFY_FORMULA,
      defaults: VERIFY_DEFAULTS
    });
  });

  app.get("/api/platform/workflows", (_request, response) => {
    response.json({ workflows: store.listWorkflows() });
  });

  app.get("/api/platform/node-types", (_request, response) => {
    const workflows = store.listWorkflows();
    const agents = store.listAgents().filter((agent) => agent.enabled);
    const tools = store.listTools().filter((tool) => tool.enabled);
    response.json({
      version: NODE_TYPE_CONTRACT_VERSION,
      commonFields: COMMON_NODE_FIELDS,
      nodeTypes: withRegistryOptions(NODE_TYPE_SPECS, {
        workflows: workflows.map((workflow) => ({ id: workflow.id, label: workflow.name })),
        agents: agents.map((agent) => ({ id: agent.id, label: agent.name })),
        tools: tools.map((tool) => ({
          id: tool.id,
          label: isWorkflowToolEndpoint(tool.endpoint)
            ? `${tool.name}（工作流工具）`
            : `${tool.name}（${tool.type}）`
        })),
        verifiers: agents
          .filter((agent) => agent.tools.includes("verify.rubric"))
          .map((agent) => ({ id: agent.id, label: agent.name }))
      }),
      canvas: CANVAS_CONTRACT
    });
  });

  app.post("/api/platform/workflows", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const parsed = parseWorkflowDefinition(body.dsl ?? body);
      // 已有工作流默认追加版本：覆盖同版本会让历史运行与单步重跑失去可复现性。
      const existing = store.getWorkflow(parsed.id);
      const version = existing ? Math.max(parsed.version, existing.definition.version + 1) : parsed.version;
      const definition = version === parsed.version ? parsed : { ...parsed, version };
      const plan = compileWorkflow(definition, { resolveWorkflow: storeWorkflowResolver(store) });
      store.saveWorkflow(definition);
      syncWorkflowTools(store);
      response.status(201).json({
        workflow: store.getWorkflow(definition.id, definition.version),
        plan: plan.stats,
        versionBumped: version !== parsed.version
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/workflows/:id", (request, response) => {
    try {
      const version = request.query.version === undefined ? undefined : Number(request.query.version);
      const stored = store.getWorkflow(request.params.id, Number.isInteger(version) ? version : undefined);
      if (!stored) {
        throw new PlatformError("工作流不存在。", 404);
      }
      response.json({ workflow: stored });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/workflows/:id/validate", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const candidate =
        body.dsl === undefined ? undefined : parseWorkflowDefinition(body.dsl);
      const definition =
        candidate ?? store.getWorkflow(request.params.id, typeof body.version === "number" ? body.version : undefined)?.definition;
      if (!definition) {
        throw new PlatformError("工作流不存在，且请求未携带 dsl。", 404);
      }
      const plan = compileWorkflow(definition, { resolveWorkflow: storeWorkflowResolver(store) });
      response.json({ ok: true, issues: [], stats: plan.stats, order: plan.order });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * 调试门禁：只做静态检查，不写库、不起 run。
   * 与 validate 的区别：允许传入未解析的画布草稿（必填字段可能为空），
   * 除编译器硬规则外额外给出「节点未连接 / 引用参数未填写」等可直接展示的中文提示。
   * 前端点击「调试」时调用，有 error 级问题就不进入调试视图。
   */
  app.post("/api/platform/workflows/:id/diagnose", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const draft = body.dsl;
      const source =
        draft === undefined
          ? store.getWorkflow(request.params.id, typeof body.version === "number" ? body.version : undefined)?.definition
          : draft;
      if (!source) {
        throw new PlatformError("工作流不存在，且请求未携带 dsl。", 404);
      }
      const issues: WorkflowDiagnostic[] = diagnoseWorkflow(source);
      // 草稿本身有阻断问题时不再编译：编译器的英文/结构化报错会淹没节点级提示。
      if (!hasBlockingIssue(issues)) {
        try {
          const definition =
            draft === undefined ? (source as WorkflowDefinition) : parseWorkflowDefinition(draft);
          compileWorkflow(definition, { resolveWorkflow: storeWorkflowResolver(store) });
        } catch (error) {
          if (error instanceof WorkflowCompileError) {
            for (const issue of error.issues) {
              issues.push({ ...issue, severity: "error" });
            }
          } else if (error instanceof WorkflowSyntaxError) {
            issues.push({
              code: "syntax",
              path: error.path,
              message: error.message,
              severity: "error"
            });
          } else {
            throw error;
          }
        }
      }
      response.json({ ok: !hasBlockingIssue(issues), issues });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/runs", (request, response) => {
    const limit = Number(request.query.limit);
    response.json({ runs: store.listRuns(Number.isInteger(limit) ? limit : 20) });
  });

  app.get("/api/platform/metrics/summary", (request, response) => {
    try {
      const workflowId = typeof request.query.workflowId === "string" ? request.query.workflowId.trim() : "";
      const limit = Number(request.query.limit);
      response.json(
        collectMetrics(store, {
          workflowIds: workflowId ? [workflowId] : [],
          limit: Number.isInteger(limit) && limit > 0 ? limit : undefined
        })
      );
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/metrics/compare", (request, response) => {
    try {
      const raw = typeof request.query.workflowIds === "string" ? request.query.workflowIds : "";
      const workflowIds = raw
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      const limit = Number(request.query.limit);
      response.json(
        collectMetrics(store, {
          workflowIds,
          limit: Number.isInteger(limit) && limit > 0 ? limit : undefined
        })
      );
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/runs", async (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const workflowId = typeof body.workflowId === "string" ? body.workflowId : "";
      if (!workflowId) {
        throw new PlatformError("缺少 workflowId。", 400);
      }
      const version = typeof body.version === "number" && Number.isInteger(body.version) ? body.version : undefined;
      const stored = store.getWorkflow(workflowId, version);
      if (!stored) {
        throw new PlatformError("工作流不存在，请先保存 DSL。", 404);
      }
      const input = isRecord(body.input) ? body.input : {};
      const stopAfter = typeof body.stopAfter === "string" ? body.stopAfter.trim() : undefined;
      if (stopAfter === "") {
        throw new PlatformError("stopAfter 不能为空字符串。", 400);
      }
      const priorityClass =
        body.priorityClass === undefined ? undefined : Number(body.priorityClass);
      if (
        priorityClass !== undefined &&
        (!Number.isInteger(priorityClass) || priorityClass < 0 || priorityClass > 5)
      ) {
        throw new PlatformError("priorityClass 必须是 0 到 5 之间的整数。", 400);
      }
      const deadlineAt = typeof body.deadlineAt === "string" ? body.deadlineAt.trim() : undefined;
      if (deadlineAt !== undefined && Number.isNaN(Date.parse(deadlineAt))) {
        throw new PlatformError("deadlineAt 必须是可解析的时间。", 400);
      }
      const release = resolveRunRelease(body, workflowId, evolution);
      const runOptions = {
        stopAfter,
        ...(priorityClass !== undefined ? { priorityClass } : {}),
        ...(deadlineAt ? { deadlineAt } : {}),
        ...(release
          ? {
              releaseId: release.releaseId,
              experimentId: release.experimentId,
              arm: release.arm,
              onCreated: (created: { id: string }) =>
                evolution?.recordAssignment(created.id, release, workflowId)
            }
          : {})
      };
      if (body.async === true) {
        const run = executor.start(stored.definition, input, runOptions);
        response.status(202).json({ run });
        return;
      }
      const result = await executor.run(stored.definition, input, runOptions);
      response.status(201).json(result);
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/runs/:id/retry", (request, response) => {
    try {
      const run = store.getRun(request.params.id);
      if (!run) {
        throw new PlatformError("运行记录不存在。", 404);
      }
      const stored = store.getWorkflow(run.workflowId, run.workflowVersion);
      const definition = run.definition ?? stored?.definition;
      if (!definition) {
        throw new PlatformError("运行对应的工作流版本不存在。", 404);
      }
      // 重跑沿用原发布的冻结快照，避免人工重跑悄悄换到新版本。
      const release = run.releaseId
        ? {
            releaseId: run.releaseId,
            experimentId: run.experimentId,
            arm: (run.arm === "control" ? "control" : "treatment") as "control" | "treatment",
            assignmentKey: `retry:${run.id}:${randomUUID()}`
          }
        : resolveRunRelease({ releaseId: null }, run.workflowId, evolution);
      const next = executor.start(definition, run.input, {
        ...(release
          ? {
              releaseId: release.releaseId,
              experimentId: release.experimentId,
              arm: release.arm,
              onCreated: (created: { id: string }) =>
                evolution?.recordAssignment(created.id, release, run.workflowId)
            }
          : {})
      });
      response.status(202).json({ run: next, retryOf: run.id });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/runs/:id/cancel", (request, response) => {
    try {
      const run = executor.cancelRun(request.params.id);
      response.status(202).json({ run });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/runs/:id/resume", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const stopAfter = typeof body.stopAfter === "string" ? body.stopAfter.trim() : undefined;
      const run = executor.startResume(request.params.id, { stopAfter });
      response.status(202).json({ run, resumedFrom: request.params.id });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/runs/:id/steps/:stepId/retry", async (request, response) => {
    try {
      const step = await executor.retryStep(request.params.id, request.params.stepId);
      response.json({ step, trace: traceOf(store, request.params.id) });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/approvals", (request, response) => {
    try {
      const status = typeof request.query.status === "string" ? request.query.status : "";
      if (status && !["pending", "approved", "rejected", "expired"].includes(status)) {
        throw new PlatformError("status 只支持 pending / approved / rejected / expired。", 400);
      }
      const runId = typeof request.query.runId === "string" ? request.query.runId : undefined;
      const limit = Number(request.query.limit);
      response.json({
        approvals: store.listApprovals({
          runId,
          status: (status || undefined) as ApprovalStatus | undefined,
          limit: Number.isInteger(limit) ? limit : undefined
        })
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/approvals/:id/decide", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      if (body.decision !== "approved" && body.decision !== "rejected") {
        throw new PlatformError("decision 必须是 approved 或 rejected。", 400);
      }
      const approval = executor.decideApproval(request.params.id, {
        decision: body.decision as ApprovalDecision,
        reviewer: typeof body.reviewer === "string" ? body.reviewer : undefined,
        comment: typeof body.comment === "string" ? body.comment : undefined
      });
      response.json({ approvalId: approval.id, decision: body.decision });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/runs/:id", (request, response) => {
    const run = store.getRun(request.params.id);
    if (!run) {
      response.status(404).json({ message: "运行记录不存在。" });
      return;
    }
    response.json({ run });
  });

  app.get("/api/platform/interactions", (request, response) => {
    try {
      const status = typeof request.query.status === "string" ? request.query.status : "";
      if (status && !["pending", "answered", "expired", "cancelled"].includes(status)) {
        throw new PlatformError("status 只支持 pending / answered / expired / cancelled。", 400);
      }
      const runId = typeof request.query.runId === "string" ? request.query.runId : undefined;
      const limit = Number(request.query.limit);
      response.json({
        interactions: store.listInteractions({
          runId,
          status: (status || undefined) as InteractionStatus | undefined,
          limit: Number.isInteger(limit) ? limit : undefined
        })
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/interactions/:id/respond", async (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const values = isRecord(body.values) ? body.values : {};
      const interaction = store.getInteraction(request.params.id);
      if (!interaction) {
        throw new PlatformError("人工输入任务不存在。", 404);
      }
      const baseline = store.listSteps(interaction.runId).length;
      executor.respondInteraction(interaction.id, {
        values,
        actor: typeof body.actor === "string" ? body.actor : undefined
      });
      await waitForRunCheckpoint(store, interaction.runId, baseline, 120_000);
      response.json({
        run: store.getRun(interaction.runId),
        steps: store.listSteps(interaction.runId),
        interactions: store.listInteractions({ runId: interaction.runId }),
        interaction: store.getInteraction(interaction.id),
        pending: store.listInteractions({ runId: interaction.runId, status: "pending" })[0]
      });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/runs/:id/trace", (request, response) => {
    const run = store.getRun(request.params.id);
    if (!run) {
      response.status(404).json({ message: "运行记录不存在。" });
      return;
    }
    response.json(traceOf(store, run.id));
  });

  return { store, executor };
}

function traceOf(store: PlatformStateStore, runId: string) {
  const run = store.getRun(runId)!;
  return {
    run,
    steps: store.listSteps(runId),
    verifyResults: store.listVerifyResults(runId),
    loopIterations: store.listLoopIterations(runId),
    approvals: store.listApprovals({ runId }),
    interactions: store.listInteractions({ runId }),
    queue: store.listSchedulerQueue(runId),
    runNodes: store.listRunNodes(runId),
    // 检查点状态可能包含大量产物，trace 只给出序号与已完成节点数。
    checkpoints: store.listRunCheckpoints(runId, 10).map((checkpoint) => ({
      id: checkpoint.id,
      runId: checkpoint.runId,
      sequence: checkpoint.sequence,
      createdAt: checkpoint.createdAt,
      nodeCount:
        checkpoint.state.nodes && typeof checkpoint.state.nodes === "object"
          ? Object.keys(checkpoint.state.nodes as Record<string, unknown>).length
          : 0
    }))
  };
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "verifying", "revising"]);

/**
 * 人工输入提交后，运行会在后台继续；接口等到下一次暂停（或终态）再返回，
 * 避免训练页为了拿最新课堂/谈话状态反复轮询。步骤数用于区分“刚提交”与“已继续”。
 */
async function waitForRunCheckpoint(
  store: PlatformStateStore,
  runId: string,
  baselineSteps: number,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.getRun(runId);
    if (!run) {
      return;
    }
    const advanced = store.listSteps(runId).length > baselineSteps;
    if (advanced && !ACTIVE_RUN_STATUSES.has(run.status)) {
      return;
    }
    if (!ACTIVE_RUN_STATUSES.has(run.status) && run.status !== "waiting_input") {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

function seedRegistry(store: PlatformStateStore) {
  return {
    agents: store.seedAgents(BUILTIN_AGENTS),
    tools: store.seedTools(BUILTIN_TOOLS),
    mcpServers: store.seedMcpServers([DEMO_MCP_SERVER, DATA_ANALYSIS_MCP_SERVER])
  };
}

function seedBuiltinWorkflows(store: PlatformStateStore): string[] {
  const ids: string[] = [];
  let workflows: WorkflowDefinition[];
  try {
    workflows = loadBuiltinWorkflows();
  } catch (error) {
    console.warn(`[platform] 内置工作流加载失败：${error instanceof Error ? error.message : String(error)}`);
    return ids;
  }

  // 内置流程互相引用子工作流时，先按加载结果建索引，避免依赖文件顺序。
  const byKey = new Map(workflows.map((workflow) => [`${workflow.id}@${workflow.version}`, workflow]));
  const latest = new Map<string, WorkflowDefinition>();
  for (const workflow of workflows) {
    const current = latest.get(workflow.id);
    if (!current || current.version < workflow.version) {
      latest.set(workflow.id, workflow);
    }
  }
  const resolveWorkflow = (id: string, version?: number) =>
    version === undefined ? latest.get(id) : byKey.get(`${id}@${version}`);

  for (const workflow of workflows) {
    try {
      compileWorkflow(workflow, { resolveWorkflow });
      store.saveWorkflow(workflow);
      ids.push(workflow.id);
    } catch (error) {
      const detail = error instanceof WorkflowCompileError ? error.message : String(error);
      console.warn(`[platform] 内置工作流 ${workflow.id} 未通过校验：${detail}`);
    }
  }
  return ids;
}

function storeWorkflowResolver(store: PlatformStateStore) {
  return (id: string, version?: number) => store.getWorkflow(id, version)?.definition;
}

type RegistryOption = { id: string; label: string };

function withRegistryOptions(
  specs: NodeTypeSpec[],
  registry: {
    workflows: RegistryOption[];
    agents: RegistryOption[];
    tools: RegistryOption[];
    verifiers: RegistryOption[];
  }
): NodeTypeSpec[] {
  const toFieldOptions = (options: RegistryOption[]) => ({
    options: options.map((option) => option.id),
    optionLabels: Object.fromEntries(options.map((option) => [option.id, option.label]))
  });
  return specs.map((spec) => ({
    ...spec,
    fields: spec.fields.map((field) => {
      if (spec.kind === "subworkflow" && field.key === "workflowId") {
        return { ...field, ...toFieldOptions(registry.workflows) };
      }
      if (spec.kind === "agent" && field.key === "agent") {
        return { ...field, ...toFieldOptions(registry.agents) };
      }
      if (spec.kind === "tool" && field.key === "tool") {
        return { ...field, ...toFieldOptions(registry.tools) };
      }
      if (spec.kind === "verify" && field.key === "verifier") {
        return { ...field, ...toFieldOptions(registry.verifiers) };
      }
      return field;
    })
  }));
}

function requireKnowledge(options: PlatformOptions): KnowledgeProviderPort {
  if (!options.knowledge) {
    throw new PlatformError("知识库服务未接入。", 503);
  }
  return options.knowledge;
}

function parseBaseIds(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new PlatformError("knowledgeBaseIds 必须是字符串数组。", 400);
  }
  return [...new Set(value.map((item) => (item as string).trim()))];
}

function fail(response: Response, error: unknown) {
  if (error instanceof WorkflowCompileError) {
    response.status(400).json({ message: error.message, issues: error.issues });
    return;
  }
  if (error instanceof WorkflowSyntaxError) {
    response.status(400).json({
      message: error.message,
      issues: [{ code: "syntax", path: error.path, message: error.message }]
    });
    return;
  }
  if (error instanceof PlatformError) {
    response.status(error.status).json({ message: error.message });
    return;
  }
  // 知识库服务用自带 status 的 KnowledgeError 表达 4xx/5xx，这里透传状态码。
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 600) {
    response.status(status).json({ message: error instanceof Error ? error.message : "知识库请求失败。" });
    return;
  }
  console.error("[platform] 请求处理失败", error);
  response.status(500).json({ message: error instanceof Error ? error.message : "平台请求失败。" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 运行分流：
 * - releaseId=null 显式绕过演化控制面；
 * - 指定 releaseId 时只允许 active/canary 发布；
 * - 未指定时按活跃金丝雀 / 当前生效发布自动选择；没有发布则保持旧行为。
 */
function resolveRunRelease(
  body: Record<string, unknown>,
  workflowId: string,
  evolution?: EvolutionService
): RunReleasePick | undefined {
  if (!evolution?.enabled()) {
    if (body.releaseId !== undefined && body.releaseId !== null) {
      throw new PlatformError("演化控制面未启用，不能指定 releaseId。", 400);
    }
    return undefined;
  }
  if (body.releaseId === null) {
    return undefined;
  }
  if (typeof body.releaseId === "string" && body.releaseId.trim() !== "") {
    const manifest = evolution.getRelease(body.releaseId.trim());
    if (manifest.workflowId !== workflowId) {
      throw new PlatformError("releaseId 与 workflowId 不匹配。", 400);
    }
    if (manifest.status !== "active" && manifest.status !== "canary") {
      throw new PlatformError(`发布「${manifest.id}」状态为 ${manifest.status}，不能承接运行。`, 409);
    }
    return {
      releaseId: manifest.id,
      arm: "treatment",
      assignmentKey: `explicit:${manifest.id}:${randomUUID()}`
    };
  }
  return evolution.pickRelease(
    workflowId,
    typeof body.assignmentKey === "string" ? body.assignmentKey : undefined
  );
}
