export type CacheTtl = '5m' | '1h'

/** The last main-thread API request, as the transcript recorded it. */
export type CacheSnap = {
  /** When the request started (ms since epoch): the cache timer's origin. */
  startedAt: number
  /** TTL the request actually wrote with; null when it wrote nothing (pure hit). */
  ttl: CacheTtl | null
  model: string
  isFast: boolean
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export type CacheBreaker = { kind: 'model' | 'compact'; detail: string; toModel?: string }

export type CacheTick = { now: number; draftChars: number }

export type CacheMode = 'full' | 'off'

export type CacheDemo = 'warm' | 'expiring' | 'expired' | 'model' | 'compacted' | 'working'

declare module 'claude-code' {
  interface PluginState {
    'cache-watch': {
      snap: CacheSnap | null
      ttl: CacheTtl | null
      breaker: CacheBreaker | null
      tick: CacheTick
      mode: CacheMode
      transcriptPath: string | null
      demo: CacheDemo | null
    }
  }
}
