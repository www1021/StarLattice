import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type AuthRole = "owner" | "member";

export type AuthUser = {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: AuthRole;
  created_at: string;
};

export type AuthSession = {
  id: string;
  user_id: string;
  expires_at: number;
  created_at: string;
  last_seen_at: string | null;
};

export type AuditEvent = {
  id: string;
  user_id: string | null;
  action: string;
  target: string;
  result: "ok" | "denied" | "failed";
  created_at: string;
};

function hashSessionId(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * 账号、会话、审计、文件归属放在一个独立的库里。
 * 独立文件有两个好处：不跟三个业务库抢写锁；备份 / 归档时可以单独处理。
 * 会话表里只存 id 的哈希，库文件泄露也不等于拿到一串能直接用的登录票据。
 */
export class AuthStore {
  readonly db: Database.Database;
  readonly dbPath: string;

  constructor(dbPath = process.env.AUTH_DB_PATH || path.resolve("data", "auth.db")) {
    this.dbPath = dbPath;
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.initialize();
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS auth_users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name  TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'member',
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        expires_at   INTEGER NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS auth_file_owners (
        file_id   TEXT PRIMARY KEY,
        owner_id  TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS auth_events (
        id         TEXT PRIMARY KEY,
        user_id    TEXT,
        action     TEXT NOT NULL,
        target     TEXT NOT NULL DEFAULT '',
        result     TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_auth_events_created ON auth_events(created_at);
    `);
  }

  close() {
    this.db.close();
  }

  countUsers(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM auth_users").get() as { n: number };
    return row.n;
  }

  findUserById(id: string): AuthUser | undefined {
    return this.db.prepare("SELECT * FROM auth_users WHERE id = ?").get(id) as AuthUser | undefined;
  }

  /** 最早创建的账号。存量数据补归属时用它，避免把老数据判给后来的人。 */
  firstUser(): AuthUser | undefined {
    return this.db
      .prepare("SELECT * FROM auth_users ORDER BY created_at ASC, rowid ASC LIMIT 1")
      .get() as AuthUser | undefined;
  }

  findUserByUsername(username: string): AuthUser | undefined {
    return this.db
      .prepare("SELECT * FROM auth_users WHERE username = ? COLLATE NOCASE")
      .get(username) as AuthUser | undefined;
  }

  createUser(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    role: AuthRole;
  }): AuthUser {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO auth_users (id, username, display_name, password_hash, role)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, input.username, input.displayName, input.passwordHash, input.role);
    return this.findUserById(id)!;
  }

  /**
   * 抢占首个账号。用 IMMEDIATE 事务拿写锁，避免两个并发注册都读到
   * 「库里还没有账号」而各自创建一个 owner。
   */
  claimFirstUser(input: {
    username: string;
    displayName: string;
    passwordHash: string;
    role: AuthRole;
  }): AuthUser {
    return this.db.transaction(() => {
      if (this.countUsers() > 0) {
        throw new Error("首个账号已被创建");
      }
      return this.createUser(input);
    }).immediate();
  }

  /** 注销账号：级联删掉会话、文件归属，审计记录保留。 */
  deleteUser(userId: string) {
    this.db.prepare("DELETE FROM auth_users WHERE id = ?").run(userId);
  }

  /** 改密码并踢掉所有旧会话。 */
  changePassword(userId: string, passwordHash: string) {
    this.db.prepare("UPDATE auth_users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
    this.deleteUserSessions(userId);
  }

  /** 登录时 quietly 升级哈希参数：只换哈希，不影响当前会话。 */
  changePasswordHashOnly(userId: string, passwordHash: string) {
    this.db.prepare("UPDATE auth_users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
  }

  /** 返回原始票据（只通过 Set-Cookie 交给浏览器），库里落的是哈希。 */
  createSession(userId: string, ttlMs: number): string {
    const raw = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, user_id, expires_at, last_seen_at)
         VALUES (?, ?, ?, datetime('now'))`
      )
      .run(hashSessionId(raw), userId, Date.now() + ttlMs);
    return raw;
  }

  lookupSession(raw: string): { session: AuthSession; user: AuthUser } | undefined {
    const session = this.db
      .prepare("SELECT * FROM auth_sessions WHERE id = ?")
      .get(hashSessionId(raw)) as AuthSession | undefined;
    if (!session || session.expires_at <= Date.now()) {
      if (session) {
        this.db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(session.id);
      }
      return undefined;
    }
    const user = this.findUserById(session.user_id);
    if (!user) {
      this.db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(session.id);
      return undefined;
    }
    return { session, user };
  }

  touchSession(raw: string) {
    this.db
      .prepare("UPDATE auth_sessions SET last_seen_at = datetime('now') WHERE id = ?")
      .run(hashSessionId(raw));
  }

  deleteSession(raw: string) {
    this.db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(hashSessionId(raw));
  }

  deleteUserSessions(userId: string) {
    this.db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
  }

  listSessions(userId: string): Array<{ id: string; created_at: string; last_seen_at: string | null }> {
    return this.db
      .prepare(
        `SELECT substr(id, 1, 10) AS id, created_at, last_seen_at
         FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC`
      )
      .all(userId) as Array<{ id: string; created_at: string; last_seen_at: string | null }>;
  }

  /** 清理过期会话，启动时跑一次，之后每小时跑一次。 */
  purgeExpiredSessions(): number {
    return this.db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(Date.now()).changes;
  }

  setFileOwner(fileId: string, ownerId: string) {
    this.db
      .prepare(
        `INSERT INTO auth_file_owners (file_id, owner_id) VALUES (?, ?)
         ON CONFLICT(file_id) DO NOTHING`
      )
      .run(fileId, ownerId);
  }

  getFileOwner(fileId: string): string | undefined {
    const row = this.db
      .prepare("SELECT owner_id FROM auth_file_owners WHERE file_id = ?")
      .get(fileId) as { owner_id: string } | undefined;
    return row?.owner_id;
  }

  /**
   * 审计只记元数据：谁、做了什么、对哪个 id、结果如何。
   * 密码、Cookie、请求体、对话正文一律不进来。
   */
  recordEvent(input: {
    userId: string | null;
    action: string;
    target?: string;
    result: AuditEvent["result"];
  }) {
    this.db
      .prepare(
        `INSERT INTO auth_events (id, user_id, action, target, result) VALUES (?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), input.userId, input.action, input.target ?? "", input.result);
  }

  listEvents(limit = 100): AuditEvent[] {
    return this.db
      .prepare("SELECT * FROM auth_events ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit) as AuditEvent[];
  }
}
