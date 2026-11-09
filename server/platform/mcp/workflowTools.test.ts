import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpManager } from "./mcpManager.js";
import { runWorkflowTool, syncWorkflowTools, workflowToolId } from "./workflowTools.js";
import { PlatformStateStore } from "../runtime/stateStore.js";
import { WorkflowExecutor } from "../runtime/executor.js";
import type { WorkflowDefinition } from "../types.js";

const WORKFLOW_ID = "workflow-tool-probe";

function makeContext() {
  const directory = mkdtempSync(path.join(tmpdir(), "yiban-workflow-tool-"));
  const store = new PlatformStateStore(path.join(directory, "platform.db"));
  const workflow: WorkflowDefinition = {
    id: WORKFLOW_ID,
    name: "工作流工具探针",
    version: 1,
    inputs: [
      { name: "topic", type: "string", required: true, description: "分析主题" },
      { name: "tone", type: "string", required: false }
    ],
    nodes: [
      {
        id: "draft",
        kind: "template",
        title: "草稿",
        template: "${input.topic} 的分析报告"
      },
      {
        id: "end",
        kind: "end",
        title: "结束",
        inputs: { report: "${draft.value}" }
      }
    ],
    edges: [{ from: "draft", to: "end" }]
  };
  store.saveWorkflow(workflow);
  return {
    store,
    workflow,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("syncWorkflowTools registers each workflow as an internal MCP tool", () => {
  const context = makeContext();
  try {
    syncWorkflowTools(context.store);
    const tool = context.store.getTool(workflowToolId(WORKFLOW_ID));
    assert.ok(tool);
    assert.equal(tool.type, "mcp");
    assert.equal(tool.endpoint, `workflow://${WORKFLOW_ID}`);
    assert.match(tool.name, /工作流工具探针/);
    assert.deepEqual(tool.schema.required, ["topic"]);
    assert.deepEqual(tool.schema.properties, {
      topic: { type: "string", description: "分析主题" },
      tone: { type: "string" }
    });

    const createdAt = tool.createdAt;
    syncWorkflowTools(context.store);
    assert.equal(context.store.getTool(tool.id)!.createdAt, createdAt);
  } finally {
    context.close();
  }
});

test("workflow tools execute through McpManager and return end-node output", async () => {
  const context = makeContext();
  try {
    syncWorkflowTools(context.store);
    const tool = context.store.getTool(workflowToolId(WORKFLOW_ID))!;
    const executor = new WorkflowExecutor(context.store, {}, {});
    const manager = new McpManager(context.store);
    manager.setWorkflowRunner((target, args) =>
      runWorkflowTool(context.store, executor, target, args)
    );

    const result = await manager.callToolRecord(tool, { topic: "华东区毛利" });
    assert.equal(result.isError, false);
    assert.equal(result.serverId, "platform-workflows");
    assert.match(result.text, /华东区毛利 的分析报告/);
    const structured = result.structuredContent as {
      runId: string;
      status: string;
      output: { report?: string };
    };
    assert.equal(structured.status, "succeeded");
    assert.ok(structured.runId.startsWith("run_"));
    assert.equal(structured.output.report, "华东区毛利 的分析报告");

    const failed = await manager.callToolRecord(tool, {});
    assert.equal(failed.isError, true);
    assert.match(failed.text, /缺少必填输入/);
  } finally {
    context.close();
  }
});
