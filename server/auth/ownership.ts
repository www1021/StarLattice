import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync
} from "node:fs";
import path from "node:path";
import { currentOwnerId } from "./context.js";
import type { AuthStore } from "./store.js";

/**
 * 个人数据表清单。注册中心、调度台账、演化记录这些平台资产不在里面，
 * 它们对所有账号可见，分用户反而会让「注册中心」每个人看到不一样。
 * FTS5 虚表不能加列，检索时通过 chunks / documents 的归属过滤。
 */
export const PERSONAL_TABLES = {
  training: [
    "conversations",
    "conversation_messages",
    "conversation_artifacts",
    "conversation_citations",
    "training_evaluations",
    "speak_training_sessions",
    "counseling_sessions",
    "growth_snapshots"
  ],
  knowledge: ["knowledge_bases", "knowledge_documents", "knowledge_chunks"],
  platform: [
    "platform_workflows",
    "platform_eval_tasks",
    "platform_mcp_servers",
    // 运行记录必须跟着工作流走：runs 里存着 definition、input、output，
    // 不隔离的话别人能借运行详情看到你的工作流定义和输入输出。
    "platform_runs"
  ]
} as const;

type DatabaseKey = keyof typeof PERSONAL_TABLES;

/**
 * 只在删号时清理、启动时不做回填的表。
 * 工具表里的「无主行」是内置工具，属于产品本身，补给某个账号会让别人再也看不到。
 */
const CLEANUP_ONLY_TABLES: Partial<Record<DatabaseKey, readonly string[]>> = {
  // 自建智能体永远有主人，不该被回填；删号时要跟着走，否则会留一批谁都看不见的孤儿配置。
  platform: ["platform_tools", "chat_agents"]
};

function databasePath(key: DatabaseKey): string {
  const fromEnv: Record<DatabaseKey, string | undefined> = {
    training: process.env.TRAINING_DB_PATH,
    knowledge: process.env.KNOWLEDGE_DB_PATH,
    platform: process.env.PLATFORM_DB_PATH
  };
  return fromEnv[key] || path.resolve("data", `${key}.db`);
}

function settingsRoot(): string {
  return process.env.MODEL_SETTINGS_DIR || path.resolve("data", "settings");
}

function open(pathname: string): Database.Database | undefined {
  if (!existsSync(pathname)) {
    return undefined;
  }
  const db = new Database(pathname);
  db.pragma("busy_timeout = 5000");
  return db;
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

/**
 * 给一个已打开的连接补列。各 store 在 initialize() 里直接调它，
 * 这样单元测试里单独 new 一个 Repository 也不会遇到「没有 owner_id 列」。
 */
export function ensureOwnerColumnsFor(
  db: Database.Database,
  tables: readonly string[]
): void {
  for (const table of tables) {
    if (!tableExists(db, table)) {
      continue;
    }
    if (!hasColumn(db, table, "owner_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN owner_id TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_owner ON ${table}(owner_id)`);
  }
}

/** 启动时再统一兜一次，覆盖那些只在运行期才建出来的表。 */
export function ensureOwnerColumns(): void {
  for (const key of Object.keys(PERSONAL_TABLES) as DatabaseKey[]) {
    const db = open(databasePath(key));
    if (!db) {
      continue;
    }
    try {
      ensureOwnerColumnsFor(db, PERSONAL_TABLES[key]);
    } finally {
      db.close();
    }
  }
}

/**
 * 首个账号创建时调用，把历史数据全部归给它。
 * 必须在开放注册之前做完，否则老数据会变成谁都查不到的无主数据。
 */
export function backfillOwnerData(userId: string, store?: AuthStore): void {
  assignOrphanRows(userId);
  adoptLegacySettings(userId);
  // 已经生成过的导出文件也归给首个账号，否则老文件下载时会被判成无主。
  if (store && existsSync(generatedDir())) {
    for (const name of readdirSync(generatedDir())) {
      store.setFileOwner(name, userId);
    }
  }
}

/**
 * 只补「归属为空」的存量行，不碰密钥目录和导出文件。
 * 给已经有账号、但后来又加了隔离列的老库用（比如运行记录）。
 */
export function backfillOrphanRows(userId: string): void {
  assignOrphanRows(userId);
}

function assignOrphanRows(userId: string): void {
  for (const key of Object.keys(PERSONAL_TABLES) as DatabaseKey[]) {
    const db = open(databasePath(key));
    if (!db) {
      continue;
    }
    try {
      const update = db.transaction(() => {
        for (const table of PERSONAL_TABLES[key]) {
          if (!tableExists(db, table) || !hasColumn(db, table, "owner_id")) {
            continue;
          }
          db.prepare(`UPDATE ${table} SET owner_id = ? WHERE owner_id IS NULL`).run(userId);
        }
      });
      update.immediate();
    } finally {
      db.close();
    }
  }
}

function generatedDir(): string {
  return path.resolve("generated");
}

/** 新生成的导出文件记一笔归属，下载端点据此校验。 */
export function recordGeneratedFileOwner(fileId: string): void {
  const ownerId = currentOwnerId();
  if (!ownerId) {
    return;
  }
  const db = open(process.env.AUTH_DB_PATH || path.resolve("data", "auth.db"));
  if (!db) {
    return;
  }
  try {
    db.prepare(
      `INSERT INTO auth_file_owners (file_id, owner_id) VALUES (?, ?)
       ON CONFLICT(file_id) DO NOTHING`
    ).run(fileId, ownerId);
  } finally {
    db.close();
  }
}

/**
 * 模型密钥原来是全局一份。首个账号诞生后改成按用户分目录，
 * 这里把老文件复制进他的目录，避免一登录发现之前填的 Key 全不见了。
 */
function adoptLegacySettings(userId: string): void {
  const root = settingsRoot();
  const target = path.join(root, userId);
  if (!existsSync(root)) {
    return;
  }
  mkdirSync(target, { recursive: true });
  for (const name of ["models.json", "model-key"]) {
    const source = path.join(root, name);
    const destination = path.join(target, name);
    if (existsSync(source) && !existsSync(destination)) {
      copyFileSync(source, destination);
    }
  }
  // 复制完成后把根目录那份收进归档，别在共享位置留一份同等的密钥副本。
  quarantineLegacySettings();
}

/** 是否已经有账号把自己的模型配置接管过去了（有才说明根目录那份可以归档）。 */
function hasOwnedSettingsCopy(): boolean {
  const root = settingsRoot();
  if (!existsSync(root)) {
    return false;
  }
  return readdirSync(root, { withFileTypes: true }).some(
    (entry) =>
      entry.isDirectory() &&
      !entry.name.startsWith("_") &&
      existsSync(path.join(root, entry.name, "models.json"))
  );
}

/**
 * 把还没分账号时留下的全局模型文件（settings 根目录的 models.json / model-key）
 * 挪进 `_legacy/<时间戳>/` 归档。
 *
 * 旧版把这俩文件放在共享根目录，无身份的调用（后台任务、调度器）会落到那里读。
 * 分账号之后它就成了「谁的账号都能顺带用上」的影子凭据，必须移走。
 * 只有确认已有账号接管过配置才动手，避免把唯一一份配置藏进归档。
 */
export function quarantineLegacySettings(): void {
  const root = settingsRoot();
  if (!existsSync(root) || !hasOwnedSettingsCopy()) {
    return;
  }
  const files = ["models.json", "model-key"]
    .map((name) => ({ name, source: path.join(root, name) }))
    .filter((item) => existsSync(item.source));
  if (files.length === 0) {
    return;
  }
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const target = path.join(root, "_legacy", stamp);
  mkdirSync(target, { recursive: true });
  for (const item of files) {
    try {
      renameSync(item.source, path.join(target, item.name));
    } catch {
      // 跨盘或被占用的退回复制 + 删除，归档失败也不能把凭据留在共享位置。
      copyFileSync(item.source, path.join(target, item.name));
      rmSync(item.source, { force: true });
    }
  }
  console.warn(
    `[auth] 旧版全局模型配置已归档到 ${path.relative(root, target)}，不再作为无身份调用的共享凭据。`
  );
}

/** 注销账号：删掉这个人在三个业务库、密钥目录和生成文件里的全部数据。 */
export function deleteOwnerData(userId: string, generatedDir: string): void {
  for (const key of Object.keys(PERSONAL_TABLES) as DatabaseKey[]) {
    const db = open(databasePath(key));
    if (!db) {
      continue;
    }
    try {
      const remove = db.transaction(() => {
        for (const table of [...PERSONAL_TABLES[key], ...(CLEANUP_ONLY_TABLES[key] ?? [])]) {
          if (!tableExists(db, table) || !hasColumn(db, table, "owner_id")) {
            continue;
          }
          db.prepare(`DELETE FROM ${table} WHERE owner_id = ?`).run(userId);
        }
      });
      remove.immediate();
    } finally {
      db.close();
    }
  }

  const settings = path.join(settingsRoot(), userId);
  if (existsSync(settings)) {
    rmSync(settings, { recursive: true, force: true });
  }
  if (existsSync(generatedDir)) {
    for (const name of readdirSync(generatedDir)) {
      // 文件归属由 auth_file_owners 记录；这里只清掉按 owner 前缀命名的目录。
      if (name.startsWith(`${userId}_`) || name === userId) {
        rmSync(path.join(generatedDir, name), { recursive: true, force: true });
      }
    }
  }
}
