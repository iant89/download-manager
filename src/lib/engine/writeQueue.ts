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

  submit(offset: number, chunk: Uint8Array): void {
    if (this.stopped) return
    this.queue.push({ offset, chunk })
    this.pendingBytes += chunk.byteLength
    this.pump()
  }

  /** Resolves once fewer than `lowWater` bytes are still unacknowledged. */
  async drain(): Promise<void> {
    if (this.error) throw this.error
    if (this.pendingBytes < this.lowWater) return
    await new Promise<void>((resolve) => this.drainWaiters.push(resolve))
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
  async stop(timeoutMs = 4000): Promise<void> {
    this.stopped = true
    this.pump()
    const settled = new Promise<void>((resolve) => {
      if (this.queue.length === 0 && this.inflight === 0) resolve()
      else this.settleWaiters.push(resolve)
    })
    await Promise.race([settled, sleep(timeoutMs)])
    this.releaseWaiters()
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
          () => this.settleWrite(item),
          (error) => {
            this.settleWrite(item)
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
