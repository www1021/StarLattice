import assert from "node:assert/strict";
import test from "node:test";
import type { AgentCapability, AgentRecord, AgentWrite } from "../types.js";
import { BUILTIN_AGENTS } from "../registry/agents.js";
import { createSchedule, parseScheduleRequest } from "./scheduler.js";

function toRecord(write: AgentWrite): AgentRecord {
  return {
    ...write,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z"
  };
}

const BUILTIN_RECORDS = BUILTIN_AGENTS.map(toRecord);

function customAgent(
  id: string,
  name: string,
  capabilities: AgentCapability[],
  enabled = true
): AgentRecord {
  return {
    id,
    name,
    version: 1,
    role: "测试 Agent",
    prompt: "",
    tools: [],
    model: "classroom-llm",
    capabilities,
    memory: {},
    enabled,
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z"
  };
}

test("selects the strongest capability match and explains the score", () => {
  const agents = [
    ...BUILTIN_RECORDS,
    customAgent("lesson-assistant", "教案助理 Agent", [{ tag: "教学设计", weight: 0.7 }])
  ];
  const plan = createSchedule(
    [{ id: "lesson", title: "教案生成", capabilities: ["教学设计"], priority: 0.9 }],
    agents
  );

  assert.equal(plan.decisions.length, 1);
  const decision = plan.decisions[0];
  assert.equal(decision.agentId, "lesson-plan-agent");
  assert.equal(decision.breakdown.capability, 0.92);
  assert.equal(decision.breakdown.availability, 1);
  assert.equal(decision.breakdown.priority, 0.9);
  assert.equal(decision.score, 0.94);
  assert.match(decision.reason, /选择 教案生成 Agent/);
  assert.match(decision.reason, /能力匹配 0\.92/);
  assert.match(decision.reason, /教学设计 0\.92/);
  assert.ok(decision.alternatives.length > 0);
});

test("maps each student persona by its capability tag", () => {
  const plan = createSchedule(
    [
      { id: "top", capabilities: ["高阶追问"], priority: 0.6 },
      { id: "weak", capabilities: ["暴露卡点"], priority: 0.7 },
      { id: "silent", capabilities: ["点名后回应"], priority: 0.8 },
      { id: "misunderstanding", capabilities: ["典型误区"], priority: 0.9 }
    ],
    BUILTIN_RECORDS
  );

  const assigned = Object.fromEntries(
    plan.decisions.map((decision) => [decision.taskId, decision.agentId])
  );
  assert.deepEqual(assigned, {
    top: "student-top-agent",
    weak: "student-weak-agent",
    silent: "student-silent-agent",
    misunderstanding: "student-misunderstanding-agent"
  });
  assert.equal(plan.stats.scheduledCount, 4);
});

test("schedules dependencies in order and blocks tasks with unmet prerequisites", () => {
  const tasks = [
    { id: "report", capabilities: ["诊断洞察"], dependsOn: ["verify"] },
    { id: "verify", capabilities: ["规则校验"], dependsOn: ["observer"] },
    { id: "observer", capabilities: ["参与度诊断"], dependsOn: ["lesson"] },
    { id: "lesson", capabilities: ["教学设计"] }
  ];
  const plan = createSchedule(tasks, BUILTIN_RECORDS);
  assert.deepEqual(
    plan.decisions.map((decision) => decision.taskId),
    ["lesson", "observer", "verify", "report"]
  );
  assert.equal(plan.stats.blockedCount, 0);

  const blockedPlan = createSchedule(
    [{ id: "report", capabilities: ["诊断洞察"], dependsOn: ["missing-task"] }],
    BUILTIN_RECORDS
  );
  assert.equal(blockedPlan.decisions.length, 0);
  assert.equal(blockedPlan.blocked.length, 1);
  assert.deepEqual(blockedPlan.blocked[0]?.blockedBy, ["missing-task"]);
  assert.match(blockedPlan.blocked[0]?.reason ?? "", /missing-task/);

  const completedPlan = createSchedule(
    [{ id: "report", capabilities: ["诊断洞察"], dependsOn: ["missing-task"] }],
    BUILTIN_RECORDS,
    { completedTaskIds: ["missing-task"] }
  );
  assert.equal(completedPlan.decisions[0]?.agentId, "teaching-report-agent");
});

test("spreads work across equal agents using load, and reserves capacity in a batch", () => {
  const agents = [
    customAgent("agent-a", "Agent A", [{ tag: "设计", weight: 0.9 }]),
    customAgent("agent-b", "Agent B", [{ tag: "设计", weight: 0.9 }])
  ];
  const plan = createSchedule(
    [
      { id: "task-1", capabilities: ["设计"] },
      { id: "task-2", capabilities: ["设计"] }
    ],
    agents
  );

  assert.deepEqual(
    plan.decisions.map((decision) => decision.agentId),
    ["agent-a", "agent-b"]
  );
  assert.equal(plan.decisions[1]?.breakdown.availability, 1);
  assert.match(plan.decisions[1]?.reason ?? "", /Agent B/);

  const loadedAgents = [
    customAgent("agent-a", "Agent A", [{ tag: "设计", weight: 0.9 }]),
    customAgent("agent-b", "Agent B", [{ tag: "设计", weight: 0.9 }])
  ];
  const loadedPlan = createSchedule(
    [{ id: "task-1", capabilities: ["设计"] }],
    loadedAgents,
    { loads: { "agent-a": { inFlight: 1, capacity: 1 } } }
  );
  assert.equal(loadedPlan.decisions[0]?.agentId, "agent-b");
  assert.equal(loadedPlan.decisions[0]?.breakdown.availability, 1);
});

test("ignores disabled agents and reports unassigned tasks with candidate gaps", () => {
  const agents = [
    customAgent("disabled-a", "停用 A", [{ tag: "设计", weight: 0.99 }], false),
    customAgent("enabled-b", "启用 B", [{ tag: "评审", weight: 0.8 }])
  ];
  const plan = createSchedule([{ id: "design", capabilities: ["设计"] }], agents, {
    reserve: false
  });

  assert.equal(plan.decisions.length, 0);
  assert.equal(plan.unassigned.length, 1);
  assert.match(plan.unassigned[0]?.reason ?? "", /没有具备 「设计」 能力/);
  assert.equal(plan.unassigned[0]?.candidates[0]?.agentId, "enabled-b");
  assert.deepEqual(plan.unassigned[0]?.candidates[0]?.missingCapabilities, ["设计"]);
});

test("keeps agents eligible when optional task arrays are omitted from the request", () => {
  const { tasks, options } = parseScheduleRequest({
    tasks: [{ id: "lesson", capabilities: ["教学设计"] }]
  });
  const plan = createSchedule(tasks, BUILTIN_RECORDS, options);
  assert.equal(plan.decisions[0]?.agentId, "lesson-plan-agent");
});

test("validates schedule requests before scheduling", () => {
  assert.throws(
    () =>
      parseScheduleRequest({
        tasks: [
          { id: "a", capabilities: ["设计"] },
          { id: "a", capabilities: ["评审"] }
        ]
      }),
    /任务 id 重复/
  );
  assert.throws(() =>
    parseScheduleRequest({ tasks: [{ id: "a", capabilities: ["设计"], priority: 1.2 }] })
  );
  assert.throws(() => parseScheduleRequest({ tasks: [{ id: "a", capabilities: [] }] }), /capabilities/);
  assert.throws(() => parseScheduleRequest({ tasks: [] }), /tasks 必须是非空数组/);
  assert.throws(
    () =>
      parseScheduleRequest({
        tasks: [{ id: "a", capabilities: ["设计"] }],
        weights: { capability: 2 }
      }),
    /weights/
  );
  assert.throws(
    () => parseScheduleRequest({ tasks: [{ id: "a", capabilities: ["设计"] }], loads: { "a": { inFlight: -1 } } }),
    /inFlight/
  );
});
