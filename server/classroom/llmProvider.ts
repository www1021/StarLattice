import { isQwenConfigured, streamQwenChat } from "../qwenOpenAiClient.js";

export type LlmProvider = {
  generateStudentReaction(prompt: string, options?: { timeoutMs?: number }): Promise<string>;
  generateObserverTip(prompt: string): Promise<string>;
  generateClassroomReport(prompt: string, options?: { timeoutMs?: number }): Promise<string>;
  mode: "mock" | "llm";
};

export const mockLlmProvider: LlmProvider = {
  mode: "mock",
  async generateStudentReaction(prompt) {
    return `规则引擎学生反应：${prompt.slice(0, 80)}`;
  },
  async generateObserverTip(prompt) {
    return `规则引擎观察提示：${prompt.slice(0, 80)}`;
  },
  async generateClassroomReport(prompt) {
    return `规则引擎诊断报告：${prompt.slice(0, 80)}`;
  }
};

export function createClassroomLlmProvider(): LlmProvider {
  if (!isQwenConfigured()) {
    return mockLlmProvider;
  }

  return {
    mode: "llm",
    async generateStudentReaction(prompt, options) {
      return runMimoText(
        `你是虚拟课堂学生智能体。请严格按要求输出 JSON，不要输出 Markdown。\n${prompt}`,
        options
      );
    },
    async generateObserverTip(prompt) {
      return runMimoText(`你是师范生微格教学课堂观察员。请只给一句具体、克制、可操作的实时建议。\n${prompt}`);
    },
    async generateClassroomReport(prompt, options) {
      return runMimoText(
        `你是师范生教学能力诊断专家。请用一段专业但简洁的话补充课堂诊断洞察。\n${prompt}`,
        options
      );
    }
  };
}

async function runMimoText(prompt: string, options: { timeoutMs?: number } = {}) {
  let content = "";
  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;

  try {
    const result = await streamQwenChat({
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      enableThinking: false,
      signal: controller.signal,
      onDelta(delta) {
        content += delta;
      },
      onThinkingDelta() {}
    });

    return (result.visibleAssistantContent || content).trim();
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
