/**
 * Integration tests for the download engine. They run in Node against the
 * dev server's `/testfile/*` endpoint (start `npm run dev` first) and verify
 * that the assembled bytes are exactly what the server generated.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { TaskRunner, buildSegments } from './taskRunner'
import { RateLimiter } from './rateLimiter'
import { StreamSink } from './sinks/streamSink'
import { WriteQueue } from './writeQueue'
import type { Sink, SinkContext, SinkResult } from './sinks/types'
import { DEFAULT_AUTH, type DownloadStatus, type SegmentState } from '../../types'

const BASE =
  process.env.FLUX_TEST_BASE ??
  (globalThis as { __FLUX_TEST_SERVER__?: { base: string } }).__FLUX_TEST_SERVER__?.base ??
  'http://localhost:5173'

/** Random-access sink that keeps bytes in memory for verification. */
class TestSink implements Sink {
  readonly mode = 'memory' as const
  resumable = true as boolean
  durable = false as boolean
  buffer = new Uint8Array(0)
  writes = 0
  async write(offset: number, chunk: Uint8Array): Promise<void> {
    this.writes += 1
    if (offset + chunk.byteLength > this.buffer.byteLength) {
      const next = new Uint8Array(offset + chunk.byteLength)
      next.set(this.buffer)
      this.buffer = next
    }
    this.buffer.set(chunk, offset)
  }
  async finish(size: number, filename: string): Promise<SinkResult> {
    return { size, filename }
  }
  async abort(): Promise<void> {}
}

function expectedByte(p: number): number {
  return (p * 31 + ((p >>> 8) * 17) + ((p >>> 16) * 7)) & 0xff
}

function verify(buf: Uint8Array, size: number): void {
  expect(buf.byteLength).toBe(size)
  for (let i = 0; i < size; i += 4099) expect(buf[i]).toBe(expectedByte(i))
  expect(buf[size - 1]).toBe(expectedByte(size - 1))
}

interface Run {
  runner: TaskRunner
  sink: TestSink
  statuses: DownloadStatus[]
  segments: () => SegmentState[]
  done: Promise<SinkResult>
}

function run(url: string, opts: Partial<{ connections: number; speedLimit: number; auth: typeof DEFAULT_AUTH; globalLimit: number }> = {}): Run {
  const sink = new TestSink()
  const statuses: DownloadStatus[] = []
  let segs: SegmentState[] = []
  let resolve!: (r: SinkResult) => void
  let reject!: (e: Error) => void
  const done = new Promise<SinkResult>((res, rej) => { resolve = res; reject = rej })
  const runner = new TaskRunner(
    { id: 't', url, filename: 'x.bin', connections: opts.connections ?? 4, speedLimit: opts.speedLimit ?? 0, maxRetries: 3, auth: opts.auth ?? DEFAULT_AUTH, headers: [] },
    {
      globalLimiter: new RateLimiter(opts.globalLimit ?? 0),
      sinkFactory: async (_ctx: SinkContext) => sink,
      callbacks: {
        onMeta: () => {},
        onSegments: (s) => { segs = s },
        onStatus: (s, err) => { statuses.push(s); if (s === 'failed') reject(new Error(err ?? 'failed')) },
        onProgress: () => {},
        onSaveMode: () => {},
        onComplete: (r) => resolve(r),
      },
    },
  )
  return { runner, sink, statuses, segments: () => segs, done }
}

beforeAll(async () => {
  const res = await fetch(`${BASE}/testfile/1kb`, { method: 'HEAD' })
  if (!res.ok) throw new Error(`test server not reachable at ${BASE}`)
})

afterAll(async () => {
  // The setup file boots a private /testfile server; close it so vitest exits.
  const server = (globalThis as { __FLUX_TEST_SERVER__?: { server: { closeAllConnections?(): void; close(cb: () => void): void } } }).__FLUX_TEST_SERVER__?.server
  if (server) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

describe('buildSegments', () => {
  it('splits evenly and covers every byte', () => {
    const segs = buildSegments(10_000_000, 8, true)
    expect(segs).toHaveLength(8)
    expect(segs[0]!.start).toBe(0)
    expect(segs.at(-1)!.end).toBe(9_999_999)
    for (let i = 1; i < segs.length; i += 1) expect(segs[i]!.start).toBe(segs[i - 1]!.end + 1)
  })
  it('never makes segments smaller than the minimum', () => {
    expect(buildSegments(600_000, 8, true)).toHaveLength(1)
  })
  it('uses one open-ended segment when size is unknown', () => {
    const segs = buildSegments(null, 8, true)
    expect(segs).toHaveLength(1)
    expect(segs[0]!.end).toBe(Number.POSITIVE_INFINITY)
  })
})

describe('TaskRunner', () => {
  it('downloads with multiple connections and assembles bytes exactly', async () => {
    const size = 6 * 1024 * 1024
    const r = run(`${BASE}/testfile/6mb`, { connections: 6 })
    void r.runner.start()
    const result = await r.done
    expect(result.size).toBe(size)
    verify(r.sink.buffer, size)
    expect(r.segments().length).toBe(6)
    expect(r.segments().every((s) => s.status === 'done')).toBe(true)
  }, 30_000)

  it('falls back to a single stream when the server ignores Range', async () => {
    const size = 3 * 1024 * 1024
    const r = run(`${BASE}/testfile/3mb?noranges=1`, { connections: 4 })
    void r.runner.start()
    await r.done
    verify(r.sink.buffer, size)
    expect(r.segments().length).toBe(1)
  }, 30_000)

  it('sends Basic auth credentials', async () => {
    const r = run(`${BASE}/testfile/1mb?auth=flux:demo`, { connections: 2, auth: { kind: 'basic', username: 'flux', password: 'demo', token: '' } })
    void r.runner.start()
    await r.done
    verify(r.sink.buffer, 1024 * 1024)
  }, 30_000)

  it('fails cleanly with a 401 when credentials are wrong', async () => {
    const r = run(`${BASE}/testfile/1mb?auth=flux:demo`, { connections: 2 })
    void r.runner.start()
    await expect(r.done).rejects.toThrow(/401/)
  }, 30_000)

  it('pauses and resumes without corrupting data', async () => {
    const size = 40 * 1024 * 1024
    const r = run(`${BASE}/testfile/40mb?delay=10`, { connections: 4 })
    void r.runner.start()
    await new Promise((res) => setTimeout(res, 600))
    await r.runner.pause()
    const snap = r.runner.getSnapshot()
    expect(r.runner.getStatus()).toBe('paused')
    expect(snap.receivedBytes).toBeGreaterThan(0)
    expect(snap.receivedBytes).toBeLessThan(size)
    await new Promise((res) => setTimeout(res, 200))
    const afterPause = r.runner.getSnapshot().receivedBytes
    expect(afterPause).toBe(snap.receivedBytes)
    void r.runner.start()
    await r.done
    verify(r.sink.buffer, size)
  }, 40_000)

  it('honours the speed limit', async () => {
    const size = 1024 * 1024
    const r = run(`${BASE}/testfile/1mb`, { connections: 2, speedLimit: 512 * 1024 })
    const t0 = Date.now()
    void r.runner.start()
    await r.done
    const elapsed = (Date.now() - t0) / 1000
    verify(r.sink.buffer, size)
    expect(elapsed).toBeGreaterThan(1.4)
  }, 30_000)

  it('cancel stops all connections', async () => {
    const r = run(`${BASE}/testfile/20mb?delay=2`, { connections: 4 })
    void r.runner.start()
    await new Promise((res) => setTimeout(res, 400))
    await r.runner.cancel()
    expect(r.runner.getStatus()).toBe('canceled')
    const bytes = r.runner.getSnapshot().receivedBytes
    await new Promise((res) => setTimeout(res, 400))
    expect(r.runner.getSnapshot().receivedBytes).toBe(bytes)
  }, 30_000)

  it('pausing a non-resumable sink resets progress and still completes', async () => {
    const size = 20 * 1024 * 1024
    const sink = new TestSink()
    sink.resumable = false // stream-sink semantics: nothing can be rewound
    const statuses: DownloadStatus[] = []
    let resolve!: (r: SinkResult) => void
    let reject!: (e: Error) => void
    const done = new Promise<SinkResult>((res, rej) => { resolve = res; reject = rej })
    const runner = new TaskRunner(
      { id: 'nr', url: `${BASE}/testfile/20mb?delay=20`, filename: 'nr.bin', connections: 4, speedLimit: 0, maxRetries: 3, auth: DEFAULT_AUTH, headers: [] },
      {
        globalLimiter: new RateLimiter(0),
        sinkFactory: async () => sink,
        callbacks: {
          onMeta: () => {},
          onSegments: () => {},
          onStatus: (s, err) => { statuses.push(s); if (s === 'failed') reject(new Error(err ?? 'failed')) },
          onProgress: () => {},
          onSaveMode: () => {},
          onComplete: (r) => resolve(r),
        },
      },
    )
    void runner.start()
    await new Promise((res) => setTimeout(res, 250))
    await runner.pause()
    // A stream sink cannot seek: the runner must start over from zero.
    expect(runner.getSnapshot().receivedBytes).toBe(0)
    void runner.start()
    const result = await done
    expect(result.size).toBe(size)
    verify(sink.buffer, size)
  }, 40_000)
})

// ---------------------------------------------------------------------------
// Stream sink reordering (regression: out-of-order writes used to deadlock)
// ---------------------------------------------------------------------------

/**
 * Creates a StreamSink whose readable side is drained in the background (the
 * service worker plays this role in the app) and records the byte order in
 * which chunks reach the wire.
 */
function makeRecordingSink() {
  const transform = new TransformStream<Uint8Array, Uint8Array>()
  const sink = new StreamSink(
    { id: 't', filename: 'x.bin', mime: 'application/octet-stream', totalBytes: 8, resumeFrom: 0 },
    transform,
  )
  const wire: number[] = []
  const drained = (async () => {
    const reader = transform.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) wire.push(value[0]!)
    }
  })()
  return { sink, wire, drained }
}

describe('stream sink / write queue reordering', () => {
  it('resolves an out-of-order write once the gap before it fills', async () => {
    const { sink, wire, drained } = makeRecordingSink()
    const late = sink.write(4, new Uint8Array([2, 2, 2, 2]))
    await new Promise((r) => setTimeout(r, 10))
    const early = sink.write(0, new Uint8Array([1, 1, 1, 1]))
    await Promise.all([early, late])
    await sink.finish(8, 'x.bin')
    await drained
    // Bytes must reach the wire in file order even though chunk 2 arrived first.
    expect(wire).toEqual([1, 2])
  }, 5000)

  it('write queue makes progress when the head write is parked', async () => {
    const { sink, wire, drained } = makeRecordingSink()
    const queue = new WriteQueue(sink, 64)
    queue.submit(4, new Uint8Array([2, 2, 2, 2]))
    queue.submit(0, new Uint8Array([1, 1, 1, 1]))
    await queue.stop()
    expect(queue.pending).toBe(0)
    await sink.finish(8, 'x.bin')
    await drained
    expect(wire).toEqual([1, 2])
  }, 5000)

  it('overlapping retransmissions are dropped, not duplicated', async () => {
    const { sink, wire, drained } = makeRecordingSink()
    await sink.write(0, new Uint8Array([1, 1, 1, 1]))
    await sink.write(0, new Uint8Array([9, 9, 9, 9, 2, 2, 2, 2])) // fully + partially overlapped
    await sink.finish(8, 'x.bin')
    await drained
    expect(wire).toEqual([1, 2])
  }, 5000)
})
