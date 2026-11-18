import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { registerPlatform } from "./routes.js";
import { PlatformStateStore } from "./runtime/stateStore.js";
import { runWithAuth } from "../auth/context.js";
import type { WorkflowDefinition } from "./types.js";
import { configureTestModels } from "../testing/modelFixtures.js";

// 模型密钥只能来自账号设置，环境变量不再兜底：整份用例统一先备好一条可用模型。
let restoreModels: () => void;
before(() => {
  restoreModels = configureTestModels([{ id: "test-model", tags: ["fast", "reasoning"] }]);
});
after(() => restoreModels());

test("exposes registry agents and tools as node dropdown options", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-routes-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  const app = express();
  app.use(express.json());
  registerPlatform(app, { store });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/platform`;

  try {
    const payload = await fetch(`${base}/node-types`).then((response) => response.json()) as {
      nodeTypes: Array<{
        kind: string;
        fields: Array<{ key: string; type: string; options?: string[]; optionLabels?: Record<string, string> }>;
      }>;
    };
    const field = (kind: string, key: string) =>
      payload.nodeTypes.find((spec) => spec.kind === kind)!.fields.find((item) => item.key === key)!;

    const agentField = field("agent", "agent");
    assert.ok(agentField.options?.includes("lesson-plan-agent"));
    assert.equal(agentField.optionLabels?.["lesson-plan-agent"], "教案生成 Agent");

    const toolField = field("tool", "tool");
    assert.ok(toolField.options?.includes("knowledge.search"));
    assert.match(toolField.optionLabels?.["knowledge.search"] ?? "", /知识库/);

    const workflowField = field("subworkflow", "workflowId");
    assert.ok((workflowField.options?.length ?? 0) > 0);

    const verifierField = field("verify", "verifier");
    assert.ok(verifierField.options?.includes("observer-verifier"));

    assert.equal(field("agent", "agentVersion").type, "select");

    // 模型下拉不再有后端写死的条目：第一项固定是「跟随默认」，其余来自设置里配好的模型。
    const modelField = field("agent", "model");
    assert.equal(modelField.type, "select");
    assert.equal(modelField.options?.[0], "platform-default");
    assert.match(modelField.optionLabels?.["platform-default"] ?? "", /跟随默认/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("saving an existing workflow appends a version and keeps old versions intact", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-routes-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  const app = express();
  app.use(express.json());
  registerPlatform(app, { store });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/platform`;
  const post = async <T>(url: string, body: unknown): Promise<T> => {
    const response = await fetch(`${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    assert.ok(response.ok, JSON.stringify(payload));
    return payload as T;
  };

  const workflow: WorkflowDefinition = {
    id: "version-probe",
    name: "版本探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "draft", kind: "agent", agent: "lesson-plan-agent", title: "第一版节点" }],
    edges: []
  };

  try {
    const first = await post<{ workflow: { definition: WorkflowDefinition }; versionBumped?: boolean }>(
      "/workflows",
      { dsl: workflow }
    );
    assert.equal(first.workflow.definition.version, 1);
    assert.notEqual(first.versionBumped, true);

    const second = await post<{ workflow: { definition: WorkflowDefinition }; versionBumped?: boolean }>(
      "/workflows",
      { dsl: workflow }
    );
    assert.equal(second.workflow.definition.version, 2);
    assert.equal(second.versionBumped, true);

    const oldVersion = await fetch(`${base}/workflows/version-probe?version=1`).then(
      (response) => response.json()
    ) as { workflow: { definition: WorkflowDefinition } };
    assert.equal((oldVersion.workflow.definition.nodes[0] as { title?: string }).title, "第一版节点");

    const started = await post<{
      run: { id: string; workflowVersion: number; definition?: WorkflowDefinition };
    }>("/runs", {
      workflowId: "version-probe",
      version: 2,
      input: {},
      async: true
    });
    assert.equal(started.run.workflowVersion, 2);
    assert.equal(started.run.definition?.version, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("exposes pending human interactions and resumes the run with submitted values", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-routes-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  const app = express();
  app.use(express.json());
  registerPlatform(app, { store });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/platform`;
  const post = async <T>(url: string, body: unknown, expectOk = true): Promise<T> => {
    const response = await fetch(`${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = (await response.json()) as T & { message?: string };
    if (expectOk) {
      assert.ok(response.ok, JSON.stringify(payload));
    } else {
      assert.equal(response.ok, false);
    }
    return payload;
  };
  const workflow: WorkflowDefinition = {
    id: "human-route-probe",
    name: "人工交互接口探针",
    version: 1,
    inputs: [],
    nodes: [
      {
        id: "ask",
        kind: "human",
        title: "填写发言",
        prompt: "请输入本轮发言",
        assignee: "参训教师",
        fields: [
          { key: "text", label: "发言", type: "text", required: true },
          {
            key: "action",
            label: "动作",
            type: "select",
            options: ["continue", "finish"],
            defaultValue: "continue"
          }
        ],
        inputs: { topic: "分数的意义" }
      },
      { id: "echo", kind: "template", template: "${ask.text} / ${ask.action}" }
    ],
    edges: [{ from: "ask", to: "echo" }]
  };

  try {
    await post("/workflows", { dsl: workflow });
    const started = await post<{ run: { id: string } }>("/runs", {
      workflowId: "human-route-probe",
      input: {},
      async: true
    });

    const pending = await waitForPendingInteraction(base, started.run.id);
    assert.equal(pending.nodeId, "ask");
    assert.deepEqual(pending.context, { topic: "分数的意义" });
    assert.equal(pending.fields.length, 2);

    const missing = await post<{ message?: string }>(
      `/interactions/${pending.id}/respond`,
      { values: { action: "continue" } },
      false
    );
    assert.match(missing.message ?? "", /不能为空/);

    const resumed = await post<{
      run: { status: string };
      steps: Array<{ nodeId: string; status: string; output?: unknown }>;
      interactions: Array<{ id: string; status: string; response?: Record<string, unknown> }>;
      interaction: { status: string; actor?: string };
      pending?: unknown;
    }>(`/interactions/${pending.id}/respond`, {
      values: { text: "请同学们看这个例子。" },
      actor: "tester"
    });

    assert.equal(resumed.run.status, "succeeded");
    assert.equal(resumed.interaction.status, "answered");
    assert.equal(resumed.interaction.actor, "tester");
    assert.equal(resumed.pending, undefined);
    assert.equal(resumed.interactions[0]?.status, "answered");
    assert.equal(resumed.interactions[0]?.response?.action, "continue");
    const echo = resumed.steps.find((step) => step.nodeId === "echo");
    assert.equal(echo?.status, "succeeded");
    assert.equal((echo?.output as { value?: string }).value, "请同学们看这个例子。 / continue");

    const duplicate = await post<{ message?: string }>(
      `/interactions/${pending.id}/respond`,
      { values: { text: "重复提交" } },
      false
    );
    assert.match(duplicate.message ?? "", /已处理/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitForPendingInteraction(
  base: string,
  runId: string,
  timeoutMs = 4000
): Promise<{
  id: string;
  nodeId: string;
  context?: Record<string, unknown>;
  fields: Array<{ key: string }>;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/interactions?runId=${encodeURIComponent(runId)}&status=pending`);
    const payload = (await response.json()) as {
      interactions: Array<{
        id: string;
        nodeId: string;
        context?: Record<string, unknown>;
        fields: Array<{ key: string }>;
      }>;
    };
    if (payload.interactions[0]) {
      return payload.interactions[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("等待待输入交互超时");
}

test("model list only shows models the user configured, never key material", async () => {
  const previousDir = process.env.MODEL_SETTINGS_DIR;
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-routes-"));
  // 独立设置目录，避免读到开发机上真实的模型配置；密钥只能来自这里。
  process.env.MODEL_SETTINGS_DIR = path.join(directory, "settings");
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  const app = express();
  app.use(express.json());
  registerPlatform(app, { store });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/platform`;

  try {
    const saved = await fetch(`${base}/models`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: "DeepSeek 对话",
        provider: "deepseek",
        model: "deepseek-chat",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-should-never-leave-the-server",
        costTier: "low"
      })
    });
    assert.equal(saved.status, 200);

    const payload = (await fetch(`${base}/models`).then((response) => response.json())) as {
      models: Array<Record<string, unknown>>;
      total: number;
      defaultModelId: string;
    };
    // 列表里是预置的三条骨架 + 用户刚配的这一条：骨架没有密钥，只有配过的才算可用。
    assert.equal(payload.total, 4);
    assert.equal(payload.defaultModelId, "deepseek-chat");

    const item = payload.models.find((model) => model.id === "deepseek-chat") ?? {};
    assert.equal(item.id, "deepseek-chat");
    assert.equal(item.label, "DeepSeek 对话");
    assert.equal(item.configured, true);
    assert.equal(item.isDefault, true);
    assert.equal(item.keySource, "stored");
    assert.equal("apiKey" in item, false);
    // 预置骨架只带地址和模型名，密钥留白等本人填。
    const seeded = payload.models.filter((model) => model.id !== "deepseek-chat");
    assert.equal(seeded.length, 3);
    assert.equal(
      seeded.every((model) => model.configured === false && model.keySource === "none"),
      true
    );
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes("sk-should-never-leave-the-server"), false);

    const agents = (await fetch(`${base}/registry`).then((response) => response.json())) as {
      agents: Array<{ id: string; model?: string; modelProfile?: { id: string; label: string } }>;
    };
    const diagnostician = agents.agents.find((agent) => agent.id === "business-diagnostician");
    assert.equal(diagnostician?.model, "reasoning");
    assert.equal(diagnostician?.modelProfile?.id, "reasoning");
    // 角色解析到默认模型，标签里带角色名，注册中心仍然可读
    assert.match(diagnostician?.modelProfile?.label ?? "", /推理/);

    const rejected = await fetch(`${base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "model-probe", name: "模型探针", model: "not-registered" })
    });
    assert.equal(rejected.status, 422);
    const error = (await rejected.json()) as { message?: string };
    assert.match(error.message ?? "", /可用模型/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousDir === undefined) {
      delete process.env.MODEL_SETTINGS_DIR;
    } else {
      process.env.MODEL_SETTINGS_DIR = previousDir;
    }
  }
});

test("exposes real scheduler leases and active agent loads", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-routes-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  const app = express();
  app.use(express.json());
  registerPlatform(app, { store });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/platform`;

  try {
    const run = store.createRun({
      workflowId: "lease-route-probe",
      workflowVersion: 1,
      workflowInput: {},
      mode: "stub",
      status: "running"
    });
    const lease = store.acquireSchedulerLease({
      runId: run.id,
      taskPath: "review",
      agentId: "topic-innovation-agent",
      workerId: "worker-route-test",
      ttlMs: 60000
    });

    const summary = (await fetch(`${base}/scheduler`).then((response) => response.json())) as {
      activeLoads: Record<string, { inFlight: number }>;
      runtime: { workerId: string; leaseTtlMs: number };
    };
    assert.deepEqual(summary.activeLoads, { "topic-innovation-agent": { inFlight: 1 } });
    assert.equal(typeof summary.runtime.workerId, "string");
    assert.ok(summary.runtime.leaseTtlMs > 0);

    const active = (await fetch(`${base}/scheduler/leases?agentId=topic-innovation-agent`).then((response) =>
      response.json()
    )) as { leases: Array<{ id: string; status: string; releaseReason?: string }> };
    assert.equal(active.leases[0]?.id, lease.id);
    assert.equal(active.leases[0]?.status, "active");

    store.releaseSchedulerLease(lease.id, "completed");
    const all = (await fetch(`${base}/scheduler/leases?active=false&agentId=topic-innovation-agent`).then(
      (response) => response.json()
    )) as { leases: Array<{ status: string; releaseReason?: string }> };
    assert.equal(all.leases[0]?.status, "released");
    assert.equal(all.leases[0]?.releaseReason, "completed");
    const afterRelease = (await fetch(`${base}/scheduler`).then((response) => response.json())) as {
      activeLoads: Record<string, { inFlight: number }>;
    };
    assert.deepEqual(afterRelease.activeLoads, {});
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("保存工作流按账号归属拦截：member 不能覆盖共享/他人版本，部署者改共享保持共享", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-routes-scope-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  const app = express();
  app.use(express.json());
  // 测试用身份中间件：x-test-user 头决定请求以哪个账号进入，模拟真实登录。
  app.use((request, _response, next) => {
    const userId = request.header("x-test-user");
    if (userId) {
      runWithAuth(
        {
          userId,
          username: userId,
          displayName: userId,
          role: userId === "deployer" ? "owner" : "member",
          sessionId: "test"
        },
        () => next()
      );
      return;
    }
    next();
  });
  registerPlatform(app, { store });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/platform`;
  const save = async (user: string | undefined, dsl: unknown) => {
    const response = await fetch(`${base}/workflows`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(user ? { "x-test-user": user } : {})
      },
      body: JSON.stringify({ dsl })
    });
    return { status: response.status, payload: (await response.json()) as { message?: string; workflow?: { definition: WorkflowDefinition; ownerId?: string } } };
  };
  const probe: WorkflowDefinition = {
    id: "scope-probe",
    name: "归属探针",
    version: 1,
    inputs: [],
    nodes: [{ id: "draft", kind: "agent", agent: "lesson-plan-agent", title: "节点" }],
    edges: []
  };

  try {
    // 无身份播种 → 行 owner 为 null（共享），v1。
    const seeded = await save(undefined, probe);
    assert.equal(seeded.status, 201);

    // member 改共享流程：明确 403，而不是静默 no-op 后返回空 workflow。
    const memberHit = await save("member-a", { ...probe, name: "成员改名" });
    assert.equal(memberHit.status, 403);
    assert.match(memberHit.payload.message ?? "", /共享/);

    // 部署者改共享流程：通过，且新版本仍然共享（owner null）。
    const deployerSave = await save("deployer", { ...probe, name: "部署者改名" });
    assert.equal(deployerSave.status, 201);
    assert.equal(deployerSave.payload.workflow?.definition.version, 2);
    const rows = store.listWorkflows();
    assert.ok(rows.some((row) => row.id === "scope-probe"));

    // 部署者落库的 v2 归属为空（共享），member 能看到 v2。
    const memberView = await fetch(`${base}/workflows/scope-probe`, {
      headers: { "x-test-user": "member-a" }
    }).then((response) => response.json()) as { workflow: { definition: WorkflowDefinition } };
    assert.equal(memberView.workflow.definition.version, 2);
    assert.equal(memberView.workflow.definition.name, "部署者改名");

    // member 建自己的流程不受影响。
    const own: WorkflowDefinition = {
      id: "member-own",
      name: "成员自建",
      version: 1,
      inputs: [],
      nodes: [{ id: "draft", kind: "agent", agent: "lesson-plan-agent", title: "节点" }],
      edges: []
    };
    const memberOwn = await save("member-a", own);
    assert.equal(memberOwn.status, 201);
    const again = await save("member-a", { ...own, name: "成员自建二" });
    assert.equal(again.status, 201);
    assert.equal(again.payload.workflow?.definition.version, 2);

    // 版本号撞上别人看不见的私有行：409 而不是静默 no-op。
    const collide: WorkflowDefinition = { ...own, id: "member-own", version: 2 };
    const memberB = await save("member-b", collide);
    assert.equal(memberB.status, 409);
    assert.match(memberB.payload.message ?? "", /版本冲突|占用/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("转交工具 agent:// 按智能体校验，不再被当成找不到的 MCP 工具", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-routes-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  const app = express();
  app.use(express.json());
  registerPlatform(app, { store });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/platform`;

  const save = async (body: Record<string, unknown>) => {
    const response = await fetch(`${base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return {
      status: response.status,
      payload: (await response.json()) as {
        agent?: { tools: string[] };
        message?: string;
      }
    };
  };

  try {
    const target = await save({ id: "deleg-target", name: "备课专项", prompt: "负责备课。" });
    assert.equal(target.status, 201);

    const host = await save({
      id: "deleg-host",
      name: "师者工作台",
      prompt: "把专项问题转交给对应专项。",
      tools: ["agent://deleg-target"]
    });
    assert.equal(host.status, 201);
    assert.deepEqual(host.payload.agent?.tools, ["agent://deleg-target"]);

    const ghost = await save({
      id: "deleg-ghost",
      name: "空指向",
      prompt: "转交给一个不存在的智能体。",
      tools: ["agent://nowhere"]
    });
    assert.equal(ghost.status, 400);
    assert.match(ghost.payload.message ?? "", /要转交的智能体「nowhere」不存在/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
