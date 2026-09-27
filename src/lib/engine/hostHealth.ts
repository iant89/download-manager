/**
 * Host health tracking (plan P3-02).
 *
 * Keeps per-host statistics so the scheduler and adaptive controller can make
 * informed decisions. All updates are cheap and lock-free; the store can read
 * stats for the diagnostics panel without affecting the download path.
 */

export interface HostStats {
  host: string
  averageLatency: number
  throughput: number // bytes/s, EMA
  failures: number
  rateLimited: boolean
  lastRateLimitAt: number | null
  connectionResets: number
  samples: number
  successCount: number
}

export interface HostHealthOptions {
  latencyAlpha?: number
  throughputAlpha?: number
  rateLimitCooldownMs?: number
}

export class HostHealthTracker {
  private stats = new Map<string, HostStats>()
  private latencyAlpha: number
  private throughputAlpha: number
  private rateLimitCooldownMs: number

  constructor(options: HostHealthOptions = {}) {
    this.latencyAlpha = options.latencyAlpha ?? 0.3
    this.throughputAlpha = options.throughputAlpha ?? 0.2
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 30_000
  }

  /** Records a successful fetch's latency and throughput. */
  recordSuccess(host: string, latencyMs: number, bytes: number, durationMs: number): void {
    const s = this.ensure(host)
    s.averageLatency = s.samples === 0 ? latencyMs : this.latencyAlpha * latencyMs + (1 - this.latencyAlpha) * s.averageLatency
    if (durationMs > 0) {
      const sample = (bytes / durationMs) * 1000
      s.throughput = s.samples === 0 ? sample : this.throughputAlpha * sample + (1 - this.throughputAlpha) * s.throughput
    }
    s.successCount += 1
    s.samples += 1
  }

  recordFailure(host: string, kind: 'reset' | '429' | '5xx' | 'other' | 'timeout' = 'other'): void {
    const s = this.ensure(host)
    s.failures += 1
    if (kind === 'reset') s.connectionResets += 1
    if (kind === '429') {
      s.rateLimited = true
      s.lastRateLimitAt = Date.now()
    }
    s.samples += 1
  }

  /** Called when a 429's Retry-After has elapsed or we observe successful requests again. */
  clearRateLimit(host: string): void {
    const s = this.stats.get(host)
    if (!s) return
    s.rateLimited = false
  }

  /** Returns a snapshot for a host, or a blank one if unknown. */
  get(host: string): HostStats {
    return this.ensure(host)
  }

  getAll(): HostStats[] {
    return [...this.stats.values()].map((s) => ({ ...s }))
  }

  /** Prunes hosts not seen for a while (optional maintenance). */
  prune(before = Date.now() - 5 * 60_000): void {
    for (const [host, s] of this.stats) {
      if (s.lastRateLimitAt && s.lastRateLimitAt < before && s.samples < 5) this.stats.delete(host)
    }
  }

  /** Refreshes rateLimited flags based on cooldown. */
  tick(): void {
    const now = Date.now()
    for (const s of this.stats.values()) {
      if (s.rateLimited && s.lastRateLimitAt && now - s.lastRateLimitAt > this.rateLimitCooldownMs) {
        s.rateLimited = false
      }
    }
  }

  private ensure(host: string): HostStats {
    let s = this.stats.get(host)
    if (!s) {
      s = {
        host,
        averageLatency: 0,
        throughput: 0,
        failures: 0,
        rateLimited: false,
        lastRateLimitAt: null,
        connectionResets: 0,
        samples: 0,
        successCount: 0,
      }
      this.stats.set(host, s)
    }
    return s
  }
}

export const globalHostHealth = new HostHealthTracker()
