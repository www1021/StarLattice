#!/usr/bin/env node
// 平台内置的教学资源 MCP 服务器（stdio 传输），用于演示真实 MCP 握手、工具发现与调用。
import { createInterface } from "node:readline";

const SERVER_INFO = { name: "teaching-resource-mcp", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-06-18";

const RESOURCES = [
  {
    id: "res-fraction-01",
    title: "分数的意义·单元导入设计",
    subject: "数学",
    grade: "五年级",
    keywords: ["分数", "意义", "导入", "单位1"],
    summary: "用分披萨情境引出单位“1”，比较整体平均分的不同表达，衔接到分数定义。",
    url: "https://example.edu/resources/fraction-meaning"
  },
  {
    id: "res-fraction-02",
    title: "分数与除法·课堂提问链",
    subject: "数学",
    grade: "五年级",
    keywords: ["分数", "除法", "提问", "课堂互动"],
    summary: "从“3 块饼分给 4 人”切入，连续追问每人的量与 3/4 的关系，形成问题链。",
    url: "https://example.edu/resources/fraction-division"
  },
  {
    id: "res-circle-01",
    title: "圆的面积·割补法探究",
    subject: "数学",
    grade: "六年级",
    keywords: ["圆", "面积", "割补", "转化"],
    summary: "把圆等分拼成近似长方形，推导 S=πr²，配合动态演示与小组记录单。",
    url: "https://example.edu/resources/circle-area"
  },
  {
    id: "res-photosynthesis-01",
    title: "光合作用·实验变量控制",
    subject: "生物",
    grade: "七年级",
    keywords: ["光合作用", "实验", "变量", "对照"],
    summary: "以金鱼藻产氧实验为载体，训练单一变量与对照组的实验设计。",
    url: "https://example.edu/resources/photosynthesis"
  },
  {
    id: "res-writing-01",
    title: "记叙文细节描写·课堂评价量表",
    subject: "语文",
    grade: "七年级",
    keywords: ["记叙文", "细节", "描写", "评价量表"],
    summary: "从动作、语言、心理三个维度给出可观察的评价指标，便于同伴互评。",
    url: "https://example.edu/resources/narrative-detail"
  }
];

const TOOLS = [
  {
    name: "teaching_resource_search",
    title: "教学资源检索",
    description: "按课题关键词检索平台内置的教案片段、课堂提问链与实验设计资源，返回标题、摘要与链接。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "课题或关键词，例如“分数的意义”" },
        subject: { type: "string", description: "学科，可选" },
        limit: { type: "number", minimum: 1, maximum: 5, default: 3 }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "lesson_timing_check",
    title: "课堂环节时长校验",
    description: "校验各教学环节时长之和是否匹配总课时，并给出压缩或补充建议。",
    inputSchema: {
      type: "object",
      properties: {
        durationMinutes: { type: "number", minimum: 10, maximum: 120 },
        phases: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              minutes: { type: "number", minimum: 1 }
            },
            required: ["name", "minutes"]
          }
        }
      },
      required: ["durationMinutes", "phases"],
      additionalProperties: false
    }
  },
  {
    name: "classroom_feedback",
    title: "课堂反馈生成",
    description: "根据训练得分与问题清单生成结构化的课堂改进反馈。",
    inputSchema: {
      type: "object",
      properties: {
        score: { type: "number", minimum: 0, maximum: 1 },
        strengths: { type: "array", items: { type: "string" } },
        issues: { type: "array", items: { type: "string" } }
      },
      required: ["score"],
      additionalProperties: false
    }
  }
];

function searchResources(input) {
  const query = String(input.query ?? "").trim();
  const subject = String(input.subject ?? "").trim();
  const limit = Math.min(5, Math.max(1, Number(input.limit) || 3));
  const terms = query.split(/[\s,，、]+/).filter(Boolean);
  const ranked = RESOURCES.map((resource) => {
    const haystack = `${resource.title} ${resource.summary} ${resource.keywords.join(" ")}`;
    const score = terms.reduce((total, term) => (haystack.includes(term) ? total + 1 : total), 0);
    return { resource, score };
  })
    .filter((item) => item.score > 0 && (!subject || item.resource.subject === subject))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ resource }) => resource);

  return {
    query,
    total: ranked.length,
    results: ranked
  };
}

function checkTiming(input) {
  const duration = Number(input.durationMinutes);
  const phases = Array.isArray(input.phases) ? input.phases : [];
  const used = phases.reduce((total, phase) => total + (Number(phase?.minutes) || 0), 0);
  const delta = used - duration;
  const suggestions = [];
  if (delta > 0) {
    suggestions.push(`总时长超出 ${delta} 分钟，优先压缩导入或练习环节，保留探究与反馈时间。`);
  } else if (delta < 0) {
    suggestions.push(`总时长还差 ${Math.abs(delta)} 分钟，可增加学生展示或分层练习。`);
  } else {
    suggestions.push("各环节时长与课时完全匹配。");
  }
  const longest = [...phases].sort((a, b) => (Number(b?.minutes) || 0) - (Number(a?.minutes) || 0))[0];
  if (longest && Number(longest.minutes) > duration * 0.5) {
    suggestions.push(`「${longest.name}」占用超过一半课时，建议拆分并插入即时反馈。`);
  }
  return {
    durationMinutes: duration,
    usedMinutes: used,
    deltaMinutes: delta,
    phases,
    suggestions
  };
}

function buildFeedback(input) {
  const score = Math.min(1, Math.max(0, Number(input.score) || 0));
  const strengths = Array.isArray(input.strengths) ? input.strengths : [];
  const issues = Array.isArray(input.issues) ? input.issues : [];
  const level = score >= 0.85 ? "优秀" : score >= 0.7 ? "良好" : "待改进";
  return {
    score,
    level,
    summary: `本次课堂训练评为${level}（${score.toFixed(2)}）。`,
    strengths: strengths.length > 0 ? strengths : ["教学目标清晰，环节完整。"],
    nextActions:
      issues.length > 0
        ? issues.map((issue) => `针对「${issue}」补充证据并设计一次针对性演练。`)
        : ["保持当前节奏，增加一次开放性问题检验迁移。"],
    source: "teaching-resource-mcp"
  };
}

function callTool(name, args) {
  switch (name) {
    case "teaching_resource_search": {
      const result = searchResources(args);
      return {
        text:
          result.total > 0
            ? `检索「${result.query}」命中 ${result.total} 条教学资源：\n${result.results
                .map((item, index) => `${index + 1}. ${item.title}（${item.subject}·${item.grade}）：${item.summary}`)
                .join("\n")}`
            : `检索「${result.query}」未命中内置资源，请调整关键词或补充学科。`,
        structuredContent: result
      };
    }
    case "lesson_timing_check": {
      const result = checkTiming(args);
      return {
        text: `课时 ${result.durationMinutes} 分钟，已排 ${result.usedMinutes} 分钟，偏差 ${result.deltaMinutes} 分钟。\n${result.suggestions.join("\n")}`,
        structuredContent: result
      };
    }
    case "classroom_feedback": {
      const result = buildFeedback(args);
      return {
        text: `${result.summary}\n建议：${result.nextActions.join("；")}`,
        structuredContent: result
      };
    }
    default:
      throw Object.assign(new Error(`未知工具：${name}`), { code: -32602 });
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = message ?? {};
  if (method === undefined) {
    return;
  }

  try {
    switch (method) {
      case "initialize":
        respond(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: "提供教学资源检索、课时校验与课堂反馈三类工具。"
        });
        return;
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        respond(id, {});
        return;
      case "tools/list":
        respond(id, { tools: TOOLS });
        return;
      case "tools/call": {
        const name = String(params?.name ?? "");
        const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
        const { text, structuredContent } = callTool(name, args);
        respond(id, {
          content: [{ type: "text", text }],
          structuredContent,
          isError: false
        });
        return;
      }
      default:
        respondError(id, -32601, `不支持的方法：${method}`);
    }
  } catch (error) {
    respondError(id, error?.code ?? -32603, error?.message ?? "工具执行失败。");
  }
});
