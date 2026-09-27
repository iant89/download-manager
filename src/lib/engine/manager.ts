/**
 * Owns every `TaskRunner` and the shared resources they compete for:
 *
 *   DownloadManager
 *     ├─ DownloadScheduler   which downloads run (queue, priority, concurrency)
 *     ├─ ConnectionPool      how many connections (global / per host)
 *     ├─ RateLimiter         global speed cap
 *     ├─ CheckpointStore     durable resume state
 *     └─ TaskRunner × N      the downloads themselves
 *
 * The store *requests* actions here; status changes flow back exclusively as
 * runner events (plan P1-02).
 */

import type { DownloadDiagnostics, DownloadStatus, DownloadTask, ResourceIdentity, SaveMode, SegmentState, Settings } from '../../types'
import { RUNNING_STATUSES } from '../../types'
import type { DownloadCheckpoint } from './checkpoint'
import { checkpointStore as defaultCheckpointStore, type CheckpointStore } from './checkpointStore'
import { ConnectionPool } from './connectionPool'
import { handleStore } from './handleStore'
import { RateLimiter } from './rateLimiter'
import { DownloadScheduler } from './scheduler'
import { createSink } from './sinkFactory'
import { abortStream } from './sinks/swBridge'
import type { Sink, SinkContext, SinkResult } from './sinks/types'
import { TaskRunner } from './taskRunner'
import type { HttpTransport } from './transport'
import { globalHostHealth } from './hostHealth'

export type ManagerEvent =
  | { type: 'meta'; id: string; totalBytes: number | null; filename: string | null; mime: string | null; supportsRanges: boolean; identity: ResourceIdentity }
  | { type: 'segments'; id: string; segments: SegmentState[] }
  | { type: 'status'; id: string; status: DownloadStatus; error?: string | null; awaitingTarget?: boolean }
  | { type: 'progress'; id: string; receivedBytes: number }
  | { type: 'saveMode'; id: string; mode: SaveMode }
  | { type: 'stats'; id: string; diagnostics: DownloadDiagnostics }
  | { type: 'complete'; id: string; filename: string; url?: string; size: number; saveMode: SaveMode; checksum?: SinkResult['checksum'] }

export interface ManagerHost {
  getSettings(): Settings
  getTask(id: string): DownloadTask | undefined
  emit(event: ManagerEvent): void
}

export interface ManagerOptions {
  checkpointStore?: CheckpointStore
  transport?: HttpTransport
  /** Override sink creation (tests). */
  sinkFactory?: (task: DownloadTask, ctx: SinkContext) => Promise<Sink>
}

export class DownloadManager {
  private runners = new Map<string, TaskRunner>()
  private globalLimiter = new RateLimiter(0)
  readonly scheduler = new DownloadScheduler()
  readonly pool = new ConnectionPool()
  readonly checkpoints: CheckpointStore
  readonly hostHealth = globalHostHealth

  constructor(
    private host: ManagerHost,
    private options: ManagerOptions = {},
  ) {
    this.checkpoints = options.checkpointStore ?? defaultCheckpointStore
    this.applySettings(host.getSettings())
  }

  /** Pushes limit-related settings into the scheduler, pool and limiter. */
  applySettings(settings: Settings): void {
    this.globalLimiter.setRate(settings.globalSpeedLimit)
    this.scheduler.setLimits({ maxConcurrent: Math.max(1, settings.maxConcurrentDownloads) })
    this.pool.setLimits({
      global: Math.max(1, settings.maxTotalConnections ?? 48),
      perHost: Math.max(1, settings.maxConnectionsPerHost ?? 16),
    })
    this.pump()
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

  getRunner(id: string): TaskRunner | undefined {
    return this.runners.get(id)
  }

  createRunner(task: DownloadTask, checkpoint: DownloadCheckpoint | null = null): TaskRunner {
    const settings = this.host.getSettings()
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
        checksum: task.expectedChecksum,
        memoryLimit: Math.max(1, settings.memoryLimitMB ?? 512) * 1024 * 1024,
      },
      {
        globalLimiter: this.globalLimiter,
        connectionPool: this.pool,
        checkpointStore: this.checkpoints,
        transport: this.options.transport,
        sinkFactory: (ctx) => (this.options.sinkFactory ? this.options.sinkFactory(task, ctx) : this.buildSink(task, ctx)),
        callbacks: {
          onMeta: (meta) => this.host.emit({ type: 'meta', id: task.id, ...meta }),
          onSegments: (segments) => this.host.emit({ type: 'segments', id: task.id, segments }),
          onStatus: (status, error, awaitingTarget) => {
            // Engine-reported status is the only authority for slot accounting.
            if (!RUNNING_STATUSES.includes(status) && this.scheduler.isActive(task.id)) {
              this.scheduler.completed(task.id)
              queueMicrotask(() => this.pump())
            }
            this.host.emit({ type: 'status', id: task.id, status, error: error ?? null, awaitingTarget })
          },
          onProgress: (receivedBytes) => this.host.emit({ type: 'progress', id: task.id, receivedBytes }),
          onSaveMode: (mode) => this.host.emit({ type: 'saveMode', id: task.id, mode }),
          onStats: (diagnostics) => this.host.emit({ type: 'stats', id: task.id, diagnostics }),
          onComplete: (result) =>
            this.host.emit({
              type: 'complete',
              id: task.id,
              filename: result.filename,
              url: result.url,
              size: result.size,
              saveMode: result.saveMode,
              checksum: result.checksum,
            }),
        },
      },
      { checkpoint, totalBytes: checkpoint?.resource.totalBytes ?? task.totalBytes },
    )
    this.runners.set(task.id, runner)
    return runner
  }

  private async buildSink(task: DownloadTask, ctx: SinkContext): Promise<Sink> {
    const settings = this.host.getSettings()
    const handle = task.handleKey ? await handleStore.getFile(task.id) : null
    return createSink({ ...ctx, preferred: settings.saveMode, handle })
  }

  // --------------------------------------------------------------- queueing

  /** Queues a download; the scheduler starts it when a slot is free. */
  enqueue(id: string): void {
    const task = this.host.getTask(id)
    if (!this.runners.has(id)) return
    this.scheduler.enqueue(id, { priority: task?.priority ?? 0, sequence: task?.queuedAt })
    this.pump()
  }

  setPriority(id: string, priority: number): void {
    this.scheduler.setPriority(id, priority)
    this.pump()
  }

  /** Dispatches as many queued downloads as the limits allow. */
  pump(): void {
    for (const id of this.scheduler.pump()) {
      const runner = this.runners.get(id)
      if (!runner) {
        this.scheduler.completed(id)
        continue
      }
      void runner.start().finally(() => {
        // A runner that declined to start (or finished without a final
        // status) must not keep holding a slot.
        if (!RUNNING_STATUSES.includes(runner.getStatus()) && this.scheduler.isActive(id)) {
          this.scheduler.completed(id)
          this.pump()
        }
      })
    }
  }

  // ---------------------------------------------------------------- actions

  async pause(id: string): Promise<void> {
    const runner = this.runners.get(id)
    this.scheduler.cancel(id)
    if (runner) await runner.pause()
    this.pump()
  }

  async cancel(id: string): Promise<void> {
    const runner = this.runners.get(id)
    this.scheduler.cancel(id)
    if (runner) {
      abortStream(id, 'canceled')
      await runner.cancel()
    }
    this.pump()
  }

  /** Resets the download to zero and queues it again. */
  async retry(id: string): Promise<void> {
    const runner = this.runners.get(id)
    if (!runner) return
    this.scheduler.cancel(id)
    await runner.reset()
    this.enqueue(id)
  }

  setSpeedLimit(id: string, bytesPerSecond: number): void {
    this.runners.get(id)?.setSpeedLimit(bytesPerSecond)
  }

  setConnections(id: string, connections: number): void {
    this.runners.get(id)?.setConnections(connections)
  }

  /** Forgets a runner (after cancel/remove, or to replace it). */
  destroy(id: string): void {
    const runner = this.runners.get(id)
    this.runners.delete(id)
    this.scheduler.cancel(id)
    void runner?.dispose()
    this.pump()
  }

  activeCount(): number {
    return this.scheduler.activeCount()
  }

  isActive(id: string): boolean {
    return this.scheduler.isActive(id)
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runners.keys()].map((id) => this.pause(id)))
  }
}
