/**
 * 内置工作流离线冒烟：不连真实模型，逐个跑一遍所有 JSON 工作流。
 * 人工输入 / 审批节点自动应答，只验证「DSL 能不能从头跑到尾」。
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureTestModel } from "../server/testing/modelFixtures.js";

const sandbox = mkdtempSync(path.join(tmpdir(), "starlattice-smoke-"));
process.env.PLATFORM_DB_PATH = path.join(sandbox, "smoke.db");
process.env.MODEL_SETTINGS_DIR = path.join(sandbox, "models");
configureTestModel({ id: "test-model" });

const { PlatformStateStore } = await import("../server/platform/runtime/stateStore.js");
const { WorkflowExecutor } = await import("../server/platform/runtime/executor.js");

const dir = fileURLToPath(new URL("../server/platform/workflow/", import.meta.url));
const ids = readdirSync(dir)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.slice(0, -5))
  .sort();

const defs = ids.map((id) => JSON.parse(readFileSync(`${dir}${id}.json`, "utf8")));
const store = new PlatformStateStore();
for (const definition of defs) {
  store.saveWorkflow(definition, null);
}
const executor = new WorkflowExecutor(store);

const SAMPLE: Record<string, unknown> = {
  grade: "初三",
  stage: "初中",
  subject: "数学",
  scope: "一元二次方程",
  topic: "一元二次方程",
  title: "一元二次方程",
  field: "数学",
  question: "帮我出一份初三数学一元二次方程的小测，15道题左右，包含选择填空判断，难度适中。",
  request: "帮我备一节初三数学一元二次方程的课",
  input: "帮我分析这节课的课堂实录",
  eventText: "班上有学生说被同学打了",
  transcript: "师：同学们，我们昨天学了分数的意义。生：老师，12个苹果分给3个人，每人几个？师：你来说。生：4个。",
  plan: "导入5分钟，探究15分钟，练习15分钟，小结5分钟。",
  studentAnswer: "4/3",
  studentId: "student-1",
  paperText: "1. 1+1=？ 2. 2×3=？",
  objectives: "能说出一元二次方程的标准形式",
  improvement: "增加分层练习",
  focus: "课堂提问",
  audience: "初三学生",
  background: "学生已学过一元一次方程",
  brief: "初三数学一元二次方程复习课",
  diagnosis: "概念混淆",
  source: "课堂实录",
  textbook: "人教版九年级数学",
  trainingGoal: "提升课堂提问质量",
  classType: "新授课",
  observer: "教研员",
  difficulty: "适中",
  targetDifficulty: "适中",
  itemTypes: "选择题、填空题、判断题",
  itemCount: 5,
  minutes: "40",
  duration: 40,
  durationMinutes: 40,
  totalScore: 100,
  score: 85,
  count_num: 5,
  qualityMode: "quick",
  mode: "题目",
  specialTrainingMode: "答辩",
  requireApproval: false,
  issues: [],
  citations: [],
  knowledgeBaseIds: [],
  array: [],
  config: { caseId: "academic" }
};

function sampleFor(input: { name: string; type?: string; defaultValue?: unknown }): unknown {
  if (input.defaultValue !== undefined) return input.defaultValue;
  if (Object.prototype.hasOwnProperty.call(SAMPLE, input.name)) return SAMPLE[input.name];
  if (input.type === "number") return 3;
  if (input.type === "boolean") return false;
  if (input.type === "object") return {};
  return "示例内容";
}

function responseFor(field: { key?: string; label?: string; options?: unknown[] }): unknown {
  const key = field.key ?? "";
  const label = field.label ?? "";
  const probe = `${key} ${label}`;
  const options = (field.options ?? []).filter((option): option is string => typeof option === "string");
  if (options.length > 0) return options[0];
  if (/年级|grade/i.test(probe)) return "初三";
  if (/学科|subject/i.test(probe)) return "数学";
  if (/范围|scope/i.test(probe)) return "一元二次方程";
  if (/题量|数量|count/i.test(probe)) return 5;
  if (/题型|类型|types/i.test(probe)) return "选择题、填空题、判断题";
  if (/课题|标题|题目|topic|title/i.test(probe)) return "一元二次方程";
  if (/实录|文本|内容|text|transcript/i.test(probe)) return SAMPLE.transcript;
  if (/作答|答案|answer/i.test(probe)) return "4/3";
  return "示例内容";
}

const ACTIVE = new Set(["queued", "running", "verifying", "revising", "waiting_input", "waiting_approval"]);
const failures: string[] = [];

async function smoke(definition: (typeof defs)[number], input: Record<string, unknown>, suffix = "") {
  const label = `${definition.id} v${definition.version}${suffix}`;
  try {
    const started = executor.start(definition, input);
    const runId = started.id;
    let answered = 0;
    let approved = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const run = store.getRun(runId);
      if (!run || !ACTIVE.has(run.status)) break;
      for (const interaction of store.listInteractions({ runId, status: "pending" })) {
        const values: Record<string, unknown> = {};
        for (const field of interaction.fields ?? []) values[field.key] = responseFor(field);
        executor.respondInteraction(interaction.id, { values, actor: "smoke" });
        answered += 1;
      }
      for (const approval of store.listApprovals({ runId, status: "pending" })) {
        executor.decideApproval(approval.id, {
          decision: "approved",
          reviewer: "smoke",
          comment: "自动验收"
        });
        approved += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const run = store.getRun(runId)!;
    if (ACTIVE.has(run.status)) {
      failures.push(`${label}: 超时未完成（${run.status}）`);
      return;
    }
    const steps = store.listSteps(runId);
    const failedSteps = steps.filter((step) => step.status === "failed");
    if (run.status !== "succeeded" || failedSteps.length > 0) {
      const detail = failedSteps
        .slice(0, 3)
        .map((step) => `${step.path || step.nodeId}: ${String(step.error ?? "").slice(0, 120)}`)
        .join(" | ");
      failures.push(`${label}: ${run.status}（失败步骤 ${failedSteps.length}）${detail}`);
      return;
    }
    console.log(`✓ ${label} · ${steps.length} 步${answered ? ` · 自动补参 ${answered}` : ""}${approved ? ` · 自动审批 ${approved}` : ""}`);
  } catch (error) {
    failures.push(`${label}: ${(error as Error).message}`);
  }
}

for (const definition of defs) {
  const input: Record<string, unknown> = {};
  for (const variable of definition.inputs ?? []) input[variable.name] = sampleFor(variable);
  await smoke(definition, input);
}

// 两条关键分支额外跑一次：完整命题质量工程、备课总流。
const exam = defs.find((definition) => definition.id === "exam-quality-v1");
if (exam) {
  const input: Record<string, unknown> = {};
  for (const variable of exam.inputs ?? []) input[variable.name] = sampleFor(variable);
  input.qualityMode = "full";
  await smoke(exam, input, "（完整模式）");
}
const master = defs.find((definition) => definition.id === "teacher-workbench-master-v1");
if (master) {
  await smoke(master, { question: "帮我备一节初三数学一元二次方程的课，40分钟" }, "（备课分支）");
  await smoke(master, { question: "帮我看看这节数学课上的怎么样，实录如下：师：同学们好。生：老师好。" }, "（观课分支）");
}

if (failures.length > 0) {
  console.log("\n失败清单：");
  for (const failure of failures) console.log(`✗ ${failure}`);
  process.exit(1);
}
console.log(`\n全部通过（${defs.length} 个工作流 + 3 条补充分支）`);
