import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlatformStateStore } from "../runtime/stateStore.js";
import type { EvaluationDataset } from "./types.js";

/**
 * 内置回归集：只覆盖可复现的固定输入，避免门禁拿临时问题做统计。
 * 教育集来自 data/eval/tasks.json；经营集使用 demo 销售明细的三类提问。
 */
export function seedEvolutionDatasets(store: PlatformStateStore): string[] {
  const seeded: string[] = [];
  if (!store.getDataset("eduset_classroom-v1_core")) {
    const dataset = educationDataset();
    if (dataset) {
      store.saveDataset(dataset);
      seeded.push(dataset.id);
    }
  }
  if (!store.getDataset("bizset_business-analysis-v1_core")) {
    store.saveDataset(businessDataset());
    seeded.push("bizset_business-analysis-v1_core");
  }
  return seeded;
}

function educationDataset(): EvaluationDataset | undefined {
  let tasks: Array<{
    id: string;
    vars: Record<string, unknown>;
    expectedPoints?: string[];
    rubric?: string[];
    threshold?: number;
    difficulty?: string;
    category?: string;
  }>;
  try {
    const raw = JSON.parse(
      readFileSync(path.resolve("data", "eval", "tasks.json"), "utf8")
    ) as { tasks?: typeof tasks };
    tasks = Array.isArray(raw.tasks) ? raw.tasks : [];
  } catch {
    return undefined;
  }
  const chosen = tasks.filter((task) => task.vars?.topic && task.vars?.subject && task.vars?.grade).slice(0, 6);
  if (chosen.length === 0) {
    return undefined;
  }
  return {
    id: "eduset_classroom-v1_core",
    workflowId: "classroom-v1",
    name: "课堂设计核心回归集",
    version: 1,
    description: "固定 6 个课堂主题，覆盖不同学科与年级；门禁用逐用例配对比较，不随演示输入变化。",
    createdAt: new Date().toISOString(),
    cases: chosen.map((task) => ({
      id: task.id,
      datasetId: "eduset_classroom-v1_core",
      title: String(task.vars.topic),
      input: {
        topic: task.vars.topic,
        subject: task.vars.subject,
        grade: task.vars.grade
      },
      expected: { points: task.expectedPoints ?? [] },
      rubric: task.rubric ?? [],
      threshold: task.threshold ?? 0.8,
      tags: [task.difficulty ?? "unknown", task.category ?? "normal"]
    }))
  };
}

function businessDataset(): EvaluationDataset {
  const cases = [
    {
      id: "biz-01",
      title: "按订单销售额口径看区域与品类毛利",
      question: "按订单销售额口径看一下本期区域与品类毛利，为什么下滑？"
    },
    {
      id: "biz-02",
      title: "退款对区域毛利的影响",
      question: "退款主要集中在哪些区域和品类？对毛利额影响多大？"
    },
    {
      id: "biz-03",
      title: "渠道毛利对比",
      question: "线上与门店渠道的毛利率差异在哪里，下一步应该优化什么？"
    }
  ];
  return {
    id: "bizset_business-analysis-v1_core",
    workflowId: "business-analysis-v1",
    name: "经营分析核心回归集",
    version: 1,
    description: "固定三问覆盖口径、退款与渠道维度，用于检查自愈补丁是否只修好单题却拖坏其他问题。",
    createdAt: new Date().toISOString(),
    cases: cases.map((item) => ({
      id: item.id,
      datasetId: "bizset_business-analysis-v1_core",
      title: item.title,
      input: { question: item.question, source: "data/demo/sales.csv" },
      expected: {},
      rubric: ["口径正确", "数值一致", "结论可执行"],
      threshold: 0.7,
      tags: ["business", "regression"]
    }))
  };
}
