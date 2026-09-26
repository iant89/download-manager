import type { SaveMode } from '../../../types'
import { registerStream, triggerStreamDownload } from './swBridge'
import type { Sink, SinkContext, SinkResult } from './types'

/**
 * Streams bytes to the browser's download shelf through the service worker.
 *
 * The pipe is strictly sequential, but multi-connection downloads arrive out of
 * order. This sink reorders: a chunk whose offset is ahead of the write cursor
 * is parked and its `write()` promise is only resolved once everything before
 * it has been flushed — which applies natural backpressure to the fastest
 * connection instead of buffering the whole file.
 */
export class StreamSink implements Sink {
  readonly mode: SaveMode = 'stream'
  /** The pipe cannot be rewound, so a paused download restarts from zero. */
  readonly resumable = false

  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private closed = false
  private nextOffset = 0
  private parked = new Map<number, ParkedChunk>()
  private filename: string

  constructor(
    ctx: SinkContext,
    private transform: TransformStream<Uint8Array, Uint8Array>,
  ) {
    this.filename = ctx.filename
  }

  static async open(ctx: SinkContext): Promise<StreamSink> {
    const transform = new TransformStream<Uint8Array, Uint8Array>(
      undefined,
      undefined,
      { highWaterMark: 4 },
    )
    const sink = new StreamSink(ctx, transform)
    const url = await registerStream({
      id: ctx.id,
      filename: ctx.filename,
      mime: ctx.mime || 'application/octet-stream',
      size: ctx.totalBytes,
      readable: transform.readable,
    })
    triggerStreamDownload(url)
    return sink
  }

  private async writerFor(): Promise<WritableStreamDefaultWriter<Uint8Array>> {
    if (!this.writer) this.writer = this.transform.writable.getWriter()
    return this.writer
  }

  async write(offset: number, chunk: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('Stream sink is closed')
    if (offset === this.nextOffset) {
      await this.push(chunk)
    } else if (offset < this.nextOffset) {
      // Overlapping bytes (usually a retried range) — drop what we already have.
      const skip = this.nextOffset - offset
      if (chunk.byteLength > skip) await this.push(chunk.subarray(skip))
    } else {
      await new Promise<void>((resolve, reject) => {
        this.parked.set(offset, { chunk, resolve, reject })
      })
    }
    await this.drainParked()
  }

  private async push(chunk: Uint8Array): Promise<void> {
    const writer = await this.writerFor()
    await writer.ready
    await writer.write(chunk)
    this.nextOffset += chunk.byteLength
  }

  private async drainParked(): Promise<void> {
    let next = this.parked.get(this.nextOffset)
    while (next) {
      this.parked.delete(this.nextOffset)
      try {
        await this.push(next.chunk)
        next.resolve()
      } catch (error) {
        next.reject(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
      next = this.parked.get(this.nextOffset)
    }
  }

  async finish(size: number, filename: string): Promise<SinkResult> {
    this.filename = filename
    this.closed = true
    if (this.parked.size > 0) {
      throw new Error('Download finished with gaps in the stream')
    }
    const writer = await this.writerFor()
    await writer.ready
    await writer.close()
    return { filename: this.filename, size }
  }

  async abort(reason = 'canceled'): Promise<void> {
    this.closed = true
    for (const parked of this.parked.values()) parked.reject(new Error(reason))
    this.parked.clear()
    try {
      const writer = await this.writerFor()
      await writer.abort(reason)
    } catch {
      /* already closed */
    }
  }
}

interface ParkedChunk {
  chunk: Uint8Array
  resolve: () => void
  reject: (error: Error) => void
}
