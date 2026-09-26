import type { SaveMode } from '../../../types'
import { ensureWritePermission, type FsaFileHandle, type FsaWritable } from './fsa'
import type { Sink, SinkContext, SinkResult } from './types'

/**
 * Writes straight into a file the user picked with `showSaveFilePicker()`
 * (or a file inside a picked directory). Bytes are `seek()`+`write()`n as they
 * arrive, so multi-gigabyte downloads never touch the JS heap, and a paused
 * download can be resumed by re-opening the same handle.
 */
export class FsaSink implements Sink {
  readonly mode: SaveMode = 'fsa'
  readonly resumable = true

  private writable: FsaWritable | null = null
  private cursor = -1
  private failed: Error | null = null

  constructor(
    private handle: FsaFileHandle,
    private ctx: SinkContext,
  ) {}

  static async open(handle: FsaFileHandle, ctx: SinkContext): Promise<FsaSink> {
    const granted = await ensureWritePermission(handle)
    if (!granted) throw new Error(`Write permission denied for "${handle.name}"`)
    return new FsaSink(handle, ctx)
  }

  get filename(): string {
    return this.handle.name
  }

  private async ensure(): Promise<FsaWritable> {
    if (this.failed) throw this.failed
    if (!this.writable) {
      this.writable = await this.handle.createWritable({ keepExistingData: this.ctx.resumeFrom > 0 })
      this.cursor = -1
    }
    return this.writable
  }

  async write(offset: number, chunk: Uint8Array): Promise<void> {
    const writable = await this.ensure()
    try {
      if (offset !== this.cursor) {
        await writable.write({ type: 'seek', position: offset })
        this.cursor = offset
      }
      await writable.write(toArrayBuffer(chunk))
      this.cursor = offset + chunk.byteLength
    } catch (error) {
      this.failed = error instanceof Error ? error : new Error(String(error))
      throw error
    }
  }

  async finish(size: number): Promise<SinkResult> {
    const writable = await this.ensure()
    try {
      if (this.ctx.totalBytes != null && size > 0) {
        await writable.write({ type: 'truncate', size })
      }
    } catch {
      // Truncation is a nicety; some implementations reject it mid-stream.
    }
    await writable.close()
    this.writable = null
    return { filename: this.handle.name, size }
  }

  async abort(reason?: string): Promise<void> {
    if (!this.writable) return
    try {
      await this.writable.abort(reason)
    } catch {
      await this.writable.close().catch(() => undefined)
    }
    this.writable = null
    this.cursor = -1
  }

  /** Called when the user pauses: flush what we have but keep the file. */
  async checkpoint(): Promise<void> {
    if (!this.writable) return
    await this.writable.close()
    this.writable = null
    this.cursor = -1
  }
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  if (view.buffer instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === view.buffer.byteLength) return view.buffer
  return view.slice().buffer as ArrayBuffer
}
