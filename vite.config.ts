import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

/**
 * Dev/preview-only endpoint that serves deterministic synthetic files with full
 * HTTP Range + HEAD support, so the multi-connection engine can be exercised
 * without depending on a CORS-friendly host.
 *
 *   /testfile/<size>[?delay=<ms per 64KiB>][&auth=user:pass][&noranges=1][&name=foo.bin]
 *
 * <size> accepts 5mb, 200kb, 1gb …
 */
function testFilePlugin(): Plugin {
  const CHUNK = 64 * 1024

  const parseSize = (raw: string): number | null => {
    const m = /^(\d+(?:\.\d+)?)(b|kb|mb|gb)?$/i.exec(raw)
    if (!m) return null
    const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[(m[2] ?? 'b').toLowerCase() as 'b' | 'kb' | 'mb' | 'gb']
    return Math.min(8 * 1024 ** 3, Math.floor(Number(m[1]) * mult))
  }

  // Deterministic byte at absolute offset so any range can be verified.
  const fill = (buf: Buffer, offset: number) => {
    for (let i = 0; i < buf.length; i += 1) {
      const p = offset + i
      buf[i] = (p * 31 + ((p >>> 8) * 17) + ((p >>> 16) * 7)) & 0xff
    }
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
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
    const name = url.searchParams.get('name') ?? `flux-test-${url.pathname.split('/').pop()}.bin`

    if (auth) {
      const header = req.headers.authorization ?? ''
      const expected = `Basic ${Buffer.from(auth).toString('base64')}`
      const bearerOk = header === `Bearer ${auth}`
      if (header !== expected && !bearerOk) {
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
    const length = end - start + 1
    res.setHeader('Content-Length', String(length))

    if (req.method === 'HEAD') {
      res.end()
      return
    }

    let offset = start
    let closed = false
    req.on('close', () => {
      closed = true
    })
    const write = (buf: Buffer) => new Promise<void>((resolve) => (res.write(buf) ? resolve() : res.once('drain', resolve)))
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

  const install = (server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/testfile/')) void handler(req, res)
      else next()
    })
  }

  return {
    name: 'flux-test-file',
    configureServer: install,
    configurePreviewServer: install,
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), testFilePlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    cors: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
