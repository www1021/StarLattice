import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type {
  AgentCapability,
  AgentRecord,
  AgentWrite,
  CompiledPlan,
  WorkflowDefinition
} from "../types.js";
import { BUILTIN_AGENTS } from "../registry/agents.js";
import { buildWorkflowSchedule, replanForTask } from "./planner.js";
import { createSchedule, parseScheduleRequest } from "./scheduler.js";
import { configureTestModels } from "../../testing/modelFixtures.js";

// 模型密钥只能来自账号设置（环境变量不再兜底）。整份用例备三条模型：
// 快速（低）、推理（高）、低成本推理（低），角色仍用 PLATFORM_MODEL_* 指过去。
let restoreModels: () => void;
const previousRoleEnv = {
  fast: process.env.PLATFORM_MODEL_FAST,
  reasoning: process.env.PLATFORM_MODEL_REASONING
};
before(() => {
  process.env.PLATFORM_MODEL_FAST = "fast-model";
  process.env.PLATFORM_MODEL_REASONING = "strong-model";
  restoreModels = configureTestModels(
    [
      { id: "fast-model", model: "fast-model", tags: ["fast", "low-cost"], costTier: "low" },
      { id: "strong-model", model: "strong-model", tags: ["reasoning", "strong"], costTier: "high" },
      { id: "reasoning-lite", model: "lite-model", tags: ["reasoning"], costTier: "low" }
    ],
    { defaultId: "fast-model" }
  );
});
after(() => {
  restoreModels();
  for (const [name, value] of [
    ["PLATFORM_MODEL_FAST", previousRoleEnv.fast],
    ["PLATFORM_MODEL_REASONING", previousRoleEnv.reasoning]
  ] as const) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

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

test("prefers an agent whose model matches the task's model tags", () => {
  // 角色档位不再内置，由部署配置的 PLATFORM_MODEL_* 提供（不配就跟随用户默认模型）。
  const restore = withEnv({
    PLATFORM_MODEL_FAST: "fast-model",
    PLATFORM_MODEL_REASONING: "strong-model"
  });
  try {
    const agents = [
      agentWithModel("fast-designer", "快速设计 Agent", [{ tag: "设计", weight: 0.9 }], "fast"),
      agentWithModel("strong-designer", "推理设计 Agent", [{ tag: "设计", weight: 0.9 }], "reasoning")
    ];
    const plan = createSchedule(
      [{ id: "deep-diagnosis", capabilities: ["设计"], priority: 0.5, modelTags: ["reasoning"] }],
      agents
    );

    const decision = plan.decisions[0];
    assert.equal(decision.agentId, "strong-designer");
    assert.equal(decision.model.id, "reasoning");
    assert.equal(decision.model.costTier, "high");
    assert.equal(decision.model.fit, 1);
    assert.equal(decision.breakdown.model, 1);
    assert.equal(plan.weights.model, 0.15);
  } finally {
    restore();
  }
});

test("cost caps exclude expensive models but keep the cheapest candidate as a marked fallback", () => {
  const restore = withEnv({
    PLATFORM_MODEL_REASONING: "strong-model"
  });
  try {
    const agents = [
      agentWithModel("agent-a", "高成本推理 Agent", [{ tag: "设计", weight: 0.9 }], "reasoning"),
      agentWithModel("agent-b", "低成本推理 Agent", [{ tag: "设计", weight: 0.9 }], "reasoning-lite")
    ];
    const uncapped = createSchedule(
      [{ id: "task", capabilities: ["设计"], priority: 0.5, modelTags: ["reasoning"] }],
      agents
    );
    assert.equal(uncapped.decisions[0]?.agentId, "agent-a");

    const capped = createSchedule(
      [
        {
          id: "task",
          capabilities: ["设计"],
          priority: 0.5,
          modelTags: ["reasoning"],
          maxCostTier: "medium"
        }
      ],
      agents
    );
    assert.equal(capped.decisions[0]?.agentId, "agent-b");
    assert.equal(capped.decisions[0]?.model.costTier, "low");
    assert.doesNotMatch(capped.decisions[0]?.reason ?? "", /超过任务成本上限/);

    const allCapped = createSchedule(
      [
        {
          id: "task",
          capabilities: ["设计"],
          priority: 0.5,
          modelTags: ["reasoning"],
          maxCostTier: "low"
        }
      ],
      [agents[0]]
    );
    assert.equal(allCapped.decisions[0]?.agentId, "agent-a");
    assert.match(allCapped.decisions[0]?.reason ?? "", /超过任务成本上限/);
  } finally {
    restore();
  }
});

test("leaves a task unassigned when no agent model carries the required tag", () => {
  const plan = createSchedule(
    [{ id: "deep-diagnosis", capabilities: ["设计"], modelTags: ["reasoning"] }],
    [agentWithModel("fast-designer", "快速设计 Agent", [{ tag: "设计", weight: 0.9 }], "fast")]
  );

  assert.equal(plan.decisions.length, 0);
  assert.equal(plan.unassigned.length, 1);
  assert.match(plan.unassigned[0]?.reason ?? "", /模型标签「reasoning」/);
});

test("parses model tags and cost caps and rejects invalid values", () => {
  const parsed = parseScheduleRequest({
    tasks: [
      {
        id: "task",
        capabilities: ["设计"],
        modelTags: ["reasoning"],
        maxCostTier: "medium"
      }
    ]
  });
  assert.deepEqual(parsed.tasks[0]?.modelTags, ["reasoning"]);
  assert.equal(parsed.tasks[0]?.maxCostTier, "medium");

  assert.throws(
    () =>
      parseScheduleRequest({
        tasks: [{ id: "task", capabilities: ["设计"], maxCostTier: "premium" }]
      }),
    /maxCostTier/
  );
  assert.throws(
    () =>
      parseScheduleRequest({
        tasks: [{ id: "task", capabilities: ["设计"], modelTags: [1] }]
      }),
    /modelTags/
  );
});

test("workflow planning lifts diagnose agents' reasoning model into scheduling constraints", () => {
  const workflow: WorkflowDefinition = {
    id: "model-aware-plan",
    name: "模型感知调度探针",
    version: 1,
    inputs: [],
    nodes: [],
    edges: []
  };
  const plan = {
    workflow,
    steps: [
      {
        path: "diagnose",
        nodeId: "diagnose",
        depth: 1,
        node: {
          id: "diagnose",
          kind: "agent",
          agent: "strong-diagnostician",
          loopRole: "diagnose"
        }
      },
      {
        path: "draft",
        nodeId: "draft",
        depth: 1,
        node: { id: "draft", kind: "agent", agent: "fast-writer" }
      }
    ]
  } as unknown as CompiledPlan;
  const agents = [
    agentWithModel("strong-diagnostician", "推理诊断 Agent", [{ tag: "诊断", weight: 0.9 }], "reasoning"),
    agentWithModel("fast-writer", "快速写作 Agent", [{ tag: "写作", weight: 0.9 }], "fast")
  ];

  const schedule = buildWorkflowSchedule(plan, agents);
  const diagnose = schedule.decisions.find((decision) => decision.taskId === "diagnose");
  assert.equal(diagnose?.agentId, "strong-diagnostician");
  assert.equal(diagnose?.model.id, "reasoning");
  assert.equal(diagnose?.breakdown.model, 1);
});

test("PLATFORM_SCHEDULE_MAX_COST applies a global cap and marks an unavoidable downgrade", () => {
  const restore = withEnv({
    PLATFORM_MODEL_REASONING: "strong-model",
    PLATFORM_SCHEDULE_MAX_COST: "low"
  });
  try {
    const workflow: WorkflowDefinition = {
      id: "cost-cap-plan",
      name: "成本上限探针",
      version: 1,
      inputs: [],
      nodes: [],
      edges: []
    };
    const plan = {
      workflow,
      steps: [
        {
          path: "diagnose",
          nodeId: "diagnose",
          depth: 1,
          node: {
            id: "diagnose",
            kind: "agent",
            agent: "strong-diagnostician",
            loopRole: "diagnose"
          }
        }
      ]
    } as unknown as CompiledPlan;
    const agents = [
      agentWithModel("strong-diagnostician", "推理诊断 Agent", [{ tag: "诊断", weight: 0.9 }], "reasoning")
    ];

    const schedule = buildWorkflowSchedule(plan, agents);
    const diagnose = schedule.decisions.find((decision) => decision.taskId === "diagnose");
    assert.equal(diagnose?.model.costTier, "high");
    assert.match(diagnose?.reason ?? "", /超过任务成本上限/);
  } finally {
    restore();
  }
});

test("schedulerMode=static keeps the DSL-declared agent and skips runtime replanning", () => {
  const plan = {
    workflow: {
      id: "static-ablation",
      name: "静态调度消融",
      version: 1,
      schedulerMode: "static",
      inputs: [],
      nodes: [],
      edges: []
    } satisfies WorkflowDefinition,
    steps: [
      {
        path: "draft",
        nodeId: "draft",
        depth: 1,
        node: { id: "draft", kind: "agent", agent: "fast-writer", capabilities: ["写作"] }
      }
    ]
  } as unknown as CompiledPlan;
  const agents = [
    agentWithModel("fast-writer", "快速写作 Agent", [{ tag: "写作", weight: 0.3 }], "fast"),
    agentWithModel("strong-writer", "强力写作 Agent", [{ tag: "写作", weight: 0.95 }], "reasoning")
  ];

  const schedule = buildWorkflowSchedule(plan, agents, {
    "fast-writer": { inFlight: 3, capacity: 1 }
  });
  const draft = schedule.decisions.find((decision) => decision.taskId === "draft");

  assert.equal(schedule.staticMode, true);
  assert.equal(draft?.agentId, "fast-writer");
  assert.match(draft?.reason ?? "", /静态消融/);
  assert.equal(replanForTask(schedule, "draft", ["fast-writer"], agents), undefined);
});

function agentWithModel(
  id: string,
  name: string,
  capabilities: AgentCapability[],
  model: string
): AgentRecord {
  return { ...customAgent(id, name, capabilities), model };
}

function withEnv(values: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

test("excludeAgentIds re-plans away from the failed agent", () => {
  const agents = [
    customAgent("agent-a", "主 Agent", [{ tag: "调度重排探针技能", weight: 0.9 }]),
    customAgent("agent-b", "备用 Agent", [{ tag: "调度重排探针技能", weight: 0.6 }])
  ];
  const tasks = [
    { id: "t1", title: "任务", capabilities: ["调度重排探针技能"], priority: 0.9 }
  ];

  assert.equal(createSchedule(tasks, agents).decisions[0]?.agentId, "agent-a");
  assert.equal(
    createSchedule(tasks, agents, { excludeAgentIds: ["agent-a"] }).decisions[0]?.agentId,
    "agent-b"
  );
  const none = createSchedule(tasks, agents, { excludeAgentIds: ["agent-a", "agent-b"] });
  assert.equal(none.decisions.length, 0);
  assert.equal(none.unassigned.length, 1);
});

test("node-level capabilities drive scheduling instead of authored agent tags", () => {
  const workflow: WorkflowDefinition = {
    id: "content-aware-plan",
    name: "节点能力调度探针",
    version: 1,
    inputs: [],
    nodes: [],
    edges: []
  };
  const plan = {
    workflow,
    steps: [
      {
        path: "task",
        nodeId: "task",
        depth: 1,
        node: {
          id: "task",
          kind: "agent",
          agent: "writer-agent",
          capabilities: ["数据分析"]
        }
      }
    ]
  } as unknown as CompiledPlan;
  const agents = [
    customAgent("writer-agent", "写作 Agent", [{ tag: "写作", weight: 0.95 }]),
    customAgent("analyst-agent", "分析 Agent", [{ tag: "数据分析", weight: 0.9 }])
  ];

  const schedule = buildWorkflowSchedule(plan, agents);
  const decision = schedule.decisions.find((item) => item.taskId === "task");
  assert.equal(decision?.agentId, "analyst-agent");
  assert.deepEqual(decision?.matchedCapabilities.map((item) => item.tag), ["数据分析"]);

  const inherited = buildWorkflowSchedule(
    {
      workflow,
      steps: [
        { path: "task", nodeId: "task", depth: 1, node: { id: "task", kind: "agent", agent: "writer-agent" } }
      ]
    } as unknown as CompiledPlan,
    agents
  );
  assert.equal(inherited.decisions[0]?.agentId, "writer-agent");
});
