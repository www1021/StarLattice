export type ScenarioPackId = "core" | "education" | "business-analysis";

export type ScenarioPackFilter = ScenarioPackId | "custom";

export type ScenarioPackKind = "agents" | "tools" | "workflows" | "templates";

export type ScenarioPackItems = Record<ScenarioPackKind, string[]>;

export const SCENARIO_PACK_META: Record<ScenarioPackId, { label: string; description: string }> = {
  core: { label: "通用", description: "跨行业复用的规划、检索、执行、复核与报告 Agent" },
  education: { label: "教育场景", description: "师范生教案、课堂演练、学情与选题评审" },
  "business-analysis": { label: "经营分析", description: "指标计算、归因分析与经营报告" }
};

export const SCENARIO_PACK_FILTERS: Array<{ id: ScenarioPackFilter; label: string }> = [
  { id: "core", label: SCENARIO_PACK_META.core.label },
  { id: "education", label: SCENARIO_PACK_META.education.label },
  { id: "business-analysis", label: SCENARIO_PACK_META["business-analysis"].label },
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
    workflows: ["task-report-v1"],
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
      "lms.publish",
      "mcp.teaching-resources.teaching_resource_search",
      "mcp.teaching-resources.lesson_timing_check",
      "mcp.teaching-resources.classroom_feedback"
    ],
    workflows: [
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
      "data-analyst",
      "business-reviewer",
      "business-reporter"
    ],
    tools: [
      "mcp.data-analysis.profile",
      "mcp.data-analysis.metric_calc",
      "mcp.data-analysis.groupby",
      "mcp.data-analysis.trend",
      "mcp.data-analysis.chart"
    ],
    workflows: ["business-analysis-v1"],
    templates: ["business-analysis"]
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
