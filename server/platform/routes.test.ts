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
