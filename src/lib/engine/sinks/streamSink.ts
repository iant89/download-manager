import type { SaveMode } from '../../../types'
import { isSwAlive, registerStream, triggerStreamDownload } from './swBridge'
import { ChecksumMismatchError, DownloadIntegrityError } from '../errors'
import { Sha256 } from '../sha256'
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
  /**
   * The pipe lives in a service worker the browser may terminate at any time.
   * Nothing about it survives a reload: a dead stream means FAILED, not PAUSED.
   */
  readonly durable = false

  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private closed = false
  private aborted = false
  private nextOffset = 0
  private parked = new Map<number, ParkedChunk>()
  private flushing = false
  private filename: string
  private expectedSize: number | null
  private expectedChecksum: string | null
  /** Bytes are pushed strictly in order, so they can be hashed on the fly. */
  private hasher: Sha256 | null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatFailures = 0

  constructor(
    ctx: SinkContext,
    private transform: TransformStream<Uint8Array, Uint8Array>,
  ) {
    this.filename = ctx.filename
    this.expectedSize = ctx.totalBytes
    this.expectedChecksum = ctx.checksum ?? null
    this.hasher = this.expectedChecksum ? new Sha256() : null
    this.startHeartbeat()
  }

  /** Bytes already pushed down the pipe, in order. */
  get written(): number {
    return this.nextOffset
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

  private startHeartbeat(): void {
    // P2-05: StreamSink is non-resumable (browser may terminate the worker).
    // Heartbeat pings the worker; after 3 consecutive failures we fail the
    // stream rather than leaving the UI in "downloading" forever.
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return
    this.heartbeatTimer = setInterval(async () => {
      if (this.closed || this.aborted) {
        this.stopHeartbeat()
        return
      }
      const alive = await isSwAlive().catch(() => false)
      if (!alive) {
        this.heartbeatFailures += 1
        if (this.heartbeatFailures >= 3) {
          const err = new DownloadIntegrityError('Service worker was terminated — stream download failed')
          this.failAll(err)
          this.stopHeartbeat()
        }
      } else {
        this.heartbeatFailures = 0
      }
    }, 8000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
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
      this.park(offset, { chunk, resolve, reject })
    })
    void this.flush()
    return parked
  }

  /**
   * Parks a chunk at `offset`. A duplicate at the same offset (a retransmission)
   * is merged rather than rejected: the longer chunk wins and every waiter is
   * resolved once it has been pushed.
   */
  private park(offset: number, entry: ParkedChunk): void {
    const previous = this.parked.get(offset)
    if (!previous) {
      this.parked.set(offset, entry)
      return
    }
    const keep = entry.chunk.byteLength > previous.chunk.byteLength ? entry.chunk : previous.chunk
    this.parked.set(offset, {
      chunk: keep,
      resolve: () => {
        previous.resolve()
        entry.resolve()
      },
      reject: (error) => {
        previous.reject(error)
        entry.reject(error)
      },
    })
  }

  /**
   * After the cursor advanced, chunks that started before it (retransmissions
   * with different boundaries) would never be "at the cursor" again: resolve
   * the fully-covered ones and re-park the tails of the partly-covered ones.
   */
  private reconcileBehindCursor(): void {
    for (const [offset, entry] of [...this.parked]) {
      if (offset >= this.nextOffset) continue
      this.parked.delete(offset)
      const end = offset + entry.chunk.byteLength
      if (end <= this.nextOffset) entry.resolve()
      else this.park(this.nextOffset, { ...entry, chunk: entry.chunk.subarray(this.nextOffset - offset) })
    }
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
          this.hasher?.update(next.chunk)
          this.nextOffset += next.chunk.byteLength
          next.resolve()
          this.reconcileBehindCursor()
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

  /**
   * Final invariants (plan P2-04): every byte up to the expected size has been
   * pushed, nothing is parked, and the checksum (if any) matches. On failure
   * the pipe is *aborted* rather than closed, so the browser marks the shelf
   * download as failed instead of saving a truncated or corrupt file.
   */
  async finish(size: number, filename: string): Promise<SinkResult> {
    this.filename = filename
    this.closed = true
    const expected = this.expectedSize ?? size
    let problem: Error | null = null
    if (this.parked.size > 0) problem = new DownloadIntegrityError('Download finished with gaps in the stream')
    else if (this.nextOffset !== expected) problem = new DownloadIntegrityError(`Stream finished at byte ${this.nextOffset}, expected ${expected}`)
    let checksum: SinkResult['checksum']
    if (!problem && this.hasher && this.expectedChecksum) {
      const actual = this.hasher.digestHex()
      if (actual !== this.expectedChecksum) problem = new ChecksumMismatchError('sha-256', this.expectedChecksum, actual)
      else checksum = { algorithm: 'sha-256', value: actual, verified: true }
    }
    if (problem) {
      this.failAll(problem)
      await this.abort(problem.message)
      throw problem
    }
    const writer = await this.writerFor()
    await writer.ready
    await writer.close()
    return { filename: this.filename, size, checksum }
  }

  async abort(reason = 'canceled'): Promise<void> {
    this.aborted = true
    this.closed = true
    this.stopHeartbeat()
    this.failAll(new Error(reason))
    try {
      const writer = await this.writerFor()
      await writer.abort(reason)
    } catch {
      /* already closed */
    }
  }

  /** Exposed for diagnostics: heartbeat state (plan P3-10). */
  get heartbeat(): { failures: number; active: boolean } {
    return { failures: this.heartbeatFailures, active: Boolean(this.heartbeatTimer) }
  }
}

interface ParkedChunk {
  chunk: Uint8Array
  resolve: () => void
  reject: (error: Error) => void
}
