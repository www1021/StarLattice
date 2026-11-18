/**
 * 预置模型档案。
 *
 * 代码拉到本地、第一次打开设置面板时，这三条已经躺在「模型与密钥」里：
 * 接口地址、模型名都填好了，只有 API Key 空着等本人去接。
 * 这样换台机器不用照着文档重填一遍地址，也不会把谁的密钥带进仓库。
 * 用户改过、加过、删过之后以 data/settings/<账号>/models.json 为准，这里只在首次出现。
 */
export type SeedModel = {
  id: string;
  label: string;
  description: string;
  provider: string;
  model: string;
  baseUrl: string;
  tags: string[];
  costTier: "low" | "medium" | "high";
};

export const SEED_MODELS: SeedModel[] = [
  {
    id: "dashscope-qwen-plus",
    label: "qwen-plus",
    description: "阿里云百炼 · 预置，填入自己的 API Key 才能用",
    provider: "dashscope",
    model: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    tags: [],
    costTier: "medium"
  },
  {
    id: "dashscope-qwen-flash",
    label: "qwen-flash",
    description: "阿里云百炼 · 预置，填入自己的 API Key 才能用",
    provider: "dashscope",
    model: "qwen-flash",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    tags: [],
    costTier: "medium"
  },
  {
    id: "deepseek-deepseek-flash",
    label: "deepseek-flash",
    description: "深度求索 DeepSeek · 预置，填入自己的 API Key 才能用",
    provider: "deepseek",
    model: "deepseek-flash",
    baseUrl: "https://api.deepseek.com/v1",
    tags: [],
    costTier: "medium"
  }
];
