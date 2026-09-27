/**
 * The heart of Flux: one `TaskRunner` per download.
 *
 * Responsibilities
 *  - probe the remote resource and lock in its identity (size/ETag/Last-Modified)
 *  - split it into N segments and fetch them in parallel with HTTP Range
 *  - validate every response (Content-Range, body length, identity)
 *  - honour per-task and global speed limits and the shared connection pool
 *  - classify failures and retry with backoff / Retry-After
 *  - pause (pausing → drain → checkpoint → paused) and resume per segment
 *  - verify coverage, then finalize through the `Sink` (incl. checksum)
 *
 * Byte accounting (plan P0-08). Three numbers exist per segment and must not
 * be confused:
 *   network offset  bytes read off the wire (transient, per request)
 *   received        bytes the sink has acknowledged — a contiguous prefix of
 *                   the segment; this is what progress and checkpoints use
 *   checkpointed    `received` at the last successful durable checkpoint
 */

import type { AuthConfig, DownloadDiagnostics, DownloadStatus, HeaderEntry, SaveMode, SegmentState } from '../../types'
import { buildRequestHeaders, HttpError, isAbort, isLikelyCorsError } from '../http'
import {
  assertSameResource,
  CHECKPOINT_VERSION,
  EMPTY_IDENTITY,
  fromSegmentCheckpoint,
  ifRangeValidator,
  toSegmentCheckpoint,
  type DownloadCheckpoint,
  type ResourceIdentity,
} from './checkpoint'
import type { CheckpointStore } from './checkpointStore'
import { hostOf, type ConnectionPool, type Release } from './connectionPool'
import { BodyLengthError, DownloadIntegrityError, RangeMismatchError, ResourceChangedError } from './errors'
import { engineEvent } from './events'
import { RateLimiter } from './rateLimiter'
import { classifyFailure } from './retryPolicy'
import type { Sink, SinkContext, SinkResult } from './sinks/types'
import { canTransition } from './stateMachine'
import { defaultTransport, type HttpTransport, type RangeResponse } from './transport'
import { WriteQueue } from './writeQueue'
import { AdaptiveConnectionController } from './adaptive'
import { globalHostHealth } from './hostHealth'
import type { HostHealthTracker } from './hostHealth'

export const MIN_SEGMENT_BYTES = 512 * 1024
/** Bytes a single connection buffers before handing them to the sink. */
const FLUSH_BYTES = 1024 * 1024
const MAX_PIPELINE_BYTES = 8 * 1024 * 1024

export interface TaskConfig {
  id: string
  url: string
  filename: string
  connections: number
  speedLimit: number
  maxRetries: number
  auth: AuthConfig
  headers: HeaderEntry[]
  /** Expected SHA-256 (lowercase hex), verified while finalizing. */
  checksum?: string | null
  /** Hard cap for in-memory downloads, passed through to the sink. */
  memoryLimit?: number
}

export interface RunnerMeta {
  totalBytes: number | null
  filename: string | null
  mime: string | null
  supportsRanges: boolean
  identity: ResourceIdentity
}

/** Diagnostics counters (plan P2-13 / P3-10). */
export type RunnerStats = DownloadDiagnostics

export interface RunnerCallbacks {
  onMeta(meta: RunnerMeta): void
  onSegments(segments: SegmentState[]): void
  onStatus(status: DownloadStatus, error?: string | null, awaitingTarget?: boolean): void
  onProgress(receivedBytes: number): void
  onSaveMode(mode: SaveMode): void
  onComplete(result: SinkResult & { saveMode: SaveMode }): void
  onStats?(stats: RunnerStats): void
}

export interface RunnerDeps {
  globalLimiter: RateLimiter
  sinkFactory(ctx: SinkContext): Promise<Sink>
  callbacks: RunnerCallbacks
  transport?: HttpTransport
  checkpointStore?: CheckpointStore
  connectionPool?: ConnectionPool
}

export interface RunnerInitial {
  /** Verified durable state from a previous session. */
  checkpoint?: DownloadCheckpoint | null
  totalBytes?: number | null
}

type Phase = 'idle' | 'running' | 'pausing' | 'paused' | 'stopped' | 'verifying' | 'finalizing' | 'done'
type Outcome = 'completed' | 'failed' | 'canceled' | null
type Gate = { promise: Promise<'segmented' | 'single'>; resolve: (v: 'segmented' | 'single') => void }

export class TaskRunner {
  readonly id: string

  private config: TaskConfig
  private deps: RunnerDeps
  private transport: HttpTransport
  private host: string
  private phase: Phase = 'idle'
  private outcome: Outcome = null
  private status: DownloadStatus = 'queued'

  private segments: SegmentState[] = []
  private totalBytes: number | null = null
  private filename: string
  private mime = 'application/octet-stream'
  private identity: ResourceIdentity = { ...EMPTY_IDENTITY }
  /** Once set, every later response must match `identity`. */
  private identityLocked = false
  private supportsRanges = false
  private segmented = false
  private usedRange = true
  private plainRetried = false
  private splitDone = false
  private ifRangeAllowed = true
  /** True once this download continues earlier progress (pause/resume or restore). */
  private resumed = false
  private restored = false
  private restoredMode: SaveMode | null = null

  private taskLimiter: RateLimiter
  private sink: Sink | null = null
  private writeQueue: WriteQueue | null = null
  private controllers = new Set<AbortController>()
  private workers = new Set<Promise<void>>()
  /** Aborted on pause/cancel/fail so backoff sleeps and pool waits wake up. */
  private runAbort = new AbortController()
  private resumeFrom: number
  /** Bumped whenever byte accounting is reset; stale write acks are ignored. */
  private generation = 0
  /** Acknowledged-but-not-yet-contiguous ranges per segment. */
  private writtenRanges = new Map<SegmentState, [number, number][]>()
  /**
   * Highest network offset reached per segment. Telemetry only: writes are
   * acknowledged in FLUSH_BYTES-sized blocks, so the written watermark moves
   * far too coarsely to drive the throughput graphs. This is never persisted.
   */
  private seenWatermarks = new Map<SegmentState, number>()

  private receivedBytes = 0
  private lastProgressEmit = 0
  private gate: Gate | null = null
  private firstResponseSeen = false
  private currentError: string | null = null
  private pausePromise: Promise<void> | null = null
  private finishing = false
  private stats: RunnerStats = {
    automaticRetryCount: 0,
    httpErrors: 0,
    rangeErrors: 0,
    integrityErrors: 0,
    unverifiedRanges: false,
    ifRange: false,
    lastCheckpointAt: null,
  }

  // P3-01 / P3-02: adaptive controller and host health tracking
  private adaptive: AdaptiveConnectionController
  private hostHealth: HostHealthTracker

  constructor(config: TaskConfig, deps: RunnerDeps, initial?: RunnerInitial) {
    this.id = config.id
    this.config = { ...config }
    this.deps = deps
    this.transport = deps.transport ?? defaultTransport
    this.host = hostOf(config.url)
    this.filename = config.filename
    this.totalBytes = initial?.totalBytes ?? null
    this.resumeFrom = 0
    this.taskLimiter = new RateLimiter(config.speedLimit)
    // P3-01: adaptive starts at 2 and grows toward requested max; tests keep
    // deterministic behaviour because small files use requested directly.
    this.adaptive = new AdaptiveConnectionController({
      initial: Math.min(2, this.config.connections),
      min: 1,
      max: this.config.connections,
    })
    this.hostHealth = globalHostHealth

    const cp = initial?.checkpoint
    if (cp) {
      // Resume from segments, not a single byte offset (plan P0-07).
      this.segments = cp.segments.map(fromSegmentCheckpoint).sort((a, b) => a.start - b.start)
      this.segments.forEach((s, i) => (s.index = i))
      this.totalBytes = cp.resource.totalBytes
      this.identity = { ...cp.resource }
      this.identityLocked = true
      this.supportsRanges = cp.supportsRanges
      this.segmented = this.segments.length > 1
      this.firstResponseSeen = true
      this.splitDone = true
      this.resumed = true
      this.restored = true
      this.restoredMode = cp.saveMode
      this.resumeFrom = cp.bytesWritten
      this.receivedBytes = this.sumReceived()
      this.stats.lastCheckpointAt = cp.savedAt
      this.status = 'paused'
      this.phase = 'paused'
    }
  }

  // ------------------------------------------------------------ inspection

  getStatus(): DownloadStatus {
    return this.status
  }

  getSnapshot(): {
    receivedBytes: number
    totalBytes: number | null
    segments: SegmentState[]
    error: string | null
    supportsRanges: boolean
    identity: ResourceIdentity
    stats: RunnerStats
  } {
    return {
      receivedBytes: this.receivedBytes,
      totalBytes: this.totalBytes,
      segments: this.getSegments(),
      error: this.currentError,
      supportsRanges: this.supportsRanges,
      identity: { ...this.identity },
      stats: { ...this.stats },
    }
  }

  getFilename(): string {
    return this.filename
  }

  getSaveMode(): SaveMode | null {
    return this.sink?.mode ?? null
  }

  setSpeedLimit(bytesPerSecond: number): void {
    this.config.speedLimit = bytesPerSecond
    this.taskLimiter.setRate(bytesPerSecond)
  }

  setConnections(connections: number): void {
    this.config.connections = Math.max(1, Math.min(32, connections))
  }

  /**
   * Snapshot of the durable resume state, or null when this download can't be
   * resumed across sessions (unknown size, open-ended segment, no ranges).
   * Only meaningful right after the sink has been checkpointed.
   */
  createCheckpoint(): DownloadCheckpoint | null {
    const saveMode = this.sink?.mode ?? this.restoredMode
    if (!saveMode || this.totalBytes == null || this.segments.length === 0) return null
    if (this.segments.some((s) => !Number.isFinite(s.end))) return null
    if (!this.supportsRanges && this.receivedBytes < this.totalBytes) return null
    const segments = this.segments.map(toSegmentCheckpoint)
    return {
      version: CHECKPOINT_VERSION,
      id: this.id,
      url: this.config.url,
      resource: { ...this.identity, totalBytes: this.totalBytes, contentType: this.identity.contentType ?? this.mime },
      saveMode,
      supportsRanges: this.supportsRanges,
      bytesWritten: segments.reduce((sum, s) => sum + s.received, 0),
      segments,
      savedAt: Date.now(),
    }
  }

  // ------------------------------------------------------------- lifecycle

  /** Starts (or resumes) the download. Idempotent while running. */
  async start(): Promise<void> {
    if (this.outcome) return
    if (this.phase === 'running' || this.phase === 'verifying' || this.phase === 'finalizing') return
    // Never race an in-flight pause: its queue is still stopped and a
    // non-resumable sink may still be tearing down.
    if (this.pausePromise) {
      await this.pausePromise
      if (this.isRunning() || this.outcome) return
    }
    const continuing = this.phase === 'paused' && this.sumReceived() > 0
    if (continuing) this.resumed = true
    this.phase = 'running'
    this.runAbort = new AbortController()
    this.currentError = null

    try {
      if (!this.sink) {
        await this.probe()
        if (!this.isRunning()) return
        await this.openSink()
        const opened = this.sink as Sink | null
        if (!this.isRunning()) {
          await opened?.abort('canceled')
          this.sink = null
          this.writeQueue = null
          return
        }
      } else {
        this.writeQueue?.restart()
      }
      if (this.resumed && this.sumReceived() > 0) {
        engineEvent('download.resume', { file: this.filename, id: this.id, bytes: this.sumReceived(), segments: this.segments.filter((s) => s.status !== 'done').length })
      }
      await this.execute()
    } catch (error) {
      await this.handleRunError(error)
    }
  }

  /**
   * Pause (plan P1-01 / P1-03): stop the network, drain the write queue,
   * checkpoint the sink, persist the checkpoint — and only *then* report
   * `paused`. Resolves once the pause is complete.
   */
  async pause(): Promise<void> {
    if (this.outcome) return
    if (this.pausePromise) return this.pausePromise
    if (this.phase === 'idle') {
      // Never started (still queued): nothing to settle.
      this.phase = 'paused'
      this.setStatus('paused')
      return
    }
    // Verification/finalization is short and must not be torn in half.
    if (this.phase !== 'running') return

    engineEvent('download.pause.requested', { file: this.filename, id: this.id })
    this.phase = 'pausing'
    this.setStatus('pausing')
    this.stopNetwork('paused')

    const settle = async (): Promise<void> => {
      await Promise.allSettled([...this.workers])
      const sink = this.sink
      if (sink && !sink.resumable) {
        // A stream sink parks chunks ahead of its cursor; those can never
        // complete once the network is gone, so cut them loose and restart
        // from zero on resume (the shelf download ends here).
        await sink.abort('paused').catch(() => undefined)
        await this.writeQueue?.stop(0).catch(() => false)
        this.sink = null
        this.writeQueue = null
        this.resetProgress()
      } else if (sink) {
        await this.writeQueue?.stop().catch(() => false)
        await this.persistCheckpoint(sink)
      }
      this.receivedBytes = this.sumReceived()
      this.emitSegments()
      this.deps.callbacks.onProgress(this.receivedBytes)
      // A cancel may have landed while we were settling.
      if (this.phase === 'pausing') {
        this.phase = 'paused'
        this.setStatus('paused')
      }
    }
    const settling = settle()
    this.pausePromise = settling
    try {
      await settling
    } finally {
      if (this.pausePromise === settling) this.pausePromise = null
    }
  }

  async cancel(): Promise<void> {
    this.phase = 'stopped'
    this.outcome = 'canceled'
    this.stopNetwork('canceled')
    await Promise.allSettled([...this.workers])
    try {
      await this.sink?.abort('canceled')
    } catch {
      /* ignore */
    }
    this.writeQueue = null
    this.sink = null
    await this.deps.checkpointStore?.remove(this.id)
    this.setStatus('canceled')
  }

  /** Clears all progress and error state so the next start() begins from zero. */
  async reset(): Promise<void> {
    this.stopNetwork('retry')
    await Promise.allSettled([...this.workers])
    await this.sink?.abort('retry').catch(() => undefined)
    await this.deps.checkpointStore?.remove(this.id)
    this.generation += 1
    this.writtenRanges.clear()
    this.seenWatermarks.clear()
    this.currentError = null
    this.outcome = null
    this.splitDone = false
    this.firstResponseSeen = false
    this.plainRetried = false
    this.usedRange = true
    this.ifRangeAllowed = true
    this.gate = null
    this.receivedBytes = 0
    this.resumeFrom = 0
    this.segments = []
    this.totalBytes = null
    this.identity = { ...EMPTY_IDENTITY }
    this.identityLocked = false
    this.resumed = false
    this.restored = false
    this.restoredMode = null
    this.finishing = false
    this.sink = null
    this.writeQueue = null
    this.phase = 'idle'
  }

  /** Clears the error state and starts over from the beginning. */
  async retry(): Promise<void> {
    await this.reset()
    await this.start()
  }

  /**
   * Drops the runner without touching the sink or the persisted checkpoint —
   * what a crash or tab close looks like to the engine.
   */
  async dispose(): Promise<void> {
    this.phase = 'stopped'
    this.stopNetwork('disposed')
    await Promise.allSettled([...this.workers])
  }

  // ---------------------------------------------------------------- probing

  private async probe(): Promise<void> {
    this.setStatus('probing')
    engineEvent('download.probe.start', { file: this.filename, id: this.id, url: this.config.url })
    const controller = new AbortController()
    this.controllers.add(controller)
    try {
      const probe = await this.transport.probe(this.config.url, this.requestHeaders(), controller.signal)
      const seen: Partial<ResourceIdentity> = {
        totalBytes: probe.totalBytes,
        etag: probe.etag,
        lastModified: probe.lastModified,
        contentType: probe.contentType,
      }
      // Resource validation before touching the partial file (end-state
      // "RESOURCE VALIDATION" step). A HEAD that reveals nothing proves nothing.
      if (this.identityLocked) assertSameResource(this.identity, seen)
      this.absorbIdentity(seen)
      if (probe.totalBytes != null && this.totalBytes == null) this.totalBytes = probe.totalBytes
      if (probe.contentType) this.mime = probe.contentType.split(';')[0]!.trim() || this.mime
      if (probe.filename) this.filename = probe.filename
      engineEvent('download.probe.complete', { file: this.filename, id: this.id, totalBytes: probe.totalBytes, etag: probe.etag, lastModified: probe.lastModified, acceptRanges: probe.acceptsRangesHeader })
      this.emitMeta()
    } catch (error) {
      if (error instanceof ResourceChangedError) throw error
      // A failing HEAD is not fatal: the first GET teaches us the rest.
    } finally {
      this.controllers.delete(controller)
    }
  }

  private async openSink(): Promise<void> {
    this.setStatus('probing', null, true)
    const ctx: SinkContext = {
      id: this.id,
      filename: this.filename,
      mime: this.mime,
      totalBytes: this.totalBytes,
      resumeFrom: this.resumeFrom,
      checksum: this.config.checksum ?? null,
      memoryLimit: this.config.memoryLimit,
    }
    const sink = await this.deps.sinkFactory(ctx)
    this.sink = sink
    const sinkName = sinkFilename(sink)
    if (sinkName) this.filename = sinkName
    this.writeQueue = new WriteQueue(sink)
    const hasProgress = this.sumReceived() > 0
    if (hasProgress && (!sink.resumable || (this.restored && !sink.durable))) {
      // A stream sink cannot seek, and a restored checkpoint is only valid
      // for the durable target it was taken against. Start over from zero.
      engineEvent('download.checkpoint.discarded', { file: this.filename, id: this.id, reason: `${sink.mode} sink cannot continue earlier progress` })
      this.resetProgress()
    }
    this.resumeFrom = 0
    this.setStatus('probing', null, false)
    this.deps.callbacks.onSaveMode(sink.mode)
  }

  /** Drops all acknowledged-byte bookkeeping so the transfer restarts at 0. */
  private resetProgress(): void {
    this.generation += 1
    this.writtenRanges.clear()
    this.seenWatermarks.clear()
    this.receivedBytes = 0
    this.resumeFrom = 0
    this.firstResponseSeen = false
    this.gate = null
    this.splitDone = false
    this.restored = false
    this.resumed = false
    this.segments = buildSegments(this.totalBytes, 1, false)
    this.segmented = false
    this.emitSegments()
    this.deps.callbacks.onProgress(0)
    void this.deps.checkpointStore?.remove(this.id)
  }

  // ------------------------------------------------------------- execution

  private async execute(): Promise<void> {
    if (this.segments.length === 0) {
      const connections = this.supportsRanges || this.totalBytes != null ? this.config.connections : 1
      this.segments = buildSegments(this.totalBytes, connections, this.usedRange)
      this.segmented = this.segments.length > 1
      engineEvent('download.plan', { file: this.filename, id: this.id, totalBytes: this.totalBytes, segments: this.segments.map((s) => [s.start, s.end]) })
      this.emitSegments()
    }
    this.setStatus('downloading')

    if (!this.allSegmentsDone()) {
      if (this.firstResponseSeen) {
        // Range support is established: run every incomplete segment at once.
        await Promise.all(this.segments.filter((s) => s.status !== 'done').map((seg) => this.runWorker(seg)))
      } else if (this.segmented) {
        const gate = this.createGate()
        const first = this.runWorker(this.segments[0]!, gate.promise)
        const mode = await Promise.race([gate.promise, first.then(() => 'single' as const)])
        if (mode === 'segmented') {
          const rest = this.segments.slice(1).map((seg) => this.runWorker(seg))
          await Promise.all([first, ...rest])
        } else {
          await first
        }
      } else {
        await this.runWorker(this.segments[0]!)
      }
    }

    // Workers spawned by a mid-download split aren't in the arrays above.
    while (this.workers.size > 0) await Promise.allSettled([...this.workers])

    if (this.isRunning() && this.outcome == null && this.allSegmentsDone()) await this.verifyAndFinalize()
  }

  private async handleRunError(error: unknown): Promise<void> {
    if (this.phase === 'stopped' || this.outcome === 'canceled') return
    if (this.phase === 'pausing' || this.phase === 'paused') return
    if (isAbort(error) && !this.isRunning() && this.phase !== 'verifying' && this.phase !== 'finalizing') return
    if (this.canFallBackToPlain(error)) {
      await this.restartPlain()
      return
    }
    if (this.outcome) return
    await this.fail(error)
  }

  /**
   * Many CORS setups refuse the preflight a `Range` header triggers, or the
   * server ignores ranges entirely. When the very first (ranged) request dies
   * before writing a single byte, retry once as a plain GET.
   */
  private canFallBackToPlain(error: unknown): boolean {
    return (
      isLikelyCorsError(error) &&
      this.usedRange &&
      !this.plainRetried &&
      !this.firstResponseSeen &&
      this.receivedBytes === 0 &&
      this.outcome == null
    )
  }

  private async restartPlain(): Promise<void> {
    engineEvent('download.fallback.plain', { file: this.filename, id: this.id })
    this.stopNetwork('fallback')
    await Promise.allSettled([...this.workers])
    this.generation += 1
    this.writtenRanges.clear()
    this.seenWatermarks.clear()
    this.plainRetried = true
    this.usedRange = false
    this.supportsRanges = false
    this.segmented = false
    this.splitDone = true
    this.firstResponseSeen = false
    this.gate = null
    this.segments = buildSegments(this.totalBytes, 1, false)
    this.emitSegments()
    this.phase = 'running'
    this.runAbort = new AbortController()
    this.writeQueue?.restart()
    try {
      await this.execute()
    } catch (error) {
      const phase = this.phase as Phase
      if (phase === 'stopped' || phase === 'pausing' || phase === 'paused' || this.outcome) return
      await this.fail(error)
    }
  }

  private isRunning(): boolean {
    return (this.phase as Phase) === 'running'
  }

  private createGate(): Gate {
    let resolve!: (v: 'segmented' | 'single') => void
    const promise = new Promise<'segmented' | 'single'>((r) => {
      resolve = r
    })
    this.gate = { promise, resolve }
    return this.gate
  }

  private async runWorker(segment: SegmentState, gate?: Promise<'segmented' | 'single'>): Promise<void> {
    const worker = this.workerLoop(segment, gate)
    this.workers.add(worker)
    try {
      await worker
    } finally {
      this.workers.delete(worker)
    }
  }

  private async workerLoop(segment: SegmentState, gate?: Promise<'segmented' | 'single'>): Promise<void> {
    /** Consecutive failures without progress. */
    let attempt = 0

    while (this.isRunning()) {
      if (segment.status === 'done' || !this.segments.includes(segment)) return
      if (Number.isFinite(segment.end) && segment.received >= segment.end - segment.start + 1) {
        segment.status = 'done'
        this.emitSegments()
        return
      }
      const controller = new AbortController()
      this.controllers.add(controller)
      segment.attempts = attempt
      segment.status = attempt === 0 ? 'active' : 'retrying'
      this.emitSegments()

      const rangeRequested = this.usedRange
      const requestStart = segment.start + segment.received
      const bounded = Number.isFinite(segment.end) && this.totalBytes != null
      const receivedBefore = segment.received
      const ifRange =
        rangeRequested && this.ifRangeAllowed && this.identityLocked && (this.resumed || segment.received > 0)
          ? ifRangeValidator(this.identity)
          : null
      if (ifRange && !this.stats.ifRange) this.bumpStats({ ifRange: true })
      let release: Release | null = null

      try {
        if (this.deps.connectionPool) release = await this.deps.connectionPool.acquire(this.host, controller.signal)
        if (!this.isRunning()) return
        if (attempt === 0 && receivedBefore === 0) engineEvent('download.segment.start', { id: this.id, segment: segment.index, start: segment.start, end: segment.end })

        const fetchStart = Date.now()
        const response = await this.transport.fetchRange({
          url: this.config.url,
          headers: this.requestHeaders(),
          signal: controller.signal,
          range: rangeRequested ? { start: requestStart, end: bounded ? segment.end : null } : undefined,
          ifRange,
          // Before the identity is locked, a total that disagrees with HEAD is
          // adopted (and the plan adjusted) rather than treated as a change.
          expectedTotal: this.identityLocked ? this.totalBytes : null,
        })

        const latencyMs = Date.now() - fetchStart
        // P3-02: host health — latency sample for successful fetch
        this.hostHealth.recordSuccess(this.host, latencyMs, 0, latencyMs)
        // P3-01: adaptive — observe latency trend (throughput will be measured after consume)
        // Note: initial observation uses latency as inverse throughput proxy.

        const plan = this.ingestResponse(response, segment, requestStart, rangeRequested)
        // Never leave the first worker (or its siblings) waiting on the gate.
        this.gate?.resolve(this.supportsRanges ? 'segmented' : 'single')
        if (plan.kind === 'collapse') {
          // The server ignored `Range`: this response is the entire file.
          // Reuse it as a single stream from byte 0 and kill every sibling.
          this.generation += 1
          this.writtenRanges.clear()
          this.seenWatermarks.clear()
          this.segmented = false
          this.splitDone = true
          this.usedRange = false
          this.supportsRanges = false
          for (const other of this.controllers) {
            if (other !== controller) other.abort(new Error('superseded by single-stream fallback'))
          }
          segment.start = 0
          segment.received = 0
          segment.end = this.totalBytes != null ? this.totalBytes - 1 : Number.POSITIVE_INFINITY
          segment.attempts = 0
          segment.index = 0
          this.segments = [segment]
          this.receivedBytes = 0
          this.emitSegments()
        }
        if (gate) await gate
        if (!this.isRunning()) {
          controller.abort()
          await response.cancel()
          return
        }
        if (plan.kind === 'done') {
          segment.status = 'done'
          this.emitSegments()
          engineEvent('download.segment.complete', { id: this.id, segment: segment.index })
          return
        }

        await this.consume(response, segment, controller, plan)
        if (!this.isRunning()) return
        // consume() may have completed the segment (TS can't see the mutation).
        if ((segment.status as SegmentState['status']) === 'done') {
          engineEvent('download.segment.complete', { id: this.id, segment: segment.index })
          return
        }
        // Content-Range covered less than we asked for: re-request the rest.
        if (segment.received > receivedBefore) attempt = 0
        continue
      } catch (error) {
        if (!this.isRunning()) return
        if (isAbort(error)) return

        // If-Range adds a preflighted header; if that's what broke the
        // request, drop it and rely on response validation instead.
        if (ifRange && isLikelyCorsError(error)) {
          this.ifRangeAllowed = false
          this.bumpStats({ ifRange: false })
          continue
        }
        if (this.canFallBackToPlain(error)) throw error

        this.countFailure(error)
        // P3-02: host health failure tracking (latency / 429 / resets)
        if (error instanceof HttpError) {
          if (error.status === 429) this.hostHealth.recordFailure(this.host, '429')
          else if (error.status >= 500) this.hostHealth.recordFailure(this.host, '5xx')
          else this.hostHealth.recordFailure(this.host, 'other')
        } else if (error instanceof Error && /aborted|reset|network/i.test(error.message)) {
          this.hostHealth.recordFailure(this.host, 'reset')
        } else {
          this.hostHealth.recordFailure(this.host, 'other')
        }
        // P3-01: adaptive — shrink on rate limit
        if (error instanceof HttpError && error.status === 429) this.adaptive.onRateLimited()

        if (segment.received > receivedBefore) attempt = 0
        attempt += 1
        const decision = classifyFailure(error, { attempt, maxRetries: this.config.maxRetries })
        if (decision.type === 'aborted') return
        if (decision.type !== 'retry') throw error

        segment.status = 'retrying'
        segment.attempts = attempt
        this.bumpStats({ automaticRetryCount: this.stats.automaticRetryCount + 1 })
        engineEvent('download.segment.retry', { id: this.id, segment: segment.index, attempt, delayMs: Math.round(decision.delayMs), reason: decision.reason })
        this.emitSegments()
        // Don't hold a pool slot while backing off.
        release?.()
        release = null
        await abortableSleep(decision.delayMs, this.runAbort.signal)
      } finally {
        release?.()
        this.controllers.delete(controller)
      }
    }
  }

  /**
   * Reads the (already transport-validated) response and decides how to
   * consume it. Also locks in / checks the resource identity.
   */
  private ingestResponse(
    response: RangeResponse,
    segment: SegmentState,
    requestStart: number,
    rangeRequested: boolean,
  ): { kind: 'stream' | 'collapse' | 'done'; skip: number; creditEnd: number; expectedBytes: number | null } {
    // Identity check on every response once established (plan P0-04).
    if (this.identityLocked) {
      try {
        assertSameResource(this.identity, response.identity)
      } catch (error) {
        engineEvent('download.resource.changed', { file: this.filename, id: this.id, reason: (error as Error).message })
        throw error
      }
    }

    const first = !this.firstResponseSeen
    const contentLength = response.contentLength

    if (response.kind === 'unsatisfiable') {
      // Plan P0-03: a 416 is not proof the segment is complete.
      const total = response.unsatisfiedTotal
      if (total != null && this.totalBytes != null && total !== this.totalBytes) {
        throw new ResourceChangedError(`Remote size changed from ${this.totalBytes} to ${total} bytes`)
      }
      const knownTotal = total ?? this.totalBytes
      if (knownTotal != null && requestStart >= knownTotal && requestStart > segment.start) {
        if (!Number.isFinite(segment.end)) segment.end = requestStart - 1
        return { kind: 'done', skip: 0, creditEnd: segment.end, expectedBytes: 0 }
      }
      if (knownTotal == null && !Number.isFinite(segment.end) && requestStart > segment.start) {
        segment.end = requestStart - 1
        return { kind: 'done', skip: 0, creditEnd: segment.end, expectedBytes: 0 }
      }
      if (knownTotal != null && requestStart < knownTotal) {
        throw new ResourceChangedError('Server rejected a range inside the file (416) — the remote file probably changed')
      }
      throw new HttpError('Server responded 416 Range Not Satisfiable', 416)
    }

    if (response.kind === 'partial') {
      if (first) {
        this.firstResponseSeen = true
        this.supportsRanges = true
        this.gate?.resolve('segmented')
      }
      if (this.totalBytes == null) {
        const total = response.contentRange?.total ?? (contentLength != null && requestStart === 0 && !Number.isFinite(segment.end) ? contentLength : null)
        if (total != null) {
          this.totalBytes = total
          this.emitMeta()
        }
      }
      this.absorbIdentity({ ...response.identity, totalBytes: this.totalBytes })
      this.identityLocked = true

      let creditEnd: number
      let expectedBytes: number | null
      if (first && response.contentRange?.total != null && this.totalBytes != null && response.contentRange.total !== this.totalBytes) {
        this.adoptTotal(response.contentRange.total)
      }
      if (response.contentRange) {
        creditEnd = response.contentRange.end
        expectedBytes = response.contentRange.end - response.contentRange.start + 1
      } else {
        // Content-Range not exposed cross-origin: the best remaining check is
        // Content-Length against what we asked for.
        if (!this.stats.unverifiedRanges) {
          this.bumpStats({ unverifiedRanges: true })
          engineEvent('download.range.unverified', { file: this.filename, id: this.id, hint: 'Server does not expose Content-Range (Access-Control-Expose-Headers)' })
        }
        const requestedLength = Number.isFinite(segment.end) ? segment.end - requestStart + 1 : null
        if (contentLength != null && requestedLength != null && contentLength > requestedLength) {
          throw new RangeMismatchError(`206 body of ${contentLength} bytes exceeds the requested ${requestedLength}`)
        }
        expectedBytes = contentLength
        creditEnd = contentLength != null ? requestStart + contentLength - 1 : segment.end
      }
      return { kind: 'stream', skip: 0, creditEnd, expectedBytes }
    }

    // 200: the whole representation from byte 0.
    if (response.sentIfRange && this.supportsRanges) {
      // If-Range told the server "only if unchanged"; a full body means it changed.
      throw new ResourceChangedError('Remote file changed (If-Range validator no longer matches)')
    }
    if (this.totalBytes != null && contentLength != null && contentLength !== this.totalBytes && this.identityLocked) {
      throw new ResourceChangedError(`Remote size changed from ${this.totalBytes} to ${contentLength} bytes`)
    }
    if (first) {
      this.firstResponseSeen = true
      this.supportsRanges = false
      if (contentLength != null && contentLength !== this.totalBytes) {
        // The GET is authoritative over HEAD.
        this.totalBytes = contentLength
        if (!this.segmented && this.segments.length === 1) this.segments[0]!.end = contentLength > 0 ? contentLength - 1 : Number.POSITIVE_INFINITY
        this.emitMeta()
      }
      this.absorbIdentity({ ...response.identity, totalBytes: this.totalBytes })
      this.identityLocked = true
      const total = this.totalBytes
      if (this.segmented) {
        this.gate?.resolve('single')
        return { kind: 'collapse', skip: 0, creditEnd: total != null ? total - 1 : Number.POSITIVE_INFINITY, expectedBytes: contentLength }
      }
      this.gate?.resolve('single')
    }
    // Discard bytes before our window so the write cursor stays aligned.
    const skip = rangeRequested || requestStart > 0 ? requestStart : 0
    const total = this.totalBytes
    return {
      kind: 'stream',
      skip,
      creditEnd: total != null ? total - 1 : Number.POSITIVE_INFINITY,
      expectedBytes: contentLength != null ? contentLength - skip : null,
    }
  }

  private async consume(
    response: RangeResponse,
    segment: SegmentState,
    controller: AbortController,
    plan: { skip: number; creditEnd: number; expectedBytes: number | null },
  ): Promise<void> {
    const body = response.body
    if (!body) {
      if (plan.expectedBytes) throw new BodyLengthError('Response had no body', plan.expectedBytes, 0)
      return
    }
    const queue = this.writeQueue
    if (!queue) throw new Error('Download sink is not ready')

    const generation = this.generation
    const reader = body.getReader()
    let buffer: Uint8Array[] = []
    let buffered = 0
    /** Network offset: next absolute byte to read. */
    let offset = segment.start + segment.received
    let inFlight = 0
    let toSkip = plan.skip
    /** Body bytes seen after the skipped prefix (for length validation). */
    let bodyBytes = 0
    let ackError: unknown = null
    const acks: Promise<void>[] = []
    let finishedCleanly = false

    const flush = async (final: boolean): Promise<void> => {
      if (buffered > 0) {
        const chunk = concat(buffer, buffered)
        buffer = []
        buffered = 0
        inFlight += chunk.byteLength
        const ack = queue.submit(offset, chunk, (at, length) => this.markWritten(segment, generation, at, length))
        if (ack) acks.push(ack.catch((error) => { ackError ??= error }))
        offset += chunk.byteLength
      }
      if (final || inFlight > MAX_PIPELINE_BYTES) {
        await queue.drain(this.runAbort.signal)
        inFlight = 0
      }
      this.emitProgress()
      this.maybeSplit(segment, offset)
    }

    try {
      for (;;) {
        if (!this.isRunning()) {
          // Pausing/cancelling: unflushed bytes were never written, so they
          // simply aren't credited. Don't wait on the queue here — pause()
          // drains it after every worker has stopped.
          controller.abort()
          await reader.cancel().catch(() => undefined)
          return
        }
        const read = await reader.read()
        if (read.done) {
          finishedCleanly = true
          break
        }
        let value = read.value!

        await this.deps.globalLimiter.take(value.byteLength)
        await this.taskLimiter.take(value.byteLength)

        if (toSkip > 0) {
          if (value.byteLength <= toSkip) {
            toSkip -= value.byteLength
            continue
          }
          value = value.subarray(toSkip)
          toSkip = 0
        }
        bodyBytes += value.byteLength

        const windowEnd = Math.min(segment.end, plan.creditEnd)
        const remaining = Number.isFinite(windowEnd) ? Math.max(0, windowEnd + 1 - offset) : value.byteLength
        if (remaining === 0) {
          if (segment.end < plan.creditEnd) {
            // A mid-download split shortened this segment: the rest belongs
            // to a sibling. Stop reading; that's not an error.
            await reader.cancel().catch(() => undefined)
            break
          }
          throw new BodyLengthError('Server sent more bytes than Content-Range described', plan.expectedBytes ?? bodyBytes - value.byteLength, bodyBytes)
        }
        const chunk = remaining < value.byteLength ? value.subarray(0, remaining) : value

        buffer.push(chunk)
        buffered += chunk.byteLength
        // `offset` is the write cursor (it only advances on flush), so the
        // network position is the cursor plus everything still buffered.
        this.markSeen(segment, offset + buffered)
        // Writes are only acknowledged once a FLUSH_BYTES block lands, which is
        // far too coarse for the speed readout and the throughput graphs; report
        // what the network has actually delivered (throttled inside).
        this.emitProgress()
        if (buffered >= FLUSH_BYTES) await flush(false)
      }
      await flush(true)
      if (!this.isRunning()) return

      // Plan P0-02: a body shorter than promised must not become a finished segment.
      if (finishedCleanly && plan.expectedBytes != null && bodyBytes < plan.expectedBytes) {
        // Credit what arrived (it's at the right offsets) and let the retry
        // policy re-request the remainder.
        await untilAborted(Promise.all(acks), this.runAbort.signal)
        if (!this.isRunning()) return
        if (ackError) throw ackError
        engineEvent('download.segment.short', { id: this.id, segment: segment.index, expected: plan.expectedBytes, actual: bodyBytes })
        throw new BodyLengthError(`Response body ended after ${bodyBytes} of ${plan.expectedBytes} bytes`, plan.expectedBytes, bodyBytes)
      }

      // Wait until the sink acknowledged everything this response delivered.
      await untilAborted(Promise.all(acks), this.runAbort.signal)
      if (!this.isRunning()) return
      if (ackError) throw ackError
      if (queue.failure) throw queue.failure
      if (!this.isRunning()) return

      if (!Number.isFinite(segment.end)) {
        if (finishedCleanly) {
          segment.end = segment.start + segment.received - 1
          if (this.totalBytes == null) {
            this.totalBytes = segment.end + 1
            this.emitMeta()
          }
          segment.status = 'done'
        }
      } else if (segment.received >= segment.end - segment.start + 1) {
        segment.status = 'done'
      }
      this.emitSegments()
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      buffer = []
    }
  }

  /** Advances a segment's contiguous written watermark from sink acknowledgements. */
  private markWritten(segment: SegmentState, generation: number, at: number, length: number): void {
    if (generation !== this.generation || !this.segments.includes(segment)) return
    let mark = segment.start + segment.received
    const end = at + length
    if (end <= mark) return
    const pending = this.writtenRanges.get(segment) ?? []
    pending.push([at, end])
    pending.sort((a, b) => a[0] - b[0])
    const rest: [number, number][] = []
    for (const [s, e] of pending) {
      if (s <= mark) mark = Math.max(mark, e)
      else rest.push([s, e])
    }
    this.writtenRanges.set(segment, rest)
    const cap = Number.isFinite(segment.end) ? segment.end - segment.start + 1 : Number.POSITIVE_INFINITY
    segment.received = Math.min(cap, mark - segment.start)
    this.receivedBytes = this.sumReceived()
  }

  /** aria2-style dynamic splitting: learn the size mid-download, then fan out. */
  private maybeSplit(segment: SegmentState, networkOffset: number): void {
    if (this.splitDone || this.segmented || !this.isRunning()) return
    if (!this.totalBytes || this.totalBytes < MIN_SEGMENT_BYTES * 4) return
    if (Number.isFinite(segment.end) && segment.end !== this.totalBytes - 1) return
    if (!this.supportsRanges) return

    // P3-01 / P3-02: consult adaptive controller and host health; if the
    // host is rate-limited, stay conservative and don't fan out.
    const host = this.hostHealth.get(this.host)
    if (host.rateLimited) return
    const desired = this.adaptive.connections
    const targetConnections = Math.min(this.config.connections, desired)
    const remaining = this.totalBytes - networkOffset
    const extra = Math.min(targetConnections - 1, Math.floor(remaining / MIN_SEGMENT_BYTES) - 1)
    if (extra < 1 || remaining < MIN_SEGMENT_BYTES * 2) return

    const splitAt = networkOffset + Math.floor(remaining / (extra + 1))
    segment.end = splitAt - 1
    this.splitDone = true
    this.segmented = true

    const chunk = Math.floor((this.totalBytes - splitAt) / extra)
    for (let i = 0; i < extra; i += 1) {
      const start = splitAt + i * chunk
      const end = i === extra - 1 ? this.totalBytes - 1 : start + chunk - 1
      this.segments.push({ index: this.segments.length, start, end, received: 0, status: 'idle', attempts: 0, speed: 0 })
    }
    engineEvent('download.plan', { file: this.filename, id: this.id, split: true, segments: this.segments.map((s) => [s.start, s.end]) })
    this.emitSegments()

    for (const seg of this.segments.slice(1)) {
      if (seg.status !== 'idle') continue
      seg.status = 'active'
      void this.runWorker(seg).catch((error) => {
        if (this.isRunning() && this.outcome == null) void this.handleRunError(error)
      })
    }
  }

  /**
   * The first response reported a different size than HEAD did. Nothing has
   * been written yet, so re-fit the plan: drop segments past the new end and
   * stretch/shrink the last one.
   */
  private adoptTotal(total: number): void {
    this.totalBytes = total
    const keep = this.segments.filter((s) => s.start < total)
    if (keep.length === 0) return
    keep.at(-1)!.end = total - 1
    this.segments = keep
    this.segmented = keep.length > 1
    this.emitMeta()
    this.emitSegments()
  }

  private allSegmentsDone(): boolean {
    return this.segments.length > 0 && this.segments.every((s) => s.status === 'done')
  }

  /**
   * DOWNLOADING → VERIFYING → FINALIZING → COMPLETED (plan P2-14).
   * Verifying checks the structural invariants; finalizing commits the sink,
   * which also verifies the checksum.
   */
  private async verifyAndFinalize(): Promise<void> {
    if (this.outcome || this.finishing) return
    const queue = this.writeQueue
    const sink = this.sink
    if (!queue || !sink) return
    this.finishing = true

    this.phase = 'verifying'
    this.setStatus('verifying')
    const drained = await queue.stop(30_000)
    if (queue.failure) throw queue.failure
    if (!drained) throw new DownloadIntegrityError('Timed out waiting for the last writes to reach the target')
    const size = this.verifyCoverage()
    engineEvent('download.verify', { file: this.filename, id: this.id, size, segments: this.segments.length })

    this.phase = 'finalizing'
    this.setStatus('finalizing')
    const result = await sink.finish(size, this.filename)
    if (result.checksum) engineEvent('download.checksum', { file: this.filename, id: this.id, ...result.checksum })
    this.outcome = 'completed'
    this.phase = 'done'
    await this.deps.checkpointStore?.remove(this.id)
    this.deps.callbacks.onProgress(this.receivedBytes)
    this.setStatus('completed')
    engineEvent('download.complete', { file: this.filename, id: this.id, size, mode: sink.mode })
    this.deps.callbacks.onComplete({ ...result, saveMode: sink.mode })
  }

  /** Segments must tile [0, size) with every byte acknowledged. Returns the size. */
  private verifyCoverage(): number {
    const ordered = [...this.segments].sort((a, b) => a.start - b.start)
    let cursor = 0
    for (const seg of ordered) {
      if (seg.start !== cursor) throw new DownloadIntegrityError(`Segment coverage ${seg.start > cursor ? 'gap' : 'overlap'} at byte ${cursor}`)
      if (!Number.isFinite(seg.end)) throw new DownloadIntegrityError('A segment never learned where it ends')
      const length = seg.end - seg.start + 1
      if (seg.received !== length) throw new DownloadIntegrityError(`Segment ${seg.index} has ${seg.received} of ${length} bytes`)
      cursor = seg.end + 1
    }
    if (this.totalBytes != null && cursor !== this.totalBytes) {
      throw new DownloadIntegrityError(`Downloaded ${cursor} bytes, expected ${this.totalBytes}`)
    }
    return cursor
  }

  // ----------------------------------------------------------- persistence

  /** Commits the sink and records exactly what is now durable (plan P0-08). */
  private async persistCheckpoint(sink: Sink): Promise<void> {
    try {
      await sink.checkpoint?.()
    } catch {
      // If the sink couldn't commit, nothing new is durable: keep the old checkpoint.
      return
    }
    const store = this.deps.checkpointStore
    if (!store) return
    if (!sink.durable) {
      await store.remove(this.id)
      return
    }
    const checkpoint = this.createCheckpoint()
    if (!checkpoint) {
      await store.remove(this.id)
      return
    }
    try {
      await store.save(this.id, checkpoint)
      this.bumpStats({ lastCheckpointAt: checkpoint.savedAt })
      engineEvent('download.checkpoint.saved', { file: this.filename, id: this.id, bytes: checkpoint.bytesWritten, segments: checkpoint.segments.length })
    } catch {
      /* storage full/unavailable: the previous checkpoint (if any) is still valid */
    }
  }

  // ----------------------------------------------------------------- utils

  private setStatus(next: DownloadStatus, error: string | null = null, awaitingTarget?: boolean): void {
    if (!canTransition(this.status, next)) {
      engineEvent('download.status.invalid', { id: this.id, from: this.status, to: next })
    }
    this.status = next
    this.deps.callbacks.onStatus(next, error, awaitingTarget)
  }

  private absorbIdentity(seen: Partial<ResourceIdentity>): void {
    this.identity = {
      etag: this.identity.etag ?? seen.etag ?? null,
      lastModified: this.identity.lastModified ?? seen.lastModified ?? null,
      totalBytes: this.identity.totalBytes ?? seen.totalBytes ?? null,
      contentType: this.identity.contentType ?? seen.contentType ?? null,
    }
  }

  private countFailure(error: unknown): void {
    if (error instanceof HttpError) this.bumpStats({ httpErrors: this.stats.httpErrors + 1 })
    else if (error instanceof RangeMismatchError) this.bumpStats({ rangeErrors: this.stats.rangeErrors + 1 })
    else if (error instanceof DownloadIntegrityError) this.bumpStats({ integrityErrors: this.stats.integrityErrors + 1 })
    if (error instanceof DownloadIntegrityError) {
      engineEvent('download.integrity.failure', { file: this.filename, id: this.id, error: error.message, kind: error.name })
    }
  }

  private bumpStats(patch: Partial<RunnerStats>): void {
    this.stats = { ...this.stats, ...patch }
    this.deps.callbacks.onStats?.({ ...this.stats })
  }

  private requestHeaders(): Record<string, string> {
    return buildRequestHeaders(this.config.auth, this.config.headers)
  }

  private getSegments(): SegmentState[] {
    return this.segments.map((s) => ({ ...s }))
  }

  private sumReceived(): number {
    let total = 0
    for (const seg of this.segments) total += seg.received
    return total
  }

  /**
   * Records how far the network has got on a segment, independent of what the
   * sink has acknowledged. Retries re-read from the written watermark, so the
   * high-water mark keeps re-reads from inflating the figure.
   */
  private markSeen(segment: SegmentState, networkOffset: number): void {
    const seen = networkOffset - segment.start
    if (seen > (this.seenWatermarks.get(segment) ?? 0)) this.seenWatermarks.set(segment, seen)
  }

  /** Bytes the network has delivered, written or still on their way to disk. */
  private seenBytes(): number {
    let total = 0
    for (const seg of this.segments) {
      const length = Number.isFinite(seg.end) ? seg.end - seg.start + 1 : Number.POSITIVE_INFINITY
      const seen = Math.min(this.seenWatermarks.get(seg) ?? 0, length)
      total += Math.max(seg.received, seen)
    }
    return total
  }

  private emitSegments(): void {
    this.deps.callbacks.onSegments(this.getSegments())
  }

  private emitMeta(): void {
    this.deps.callbacks.onMeta({
      totalBytes: this.totalBytes,
      filename: this.filename,
      mime: this.mime,
      supportsRanges: this.supportsRanges,
      identity: { ...this.identity },
    })
  }

  private emitProgress(): void {
    const now = Date.now()
    if (now - this.lastProgressEmit < 150) return
    this.lastProgressEmit = now
    // Report the further of "written to the target" and "off the network": the
    // written watermark only moves in FLUSH_BYTES steps, which left the
    // throughput graphs flat for most of a transfer.
    this.deps.callbacks.onProgress(Math.max(this.receivedBytes, this.seenBytes()))
    this.emitSegments()
  }

  private async fail(error: unknown): Promise<void> {
    if (this.outcome) return
    const message = error instanceof Error ? error.message : String(error)
    this.currentError = message
    // Worker-level integrity errors were counted when classified; ones raised
    // while verifying/finalizing (coverage, size, checksum) land here first.
    if (this.finishing && error instanceof DownloadIntegrityError) this.bumpStats({ integrityErrors: this.stats.integrityErrors + 1 })
    this.outcome = 'failed'
    this.phase = 'idle'
    this.stopNetwork('failed')
    engineEvent('download.failed', { file: this.filename, id: this.id, error: message, kind: error instanceof Error ? error.name : typeof error })
    this.deps.callbacks.onSegments(
      this.segments.map((s) => (s.status === 'active' || s.status === 'retrying' ? { ...s, status: 'error' as const } : { ...s })),
    )
    this.setStatus('failed', message)
    // Release the target: an FSA writable discards its swap file (the file on
    // disk keeps the last checkpoint), a stream download is marked failed.
    const sink = this.sink
    this.sink = null
    this.writeQueue = null
    if (error instanceof ResourceChangedError) await this.deps.checkpointStore?.remove(this.id)
    await sink?.abort('failed').catch(() => undefined)
  }

  private stopNetwork(reason: string): void {
    // Nothing more is arriving, so "seen but not yet written" bytes are no
    // longer in flight: fall back to the written watermark for reporting.
    this.seenWatermarks.clear()
    for (const controller of this.controllers) controller.abort(new Error(reason))
    this.controllers.clear()
    this.runAbort.abort(new Error(reason))
  }
}

/**
 * Range planner: `connections` equal segments that tile [0, total) exactly —
 * no gaps, no overlaps, first byte 0, last byte total-1.
 */
export function buildSegments(
  totalBytes: number | null,
  connections: number,
  allowSplit: boolean,
): SegmentState[] {
  const single = (end: number): SegmentState[] => [
    { index: 0, start: 0, end, received: 0, status: 'idle', attempts: 0, speed: 0 },
  ]
  if (!allowSplit) return single(totalBytes != null && totalBytes > 0 ? totalBytes - 1 : Number.POSITIVE_INFINITY)
  if (totalBytes == null || totalBytes <= 0) return single(Number.POSITIVE_INFINITY)

  const maxConnections = Math.max(1, Math.min(Math.floor(connections) || 1, Math.floor(totalBytes / MIN_SEGMENT_BYTES) || 1))
  if (maxConnections === 1) return single(totalBytes - 1)

  const size = Math.floor(totalBytes / maxConnections)
  const segments: SegmentState[] = []
  for (let i = 0; i < maxConnections; i += 1) {
    const start = i * size
    const end = i === maxConnections - 1 ? totalBytes - 1 : start + size - 1
    segments.push({ index: i, start, end, received: 0, status: 'idle', attempts: 0, speed: 0 })
  }
  return segments
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!
  const out = new Uint8Array(length)
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.byteLength
  }
  return out
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Resolves when `promise` settles or `signal` aborts, whichever is first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<T | void>((resolve, reject) => {
    const onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function sinkFilename(sink: Sink): string | null {
  const candidate = sink as { filename?: unknown }
  return typeof candidate.filename === 'string' && candidate.filename ? candidate.filename : null
}
