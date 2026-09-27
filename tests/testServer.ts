/**
 * The `/testfile/*` endpoint, shared by the Vite dev/preview server
 * (`vite.config.ts`) and the vitest setup (`tests/setup.ts`) so both serve
 * byte-identical, deterministic files with full Range/HEAD support.
 *
 *   /testfile/<size>?<options>
 *
 * <size> accepts 5mb, 200kb, 1gb …
 *
 * Options:
 *   delay=<ms>        pause after every 64 KiB chunk
 *   auth=user:pass    require Basic (or `Bearer user:pass`) auth
 *   noranges=1        ignore Range, always 200 with Accept-Ranges: none
 *   name=<file>       Content-Disposition filename
 *   etag=<value>      ETag to report (default: derived from the size)
 *   nocr=1            206 responses omit Content-Range (as if CORS-hidden)
 *
 * Fault injection (plan §Testing). Faults apply to the first `times` GETs
 * (default 1) counted per `key` (default: the path + query), so each test uses
 * its own key:
 *   fault=short       send only half the promised body, then end cleanly
 *   fault=badrange    Content-Range start is off by one
 *   fault=overflow    send 1 KiB more than Content-Range promises
 *   fault=503         503 with `Retry-After: <retryafter>` (default 1 s)
 *   fault=416         416 with `Content-Range: bytes * /<size>`
 *   fault=etag        ETag changes after `times` GETs (resource replaced)
 *   fault=size        total size grows by 1 KiB after `times` GETs
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'

const CHUNK = 64 * 1024
const LAST_MODIFIED = 'Wed, 01 Jan 2025 00:00:00 GMT'

export function expectedByte(p: number): number {
  return (p * 31 + ((p >>> 8) * 17) + ((p >>> 16) * 7)) & 0xff
}

function parseSize(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(raw)
  if (!m) return null
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] ?? 'b').toLowerCase() as 'b' | 'kb' | 'mb' | 'gb']
  return Math.min(8 * 1024 ** 3, Math.floor(Number(m[1]) * mult))
}

function fill(buf: Buffer, offset: number): void {
  for (let i = 0; i < buf.length; i += 1) buf[i] = expectedByte(offset + i)
}

/** GET counts per fault key (reset with `resetTestFaults`). */
const faultCounters = new Map<string, number>()

export function resetTestFaults(): void {
  faultCounters.clear()
}

/** Handles `/testfile/*`; returns false for any other path. */
export async function handleTestFile(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/testfile/')) return false
  const baseSize = parseSize(url.pathname.slice('/testfile/'.length))
  if (baseSize == null) {
    res.statusCode = 404
    res.end('usage: /testfile/<size>[?delay=ms&auth=user:pass&noranges=1&name=x&fault=…]')
    return true
  }
  const params = url.searchParams
  const delay = Math.max(0, Number(params.get('delay') ?? 0))
  const auth = params.get('auth')
  const noRanges = params.get('noranges') === '1'
  const hideContentRange = params.get('nocr') === '1'
  const name = params.get('name') || `flux-test-${url.pathname.split('/').pop()}.bin`
  const fault = params.get('fault')
  const times = Math.max(0, Number(params.get('times') ?? 1))
  const key = params.get('key') ?? `${url.pathname}${url.search}`

  // CORS first so even error responses are readable by the browser.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Disposition, Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Retry-After',
  )
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return true
  }

  if (auth) {
    const header = req.headers.authorization ?? ''
    const expected = `Basic ${Buffer.from(auth).toString('base64')}`
    if (header !== expected && header !== `Bearer ${auth}`) {
      res.statusCode = 401
      res.setHeader('WWW-Authenticate', 'Basic realm="flux"')
      res.end('unauthorized')
      return true
    }
  }

  // Count GETs per key; `faulty` is true while within the first `times`.
  let count = faultCounters.get(key) ?? 0
  if (req.method === 'GET') faultCounters.set(key, ++count)
  const faulty = req.method === 'GET' && count <= times
  const replaced = (fault === 'etag' || fault === 'size') && (faultCounters.get(key) ?? 0) > times

  const size = fault === 'size' && replaced ? baseSize + 1024 : baseSize
  const etag = replaced && fault === 'etag' ? `"flux-v2-${baseSize}"` : `"${params.get('etag') ?? `flux-${baseSize}`}"`

  if (fault === '503' && faulty) {
    res.statusCode = 503
    res.setHeader('Retry-After', params.get('retryafter') ?? '1')
    res.end('busy')
    return true
  }

  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Accept-Ranges', noRanges ? 'none' : 'bytes')
  res.setHeader('ETag', etag)
  res.setHeader('Last-Modified', LAST_MODIFIED)

  let start = 0
  let end = size - 1
  const range = req.headers.range
  const ifRange = req.headers['if-range']
  // If-Range: serve the range only if the validator still matches.
  const rangeHonoured = Boolean(range) && !noRanges && (!ifRange || ifRange === etag || ifRange === LAST_MODIFIED)
  if (range && rangeHonoured) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!m) {
      res.statusCode = 416
      res.end()
      return true
    }
    if (m[1] === '' && m[2] !== '') {
      start = Math.max(0, size - Number(m[2]))
    } else {
      start = Number(m[1] || 0)
      if (m[2] !== '') end = Math.min(end, Number(m[2]))
    }
    if (start > end || start >= size || (fault === '416' && faulty)) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return true
    }
    res.statusCode = 206
    if (!hideContentRange) {
      const reportedStart = fault === 'badrange' && faulty ? start + 1 : start
      res.setHeader('Content-Range', `bytes ${reportedStart}-${end}/${size}`)
    }
  } else {
    res.statusCode = 200
  }

  let bodyEnd = end
  if (fault === 'short' && faulty) bodyEnd = start + Math.floor((end - start + 1) / 2) - 1
  if (fault === 'overflow' && faulty) bodyEnd = Math.min(size - 1, end + 1024)
  // Content-Length always describes what we *claim*; short bodies then end
  // early. Node would reject a mismatched length, so omit it for those.
  if (bodyEnd === end) res.setHeader('Content-Length', String(end - start + 1))

  if (req.method === 'HEAD') {
    res.end()
    return true
  }

  let offset = start
  let closed = false
  req.on('close', () => {
    closed = true
  })
  const write = (buf: Buffer) =>
    new Promise<void>((resolve) => {
      if (closed || res.writableEnded || res.destroyed) {
        resolve()
        return
      }
      if (res.write(buf)) resolve()
      else res.once('drain', resolve)
    })
  while (offset <= bodyEnd && !closed) {
    const n = Math.min(CHUNK, bodyEnd - offset + 1)
    const buf = Buffer.allocUnsafe(n)
    fill(buf, offset)
    await write(buf)
    offset += n
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
  }
  res.end()
  return true
}

/** Boots the server on an ephemeral port and resolves once it listens. */
export async function startTestFileServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    void handleTestFile(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404
        res.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, base: `http://127.0.0.1:${port}` }
}
