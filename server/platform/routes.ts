import type { Express, Response } from "express";
import { currentAuth } from "../auth/context.js";
import {
  NODE_KINDS,
  PlatformError,
  type ApprovalDecision,
  type ApprovalStatus,
  type InteractionStatus,
  type PluginWrite,
  type WorkflowDefinition
} from "./types.js";
import {
  describeSyntaxError,
  loadBuiltinWorkflows,
  parseWorkflowDefinition,
  WorkflowSyntaxError
} from "./workflow/dsl.js";
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
import { subscribeRunTokens } from "./runtime/runStreamBus.js";
import { BUILTIN_AGENTS, parseAgentWrite } from "./registry/agents.js";
import { SHARED_CHAT_AGENTS } from "./registry/sharedChatAgents.js";
import {
  describeAgentModel,
  getModelCatalog,
  getModelProfile,
  resolveModel,
  toModelView
} from "./models/catalog.js";
import { completeQwenChat } from "../qwenOpenAiClient.js";
import {
  deleteUserModel,
  getDefaultModelId,
  getUserModel,
  resolveUserApiKey,
  saveUserModel,
  setDefaultModelId
} from "./models/userModels.js";
import { probeModel } from "./models/probe.js";
import { listRemoteModels } from "./models/remoteModels.js";
import { BUILTIN_TOOLS, parseToolWrite } from "./registry/tools.js";
import { parseTeamWrite } from "./registry/teams.js";
import { DATA_ANALYSIS_MCP_SERVER, DEMO_MCP_SERVER, McpManager } from "./mcp/mcpManager.js";
import { PluginService } from "./plugins/pluginService.js";
import { SHARED_PLUGINS } from "./plugins/sharedPlugins.js";
import { syncPluginTools } from "./plugins/pluginTools.js";
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
import { getQwenModel, isQwenConfigured, streamQwenChat } from "../qwenOpenAiClient.js";
import {
  buildDebugSystemPrompt,
  buildFallbackReply,
  buildRunUserMessage,
  chunkFallbackText,
  classifyDebugIntent,
  debugChatModel,
  pickFinalArtifact,
  summarizeNodes,
  type DebugIntent,
  type DebugStep
} from "./workflow/debugChat.js";
import {
  buildRunTrace,
  collectTraceNodeMeta,
  type RunTraceStep
} from "./workflow/runTrace.js";

/**
 * 工作流会话落库端口：主聊天页传 persist=true 时，把这一轮对话写进会话库。
 * 由 server/index.ts 注入，platform 模块不直接依赖 chatRepository。
 */
type WorkflowConversationPersist = (input: {
  conversationId?: string;
  workflowId: string;
  runId?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}) => Promise<string>;

/** 调试助手的流式补全端口；测试可注入本地实现，避免触碰真实模型。 */
type DebugStreamPort = (options: {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  onDelta: (content: string) => void;
}) => Promise<void>;

async function defaultDebugStream(options: Parameters<DebugStreamPort>[0]): Promise<void> {
  await streamQwenChat({
    system: options.system,
    messages: options.messages,
    model: options.model,
    maxTokens: options.maxTokens ?? 700,
    // 调试助手只要正文，关掉上游思考链，首帧从 7 秒级降到 1 秒级。
    disableThinking: true,
    signal: options.signal,
    onDelta: options.onDelta,
    onThinkingDelta: () => {}
  });
}

export type PlatformOptions = {
  store?: PlatformStateStore;
  executor?: WorkflowExecutor;
  knowledge?: KnowledgeProviderPort;
  mcp?: McpManager;
  evolution?: EvolutionService;
  reclaimer?: SchedulerReclaimer;
  debugStream?: DebugStreamPort;
  persistWorkflowConversation?: WorkflowConversationPersist;
};

export function registerPlatform(app: Express, options: PlatformOptions = {}) {
  const store = options.store ?? new PlatformStateStore();
  const executor = options.executor ?? new WorkflowExecutor(store);
  const mcp = options.mcp ?? new McpManager(store);
  const plugins = new PluginService();
  const evolution = options.evolution;
  const reclaimer = options.reclaimer;
  if (evolution) {
    registerEvolutionRoutes(app, evolution);
  }
  const builtinWorkflows = seedBuiltinWorkflows(store);
  const seededRegistry = seedRegistry(store);
  // 研途引航系列对话智能体与课程示例插件：随代码分发，启动时播种为全员可见。
  const seededSharedAgents = store.seedSharedChatAgents(SHARED_CHAT_AGENTS);
  const seededSharedPlugins = plugins.seedShared(SHARED_PLUGINS);
  if (seededSharedAgents > 0 || seededSharedPlugins > 0) {
    console.log(
      `[platform] 共享资产播种：智能体 ${seededSharedAgents} 个，插件 ${seededSharedPlugins} 个。`
    );
  }

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
    // 隐藏档案只给执行层兜底用，设置列表里不出现。
    const models = getModelCatalog()
      .filter((profile) => !profile.hidden)
      .map(toModelView);
    response.json({ models, total: models.length, defaultModelId: getDefaultModelId() });
  });

  /** 新增 / 更新一个自定义模型（设置面板「模型与密钥」）。密钥留空表示沿用已保存的那条。 */
  app.post("/api/platform/models", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const stored = saveUserModel({
        id: typeof body.id === "string" ? body.id : undefined,
        label: typeof body.label === "string" ? body.label : undefined,
        description: typeof body.description === "string" ? body.description : undefined,
        provider: typeof body.provider === "string" ? body.provider : undefined,
        model: typeof body.model === "string" ? body.model : "",
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : "",
        apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
        tags: Array.isArray(body.tags)
          ? body.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "")
          : undefined,
        costTier:
          body.costTier === "low" || body.costTier === "high" || body.costTier === "medium"
            ? body.costTier
            : undefined
      });
      const profile = getModelProfile(stored.id);
      response.json({ model: profile ? toModelView(profile) : null, defaultModelId: getDefaultModelId() });
    } catch (error) {
      fail(response, error);
    }
  });

  /**
   * 解析「临时表单 / 已存档案」两种来源的接口地址与密钥。
   * 有 id 就先取已存配置，表单里显式填的值优先，缺的才用存档补。
   */
  const readModelTarget = (body: Record<string, unknown>) => {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    let baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
    let model = typeof body.model === "string" ? body.model.trim() : "";
    let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

    if (id) {
      const stored = getUserModel(id);
      if (stored) {
        baseUrl = baseUrl || stored.baseUrl;
        model = model || stored.model;
        apiKey = apiKey || resolveUserApiKey(stored);
      } else {
        const profile = getModelProfile(id);
        if (profile) {
          baseUrl = baseUrl || profile.baseUrl;
          model = model || profile.model;
          apiKey = apiKey || profile.apiKey;
        }
      }
    }
    return { baseUrl, model, apiKey };
  };

  /** 连通性测试：有 id 就用已存配置，否则用请求体里的临时配置（编辑器里「先测再存」）。 */
  app.post("/api/platform/models/test", async (request, response) => {
    try {
      const { baseUrl, model, apiKey } = readModelTarget(isRecord(request.body) ? request.body : {});
      if (!model || !baseUrl) {
        throw new PlatformError("缺少模型 ID 或接口地址，无法测试连通性。", 422);
      }
      const result = await probeModel({ baseUrl, model, apiKey });
      response.json(result);
    } catch (error) {
      fail(response, error);
    }
  });

  /** 拉一把服务方实际可用的模型，省得对着文档手抄模型 ID。 */
  app.post("/api/platform/models/remote", async (request, response) => {
    try {
      const { baseUrl, apiKey } = readModelTarget(isRecord(request.body) ? request.body : {});
      if (!baseUrl) {
        throw new PlatformError("缺少接口地址，拉不到模型列表。", 422);
      }
      response.json(await listRemoteModels({ baseUrl, apiKey }));
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/models/:id/default", (request, response) => {
    try {
      const defaultModelId = setDefaultModelId(request.params.id);
      response.json({ defaultModelId });
    } catch (error) {
      fail(response, error);
    }
  });

  app.delete("/api/platform/models/:id", (request, response) => {
    try {
      if (!deleteUserModel(request.params.id)) {
        throw new PlatformError("这条模型不存在，或不是你在设置里添加的。", 404);
      }
      response.json({ deleted: true, defaultModelId: getDefaultModelId() });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/agents", (request, response) => {
    // scope=chat 只回自建与共享对话智能体：聊天页要的是「能对话的人格」，
    // 内置那批是工作流零件（评分验证器、虚拟学生），混进来只会干扰选择。
    // 无主行是随代码分发的共享智能体（如研途引航系列），全员可见。
    if (request.query.scope === "chat") {
      const agents = store.listChatAgents();
      response.json({ agents, total: agents.length });
      return;
    }
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

  /**
   * 提示词一键优化：把用户随手写的几句话整理成「任务目标 / 任务流程 / 限制说明」的结构。
   * 用当前账号自己的模型，没配模型时按模型目录的提示原样返回 422，不偷偷用平台兜底。
   */
  app.post("/api/platform/agents/polish-prompt", async (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (prompt.length < 8) {
        throw new PlatformError("先写几句提示词，再点一键优化。", 400);
      }
      if (prompt.length > 8000) {
        throw new PlatformError("提示词太长了，先精简到 8000 字以内再优化。", 400);
      }
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
      const description = typeof body.description === "string" ? body.description.trim().slice(0, 200) : "";
      const modelId = typeof body.model === "string" ? body.model.trim() : "";
      const resolution = resolveModel(modelId || undefined, { source: "node", allowRaw: false });
      const result = await completeQwenChat({
        system:
          "你是提示词工程师。把用户写的智能体提示词改写成可直接使用的结构化版本，只输出改写后的提示词本身。" +
          "要求：用「# 任务目标」「# 任务流程」「# 限制说明」三段小标题；保留原意与专有名词，不新增用户没提过的功能；" +
          "流程写成可执行的步骤；限制说明里明确「不确定时说明不知道，不编造」。不要解释、不要 Markdown 代码围栏、不要前后缀客套话。",
        messages: [
          {
            role: "user",
            content: [
              name ? `智能体名称：${name}` : "",
              description ? `用途描述：${description}` : "",
              "",
              "现有提示词：",
              prompt
            ]
              .filter((line) => line !== "")
              .join("\n")
          }
        ],
        model: resolution.model,
        provider: { baseUrl: resolution.baseUrl, apiKey: resolution.apiKey, label: resolution.label },
        maxTokens: 1800,
        temperature: 0.35
      });
      const polished = stripCodeFence(result).trim();
      if (!polished) {
        throw new PlatformError("模型没有返回内容，稍后再试一次。", 502);
      }
      response.json({ prompt: polished.slice(0, 20000), model: resolution.label });
    } catch (error) {
      fail(response, error);
    }
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
      // 自建智能体挂的工具必须在注册中心里真实可用：
      // 存下一个查不到 id，用户只会在聊天里等来「模型没调用」，不如保存时就拦下。
      if (!existing || existing.source === "custom") {
        for (const toolId of agent.tools) {
          const tool = store.getTool(toolId);
          if (!tool) {
            throw new PlatformError(
              `工具「${toolId}」不存在，请先在 MCP 连接页发现它，或把它从列表里移除。`,
              400
            );
          }
          if (tool.type === "mcp" && !tool.enabled) {
            throw new PlatformError(
              `工具「${tool.name}」已停用，请先启用，或把它从列表里移除。`,
              400
            );
          }
        }
      }
      store.saveAgent(agent);
      response.status(existing ? 200 : 201).json({ agent: store.getAgent(agent.id), created: !existing });
    } catch (error) {
      fail(response, error);
    }
  });

  app.delete("/api/platform/agents/:id", (request, response) => {
    try {
      const removed = store.deleteAgent(request.params.id);
      if (!removed) {
        throw new PlatformError("Agent 不存在。", 404);
      }
      response.json({ deleted: true, id: request.params.id });
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

  // ---- 自定义插件（API / 代码两种实现） ----
  app.get("/api/platform/plugins", (_request, response) => {
    response.json(plugins.list());
  });

  app.get("/api/platform/plugins/:id", (request, response) => {
    try {
      const plugin = plugins.get(request.params.id);
      if (!plugin) {
        throw new PlatformError("插件不存在。", 404);
      }
      response.json({ plugin });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/plugins", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      if (typeof body.name !== "string" || !body.name.trim()) {
        throw new PlatformError("插件名称必填。", 400);
      }
      if (body.type !== "api" && body.type !== "code") {
        throw new PlatformError("插件类型只能是 api 或 code。", 400);
      }
      const write: PluginWrite = {
        name: body.name,
        type: body.type,
        description: typeof body.description === "string" ? body.description : undefined,
        domain: typeof body.domain === "string" ? body.domain : undefined,
        runtime: typeof body.runtime === "string" ? body.runtime : undefined,
        endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
        method: typeof body.method === "string" ? body.method : undefined,
        status: body.status === "active" || body.status === "draft" || body.status === "error" ? body.status : undefined
      };
      const created = plugins.create(write);
      syncPluginTools(plugins, store);
      response.status(201).json({ plugin: created, created: true });
    } catch (error) {
      fail(response, error);
    }
  });

  app.patch("/api/platform/plugins/:id", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const patch: Partial<PluginWrite> = {};
      if (body.name !== undefined) patch.name = String(body.name);
      if (body.description !== undefined) patch.description = String(body.description);
      if (body.domain !== undefined) patch.domain = String(body.domain);
      if (body.runtime !== undefined) patch.runtime = String(body.runtime);
      if (body.endpoint !== undefined) patch.endpoint = String(body.endpoint);
      if (body.method !== undefined) patch.method = String(body.method);
      if (body.type === "api" || body.type === "code") patch.type = body.type;
      if (body.status === "active" || body.status === "draft" || body.status === "error") {
        patch.status = body.status;
      }
      const updated = plugins.update(request.params.id, patch);
      syncPluginTools(plugins, store);
      response.json({ plugin: updated });
    } catch (error) {
      fail(response, error);
    }
  });

  app.post("/api/platform/plugins/:id/test", async (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const args = isRecord(body.args) ? body.args : {};
      const result = await plugins.test(request.params.id, args as Record<string, unknown>);
      response.json({ result });
    } catch (error) {
      fail(response, error);
    }
  });

  app.delete("/api/platform/plugins/:id", (request, response) => {
    try {
      const removed = plugins.delete(request.params.id);
      if (!removed) {
        throw new PlatformError("插件不存在。", 404);
      }
      syncPluginTools(plugins, store);
      response.json({ deleted: true });
    } catch (error) {
      fail(response, error);
    }
  });

  /** 创建前验证：用临时记录跑一次真实调用，不落库。 */
  app.post("/api/platform/plugins/preview", async (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const args = isRecord(body.args) ? body.args : {};
      const result = await plugins.preview(body as PluginWrite, args as Record<string, unknown>);
      response.json({ result });
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
    // 只把「已经填了密钥」的模型放进节点下拉，避免选了一条跑不通的配置。
    const usableModels = getModelCatalog().filter(
      (profile) => !profile.hidden && profile.apiKey && profile.baseUrl
    );
    const activeModelId = getDefaultModelId() || usableModels[0]?.id || "";
    const activeModel = usableModels.find((profile) => profile.id === activeModelId);
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
          .map((agent) => ({ id: agent.id, label: agent.name })),
        models: [
          {
            id: "platform-default",
            label: activeModel ? `跟随默认（${activeModel.label}）` : "跟随默认"
          },
          ...usableModels.map((profile) => ({
            id: profile.id,
            label: profile.label
          }))
        ]
      }),
      canvas: CANVAS_CONTRACT
    });
  });

  app.post("/api/platform/workflows", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const parsed = parseWorkflowDefinition(body.dsl ?? body);
      const auth = currentAuth();
      // 后台任务/测试没有登录身份，保持旧行为不拦；有身份时才做归属校验。
      // 已有工作流默认追加版本：覆盖同版本会让历史运行与单步重跑失去可复现性。
      const existing = store.getWorkflow(parsed.id);
      let version: number;
      // 部署者改共享流程（owner 为空）时，新版本继续保持共享，别的账号才能看到更新。
      let keepShared = false;
      if (auth && existing) {
        const canEdit =
          existing.ownerId === null
            ? auth.role === "owner"
            : existing.ownerId === auth.userId;
        if (!canEdit) {
          throw new PlatformError(
            existing.ownerId === null
              ? `「${existing.definition.name}」是内置共享流程，你的账号不能直接覆盖保存。请让部署者修改，或先复制成自己的流程再改。`
              : `「${existing.definition.name}」是其他账号的私有流程，不能覆盖保存。`,
            403
          );
        }
        version = Math.max(parsed.version, existing.definition.version + 1);
        keepShared = existing.ownerId === null && auth.role === "owner";
      } else {
        version = existing ? Math.max(parsed.version, existing.definition.version + 1) : parsed.version;
      }
      // 要写的版本号可能被一条当前账号看不见的行占着（别人的私有版本），
      // 直接 upsert 会因为归属条件不匹配静默跳过，响应再查就是空——必须在写之前拦住。
      const ownerAtVersion = store.workflowVersionOwner(parsed.id, version);
      if (auth && ownerAtVersion !== undefined && ownerAtVersion !== auth.userId) {
        if (ownerAtVersion === null && auth.role === "owner") {
          keepShared = true;
        } else {
          throw new PlatformError(
            `流程版本冲突：${parsed.id} v${version} 已被其他账号占用，请刷新画布后重试。`,
            409
          );
        }
      }
      const definition = version === parsed.version ? parsed : { ...parsed, version };
      const plan = compileWorkflow(definition, { resolveWorkflow: storeWorkflowResolver(store) });
      store.saveWorkflow(definition, keepShared ? null : undefined);
      syncWorkflowTools(store);
      const stored = store.getWorkflow(definition.id, definition.version);
      if (!stored) {
        // 防御：写库与回读之间所有权判定应当一致，走到这里说明语义被破坏，明确报错而不是返回空 workflow。
        throw new PlatformError("保存未能生效：目标版本属于其他账号，请刷新画布后重试。", 409);
      }
      response.status(201).json({
        workflow: stored,
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
            const described = describeSyntaxError(source, error);
            issues.push({
              code: "syntax",
              path: described.path,
              message: described.message,
              nodeId: described.nodeId,
              paramIndex: described.paramIndex,
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

  /** 调试运行报错的结构化详情，前端按「节点 / 问题」逐条展示。 */
  type DebugIssue = {
    code: string;
    path: string;
    message: string;
    severity?: string;
    /** 能在画布上定位到的节点 ID；工作流级问题（如输入为空）不填。 */
    nodeId?: string;
    /** 落在「参数提取」节点某参数上时的参数下标，前端可滚到那一行。 */
    paramIndex?: number;
  };

  /**
   * 调试助手对话流。
   * - 普通会话（主聊天页）：提问由模型直接流式回答，显式要求才跑流程。
   * - 画布调试面板（strictRun）：每轮都跑工作流，跑前做静态校验，
   *   有问题直接把节点级详情下发、绝不回退到模型兜底话术。
   */
  app.post("/api/platform/workflows/:id/debug/chat", async (request, response) => {
    const body = isRecord(request.body) ? request.body : {};
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";
    // 兼容旧调用方：显式 forceRun 仍可绕过意图分类；画布调试面板已改用 strictRun。
    const forceRun = body.forceRun === true;
    /** 画布调试面板专用：默认跑工作流，不做意图分流、不做兜底模型回复。 */
    const strictRun = body.strictRun === true;
    // 主聊天页的工作流会话需要落库；调试面板不传 persist，行为保持不变。
    const persist = body.persist === true;
    const conversationIdHint =
      typeof body.conversationId === "string" && body.conversationId.trim()
        ? body.conversationId.trim().slice(0, 200)
        : undefined;
    const history = (Array.isArray(body.history) ? body.history : [])
      .filter(isRecord)
      .flatMap((item) => {
        if (
          (item.role !== "user" && item.role !== "assistant") ||
          typeof item.content !== "string"
        ) {
          return [];
        }
        return [
          {
            role: item.role as "user" | "assistant",
            content: item.content.slice(0, 8000)
          }
        ];
      })
      .slice(-40);
    const stored = store.getWorkflow(request.params.id);
    if (!stored) {
      response.status(404).json({ message: "工作流不存在，请先保存 DSL。" });
      return;
    }
    if (!message) {
      response.status(400).json({ message: "消息不能为空。" });
      return;
    }

    response.status(200);
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders?.();

    const write = (event: string, data: unknown) => {
      if (response.writableEnded) {
        return;
      }
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const abort = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) {
        abort.abort();
      }
    });

    // 画布调试面板会带上当前（可能还没保存）的定义：跑的就是用户眼前这张图。
    // 否则删掉的连线、改过的参数仍然跑库里那份旧版本，表现就是「没连也能往下跑」。
    let definition = stored.definition;
    let draftError: unknown;
    if (strictRun && isRecord(body.definition)) {
      try {
        definition = parseWorkflowDefinition(body.definition);
      } catch (error) {
        draftError = error;
      }
    }
    const workflowName = definition.name?.trim() || request.params.id;
    const nodeCount = Array.isArray(definition.nodes) ? definition.nodes.length : 0;
    const inputNames = Array.isArray(definition.inputs)
      ? definition.inputs.map((item) => item.name).filter(Boolean)
      : [];
    const nodeLabels = (Array.isArray(definition.nodes) ? definition.nodes : [])
      .slice(0, 40)
      .map((node) => {
        const item = node as unknown as Record<string, unknown>;
        const id = typeof item.id === "string" ? item.id : "";
        const type = typeof item.type === "string" ? item.type : "";
        return [id, type].filter(Boolean).join(":");
      })
      .filter(Boolean);
    const intent: DebugIntent = strictRun || forceRun ? "run" : classifyDebugIntent(message);
    const system = buildDebugSystemPrompt({
      workflowName,
      nodeCount,
      inputNames,
      nodeLabels,
      intent
    });
    write("meta", { intent, workflowName, model: strictRun ? "workflow" : debugChatModel() });

    /**
     * 画布调试面板（strictRun）：调试运行就是跑工作流。
     * 不做意图分流、不调用模型、不做任何兜底话术；
     * 工作流配置有问题（必填输入为空、节点没连线、引用/编译不通过）直接把
     * 节点级详情通过 error 事件下发，让用户知道具体哪里错。
     */
    if (strictRun) {
      // 画布定义本身解析不过（节点类型写错、字段结构坏了）就不要往下走。
      if (draftError) {
        const details: DebugIssue[] =
          draftError instanceof WorkflowSyntaxError
            ? [{ code: "syntax", path: draftError.path, message: draftError.message }]
            : [
                {
                  code: "syntax",
                  path: "workflow",
                  message: draftError instanceof Error ? draftError.message : String(draftError)
                }
              ];
        write("error", {
          message: `工作流定义解析失败：${details[0].message}`,
          details,
          blocked: true
        });
        write("done", { intent, blocked: true, usedModel: false });
        response.end();
        return;
      }
      const input = isRecord(body.input) ? body.input : {};
      const issues: DebugIssue[] = [];
      const knownNodeIds = new Set(
        (Array.isArray(definition.nodes) ? definition.nodes : [])
          .map((node) => (typeof node.id === "string" ? node.id : ""))
          .filter(Boolean)
      );
      /**
       * 诊断 path 是裸节点 ID，编译 path 可能带 nodes[i]. / 节点ID/字段 前缀，
       * 前端靠字符串切分不可靠，这里直接在服务端把可定位的 nodeId 一起下发。
       */
      const nodeIdOf = (path: string): string | undefined => {
        let best: string | undefined;
        for (const id of knownNodeIds) {
          if (
            path === id ||
            path.startsWith(`${id}.`) ||
            path.startsWith(`${id}/`) ||
            path.startsWith(`${id}[`) ||
            path.includes(`.${id}.`) ||
            path.includes(`/${id}/`)
          ) {
            if (!best || id.length > best.length) {
              best = id;
            }
          }
        }
        return best;
      };
      const addIssue = (code: string, path: string, message: string, nodeId?: string, paramIndex?: number) => {
        issues.push({ code, path, message, nodeId: nodeId ?? nodeIdOf(path), paramIndex });
      };

      // 1) 工作流必填输入为空
      for (const variable of definition.inputs) {
        if (!variable.required) {
          continue;
        }
        const value = input[variable.name];
        if (
          value === undefined ||
          value === null ||
          (typeof value === "string" && value.trim() === "")
        ) {
          addIssue(
            "missing-required-input",
            `input.${variable.name}`,
            `必填输入「${variable.name}」为空，请在调试面板上方「输入映射」里填写。`
          );
        }
      }

      // 2) 静态诊断：没连线、必填字段/引用参数没填、残缺引用等
      const diagnostics = diagnoseWorkflow(definition);
      for (const issue of diagnostics) {
        if (issue.severity === "error" || issue.code === "empty-required-port") {
          addIssue(issue.code, issue.path, issue.message);
        }
      }

      // 3) 编译校验：引用顺序、环、子流程入参、loop 作用域等
      if (!hasBlockingIssue(diagnostics)) {
        try {
          compileWorkflow(definition, { resolveWorkflow: storeWorkflowResolver(store) });
        } catch (error) {
          if (error instanceof WorkflowCompileError) {
            for (const issue of error.issues) {
              addIssue(issue.code, issue.path, issue.message);
            }
          } else if (error instanceof WorkflowSyntaxError) {
            const described = describeSyntaxError(definition, error);
            addIssue("syntax", described.path, described.message, described.nodeId, described.paramIndex);
          } else {
            addIssue("compile", "workflow", error instanceof Error ? error.message : String(error));
          }
        }
      }

      if (issues.length > 0) {
        write("error", {
          message: `工作流检查未通过：共 ${issues.length} 处问题，本轮没有执行。`,
          details: issues,
          blocked: true
        });
        write("done", { intent, blocked: true, usedModel: false });
        response.end();
        return;
      }

      // 校验通过才真正执行。
      // 这里不用 await executor.run()：含人工交互节点的工作流会停等输入，
      // 全局调度队列也可能被别的运行占住，同步等待会让 SSE 无限转圈。
      // 改成异步启动 + 轮询：实时下发待填字段，超时就取消并回报卡在哪。
      const debugTimeoutMs = Math.min(
        600_000,
        Math.max(10_000, Number(process.env.PLATFORM_DEBUG_RUN_TIMEOUT_MS) || 180_000)
      );
      const activeStatuses = new Set<string>([
        "queued",
        "running",
        "verifying",
        "revising",
        "waiting_approval",
        "waiting_input"
      ]);
      let startedRunId: string;
      try {
        startedRunId = executor.start(definition, input).id;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        write("error", {
          message: `工作流启动失败：${reason}`,
          details: [{ code: "run-error", path: "workflow", message: reason }]
        });
        write("done", { intent, usedModel: false });
        response.end();
        return;
      }

      // runId 一并下发：前端退出调试时可以立刻取消这条运行，不用等下一个 progress。
      write("status", { text: "正在执行工作流…", runId: startedRunId });

      /**
       * 真流式：live handler 边生成边把 token 推到 runStreamBus，这里订阅后
       * 立刻转发给面板。每个 path 第一帧开一条流式回复（done=false），后续
       * 帧按同一 id 追加；步骤跑完后用台账里的最终产物整篇替换收尾
       * （replace=true），保证截断、JSON 归一化之类后处理不会造成前后不一致。
       */
      const streamCounts = new Map<string, number>();
      const openStreamIds = new Map<string, string>();
      /**
       * 只有「会打印到会话」的节点才允许流式上屏。子流程里的中间 LLM
       * （如答辩训练里被「回复」模板引用的大模型）跑完后模板会原样渲染一遍，
       * 如果 LLM 本身也流式推送，同一段正文就会在面板里出现两遍。
       * outputConfig 按节点 id 递归收集（含被引用子工作流），这里按 path 末段查开关。
       */
      const isEmittablePath = (streamPath: string): boolean => {
        const leaf = streamPath.split("/").pop() ?? streamPath;
        const root = streamPath.split("/")[0];
        const config = outputConfig.get(leaf) ?? outputConfig.get(root);
        return config?.emit === true;
      };
      const unsubscribeTokens = subscribeRunTokens(startedRunId, ({ path, delta }) => {
        if (abort.signal.aborted || response.writableEnded) {
          return;
        }
        if (!isEmittablePath(path)) {
          return;
        }
        let id = openStreamIds.get(path);
        if (!id) {
          const count = (streamCounts.get(path) ?? 0) + 1;
          streamCounts.set(path, count);
          id = `${path}:stream:${count}`;
          openStreamIds.set(path, id);
          const titleKey = path.split("/").pop() ?? path;
          write("output", {
            id,
            nodeId: path,
            title: nodeTitles.get(titleKey) ?? path,
            kind: "stream",
            stream: true,
            reveal: false,
            text: delta,
            done: false
          });
          return;
        }
        write("output", { id, text: delta, done: false });
      });
      /** 流式收尾：用台账最终产物整篇替换，前端停止流式状态。 */
      const closeStream = (path: string, text: string): void => {
        const id = openStreamIds.get(path);
        if (!id) {
          return;
        }
        openStreamIds.delete(path);
        if (abort.signal.aborted || response.writableEnded) {
          return;
        }
        write("output", { id, nodeId: path, kind: "stream", stream: true, reveal: false, text, done: true, replace: true });
      };
      const closeAllStreams = (): void => {
        for (const path of [...openStreamIds.keys()]) {
          closeStream(path, "");
        }
      };
      const disconnectCleanup = (): void => {
        unsubscribeTokens();
        closeAllStreams();
      };

      let deadline = Date.now() + debugTimeoutMs;
      // 表单已交给用户时 deadline 会续期，但整条 SSE 仍要有绝对上限，避免连接挂死。
      const hardDeadline = Date.now() + Math.max(debugTimeoutMs * 5, 600_000);
      const announced = new Set<string>();
      const nodeTitles = new Map<string, string>();
      /**
       * 只有「输出节点」的正文能打印到调试会话；其它节点的产物只用于向下游传变量。
       * DSL 没写开关时的默认：标题为「回复 / 回答 / 输出 …」的 template 节点是回复节点，
       * 其余 template（如变量转换）与 llm / human 等一律不打印，避免同一段内容重复刷屏。
       * 循环体/子工作流里的回复节点也要打印——答辩训练的追问正文、评分都在子流程里，
       * 之前只收集顶层节点，导致子流程的回复永远不打印、问题只能靠人工节点 prompt 一次性蹦出。
       * 这里按 workflowId 递归收集被引用工作流的节点（防环：visitedWorkflows + 深度上限）。
       */
      const replyTitle = /^(回复|回答|答复|输出|answer|output|respond)/i;
      const outputConfig = new Map<string, { emit: boolean; stream: boolean }>();
      const visitedWorkflows = new Set<string>();
      const collectOutputNodes = (nodes: unknown, depth = 0): void => {
        if (depth > 5 || !Array.isArray(nodes)) {
          return;
        }
        for (const node of nodes) {
          if (!node || typeof node !== "object") {
            continue;
          }
          const item = node as Record<string, unknown>;
          if (typeof item.id !== "string") {
            continue;
          }
          const kind = typeof item.kind === "string" ? item.kind : "";
          const title = typeof item.title === "string" ? item.title.trim() : "";
          if (!nodeTitles.has(item.id)) {
            nodeTitles.set(item.id, title || item.id);
          }
          if (!outputConfig.has(item.id)) {
            outputConfig.set(item.id, {
              emit:
                typeof item.emitOutput === "boolean"
                  ? item.emitOutput
                  : kind === "template" && replyTitle.test(title),
              stream: typeof item.streamOutput === "boolean" ? item.streamOutput : true
            });
          }
          // 循环体 / 容器内嵌套的节点定义
          collectOutputNodes(item.body, depth + 1);
          collectOutputNodes(item.nodes, depth + 1);
          // 子工作流引用：递归收集被引用工作流的节点
          const workflowId = typeof item.workflowId === "string" ? item.workflowId : "";
          if (workflowId && !visitedWorkflows.has(workflowId)) {
            visitedWorkflows.add(workflowId);
            const stored = store.getWorkflow(workflowId);
            if (stored) {
              collectOutputNodes(stored.definition.nodes, depth + 1);
            }
          }
        }
      };
      collectOutputNodes(definition.nodes);
      /** 模板节点常带内联 HTML，推给面板前去掉标签，只留可读正文。 */
      const stepText = (output: unknown, limit = 1200): string => {
        const plain = (value: string): string =>
          value
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]*>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .trim()
            .slice(0, limit);
        if (typeof output === "string") {
          return plain(output);
        }
        if (!isRecord(output)) {
          return "";
        }
        const candidate = output.output ?? output.value ?? output.content ?? output.answer;
        return typeof candidate === "string" ? plain(candidate) : "";
      };
      let lastProgressSequence = 0;
      let printedCount = 0;
      let settled = false;
      let disconnected = false;
      while (Date.now() < deadline && Date.now() < hardDeadline) {
        if (abort.signal.aborted || response.writableEnded) {
          disconnected = true;
          break;
        }
        const current = store.getRun(startedRunId);
        if (!current) {
          break;
        }

        // 每有新节点跑完就下发一次节点状态，让画布实时高亮；正文单独走 output 事件，
        // 并且只发给输出节点，避免同一个大模型结果在 llm 节点和回复节点里重复打印。
        const liveSteps = store.listSteps(startedRunId);
        const finished = liveSteps.filter(
          (step) =>
            step.sequence > lastProgressSequence &&
            (step.status === "succeeded" || step.status === "failed" || step.status === "skipped")
        );
        if (finished.length > 0) {
          lastProgressSequence = Math.max(...finished.map((step) => step.sequence));
          write("progress", {
            runId: startedRunId,
            nodes: summarizeNodes(liveSteps as unknown as DebugStep[])
          });
        }

        for (const step of finished) {
          // 有真流式的节点：这里只负责收尾（整篇替换 + 停止流式状态），
          // 正文在生成过程中已经逐帧推给面板了，不再整篇重发一遍。
          if (openStreamIds.has(step.path)) {
            closeStream(step.path, stepText(step.output, Number.POSITIVE_INFINITY));
            printedCount += 1;
            continue;
          }
          // 容器内的子节点 path 形如 loopId/childId，回退到顶层节点查开关。
          const config =
            outputConfig.get(step.nodeId) ?? outputConfig.get(step.path.split("/")[0]);
          if (!config?.emit) {
            continue;
          }
          const text = stepText(step.output);
          if (!text) {
            continue;
          }
          printedCount += 1;
          // 正文一次发全，逐字动画交给前端按字数渲染。早先在轮询循环里串行
          // sleep 分片，会把后续节点状态、人工输入表单一起卡住，断线还只剩半句。
          // reveal 为 true 表示这条要做打字动画；关掉流式开关时直接整篇显示。
          write("output", {
            id: `${step.nodeId}:${step.sequence}`,
            nodeId: step.nodeId,
            title: nodeTitles.get(step.nodeId) ?? step.nodeId,
            kind: step.nodeKind,
            stream: config.stream,
            reveal: config.stream,
            text,
            done: true
          });
        }
        if (disconnected) {
          break;
        }

        // 人工输入节点挂起时把字段下发给调试面板，用户填完提交后运行会继续。
        const pending = store.listInteractions({
          runId: startedRunId,
          status: "pending",
          limit: 5
        });
        for (const interaction of pending) {
          if (announced.has(interaction.id)) {
            continue;
          }
          announced.add(interaction.id);
          write("interaction", {
            id: interaction.id,
            nodeId: interaction.nodeId,
            path: interaction.path,
            title: interaction.title,
            prompt: interaction.prompt,
            fields: interaction.fields
          });
          write("status", { text: `等待人工输入：${interaction.title}` });
        }
        if (pending.length > 0) {
          // 表单已经摆到用户面前，读题与作答的时间不该算进「卡死」判定。
          deadline = Date.now() + debugTimeoutMs;
        }
        if (!activeStatuses.has(current.status)) {
          settled = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      if (!settled && !disconnected) {
        // 超时后必须把后台运行取消掉，否则它还会继续占着调度槽位。
        try {
          executor.cancelRun(startedRunId);
        } catch {
          // 运行可能刚好在终态，忽略即可。
        }
      }
      if (disconnected) {
        // 前端断开后不会再有人填写人工输入，取消运行以免又留下一条僵尸等待占住调度槽位。
        try {
          executor.cancelRun(startedRunId);
        } catch {
          // 运行可能刚好到了终态，忽略即可。
        }
        disconnectCleanup();
        response.end();
        return;
      }
      if (!settled) {
        const details: DebugIssue[] = [];
        for (const interaction of store.listInteractions({
          runId: startedRunId,
          status: "pending",
          limit: 5
        })) {
          details.push({
            code: "waiting-human-input",
            path: interaction.path || interaction.nodeId,
            nodeId: interaction.nodeId,
            message: `节点「${interaction.title}」在等待人工输入，本轮没在限定时间内提交。`
          });
        }
        // 别的运行占住全局调度槽位是最常见的卡住原因，逐条列出来。
        const others = store
          .listInteractions({ status: "pending", limit: 10 })
          .filter((item) => item.runId !== startedRunId);
        for (const interaction of others.slice(0, 5)) {
          details.push({
            code: "scheduler-slot-occupied",
            path: interaction.path || interaction.nodeId,
            message: `另有一条运行（${interaction.runId}）的「${interaction.title}」仍在等待人工输入，占用了调度槽位；可在监控台填写或取消，或重启后端清空等待点。`
          });
        }
        if (details.length === 0) {
          details.push({
            code: "run-timeout",
            path: "workflow",
            message: `运行 ${Math.round(debugTimeoutMs / 1000)} 秒仍未结束，常见原因是含人工交互节点未填写，或全局调度队列被其他未结束的运行占满。`
          });
        }
        write("error", {
          message: `调试运行超过 ${Math.round(debugTimeoutMs / 1000)} 秒未结束，本轮已取消。`,
          details,
          blocked: true,
          runId: startedRunId
        });
        disconnectCleanup();
        write("done", { intent, blocked: true, usedModel: false, runId: startedRunId });
        response.end();
        return;
      }

      const result = {
        run: store.getRun(startedRunId)!,
        steps: store.listSteps(startedRunId)
      };
      const steps = result.steps as unknown as DebugStep[];
      const artifact = pickFinalArtifact(steps);
      const nodes = summarizeNodes(steps);
      write("nodes", {
        nodes,
        run: {
          id: result.run.id,
          status: result.run.status,
          mode: result.run.mode,
          stepCount: result.run.stepCount,
          durationMs: result.run.durationMs
        },
        artifactNodeId: artifact?.nodeId
      });
      if (result.run.status === "failed") {
        const failed: DebugIssue[] = steps
          .filter((step) => step.status === "failed")
          .map((step) => {
            const detail = (step as unknown as Record<string, unknown>).error;
            return {
              code: "node-failed",
              path: step.path ?? step.nodeId ?? "workflow",
              nodeId: step.nodeId,
              message:
                typeof detail === "string" && detail.trim()
                  ? detail
                  : `节点「${step.nodeId ?? step.path}」执行失败`
            };
          });
        write("error", {
          message: `工作流运行失败：${failed.length || 1} 个节点报错，详情如下。`,
          details: failed.length > 0 ? failed : [{ code: "run-failed", path: "workflow", message: "运行以失败状态结束" }],
          runId: result.run.id
        });
        disconnectCleanup();
        write("done", { intent, runId: result.run.id, usedModel: false });
        response.end();
        return;
      }

      // 成功：输出节点已在运行过程中逐条发全，这里不再重复整篇结果，
      // 否则同一段正文会在回复区出现两遍。整轮没有输出节点时给一句明确说明。
      if (printedCount === 0) {
        write("notice", {
          text: "本轮没有输出节点打印内容：其它节点的产物只作为变量传给下游，不会直接打印。想看正文，请在回复节点打开「打印到会话」。"
        });
      }
      disconnectCleanup();
      write("done", { intent, runId: result.run.id, usedModel: false });
      response.end();
      return;
    }

    let userMessage = message;
    let fallbackContext: Parameters<typeof buildFallbackReply>[0] = { intent, workflowName, message };
    let runId: string | undefined;

    if (intent === "run") {
      write("status", { text: "正在执行工作流…" });
      const input = isRecord(body.input) ? body.input : {};
      try {
        const result = await executor.run(definition, input);
        const steps = result.steps as unknown as DebugStep[];
        const artifact = pickFinalArtifact(steps);
        const nodes = summarizeNodes(steps);
        runId = result.run.id;
        fallbackContext = {
          intent,
          workflowName,
          message,
          status: result.run.status,
          mode: result.run.mode,
          stepCount: result.run.stepCount,
          durationMs: result.run.durationMs
        };
        write("nodes", {
          nodes,
          run: {
            id: result.run.id,
            status: result.run.status,
            mode: result.run.mode,
            stepCount: result.run.stepCount,
            durationMs: result.run.durationMs
          },
          artifactNodeId: artifact?.nodeId
        });
        // 轨迹标识：这轮真的走了哪些智能体/子流程、调了哪些工具插件，
        // 聊天页拿它渲染在回复上方的小字标签里（调试面板不依赖这个事件）。
        const traceNodeMeta = collectTraceNodeMeta(definition, (workflowId) =>
          store.getWorkflow(workflowId)?.definition
        );
        const trace = buildRunTrace({
          steps: result.steps as unknown as RunTraceStep[],
          nodeMeta: (nodeId) => traceNodeMeta.get(nodeId),
          resolveTool: (toolId) => store.getTool(toolId),
          resolvePluginName: (pluginId) => plugins.get(pluginId)?.name
        });
        write("trace", trace);
        userMessage = buildRunUserMessage({
          message,
          artifact: artifact?.output,
          artifactNodeId: artifact?.nodeId,
          status: result.run.status,
          mode: result.run.mode,
          stepCount: result.run.stepCount,
          durationMs: result.run.durationMs,
          nodes
        });
        write("status", { text: "运行结束，正在整理结果" });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        fallbackContext = { intent, workflowName, message, error: reason };
        userMessage = buildRunUserMessage({ message, error: reason });
        write("status", { text: "工作流执行失败" });
      }
    }

    const stream = options.debugStream ?? defaultDebugStream;
    let sent = false;
    let modelOk = false;
    // 累积本轮助手文字，persist 时作为一条 assistant 消息写进会话库。
    let answer = "";
    const canCallModel = Boolean(options.debugStream) || isQwenConfigured();
    const candidates = [...new Set([debugChatModel(), getQwenModel()])].filter(Boolean);

    if (canCallModel) {
      for (const model of candidates) {
        try {
          await stream({
            system,
            messages: [{ role: "user", content: userMessage }],
            model,
            // 直接回答实质问题需要比「转述一次产物」更宽一点的空间。
            maxTokens: intent === "chat" ? 1000 : 700,
            signal: abort.signal,
            onDelta: (content) => {
              sent = true;
              answer += content;
              write("delta", { content });
            }
          });
          modelOk = true;
          break;
        } catch {
          // 第一个模型不可用时换默认模型；已经吐过字就不重试，避免内容重复。
          if (sent || abort.signal.aborted) {
            break;
          }
        }
      }
    }

    if (!modelOk && !sent && !abort.signal.aborted) {
      write("notice", { text: "模型没接上，先用本地回复" });
      for (const chunk of chunkFallbackText(buildFallbackReply(fallbackContext))) {
        if (abort.signal.aborted) {
          break;
        }
        write("delta", { content: chunk });
        answer += chunk;
        await new Promise((resolve) => setTimeout(resolve, 18));
      }
    }

    let conversationId: string | undefined;
    if (persist && answer.trim() && !abort.signal.aborted && options.persistWorkflowConversation) {
      try {
        conversationId = await options.persistWorkflowConversation({
          conversationId: conversationIdHint,
          workflowId: request.params.id,
          runId,
          messages: [...history, { role: "assistant", content: answer }]
        });
      } catch {
        // 落库失败不影响这一轮已经流出去的回复。
      }
    }

    write("done", { intent, runId, usedModel: modelOk, conversationId });
    response.end();
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
      // 先按当前账号确认这条审批存在且属于自己，别人的审批一律当不存在。
      if (!store.getApproval(request.params.id)) {
        throw new PlatformError("审批不存在。", 404);
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
      // 早先的「首个账号接管无主数据」把内置流程也划给了那个账号，
      // 第二个账号登进来会看到空列表。按内置文件校正回共享，用户自己存的新版本不动。
      const released = store.releaseBuiltinWorkflow(workflow.id, workflow.version);
      if (released > 0) {
        console.log(`[platform] 内置工作流 ${workflow.id} v${workflow.version} 已恢复为全员可见。`);
      }
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
    models: RegistryOption[];
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
      // 模型下拉直接来自设置里配好的那些，节点上不再出现后端写死的名字。
      if (field.key === "model") {
        return { ...field, ...toFieldOptions(registry.models) };
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

/** 模型偶尔会把整段文本包进 ``` 里，展示到输入框里很难看，先剥掉。 */
function stripCodeFence(text: string) {
  const trimmed = text.trim();
  const matched = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return matched ? matched[1] : trimmed;
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
