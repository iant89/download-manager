/**
 * End-to-end engine tests against a misbehaving server (HARDENING_PLAN.md
 * §Testing): short bodies, wrong Content-Range, oversized bodies, 503 with
 * Retry-After, resources that change mid-download or between sessions,
 * checksum verification, durable checkpoints, the connection pool and the
 * scheduler. Every successful run verifies the assembled bytes exactly.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'

import { DEFAULT_AUTH, DEFAULT_SETTINGS, type DownloadStatus, type DownloadTask, EMPTY_DIAGNOSTICS, type SegmentState } from '../../types'
import { expectedByte } from '../../../tests/testServer'
import { TaskRunner, type RunnerStats, type TaskConfig } from './taskRunner'
import { RateLimiter } from './rateLimiter'
import { MemoryCheckpointStore } from './checkpointStore'
import { ConnectionPool } from './connectionPool'
import { DownloadManager, type ManagerEvent } from './manager'
import { MemorySink } from './sinks/memorySink'
import { StreamSink } from './sinks/streamSink'
import type { Sink, SinkContext, SinkResult } from './sinks/types'
import { findInvalidTransition } from './stateMachine'
import { DownloadIntegrityError } from './errors'

const BASE = (globalThis as { __FLUX_TEST_SERVER__?: { base: string } }).__FLUX_TEST_SERVER__!.base
let keySeq = 0
const key = () => `k${Date.now()}-${keySeq++}`

afterAll(async () => {
  const server = (globalThis as { __FLUX_TEST_SERVER__?: { server: { closeAllConnections?(): void; close(cb: () => void): void } } }).__FLUX_TEST_SERVER__?.server
  if (server) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/** Random-access sink standing in for a file on disk; `durable` is configurable. */
class DiskSink implements Sink {
  readonly mode = 'fsa' as const
  readonly resumable = true
  checkpoints = 0
  constructor(
    public buffer: Uint8Array = new Uint8Array(0),
    readonly durable = true,
  ) {}
  async write(offset: number, chunk: Uint8Array): Promise<void> {
    if (offset + chunk.byteLength > this.buffer.byteLength) {
      const next = new Uint8Array(offset + chunk.byteLength)
      next.set(this.buffer)
      this.buffer = next
    }
    this.buffer.set(chunk, offset)
  }
  async checkpoint(): Promise<void> {
    this.checkpoints += 1
  }
  async finish(size: number, filename: string): Promise<SinkResult> {
    if (this.buffer.byteLength < size) throw new DownloadIntegrityError(`short file ${this.buffer.byteLength} < ${size}`)
    this.buffer = this.buffer.subarray(0, size)
    return { size, filename }
  }
  async abort(): Promise<void> {}
}

function verify(buf: Uint8Array, size: number): void {
  expect(buf.byteLength).toBe(size)
  // Every byte, not a sample: these tests exist to catch misplaced bytes.
  for (let i = 0; i < size; i += 1) {
    if (buf[i] !== expectedByte(i)) throw new Error(`byte ${i}: expected ${expectedByte(i)}, got ${buf[i]}`)
  }
}

function sha256Of(size: number): string {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) data[i] = expectedByte(i)
  return createHash('sha256').update(data).digest('hex')
}

interface Harness {
  runner: TaskRunner
  statuses: DownloadStatus[]
  stats: () => RunnerStats
  segments: () => SegmentState[]
  done: Promise<SinkResult>
}

function harness(
  url: string,
  sinkFactory: (ctx: SinkContext) => Promise<Sink>,
  opts: Partial<TaskConfig> & { store?: MemoryCheckpointStore; pool?: ConnectionPool; initial?: ConstructorParameters<typeof TaskRunner>[2] } = {},
): Harness {
  const statuses: DownloadStatus[] = []
  let stats: RunnerStats = { ...EMPTY_DIAGNOSTICS }
  let segs: SegmentState[] = []
  let resolve!: (r: SinkResult) => void
  let reject!: (e: Error) => void
  const done = new Promise<SinkResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  done.catch(() => undefined)
  const { store, pool, initial, ...config } = opts
  const runner = new TaskRunner(
    { id: opts.id ?? 't', url, filename: 'x.bin', connections: 4, speedLimit: 0, maxRetries: 4, auth: DEFAULT_AUTH, headers: [], ...config },
    {
      globalLimiter: new RateLimiter(0),
      sinkFactory,
      checkpointStore: store,
      connectionPool: pool,
      callbacks: {
        onMeta: () => {},
        onSegments: (s) => (segs = s),
        onStatus: (s, err) => {
          statuses.push(s)
          if (s === 'failed') reject(new Error(err ?? 'failed'))
        },
        onProgress: () => {},
        onSaveMode: () => {},
        onStats: (s) => (stats = s),
        onComplete: (r) => resolve(r),
      },
    },
    initial,
  )
  return { runner, statuses, stats: () => stats, segments: () => segs, done }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
describe('faulty servers', () => {
  it('re-requests the remainder after a short body', async () => {
    const size = 3 * 1024 * 1024
    const sink = new DiskSink()
    const h = harness(`${BASE}/testfile/3mb?fault=short&times=2&key=${key()}`, async () => sink)
    void h.runner.start()
    await h.done
    verify(sink.buffer, size)
    expect(h.stats().integrityErrors).toBeGreaterThan(0)
    expect(h.stats().automaticRetryCount).toBeGreaterThan(0)
  })

  it('never writes bytes from a wrong Content-Range', async () => {
    const size = 2 * 1024 * 1024
    const sink = new DiskSink()
    const h = harness(`${BASE}/testfile/2mb?fault=badrange&times=2&key=${key()}`, async () => sink)
    void h.runner.start()
    await h.done
    verify(sink.buffer, size)
    expect(h.stats().rangeErrors).toBeGreaterThan(0)
  })

  it('does not let an oversized body overwrite the next segment', async () => {
    const size = 4 * 1024 * 1024
    const sink = new DiskSink()
    const h = harness(`${BASE}/testfile/4mb?fault=overflow&times=3&key=${key()}`, async () => sink)
    void h.runner.start()
    await h.done
    verify(sink.buffer, size)
  })

  it('waits out a 503 with Retry-After and completes', async () => {
    const sink = new DiskSink()
    const t0 = Date.now()
    const h = harness(`${BASE}/testfile/1mb?fault=503&times=1&retryafter=1&key=${key()}`, async () => sink, { connections: 1 })
    void h.runner.start()
    await h.done
    verify(sink.buffer, 1024 * 1024)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    expect(h.stats().httpErrors).toBeGreaterThan(0)
  })

  it('credits only verified bytes when Content-Range is hidden', async () => {
    const sink = new DiskSink()
    const h = harness(`${BASE}/testfile/2mb?nocr=1&key=${key()}`, async () => sink)
    void h.runner.start()
    await h.done
    verify(sink.buffer, 2 * 1024 * 1024)
    expect(h.stats().unverifiedRanges).toBe(true)
  })

  it('fails with "changed" when the ETag changes mid-download', async () => {
    const sink = new DiskSink()
    const h = harness(`${BASE}/testfile/8mb?fault=etag&times=1&delay=5&key=${key()}`, async () => sink, { connections: 4 })
    void h.runner.start()
    await expect(h.done).rejects.toThrow(/changed/i)
  })

  it('fails with "changed" when the size changes mid-download', async () => {
    const sink = new DiskSink()
    const h = harness(`${BASE}/testfile/8mb?fault=size&times=1&delay=5&key=${key()}`, async () => sink, { connections: 4 })
    void h.runner.start()
    await expect(h.done).rejects.toThrow(/changed/i)
  })

  it('treats an unexpected 416 inside the file as fatal, not complete', async () => {
    const sink = new DiskSink()
    const h = harness(`${BASE}/testfile/2mb?fault=416&times=99&key=${key()}`, async () => sink, { connections: 2 })
    void h.runner.start()
    await expect(h.done).rejects.toThrow()
    expect(h.statuses).not.toContain('completed')
  })

  it('follows the status state machine', async () => {
    const sink = new DiskSink()
    const h = harness(`${BASE}/testfile/2mb?key=${key()}`, async () => sink)
    void h.runner.start()
    await h.done
    expect(findInvalidTransition(['queued', ...h.statuses])).toBeNull()
    expect(h.statuses).toContain('verifying')
    expect(h.statuses.at(-1)).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
describe('checksum verification', () => {
  it('reports a verified checksum on a match', async () => {
    const size = 1024 * 1024
    const h = harness(`${BASE}/testfile/1mb?key=${key()}`, async (ctx) => new MemorySink(ctx), { checksum: sha256Of(size) })
    void h.runner.start()
    const result = await h.done
    expect(result.checksum).toMatchObject({ verified: true, value: sha256Of(size) })
  })

  it('fails the download on a mismatch', async () => {
    const h = harness(`${BASE}/testfile/1mb?key=${key()}`, async (ctx) => new MemorySink(ctx), { checksum: 'a'.repeat(64) })
    void h.runner.start()
    await expect(h.done).rejects.toThrow(/mismatch/i)
    expect(h.stats().integrityErrors).toBeGreaterThan(0)
  })

  it('stream sink hashes in order and refuses to finish short', async () => {
    const transform = new TransformStream<Uint8Array, Uint8Array>()
    const drained = transform.readable.pipeTo(new WritableStream())
    const sink = new StreamSink({ id: 's', filename: 's.bin', mime: 'x', totalBytes: 8, resumeFrom: 0 }, transform)
    await sink.write(0, new Uint8Array([1, 2, 3, 4]))
    await expect(sink.finish(8, 's.bin')).rejects.toThrow(DownloadIntegrityError)
    await drained.catch(() => undefined)
  })
})

// ---------------------------------------------------------------------------
describe('durable checkpoints', () => {
  it('pause writes a checkpoint that a fresh runner resumes from', async () => {
    const size = 24 * 1024 * 1024
    const store = new MemoryCheckpointStore()
    const k = key()
    const url = `${BASE}/testfile/24mb?delay=10&key=${k}`
    const disk = new DiskSink()
    const first = harness(url, async () => disk, { id: 'cp', store })
    void first.runner.start()
    await sleep(500)
    await first.runner.pause()
    expect(first.runner.getStatus()).toBe('paused')
    expect(findInvalidTransition(['queued', ...first.statuses])).toBeNull()
    expect(disk.checkpoints).toBeGreaterThan(0)
    const saved = await store.load('cp')
    expect(saved).not.toBeNull()
    expect(saved!.bytesWritten).toBeGreaterThan(0)
    expect(saved!.bytesWritten).toBeLessThan(size)
    expect(saved!.resource.etag).toBe(`"flux-${size}"`)

    // Simulate a reload: throw the runner away, keep only the disk + checkpoint.
    await first.runner.dispose()
    const reopened = new DiskSink(disk.buffer)
    let resumeFrom = -1
    const second = harness(
      url,
      async (ctx) => {
        resumeFrom = ctx.resumeFrom
        return reopened
      },
      { id: 'cp', store, initial: { checkpoint: saved! } },
    )
    expect(second.runner.getStatus()).toBe('paused')
    expect(second.runner.getSnapshot().receivedBytes).toBe(saved!.bytesWritten)
    void second.runner.start()
    await second.done
    expect(resumeFrom).toBe(saved!.bytesWritten)
    expect(second.stats().ifRange).toBe(true)
    verify(reopened.buffer, size)
    expect(await store.load('cp')).toBeNull() // cleared on completion
  }, 60_000)

  it('non-durable sinks never persist a checkpoint', async () => {
    const store = new MemoryCheckpointStore()
    const sink = new DiskSink(new Uint8Array(0), false)
    const h = harness(`${BASE}/testfile/16mb?delay=10&key=${key()}`, async () => sink, { id: 'nd', store })
    void h.runner.start()
    await sleep(400)
    await h.runner.pause()
    expect(store.saves).toBe(0)
    expect(await store.load('nd')).toBeNull()
    await h.runner.cancel()
  }, 30_000)

  it('a restored checkpoint for a replaced file fails instead of splicing', async () => {
    const store = new MemoryCheckpointStore()
    const k = key()
    const disk = new DiskSink()
    const first = harness(`${BASE}/testfile/16mb?delay=10&key=${k}`, async () => disk, { id: 'rc', store })
    void first.runner.start()
    await sleep(400)
    await first.runner.pause()
    const saved = (await store.load('rc'))!
    await first.runner.dispose()
    // Same URL shape, but the server now reports a different ETag.
    const second = harness(`${BASE}/testfile/16mb?delay=10&etag=other&key=${k}`, async () => new DiskSink(disk.buffer), {
      id: 'rc',
      store,
      initial: { checkpoint: saved },
    })
    void second.runner.start()
    await expect(second.done).rejects.toThrow(/changed/i)
    expect(await store.load('rc')).toBeNull()
  }, 30_000)
})

// ---------------------------------------------------------------------------
describe('shared limits', () => {
  it('the connection pool caps per-host connections across segments', async () => {
    const pool = new ConnectionPool({ global: 10, perHost: 2 })
    let peak = 0
    const timer = setInterval(() => (peak = Math.max(peak, pool.stats().total)), 5)
    const sink = new DiskSink()
    const h = harness(`${BASE}/testfile/6mb?delay=2&key=${key()}`, async () => sink, { connections: 6, pool })
    void h.runner.start()
    await h.done
    clearInterval(timer)
    verify(sink.buffer, 6 * 1024 * 1024)
    expect(peak).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(2)
  }, 30_000)

  it('a shared global limiter caps the combined speed of several downloads (P2-12)', async () => {
    const limiter = new RateLimiter(512 * 1024)
    const sinks = [new DiskSink(), new DiskSink()]
    const runs = sinks.map((sink, i) => {
      const statuses: DownloadStatus[] = []
      let resolve!: () => void
      const done = new Promise<void>((r) => (resolve = r))
      const runner = new TaskRunner(
        { id: `g${i}`, url: `${BASE}/testfile/512kb?key=${key()}`, filename: 'g.bin', connections: 2, speedLimit: 0, maxRetries: 2, auth: DEFAULT_AUTH, headers: [] },
        {
          globalLimiter: limiter,
          sinkFactory: async () => sink,
          callbacks: { onMeta() {}, onSegments() {}, onStatus: (s) => statuses.push(s), onProgress() {}, onSaveMode() {}, onComplete: () => resolve() },
        },
      )
      return { runner, done }
    })
    const t0 = Date.now()
    for (const r of runs) void r.runner.start()
    await Promise.all(runs.map((r) => r.done))
    const elapsed = (Date.now() - t0) / 1000
    for (const sink of sinks) verify(sink.buffer, 512 * 1024)
    // 1 MiB at 512 KiB/s ≈ 2 s (minus the limiter's initial burst).
    expect(elapsed).toBeGreaterThan(1.3)
  }, 30_000)

  it('the manager never runs more downloads than allowed and honours priority', async () => {
    const tasks: Record<string, DownloadTask> = {}
    const running = new Set<string>()
    const started: string[] = []
    let peak = 0
    const settings = { ...DEFAULT_SETTINGS, maxConcurrentDownloads: 1 }
    const completions: Record<string, () => void> = {}
    const finished = (id: string) => new Promise<void>((r) => (completions[id] = r))
    const manager = new DownloadManager(
      {
        getSettings: () => settings,
        getTask: (id) => tasks[id],
        emit: (event: ManagerEvent) => {
          if (event.type !== 'status') return
          if (event.status === 'probing' && !running.has(event.id)) {
            running.add(event.id)
            started.push(event.id)
            peak = Math.max(peak, running.size)
          }
          if (event.status === 'completed' || event.status === 'failed') {
            running.delete(event.id)
            completions[event.id]?.()
          }
        },
      },
      { checkpointStore: new MemoryCheckpointStore(), sinkFactory: async () => new DiskSink() },
    )
    const make = (id: string, priority: number, queuedAt: number): DownloadTask => ({
      id, url: `${BASE}/testfile/512kb?key=${key()}`, filename: `${id}.bin`, mime: 'x', totalBytes: null, connections: 2,
      speedLimit: 0, maxRetries: 2, auth: DEFAULT_AUTH, headers: [], status: 'queued', receivedBytes: 0, createdAt: 0,
      startedAt: null, completedAt: null, error: null, supportsRanges: false, segments: [], speedHistory: [], speed: 0,
      saveMode: null, terminalFailureCount: 0, priority, queuedAt, expectedChecksum: null, checksumVerified: null,
      identity: null, diagnostics: { ...EMPTY_DIAGNOSTICS }, effectiveUrl: '', proxyUsed: false, handleKey: null,
      awaitingTarget: false, resultUrl: null,
    })
    tasks.a = make('a', 0, 1)
    tasks.b = make('b', 0, 2)
    tasks.c = make('c', 10, 3)
    const all = Promise.all(['a', 'b', 'c'].map(finished))
    for (const id of ['a', 'b', 'c']) manager.createRunner(tasks[id]!)
    manager.enqueue('a')
    manager.enqueue('b')
    manager.enqueue('c')
    await all
    expect(peak).toBe(1)
    // `a` grabbed the free slot immediately; then priority beats FIFO.
    expect(started).toEqual(['a', 'c', 'b'])
  }, 30_000)
})
