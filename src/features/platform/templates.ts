import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, WorkflowVariable } from "./types";

export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  badge: string;
  inputs: WorkflowVariable[];
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "lesson-pipeline",
    name: "教案生成流水线",
    description: "生成初稿 → 教研审核 → 按问题修订 → 汇总输出，带 Self-Loop 修订入口。",
    badge: "教育 · 生成",
    inputs: [
      { name: "topic", type: "string", required: true, description: "课程主题，例如「分数的意义」" },
      { name: "grade", type: "string", required: true, description: "学段年级，例如「五年级」" }
    ],
    nodes: [
      { id: "start", kind: "start", title: "开始" },
      {
        id: "draft",
        kind: "llm",
        title: "生成教案初稿",
        system: "你是一名资深教研员，输出结构完整、可执行的教案。",
        prompt:
          "围绕 ${input.topic} 为 ${input.grade} 生成一份教案初稿，包含教学目标、学生活动、分层练习与评价方式。",
        thinking: true,
        inputs: { topic: "${input.topic}", grade: "${input.grade}" }
      },
      {
        id: "review",
        kind: "verify",
        title: "教研审核",
        verifier: "observer-verifier",
        rubric: ["目标达成", "活动设计", "评价一致"],
        threshold: 0.82
      },
      {
        id: "revise",
        kind: "llm",
        title: "按问题修订",
        prompt: "根据以下问题清单修订教案，保留已达标部分：\n${review.issues}",
        inputs: { draft: "${draft.output}", issues: "${review.issues}" }
      },
      {
        id: "report",
        kind: "template",
        title: "汇总教案",
        template: "# ${input.topic} 教学设计\n\n${revise.output}",
        inputs: { plan: "${revise.output}" }
      },
      { id: "end", kind: "end", title: "结束", inputs: { plan: "${report.output}" } }
    ],
    edges: [
      { from: "start", to: "draft" },
      { from: "draft", to: "review" },
      { from: "review", to: "revise", label: "按问题修订" },
      { from: "revise", to: "report" },
      { from: "report", to: "end" }
    ]
  },
  {
    id: "essay-review",
    name: "作文批改与反馈",
    description: "解析原文 → 评分 → 验证 → 条件分支（表扬 / 重写）→ 输出批改反馈。",
    badge: "教育 · 批改",
    inputs: [
      { name: "essay", type: "string", required: true, description: "学生作文原文" },
      { name: "rubric", type: "string", required: false, description: "本次批改重点" }
    ],
    nodes: [
      { id: "start", kind: "start", title: "开始" },
      {
        id: "parse",
        kind: "template",
        title: "整理原文",
        template: "作文原文：\n${input.essay}\n\n批改重点：${input.rubric}",
        inputs: { essay: "${input.essay}", rubric: "${input.rubric}" }
      },
      {
        id: "score",
        kind: "llm",
        title: "批改与评分",
        system: "你是一名语文教师，批改要具体到句子，并给出可执行的修改建议。",
        prompt: "阅读以下作文，按内容、结构、语言三个维度评分并给出修改建议：\n${parse.output}",
        inputs: { essay: "${parse.output}" }
      },
      {
        id: "verify",
        kind: "verify",
        title: "批改质量验证",
        verifier: "observer-verifier",
        rubric: ["评价具体", "建议可执行", "证据充分"],
        threshold: 0.78
      },
      {
        id: "decide",
        kind: "condition",
        title: "是否达到优秀",
        when: "${verify.score} >= 0.85",
        then: [
          {
            id: "praise",
            kind: "template",
            title: "优秀范文反馈",
            template: "本篇达到优秀水平：\n${score.output}"
          }
        ],
        else: [
          {
            id: "rewrite",
            kind: "llm",
            title: "给出重写建议",
            prompt: "针对未达标项给出重写提纲：\n${verify.issues}"
          }
        ]
      },
      {
        id: "report",
        kind: "template",
        title: "输出批改反馈",
        template: "# 作文批改反馈\n\n${score.output}\n\n验证问题：\n${verify.issues}",
        inputs: { feedback: "${score.output}", issues: "${verify.issues}" }
      },
      { id: "end", kind: "end", title: "结束", inputs: { feedback: "${report.output}" } }
    ],
    edges: [
      { from: "start", to: "parse" },
      { from: "parse", to: "score" },
      { from: "score", to: "verify" },
      { from: "verify", to: "decide", label: "验证后" },
      { from: "decide", to: "report", label: "分支后" },
      { from: "report", to: "end" }
    ]
  },
  {
    id: "learning-diagnosis",
    name: "学情诊断",
    description: "知识库检索 → 学情分析 → 验证 → 输出诊断建议，演示知识库与证据链。",
    badge: "教育 · 诊断",
    inputs: [
      { name: "classInfo", type: "string", required: true, description: "班级学情描述或最近一次测验情况" }
    ],
    nodes: [
      { id: "start", kind: "start", title: "开始" },
      {
        id: "retrieve",
        kind: "knowledge",
        title: "检索学情资料",
        query: "${input.classInfo}",
        topK: 5,
        inputs: { query: "${input.classInfo}" }
      },
      {
        id: "diagnose",
        kind: "llm",
        title: "生成诊断建议",
        system: "你是一名教研组长，诊断要基于证据，给出分层教学建议。",
        prompt: "结合以下资料分析学情，指出三类主要问题并给出分层教学建议：\n${retrieve.output}",
        inputs: { evidence: "${retrieve.output}" }
      },
      {
        id: "verify",
        kind: "verify",
        title: "诊断质量验证",
        verifier: "observer-verifier",
        rubric: ["证据支撑", "分层建议", "可执行性"],
        threshold: 0.8
      },
      { id: "end", kind: "end", title: "结束", inputs: { diagnosis: "${diagnose.output}" } }
    ],
    edges: [
      { from: "start", to: "retrieve" },
      { from: "retrieve", to: "diagnose" },
      { from: "diagnose", to: "verify" },
      { from: "verify", to: "end" }
    ]
  }
];

export function applyTemplate(definition: WorkflowDefinition, template: WorkflowTemplate): WorkflowDefinition {
  return {
    ...definition,
    description: definition.description || template.description,
    inputs: template.inputs.map((variable) => ({ ...variable })),
    // 模板常量会被多个流程复用，必须深拷贝，否则编辑子节点会污染模板本身。
    nodes: structuredClone(template.nodes),
    edges: template.edges.map((edge) => ({ ...edge }))
  };
}
