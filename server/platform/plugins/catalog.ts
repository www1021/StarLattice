import type { PluginView } from "../types.js";

/**
 * 官方插件：平台内置、全员可见、不可删除，也不落用户库（与 BUILTIN_AGENTS 同思路）。
 * 这里的 calls / references / version 为展示用的基线值，真实统计接入 Agent 引用后由服务层覆盖。
 */
export const OFFICIAL_PLUGINS: PluginView[] = [
  {
    id: "off-weather",
    name: "天气查询",
    type: "api",
    description: "按城市名或坐标查询实时天气与未来预报，返回结构化 JSON。",
    official: true,
    status: "active",
    domain: "api.weatherapi.com",
    endpoint: "https://api.weatherapi.com/v1/current.json",
    method: "GET",
    calls: 1840,
    tools: 2,
    references: 6,
    version: "2.3.0",
    updatedAt: "2026-10-21"
  },
  {
    id: "off-scrape",
    name: "网页抓取",
    type: "api",
    description: "抓取指定网页正文与元数据，自动清洗为纯文本或 Markdown。",
    official: true,
    status: "active",
    domain: "api.jina.ai",
    endpoint: "https://r.jina.ai/https://{url}",
    method: "GET",
    calls: 932,
    tools: 1,
    references: 4,
    version: "1.5.1",
    updatedAt: "2026-09-30"
  },
  {
    id: "off-translate",
    name: "翻译",
    type: "code",
    description: "调用本地模型做中英互译，支持术语表与语气控制。",
    official: true,
    status: "active",
    runtime: "Python 3.11",
    calls: 4210,
    tools: 1,
    references: 9,
    version: "3.0.2",
    updatedAt: "2026-11-02"
  }
];
