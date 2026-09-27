/**
 * Minimal stand-in for the dev server's `/testfile/*` endpoint so the engine
 * tests can run without `npm run dev`. Produces the exact same deterministic
 * bytes as the Vite plugin in `vite.config.ts`.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'

const CHUNK = 64 * 1024

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

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const size = parseSize(url.pathname.slice('/testfile/'.length))
  if (size == null) {
    res.statusCode = 404
    res.end('usage: /testfile/<size>[?delay=ms&auth=user:pass&noranges=1]')
    return
  }
  const delay = Math.max(0, Number(url.searchParams.get('delay') ?? 0))
  const auth = url.searchParams.get('auth')
  const noRanges = url.searchParams.get('noranges') === '1'
  const name = `flux-test-${url.pathname.split('/').pop()}.bin`

  if (auth) {
    const header = req.headers.authorization ?? ''
    const expected = `Basic ${Buffer.from(auth).toString('base64')}`
    if (header !== expected && header !== `Bearer ${auth}`) {
      res.statusCode = 401
      res.setHeader('WWW-Authenticate', 'Basic realm="flux"')
      res.end('unauthorized')
      return
    }
  }

  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Accept-Ranges', noRanges ? 'none' : 'bytes')
  // Mirror the dev server so happy-dom's CORS checks let the engine through.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Range, Accept-Ranges')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  let start = 0
  let end = size - 1
  const range = req.headers.range
  if (range && !noRanges) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!m) {
      res.statusCode = 416
      res.end()
      return
    }
    if (m[1] === '' && m[2] !== '') {
      start = Math.max(0, size - Number(m[2]))
    } else {
      start = Number(m[1] || 0)
      if (m[2] !== '') end = Math.min(end, Number(m[2]))
    }
    if (start > end || start >= size) {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  } else {
    res.statusCode = 200
  }
  res.setHeader('Content-Length', String(end - start + 1))

  if (req.method === 'HEAD') {
    res.end()
    return
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
  while (offset <= end && !closed) {
    const n = Math.min(CHUNK, end - offset + 1)
    const buf = Buffer.allocUnsafe(n)
    fill(buf, offset)
    await write(buf)
    offset += n
    if (delay > 0) await new Promise((r) => setTimeout(r, delay))
  }
  res.end()
}

/** Boots the server on an ephemeral port and resolves once it listens. */
export async function startTestFileServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    void handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { server, base: `http://127.0.0.1:${port}` }
}
