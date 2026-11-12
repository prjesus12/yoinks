/**
 * Sliding-window rate limiting, keyed by whoever is asking. The hosted server
 * spawns yt-dlp per request, so an unmetered `/api/probe` is a CPU and file
 * descriptor exhaust with a single loop.
 */

export type RateLimitOptions = {
  /** Requests allowed inside one window. */
  limit: number
  windowMs: number
}

export type RateLimitResult = {
  allowed: boolean
  /** How long until a slot frees up. Only set when blocked. */
  retryAfterMs?: number
}

export type RateLimiter = {
  take: (key: string, now?: number) => RateLimitResult
  /** Forget keys whose whole window has passed — call it from the sweep. */
  prune: (now?: number) => void
  size: () => number
}

export function createRateLimiter({limit, windowMs}: RateLimitOptions): RateLimiter {
  const hits = new Map<string, number[]>()

  const fresh = (key: string, now: number): number[] => {
    const list = hits.get(key)
    if (!list) return []
    const kept = list.filter(at => now - at < windowMs)
    if (kept.length === 0) hits.delete(key)
    else hits.set(key, kept)
    return kept
  }

  return {
    take(key, now = Date.now()) {
      const list = fresh(key, now)
      if (list.length >= limit) {
        const oldest = list[0] ?? now
        return {allowed: false, retryAfterMs: Math.max(1, oldest + windowMs - now)}
      }
      list.push(now)
      hits.set(key, list)
      return {allowed: true}
    },
    prune(now = Date.now()) {
      for (const key of [...hits.keys()]) fresh(key, now)
    },
    size: () => hits.size,
  }
}
