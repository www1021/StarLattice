/**
 * 接口地址归一。
 *
 * 用户经常把文档里那条完整端点整段粘进来（https://x/v1/chat/completions），
 * 而程序统一按「serviceUrl + /chat/completions」拼，不处理就会拼成
 * …/chat/completions/chat/completions 然后 404。这里统一退回 /v1 这一层。
 */
export function normalizeBaseUrl(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/+$/, "");
}

/**
 * 本机跑的推理服务（Ollama、LM Studio 之类）本来就不校验 API Key。
 * 判断「没填密钥」时要把它们排除掉，否则本地模型会被这条检查挡在门外。
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}
