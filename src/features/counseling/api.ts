import type { CounselingConfig, CounselingSession } from "../../../shared/counseling";

async function request<T>(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as { message?: string } | undefined;
    throw new Error(payload?.message || "谈心谈话请求失败。");
  }
  return response.json() as Promise<T>;
}

export type CounselingConfigResponse = {
  cases: Array<CounselingSession["student"]>;
  capabilities: { model: boolean; iflytek: boolean; voice: "browser-or-iflytek" };
};

export function loadCounselingConfig() {
  return request<CounselingConfigResponse>("/api/counseling/config");
}

export function getCounselingSession(id: string) {
  return request<{ session: CounselingSession }>(`/api/counseling/sessions/${encodeURIComponent(id)}`);
}

export function createCounselingSession(config: CounselingConfig) {
  return request<{ session: CounselingSession }>("/api/counseling/sessions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(config)
  });
}

export function submitCounselingTurn(id: string, text: string, turnId: string) {
  return request<{ session: CounselingSession }>(`/api/counseling/sessions/${encodeURIComponent(id)}/turn`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, turnId })
  });
}

export function finishCounselingSession(id: string) {
  return request<{ session: CounselingSession }>(`/api/counseling/sessions/${encodeURIComponent(id)}/finish`, { method: "POST" });
}

export function saveCounselingDraft(id: string) {
  return request<{ session: CounselingSession }>(`/api/counseling/sessions/${encodeURIComponent(id)}/save-draft`, { method: "POST" });
}
