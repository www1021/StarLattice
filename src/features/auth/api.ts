/** 与 server/auth/password.ts 的 MIN_PASSWORD_LENGTH 保持一致。 */
export const MIN_PASSWORD_LENGTH = 8;

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: "owner" | "member";
};

export type SessionInfo = {
  authenticated: boolean;
  user: AuthUser | null;
  hasUsers: boolean;
  signupOpen: boolean;
};

export type AuditEntry = {
  id: string;
  user_id: string | null;
  action: string;
  target: string;
  result: "ok" | "denied" | "failed";
  created_at: string;
};

export class AuthApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AuthApiError";
  }
}

async function authFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`/api/auth${path}`, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "StarLattice",
      ...(init.headers ?? {})
    }
  });
  const raw = await response.text();
  const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  if (!response.ok) {
    throw new AuthApiError(
      typeof payload.message === "string" ? payload.message : `请求失败（${response.status}）`,
      response.status
    );
  }
  return payload as T;
}

export function fetchSession(): Promise<SessionInfo> {
  return authFetch<SessionInfo>("/session");
}

export function login(input: {
  username: string;
  password: string;
  remember: boolean;
}): Promise<{ user: AuthUser }> {
  return authFetch<{ user: AuthUser }>("/login", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function register(input: {
  username: string;
  password: string;
  displayName?: string;
}): Promise<{ user: AuthUser; isFirst: boolean }> {
  return authFetch<{ user: AuthUser; isFirst: boolean }>("/register", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return authFetch<{ ok: boolean }>("/logout", {
    method: "POST",
    body: "{}"
  });
}

export function invite(input: {
  username: string;
  password: string;
}): Promise<{ user: AuthUser }> {
  return authFetch<{ user: AuthUser }>("/invite", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function changePassword(input: {
  currentPassword: string;
  password: string;
}): Promise<{ ok: boolean }> {
  return authFetch<{ ok: boolean }>("/password", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteAccount(): Promise<{ ok: boolean }> {
  return authFetch<{ ok: boolean }>("/account", { method: "DELETE" });
}

export function listEvents(): Promise<{ events: AuditEntry[] }> {
  return authFetch<{ events: AuditEntry[] }>("/events?limit=60");
}
