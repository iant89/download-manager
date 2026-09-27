/**
 * Unit tests for the hardening building blocks (HARDENING_PLAN.md §Testing):
 * Content-Range validation, retry classification, checkpoints, scheduler,
 * connection pool, SHA-256 and the status state machine.
 */
import { describe, expect, it } from 'vitest'

import { HttpError } from '../http'
import { parseContentRange, parseUnsatisfiedTotal, validateRangeResponse } from './contentRange'
import {
  BodyLengthError,
  ChecksumMismatchError,
  CheckpointError,
  CheckpointVersionError,
  MemoryLimitError,
  RangeMismatchError,
  ResourceChangedError,
} from './errors'
import { backoffFor, classifyFailure, MAX_RETRY_AFTER_MS, parseRetryAfter } from './retryPolicy'
import {
  assertSameResource,
  CHECKPOINT_VERSION,
  ifRangeValidator,
  migrateCheckpoint,
  validateCheckpoint,
  type DownloadCheckpoint,
} from './checkpoint'
import { MemoryCheckpointStore } from './checkpointStore'
import { DownloadScheduler } from './scheduler'
import { ConnectionPool, hostOf } from './connectionPool'
import { isValidSha256, normalizeChecksum, Sha256, sha256OfBlob } from './sha256'
import { canTransition, findInvalidTransition } from './stateMachine'
import { MemorySink } from './sinks/memorySink'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
describe('Content-Range', () => {
  it('parses satisfied ranges with known and unknown totals', () => {
    expect(parseContentRange('bytes 0-99/1000')).toEqual({ start: 0, end: 99, total: 1000 })
    expect(parseContentRange('bytes 100-199/*')).toEqual({ start: 100, end: 199, total: null })
  })

  it('rejects malformed or impossible headers', () => {
    for (const bad of ['bytes 100-99/1000', 'bytes 0-1000/1000', 'bytes */1000', 'items 0-1/2', 'garbage']) {
      expect(() => parseContentRange(bad), bad).toThrow(RangeMismatchError)
    }
  })

  it('reads the total of an unsatisfied range', () => {
    expect(parseUnsatisfiedTotal('bytes */5000')).toBe(5000)
    expect(parseUnsatisfiedTotal('bytes 0-1/2')).toBeNull()
    expect(parseUnsatisfiedTotal(null)).toBeNull()
  })

  it('accepts the exact range and a shorter one', () => {
    expect(() => validateRangeResponse(100, 199, { start: 100, end: 199, total: 1000 }, 1000)).not.toThrow()
    expect(() => validateRangeResponse(100, 199, { start: 100, end: 150, total: 1000 }, 1000)).not.toThrow()
  })

  it('rejects a wrong start, an overlong end and a different total', () => {
    expect(() => validateRangeResponse(100, 199, { start: 101, end: 199, total: 1000 }, 1000)).toThrow(RangeMismatchError)
    expect(() => validateRangeResponse(100, 199, { start: 100, end: 200, total: 1000 }, 1000)).toThrow(RangeMismatchError)
    expect(() => validateRangeResponse(100, 199, { start: 100, end: 199, total: 2000 }, 1000)).toThrow(ResourceChangedError)
  })
})

// ---------------------------------------------------------------------------
describe('retry policy', () => {
  const ctx = { attempt: 1, maxRetries: 3, random: () => 0 }

  it('retries transient HTTP statuses and gives up on client errors', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(classifyFailure(new HttpError('x', status), ctx).type, String(status)).toBe('retry')
    }
    for (const status of [400, 401, 403, 404, 410, 416]) {
      expect(classifyFailure(new HttpError('x', status), ctx).type, String(status)).toBe('fatal')
    }
  })

  it('honours Retry-After, capped', () => {
    expect(classifyFailure(new HttpError('busy', 503, 'http', 2000), ctx)).toMatchObject({ type: 'retry', delayMs: 2000 })
    expect(classifyFailure(new HttpError('busy', 429, 'http', 10 * 60 * 60_000), ctx)).toMatchObject({ type: 'retry', delayMs: MAX_RETRY_AFTER_MS })
  })

  it('parses both Retry-After forms', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000)
    expect(parseRetryAfter('soon')).toBeNull()
  })

  it('retries integrity errors (bad ranges, short bodies) until exhausted', () => {
    expect(classifyFailure(new RangeMismatchError('bad'), ctx).type).toBe('retry')
    expect(classifyFailure(new BodyLengthError('short', 10, 5), ctx).type).toBe('retry')
    expect(classifyFailure(new BodyLengthError('short', 10, 5), { ...ctx, attempt: 4 }).type).toBe('fatal')
  })

  it('never retries checksum, memory or resource-change failures', () => {
    expect(classifyFailure(new ChecksumMismatchError('sha-256', 'a'.repeat(64), 'b'.repeat(64)), ctx).type).toBe('fatal')
    expect(classifyFailure(new MemoryLimitError(10), ctx).type).toBe('fatal')
    expect(classifyFailure(new ResourceChangedError(), ctx).type).toBe('resource-changed')
  })

  it('falls back to a plain GET for CORS-looking errors when allowed', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'), { ...ctx, canFallBack: true }).type).toBe('fallback')
    expect(classifyFailure(new TypeError('Failed to fetch'), ctx).type).toBe('retry')
  })

  it('treats aborts as aborts', () => {
    expect(classifyFailure(new DOMException('x', 'AbortError'), ctx).type).toBe('aborted')
  })

  it('backs off exponentially with a cap', () => {
    expect(backoffFor(1, () => 0)).toBe(400)
    expect(backoffFor(3, () => 0)).toBe(1600)
    expect(backoffFor(30, () => 0)).toBe(20_000)
  })
})

// ---------------------------------------------------------------------------
function checkpoint(overrides: Partial<DownloadCheckpoint> = {}): DownloadCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    id: 'a',
    url: 'https://example.com/a',
    resource: { etag: '"v1"', lastModified: null, totalBytes: 300, contentType: null },
    saveMode: 'fsa',
    supportsRanges: true,
    bytesWritten: 150,
    segments: [
      { index: 0, start: 0, end: 99, received: 100, status: 'complete', attempts: 0 },
      { index: 1, start: 100, end: 199, received: 50, status: 'partial', attempts: 1 },
      { index: 2, start: 200, end: 299, received: 0, status: 'pending', attempts: 0 },
    ],
    savedAt: 1,
    ...overrides,
  }
}

describe('checkpoints', () => {
  it('accepts a well-formed checkpoint', () => {
    expect(() => validateCheckpoint(checkpoint())).not.toThrow()
    expect(migrateCheckpoint(JSON.parse(JSON.stringify(checkpoint())))).toMatchObject({ bytesWritten: 150 })
  })

  it('rejects gaps, overlaps, overfull segments and bad totals', () => {
    const base = checkpoint()
    const gap = checkpoint({ segments: [base.segments[0]!, { ...base.segments[1]!, start: 101 }, base.segments[2]!] })
    const overlap = checkpoint({ segments: [base.segments[0]!, { ...base.segments[1]!, start: 99 }, base.segments[2]!] })
    const overfull = checkpoint({ segments: [base.segments[0]!, { ...base.segments[1]!, received: 101 }, base.segments[2]!] })
    const wrongSum = checkpoint({ bytesWritten: 151 })
    const noTotal = checkpoint({ resource: { ...base.resource, totalBytes: null } })
    const short = checkpoint({ segments: base.segments.slice(0, 2), bytesWritten: 150 })
    const lyingStatus = checkpoint({ segments: [{ ...base.segments[0]!, status: 'partial' }, base.segments[1]!, base.segments[2]!] })
    for (const cp of [gap, overlap, overfull, wrongSum, noTotal, short, lyingStatus]) {
      expect(() => validateCheckpoint(cp)).toThrow(CheckpointError)
    }
  })

  it('refuses unknown versions', () => {
    expect(() => migrateCheckpoint({ ...checkpoint(), version: 99 })).toThrow(CheckpointVersionError)
    expect(() => migrateCheckpoint('nope')).toThrow(CheckpointError)
  })

  it('detects a changed resource by size, ETag or Last-Modified', () => {
    const saved = { etag: '"v1"', lastModified: 'Mon', totalBytes: 10, contentType: null }
    expect(() => assertSameResource(saved, { totalBytes: 10, etag: 'W/"v1"', lastModified: 'Mon' })).not.toThrow()
    expect(() => assertSameResource(saved, { totalBytes: 11 })).toThrow(ResourceChangedError)
    expect(() => assertSameResource(saved, { etag: '"v2"' })).toThrow(ResourceChangedError)
    expect(() => assertSameResource(saved, { lastModified: 'Tue' })).toThrow(ResourceChangedError)
    // Unknown on one side is not evidence of change.
    expect(() => assertSameResource(saved, { etag: null, lastModified: null, totalBytes: null })).not.toThrow()
  })

  it('uses only a strong ETag for If-Range, else Last-Modified', () => {
    expect(ifRangeValidator({ etag: '"v1"', lastModified: 'Mon', totalBytes: 1, contentType: null })).toBe('"v1"')
    expect(ifRangeValidator({ etag: 'W/"v1"', lastModified: 'Mon', totalBytes: 1, contentType: null })).toBe('Mon')
    expect(ifRangeValidator({ etag: 'W/"v1"', lastModified: null, totalBytes: 1, contentType: null })).toBeNull()
  })

  it('memory store round-trips and validates on load', async () => {
    const store = new MemoryCheckpointStore()
    await store.save('a', checkpoint())
    expect((await store.load('a'))?.bytesWritten).toBe(150)
    store.data.set('b', { ...checkpoint(), bytesWritten: 7 } as DownloadCheckpoint)
    await expect(store.load('b')).rejects.toThrow(CheckpointError)
    await store.remove('a')
    expect(await store.load('a')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
describe('DownloadScheduler', () => {
  it('runs highest priority first, FIFO within a priority, up to the limit', () => {
    const s = new DownloadScheduler({ maxConcurrent: 2 })
    s.enqueue('low', { priority: 0 })
    s.enqueue('high1', { priority: 10 })
    s.enqueue('mid', { priority: 5 })
    s.enqueue('high2', { priority: 10 })
    expect(s.pump()).toEqual(['high1', 'high2'])
    expect(s.pump()).toEqual([])
    s.completed('high1')
    expect(s.pump()).toEqual(['mid'])
    expect(s.queued()).toEqual(['low'])
  })

  it('honours persisted sequence numbers and priority changes', () => {
    const s = new DownloadScheduler({ maxConcurrent: 1 })
    s.enqueue('b', { sequence: 20 })
    s.enqueue('a', { sequence: 10 })
    expect(s.queued()).toEqual(['a', 'b'])
    s.setPriority('b', 1)
    expect(s.pump()).toEqual(['b'])
  })

  it('never exceeds the limit and frees slots on cancel', () => {
    const s = new DownloadScheduler({ maxConcurrent: 1 })
    s.enqueue('a')
    s.enqueue('b')
    expect(s.pump()).toEqual(['a'])
    s.enqueue('a') // re-enqueueing an active id is a no-op
    expect(s.activeCount()).toBe(1)
    s.cancel('a')
    expect(s.pump()).toEqual(['b'])
    s.setLimits({ maxConcurrent: 3 })
    expect(s.activeCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
describe('ConnectionPool', () => {
  it('limits connections per host and globally, FIFO', async () => {
    const pool = new ConnectionPool({ global: 3, perHost: 2 })
    const a1 = await pool.acquire('a')
    await pool.acquire('a')
    let a3Granted = false
    const a3 = pool.acquire('a').then((release) => {
      a3Granted = true
      return release
    })
    await pool.acquire('b')
    let b2Granted = false
    void pool.acquire('b').then(() => (b2Granted = true))
    await Promise.resolve()
    expect(a3Granted).toBe(false) // per-host
    expect(b2Granted).toBe(false) // global
    expect(pool.stats().total).toBe(3)
    a1()
    await a3
    expect(a3Granted).toBe(true)
    expect(b2Granted).toBe(false)
  })

  it('releases are idempotent and waiting can be aborted', async () => {
    const pool = new ConnectionPool({ global: 1, perHost: 1 })
    const release = await pool.acquire('h')
    const controller = new AbortController()
    const waiting = pool.acquire('h', controller.signal)
    controller.abort()
    await expect(waiting).rejects.toBeTruthy()
    release()
    release()
    expect(pool.stats().total).toBe(0)
    const again = await pool.acquire('h')
    expect(pool.stats().total).toBe(1)
    again()
  })

  it('extracts hosts', () => {
    expect(hostOf('https://Example.com:8443/x')).toBe('example.com:8443')
    expect(hostOf('not a url')).toBe('')
  })
})

// ---------------------------------------------------------------------------
describe('SHA-256', () => {
  it('matches known vectors and node:crypto for incremental input', async () => {
    expect(new Sha256().update(new TextEncoder().encode('abc')).digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(new Sha256().digestHex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    const data = new Uint8Array(1_000_003).map((_, i) => (i * 7) & 0xff)
    const expected = createHash('sha256').update(data).digest('hex')
    const h = new Sha256()
    for (let i = 0; i < data.length; i += 65_537) h.update(data.subarray(i, i + 65_537))
    expect(h.digestHex()).toBe(expected)
    expect(await sha256OfBlob(new Blob([data]), 100_000)).toBe(expected)
  })

  it('validates and normalises user input', () => {
    expect(isValidSha256('A'.repeat(64))).toBe(true)
    expect(isValidSha256('sha256:' + 'a'.repeat(64))).toBe(true)
    expect(isValidSha256('abc')).toBe(false)
    expect(normalizeChecksum('  SHA256:' + 'AB'.repeat(32) + ' ')).toBe('ab'.repeat(32))
  })
})

// ---------------------------------------------------------------------------
describe('status state machine', () => {
  it('allows the normal lifecycle', () => {
    expect(findInvalidTransition(['queued', 'probing', 'downloading', 'verifying', 'finalizing', 'completed'])).toBeNull()
    expect(findInvalidTransition(['queued', 'probing', 'downloading', 'pausing', 'paused', 'queued', 'probing', 'downloading'])).toBeNull()
    expect(findInvalidTransition(['downloading', 'failed', 'queued'])).toBeNull()
  })

  it('rejects impossible jumps', () => {
    expect(canTransition('completed', 'downloading')).toBe(false)
    expect(canTransition('queued', 'completed')).toBe(false)
    expect(canTransition('downloading', 'paused')).toBe(false) // must go through pausing
    expect(findInvalidTransition(['queued', 'downloading', 'completed'])).toMatchObject({ from: 'downloading', to: 'completed' })
  })
})

// ---------------------------------------------------------------------------
describe('MemorySink limits', () => {
  it('refuses to grow past its memory limit', async () => {
    const sink = new MemorySink({ id: 'm', filename: 'm.bin', mime: 'application/octet-stream', totalBytes: null, resumeFrom: 0, memoryLimit: 1024 })
    await sink.write(0, new Uint8Array(1000))
    await expect(sink.write(1000, new Uint8Array(100))).rejects.toThrow(MemoryLimitError)
  })

  it('rejects a known size above the limit up front', () => {
    expect(() => new MemorySink({ id: 'm', filename: 'm.bin', mime: 'x', totalBytes: 4096, resumeFrom: 0, memoryLimit: 1024 })).toThrow(MemoryLimitError)
  })
})

// ---------------------------------------------------------------------------
// Property-style tests (plan P2-09): random inputs, fixed seed for replay.
// ---------------------------------------------------------------------------
import { buildSegments } from './taskRunner'
import { StreamSink } from './sinks/streamSink'
import { WriteQueue } from './writeQueue'

function rng(seed: number): () => number {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

describe('range properties', () => {
  it('buildSegments always tiles [0, size) without gaps or overlaps', () => {
    const random = rng(42)
    for (let i = 0; i < 500; i += 1) {
      const size = 1 + Math.floor(random() * 200_000_000)
      const connections = 1 + Math.floor(random() * 16)
      const segs = buildSegments(size, connections, true)
      expect(segs[0]!.start).toBe(0)
      expect(segs.at(-1)!.end).toBe(size - 1)
      for (let j = 1; j < segs.length; j += 1) expect(segs[j]!.start).toBe(segs[j - 1]!.end + 1)
      expect(segs.length).toBeLessThanOrEqual(connections)
    }
  })

  it('any arrival order and chunking reaches a stream sink in file order, hashed correctly', async () => {
    const random = rng(7)
    for (let round = 0; round < 25; round += 1) {
      const size = 1 + Math.floor(random() * 5000)
      const data = new Uint8Array(size).map((_, i) => (i * 13 + round) & 0xff)
      // Cut into random chunks, then shuffle and sprinkle duplicate retransmissions.
      const chunks: { offset: number; bytes: Uint8Array }[] = []
      for (let offset = 0; offset < size; ) {
        const len = Math.min(size - offset, 1 + Math.floor(random() * 700))
        chunks.push({ offset, bytes: data.slice(offset, offset + len) })
        offset += len
      }
      for (const c of [...chunks]) if (random() < 0.2) chunks.push(c)
      for (let i = chunks.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1))
        ;[chunks[i], chunks[j]] = [chunks[j]!, chunks[i]!]
      }
      const transform = new TransformStream<Uint8Array, Uint8Array>()
      const received: number[] = []
      const drained = (async () => {
        const reader = transform.readable.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          received.push(...value!)
        }
      })()
      const expectedHash = createHash('sha256').update(data).digest('hex')
      const sink = new StreamSink({ id: 'p', filename: 'p', mime: 'x', totalBytes: size, resumeFrom: 0, checksum: expectedHash }, transform)
      const queue = new WriteQueue(sink, 1 << 20)
      for (const c of chunks) queue.submit(c.offset, c.bytes)
      expect(await queue.stop(5000)).toBe(true)
      const result = await sink.finish(size, 'p')
      await drained
      expect(received.length).toBe(size)
      expect(Uint8Array.from(received)).toEqual(data)
      expect(result.checksum?.value).toBe(expectedHash)
    }
  })
})
