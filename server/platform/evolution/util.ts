import { createHash, randomUUID } from "node:crypto";

/** 稳定序列化：对象键排序，保证同一快照每次得到相同哈希。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) {
        sorted[key] = sortValue(record[key]);
      }
    }
    return sorted;
  }
  return value;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value: string, length = 12): string {
  return sha256(value).slice(0, length);
}

export function slug(value: string, fallback = "item"): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** 可复现的 32 位随机数发生器，bootstrap 结果不随机器变化。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(value: string): number {
  return Number.parseInt(sha256(value).slice(0, 8), 16);
}

/** 0–99 的稳定桶位，用于金丝雀分流；同一 assignmentKey 始终落在同一侧。 */
export function trafficBucket(key: string): number {
  return Number.parseInt(sha256(key).slice(0, 8), 16) % 100;
}

export function round4(value: number): number {
  return Number(value.toFixed(4));
}

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") {
    return fallback;
  }
  return !["0", "false", "off", "no"].includes(value);
}

export function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
