/* eslint-disable no-restricted-globals */
/**
 * Flux download sink service worker.
 *
 * Browsers without the File System Access API (Firefox / Safari) cannot stream a
 * fetched response to disk, and buffering a multi-gigabyte file in memory is not
 * an option. This worker implements the classic "StreamSaver" trick:
 *
 *   1. the page registers a `ReadableStream` against a synthetic URL
 *      (`/flux-stream/<id>`) by transferring it over a MessageChannel,
 *   2. the page navigates a hidden iframe to that URL,
 *   3. this worker intercepts the navigation and answers with the stream plus a
 *      `Content-Disposition: attachment` header, so the browser writes the bytes
 *      straight to the user's download folder as they arrive.
 */
const STREAMS = new Map()

function sanitize(name) {
  return String(name || 'download')
    .replace(/[\r\n"\\]/g, '')
    .slice(0, 200)
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  const data = event.data || {}
  const port = event.ports && event.ports[0]

  if (data.type === 'STREAM_REGISTER') {
    STREAMS.set(data.url, {
      readable: data.readable,
      filename: sanitize(data.filename),
      size: typeof data.size === 'number' ? data.size : null,
      mime: data.mime || 'application/octet-stream',
      done: false,
    })
    if (port) port.postMessage({ ok: true })
    return
  }

  if (data.type === 'STREAM_ABORT') {
    const entry = STREAMS.get(data.url)
    if (entry && !entry.done) {
      entry.done = true
      try {
        entry.readable.cancel(data.reason || 'aborted')
      } catch {
        /* already closed */
      }
    }
    STREAMS.delete(data.url)
    if (port) port.postMessage({ ok: true })
    return
  }

  if (data.type === 'PING' && port) port.postMessage({ ok: true, sw: true })
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.startsWith('/flux-stream/')) return

  const entry = STREAMS.get(url.pathname)
  if (!entry) {
    event.respondWith(new Response('stream not found', { status: 404 }))
    return
  }

  const headers = new Headers({
    'Content-Type': entry.mime || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${entry.filename}"; filename*=UTF-8''${encodeURIComponent(
      entry.filename,
    )}`,
    // Disable caching & keep the byte stream honest.
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
  })
  if (entry.size != null && entry.size > 0) headers.set('Content-Length', String(entry.size))

  event.respondWith(new Response(entry.readable, { status: 200, headers }))

  // The stream is consumed once; drop it so a second navigation 404s.
  entry.done = true
  STREAMS.delete(url.pathname)
})
