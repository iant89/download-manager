import type { Sink } from './sinks/types'

/**
 * Serializes random-access writes coming from N parallel connections into a
 * single sink, and applies backpressure: connections stop reading from the
 * network once more than `highWater` bytes are waiting to be flushed.
 *
 * Writes are *dispatched* in arrival order but never awaited inline: a sink
 * that blocks a chunk (the stream sink parks everything ahead of its cursor)
 * must not stop later, in-order chunks from being handed over — otherwise one
 * fast connection parking its first block would deadlock the whole download.
 * Backpressure is preserved because `pendingBytes` only decreases once a write
 * has actually completed.
 */
export class WriteQueue {
  private queue: PendingWrite[] = []
  private pendingBytes = 0
  private inflight = 0
  private looping = false
  private stopped = false
  private drainWaiters: (() => void)[] = []
  private settleWaiters: (() => void)[] = []
  private error: Error | null = null

  constructor(
    private sink: Sink,
    private lowWater = 4 * 1024 * 1024,
  ) {}

  get pending(): number {
    return this.pendingBytes
  }

  /**
   * Queues a write. The returned promise settles once the sink has
   * acknowledged (or rejected) the bytes; `onWritten` fires at the same moment.
   * The runner uses this to advance its *written* watermark, which is distinct
   * from how much has been read off the network (plan P0-08).
   *
   * Returns null when the queue is stopped and the write was dropped.
   */
  submit(offset: number, chunk: Uint8Array, onWritten?: (offset: number, length: number) => void): Promise<void> | null {
    if (this.stopped) return null
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const done = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    // Callers that don't await must not trigger unhandled-rejection noise.
    done.catch(() => undefined)
    this.queue.push({ offset, chunk, onWritten, resolve, reject })
    this.pendingBytes += chunk.byteLength
    this.pump()
    return done
  }

  /**
   * Resolves once fewer than `lowWater` bytes are still unacknowledged, or as
   * soon as `signal` aborts (a pausing worker must never wait on writes that
   * can't complete, e.g. chunks parked in a stream sink).
   */
  async drain(signal?: AbortSignal): Promise<void> {
    if (this.error) throw this.error
    if (this.pendingBytes < this.lowWater || signal?.aborted) return
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        this.drainWaiters = this.drainWaiters.filter((w) => w !== wake)
        resolve()
      }
      const wake = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.drainWaiters.push(wake)
    })
    if (this.error) throw this.error
  }

  get pendingCount(): number {
    return this.queue.length
  }

  /** Re-arms the queue after a pause so writes are accepted again. */
  restart(): void {
    this.stopped = false
    this.error = null
  }

  /**
   * Stops accepting writes and waits for everything already queued to reach
   * the sink. Bounded: writes that are blocked behind data which will never
   * arrive (out-of-order chunks after the network was aborted) are cut loose
   * by the timeout instead of hanging a pause forever.
   */
  async stop(timeoutMs = 4000): Promise<boolean> {
    this.stopped = true
    this.pump()
    let drained = false
    const settled = new Promise<void>((resolve) => {
      if (this.queue.length === 0 && this.inflight === 0) resolve()
      else this.settleWaiters.push(resolve)
    }).then(() => {
      drained = true
    })
    await Promise.race([settled, sleep(timeoutMs)])
    this.releaseWaiters()
    return drained
  }

  /** The first write error, if any (writes after it are still dispatched). */
  get failure(): Error | null {
    return this.error
  }

  private pump(): void {
    if (this.looping) return
    this.looping = true
    try {
      // Dispatch everything currently queued. Writes run concurrently from the
      // queue's point of view; sinks that care about ordering serialize
      // internally (see StreamSink / FsaSink).
      while (this.queue.length > 0) {
        const item = this.queue.shift()!
        this.inflight += 1
        this.sink.write(item.offset, item.chunk).then(
          () => {
            try {
              item.onWritten?.(item.offset, item.chunk.byteLength)
            } finally {
              this.settleWrite(item)
              item.resolve()
            }
          },
          (error) => {
            this.settleWrite(item)
            item.reject(error)
            if (!this.error) {
              this.error = error instanceof Error ? error : new Error(String(error))
              this.releaseWaiters()
            }
          },
        )
      }
    } finally {
      this.looping = false
    }
    // More data may have been submitted while we were dispatching.
    if (this.queue.length > 0) this.pump()
  }

  private settleWrite(item: PendingWrite): void {
    this.inflight -= 1
    this.pendingBytes = Math.max(0, this.pendingBytes - item.chunk.byteLength)
    if (this.pendingBytes <= this.lowWater) this.releaseWaiters()
    if (this.inflight === 0 && this.queue.length === 0) {
      const waiters = this.settleWaiters
      this.settleWaiters = []
      for (const resolve of waiters) resolve()
    }
  }

  private releaseWaiters(): void {
    const waiters = this.drainWaiters
    this.drainWaiters = []
    for (const resolve of waiters) resolve()
  }
}

interface PendingWrite {
  offset: number
  chunk: Uint8Array
  onWritten?: (offset: number, length: number) => void
  resolve: () => void
  reject: (error: unknown) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
