/**
 * Durable resume state (plan P0-04, P0-06, P3-06, P3-07).
 *
 * A checkpoint is the *only* thing a resume may trust. It records which
 * representation of the resource the partial data came from, and exactly which
 * byte ranges have been written to the sink — per segment, because segmented
 * progress is not a contiguous prefix.
 *
 * Invariant: every byte counted as received in a checkpoint was acknowledged by
 * the sink and made durable (`sink.checkpoint()`) before the checkpoint was
 * saved.
 */

import type { ResourceIdentity, SaveMode, SegmentState, SegmentStatus } from '../../types'
import { CheckpointError, CheckpointVersionError, ResourceChangedError } from './errors'

export const CHECKPOINT_VERSION = 1

export type { ResourceIdentity }

export const EMPTY_IDENTITY: ResourceIdentity = { etag: null, lastModified: null, totalBytes: null, contentType: null }

export interface SegmentCheckpoint {
  index: number
  start: number
  /** Inclusive; always finite in a checkpoint (unknown-size downloads can't resume). */
  end: number
  /** Durable bytes from `start` (a contiguous prefix of the segment). */
  received: number
  status: 'complete' | 'partial' | 'pending'
  attempts: number
}

export interface DownloadCheckpoint {
  version: typeof CHECKPOINT_VERSION
  id: string
  url: string
  resource: ResourceIdentity
  saveMode: SaveMode
  supportsRanges: boolean
  bytesWritten: number
  segments: SegmentCheckpoint[]
  savedAt: number
}

// ---------------------------------------------------------------------------
// conversions
// ---------------------------------------------------------------------------

export function toSegmentCheckpoint(s: SegmentState): SegmentCheckpoint {
  const length = s.end - s.start + 1
  const received = Math.max(0, Math.min(length, s.received))
  return {
    index: s.index,
    start: s.start,
    end: s.end,
    received,
    status: received >= length ? 'complete' : received > 0 ? 'partial' : 'pending',
    attempts: s.attempts,
  }
}

export function fromSegmentCheckpoint(s: SegmentCheckpoint): SegmentState {
  const status: SegmentStatus = s.status === 'complete' ? 'done' : 'idle'
  return { index: s.index, start: s.start, end: s.end, received: s.received, status, attempts: 0, speed: 0 }
}

// ---------------------------------------------------------------------------
// validation / migration
// ---------------------------------------------------------------------------

/**
 * Structural invariants: segments tile [0, total) with no gaps or overlaps,
 * every `received` fits its segment, and `bytesWritten` is their sum.
 */
export function validateCheckpoint(cp: DownloadCheckpoint): void {
  const total = cp.resource.totalBytes
  if (total == null || !Number.isSafeInteger(total) || total <= 0) {
    throw new CheckpointError('Checkpoint has no known resource size')
  }
  if (!Array.isArray(cp.segments) || cp.segments.length === 0) throw new CheckpointError('Checkpoint has no segments')
  const segments = [...cp.segments].sort((a, b) => a.start - b.start)
  let expectedStart = 0
  let sum = 0
  for (const seg of segments) {
    if (![seg.start, seg.end, seg.received].every(Number.isSafeInteger)) throw new CheckpointError('Checkpoint segment has non-integer bounds')
    if (seg.start !== expectedStart) {
      throw new CheckpointError(seg.start > expectedStart ? `Gap before byte ${seg.start}` : `Overlap at byte ${seg.start}`)
    }
    if (seg.end < seg.start) throw new CheckpointError(`Segment ${seg.index} ends before it starts`)
    const length = seg.end - seg.start + 1
    if (seg.received < 0 || seg.received > length) throw new CheckpointError(`Segment ${seg.index} claims ${seg.received} of ${length} bytes`)
    if ((seg.status === 'complete') !== (seg.received === length)) throw new CheckpointError(`Segment ${seg.index} status disagrees with its progress`)
    sum += seg.received
    expectedStart = seg.end + 1
  }
  if (expectedStart !== total) throw new CheckpointError(`Segments cover ${expectedStart} of ${total} bytes`)
  if (sum !== cp.bytesWritten) throw new CheckpointError(`bytesWritten (${cp.bytesWritten}) disagrees with segments (${sum})`)
}

/** Upgrades any known persisted shape to the current version, then validates it. */
export function migrateCheckpoint(raw: unknown): DownloadCheckpoint {
  if (!raw || typeof raw !== 'object') throw new CheckpointError('Checkpoint is not an object')
  const version = (raw as { version?: unknown }).version
  let cp: DownloadCheckpoint
  switch (version) {
    case 1:
      cp = raw as DownloadCheckpoint
      break
    default:
      throw new CheckpointVersionError(version)
  }
  validateCheckpoint(cp)
  return cp
}

/**
 * Compares the identity the checkpoint was taken against with what the server
 * reports now. Only fields known on *both* sides are compared: servers that
 * never expose an ETag can't be caught by one.
 */
export function assertSameResource(saved: ResourceIdentity, current: Partial<ResourceIdentity>): void {
  if (saved.totalBytes != null && current.totalBytes != null && saved.totalBytes !== current.totalBytes) {
    throw new ResourceChangedError(`Remote size changed from ${saved.totalBytes} to ${current.totalBytes} bytes`)
  }
  if (saved.etag && current.etag && normalizeEtag(saved.etag) !== normalizeEtag(current.etag)) {
    throw new ResourceChangedError(`Remote file changed (ETag ${saved.etag} → ${current.etag})`)
  }
  if (saved.lastModified && current.lastModified && saved.lastModified !== current.lastModified) {
    throw new ResourceChangedError(`Remote file changed (Last-Modified ${saved.lastModified} → ${current.lastModified})`)
  }
}

/** Weak and strong forms of the same tag describe the same representation for our purposes. */
function normalizeEtag(tag: string): string {
  return tag.trim().replace(/^W\//i, '')
}

/**
 * Validator for `If-Range`. Only a *strong* ETag is allowed there; otherwise
 * fall back to Last-Modified (RFC 9110 §13.1.5).
 */
export function ifRangeValidator(identity: ResourceIdentity): string | null {
  if (identity.etag && !/^W\//i.test(identity.etag.trim())) return identity.etag.trim()
  if (identity.lastModified) return identity.lastModified
  return null
}
