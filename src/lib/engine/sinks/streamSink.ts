import type { SaveMode } from '../../../types'
import { registerStream, triggerStreamDownload } from './swBridge'
import type { Sink, SinkContext, SinkResult } from './types'

/**
 * Streams bytes to the browser's download shelf through the service worker.
 *
 * The pipe is strictly sequential, but multi-connection downloads arrive out of
 * order. This sink reorders: a chunk ahead of the write cursor is parked (its
 * `write()` promise stays open, which is what applies backpressure through the
 * WriteQueue) and a single serialized flush loop pushes chunks in cursor order
 * as gaps fill in. Crucially, parking a chunk never blocks *other* writes —
 * the flush loop is the only writer, so a fast connection racing ahead can
 * never wedge the pipeline.
 */
export class StreamSink implements Sink {
  readonly mode: SaveMode = 'stream'
  /** The pipe cannot be rewound, so a paused download restarts from zero. */
  readonly resumable = false

  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private closed = false
  private aborted = false
  private nextOffset = 0
  private parked = new Map<number, ParkedChunk>()
  private flushing = false
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
    if (this.aborted) throw new Error('Stream sink was aborted')
    if (this.closed) throw new Error('Stream sink is closed')
    if (offset + chunk.byteLength <= this.nextOffset) {
      // Entirely overlapping bytes (usually a retried range) — already on the wire.
      return
    }
    if (offset < this.nextOffset) {
      // Overlapping bytes (usually a retried range) — drop what we already have.
      chunk = chunk.subarray(this.nextOffset - offset)
      offset = this.nextOffset
    }

    // Park the chunk and resolve the promise only once it has been pushed, so
    // the WriteQueue keeps counting it as outstanding (natural backpressure).
    const parked = new Promise<void>((resolve, reject) => {
      const previous = this.parked.get(offset)
      if (previous) previous.reject(new Error('Superseded by a duplicate chunk'))
      this.parked.set(offset, { chunk, resolve, reject })
    })
    void this.flush()
    return parked
  }

  /** Serialized: pushes every chunk that is now at the cursor, in order. */
  private async flush(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      for (;;) {
        const next = this.parked.get(this.nextOffset)
        if (!next) break
        this.parked.delete(this.nextOffset)
        if (this.aborted) {
          next.reject(new Error('Stream sink was aborted'))
          continue
        }
        try {
          const writer = await this.writerFor()
          await writer.ready
          await writer.write(next.chunk)
          this.nextOffset += next.chunk.byteLength
          next.resolve()
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          next.reject(failure)
          // Nothing else can ever be pushed behind a broken pipe.
          this.failAll(failure)
          return
        }
      }
    } finally {
      this.flushing = false
    }
  }

  private failAll(error: Error): void {
    for (const parked of this.parked.values()) parked.reject(error)
    this.parked.clear()
  }

  async finish(size: number, filename: string): Promise<SinkResult> {
    this.filename = filename
    this.closed = true
    if (this.parked.size > 0) {
      const gap = new Error('Download finished with gaps in the stream')
      this.failAll(gap)
      throw gap
    }
    const writer = await this.writerFor()
    await writer.ready
    await writer.close()
    return { filename: this.filename, size }
  }

  async abort(reason = 'canceled'): Promise<void> {
    this.aborted = true
    this.closed = true
    this.failAll(new Error(reason))
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
