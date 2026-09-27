/**
 * Adaptive connection count (plan P3-01).
 *
 * Instead of always using `connections` in parallel, the engine learns:
 *   start = 2
 *   measure throughput
 *   if throughput improves significantly → grow (2→4→8→16)
 *   if server returns 429/503 or throughput regresses → shrink
 *
 * The controller is cheap to create per host and is fed by HostHealth and
 * per-segment throughput samples.
 */

export interface AdaptiveOptions {
  initial?: number
  min?: number
  max?: number
  growthFactor?: number
  improvementThreshold?: number // 0.1 = 10% improvement needed to keep growing
  decayFactor?: number
}

export class AdaptiveConnectionController {
  private current: number
  private readonly min: number
  private readonly max: number
  private readonly growthFactor: number
  private readonly improvementThreshold: number
  private readonly decayFactor: number
  private lastThroughput: number | null = null

  constructor(options: AdaptiveOptions = {}) {
    this.current = Math.max(1, Math.min(options.initial ?? 2, options.max ?? 16))
    this.min = Math.max(1, options.min ?? 1)
    this.max = Math.max(this.min, options.max ?? 16)
    this.growthFactor = options.growthFactor ?? 2
    this.improvementThreshold = options.improvementThreshold ?? 0.08
    this.decayFactor = options.decayFactor ?? 0.5
    this.current = Math.max(this.min, Math.min(this.max, this.current))
  }

  get connections(): number {
    return this.current
  }

  /**
   * Called when we have a throughput sample for the current connection count.
   * Returns the new recommended count (may be unchanged).
   */
  observe(throughputBytesPerSecond: number): number {
    if (!Number.isFinite(throughputBytesPerSecond) || throughputBytesPerSecond <= 0) return this.current
    if (this.lastThroughput == null) {
      this.lastThroughput = throughputBytesPerSecond
      return this.tryGrow()
    }
    const improved = throughputBytesPerSecond > this.lastThroughput * (1 + this.improvementThreshold)
    const regressed = throughputBytesPerSecond < this.lastThroughput * (1 - this.improvementThreshold)

    if (improved && this.current < this.max) {
      this.lastThroughput = throughputBytesPerSecond
      return this.tryGrow()
    }
    if (regressed && this.current > this.min) {
      this.lastThroughput = throughputBytesPerSecond
      this.current = Math.max(this.min, Math.floor(this.current * this.decayFactor) || this.min)
      return this.current
    }
    this.lastThroughput = throughputBytesPerSecond
    return this.current
  }

  /** Server signaled overload: immediately shrink. */
  onRateLimited(): number {
    this.current = Math.max(this.min, Math.floor(this.current * this.decayFactor) || this.min)
    if (this.current < 2) this.current = 1
    return this.current
  }

  onConnectionReset(): number {
    // Be conservative on resets; drop one level if more than one connection.
    if (this.current > 1) this.current = Math.max(this.min, this.current - 1)
    return this.current
  }

  /** Resets to initial after a failed/retry cycle. */
  reset(): void {
    this.lastThroughput = null
  }

  private tryGrow(): number {
    const next = Math.min(this.max, Math.floor(this.current * this.growthFactor) || this.current + 1)
    if (next !== this.current) this.current = next
    return this.current
  }
}
