import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

type ScryptOptions = { N: number; r: number; p: number; maxmem: number };

/** promisify 会挑错 scrypt 的重载，这里直接包一层，参数和返回类型都写死。 */
const scryptAsync = (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => {
      if (error) {
        reject(error);
      } else {
        resolve(derived);
      }
    });
  });

/** OWASP 2026 对 scrypt 的最低要求：N=2^17, r=8, p=1。 */
const N = 131072;
const R = 8;
const P = 1;
/** Node 默认 maxmem 只有 32 MiB，N=2^17 实测需要 >128 MiB，这里留足余量。 */
const MAXMEM = 192 * 1024 * 1024;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** 库里的参数被篡改时，不能让服务端按一个天文数字的 N 去算。 */
const MAX_N = 1 << 20;

/**
 * 哈希串格式：scrypt$N$r$p$salt$hash（base64url），参数跟着盐一起入库，
 * 以后调高成本时老账号仍能用各自的参数校验，登录成功再按新参数重算覆盖。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = (await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM
  })) as Buffer;
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64url"),
    derived.toString("base64url")
  ].join("$");
}

/** 校验：用库里存的盐与参数把输入再算一遍，常量时间比对两个哈希。 */
export async function verifyPassword(
  password: string,
  encoded: string
): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isInteger(n) || n < 1 || n > MAX_N ||
    !Number.isInteger(r) || r < 1 || r > 64 ||
    !Number.isInteger(p) || p < 1 || p > 64
  ) {
    return false;
  }
  let expected: Buffer;
  let salt: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (salt.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) {
    return false;
  }
  const derived = (await scryptAsync(password, salt, KEY_LENGTH, {
    N: n,
    r,
    p,
    maxmem: Math.max(MAXMEM, Math.ceil((128 * n * r * 1.2) / (1024 * 1024)) * 1024 * 1024)
  })) as Buffer;
  return timingSafeEqual(derived, expected);
}

/** 串里的参数是否已经是当前标准；登录成功后可据此决定是否重新哈希。 */
export function isPasswordCurrent(encoded: string): boolean {
  const parts = encoded.split("$");
  return (
    parts.length === 6 &&
    parts[0] === "scrypt" &&
    Number(parts[1]) >= N &&
    Number(parts[2]) === R &&
    Number(parts[3]) === P
  );
}

/**
 * 密码下限。本机 / 可信局域网场景，scrypt 慢哈希和登录限速都在，
 * 8 字符足够；15 字符对用户太不友好。前端 src/features/auth/api.ts 有同名常量，
 * 两边要一起改。
 */
export const MIN_PASSWORD_LENGTH = 8;

/** 密码规则：下限 8 字符、上限 128 字节，不强制大小写数字符号组合。 */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `密码至少 ${MIN_PASSWORD_LENGTH} 个字符`;
  }
  if (Buffer.byteLength(password, "utf8") > 128) {
    return "密码过长（超过 128 字节）";
  }
  return null;
}

/** 用户名：3~32 个 Unicode 字母 / 数字 / _ / -，去首尾空格并统一大小写查重。 */
export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^[\p{L}\p{N}_-]{3,32}$/u.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** 显示名只是界面文案：去掉控制字符、限长，不做别的加工（React 会负责转义）。 */
export function normalizeDisplayName(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 32);
  return clean || fallback;
}
