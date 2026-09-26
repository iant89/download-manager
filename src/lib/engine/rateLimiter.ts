/** Token-bucket rate limiter used for per-task and global speed caps. */

const MIN_BURST = 32 * 1024
const MAX_WAIT_MS = 250

export class RateLimiter {
  private rate: number
  private capacity: number
  private tokens: number
  private last: number

  constructor(bytesPerSecond: number) {
    this.rate = Math.max(0, bytesPerSecond)
    this.capacity = capacityFor(this.rate)
    this.tokens = this.capacity
    this.last = now()
  }

  /** 0 means "unlimited". */
  setRate(bytesPerSecond: number): void {
    this.refill()
    this.rate = Math.max(0, bytesPerSecond)
    this.capacity = capacityFor(this.rate)
    this.tokens = Math.min(this.tokens, this.capacity)
  }

  getRate(): number {
    return this.rate
  }

  /** Blocks until `bytes` tokens are available. */
  async take(bytes: number): Promise<void> {
    if (this.rate <= 0) return
    if (bytes > this.capacity) {
      // Chunk the wait so an oversized read still honours the cap.
      let remaining = bytes
      while (remaining > 0) {
        const slice = Math.min(remaining, this.capacity)
        await this.take(slice)
        remaining -= slice
      }
      return
    }
    for (;;) {
      this.refill()
      if (this.tokens >= bytes) {
        this.tokens -= bytes
        return
      }
      const deficit = bytes - this.tokens
      const waitMs = Math.min(MAX_WAIT_MS, (deficit / this.rate) * 1000)
      await sleep(Math.max(4, waitMs))
    }
  }

  private refill(): void {
    const t = now()
    const elapsed = (t - this.last) / 1000
    this.last = t
    if (this.rate <= 0) {
      this.tokens = this.capacity
      return
    }
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.rate)
  }
}

function capacityFor(rate: number): number {
  if (rate <= 0) return MIN_BURST
  // ~250 ms of burst, clamped to something sane.
  return Math.min(16 * 1024 * 1024, Math.max(MIN_BURST, rate * 0.25))
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
