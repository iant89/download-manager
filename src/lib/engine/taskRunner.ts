/**
 * The heart of Flux: one `TaskRunner` per download.
 *
 * Responsibilities
 *  - probe the remote resource (size / range support / filename)
 *  - split it into N segments and fetch them in parallel with HTTP Range
 *  - honour per-task and global speed limits
 *  - retry failed connections with exponential backoff
 *  - pause / resume / cancel without losing acknowledged bytes
 *  - push everything through a `Sink` so nothing large is held in memory
 */

import type { AuthConfig, DownloadStatus, HeaderEntry, SaveMode, SegmentState } from '../../types'
import { buildRequestHeaders, HttpError, isAbort, isLikelyCorsError, probeResource } from '../http'
import { RateLimiter } from './rateLimiter'
import type { Sink, SinkContext, SinkResult } from './sinks/types'
import { WriteQueue } from './writeQueue'

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
}

export interface RunnerMeta {
  totalBytes: number | null
  filename: string | null
  mime: string | null
  supportsRanges: boolean
}

export interface RunnerCallbacks {
  onMeta(meta: RunnerMeta): void
  onSegments(segments: SegmentState[]): void
  onStatus(status: DownloadStatus, error?: string | null, awaitingTarget?: boolean): void
  onProgress(receivedBytes: number): void
  onSaveMode(mode: SaveMode): void
  onComplete(result: SinkResult & { saveMode: SaveMode }): void
}

export interface RunnerDeps {
  globalLimiter: RateLimiter
  sinkFactory(ctx: SinkContext): Promise<Sink>
  callbacks: RunnerCallbacks
}

type Phase = 'idle' | 'running' | 'paused' | 'stopped' | 'finalizing' | 'done'
type Outcome = 'completed' | 'failed' | 'canceled' | null

export class TaskRunner {
  readonly id: string

  private config: TaskConfig
  private deps: RunnerDeps
  private phase: Phase = 'idle'
  private outcome: Outcome = null

  private segments: SegmentState[] = []
  private totalBytes: number | null = null
  private filename: string
  private mime = 'application/octet-stream'
  private supportsRanges = false
  private segmented = false
  private usedRange = true
  private plainRetried = false
  private splitDone = false

  private taskLimiter: RateLimiter
  private sink: Sink | null = null
  private writeQueue: WriteQueue | null = null
  private controllers = new Set<AbortController>()
  private workers = new Set<Promise<void>>()
  private resumeFrom: number

  private receivedBytes = 0
  private lastProgressEmit = 0
  private gate: { promise: Promise<'segmented' | 'single'>; resolve: (v: 'segmented' | 'single') => void } | null = null
  private firstResponseSeen = false
  private currentError: string | null = null
  /** Set while `pause()` is still settling the queue and sink. */
  private pausePromise: Promise<void> | null = null

  constructor(
    config: TaskConfig,
    deps: RunnerDeps,
    initial?: { resumeFrom?: number; totalBytes?: number | null },
  ) {
    this.id = config.id
    this.config = config
    this.deps = deps
    this.filename = config.filename
    this.resumeFrom = initial?.resumeFrom ?? 0
    this.totalBytes = initial?.totalBytes ?? null
    this.receivedBytes = this.resumeFrom
    this.taskLimiter = new RateLimiter(config.speedLimit)
  }

  getStatus(): DownloadStatus {
    if (this.outcome === 'completed') return 'completed'
    if (this.outcome === 'failed') return 'failed'
    if (this.outcome === 'canceled') return 'canceled'
    switch (this.phase) {
      case 'idle':
        return 'queued'
      case 'paused':
        return 'paused'
      case 'stopped':
        return 'canceled'
      case 'finalizing':
        return 'finalizing'
      default:
        return this.segments.length === 0 ? 'probing' : 'downloading'
    }
  }

  getSnapshot(): {
    receivedBytes: number
    totalBytes: number | null
    segments: SegmentState[]
    error: string | null
    supportsRanges: boolean
  } {
    return {
      receivedBytes: this.receivedBytes,
      totalBytes: this.totalBytes,
      segments: this.segments.map((s) => ({ ...s })),
      error: this.currentError,
      supportsRanges: this.supportsRanges,
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

  /** Starts (or resumes) the download. Idempotent while running. */
  async start(): Promise<void> {
    if (this.phase === 'running' || this.outcome) return
    // Never race an in-flight pause: its queue is still `stopped` (submissions
    // would be dropped) and a non-resumable sink may still be torn down.
    if (this.pausePromise) {
      const settling = this.pausePromise
      await settling
      if (this.isRunning() || this.outcome) return
    }
    this.phase = 'running'
    this.currentError = null

    try {
      if (!this.sink) {
        await this.probe()
        if (this.phase !== 'running') return
        await this.openSink()
        // Read through a widening cast: control-flow analysis still believes
        // `this.sink` is null here because openSink() assigned it internally.
        const opened = this.sink as Sink | null
        if (this.phase !== 'running') {
          await opened?.abort('canceled')
          this.sink = null
          this.writeQueue = null
          return
        }
      } else {
        this.writeQueue?.restart()
      }
      await this.execute()
    } catch (error) {
      if (this.isStopped() || this.outcome === 'canceled') return
      if (isAbort(error) && !this.isRunning()) return
      if (this.canFallBackToPlain(error)) {
        await this.restartPlain()
        return
      }
      this.fail(error)
    }
  }

  async pause(): Promise<void> {
    if (this.phase !== 'running' && this.phase !== 'finalizing') return
    this.phase = 'paused'
    this.abortControllers('paused')
    await Promise.allSettled([...this.workers])
    const settle = async (): Promise<void> => {
      const sink = this.sink
      const resumable = sink?.resumable ?? false
      // A stream sink parks chunks that arrive ahead of the cursor; those
      // writes can never complete once the network is gone, so cut them loose
      // *before* waiting for the queue to settle (otherwise the pause hangs).
      if (sink && !resumable) await sink.abort('paused').catch(() => undefined)
      try {
        await this.writeQueue?.stop()
        if (resumable) await checkpointSink(sink)
      } catch {
        /* ignore */
      }
      if (sink && !resumable) {
        // The shelf download was ended; resuming restarts from byte zero.
        this.sink = null
        this.writeQueue = null
        this.resetProgress()
      }
      this.receivedBytes = this.sumReceived()
      this.deps.callbacks.onProgress(this.receivedBytes)
      this.deps.callbacks.onStatus('paused')
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
    this.abortControllers('canceled')
    await Promise.allSettled([...this.workers])
    try {
      await this.sink?.abort('canceled')
    } catch {
      /* ignore */
    }
    this.writeQueue = null
    this.sink = null
  }

  /** Clears the error state and starts over from the beginning. */
  async retry(): Promise<void> {
    this.currentError = null
    this.outcome = null
    this.splitDone = false
    this.firstResponseSeen = false
    this.plainRetried = false
    this.usedRange = true
    this.gate = null
    this.receivedBytes = 0
    this.resumeFrom = 0
    this.segments = []
    this.totalBytes = null
    this.sink = null
    this.writeQueue = null
    this.phase = 'idle'
    await this.start()
  }

  // ---------------------------------------------------------------- probing

  private async probe(): Promise<void> {
    this.deps.callbacks.onStatus('probing')
    const controller = new AbortController()
    this.controllers.add(controller)
    try {
      const probe = await probeResource(this.config.url, this.requestHeaders(false), controller.signal)
      if (probe.totalBytes != null) this.totalBytes = probe.totalBytes
      if (probe.contentType) this.mime = probe.contentType.split(';')[0]!.trim() || this.mime
      if (probe.filename) this.filename = probe.filename
      this.deps.callbacks.onMeta({
        totalBytes: this.totalBytes,
        filename: this.filename,
        mime: this.mime,
        supportsRanges: false,
      })
    } catch {
      // A failing HEAD is not fatal: the first GET teaches us the rest.
    } finally {
      this.controllers.delete(controller)
    }
  }

  private async openSink(): Promise<void> {
    this.deps.callbacks.onStatus('probing', null, true)
    const ctx: SinkContext = {
      id: this.id,
      filename: this.filename,
      mime: this.mime,
      totalBytes: this.totalBytes,
      resumeFrom: this.resumeFrom,
    }
    const sink = await this.deps.sinkFactory(ctx)
    this.sink = sink
    const sinkName = sinkFilename(sink)
    if (sinkName) this.filename = sinkName
    this.writeQueue = new WriteQueue(sink)
    if (!sink.resumable && (this.resumeFrom > 0 || this.sumReceived() > 0)) {
      // A stream sink cannot seek: any progress from a previous session (or an
      // earlier attempt with this runner) would misalign the byte stream, so
      // restart the transfer from zero with a fresh registration.
      this.resetProgress()
    }
    this.resumeFrom = 0
    this.deps.callbacks.onStatus('probing', null, false)
    this.deps.callbacks.onSaveMode(sink.mode)
  }

  /** Drops all acknowledged-byte bookkeeping so the transfer restarts at 0. */
  private resetProgress(): void {
    this.receivedBytes = 0
    this.resumeFrom = 0
    this.firstResponseSeen = false
    this.gate = null
    this.splitDone = false
    this.segments = buildSegments(this.totalBytes, 1, false)
    this.segmented = false
    this.deps.callbacks.onSegments(this.getSegments())
    this.deps.callbacks.onProgress(0)
  }

  // ------------------------------------------------------------- execution

  private async execute(): Promise<void> {
    if (this.segments.length === 0) {
      const connections = this.supportsRanges || this.totalBytes != null ? this.config.connections : 1
      this.segments = buildSegments(this.totalBytes, connections, this.usedRange)
      this.segmented = this.segments.length > 1
      this.deps.callbacks.onSegments(this.getSegments())
    }

    {
      if (this.segmented && this.firstResponseSeen) {
        // Resuming: range support is already established, run everything at once.
        await Promise.all(this.segments.filter((s) => s.status !== 'done').map((seg) => this.runWorker(seg)))
      } else if (this.segmented) {
        const gate = this.createGate()
        const first = this.runWorker(this.segments[0]!, gate.promise)
        const mode = await gate.promise
        if (mode === 'single') {
          await first
          return
        }
        const rest = this.segments.slice(1).map((seg) => this.runWorker(seg))
        await Promise.all([first, ...rest])
      } else {
        await this.runWorker(this.segments[0]!)
      }
    }
  }

  /**
   * Many CORS setups refuse the preflight that a `Range` header triggers, or
   * the server ignores ranges entirely. When the very first (ranged) request
   * dies before writing a single byte, retry once as a plain GET.
   */
  private canFallBackToPlain(error: unknown): boolean {
    return (
      isLikelyCorsError(error) &&
      this.usedRange &&
      !this.plainRetried &&
      this.receivedBytes === 0 &&
      this.outcome == null
    )
  }

  private async restartPlain(): Promise<void> {
    this.plainRetried = true
    this.usedRange = false
    this.supportsRanges = false
    this.segmented = false
    this.splitDone = true
    this.firstResponseSeen = false
    this.gate = null
    this.segments = buildSegments(this.totalBytes, 1, false)
    this.deps.callbacks.onSegments(this.getSegments())
    this.phase = 'running'
    try {
      await this.execute()
    } catch (error) {
      if (this.isStopped()) return
      this.fail(error)
    }
  }

  private isStopped(): boolean {
    return (this.phase as Phase) === 'stopped'
  }

  private isRunning(): boolean {
    return (this.phase as Phase) === 'running'
  }

  private createGate(): { promise: Promise<'segmented' | 'single'>; resolve: (v: 'segmented' | 'single') => void } {
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
    const { url, maxRetries } = this.config
    let attempt = 0
    const rangeRequested = this.usedRange

    while (this.phase === 'running') {
      if (segment.status === 'done') return
      const controller = new AbortController()
      this.controllers.add(controller)
      segment.attempts = attempt
      segment.status = attempt === 0 ? 'active' : 'retrying'
      this.emitSegments()

      const start = segment.start + segment.received
      const range =
        rangeRequested && this.totalBytes != null
          ? `bytes=${start}-${segment.end}`
          : rangeRequested
            ? `bytes=${start}-`
            : undefined
      const headers = this.requestHeaders(Boolean(range), range)

      try {
        const response = await fetch(url, {
          headers,
          signal: controller.signal,
          mode: 'cors',
          credentials: 'omit',
          redirect: 'follow',
        })

        const mode = this.ingestResponse(response, segment)
        if (mode === 'collapse') {
          // The server ignored `Range`: this response is the entire file.
          // Reuse it as a single stream from byte 0 and kill every sibling
          // worker (their responses are also full copies, not their ranges).
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
          this.segments = [segment]
          this.emitSegments()
        }
        if (gate) await gate
        if (this.phase !== 'running') {
          controller.abort()
          return
        }
        if (mode === 'done') {
          this.controllers.delete(controller)
          segment.status = 'done'
          this.emitSegments()
          if (this.allSegmentsDone()) await this.finalize()
          return
        }

        // A 200 to a ranged request means the server ignored the header: the
        // body starts at byte 0, not at our segment offset. Skip the leading
        // bytes so the write cursor stays aligned with the file.
        const skipBytes = response.status === 200 && rangeRequested ? segment.start + segment.received : 0
        await this.consume(response, segment, controller, skipBytes)
        this.controllers.delete(controller)
        return
      } catch (error) {
        this.controllers.delete(controller)
        if (this.phase !== 'running') return
        if (isAbort(error)) return

        attempt += 1
        if (responseIsFatal(error) || attempt > maxRetries) throw error
        segment.status = 'retrying'
        segment.attempts = attempt
        // Without range support a retry re-streams the whole file from its
        // start; rewind the segment so the bytes land at the right offsets.
        if (!rangeRequested && segment.received > 0) {
          segment.received = 0
          this.receivedBytes = this.sumReceived()
        }
        this.emitSegments()
        await sleep(backoffFor(attempt))
      }
    }
  }

  /**
   * Reads the response headers and decides whether the server honours ranges.
   * Returns 'done' when the segment turned out to be already complete and
   * 'collapse' when a segmented download must fall back to a single stream.
   */
  private ingestResponse(
    response: Response,
    segment: SegmentState,
  ): 'segmented' | 'single' | 'collapse' | 'done' {
    const contentLength = readContentLength(response)

    if (!this.firstResponseSeen) {
      this.firstResponseSeen = true
      if (response.status === 206) {
        this.supportsRanges = true
        if (this.totalBytes == null && contentLength != null) {
          this.totalBytes = segment.start + contentLength
          this.emitMeta()
        }
        this.gate?.resolve('segmented')
      } else if (response.status === 200) {
        this.supportsRanges = false
        if (this.totalBytes == null && contentLength != null) {
          this.totalBytes = contentLength
          this.emitMeta()
        }
        if (this.segmented) {
          // The server ignored `Range`: this response is the entire file, so
          // collapse back to a single streaming connection and reuse it.
          // (Handled for *any* segment — whichever response lands first.)
          this.gate?.resolve('single')
          return 'collapse'
        }
        this.gate?.resolve('single')
        return 'single'
      } else if (this.gate) {
        this.gate.resolve('segmented')
      }
    }

    if (this.totalBytes == null && contentLength != null) {
      this.totalBytes = contentLength
      this.emitMeta()
    }

    if (response.status === 416) {
      // Nothing left for this segment (usually after a resume).
      if (segment.end === Number.POSITIVE_INFINITY) {
        throw new HttpError(`Server responded ${response.status} ${response.statusText}`, response.status)
      }
      segment.received = segment.end - segment.start + 1
      this.emitSegments()
      return 'done'
    }

    if (!response.ok && response.status !== 206) {
      throw new HttpError(`Server responded ${response.status} ${response.statusText}`, response.status)
    }
    return 'segmented'
  }

  private async consume(
    response: Response,
    segment: SegmentState,
    controller: AbortController,
    skipBytes = 0,
  ): Promise<void> {
    const body = response.body
    if (!body) {
      if (!response.ok) throw new HttpError(`Empty response (${response.status})`, response.status)
      return
    }
    const queue = this.writeQueue
    if (!queue) throw new Error('Download sink is not ready')

    const reader = body.getReader()
    let buffer: Uint8Array[] = []
    let buffered = 0
    let offset = segment.start + segment.received
    let inFlight = 0
    let toSkip = skipBytes

    const flush = async (final: boolean): Promise<void> => {
      if (buffered === 0) return
      const chunk = concat(buffer, buffered)
      buffer = []
      buffered = 0
      inFlight += chunk.byteLength
      queue.submit(offset, chunk)
      offset += chunk.byteLength
      segment.received = clampReceived(segment, offset)
      this.receivedBytes = this.sumReceived()
      if (final || inFlight > MAX_PIPELINE_BYTES) {
        await queue.drain()
        inFlight = 0
      }
      this.emitProgress()
      this.maybeSplit(segment)
    }

    try {
      for (;;) {
        if (this.phase !== 'running') {
          controller.abort()
          break
        }
        const read = await reader.read()
        if (read.done) break
        let value = read.value!

        await this.deps.globalLimiter.take(value.byteLength)
        await this.taskLimiter.take(value.byteLength)

        // Discard bytes before our window (server ignored the Range header).
        if (toSkip > 0) {
          if (value.byteLength <= toSkip) {
            toSkip -= value.byteLength
            continue
          }
          value = value.subarray(toSkip)
          toSkip = 0
        }

        const remaining =
          segment.end === Number.POSITIVE_INFINITY ? value.byteLength : Math.max(0, segment.end + 1 - offset)
        if (remaining === 0) {
          await flush(true)
          break
        }
        const chunk = remaining < value.byteLength ? value.subarray(0, remaining) : value

        buffer.push(chunk)
        buffered += chunk.byteLength
        if (buffered >= FLUSH_BYTES) await flush(false)
      }
      await flush(true)
      await queue.drain()

      if (this.phase !== 'running') return

      if (segment.end === Number.POSITIVE_INFINITY) {
        segment.end = segment.start + segment.received - 1
        segment.status = 'done'
      } else if (segment.received >= segment.end - segment.start + 1) {
        segment.status = 'done'
      }
      this.emitSegments()

      if (this.allSegmentsDone()) await this.finalize()
    } catch (error) {
      try {
        await reader.cancel()
      } catch {
        /* ignore */
      }
      throw error
    } finally {
      buffer = []
    }
  }

  /** aria2-style dynamic splitting: learn the size mid-download, then fan out. */
  private maybeSplit(segment: SegmentState): void {
    if (this.splitDone || this.segmented || this.phase !== 'running') return
    if (!this.totalBytes || this.totalBytes < MIN_SEGMENT_BYTES * 4) return
    if (segment.end !== Number.POSITIVE_INFINITY) return

    const received = segment.received
    const remaining = this.totalBytes - received
    const extra = Math.min(this.config.connections - 1, Math.floor(remaining / MIN_SEGMENT_BYTES) - 1)
    if (extra < 1 || remaining < MIN_SEGMENT_BYTES * 2) return

    const splitAt = received + Math.floor(remaining / (extra + 1))
    segment.end = splitAt - 1
    this.splitDone = true
    this.segmented = true
    this.supportsRanges = true

    const chunk = Math.floor((this.totalBytes - splitAt) / extra)
    for (let i = 0; i < extra; i += 1) {
      const start = splitAt + i * chunk
      const end = i === extra - 1 ? this.totalBytes - 1 : start + chunk - 1
      this.segments.push({
        index: this.segments.length,
        start,
        end,
        received: 0,
        status: 'idle',
        attempts: 0,
        speed: 0,
      })
    }
    this.emitSegments()

    for (const seg of this.segments.slice(1)) {
      if (seg.status !== 'idle') continue
      seg.status = 'active'
      void this.runWorker(seg).catch((error) => {
        if (this.phase === 'running' && this.outcome == null) this.fail(error)
      })
    }
  }

  private allSegmentsDone(): boolean {
    return this.segments.length > 0 && this.segments.every((s) => s.status === 'done')
  }

  private async finalize(): Promise<void> {
    if (this.outcome) return
    const queue = this.writeQueue
    const sink = this.sink
    if (!queue || !sink) return
    this.phase = 'finalizing'
    this.deps.callbacks.onStatus('finalizing')
    await queue.stop()
    const size = this.receivedBytes
    const result = await sink.finish(size, this.filename)
    this.outcome = 'completed'
    this.phase = 'done'
    this.deps.callbacks.onProgress(this.receivedBytes)
    this.deps.callbacks.onComplete({ ...result, saveMode: sink.mode })
  }

  // ----------------------------------------------------------------- utils

  private requestHeaders(withRange: boolean, range?: string): Record<string, string> {
    return buildRequestHeaders(this.config.auth, this.config.headers, withRange && range ? { Range: range } : undefined)
  }

  private getSegments(): SegmentState[] {
    return this.segments.map((s) => ({ ...s }))
  }

  private sumReceived(): number {
    let total = 0
    for (const seg of this.segments) total += seg.received
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
    })
  }

  private emitProgress(): void {
    const now = Date.now()
    if (now - this.lastProgressEmit < 100) return
    this.lastProgressEmit = now
    this.deps.callbacks.onProgress(this.receivedBytes)
  }

  private fail(error: unknown): void {
    const message =
      error instanceof HttpError || error instanceof Error ? error.message : String(error)
    this.currentError = message
    this.outcome = 'failed'
    this.phase = 'idle'
    this.deps.callbacks.onSegments(
      this.segments.map((s) =>
        s.status === 'active' || s.status === 'retrying' ? { ...s, status: 'error' as const } : { ...s },
      ),
    )
    this.deps.callbacks.onStatus('failed', message)
  }

  private abortControllers(reason: string): void {
    for (const controller of this.controllers) controller.abort(new Error(reason))
    this.controllers.clear()
  }
}

export function buildSegments(
  totalBytes: number | null,
  connections: number,
  allowSplit: boolean,
): SegmentState[] {
  const single = (end: number): SegmentState[] => [
    { index: 0, start: 0, end, received: 0, status: 'idle', attempts: 0, speed: 0 },
  ]
  if (!allowSplit) return single(totalBytes != null ? totalBytes - 1 : Number.POSITIVE_INFINITY)
  if (totalBytes == null || totalBytes <= 0) return single(Number.POSITIVE_INFINITY)

  const maxConnections = Math.max(1, Math.min(connections, Math.floor(totalBytes / MIN_SEGMENT_BYTES) || 1))
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

function readContentLength(response: Response): number | null {
  const raw = response.headers.get('Content-Length')
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function clampReceived(segment: SegmentState, offset: number): number {
  if (segment.end === Number.POSITIVE_INFINITY) return offset - segment.start
  return Math.min(segment.end - segment.start + 1, Math.max(0, offset - segment.start))
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

function backoffFor(attempt: number): number {
  const base = Math.min(20_000, 400 * 2 ** (attempt - 1))
  return base + Math.random() * 250
}

function responseIsFatal(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function checkpointSink(sink: Sink | null): Promise<void> {
  if (!sink) return
  const candidate = sink as { checkpoint?: () => Promise<void> }
  if (typeof candidate.checkpoint === 'function') await candidate.checkpoint()
}

function sinkFilename(sink: Sink): string | null {
  const candidate = sink as { filename?: unknown }
  return typeof candidate.filename === 'string' && candidate.filename ? candidate.filename : null
}
