import test from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_AGENTS } from "./agents.js";
import { BUILTIN_TOOLS } from "./tools.js";
import { loadBuiltinWorkflows } from "../workflow/dsl.js";
import { WORKFLOW_TEMPLATES, applyTemplate } from "../../../src/features/platform/templates.js";
import { compileWorkflow } from "../workflow/compiler.js";
import { createSchedule } from "../scheduler/scheduler.js";
import type { WorkflowDefinition as ServerWorkflowDefinition } from "../types.js";
import {
  SCENARIO_PACK_ITEMS,
  packOf,
  type ScenarioPackId,
  type ScenarioPackKind
} from "../../../shared/scenarioPacks.js";

const workflowIds = new Set(loadBuiltinWorkflows().map((workflow) => workflow.id));
const agentIds = new Set(BUILTIN_AGENTS.map((agent) => agent.id));
const toolIds = new Set(BUILTIN_TOOLS.map((tool) => tool.id));
const templateIds = new Set(WORKFLOW_TEMPLATES.map((template) => template.id));
const agentRecords = BUILTIN_AGENTS.map((agent) => ({
  ...agent,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
}));

const knownIds: Record<ScenarioPackKind, Set<string>> = {
  agents: agentIds,
  tools: toolIds,
  workflows: workflowIds,
  templates: templateIds
};

test("every scenario pack item points at a registered seed or template", () => {
  for (const pack of Object.keys(SCENARIO_PACK_ITEMS) as ScenarioPackId[]) {
    const items = SCENARIO_PACK_ITEMS[pack];
    for (const kind of Object.keys(items) as ScenarioPackKind[]) {
      for (const id of items[kind]) {
        assert.ok(knownIds[kind].has(id), `${pack}.${kind} 引用了不存在的 id：${id}`);
        assert.equal(packOf(kind, id), pack, `${id} 应归属 ${pack}`);
      }
    }
  }
});

test("education pack covers all built-in education agents and workflows", () => {
  const education = SCENARIO_PACK_ITEMS.education;
  const business = SCENARIO_PACK_ITEMS["business-analysis"];
  const showcase = SCENARIO_PACK_ITEMS.showcase;
  const exam = SCENARIO_PACK_ITEMS.exam;
  const diagnosis = SCENARIO_PACK_ITEMS["classroom-diagnosis"];
  const teacher = SCENARIO_PACK_ITEMS["teacher-workbench"];
  assert.equal(
    education.agents.length,
    agentIds.size -
      SCENARIO_PACK_ITEMS.core.agents.length -
      business.agents.length -
      showcase.agents.length -
      exam.agents.length -
      diagnosis.agents.length -
      teacher.agents.length
  );
  const sharedWorkflows = new Set([
    ...SCENARIO_PACK_ITEMS.core.workflows,
    ...business.workflows,
    ...SCENARIO_PACK_ITEMS.research.workflows,
    ...showcase.workflows,
    ...exam.workflows,
    ...diagnosis.workflows,
    ...teacher.workflows
  ]);
  for (const id of workflowIds) {
    assert.ok(education.workflows.includes(id) || sharedWorkflows.has(id), `${id} 未归入任何场景包`);
  }
  for (const id of education.workflows) {
    assert.ok(workflowIds.has(id));
  }
  for (const id of education.agents) {
    assert.ok(agentIds.has(id));
  }
});

test("business-analysis pack covers the sales data pipeline end to end", () => {
  const business = SCENARIO_PACK_ITEMS["business-analysis"];
  for (const id of [
    "analysis-planner",
    "data-analyst",
    "business-reviewer",
    "business-reporter"
  ]) {
    assert.ok(business.agents.includes(id), `缺少经营分析 Agent：${id}`);
  }
  for (const id of [
    "mcp.data-analysis.profile",
    "mcp.data-analysis.metric_calc",
    "mcp.data-analysis.groupby",
    "mcp.data-analysis.trend",
    "mcp.data-analysis.chart"
  ]) {
    assert.ok(business.tools.includes(id), `缺少数据分析工具：${id}`);
  }
  assert.ok(business.workflows.includes("business-analysis-v1"));
  assert.ok(business.templates.includes("business-analysis"));
});

test("custom ids fall back to the custom pack", () => {
  assert.equal(packOf("agents", "user-defined-agent"), "custom");
  assert.equal(packOf("templates", "user-template"), "custom");
});

test("generic agent capability tags never overlap education tags", () => {
  const genericIds = new Set(SCENARIO_PACK_ITEMS.core.agents);
  const educationIds = new Set(SCENARIO_PACK_ITEMS.education.agents);
  const genericTags = BUILTIN_AGENTS.filter((agent) => genericIds.has(agent.id)).flatMap((agent) =>
    agent.capabilities.map((capability) => capability.tag)
  );
  const educationTags = BUILTIN_AGENTS.filter((agent) => educationIds.has(agent.id)).flatMap((agent) =>
    agent.capabilities.map((capability) => capability.tag)
  );

  for (const generic of genericTags) {
    for (const education of educationTags) {
      assert.ok(!overlaps(generic, education), `能力标签冲突：${generic} / ${education}`);
    }
  }
});

function overlaps(left: string, right: string) {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  return a === b || a.includes(b) || b.includes(a);
}

test("education tasks keep routing to education agents after generic agents are added", () => {
  const plan = createSchedule(
    [{ id: "edu-task", title: "教学设计任务", capabilities: ["教学设计"] }],
    agentRecords,
    { reserve: false }
  );
  const decision = plan.decisions[0];
  assert.equal(decision.agentId, "lesson-plan-agent");
  assert.ok(
    !SCENARIO_PACK_ITEMS.core.agents.includes(decision.agentId),
    "通用 Agent 不应被分到教育任务"
  );
  assert.ok(
    decision.alternatives.every(
      (alternative) => !SCENARIO_PACK_ITEMS.core.agents.includes(alternative.agentId)
    ),
    "通用 Agent 不应出现在教育任务的候选里"
  );
});

test("generic tasks route to generic agents", () => {
  const plan = createSchedule(
    [{ id: "generic-task", title: "任务规划", capabilities: ["任务规划"] }],
    agentRecords,
    { reserve: false }
  );
  assert.equal(plan.decisions[0].agentId, "planner-agent");
});

test("template library groups core, business and education templates", () => {
  const coreTemplateIds = new Set(SCENARIO_PACK_ITEMS.core.templates);
  const businessTemplateIds = new Set(SCENARIO_PACK_ITEMS["business-analysis"].templates);
  const lastCoreIndex = WORKFLOW_TEMPLATES.map((template) => template.id).lastIndexOf(
    SCENARIO_PACK_ITEMS.core.templates[SCENARIO_PACK_ITEMS.core.templates.length - 1]
  );
  const firstBusinessIndex = WORKFLOW_TEMPLATES.findIndex((template) =>
    businessTemplateIds.has(template.id)
  );
  const lastBusinessIndex = Math.max(
    ...WORKFLOW_TEMPLATES.map((template, index) =>
      businessTemplateIds.has(template.id) ? index : -1
    )
  );
  const firstEducationIndex = WORKFLOW_TEMPLATES.findIndex(
    (template) => !coreTemplateIds.has(template.id) && !businessTemplateIds.has(template.id)
  );

  assert.ok(firstBusinessIndex > lastCoreIndex, "经营分析模板应排在通用模板之后");
  assert.ok(firstEducationIndex > lastBusinessIndex, "教育模板应排在经营分析模板之后");
});

test("every template compiles against the built-in registry", () => {
  const workflows = loadBuiltinWorkflows();
  const latest = new Map<string, (typeof workflows)[number]>();
  for (const workflow of workflows) {
    const current = latest.get(workflow.id);
    if (!current || current.version < workflow.version) {
      latest.set(workflow.id, workflow);
    }
  }
  const resolveWorkflow = (id: string, version?: number) =>
    version === undefined ? latest.get(id) : workflows.find((workflow) => workflow.id === id && workflow.version === version);

  for (const template of WORKFLOW_TEMPLATES) {
    const definition = applyTemplate(
      {
        id: `template-${template.id}`,
        name: template.name,
        version: 1,
        description: template.description,
        inputs: [],
        nodes: [],
        edges: []
      },
      template
    ) as unknown as ServerWorkflowDefinition;
    assert.doesNotThrow(
      () => compileWorkflow(definition, { resolveWorkflow }),
      `模板 ${template.id} 未通过编译`
    );
  }
});
