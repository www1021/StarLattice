/**
 * 调试助手的对话层：意图分流、提示词、最终产物取值与离线兜底。
 * 这一层不碰执行器，纯函数便于单测；SSE 编排在 routes.ts。
 */

/** chat = 直接聊实质问题；run = 真的跑一遍工作流。默认走 chat，避免把提问误当任务。 */
export type DebugIntent = "greeting" | "capability" | "chat" | "run";

export type DebugStep = {
  nodeId?: string;
  path?: string;
  status?: string;
  durationMs?: number;
  output?: unknown;
};

export type DebugNodeSummary = {
  nodeId: string;
  status: "succeeded" | "failed" | "running" | "waiting";
  durationMs: number;
};

export type DebugPromptContext = {
  workflowName: string;
  nodeCount: number;
  inputNames: string[];
  /** 节点清单只在用户主动问结构时才用，平时不要主动罗列。 */
  nodeLabels?: string[];
  intent: DebugIntent;
};

const GREETING_RE =
  /^(你好|您好|嗨|哈喽|哈罗|hi|hello|hey|在吗|在么|早上好|中午好|下午好|晚上好|早|谢谢|多谢|bye|拜拜)/i;
const CAPABILITY_RE =
  /(你是谁|你叫什么|你能做什么|你能干嘛|你会什么|有什么功能|怎么用|如何使用|帮我什么|介绍一下你自己|帮助|help|能力)/;
/** 用户明确说要跑流程，优先级最高。 */
const RUN_TRIGGER_RE =
  /(跑一遍|跑一下|跑一跑|试运行|试跑|执行一遍|执行一次|运行一遍|运行一下|走一遍|走一下|调试一下|debug|执行工作流|运行工作流|跑工作流|用这条工作流|按这个流程|按这条流程|按工作流)/i;
/** 疑问句和咨询式表达：这类问题应当由模型直接回答，不该塞进工作流当输入。 */
const QUESTION_RE =
  /(如何|怎么|怎样|为啥|为什么|为何|是不是|是否|能不能|可不可以|有没有|哪些|什么|吗|呢|该怎么|该怎么办|请教|请问|想知道|讲讲|讲一下|说说|\?|？)/;
/** 明确要求产出一份交付物，才算任务。 */
const DELIVERABLE_RE =
  /(生成|撰写|编写|拟|出|做|写|设计|整理|产出|制作|来一份|给我)[^。！？!?]{0,24}(教案|教学设计|教学方案|方案|课件|报告|大纲|讲义|计划|试题|练习题|脚本|清单|总结|反思|学案)/;

/**
 * 意图分流：寒暄/能力询问 → 直接聊；普通提问 → 直接聊；
 * 只有显式要求跑流程、或明确要生成一份交付物，才触发工作流。
 * 兜底必须是 chat，否则「如何让学生听课效率变高」会被当成任务跑 28 步 stub。
 */
export function classifyDebugIntent(text: string): DebugIntent {
  const value = text.trim();
  if (!value) {
    return "greeting";
  }
  if (value.length <= 12 && GREETING_RE.test(value)) {
    return "greeting";
  }
  if (value.length <= 24 && CAPABILITY_RE.test(value)) {
    return "capability";
  }
  if (RUN_TRIGGER_RE.test(value)) {
    return "run";
  }
  if (QUESTION_RE.test(value)) {
    return "chat";
  }
  if (DELIVERABLE_RE.test(value)) {
    return "run";
  }
  return "chat";
}

export function debugChatModel(): string {
  return process.env.PLATFORM_DEBUG_CHAT_MODEL?.trim() || "qwen3.7-flash";
}

export function buildDebugSystemPrompt(context: DebugPromptContext): string {
  const inputs = context.inputNames.length > 0 ? context.inputNames.join("、") : "（未声明输入）";
  const labels = context.nodeLabels?.length
    ? `节点清单：${context.nodeLabels.join("、")}。`
    : "";
  return [
    `你在「${context.workflowName}」这条工作流画布的右侧跟用户聊天，同时是一位熟悉教学设计的教研伙伴。`,
    `这条工作流有 ${context.nodeCount} 个节点，声明的输入是：${inputs}。${labels}`,
    "",
    "说话规矩：",
    "- 中文口语，直接答，别写小标题、别列清单、别输出 JSON、别用 markdown 表格。",
    "- 用户问教学、课堂、课程设计、学生管理这类实质问题，就正经把答案讲清楚，给具体、能上手的做法，讲一段到两段。不要提工作流、节点、运行状态、模型或夹具，不要把回复写成运行汇报。",
    "- 对方打招呼或问你能做什么时，用一两句介绍自己：你能直接聊教学问题，也能按任务跑一遍这条工作流、把最后交付的内容讲给他听。不要编造运行结果。",
    "- 用户主动问这条工作流的结构、节点、输入时，才用上面的信息回答，不要主动罗列节点。",
    "- 拿到工作流运行结果时，只转述最终交付内容，运行结论一句带过；不要逐个节点报状态，不要复述运行指标 JSON。",
    "- 交付内容如果是 stub 夹具文本、空值或明显占位内容，用一句话说明当前是离线夹具、没有真实模型产出，别包装成真实成果；然后仍要就用户的话题给有用的通用建议，并说明这不是工作流产出。",
    "- 不要用「根据您的要求」「希望能帮到您」这类客套话。",
    context.intent === "run"
      ? "- 这一轮确实要跑工作流，下面会附上运行结果，请围绕用户的问题把内容讲清楚。"
      : "- 这一轮只是聊天，直接回答用户的问题，不要请求运行工作流，也不要提节点状态。"
  ].join("\n");
}

/** 把长大产物截短，避免把整份 JSON 塞进提示词造成无谓 token 消耗。 */
export function stringifyArtifact(output: unknown, limit = 4000): string {
  if (output === undefined || output === null) {
    return "（无输出）";
  }
  let text: string;
  if (typeof output === "string") {
    text = output;
  } else {
    try {
      text = JSON.stringify(output, null, 2);
    } catch {
      text = String(output);
    }
  }
  if (!text.trim()) {
    return "（空输出）";
  }
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
}

/**
 * 取最终交付内容，而不是 run.output 里的运行指标。
 * 优先名字像交付节点的 step，否则退回最后一个有输出的 step。
 */
export function pickFinalArtifact(
  steps: DebugStep[]
): { nodeId: string; output: unknown } | undefined {
  const candidates = steps.filter((step) => step.output !== undefined && step.output !== null);
  const isMetric = (output: unknown) =>
    typeof output === "object" &&
    output !== null &&
    !Array.isArray(output) &&
    ["mode", "score", "stepCount", "tokensUsed"].filter((key) => key in (output as object)).length >= 3;
  const usable = candidates.filter((step) => !isMetric(step.output));
  // 从后往前挑：report 常在 deliver 之前，越靠后的交付节点越接近最终产物。
  const preferred = [...usable].reverse().find((step) =>
    /deliver|delivery|report|final|output|answer|result/i.test(step.nodeId ?? "")
  );
  const chosen = preferred ?? usable[usable.length - 1] ?? candidates[candidates.length - 1];
  if (!chosen) {
    return undefined;
  }
  return { nodeId: chosen.nodeId || "?", output: chosen.output };
}

/** 按顶层节点聚合，给折叠区与画布高亮用。容器内部路径取第一段。 */
export function summarizeNodes(steps: DebugStep[]): DebugNodeSummary[] {
  const map = new Map<string, DebugNodeSummary>();
  for (const step of steps) {
    const nodeId = (step.path?.split("/")[0] || step.nodeId || "?").trim() || "?";
    const current = map.get(nodeId) ?? {
      nodeId,
      status: "succeeded" as DebugNodeSummary["status"],
      durationMs: 0
    };
    current.durationMs += step.durationMs ?? 0;
    if (step.status === "failed") {
      current.status = "failed";
    } else if (
      (step.status === "running" || step.status === "waiting") &&
      current.status !== "failed"
    ) {
      current.status = step.status as DebugNodeSummary["status"];
    }
    map.set(nodeId, current);
  }
  return [...map.values()];
}

export type RunMessageContext = {
  message: string;
  artifact?: unknown;
  artifactNodeId?: string;
  status?: string;
  mode?: string;
  stepCount?: number;
  durationMs?: number;
  error?: string;
  nodes?: DebugNodeSummary[];
};

export function buildRunUserMessage(context: RunMessageContext): string {
  const lines = [`用户说：${context.message}`, ""];
  if (context.error) {
    lines.push(`工作流执行失败：${context.error}`, "请说明失败原因和下一步可以怎么调整。");
    return lines.join("\n");
  }
  lines.push(
    `运行结论：状态 ${context.status ?? "未知"}，共 ${context.stepCount ?? 0} 步，耗时 ${context.durationMs ?? 0} 毫秒，模式 ${context.mode ?? "未知"}。`,
    `最终交付节点：${context.artifactNodeId ?? "无"}`,
    "最终交付内容：",
    stringifyArtifact(context.artifact),
    "",
    "请围绕用户原本的问题，把这段交付内容讲成一段人话，运行结论一句带过。别罗列节点、别复述指标、别把回复写成运行报告。"
  );
  return lines.join("\n");
}

export type FallbackContext = {
  intent: DebugIntent;
  workflowName: string;
  message?: string;
  status?: string;
  mode?: string;
  stepCount?: number;
  durationMs?: number;
  error?: string;
};

/** 模型不可用时的本地逐字回复，保证界面始终有流式文字。 */
export function buildFallbackReply(context: FallbackContext): string {
  if (context.intent === "chat") {
    const topic = context.message?.trim();
    return topic
      ? `这会儿模型没接上，我先接住你这个问题：「${topic}」。等模型恢复我再详细答；想看流程怎么跑，到画布右侧的「调试运行」里发一条就行。`
      : `这会儿模型没接上，等恢复后我可以接着聊教学问题，也可以帮你跑一遍「${context.workflowName}」。`;
  }
  if (context.intent !== "run") {
    return `你好呀，我是「${context.workflowName}」的调试助手。教学、课堂、课程设计的问题可以直接问我，我会流式讲给你听；想跑一遍流程，就说「跑一遍工作流」，或者到画布右侧打开「调试运行」。`;
  }
  if (context.error) {
    return `这次没跑通：${context.error}。运行详情里能看到是哪一步出的问题，改完 DSL 再试一次就行。`;
  }
  const modeNote = context.mode === "stub" ? "当前是离线夹具模式，节点没有调用真实模型。" : "";
  return `「${context.workflowName}」跑完了，${context.stepCount ?? 0} 步，用时 ${context.durationMs ?? 0} 毫秒，状态是 ${context.status ?? "未知"}。${modeNote}最终交付的内容我放在下面的运行详情里了，点开就能看。刚才模型没接上，所以先由我把结果说明一下。`;
}

/** 离线兜底按小块切分，配合短延迟做出打字效果。 */
export function chunkFallbackText(text: string, size = 3): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}
