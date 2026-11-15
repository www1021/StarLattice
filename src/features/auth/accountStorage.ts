/**
 * 浏览器本地状态按账号分键。
 *
 * 未登录时 scope 为 null，读写落在原始键上（登录页只吃得到一份不含照片的外观）。
 * 登录后所有读写自动变成 sl.account.<userId>.<原键>，切换账号互不可见。
 * 原先这些键都是全局的：课堂快照里存着完整课堂状态、谈心映射里存着别人的
 * sessionId，同一个浏览器换账号就能直接读出来，所以统一在这里收口。
 */

const PREFIX = "sl.account.";
const MIGRATED_FLAG = "sl.account.legacy-migrated.v1";

/** 外观偏好的原始键，appearance.ts 也用这一个。 */
export const APPEARANCE_STORAGE_KEY = "sl.appearance";

let scope: string | null = null;

export function currentAccountScope(): string | null {
  return scope;
}

function scopedKey(key: string, owner: string | null): string {
  return owner ? `${PREFIX}${owner}.${key}` : key;
}

/**
 * 由 AuthProvider 在每次会话状态变化时同步调用。必须早于业务组件首次渲染，
 * 否则组件的 useState(readXxx()) 会读到上一个账号的键。
 */
export function setAccountScope(userId: string | null): void {
  const next = userId && /^[A-Za-z0-9_-]{1,64}$/.test(userId) ? userId : null;
  if (next === scope) {
    return;
  }
  scope = next;
  if (next) {
    adoptLegacyAppearance(next);
  }
}

/**
 * 升级前外观是全局单键。让第一个登录的账号继承它（跟首账号回填历史数据一个道理），
 * 之后把照片从全局键里剥掉：登录页不该露出任何账号上传的图片。
 * 迁移标记保证只做一次，后加的账号不会因此拿到别人的照片。
 */
function adoptLegacyAppearance(userId: string): void {
  try {
    const storage = window.localStorage;
    if (storage.getItem(MIGRATED_FLAG)) {
      return;
    }
    const legacy = storage.getItem(APPEARANCE_STORAGE_KEY);
    const target = scopedKey(APPEARANCE_STORAGE_KEY, userId);
    if (legacy && !storage.getItem(target)) {
      storage.setItem(target, legacy);
      const parsed = JSON.parse(legacy) as Record<string, unknown>;
      delete parsed.photo;
      delete parsed.cutout;
      storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(parsed));
    }
    storage.setItem(MIGRATED_FLAG, "1");
  } catch {
    // 隐私模式写不进去就跳过，界面照常走默认外观。
  }
}

function makeStorage(kind: "local" | "session") {
  const store = (): Storage =>
    kind === "local" ? window.localStorage : window.sessionStorage;
  return {
    getItem(key: string): string | null {
      try {
        return store().getItem(scopedKey(key, scope));
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        store().setItem(scopedKey(key, scope), value);
      } catch {
        // 配额或隐私模式下写不了，状态在当前会话里仍然有效。
      }
    },
    removeItem(key: string): void {
      try {
        store().removeItem(scopedKey(key, scope));
      } catch {
        // 同上。
      }
    }
  };
}

export const accountStorage = makeStorage("local");
export const accountSessionStorage = makeStorage("session");
