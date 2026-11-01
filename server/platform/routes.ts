import type { Express, Response } from "express";
import {
  NODE_KINDS,
  PlatformError,
  type ApprovalDecision,
  type ApprovalStatus,
  type WorkflowDefinition
} from "./types.js";
import { loadBuiltinWorkflows, parseWorkflowDefinition, WorkflowSyntaxError } from "./workflow/dsl.js";
import { compileWorkflow, WorkflowCompileError } from "./workflow/compiler.js";
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
import { BUILTIN_TOOLS, parseToolWrite } from "./registry/tools.js";
import { parseTeamWrite } from "./registry/teams.js";
import { DEMO_MCP_SERVER, McpManager } from "./mcp/mcpManager.js";
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
  VERIFY_CONTRACT,
  VERIFY_DEFAULTS,
  VERIFY_FORMULA,
  VERIFY_LAYERS
} from "./verify/verifier.js";
import { collectMetrics } from "./metrics/collector.js";

type PlatformOptions = {
  store?: PlatformStateStore;
  executor?: WorkflowExecutor;
  knowledge?: KnowledgeProviderPort;
  mcp?: McpManager;
};

export function registerPlatform(app: Express, options: PlatformOptions = {}) {
  const store = options.store ?? new PlatformStateStore();
  const executor = options.executor ?? new WorkflowExecutor(store);
  const mcp = options.mcp ?? new McpManager(store);
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
      seededRegistry
    });
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
    response.json({
      formula: SCHEDULER_FORMULA,
      weights: DEFAULT_SCHEDULER_WEIGHTS,
      agentCount: agents.length,
      capabilities
    });
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
    const workflowIds = store.listWorkflows().map((workflow) => workflow.id);
    response.json({
      version: NODE_TYPE_CONTRACT_VERSION,
      commonFields: COMMON_NODE_FIELDS,
      nodeTypes: withWorkflowOptions(NODE_TYPE_SPECS, workflowIds),
      canvas: CANVAS_CONTRACT
    });
  });

  app.post("/api/platform/workflows", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const definition = parseWorkflowDefinition(body.dsl ?? body);
      const plan = compileWorkflow(definition, { resolveWorkflow: storeWorkflowResolver(store) });
      store.saveWorkflow(definition);
      response.status(201).json({
        workflow: store.getWorkflow(definition.id, definition.version),
        plan: plan.stats
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
      if (body.async === true) {
        const run = executor.start(stored.definition, input);
        response.status(202).json({ run });
        return;
      }
      const result = await executor.run(stored.definition, input);
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
      if (!stored) {
        throw new PlatformError("运行对应的工作流版本不存在。", 404);
      }
      const next = executor.start(stored.definition, run.input);
      response.status(202).json({ run: next, retryOf: run.id });
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
    approvals: store.listApprovals({ runId })
  };
}

function seedRegistry(store: PlatformStateStore) {
  return {
    agents: store.seedAgents(BUILTIN_AGENTS),
    tools: store.seedTools(BUILTIN_TOOLS),
    mcpServers: store.seedMcpServers([DEMO_MCP_SERVER])
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

function withWorkflowOptions(specs: NodeTypeSpec[], workflowIds: string[]): NodeTypeSpec[] {
  return specs.map((spec) => {
    if (spec.kind !== "subworkflow") {
      return spec;
    }
    return {
      ...spec,
      fields: spec.fields.map((field) =>
        field.key === "workflowId" ? { ...field, options: workflowIds } : field
      )
    };
  });
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
