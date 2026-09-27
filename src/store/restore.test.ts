/**
 * Reload behaviour (HARDENING_PLAN.md P0-03 / P0-10): what a persisted task
 * looks like after the page comes back.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/engine/handleStore', () => ({
  handleStore: {
    getFile: vi.fn(async (id: string) => (id.startsWith('fsa') ? ({ name: `${id}.bin` } as unknown) : null)),
    setFile: vi.fn(),
    deleteFile: vi.fn(),
    getDirectory: vi.fn(async () => null),
    getDirectoryName: vi.fn(async () => null),
    setDirectory: vi.fn(),
  },
}))

import { getManager, normalizeTask, restoreTask } from './useStore'
import { MemoryCheckpointStore } from '../lib/engine/checkpointStore'
import { CHECKPOINT_VERSION, type DownloadCheckpoint } from '../lib/engine/checkpoint'
import { DEFAULT_AUTH, EMPTY_DIAGNOSTICS, type DownloadTask } from '../types'

afterAll(async () => {
  const server = (globalThis as { __FLUX_TEST_SERVER__?: { server: import('node:http').Server } }).__FLUX_TEST_SERVER__?.server
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const store = getManager().checkpoints as MemoryCheckpointStore

function task(id: string, patch: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id, url: `https://example.com/${id}`, filename: `${id}.bin`, mime: 'x', totalBytes: 300, connections: 3, speedLimit: 0,
    maxRetries: 3, auth: { ...DEFAULT_AUTH }, headers: [], status: 'downloading', receivedBytes: 150, createdAt: 1,
    startedAt: 1, completedAt: null, error: null, supportsRanges: true,
    segments: [
      { index: 0, start: 0, end: 99, received: 100, status: 'done', speed: 0, attempts: 0 },
      { index: 1, start: 100, end: 199, received: 50, status: 'active', speed: 5, attempts: 0 },
      { index: 2, start: 200, end: 299, received: 0, status: 'active', speed: 5, attempts: 0 },
    ],
    speedHistory: [1, 2], speed: 10, saveMode: 'fsa', terminalFailureCount: 0, priority: 0, queuedAt: 1,
    expectedChecksum: null, checksumVerified: null, identity: null, diagnostics: { ...EMPTY_DIAGNOSTICS },
    effectiveUrl: `https://example.com/${id}`, proxyUsed: false, handleKey: `file:${id}`, awaitingTarget: false, resultUrl: null,
    ...patch,
  }
}

function checkpoint(id: string, bytesWritten = 120): DownloadCheckpoint {
  return {
    version: CHECKPOINT_VERSION, id, url: `https://example.com/${id}`,
    resource: { etag: '"v1"', lastModified: null, totalBytes: 300, contentType: null },
    saveMode: 'fsa', supportsRanges: true, bytesWritten,
    segments: [
      { index: 0, start: 0, end: 99, received: 100, status: 'complete', attempts: 0 },
      { index: 1, start: 100, end: 199, received: bytesWritten - 100, status: 'partial', attempts: 0 },
      { index: 2, start: 200, end: 299, received: 0, status: 'pending', attempts: 0 },
    ],
    savedAt: 5,
  }
}

beforeEach(() => store.data.clear())

describe('restoreTask', () => {
  it('resumes an FSA download from its durable checkpoint, not the UI counter', async () => {
    await store.save('fsa-1', checkpoint('fsa-1', 120))
    let used: DownloadCheckpoint | null = null
    const restored = await restoreTask(task('fsa-1'), (cp) => (used = cp), () => {})
    expect(restored.status).toBe('paused')
    expect(restored.receivedBytes).toBe(120) // checkpoint, not the 150 the UI last showed
    expect(restored.identity?.etag).toBe('"v1"')
    expect(used).not.toBeNull()
  })

  it('resets progress when no checkpoint exists', async () => {
    const restored = await restoreTask(task('fsa-2'), () => { throw new Error('no checkpoint expected') }, () => {})
    expect(restored.status).toBe('paused')
    expect(restored.receivedBytes).toBe(0)
    expect(restored.segments).toEqual([])
  })

  it('resets progress when the file handle is gone', async () => {
    await store.save('gone-1', checkpoint('gone-1'))
    const restored = await restoreTask(task('gone-1'), () => { throw new Error('must not use it') }, () => {})
    expect(restored.receivedBytes).toBe(0)
    expect(restored.handleKey).toBeNull()
    expect(await store.load('gone-1')).toBeNull()
  })

  it('discards a corrupt checkpoint and reports it', async () => {
    store.data.set('fsa-3', { ...checkpoint('fsa-3'), bytesWritten: 9999 })
    const corrupt = vi.fn()
    const restored = await restoreTask(task('fsa-3'), () => {}, corrupt)
    expect(corrupt).toHaveBeenCalledTimes(1)
    expect(restored.receivedBytes).toBe(0)
    expect(store.data.has('fsa-3')).toBe(false)
  })

  it('marks an interrupted browser stream as failed', async () => {
    const restored = await restoreTask(task('s-1', { saveMode: 'stream', handleKey: null }), () => {}, () => {})
    expect(restored.status).toBe('failed')
    expect(restored.error).toMatch(/interrupted/)
    expect(restored.receivedBytes).toBe(0)
  })

  it('memory downloads restart from zero', async () => {
    const restored = await restoreTask(task('m-1', { saveMode: 'memory', handleKey: null }), () => {}, () => {})
    expect(restored.status).toBe('paused')
    expect(restored.receivedBytes).toBe(0)
  })

  it('leaves completed tasks alone', async () => {
    const restored = await restoreTask(task('c-1', { status: 'completed', receivedBytes: 300, handleKey: null }), () => {}, () => {})
    expect(restored.status).toBe('completed')
    expect(restored.receivedBytes).toBe(300)
  })
})

describe('normalizeTask', () => {
  it('migrates older persisted tasks', () => {
    const legacy = { ...task('old'), retries: 2 } as Partial<DownloadTask> & { retries: number }
    delete legacy.terminalFailureCount
    delete legacy.priority
    delete legacy.diagnostics
    delete legacy.queuedAt
    const t = normalizeTask(legacy as DownloadTask)
    expect(t.terminalFailureCount).toBe(2)
    expect(t.priority).toBe(0)
    expect(t.queuedAt).toBe(1)
    expect(t.diagnostics).toEqual(EMPTY_DIAGNOSTICS)
    expect('retries' in t).toBe(false)
  })
})
