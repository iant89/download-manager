import type { SaveMode } from '../../../types'

export interface SinkResult {
  /** Object URL for the in-memory fallback. */
  url?: string
  filename: string
  size: number
  /** Present when a checksum was requested; `verified` is false if the sink could not compute it. */
  checksum?: { algorithm: 'sha-256'; value: string | null; verified: boolean }
}

/**
 * A sink receives downloaded bytes at absolute file offsets, sequentially, out
 * of order, and repeatedly (after a resume). Implementations must therefore
 * support random-access writes.
 *
 * Capability flags:
 *  - `resumable`: accepts writes at arbitrary offsets after an in-session pause.
 *  - `durable`:   bytes survive a page reload / crash once `checkpoint()` has
 *                 resolved, so a persisted checkpoint may reference them.
 *
 *                 resumable  durable
 *    FsaSink        yes        yes     (the file on disk)
 *    MemorySink     yes        no      (JS heap, lost on reload)
 *    StreamSink     no         no      (browser download pipe, can't seek)
 */
export interface Sink {
  readonly mode: SaveMode
  readonly resumable: boolean
  readonly durable: boolean
  write(offset: number, chunk: Uint8Array): Promise<void>
  /**
   * Commits the file. Must verify the sink's own invariants (expected size,
   * no gaps) and the requested checksum before reporting success.
   */
  finish(size: number, filename: string): Promise<SinkResult>
  abort(reason?: string): Promise<void>
  /** Makes every acknowledged write durable. Only meaningful when `durable`. */
  checkpoint?(): Promise<void>
}

export interface SinkContext {
  id: string
  filename: string
  mime: string
  totalBytes: number | null
  /** Durable bytes already in the target from a previous session (0 for a fresh download). */
  resumeFrom: number
  /** Expected SHA-256 (lowercase hex) to verify while finishing. */
  checksum?: string | null
  /** Hard cap for in-memory buffering, in bytes. */
  memoryLimit?: number
}
