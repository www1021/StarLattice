import express from "express";
import {
  hashPassword,
  isPasswordCurrent,
  normalizeDisplayName,
  normalizeUsername,
  validatePassword,
  verifyPassword
} from "./password.js";
import { checkRateLimit, resetRateLimit } from "./rateLimit.js";
import { runWithAuth, type AuthContext } from "./context.js";
import { AuthStore, type AuthUser } from "./store.js";

const COOKIE_NAME = "sl_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GENERIC_LOGIN_ERROR = "用户名或密码不正确";
const GENERIC_REGISTER_ERROR = "注册失败，请检查用户名与密码";
const REQUESTED_WITH = "StarLattice";

export type AuthRegistrationHooks = {
  /** 首个账号诞生时把历史数据回填给它，必须在开放注册之前完成。 */
  onFirstUser?: (userId: string) => void | Promise<void>;
  /** 注销账号时删掉这个人在三个业务库里的全部个人数据。 */
  onDeleteUser?: (userId: string) => void | Promise<void>;
};

export type AuthOptions = AuthRegistrationHooks & {
  store: AuthStore;
  /** 是否允许任何人注册第二个及以后的账号；默认关闭，由 owner 邀请。 */
  allowSignup?: boolean;
};

function publicUser(user: AuthUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name,
    role: user.role
  };
}

type CookieCarrier = { headers: { cookie?: string } };

function readCookie(request: CookieCarrier): string | undefined {
  const header = request.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    if (part.slice(0, index).trim() === COOKIE_NAME) {
      return part.slice(index + 1).trim();
    }
  }
  return undefined;
}

function writeSessionCookie(
  request: express.Request,
  response: express.Response,
  raw: string,
  remember: boolean
) {
  const secure =
    request.secure || request.headers["x-forwarded-proto"] === "https";
  const attributes = [
    `${COOKIE_NAME}=${raw}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    ...(remember ? [`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`] : []),
    ...(secure ? ["Secure"] : [])
  ];
  response.setHeader("Set-Cookie", attributes.join("; "));
}

function clearSessionCookie(response: express.Response) {
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
  );
}

function clientIp(request: express.Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

/**
 * 同源校验 + 写请求的 CSRF 屏障。
 * application/json 与 multipart 跨站发不出去（会触发预检），所以只要这两种
 * 内容类型或自定义头之一存在就放行；纯表单式的跨站 POST 会被挡掉。
 */
function assertSameOrigin(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction
) {
  const origin = request.headers.origin;
  if (origin) {
    try {
      const originHost = new URL(origin).hostname;
      // Vite 代理带 changeOrigin，会改写 Host 且端口不同；只比主机名，
      // 本机回环地址之间互相放行。跨站来的一律拒绝。
      const requestHost = String(request.headers.host ?? "").split(":")[0];
      const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
      const allowedExtra = process.env.AUTH_ALLOWED_ORIGIN?.trim();
      const same =
        originHost === requestHost ||
        (loopback.has(originHost) && loopback.has(requestHost)) ||
        (Boolean(allowedExtra) && originHost === allowedExtra);
      if (!same) {
        response.status(403).json({ message: "请求来源不被允许" });
        return;
      }
    } catch {
      response.status(403).json({ message: "请求来源不被允许" });
      return;
    }
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const contentType = String(request.headers["content-type"] ?? "");
    const safeType =
      contentType.includes("application/json") ||
      contentType.includes("multipart/form-data");
    // Sec-Fetch-Site 是浏览器强制设置的禁止伪造请求头，same-origin 说明
    // 这次写操作就来自本站页面；留它做兜底，免得以后新加一个无体 DELETE
    // 又因为没有同源标记被误挡。跨站表单是 cross-site，不会命中。
    const sameSite = request.headers["sec-fetch-site"] === "same-origin";
    if (
      !safeType &&
      !sameSite &&
      request.headers["x-requested-with"] !== REQUESTED_WITH
    ) {
      response.status(403).json({ message: "请求缺少同源标记" });
      return;
    }
  }
  next();
}

function contextFor(raw: string, store: AuthStore): AuthContext | undefined {
  const found = store.lookupSession(raw);
  if (!found) {
    return undefined;
  }
  return {
    userId: found.user.id,
    username: found.user.username,
    displayName: found.user.display_name,
    role: found.user.role,
    sessionId: raw
  };
}

/** WebSocket 的 upgrade 请求不经过 Express，用它单独解析 Cookie。 */
export function resolveRequestAuth(
  request: CookieCarrier,
  store: AuthStore
): AuthContext | undefined {
  const raw = readCookie(request);
  return raw ? contextFor(raw, store) : undefined;
}

/** 统一鉴权：所有非白名单的 /api 请求都从这里过，身份放进异步上下文。 */
function requireAuth(store: AuthStore) {
  return (
    request: express.Request,
    response: express.Response,
    next: express.NextFunction
  ) => {
    if (request.path === "/health") {
      next();
      return;
    }
    const raw = readCookie(request);
    const context = raw ? contextFor(raw, store) : undefined;
    if (!context) {
      store.recordEvent({
        userId: null,
        action: "api.reject",
        target: request.path,
        result: "denied"
      });
      response.status(401).json({
        message: "登录已失效，请重新登录",
        code: "UNAUTHENTICATED"
      });
      return;
    }
    response.locals.auth = context;
    runWithAuth(context, () => next());
  };
}

/**
 * 注册公开/auth 路由，再给其余 /api 挂统一鉴权。
 * 必须在所有业务路由之前调用，顺序反了会把登录接口自己也锁在外面。
 */
export function registerAuth(app: express.Express, options: AuthOptions): void {
  const { store, allowSignup = false, onFirstUser, onDeleteUser } = options;
  const authJson = express.json({ limit: "16kb" });
  const router = express.Router();

  router.use(assertSameOrigin);
  router.use(authJson);

  /** 前端启动时先问一次：有没有账号、当前登没登录、能不能注册。 */
  router.get("/session", (request, response) => {
    const raw = readCookie(request);
    const context = raw ? contextFor(raw, store) : undefined;
    const userCount = store.countUsers();
    response.json({
      authenticated: Boolean(context),
      user: context
        ? {
            id: context.userId,
            username: context.username,
            displayName: context.displayName,
            role: context.role
          }
        : null,
      hasUsers: userCount > 0,
      signupOpen: userCount === 0 || allowSignup
    });
  });

  router.post("/register", async (request, response) => {
    const ip = clientIp(request);
    const username = normalizeUsername(request.body?.username);
    const passwordIssue = validatePassword(request.body?.password);
    const keys = [`register:${ip}`, `register:${ip}:${username ?? "invalid"}`];
    if (!checkRateLimit(keys, 5)) {
      store.recordEvent({ userId: null, action: "auth.register", result: "denied" });
      response.status(429).json({ message: "尝试过于频繁，请稍后再试" });
      return;
    }

    const userCount = store.countUsers();
    if (userCount > 0 && !allowSignup) {
      store.recordEvent({ userId: null, action: "auth.register", result: "denied" });
      response.status(403).json({ message: "注册已关闭，请联系账号所有者添加" });
      return;
    }
    if (!username || passwordIssue) {
      // 不细分「用户名格式错 / 密码太短 / 已存在」，免得被用来枚举账号。
      response.status(400).json({ message: GENERIC_REGISTER_ERROR });
      return;
    }
    if (store.findUserByUsername(username)) {
      response.status(400).json({ message: GENERIC_REGISTER_ERROR });
      return;
    }

    const passwordHash = await hashPassword(request.body.password as string);
    const displayName = normalizeDisplayName(request.body.displayName, username);
    const isFirst = store.countUsers() === 0;
    let user: AuthUser;
    try {
      user = isFirst
        ? store.claimFirstUser({
            username,
            displayName,
            passwordHash,
            role: "owner"
          })
        : store.createUser({
            username,
            displayName,
            passwordHash,
            role: "member"
          });
    } catch {
      response.status(400).json({ message: GENERIC_REGISTER_ERROR });
      return;
    }

    if (isFirst && onFirstUser) {
      await onFirstUser(user.id);
    }

    const raw = store.createSession(user.id, SESSION_TTL_MS);
    writeSessionCookie(request, response, raw, true);
    resetRateLimit(keys);
    store.recordEvent({
      userId: user.id,
      action: isFirst ? "auth.owner.created" : "auth.register",
      result: "ok"
    });
    response.status(201).json({ user: publicUser(user), isFirst });
  });

  router.post("/login", async (request, response) => {
    const ip = clientIp(request);
    const username = normalizeUsername(request.body?.username);
    const keys = [
      `login:${ip}`,
      `login:${ip}:${username ?? "invalid"}`
    ];
    if (!checkRateLimit(keys, 5)) {
      store.recordEvent({ userId: null, action: "auth.login", result: "denied" });
      response.status(429).json({ message: "尝试过于频繁，请稍后再试" });
      return;
    }

    const password = request.body?.password;
    const user = username ? store.findUserByUsername(username) : undefined;
    // 账号不存在时也算一次哈希，避免用响应时间差判断账号是否存在。
    const encoded =
      user?.password_hash ??
      (await hashPassword("dummy-password-for-timing"));
    const matched =
      typeof password === "string" &&
      (await verifyPassword(password, encoded)) &&
      Boolean(user);

    if (!matched || !user) {
      store.recordEvent({
        userId: user?.id ?? null,
        action: "auth.login",
        result: "failed"
      });
      response.status(401).json({ message: GENERIC_LOGIN_ERROR });
      return;
    }

    // 参数升级：老账号登录成功时按新成本重算，用户无感。
    if (!isPasswordCurrent(encoded)) {
      store.changePasswordHashOnly(
        user.id,
        await hashPassword(password as string)
      );
    }

    const previous = readCookie(request);
    if (previous) {
      store.deleteSession(previous);
    }
    const remember = request.body?.remember !== false;
    const raw = store.createSession(user.id, SESSION_TTL_MS);
    writeSessionCookie(request, response, raw, remember);
    resetRateLimit(keys);
    store.recordEvent({ userId: user.id, action: "auth.login", result: "ok" });
    response.json({ user: publicUser(user) });
  });

  router.post("/logout", (request, response) => {
    const raw = readCookie(request);
    const context = raw ? contextFor(raw, store) : undefined;
    if (raw) {
      store.deleteSession(raw);
    }
    clearSessionCookie(response);
    store.recordEvent({
      userId: context?.userId ?? null,
      action: "auth.logout",
      result: "ok"
    });
    response.json({ ok: true });
  });

  // 以下接口都要登录；router 内部的这道中间件不影响上面四个公开接口。
  router.use(requireAuth(store));

  router.get("/me", (_request, response) => {
    const context = response.locals.auth as AuthContext | undefined;
    const user = context ? store.findUserById(context.userId) : undefined;
    response.json({ user: user ? publicUser(user) : null });
  });

  /** owner 邀请：默认关闭自由注册时，这是加第二个账号的唯一入口。 */
  router.post("/invite", async (request, response) => {
    const context = response.locals.auth as AuthContext;
    if (context.role !== "owner") {
      response.status(403).json({ message: "只有账号所有者可以添加成员" });
      return;
    }
    const username = normalizeUsername(request.body?.username);
    const passwordIssue = validatePassword(request.body?.password);
    if (!username || passwordIssue) {
      response.status(400).json({ message: GENERIC_REGISTER_ERROR });
      return;
    }
    if (store.findUserByUsername(username)) {
      response.status(400).json({ message: GENERIC_REGISTER_ERROR });
      return;
    }
    const user = store.createUser({
      username,
      displayName: normalizeDisplayName(request.body.displayName, username),
      passwordHash: await hashPassword(request.body.password as string),
      role: "member"
    });
    store.recordEvent({
      userId: context.userId,
      action: "auth.invite",
      target: user.id,
      result: "ok"
    });
    response.status(201).json({ user: publicUser(user) });
  });

  /** 改密码：成功后所有旧会话立即失效。 */
  router.post("/password", async (request, response) => {
    const context = response.locals.auth as AuthContext;
    const user = store.findUserById(context.userId);
    const current = request.body?.currentPassword;
    const next = request.body?.password;
    const issue = validatePassword(next);
    if (
      !user ||
      typeof current !== "string" ||
      !(await verifyPassword(current, user.password_hash)) ||
      issue
    ) {
      store.recordEvent({
        userId: context.userId,
        action: "auth.password",
        result: "failed"
      });
      response.status(400).json({ message: "当前密码不正确，或新密码不符合要求" });
      return;
    }
    store.changePassword(user.id, await hashPassword(next as string));
    clearSessionCookie(response);
    store.recordEvent({
      userId: user.id,
      action: "auth.password",
      result: "ok"
    });
    response.json({ ok: true });
  });

  /** 注销账号：owner 不能删掉自己（否则整库数据无主）。 */
  router.delete("/account", async (request, response) => {
    const context = response.locals.auth as AuthContext;
    if (context.role === "owner") {
      response.status(403).json({ message: "账号所有者不能注销自己的账号" });
      return;
    }
    if (onDeleteUser) {
      await onDeleteUser(context.userId);
    }
    store.deleteUser(context.userId);
    clearSessionCookie(response);
    store.recordEvent({
      userId: null,
      action: "auth.account.deleted",
      result: "ok"
    });
    response.json({ ok: true });
  });

  router.get("/events", (request, response) => {
    const context = response.locals.auth as AuthContext;
    if (context.role !== "owner") {
      response.status(403).json({ message: "只有账号所有者可以查看审计日志" });
      return;
    }
    const limit = Math.min(200, Math.max(1, Number(request.query.limit) || 100));
    response.json({ events: store.listEvents(limit) });
  });

  router.use((_request, response) => {
    response.status(404).json({ message: "接口不存在" });
  });

  app.use("/api/auth", router);
  app.use("/api", assertSameOrigin, requireAuth(store));

  store.purgeExpiredSessions();
  const purgeTimer = setInterval(() => store.purgeExpiredSessions(), 60 * 60 * 1000);
  purgeTimer.unref?.();
}
