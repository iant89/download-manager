import type { SaveMode } from '../../../types'

export interface SinkResult {
  /** Object URL for the in-memory fallback. */
  url?: string
  filename: string
  size: number
}

/**
 * A sink receives downloaded bytes at absolute file offsets, sequentially, out
 * of order, and repeatedly (after a resume). Implementations must therefore
 * support random-access writes.
 */
export interface Sink {
  readonly mode: SaveMode
  /** True when the sink can accept writes at arbitrary offsets after a pause. */
  readonly resumable: boolean
  write(offset: number, chunk: Uint8Array): Promise<void>
  finish(size: number, filename: string): Promise<SinkResult>
  abort(reason?: string): Promise<void>
}

export interface SinkContext {
  id: string
  filename: string
  mime: string
  totalBytes: number | null
  /** Bytes already on disk from a previous session (0 for a fresh download). */
  resumeFrom: number
}
