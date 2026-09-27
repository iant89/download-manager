/**
 * The 500 ms sampler that feeds the throughput graphs. A download that
 * finishes between two samples must still contribute its last interval,
 * otherwise short transfers leave an all-zero history behind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/engine/handleStore', () => ({
  handleStore: {
    getFile: vi.fn(async () => null),
    setFile: vi.fn(),
    deleteFile: vi.fn(),
    getDirectory: vi.fn(async () => null),
    getDirectoryName: vi.fn(async () => null),
    setDirectory: vi.fn(),
  },
}))

// Hoisted above the imports: the store's persist middleware touches
// localStorage as soon as it is created, and node has none.
vi.hoisted(() => {
  if (globalThis.localStorage) return
  const map = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    },
  })
})

import { useStore } from './useStore'
import { DEFAULT_AUTH, EMPTY_DIAGNOSTICS, type DownloadTask } from '../types'

function task(patch: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'a', url: 'https://example.com/a', filename: 'a.bin', mime: 'application/octet-stream',
    totalBytes: 10_000_000, connections: 4, speedLimit: 0, maxRetries: 3, auth: { ...DEFAULT_AUTH }, headers: [],
    status: 'downloading', receivedBytes: 0, createdAt: 1, startedAt: 1, completedAt: null, error: null,
    supportsRanges: true, segments: [], speed: 0, speedHistory: [], saveMode: 'memory',
    terminalFailureCount: 0, priority: 0, queuedAt: 1, expectedChecksum: null, checksumVerified: null,
    identity: null, diagnostics: { ...EMPTY_DIAGNOSTICS }, effectiveUrl: 'https://example.com/a',
    proxyUsed: false, handleKey: null, awaitingTarget: false, resultUrl: null,
    ...patch,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('tick() throughput sampling', () => {
  beforeEach(() => {
    useStore.setState({ tasks: { a: task() }, order: ['a'], globalHistory: [], globalSpeed: 0 })
  })

  afterEach(() => {
    useStore.setState({ tasks: {}, order: [], globalHistory: [], globalSpeed: 0 })
  })

  it('records the last interval of a download that completes between samples', async () => {
    useStore.getState().tick() // primes lastSample at 0 bytes
    await sleep(550)
    // The whole file landed and the task finished before the next sample.
    useStore.setState((s) => ({
      tasks: { ...s.tasks, a: { ...s.tasks.a!, receivedBytes: 10_000_000, status: 'completed', completedAt: Date.now() } },
    }))
    useStore.getState().tick()

    const after = useStore.getState()
    const history = after.tasks.a!.speedHistory
    expect(history.some((v) => v > 0), `history: ${history.join(',')}`).toBe(true)
    expect(after.globalHistory.some((v) => v > 0), `global: ${after.globalHistory.join(',')}`).toBe(true)
    // Roughly 10 MB in ~0.55 s.
    const peak = Math.max(...history)
    expect(peak).toBeGreaterThan(5_000_000)
    expect(peak).toBeLessThan(40_000_000)
  })

  it('keeps sampling a running transfer', async () => {
    useStore.getState().tick()
    for (const received of [2_000_000, 4_000_000, 6_000_000]) {
      await sleep(550)
      useStore.setState((s) => ({ tasks: { ...s.tasks, a: { ...s.tasks.a!, receivedBytes: received } } }))
      useStore.getState().tick()
    }
    const history = useStore.getState().tasks.a!.speedHistory
    expect(history.filter((v) => v > 0).length).toBeGreaterThanOrEqual(3)
  })
})
