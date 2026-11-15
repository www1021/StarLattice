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
