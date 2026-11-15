import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { registerPlatform } from "./routes.js";
import { PlatformStateStore } from "./runtime/stateStore.js";
import type { WorkflowDefinition } from "./types.js";

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

    const modelField = field("agent", "model");
    assert.equal(modelField.type, "select");
    assert.ok(modelField.options?.includes("reasoning"));
    assert.ok(modelField.options?.includes("verifier"));
    assert.match(modelField.optionLabels?.reasoning ?? "", /推理/);
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

test("exposes the logical model catalog without leaking credentials", async () => {
  const previousKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "test-key";
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
    const payload = (await fetch(`${base}/models`).then((response) => response.json())) as {
      models: Array<Record<string, unknown>>;
      total: number;
    };
    assert.ok(payload.total >= 6);
    const ids = payload.models.map((model) => model.id);
    for (const id of ["platform-default", "fast", "reasoning", "verifier", "vision", "minimax"]) {
      assert.ok(ids.includes(id), id);
    }
    const fast = payload.models.find((model) => model.id === "fast");
    assert.equal(fast?.configured, true);
    assert.equal(fast?.costTier, "low");
    assert.equal("apiKey" in (fast ?? {}), false);
    assert.equal("baseUrl" in (fast ?? {}), false);

    const agents = (await fetch(`${base}/registry`).then((response) => response.json())) as {
      agents: Array<{ id: string; model?: string; modelProfile?: { id: string; label: string } }>;
    };
    const diagnostician = agents.agents.find((agent) => agent.id === "business-diagnostician");
    assert.equal(diagnostician?.model, "reasoning");
    assert.equal(diagnostician?.modelProfile?.id, "reasoning");
    assert.match(diagnostician?.modelProfile?.label ?? "", /推理/);

    const rejected = await fetch(`${base}/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "model-probe", name: "模型探针", model: "not-registered" })
    });
    assert.equal(rejected.status, 422);
    const error = (await rejected.json()) as { message?: string };
    assert.match(error.message ?? "", /可用逻辑模型/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(directory, { recursive: true, force: true });
    if (previousKey === undefined) {
      delete process.env.QWEN_API_KEY;
    } else {
      process.env.QWEN_API_KEY = previousKey;
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
