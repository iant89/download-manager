/**
 * Retry classification (plan P1-11 / P1-12).
 *
 * Instead of a yes/no "is this fatal?", every failure is mapped to a
 * decision the worker loop can act on directly.
 */

import { HttpError, isAbort, isLikelyCorsError } from '../http'
import { ChecksumMismatchError, CheckpointError, DownloadIntegrityError, MemoryLimitError, ResourceChangedError } from './errors'

export type RetryDecision =
  | { type: 'retry'; delayMs: number; reason: string }
  | { type: 'fallback'; reason: string }
  | { type: 'fatal'; reason: string }
  | { type: 'resource-changed'; reason: string }
  | { type: 'aborted' }

/** Upper bound for honouring a server's Retry-After, so a typo can't park us for a day. */
export const MAX_RETRY_AFTER_MS = 5 * 60_000
const MAX_BACKOFF_MS = 20_000

export interface RetryContext {
  /** 1-based number of the attempt that just failed. */
  attempt: number
  maxRetries: number
  /** True when a plain-GET fallback is still available (CORS preflight rejected Range). */
  canFallBack?: boolean
  /** Deterministic jitter in tests. */
  random?: () => number
  now?: () => number
}

export function classifyFailure(error: unknown, ctx: RetryContext): RetryDecision {
  if (isAbort(error)) return { type: 'aborted' }

  if (error instanceof ResourceChangedError) return { type: 'resource-changed', reason: error.message }
  if (error instanceof MemoryLimitError || error instanceof CheckpointError || error instanceof ChecksumMismatchError) {
    return { type: 'fatal', reason: error.message }
  }

  if (ctx.canFallBack && isLikelyCorsError(error)) return { type: 'fallback', reason: 'Ranged request blocked (likely CORS preflight)' }

  const exhausted = ctx.attempt > ctx.maxRetries
  const message = error instanceof Error ? error.message : String(error)

  if (error instanceof HttpError) {
    const { status } = error
    const retryable = status === 408 || status === 425 || status === 429 || status >= 500
    if (!retryable) return { type: 'fatal', reason: message }
    if (exhausted) return { type: 'fatal', reason: message }
    if (error.retryAfterMs != null) {
      return { type: 'retry', delayMs: Math.min(MAX_RETRY_AFTER_MS, Math.max(0, error.retryAfterMs)), reason: `${status}, server asked to wait` }
    }
    return { type: 'retry', delayMs: backoffFor(ctx.attempt, ctx.random), reason: `HTTP ${status}` }
  }

  // Short bodies, bogus ranges from a flaky intermediary, dropped sockets:
  // re-requesting the unwritten remainder is safe, so these are retryable.
  if (error instanceof DownloadIntegrityError) {
    return exhausted ? { type: 'fatal', reason: message } : { type: 'retry', delayMs: backoffFor(ctx.attempt, ctx.random), reason: message }
  }

  return exhausted ? { type: 'fatal', reason: message } : { type: 'retry', delayMs: backoffFor(ctx.attempt, ctx.random), reason: message || 'network error' }
}

export function backoffFor(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 400 * 2 ** Math.max(0, attempt - 1))
  return base + random() * 250
}

/**
 * `Retry-After` is either delta-seconds ("30") or an HTTP-date. Returns the
 * delay in milliseconds, or null when absent/unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}
