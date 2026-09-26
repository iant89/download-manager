# Flux — browser download manager

A production-grade, single-page download manager built with **React 19 + TypeScript + Vite**. No backend: the browser itself opens parallel HTTP range connections, throttles them, retries, pauses/resumes, and streams the result straight to disk.

## Features

- **Multi-connection downloads** — splits a file into up to 16 HTTP `Range` segments fetched in parallel; falls back to a single stream when the server doesn't support ranges (detected automatically).
- **Streams to disk, not RAM** — three sinks, chosen automatically:
  - *Browser stream*: a service worker pipes bytes into the native download shelf (works in Chrome, Firefox, Safari).
  - *File System Access*: writes directly into a file/folder you pick; resumable across reloads (Chromium).
  - *Memory*: last-resort blob buffer for small files.
- **Authentication** — Basic, Bearer token, and arbitrary custom headers per download.
- **Speed limits** — per-download and global token-bucket throttling, changeable live.
- **Pause / resume / cancel / retry**, concurrency cap, per-connection retry with exponential backoff, automatic CORS-proxy retry (optional).
- **Live telemetry** — per-connection segment bars, throughput sparklines, ETA, peak/average speed.
- **Fluid UI** — spring animations (framer-motion), light/dark/system themes, reduced-motion support, mobile bottom-sheet layout, keyboard shortcuts (`N`, `/`, `,`, `?`, `Shift+P/R`), paste-a-URL-anywhere.
- **Persistence** — queue and settings survive reloads (IndexedDB + localStorage).

## Browser limitations (by design)

Because everything runs in the page, the remote server must allow cross-origin requests (`Access-Control-Allow-Origin`). For hosts that don't, configure a CORS proxy under **Settings → Network**. Cookies and other forbidden headers cannot be set by web pages.

## Development

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine + UI tests (dev server must be running for engine tests)
npm run build      # production bundle in dist/
```

The dev/preview server exposes `/testfile/<size>?delay=<ms>&auth=user:pass&noranges=1` — a deterministic, range-capable endpoint for exercising the engine. The **New download** dialog offers one-click samples.

## Architecture

```
src/lib/engine/
  taskRunner.ts   one download: probe → segment → parallel fetch → sink
  writeQueue.ts   serialises random-access writes, applies backpressure
  rateLimiter.ts  token bucket (per-task + global)
  manager.ts      concurrency + lifecycle across tasks
  sinks/          fsaSink · streamSink (service worker) · memorySink
src/store/        zustand store: state transitions + persistence
src/components/   UI
public/sw.js      service-worker download sink
```
