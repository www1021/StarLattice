import assert from "node:assert/strict";
import test from "node:test";
import type { ToolNode } from "../types.js";
import type { ExecutionContext } from "./executor.js";
import { createPlatformHandlers, type PlatformHandlerDependencies } from "./handlersFactory.js";

function context(): ExecutionContext {
  return {
    runId: "run_1",
    workflowId: "workflow_1",
    iteration: 0,
    scope: {
      input: { topic: "分数的意义" },
      outputs: new Map(),
      evidence: [],
      verifyRounds: 0
    }
  };
}

function dependencies(
  overrides: Partial<PlatformHandlerDependencies> = {}
): PlatformHandlerDependencies {
  return {
    getAgent: () => undefined,
    getTool: () => undefined,
    callMcpTool: async () => {
      throw new Error("测试不应调用 MCP");
    },
    searchKnowledge: async ({ query }) => [
      {
        id: "citation-1",
        documentName: "义务教育数学课程标准",
        knowledgeBaseName: "课标库",
        snippet: query,
        score: 0.9
      }
    ],
    trainingTool: () => undefined,
    ...overrides
  };
}

test("routes knowledge.search through the shared search dependency", async () => {
  const handlers = createPlatformHandlers(dependencies());
  const node: ToolNode = {
    id: "retrieve",
    kind: "tool",
    tool: "knowledge.search",
    args: { query: "分数的意义", knowledgeBaseIds: ["kb-1"], topK: 3 }
  };

  const output = (await handlers.knowledgeTool!(
    node,
    { query: "分数的意义", knowledgeBaseIds: ["kb-1"], topK: 3 },
    context()
  )) as Record<string, unknown>;

  assert.equal(output.tool, "knowledge.search");
  assert.equal((output.citations as unknown[]).length, 1);
  assert.match(String(output.output), /义务教育数学课程标准/);
});

test("leaves non-knowledge tools to the remaining tool handlers", async () => {
  const handlers = createPlatformHandlers(dependencies());
  const node: ToolNode = { id: "report", kind: "tool", tool: "report.build", args: {} };

  assert.equal(await handlers.knowledgeTool!(node, {}, context()), undefined);
});

test("training tools take precedence over generic tool handlers", async () => {
  const calls: string[] = [];
  const handlers = createPlatformHandlers(
    dependencies({
      trainingTool: (tool) => {
        calls.push(tool);
        return { handled: true, tool };
      }
    })
  );
  const node: ToolNode = { id: "classroom", kind: "tool", tool: "classroom.ask", args: {} };

  const output = await handlers.trainingTool!(node, {}, context());
  assert.deepEqual(output, { handled: true, tool: "classroom.ask" });
  assert.deepEqual(calls, ["classroom.ask"]);
});
