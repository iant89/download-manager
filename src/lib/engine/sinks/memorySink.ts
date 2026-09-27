import type { SaveMode } from '../../../types'
import { ChecksumMismatchError, DownloadIntegrityError, MemoryLimitError } from '../errors'
import { Sha256 } from '../sha256'
import type { Sink, SinkContext, SinkResult } from './types'

/** Largest file we will buffer before warning the user. */
export const MEMORY_WARN_LIMIT = 256 * 1024 * 1024
/** Default hard cap (plan P2-03); configurable in Settings. */
export const DEFAULT_MEMORY_LIMIT = 512 * 1024 * 1024
/** Above this we never pre-allocate; chunk assembly handles arbitrary sizes. */
const PREALLOC_LIMIT = MEMORY_WARN_LIMIT

/**
 * Last-resort sink: buffers the file in memory and hands back a blob URL.
 * Used when neither the File System Access API nor a service worker stream is
 * available (or when the user explicitly asks for it).
 *
 * Unlike the warning threshold, `memoryLimit` is enforced: a write that would
 * push the file past it fails with `MemoryLimitError` instead of letting the
 * tab run out of memory.
 */
export class MemorySink implements Sink {
  readonly mode: SaveMode = 'memory'
  readonly resumable = true
  /** The heap does not survive a reload. */
  readonly durable = false

  private buffer: Uint8Array | null = null
  private chunks: { offset: number; data: Uint8Array }[] = []
  private url: string | null = null
  private extent = 0
  readonly limit: number

  constructor(private ctx: SinkContext) {
    this.limit = ctx.memoryLimit && ctx.memoryLimit > 0 ? ctx.memoryLimit : DEFAULT_MEMORY_LIMIT
    const total = ctx.totalBytes
    if (total != null && total > this.limit) throw new MemoryLimitError(this.limit)
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
    const end = offset + chunk.byteLength
    if (end > this.limit) throw new MemoryLimitError(this.limit)
    if (this.buffer) {
      if (end > this.buffer.byteLength) {
        throw new DownloadIntegrityError(`Write past the expected size (${end} > ${this.buffer.byteLength})`)
      }
      this.buffer.set(chunk, offset)
    } else {
      this.chunks.push({ offset, data: chunk.slice() })
    }
    this.extent = Math.max(this.extent, end)
  }

  async finish(size: number, filename: string): Promise<SinkResult> {
    const type = this.ctx.mime || 'application/octet-stream'
    let bytes: Uint8Array
    if (this.buffer) {
      bytes = this.buffer.subarray(0, size || this.buffer.byteLength)
    } else {
      bytes = assemble(this.chunks, size || this.extent)
    }
    if (size > 0 && bytes.byteLength !== size) {
      throw new DownloadIntegrityError(`Buffered ${bytes.byteLength} bytes, expected ${size}`)
    }

    let checksum: SinkResult['checksum']
    if (this.ctx.checksum) {
      const actual = await sha256(bytes)
      if (actual !== this.ctx.checksum) throw new ChecksumMismatchError('sha-256', this.ctx.checksum, actual)
      checksum = { algorithm: 'sha-256', value: actual, verified: true }
    }

    const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type })
    this.chunks = []
    this.buffer = null
    this.url = URL.createObjectURL(blob)
    return { url: this.url, filename, size: blob.size, checksum }
  }

  async abort(): Promise<void> {
    this.chunks = []
    this.buffer = null
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

/** Lays chunks out at their offsets; later writes win on overlap (retransmissions are identical). */
function assemble(chunks: { offset: number; data: Uint8Array }[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let covered = 0
  for (const c of [...chunks].sort((a, b) => a.offset - b.offset)) {
    if (c.offset > covered) throw new DownloadIntegrityError(`Gap in buffered data at byte ${covered}`)
    const end = Math.min(size, c.offset + c.data.byteLength)
    if (end > c.offset) out.set(c.data.subarray(0, end - c.offset), c.offset)
    covered = Math.max(covered, end)
  }
  if (covered < size) throw new DownloadIntegrityError(`Buffered data ends at byte ${covered} of ${size}`)
  return out
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  return new Sha256().update(bytes).digestHex()
}
