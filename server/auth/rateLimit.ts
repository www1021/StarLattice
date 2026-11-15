type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

/**
 * 单机单进程用的固定窗口计数器。注册 / 登录按「IP」和「IP + 用户名」各算一桶，
 * 任何一桶超了都拒绝，避免只换用户名就能绕开。
 * 分布式部署要换成 Redis，但本项目是本机 SQLite 架构，内存桶足够。
 */
export function checkRateLimit(
  keys: string[],
  limit = 5,
  windowMs = 60_000
): boolean {
  const now = Date.now();
  for (const key of keys) {
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      continue;
    }
    if (bucket.count >= limit) {
      return false;
    }
    bucket.count += 1;
  }
  // 顺手清掉过期桶，避免长时间运行后 Map 一直涨。
  if (buckets.size > 2000) {
    for (const [key, value] of buckets) {
      if (value.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }
  return true;
}

export function resetRateLimit(keys: string[]) {
  for (const key of keys) {
    buckets.delete(key);
  }
}
