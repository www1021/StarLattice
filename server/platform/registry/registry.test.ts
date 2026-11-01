import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinition, WorkflowNode } from "../types.js";
import { loadBuiltinWorkflows } from "../workflow/dsl.js";
import {
  bindTeamKnowledge,
  bindWorkflowKnowledge,
  buildKnowledgeOverview,
  parseKnowledgeBindingRequest
} from "../knowledge/knowledgeBases.js";
import { BUILTIN_AGENTS, parseAgentWrite } from "./agents.js";
import { parseTeamWrite } from "./teams.js";
import { BUILTIN_TOOLS, parseToolWrite } from "./tools.js";

test("builtin registry registers at least 8 agents and 5 tools with unique ids", () => {
  assert.ok(BUILTIN_AGENTS.length >= 8, `agents: ${BUILTIN_AGENTS.length}`);
  assert.ok(BUILTIN_TOOLS.length >= 5, `tools: ${BUILTIN_TOOLS.length}`);

  const agentIds = BUILTIN_AGENTS.map((agent) => agent.id);
  const toolIds = BUILTIN_TOOLS.map((tool) => tool.id);
  assert.equal(new Set(agentIds).size, agentIds.length);
  assert.equal(new Set(toolIds).size, toolIds.length);

  const validToolIds = new Set(toolIds);
  for (const agent of BUILTIN_AGENTS) {
    assert.ok(agent.prompt.length > 0, `${agent.id} 缺少 prompt`);
    assert.ok(agent.capabilities.length > 0, `${agent.id} 缺少能力标签`);
    for (const capability of agent.capabilities) {
      assert.ok(
        capability.weight >= 0 && capability.weight <= 1,
        `${agent.id}/${capability.tag} 权重越界`
      );
    }
    for (const toolId of agent.tools) {
      assert.ok(validToolIds.has(toolId), `${agent.id} 引用未注册工具 ${toolId}`);
    }
  }

  for (const tool of BUILTIN_TOOLS) {
    assert.ok(["builtin", "mcp", "http"].includes(tool.type));
    assert.equal(tool.schema.type, "object", `${tool.id} schema 缺少 type`);
  }
});

test("builtin registry covers every reference in builtin workflows", () => {
  const workflows = loadBuiltinWorkflows();
  assert.ok(workflows.length >= 2, `workflows: ${workflows.length}`);
  const agentIds = new Set(BUILTIN_AGENTS.map((agent) => agent.id));
  const toolIds = new Set(BUILTIN_TOOLS.map((tool) => tool.id));

  for (const workflow of workflows) {
    for (const node of walk(workflow.nodes)) {
      if (node.kind === "agent") {
        assert.ok(agentIds.has(node.agent), `${workflow.id} 引用未注册 Agent：${node.agent}`);
      }
      if (node.kind === "tool") {
        assert.ok(toolIds.has(node.tool), `${workflow.id} 引用未注册工具：${node.tool}`);
      }
      if (node.kind === "verify") {
        assert.ok(agentIds.has(node.verifier), `${workflow.id} 引用未注册验证器：${node.verifier}`);
        for (const verifier of node.verifiers ?? []) {
          assert.ok(agentIds.has(verifier), `${workflow.id} 引用未注册交叉验证器：${verifier}`);
        }
      }
    }
  }
});

test("agent and tool writes are validated before persistence", () => {
  const agent = parseAgentWrite({
    id: "custom-agent",
    name: "自定义 Agent",
    tools: ["knowledge.search"],
    capabilities: [{ tag: "自定义能力", weight: 0.6 }],
    memory: { scope: "run" }
  });
  assert.equal(agent.version, 1);
  assert.equal(agent.enabled, true);
  assert.equal(agent.model, "classroom-llm");
  assert.deepEqual(agent.tools, ["knowledge.search"]);

  const bumped = parseAgentWrite({ id: "custom-agent", name: "自定义 Agent v2" }, agent);
  assert.equal(bumped.version, 2);
  assert.deepEqual(bumped.tools, ["knowledge.search"]);
  assert.deepEqual(bumped.capabilities, agent.capabilities);
  assert.deepEqual(bumped.memory, { scope: "run" });

  assert.throws(() => parseAgentWrite({ id: "Bad Id", name: "x" }), /id/);
  assert.throws(() => parseAgentWrite({ id: "a", name: "" }), /name/);
  assert.throws(
    () => parseAgentWrite({ id: "a", name: "x", capabilities: [{ tag: "t", weight: 1.2 }] }),
    /weight/
  );

  const tool = parseToolWrite({
    id: "custom.tool",
    name: "自定义工具",
    type: "mcp",
    endpoint: "mcp://custom/tool",
    description: "自定义说明"
  });
  assert.equal(tool.type, "mcp");
  assert.equal(tool.enabled, true);

  const updatedTool = parseToolWrite({ id: "custom.tool", name: "自定义工具 v2", type: "mcp" }, tool);
  assert.equal(updatedTool.endpoint, "mcp://custom/tool");
  assert.equal(updatedTool.description, "自定义说明");

  assert.throws(() => parseToolWrite({ id: "t", name: "n", type: "graphql" }), /builtin/);
  assert.throws(() => parseToolWrite({ id: "t", name: "n", type: "http", schema: [] }), /schema/);
});

test("team writes are validated and keep unspecified members", () => {
  const team = parseTeamWrite({
    id: "lesson-team",
    name: "教案实训团队",
    description: "生成 + 评审 + 验证",
    agentIds: ["lesson-plan-agent", "teaching-expert-agent", "observer-verifier"],
    workflowId: "classroom-v1",
    knowledgeBaseIds: ["kb-lesson"]
  });
  assert.deepEqual(team.agentIds, [
    "lesson-plan-agent",
    "teaching-expert-agent",
    "observer-verifier"
  ]);
  assert.equal(team.workflowId, "classroom-v1");
  assert.deepEqual(team.knowledgeBaseIds, ["kb-lesson"]);

  const renamed = parseTeamWrite({ id: "lesson-team", name: "教案团队（改名）" }, team);
  assert.equal(renamed.name, "教案团队（改名）");
  assert.deepEqual(renamed.agentIds, team.agentIds);
  assert.equal(renamed.workflowId, "classroom-v1");

  assert.throws(() => parseTeamWrite({ id: "Bad Id", name: "x" }), /id/);
  assert.throws(() => parseTeamWrite({ id: "t", name: "" }), /name/);
  assert.throws(() => parseTeamWrite({ id: "t", name: "x", agentIds: "a" }), /agentIds/);
});

test("knowledge bindings toggle team/workflow scopes and stay idempotent", () => {
  const team = {
    id: "lesson-team",
    name: "教案团队",
    description: "",
    agentIds: ["lesson-plan-agent"],
    knowledgeBaseIds: ["kb-1"],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z"
  };

  assert.deepEqual(bindTeamKnowledge(team, "kb-2", true).knowledgeBaseIds, ["kb-1", "kb-2"]);
  assert.deepEqual(bindTeamKnowledge(team, "kb-1", false).knowledgeBaseIds, []);
  assert.equal(parseKnowledgeBindingRequest({ teamId: "lesson-team" }).bound, true);
  assert.throws(() => parseKnowledgeBindingRequest({ teamId: "t", workflowId: "w" }), /二选一/);
  assert.throws(() => parseKnowledgeBindingRequest({ teamId: "t", bound: "yes" }), /bound/);

  const workflow: WorkflowDefinition = {
    id: "kb-probe",
    name: "知识库绑定探针",
    version: 1,
    knowledgeBaseIds: ["kb-1"],
    inputs: [],
    nodes: [{ id: "search", kind: "tool", tool: "knowledge.search" }],
    edges: []
  };

  const bound = bindWorkflowKnowledge(workflow, "kb-2", true);
  assert.equal(bound.version, 2);
  assert.deepEqual(bound.knowledgeBaseIds, ["kb-1", "kb-2"]);
  assert.equal(bindWorkflowKnowledge(bound, "kb-2", true), bound);

  const unbound = bindWorkflowKnowledge(bound, "kb-1", false);
  assert.equal(unbound.version, 3);
  assert.deepEqual(unbound.knowledgeBaseIds, ["kb-2"]);

  const overview = buildKnowledgeOverview(
    [{ id: "kb-1", name: "课标库", source: "local", documentCount: 2, createdAt: "2026-11-01T00:00:00.000Z" }],
    [team],
    [{ id: "kb-probe", name: "知识库绑定探针", version: 2, knowledgeBaseIds: ["kb-1"] }]
  );
  assert.deepEqual(overview.bases[0]?.teamIds, ["lesson-team"]);
  assert.deepEqual(overview.bases[0]?.workflowIds, ["kb-probe"]);
});

function* walk(nodes: WorkflowNode[]): Generator<WorkflowNode> {
  for (const node of nodes) {
    yield node;
    if (node.kind === "parallel") {
      yield* walk(node.branches);
    } else if (node.kind === "condition") {
      yield* walk(node.then);
      yield* walk(node.else ?? []);
    } else if (node.kind === "loop") {
      yield* walk(node.body);
    }
  }
}
