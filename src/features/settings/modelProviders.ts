/**
 * 添加模型时的供应商目录。
 *
 * 只收录 OpenAI 兼容协议（/chat/completions）的端点，其余供应商一律要求走「自定义」。
 * baseUrl 指到 /v1 这一层，服务端会自己拼 /chat/completions。
 */

export type ProviderModel = {
  /** 请求体里的 model 字段值。 */
  id: string;
  /** 下拉里给人看的名字，缺省时用 id。 */
  label?: string;
};

export type ModelProvider = {
  id: string;
  label: string;
  group: string;
  /** 列表左侧的单字标记，用来在长列表里快速定位。 */
  mark: string;
  baseUrl: string;
  models: ProviderModel[];
  docs?: string;
  keyPlaceholder?: string;
  note?: string;
  /** 本地服务没有鉴权，密钥可以留空。 */
  keyless?: boolean;
};

export const PROVIDER_GROUPS = ["常用", "海外", "本地", "其他"] as const;

export const MODEL_PROVIDERS: ModelProvider[] = [
  {
    id: "deepseek",
    label: "深度求索 DeepSeek",
    group: "常用",
    mark: "深",
    baseUrl: "https://api.deepseek.com/v1",
    docs: "https://api-docs.deepseek.com/zh-cn/",
    keyPlaceholder: "sk-...",
    note: "同一把密钥同时支持对话与推理模型，国内可直连。",
    models: [
      { id: "deepseek-chat", label: "DeepSeek-V3 对话" },
      { id: "deepseek-reasoner", label: "DeepSeek-R1 推理" }
    ]
  },
  {
    id: "moonshot",
    label: "月之暗面 Kimi",
    group: "常用",
    mark: "K",
    baseUrl: "https://api.moonshot.cn/v1",
    docs: "https://platform.moonshot.cn/docs",
    keyPlaceholder: "sk-...",
    note: "长上下文能力突出，适合整篇文档投喂。",
    models: [
      { id: "kimi-k2-0905-preview", label: "Kimi K2" },
      { id: "moonshot-v1-128k", label: "Moonshot 128K" },
      { id: "moonshot-v1-32k", label: "Moonshot 32K" }
    ]
  },
  {
    id: "dashscope",
    label: "阿里云百炼",
    group: "常用",
    mark: "百",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docs: "https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope",
    keyPlaceholder: "sk-...",
    note: "通义千问系列，控制台「API-KEY 管理」里创建密钥。",
    models: [
      { id: "qwen3-max", label: "Qwen3-Max" },
      { id: "qwen-plus", label: "Qwen-Plus" },
      { id: "qwen-turbo", label: "Qwen-Turbo" },
      { id: "qwen3-vl-plus", label: "Qwen3-VL-Plus（多模态）" },
      { id: "qwen-long", label: "Qwen-Long（长文档）" }
    ]
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    group: "常用",
    mark: "智",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    docs: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
    keyPlaceholder: "形如 xxxx.yyyy 的密钥",
    note: "GLM 系列，密钥由「ID.密钥」两段拼成，直接整段粘贴即可。",
    models: [
      { id: "glm-4.6", label: "GLM-4.6" },
      { id: "glm-4.5", label: "GLM-4.5" },
      { id: "glm-4-flash", label: "GLM-4-Flash（免费档）" }
    ]
  },
  {
    id: "hunyuan",
    label: "腾讯混元",
    group: "常用",
    mark: "混",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    docs: "https://cloud.tencent.com/document/product/1729",
    keyPlaceholder: "sk-...",
    note: "混元提供 OpenAI 兼容入口，密钥在腾讯云控制台创建。",
    models: [
      { id: "hunyuan-turbos-latest", label: "混元 TurboS" },
      { id: "hunyuan-t1-latest", label: "混元 T1（推理）" }
    ]
  },
  {
    id: "ark",
    label: "火山方舟 豆包",
    group: "常用",
    mark: "火",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    docs: "https://www.volcengine.com/docs/82379/1330626",
    keyPlaceholder: "填入方舟 API Key",
    note: "模型名要用方舟里的推理接入点 ID（ep- 开头）或模型 ID。",
    models: [
      { id: "doubao-seed-1-6-250615", label: "豆包 Seed 1.6" },
      { id: "doubao-pro-32k", label: "豆包 Pro 32K" }
    ]
  },
  {
    id: "minimax",
    label: "MiniMax",
    group: "常用",
    mark: "M",
    baseUrl: "https://api.minimax.chat/v1",
    docs: "https://platform.minimaxi.com/document",
    keyPlaceholder: "填入控制台的 API Key",
    note: "国内用 api.minimax.chat，海外账号换成 api.minimax.io。",
    models: [
      { id: "MiniMax-M2", label: "MiniMax M2" },
      { id: "MiniMax-Text-01", label: "MiniMax Text 01" }
    ]
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    group: "常用",
    mark: "硅",
    baseUrl: "https://api.siliconflow.cn/v1",
    docs: "https://docs.siliconflow.cn/",
    keyPlaceholder: "sk-...",
    note: "一个 key 调用多家开源模型；模型名带厂商前缀，如 deepseek-ai/DeepSeek-V3。",
    models: [
      { id: "deepseek-ai/DeepSeek-V3", label: "DeepSeek V3" },
      { id: "Qwen/Qwen2.5-72B-Instruct", label: "Qwen2.5 72B" }
    ]
  },
  {
    id: "openai",
    label: "OpenAI",
    group: "海外",
    mark: "O",
    baseUrl: "https://api.openai.com/v1",
    docs: "https://platform.openai.com/docs/api-reference",
    keyPlaceholder: "sk-...",
    note: "需要能直连 api.openai.com 的网络环境。",
    models: [
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o mini" },
      { id: "o4-mini", label: "o4-mini（推理）" }
    ]
  },
  {
    id: "gemini",
    label: "Google Gemini",
    group: "海外",
    mark: "G",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    docs: "https://ai.google.dev/gemini-api/docs/openai",
    keyPlaceholder: "AIza...",
    note: "走 Google 官方的 OpenAI 兼容端点，路径不带 /v1。",
    models: [
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }
    ]
  },
  {
    id: "ollama",
    label: "本地 Ollama",
    group: "本地",
    mark: "本",
    baseUrl: "http://127.0.0.1:11434/v1",
    docs: "https://docs.ollama.com/api/openai-compatibility",
    keyPlaceholder: "本地服务不用填",
    note: "本机端口没有鉴权，密钥留空也能用，显存够就选大一点的模型。",
    keyless: true,
    models: [
      { id: "deepseek-r1:8b", label: "deepseek-r1:8b" },
      { id: "qwen3:8b", label: "qwen3:8b" },
      { id: "qwen2.5:7b", label: "qwen2.5:7b" },
      { id: "llama3.1:8b", label: "llama3.1:8b" }
    ]
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    group: "本地",
    mark: "L",
    baseUrl: "http://127.0.0.1:1234/v1",
    docs: "https://lmstudio.ai/docs/app/api/endpoints/openai",
    keyPlaceholder: "本地服务不用填",
    note: "在 LM Studio 里开启本地服务端后即可直连，模型名以加载的为准。",
    keyless: true,
    models: []
  },
  {
    id: "custom",
    label: "自定义",
    group: "其他",
    mark: "自",
    baseUrl: "",
    note: "任何 OpenAI 兼容接口都行，地址填到 /v1 这一层，程序会自己拼 /chat/completions。",
    models: []
  }
];

export const CUSTOM_PROVIDER_ID = "custom";

/** 老配置和内置档案里的 provider 名跟目录 id 不完全一致，显示前先归一。 */
const PROVIDER_ALIASES: Record<string, string> = {
  qwen: "dashscope",
  dashscope: "dashscope",
  "openai-compatible": "custom",
  openai: "openai"
};

export function findProvider(id: string | undefined): ModelProvider | undefined {
  const key = PROVIDER_ALIASES[id ?? ""] ?? id;
  return MODEL_PROVIDERS.find((provider) => provider.id === key);
}

export function providerLabel(id: string | undefined): string {
  return findProvider(id)?.label ?? (id ? id : "未知供应商");
}

/** 保存时用来推测档案 id；中文等非法字符交给后端 slug 兜底。 */
export function suggestModelId(providerId: string, model: string): string {
  return `${providerId}-${model}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
