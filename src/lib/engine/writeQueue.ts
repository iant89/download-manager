import type { Sink } from './sinks/types'

/**
 * Serializes random-access writes coming from N parallel connections into a
 * single sink, and applies backpressure: connections stop reading from the
 * network once more than `highWater` bytes are waiting to be flushed.
 */
export class WriteQueue {
  private queue: PendingWrite[] = []
  private pendingBytes = 0
  private looping = false
  private stopped = false
  private drainWaiters: (() => void)[] = []
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
    void this.pump()
  }

  /** Resolves once fewer than `lowWater` bytes are outstanding. */
  async drain(): Promise<void> {
    if (this.error) throw this.error
    if (this.pendingBytes === 0 && this.queue.length === 0) return
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

  async stop(): Promise<void> {
    this.stopped = true
    // Flush whatever is still queued so a pause never loses acknowledged bytes.
    await this.flushAll()
    this.releaseWaiters()
  }

  private async pump(): Promise<void> {
    if (this.looping) return
    this.looping = true
    try {
      while (this.queue.length > 0 && !this.stopped) {
        const item = this.queue.shift()!
        try {
          await this.sink.write(item.offset, item.chunk)
        } catch (error) {
          this.error = error instanceof Error ? error : new Error(String(error))
          this.releaseWaiters()
          return
        }
        this.pendingBytes -= item.chunk.byteLength
        if (this.pendingBytes <= this.lowWater) this.releaseWaiters()
      }
    } finally {
      this.looping = false
    }
  }

  private async flushAll(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!
      try {
        await this.sink.write(item.offset, item.chunk)
      } catch {
        /* best effort on shutdown */
      }
      this.pendingBytes -= item.chunk.byteLength
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
