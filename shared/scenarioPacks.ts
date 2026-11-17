export type ScenarioPackId = "core" | "education" | "business-analysis" | "research" | "showcase" | "exam" | "classroom-diagnosis";

export type ScenePackId = "education" | "business-analysis";

export const SCENE_STORAGE_KEY = "starlattice-scene-pack";

/** 每个场景默认打开的地图版旗舰流程。 */
export const FLAGSHIP_WORKFLOW_BY_SCENE: Record<ScenePackId, string> = {
  education: "classroom-map-v1",
  "business-analysis": "business-map-v1"
};

export const FLAGSHIP_WORKFLOW_IDS: string[] = Object.values(FLAGSHIP_WORKFLOW_BY_SCENE);

/** 读取用户上次选择的场景；服务端渲染或隐私模式下回落到教育场景。 */
export function readScenePreference(): ScenePackId {
  const storage = (
    globalThis as { localStorage?: { getItem(key: string): string | null } }
  ).localStorage;
  if (!storage) {
    return "education";
  }
  try {
    const stored = storage.getItem(SCENE_STORAGE_KEY);
    if (stored === "business-analysis" || stored === "education") {
      return stored;
    }
  } catch {
    // localStorage 被禁用时仍可使用默认场景。
  }
  return "education";
}

export type ScenarioPackFilter = ScenarioPackId | "custom";

export type ScenarioPackKind = "agents" | "tools" | "workflows" | "templates";

export type ScenarioPackItems = Record<ScenarioPackKind, string[]>;

export const SCENARIO_PACK_META: Record<ScenarioPackId, { label: string; description: string }> = {
  core: { label: "通用", description: "跨行业复用的规划、检索、执行、复核与报告 Agent" },
  education: { label: "教育场景", description: "师范生教案、课堂演练、学情与选题评审" },
  "business-analysis": { label: "经营分析", description: "指标计算、归因分析与经营报告" },
  research: { label: "科研成长", description: "研途引航多智能体：文献阅读、实验设计与模拟答辩" },
  showcase: { label: "星枢领航", description: "平台能力全景：多智能体联调 + 工作流编排的一键演示样板" },
  exam: { label: "命题工坊", description: "命题与考试质量工程：细目表、三路并行命题、仿真施测、难度区分度与改题自愈" },
  "classroom-diagnosis": {
    label: "观课磨课工坊",
    description: "课堂诊断与磨课闭环：五路并行观察、证据核验、量表仲裁、红线下线、多轮改课复核"
  }
};

export const SCENARIO_PACK_FILTERS: Array<{ id: ScenarioPackFilter; label: string }> = [
  { id: "core", label: SCENARIO_PACK_META.core.label },
  { id: "education", label: SCENARIO_PACK_META.education.label },
  { id: "business-analysis", label: SCENARIO_PACK_META["business-analysis"].label },
  { id: "research", label: SCENARIO_PACK_META.research.label },
  { id: "showcase", label: SCENARIO_PACK_META.showcase.label },
  { id: "exam", label: SCENARIO_PACK_META.exam.label },
  { id: "classroom-diagnosis", label: SCENARIO_PACK_META["classroom-diagnosis"].label },
  { id: "custom", label: "自定义" }
];

export const SCENARIO_PACK_ITEMS: Record<ScenarioPackId, ScenarioPackItems> = {
  core: {
    agents: [
      "planner-agent",
      "research-agent",
      "executor-agent",
      "reviewer-agent",
      "reporter-agent",
      "quality-verifier"
    ],
    tools: ["knowledge.search", "verify.rubric", "export.docx", "web.search"],
    workflows: ["task-report-v1", "intent-clarify-v1"],
    templates: ["report-pipeline", "document-review"]
  },
  education: {
    agents: [
      "lesson-plan-agent",
      "teacher-action-agent",
      "student-top-agent",
      "student-weak-agent",
      "student-silent-agent",
      "student-naughty-agent",
      "student-misunderstanding-agent",
      "classroom-observer-agent",
      "teaching-report-agent",
      "observer-verifier",
      "teaching-expert-agent",
      "topic-innovation-agent",
      "topic-feasibility-agent",
      "topic-compliance-agent",
      "topic-review-verifier",
      "topic-review-auditor",
      "topic-review-agent"
    ],
    tools: [
      "report.build",
      "classroom.simulate",
      "classroom.create",
      "classroom.turn",
      "classroom.feedback",
      "classroom.report",
      "counseling.create",
      "counseling.turn",
      "counseling.feedback",
      "counseling.finish",
      "lms.publish",
      "mcp.teaching-resources.teaching_resource_search",
      "mcp.teaching-resources.lesson_timing_check",
      "mcp.teaching-resources.classroom_feedback"
    ],
    workflows: [
      "classroom-map-v1",
      "classroom-session-v1",
      "counseling-session-v1",
      "classroom-v1",
      "lesson-approval-v1",
      "mcp-resources-v1",
      "topic-review-v1",
      "lesson-design-v1",
      "classroom-rehearsal-v1",
      "learning-report-v1",
      "teaching-pipeline-v1"
    ],
    templates: ["lesson-pipeline", "essay-review", "learning-diagnosis"]
  },
  "business-analysis": {
    agents: [
      "analysis-planner",
      "business-planner",
      "data-analyst",
      "business-reviewer",
      "business-diagnostician",
      "business-reporter",
      "business-reviser"
    ],
    tools: [
      "mcp.data-analysis.profile",
      "mcp.data-analysis.metric_calc",
      "mcp.data-analysis.groupby",
      "mcp.data-analysis.trend",
      "mcp.data-analysis.chart"
    ],
    workflows: ["business-map-v1", "business-analysis-v1"],
    templates: ["business-analysis"]
  },
  research: {
    // 研途引航系列是对话智能体（住在 chat_agents），不登记在 agents 里；
    // 这里挂随代码分发的调度流、训练流，以及训练流内部引用的两条答辩子流程。
    agents: [],
    tools: [],
    workflows: [
      "ytz-master-v1",
      "ytz-defense-training-v1",
      "ytz-defense-title-v1",
      "ytz-defense-material-v1"
    ],
    templates: []
  },
  showcase: {
    // 星枢系列对话智能体（starhub-*）住在 chat_agents；这里挂注册中心同 id 的专项 Agent、
    // 旗舰总调度流，以及各专项对外的工具 id，供平台能力演示时统一筛选。
    agents: [
      "starhub-tour",
      "starhub-edu",
      "starhub-biz",
      "starhub-research",
      "starhub-tools",
      "starhub-evolve"
    ],
    // 工具不在这里重复登记：knowledge.search / plugin.* / workflow.* 已归属各自的包，
    // 一个 id 只能属于一个场景包。展示视图靠专属 Agent 与旗舰流即可标识。
    tools: [],
    workflows: ["platform-showcase-v1"],
    templates: []
  },
  exam: {
    // 衡文命题工坊：8 个注册中心 Agent 与三条工作流（细目表子流程、审题子流程、质量工程主流程）。
    // 工具只登记独有的测量工具，避免与 core 包重复归属同一个 id。
    agents: [
      "exam-blueprint",
      "exam-item-basic",
      "exam-item-apply",
      "exam-item-challenge",
      "exam-mock-student",
      "exam-auditor",
      "exam-psychometric",
      "exam-reviser"
    ],
    tools: ["exam.psychometrics"],
    workflows: ["exam-quality-v1", "exam-blueprint-v1", "exam-audit-v1"],
    templates: []
  },
  "classroom-diagnosis": {
    // 观课磨课工坊：10 个注册中心 Agent、四条工作流（总调度 + 观察/改进/报告三条子流）。
    // 两个独有工具在这里登记，不与 core 的 verify.rubric 等共用 id。
    agents: [
      "cd-observer-goal",
      "cd-observer-interaction",
      "cd-observer-content",
      "cd-observer-management",
      "cd-observer-learning",
      "cd-arbitrator",
      "cd-scorer",
      "cd-reviewer",
      "cd-improver",
      "cd-reporter"
    ],
    tools: ["classroom.evidence", "rubric.check"],
    workflows: ["cd-master-v1", "cd-observe-v1", "cd-improve-v1", "cd-report-v1"],
    templates: []
  }
};

const PACK_INDEX = new Map<string, ScenarioPackId>();
for (const pack of Object.keys(SCENARIO_PACK_ITEMS) as ScenarioPackId[]) {
  const items = SCENARIO_PACK_ITEMS[pack];
  for (const kind of Object.keys(items) as ScenarioPackKind[]) {
    for (const id of items[kind]) {
      PACK_INDEX.set(`${kind}:${id}`, pack);
    }
  }
}

export function packLabel(filter: ScenarioPackFilter): string {
  return SCENARIO_PACK_FILTERS.find((item) => item.id === filter)?.label ?? "自定义";
}

/** 未登记在场景包清单中的 id 一律视为用户自建内容。 */
export function packOf(kind: ScenarioPackKind, id: string): ScenarioPackFilter {
  return PACK_INDEX.get(`${kind}:${id}`) ?? "custom";
}

export function filterByPack<T>(
  kind: ScenarioPackKind,
  items: T[],
  getId: (item: T) => string,
  filter: ScenarioPackFilter | "all"
): T[] {
  if (filter === "all") {
    return items;
  }
  return items.filter((item) => packOf(kind, getId(item)) === filter);
}
