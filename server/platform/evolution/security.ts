import type { AgentRecord, WorkflowDefinition } from "../types.js";
import type { EvolutionChange, SecurityFinding, SecurityReport } from "./types.js";
import { isKnownModelId } from "../models/catalog.js";
import { newId } from "./util.js";

export type SecurityContext = {
  workflow: WorkflowDefinition;
  agents: AgentRecord[];
  knownTools: Set<string>;
};

type Rule = {
  id: string;
  pattern: RegExp;
  severity: SecurityFinding["severity"];
  message: string;
};

const CONTENT_RULES: Rule[] = [
  {
    id: "prompt-injection",
    pattern:
      /ignore\s+(all\s+)?(previous|above)\s+instructions|reveal\s+(the\s+)?(system\s+)?prompt|忽略(以上|之前|上述)(所有)?(指令|要求)|泄露(提示词|系统消息|密钥)/i,
    severity: "critical",
    message: "变更包含提示词注入或索取系统提示的指令。"
  },
  {
    id: "verification-bypass",
    pattern: /(不要|无需|跳过|绕过)(任何)?(验证|复核|校验)|skip\s+verification|disable\s+verification/i,
    severity: "critical",
    message: "变更要求跳过验证，会破坏可信门禁。"
  },
  {
    id: "error-hiding",
    pattern: /(隐藏|掩盖|不要提及)(错误|失败|问题)|hide\s+(the\s+)?errors?/i,
    severity: "high",
    message: "变更要求隐藏错误或失败信息。"
  },
  {
    id: "answer-leak",
    pattern: /参考答案|标准答案|ground\s*truth|answer\s*key/i,
    severity: "high",
    message: "变更引用参考答案，可能绕过真实推理。"
  },
  {
    id: "secret-token",
    pattern: /sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.|-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    severity: "critical",
    message: "变更疑似包含密钥或凭据。"
  },
  {
    id: "numeric-answer",
    pattern: /(?<!\d)(?!19\d{2}|20\d{2})\d{4,}(?!\d)/,
    severity: "high",
    message: "变更包含 4 位以上非年份数字，存在把评测答案写进提示词的风险。"
  }
];

/**
 * 候选安全扫描：内容规则 + 结构规则。
 * 只有 medium/low 允许进入门禁；critical/high 直接拒绝，避免进入评测消耗。
 */
export function scanChanges(changes: EvolutionChange[], context: SecurityContext): SecurityReport {
  const findings: SecurityFinding[] = [];
  const agentById = new Map(context.agents.map((agent) => [agent.id, agent]));

  for (const change of changes) {
    const target = change.target || "(空目标)";
    for (const rule of CONTENT_RULES) {
      const matched = `${change.after}\n${change.rationale ?? ""}`.match(rule.pattern);
      if (matched) {
        findings.push(
          finding(rule.severity, rule.id, target, rule.message, truncate(matched[0]))
        );
      }
    }

    if (change.kind === "workflow_path") {
      findings.push(
        finding(
          "high",
          "workflow-path-unsupported",
          target,
          "L1 不支持自动改写工作流路径；如需调整拓扑，请以新工作流版本发布后人工重建候选。",
          change.after.slice(0, 120)
        )
      );
      continue;
    }

    if (change.kind === "agent_swap") {
      if (!findAgentNode(context.workflow, change.target)) {
        findings.push(
          finding("high", "agent-swap-target", target, "换 Agent 的目标节点不存在或不是 Agent 节点。", target)
        );
      }
      if (!agentById.has(change.after.trim())) {
        findings.push(
          finding(
            "high",
            "agent-swap-unknown",
            target,
            `目标 Agent「${change.after}」不在发布快照中。`,
            change.after
          )
        );
      }
      continue;
    }

    const agent = agentById.get(change.target);
    if (!agent) {
      findings.push(
        finding("high", "agent-target", target, `Agent「${change.target}」不在发布快照中。`, target)
      );
      continue;
    }

    if (change.kind === "model_route" && !isKnownModelId(change.after.trim())) {
      findings.push(
        finding("high", "model-route", target, `模型「${change.after}」不在模型目录中。`, change.after)
      );
    }

    if (change.kind === "tool_policy") {
      const tools = change.after
        .split(/[,，\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      for (const tool of tools) {
        if (!context.knownTools.has(tool)) {
          findings.push(
            finding("high", "tool-policy", target, `工具「${tool}」未在注册中心登记。`, tool)
          );
        }
      }
    }

    if (change.kind === "prompt_patch") {
      const length = change.after.trim().length;
      if (length < 20 || length > 800) {
        findings.push(
          finding("medium", "prompt-length", target, `补丁长度 ${length} 字，建议限制在 20–800 字。`, "")
        );
      }
    }

    if (change.after.trim() === change.before.trim()) {
      findings.push(
        finding("low", "no-op-change", target, "变更前后内容相同，不会产生实际效果。", "")
      );
    }
  }

  const passed = !findings.some(
    (item) => item.severity === "critical" || item.severity === "high"
  );
  return { passed, findings, scannedAt: new Date().toISOString() };
}

/** 只对 Agent 节点做提示词变更；节点选择器支持节点 id 或编译路径前缀匹配。 */
function findAgentNode(workflow: WorkflowDefinition, target: string): boolean {
  return workflow.nodes.some(
    (node) => node.kind === "agent" && (node.id === target || target.endsWith(`.${node.id}`))
  );
}

function finding(
  severity: SecurityFinding["severity"],
  rule: string,
  target: string,
  message: string,
  evidence: string
): SecurityFinding {
  return { id: newId("sec"), severity, rule, target, message, evidence: truncate(evidence, 160) };
}

function truncate(value: string, limit = 120) {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
