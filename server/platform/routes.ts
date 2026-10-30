import type { Express, Response } from "express";
import { NODE_KINDS, PlatformError, type WorkflowDefinition } from "./types.js";
import { loadBuiltinWorkflows, parseWorkflowDefinition, WorkflowSyntaxError } from "./workflow/dsl.js";
import { compileWorkflow, WorkflowCompileError } from "./workflow/compiler.js";
import {
  CANVAS_CONTRACT,
  COMMON_NODE_FIELDS,
  NODE_TYPE_CONTRACT_VERSION,
  NODE_TYPE_SPECS
} from "./workflow/nodeTypes.js";
import { PlatformStateStore } from "./runtime/stateStore.js";
import { WorkflowExecutor } from "./runtime/executor.js";
import { BUILTIN_AGENTS, parseAgentWrite } from "./registry/agents.js";
import { BUILTIN_TOOLS, parseToolWrite } from "./registry/tools.js";

type PlatformOptions = {
  store?: PlatformStateStore;
  executor?: WorkflowExecutor;
};

export function registerPlatform(app: Express, options: PlatformOptions = {}) {
  const store = options.store ?? new PlatformStateStore();
  const executor = options.executor ?? new WorkflowExecutor(store);
  const builtinWorkflows = seedBuiltinWorkflows(store);
  const seededRegistry = seedRegistry(store);

  app.get("/api/platform/health", (_request, response) => {
    response.json({
      status: "ok",
      ...store.health(),
      nodeKinds: NODE_KINDS,
      builtinWorkflows,
      registry: store.registrySummary(),
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
      const body = isRecord(request.body) ? request.body : {};
      const existing = typeof body.id === "string" ? store.getAgent(body.id) : undefined;
      const agent = parseAgentWrite(body, existing);
      store.saveAgent(agent);
      response.status(existing ? 200 : 201).json({ agent: store.getAgent(agent.id), created: !existing });
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

  app.get("/api/platform/workflows", (_request, response) => {
    response.json({ workflows: store.listWorkflows() });
  });

  app.get("/api/platform/node-types", (_request, response) => {
    response.json({
      version: NODE_TYPE_CONTRACT_VERSION,
      commonFields: COMMON_NODE_FIELDS,
      nodeTypes: NODE_TYPE_SPECS,
      canvas: CANVAS_CONTRACT
    });
  });

  app.post("/api/platform/workflows", (request, response) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const definition = parseWorkflowDefinition(body.dsl ?? body);
      const plan = compileWorkflow(definition);
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
      const plan = compileWorkflow(definition);
      response.json({ ok: true, issues: [], stats: plan.stats, order: plan.order });
    } catch (error) {
      fail(response, error);
    }
  });

  app.get("/api/platform/runs", (request, response) => {
    const limit = Number(request.query.limit);
    response.json({ runs: store.listRuns(Number.isInteger(limit) ? limit : 20) });
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
    loopIterations: store.listLoopIterations(runId)
  };
}

function seedRegistry(store: PlatformStateStore) {
  return {
    agents: store.seedAgents(BUILTIN_AGENTS),
    tools: store.seedTools(BUILTIN_TOOLS)
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

  for (const workflow of workflows) {
    try {
      compileWorkflow(workflow);
      store.saveWorkflow(workflow);
      ids.push(workflow.id);
    } catch (error) {
      const detail = error instanceof WorkflowCompileError ? error.message : String(error);
      console.warn(`[platform] 内置工作流 ${workflow.id} 未通过校验：${detail}`);
    }
  }
  return ids;
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
  console.error("[platform] 请求处理失败", error);
  response.status(500).json({ message: error instanceof Error ? error.message : "平台请求失败。" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
