import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PlatformStateStore } from "./stateStore.js";
import { WorkflowExecutor, type WorkflowNodeProgress } from "./executor.js";
import type { WorkflowDefinition } from "../types.js";

function makeContext() {
  const directory = mkdtempSync(path.join(tmpdir(), "interaction-progress-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  const definition: WorkflowDefinition = {
    id: "interaction-progress-probe",
    name: "人工交互事件探针",
    version: 1,
    inputs: [],
    nodes: [
      { id: "ask", kind: "human", title: "请发言", prompt: "说说你的想法", fields: [
        { key: "text", label: "发言", type: "textarea", required: true }
      ], submitLabel: "提交" },
      { id: "end", kind: "end", title: "结束" }
    ],
    edges: [{ from: "ask", to: "end" }]
  } as unknown as WorkflowDefinition;
  store.saveWorkflow(definition);
  return {
    store,
    executor: new WorkflowExecutor(store),
    definition,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("人工节点挂起时通过进度回调推送 interaction，回答后继续跑完", async () => {
  const context = makeContext();
  const events: WorkflowNodeProgress[] = [];
  try {
    const started = context.executor.start(context.definition, {}, {
      onNodeProgress: (event) => events.push(event)
    });

    const deadline = Date.now() + 3000;
    while (!events.some((event) => event.interaction) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const promptEvent = events.find((event) => event.interaction);
    assert.ok(promptEvent?.interaction, "应推送人工交互事件");
    assert.equal(promptEvent.interaction.title, "请发言");
    assert.equal(promptEvent.interaction.prompt, "说说你的想法");
    assert.equal(promptEvent.interaction.submitLabel, "提交");
    assert.equal(promptEvent.interaction.fields[0]?.key, "text");

    const pending = context.store.listInteractions({ runId: started.id, status: "pending" });
    assert.equal(pending.length, 1);
    context.executor.respondInteraction(pending[0].id, { values: { text: "我的想法" } });

    const finish = Date.now() + 3000;
    while (Date.now() < finish) {
      const run = context.store.getRun(started.id);
      if (run?.status === "succeeded" || run?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(context.store.getRun(started.id)?.status, "succeeded");
    assert.equal(events.filter((event) => event.status === "failed").length, 0);
  } finally {
    context.close();
  }
});
