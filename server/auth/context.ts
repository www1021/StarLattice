import { AsyncLocalStorage } from "node:async_hooks";

/** 一次请求里带着的身份。所有 Repository 从这里取归属，不再逐个方法加参数。 */
export type AuthContext = {
  userId: string;
  username: string;
  displayName: string;
  role: "owner" | "member";
  sessionId: string;
};

const storage = new AsyncLocalStorage<AuthContext>();

/** 把后续整条异步链都放进这个身份里（Express 中间件与 WebSocket 连接各调一次）。 */
export function runWithAuth<T>(context: AuthContext, callback: () => T): T {
  return storage.run(context, callback);
}

export function currentAuth(): AuthContext | undefined {
  return storage.getStore();
}

/**
 * 当前请求的归属 id。
 * 返回 null 表示「不在 HTTP 请求里」：启动任务、后台调度、单元测试都走这条。
 * 这类调用方拿不到用户身份，Repository 保持旧行为（不加过滤），
 * 否则现有测试和后台台账会全部查空。所有对外入口都由鉴权中间件包住。
 */
/**
 * ws 的 message / close 回调不继承连接建立时的 AsyncLocalStorage 上下文，
 * 光在 upgrade 里包一层是不够的。在 connection 回调里调用一次，把身份抓住，
 * 之后每条消息都用返回的 wrap 包起来，服务层才拿得到 currentOwnerId()。
 */
export function bindConnectionAuth(): <T>(callback: () => T) => T {
  const context = currentAuth();
  return <T>(callback: () => T): T =>
    context ? runWithAuth(context, callback) : callback();
}

export function currentOwnerId(): string | null {
  return storage.getStore()?.userId ?? null;
}

/**
 * 从 response.locals 取回鉴权中间件存下的身份。
 * 这条路径不依赖 AsyncLocalStorage，上下文断掉之后仍然拿得到。
 */
export function authFromResponse(response: {
  locals?: Record<string, unknown>;
}): AuthContext | undefined {
  const value = response.locals?.auth as AuthContext | undefined;
  return value && typeof value.userId === "string" ? value : undefined;
}

/**
 * 重新进入某个身份，供「上下文已经断掉」的位置续上。
 *
 * body 解析器（multer、express.json）的完成回调来自 socket 的 data 事件，
 * 那条异步链是在鉴权中间件之前就创建好的，AsyncLocalStorage 到这里已经断了。
 * 解析结束后不重新进入，currentOwnerId() 就是 null，后续读模型、读设置会误判成
 * 「没有账号」，回落到进程级环境变量 —— 别人没配密钥也能用上部署方那把。
 */
export function resumeAuth<T>(
  context: AuthContext | undefined,
  callback: () => T
): T {
  return context ? runWithAuth(context, callback) : callback();
}

export type OwnerScope = {
  /** 拼在 WHERE 后面：无身份时恒真，有身份时限定归属。 */
  condition: string;
  /** 拼在已有条件的后面：无身份时为空串。 */
  and: string;
  /** 与上面两段配套的参数，直接展开进 prepare().all(...params)。 */
  params: string[];
};

/**
 * 生成一段可拼进 SQL 的归属条件。
 * alias 传表别名或表名，避免联表时列名歧义。
 */
export function ownerScope(alias = ""): OwnerScope {
  const ownerId = currentOwnerId();
  if (!ownerId) {
    return { condition: "1 = 1", and: "", params: [] };
  }
  const column = alias ? `${alias}.owner_id` : "owner_id";
  return {
    condition: `${column} = ?`,
    and: ` AND ${column} = ?`,
    params: [ownerId]
  };
}

/**
 * 「内置共享 + 自建私有」的可见性条件。
 *
 * owner_id 为空的是产品自带的那批（内置工具、示例 MCP 连接、内置工作流），
 * 全员只读可见；非空的是某个账号自己建的，别人查不到。
 * 和 ownerScope 的区别就在这里：ownerScope 只认本人，用在聊天记录这类纯私有表上。
 */
export function ownerVisibleScope(alias = ""): OwnerScope {
  const ownerId = currentOwnerId();
  if (!ownerId) {
    return { condition: "1 = 1", and: "", params: [] };
  }
  const column = alias ? `${alias}.owner_id` : "owner_id";
  return {
    condition: `(${column} IS NULL OR ${column} = ?)`,
    and: ` AND (${column} IS NULL OR ${column} = ?)`,
    params: [ownerId]
  };
}

/** 写入时用的归属值；无身份的后台任务写 null，回填时统一归给首个账号。 */
export function ownerValue(): string | null {
  return currentOwnerId();
}
