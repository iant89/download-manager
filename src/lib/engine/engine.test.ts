/**
 * Integration tests for the download engine. They run in Node against the
 * dev server's `/testfile/*` endpoint (start `npm run dev` first) and verify
 * that the assembled bytes are exactly what the server generated.
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { TaskRunner, buildSegments } from './taskRunner'
import { RateLimiter } from './rateLimiter'
import type { Sink, SinkContext, SinkResult } from './sinks/types'
import { DEFAULT_AUTH, type DownloadStatus, type SegmentState } from '../../types'

const BASE = process.env.FLUX_TEST_BASE ?? 'http://localhost:5173'

/** Random-access sink that keeps bytes in memory for verification. */
class TestSink implements Sink {
  readonly mode = 'memory' as const
  readonly resumable = true
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
  if (!res.ok) throw new Error(`dev server not reachable at ${BASE}`)
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
})
