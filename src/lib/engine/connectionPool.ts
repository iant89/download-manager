/**
 * Connection accounting across *all* downloads (plan P1-10).
 *
 * Every HTTP request a worker makes first acquires a slot. Three limits apply:
 *   - global:       total open connections across every download
 *   - per host:     connections to one origin host (servers throttle/ban beyond this)
 *   - per download: enforced by the runner itself (`connections` setting)
 *
 * Waiters are served FIFO, skipping ones whose host is still saturated so a
 * busy host can't starve downloads from other hosts.
 */

export interface PoolLimits {
  global: number
  perHost: number
}

export type Release = () => void

interface Waiter {
  host: string
  grant: (release: Release) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export class ConnectionPool {
  private limits: PoolLimits
  private total = 0
  private perHost = new Map<string, number>()
  private waiters: Waiter[] = []

  constructor(limits: PoolLimits = { global: 64, perHost: 16 }) {
    this.limits = { ...limits }
  }

  setLimits(limits: Partial<PoolLimits>): void {
    this.limits = { ...this.limits, ...limits }
    this.dispatch()
  }

  getLimits(): PoolLimits {
    return { ...this.limits }
  }

  stats(): { total: number; perHost: Record<string, number>; waiting: number } {
    return { total: this.total, perHost: Object.fromEntries(this.perHost), waiting: this.waiters.length }
  }

  /** Resolves with a release function once a slot for `host` is free. */
  acquire(host: string, signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    if (this.waiters.length === 0 && this.hasRoom(host)) return Promise.resolve(this.take(host))
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { host, grant: resolve, reject, signal }
      if (signal) {
        waiter.onAbort = () => {
          this.waiters = this.waiters.filter((w) => w !== waiter)
          reject(abortError(signal))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
      this.dispatch()
    })
  }

  private hasRoom(host: string): boolean {
    return this.total < Math.max(1, this.limits.global) && (this.perHost.get(host) ?? 0) < Math.max(1, this.limits.perHost)
  }

  private take(host: string): Release {
    this.total += 1
    this.perHost.set(host, (this.perHost.get(host) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.total -= 1
      const next = (this.perHost.get(host) ?? 1) - 1
      if (next <= 0) this.perHost.delete(host)
      else this.perHost.set(host, next)
      this.dispatch()
    }
  }

  private dispatch(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const waiter = this.waiters[i]!
      if (!this.hasRoom(waiter.host)) {
        i += 1
        continue
      }
      this.waiters.splice(i, 1)
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.grant(this.take(waiter.host))
    }
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error && /abort/i.test(reason.name + reason.message)) return reason
  const error = new Error(reason instanceof Error ? `aborted: ${reason.message}` : 'aborted')
  error.name = 'AbortError'
  return error
}
