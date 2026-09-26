/**
 * Owns every `TaskRunner`, enforces the global concurrency limit, applies the
 * global speed cap and translates runner callbacks into store-friendly events.
 */

import type { DownloadTask, DownloadStatus, SaveMode, SegmentState, Settings } from '../../types'
import { RateLimiter } from './rateLimiter'
import { handleStore } from './handleStore'
import { createSink } from './sinkFactory'
import { PickerCancelledError } from './sinks/fsa'
import { abortStream } from './sinks/swBridge'
import type { Sink } from './sinks/types'
import { TaskRunner } from './taskRunner'

export type ManagerEvent =
  | { type: 'meta'; id: string; totalBytes: number | null; filename: string | null; mime: string | null; supportsRanges: boolean }
  | { type: 'segments'; id: string; segments: SegmentState[] }
  | { type: 'status'; id: string; status: DownloadStatus; error?: string | null; awaitingTarget?: boolean }
  | { type: 'progress'; id: string; receivedBytes: number }
  | { type: 'saveMode'; id: string; mode: SaveMode }
  | { type: 'complete'; id: string; filename: string; url?: string; size: number; saveMode: SaveMode }

export interface ManagerHost {
  getSettings(): Settings
  getTask(id: string): DownloadTask | undefined
  emit(event: ManagerEvent): void
}

const ACTIVE: DownloadStatus[] = ['probing', 'downloading', 'finalizing']

export class DownloadManager {
  private runners = new Map<string, TaskRunner>()
  private globalLimiter = new RateLimiter(0)
  private active = new Set<string>()

  constructor(private host: ManagerHost) {
    this.globalLimiter.setRate(host.getSettings().globalSpeedLimit)
  }

  getGlobalLimiter(): RateLimiter {
    return this.globalLimiter
  }

  setGlobalLimit(bytesPerSecond: number): void {
    this.globalLimiter.setRate(bytesPerSecond)
  }

  has(id: string): boolean {
    return this.runners.has(id)
  }

  createRunner(task: DownloadTask, resumeFrom = 0): TaskRunner {
    const runner = new TaskRunner(
      {
        id: task.id,
        url: task.effectiveUrl || task.url,
        filename: task.filename,
        connections: task.connections,
        speedLimit: task.speedLimit,
        maxRetries: task.maxRetries,
        auth: task.auth,
        headers: task.headers,
      },
      {
        globalLimiter: this.globalLimiter,
        sinkFactory: (ctx) => this.buildSink(task, ctx, resumeFrom),
        callbacks: {
          onMeta: (meta) =>
            this.host.emit({ type: 'meta', id: task.id, ...meta }),
          onSegments: (segments) => this.host.emit({ type: 'segments', id: task.id, segments }),
          onStatus: (status, error, awaitingTarget) => {
            if (!ACTIVE.includes(status)) this.active.delete(task.id)
            else this.active.add(task.id)
            this.host.emit({ type: 'status', id: task.id, status, error: error ?? null, awaitingTarget })
          },
          onProgress: (receivedBytes) => this.host.emit({ type: 'progress', id: task.id, receivedBytes }),
          onSaveMode: (mode) => this.host.emit({ type: 'saveMode', id: task.id, mode }),
          onComplete: (result) =>
            this.host.emit({
              type: 'complete',
              id: task.id,
              filename: result.filename,
              url: result.url,
              size: result.size,
              saveMode: result.saveMode,
            }),
        },
      },
      { resumeFrom, totalBytes: task.totalBytes },
    )
    this.runners.set(task.id, runner)
    return runner
  }

  private async buildSink(
    task: DownloadTask,
    ctx: { id: string; filename: string; mime: string; totalBytes: number | null; resumeFrom: number },
    resumeFrom: number,
  ): Promise<Sink> {
    const settings = this.host.getSettings()
    const handle = task.handleKey ? await handleStore.getFile(task.id) : null
    try {
      return await createSink({
        ...ctx,
        resumeFrom: resumeFrom || ctx.resumeFrom,
        preferred: settings.saveMode,
        handle,
      })
    } catch (error) {
      if (error instanceof PickerCancelledError) throw error
      throw error
    }
  }

  async start(id: string): Promise<void> {
    const runner = this.runners.get(id)
    if (!runner) return
    this.active.add(id)
    await runner.start()
  }

  async pause(id: string): Promise<void> {
    const runner = this.runners.get(id)
    if (!runner) return
    await runner.pause()
    this.active.delete(id)
  }

  async cancel(id: string): Promise<void> {
    const runner = this.runners.get(id)
    if (!runner) return
    abortStream(id, 'canceled')
    await runner.cancel()
    this.active.delete(id)
  }

  async retry(id: string): Promise<void> {
    const runner = this.runners.get(id)
    if (!runner) return
    await runner.retry()
  }

  setSpeedLimit(id: string, bytesPerSecond: number): void {
    this.runners.get(id)?.setSpeedLimit(bytesPerSecond)
  }

  setConnections(id: string, connections: number): void {
    this.runners.get(id)?.setConnections(connections)
  }

  destroy(id: string): void {
    this.runners.delete(id)
    this.active.delete(id)
  }

  activeCount(): number {
    return this.active.size
  }

  isActive(id: string): boolean {
    return this.active.has(id)
  }

  /** Starts queued downloads in list order until the concurrency cap is hit. */
  pump(order: string[]): void {
    const settings = this.host.getSettings()
    const limit = Math.max(1, settings.maxConcurrentDownloads)
    let running = this.active.size
    for (const id of order) {
      if (running >= limit) break
      const task = this.host.getTask(id)
      if (!task) continue
      if (task.status === 'queued' && !this.active.has(id)) {
        running += 1
        this.active.add(id)
        void this.start(id)
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runners.keys()].map((id) => this.pause(id)))
  }
}
