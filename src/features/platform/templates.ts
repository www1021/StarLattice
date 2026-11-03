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
    id: "report-pipeline",
    name: "检索 → 报告流水线",
    description: "检索证据 → 起草 → 验证 → 按问题修订 → 汇总报告，带 Self-Loop 修订入口。",
    badge: "通用 · 报告",
    inputs: [
      { name: "topic", type: "string", required: true, description: "任务主题或要回答的问题" }
    ],
    nodes: [
      { id: "start", kind: "start", title: "开始" },
      {
        id: "retrieve",
        kind: "knowledge",
        title: "检索证据",
        query: "${input.topic}",
        topK: 5,
        inputs: { query: "${input.topic}" }
      },
      {
        id: "draft",
        kind: "llm",
        title: "起草初稿",
        system: "你是一名专业分析顾问，先给结论，再给依据，输出结构化、可交付的内容。",
        prompt: "围绕 ${input.topic} 起草一份结构化初稿，先给结论，再给依据与过程。",
        thinking: true,
        inputs: { topic: "${input.topic}", evidence: "${retrieve.output}" }
      },
      {
        id: "verify",
        kind: "verify",
        title: "质量验证",
        verifier: "quality-verifier",
        rubric: ["目标达成", "证据支撑", "可执行性"],
        threshold: 0.8
      },
      {
        id: "revise",
        kind: "llm",
        title: "按问题修订",
        prompt: "根据以下问题清单修订初稿，保留已达标部分：\n${verify.issues}",
        inputs: { draft: "${draft.output}", issues: "${verify.issues}" }
      },
      {
        id: "report",
        kind: "template",
        title: "汇总报告",
        template: "# ${input.topic} 任务报告\n\n${revise.output}",
        inputs: { content: "${revise.output}" }
      },
      { id: "end", kind: "end", title: "结束", inputs: { report: "${report.output}" } }
    ],
    edges: [
      { from: "start", to: "retrieve" },
      { from: "retrieve", to: "draft" },
      { from: "draft", to: "verify" },
      { from: "verify", to: "revise", label: "按问题修订" },
      { from: "revise", to: "report" },
      { from: "report", to: "end" }
    ]
  },
  {
    id: "document-review",
    name: "文档复核",
    description: "整理原文 → 规则检查 → 评审意见 → 独立验证 → 输出结论。",
    badge: "通用 · 评审",
    inputs: [
      { name: "document", type: "string", required: true, description: "待复核的原文或产物" }
    ],
    nodes: [
      { id: "start", kind: "start", title: "开始" },
      {
        id: "normalize",
        kind: "template",
        title: "整理原文",
        template: "待复核原文：\n${input.document}",
        inputs: { document: "${input.document}" }
      },
      {
        id: "check",
        kind: "llm",
        title: "规则检查",
        system: "你是一名规则检查器，只报告可核对的不符合项，并给出所在位置。",
        prompt: "检查以下原文是否符合任务要求，逐条列出不符合项与依据：\n${normalize.output}",
        inputs: { document: "${normalize.output}" }
      },
      {
        id: "review",
        kind: "llm",
        title: "评审意见",
        system: "你是一名独立评审专家，意见要具体到可执行动作。",
        prompt: "基于规则检查结果，给出评审结论、必须修改项与建议修改项：\n${check.output}",
        inputs: { findings: "${check.output}" }
      },
      {
        id: "verify",
        kind: "verify",
        title: "评审质量验证",
        verifier: "quality-verifier",
        rubric: ["问题定位", "证据支撑", "建议可执行"],
        threshold: 0.78
      },
      { id: "end", kind: "end", title: "结束", inputs: { review: "${review.output}" } }
    ],
    edges: [
      { from: "start", to: "normalize" },
      { from: "normalize", to: "check" },
      { from: "check", to: "review" },
      { from: "review", to: "verify" },
      { from: "verify", to: "end" }
    ]
  },
  {
    id: "business-analysis",
    name: "经营数据分析",
    description: "销售概况 → 区域与品类并行分析 → 毛利初稿 → number_match 验证拦截 → 净额口径重算 → 复核通过。",
    badge: "经营分析 · 报告",
    inputs: [
      {
        name: "question",
        type: "string",
        required: false,
        description: "本次经营问题，例如「本月各区域与品类的毛利表现如何？」"
      },
      {
        name: "source",
        type: "string",
        required: false,
        description: "data/demo 下的销售明细路径，默认 data/demo/sales.csv"
      }
    ],
    nodes: [
      { id: "start", kind: "start", title: "开始" },
      {
        id: "plan",
        kind: "agent",
        title: "分析规划",
        agent: "analysis-planner",
        inputs: { question: "${input.question}", source: "${input.source}" },
        prompt:
          "围绕「${input.question}」制定分析计划：明确销售额口径、区域与品类两个分析维度，以及毛利额和毛利率的验收标准。"
      },
      {
        id: "profile",
        kind: "tool",
        title: "销售数据概况",
        tool: "mcp.data-analysis.profile",
        args: { source: "${input.source}" }
      },
      {
        id: "dimensions",
        kind: "parallel",
        title: "区域 × 品类并行分析",
        branches: [
          {
            id: "region",
            kind: "tool",
            title: "区域汇总",
            tool: "mcp.data-analysis.groupby",
            args: { source: "${input.source}", dimension: "region" }
          },
          {
            id: "product",
            kind: "tool",
            title: "品类汇总",
            tool: "mcp.data-analysis.groupby",
            args: { source: "${input.source}", dimension: "product" }
          }
        ]
      },
      {
        id: "analysis",
        kind: "agent",
        title: "区域与品类分析",
        agent: "data-analyst",
        inputs: {
          profile: "${profile.output}",
          region: "${region.output}",
          product: "${product.output}"
        },
        prompt: "基于区域与品类汇总，指出增长来源、拖累项与异常波动；只引用工具返回的数字。"
      },
      {
        id: "metrics",
        kind: "tool",
        title: "毛利核算（初稿·毛额口径）",
        tool: "mcp.data-analysis.metric_calc",
        args: { source: "${input.source}", revenueBasis: "gross" }
      },
      {
        id: "review",
        kind: "agent",
        title: "经营复核",
        agent: "business-reviewer",
        inputs: {
          profile: "${profile.output}",
          analysis: "${analysis.output}",
          metrics: "${metrics.output}"
        },
        prompt:
          "核对毛利核算的销售额口径：退款必须从销售额中扣除。若发现毛销售额口径导致高估，请明确指出并给出重算要求。"
      },
      {
        id: "report",
        kind: "template",
        title: "生成分析报告",
        template:
          "# 经营分析报告\n\n## 结论\n本期销售按净额口径核算：毛利额与毛利率以扣除退款后的净销售额为基准。\n\n## 数据概况\n${profile.output}\n\n## 区域表现\n${region.output}\n\n## 品类表现\n${product.output}\n\n## 毛利核算\n${metrics.output}\n\n## 口径说明\n退款需从销售额中扣除，毛利额 = 净销售额 − 销货成本。"
      },
      {
        id: "reference-metrics",
        kind: "tool",
        title: "核对基准（净额口径毛利）",
        tool: "mcp.data-analysis.metric_calc",
        args: { source: "${input.source}", revenueBasis: "net" }
      },
      {
        id: "reference-data",
        kind: "template",
        title: "核对基准（正确口径）",
        template: "${profile.output}\n\n${region.output}\n\n${product.output}\n\n${reference-metrics.output}"
      },
      {
        id: "verify-initial",
        kind: "verify",
        title: "数值一致性验证",
        verifier: "quality-verifier",
        verifiers: ["quality-verifier", "business-reviewer"],
        rubric: ["口径一致", "数据可追溯", "结论可执行"],
        threshold: 0.7,
        minChars: 200,
        checks: [{ type: "number_match", tolerance: 0.01 }],
        inputs: { artifact: "${report.output}", reference: "${reference-data.output}" }
      },
      {
        id: "revise-loop",
        kind: "loop",
        title: "毛利口径修正",
        maxIterations: 2,
        while: "${verify-loop.score} < 0.7",
        patience: 2,
        budget: { maxDurationMs: 120000, maxTokens: 0 },
        body: [
          {
            id: "recalc",
            kind: "tool",
            title: "按净额口径重算毛利",
            tool: "mcp.data-analysis.metric_calc",
            args: { source: "${input.source}", revenueBasis: "net" }
          },
          {
            id: "rebuild",
            kind: "template",
            title: "按正确口径重建报告",
            template:
              "# 经营分析报告（修订版）\n\n## 结论\n本期销售按净额口径核算：毛利额与毛利率以扣除退款后的净销售额为基准。\n\n## 数据概况\n${profile.output}\n\n## 区域表现\n${region.output}\n\n## 品类表现\n${product.output}\n\n## 毛利核算\n${recalc.output}\n\n## 口径说明\n退款需从销售额中扣除，毛利额 = 净销售额 − 销货成本。"
          },
          {
            id: "verify-loop",
            kind: "verify",
            title: "复核修正稿",
            verifier: "quality-verifier",
            verifiers: ["quality-verifier", "business-reviewer"],
            rubric: ["口径一致", "数据可追溯", "结论可执行"],
            threshold: 0.7,
            minChars: 200,
            checks: [{ type: "number_match", tolerance: 0.01 }],
            inputs: { reference: "${reference-data.output}" }
          }
        ]
      },
      {
        id: "report-final",
        kind: "template",
        title: "输出修订报告",
        template: "${rebuild.output}"
      },
      { id: "end", kind: "end", title: "结束", inputs: { report: "${report-final.output}" } }
    ],
    edges: [
      { from: "start", to: "plan" },
      { from: "plan", to: "profile" },
      { from: "profile", to: "dimensions" },
      { from: "dimensions", to: "analysis" },
      { from: "analysis", to: "metrics" },
      { from: "metrics", to: "review" },
      { from: "review", to: "report" },
      { from: "report", to: "reference-metrics" },
      { from: "reference-metrics", to: "reference-data" },
      { from: "reference-data", to: "verify-initial" },
      { from: "verify-initial", to: "revise-loop" },
      { from: "revise-loop", to: "report-final" },
      { from: "report-final", to: "end" }
    ]
  },
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
