import type { SaveMode } from '../../../types'
import type { Sink, SinkContext, SinkResult } from './types'

/** Largest file we will fully buffer before warning the user. */
export const MEMORY_WARN_LIMIT = 256 * 1024 * 1024
/** Above this we never pre-allocate; chunk assembly handles arbitrary sizes. */
const PREALLOC_LIMIT = MEMORY_WARN_LIMIT

/**
 * Last-resort sink: buffers the file in memory and hands back a blob URL.
 * Used when neither the File System Access API nor a service worker stream is
 * available (or when the user explicitly asks for it).
 */
export class MemorySink implements Sink {
  readonly mode: SaveMode = 'memory'
  readonly resumable = true

  private buffer: Uint8Array | null = null
  private chunks: { offset: number; data: Uint8Array }[] = []
  private url: string | null = null

  constructor(private ctx: SinkContext) {
    const total = ctx.totalBytes
    // Pre-allocating is both faster and simpler than assembling out-of-order
    // chunks later; only do it for sizes the heap can comfortably hold.
    if (total != null && total > 0 && total <= PREALLOC_LIMIT) {
      try {
        this.buffer = new Uint8Array(total)
      } catch {
        this.buffer = null
      }
    }
  }

  async write(offset: number, chunk: Uint8Array): Promise<void> {
    if (this.buffer) {
      this.buffer.set(chunk, offset)
      return
    }
    this.chunks.push({ offset, data: chunk.slice() })
  }

  async finish(size: number, filename: string): Promise<SinkResult> {
    let blob: Blob
    if (this.buffer) {
      blob = new Blob([this.buffer.subarray(0, size || this.buffer.byteLength) as Uint8Array<ArrayBuffer>], {
        type: this.ctx.mime || 'application/octet-stream',
      })
    } else {
      const ordered = [...this.chunks].sort((a, b) => a.offset - b.offset)
      blob = new Blob(
        ordered.map((c) => c.data as Uint8Array<ArrayBuffer>),
        { type: this.ctx.mime || 'application/octet-stream' },
      )
    }
    this.chunks = []
    this.buffer = null
    this.url = URL.createObjectURL(blob)
    return { url: this.url, filename, size: blob.size }
  }

  async abort(): Promise<void> {
    this.chunks = []
    if (this.url) {
      URL.revokeObjectURL(this.url)
      this.url = null
    }
  }

  /** Blob URLs leak until revoked — call once the browser has the file. */
  revoke(): void {
    if (this.url) {
      URL.revokeObjectURL(this.url)
      this.url = null
    }
  }
}
