/**
 * Telemetry granularity: the throughput graphs are driven by `onProgress`, so
 * progress has to move while the transfer is in flight — not jump from 0 to
 * the final size when the last 1 MiB flush is acknowledged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TaskRunner } from './taskRunner'
import { RateLimiter } from './rateLimiter'
import type { Sink, SinkContext, SinkResult } from './sinks/types'
import { DEFAULT_AUTH } from '../../types'

const BASE =
  (globalThis as { __FLUX_TEST_SERVER__?: { base: string } }).__FLUX_TEST_SERVER__?.base ??
  'http://localhost:5173'

class NullSink implements Sink {
  readonly mode = 'memory' as const
  resumable = true as boolean
  durable = false as boolean
  async write(): Promise<void> {}
  async finish(size: number, filename: string): Promise<SinkResult> {
    return { size, filename }
  }
  async abort(): Promise<void> {}
}

beforeAll(async () => {
  const res = await fetch(`${BASE}/testfile/1kb`, { method: 'HEAD' })
  if (!res.ok) throw new Error(`test server not reachable at ${BASE}`)
})

afterAll(async () => {
  const server = (globalThis as { __FLUX_TEST_SERVER__?: { server: { closeAllConnections?(): void; close(cb: () => void): void } } }).__FLUX_TEST_SERVER__?.server
  if (server) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/** Every progress value the runner reports for one download. */
async function progressTrace(url: string, connections: number): Promise<number[]> {
  const sink = new NullSink()
  const seen: number[] = []
  let resolve!: (r: SinkResult) => void
  let reject!: (e: Error) => void
  const done = new Promise<SinkResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  const runner = new TaskRunner(
    { id: 'telemetry', url, filename: 'x.bin', connections, speedLimit: 0, maxRetries: 2, auth: DEFAULT_AUTH, headers: [] },
    {
      globalLimiter: new RateLimiter(0),
      sinkFactory: async (_ctx: SinkContext) => sink,
      callbacks: {
        onMeta: () => {},
        onSegments: () => {},
        onStatus: (s, err) => {
          if (s === 'failed') reject(new Error(err ?? 'failed'))
        },
        onProgress: (receivedBytes) => seen.push(receivedBytes),
        onSaveMode: () => {},
        onComplete: (r) => resolve(r),
      },
    },
  )
  void runner.start()
  const result = await done
  expect(seen.at(-1)).toBe(result.size)
  return seen
}

describe('progress telemetry', () => {
  it('moves while the transfer is in flight', async () => {
    // 8 MiB over 8 connections, throttled so the run lasts ~1.6 s: plenty of
    // time for several progress reports if bytes are credited as they arrive.
    const size = 8 * 1024 * 1024
    const trace = await progressTrace(`${BASE}/testfile/8mb?delay=100&key=telemetry-live`, 8)
    const inFlight = trace.filter((v) => v > 0 && v < size)
    expect(inFlight.length, `trace: ${trace.join(',')}`).toBeGreaterThanOrEqual(4)
  }, 30_000)

  it('is most of the way there before the final report', async () => {
    // A graph whose only non-zero sample is the completed size cannot show a
    // transfer in progress; the sample before the last one has to be real.
    const size = 8 * 1024 * 1024
    const trace = await progressTrace(`${BASE}/testfile/8mb?delay=100&key=telemetry-steps`, 8)
    expect(trace.length, `trace: ${trace.join(',')}`).toBeGreaterThan(2)
    expect(trace[trace.length - 2]!, `trace: ${trace.join(',')}`).toBeGreaterThan(size * 0.5)
  }, 30_000)
})
