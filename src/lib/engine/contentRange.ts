/**
 * Content-Range parsing and validation (plan P0-01 / P0-03).
 *
 *   206  Content-Range: bytes 1000-1999/5000     (total may be "*")
 *   416  Content-Range: bytes * /5000             (unsatisfied range, no spaces)
 */

import { RangeMismatchError, ResourceChangedError } from './errors'

export interface ContentRange {
  start: number
  /** Inclusive. */
  end: number
  total: number | null
}

const SATISFIED = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i
const UNSATISFIED = /^bytes\s+\*\/(\d+)$/i

export function parseContentRange(value: string): ContentRange {
  const match = SATISFIED.exec(value.trim())
  if (!match) throw new RangeMismatchError(`Invalid Content-Range header: "${value.slice(0, 60)}"`)
  const start = Number(match[1])
  const end = Number(match[2])
  const total = match[3] === '*' ? null : Number(match[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    throw new RangeMismatchError(`Invalid Content-Range bounds: "${value.slice(0, 60)}"`)
  }
  if (total != null && (!Number.isSafeInteger(total) || end >= total)) {
    throw new RangeMismatchError(`Content-Range ends past the resource size: "${value.slice(0, 60)}"`)
  }
  return { start, end, total }
}

/** Total size from a 416's `bytes * /<total>`; null when absent/unreadable. */
export function parseUnsatisfiedTotal(value: string | null): number | null {
  if (!value) return null
  const match = UNSATISFIED.exec(value.trim())
  if (!match) return null
  const total = Number(match[1])
  return Number.isSafeInteger(total) ? total : null
}

/**
 * Validates a 206 against what we asked for.
 *
 *  - it must start exactly where we asked (anything else would land bytes at
 *    the wrong offsets),
 *  - it must not run past the requested end,
 *  - its total must agree with the size we already know — a different total
 *    means the resource changed underneath us.
 *
 * A range that ends *before* the requested end is allowed: the caller only
 * credits the bytes Content-Range explicitly covers and re-requests the rest.
 */
export function validateRangeResponse(
  requestedStart: number,
  requestedEnd: number | null,
  range: ContentRange,
  expectedTotal: number | null,
): void {
  if (expectedTotal != null && range.total != null && range.total !== expectedTotal) {
    throw new ResourceChangedError(`Remote size changed from ${expectedTotal} to ${range.total} bytes`)
  }
  if (range.start !== requestedStart) {
    throw new RangeMismatchError(`Expected a range starting at byte ${requestedStart}, received ${range.start}`)
  }
  if (requestedEnd != null && range.end > requestedEnd) {
    throw new RangeMismatchError(`Server returned bytes ${range.start}-${range.end}, outside the requested ${requestedStart}-${requestedEnd}`)
  }
}
