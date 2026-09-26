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

## Deploy to GitHub Pages

1. In the repository's **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
2. Merge the workflow into `main`. Every push to `main` builds and deploys the site; you can also run **Deploy to GitHub Pages** manually from the **Actions** tab (select `main`).
3. Open the deployment URL shown by the workflow's `github-pages` environment (normally https://iant89.github.io/download-manager/).

The workflow uses Node.js 22, installs the lockfile with `npm ci`, builds the app (including TypeScript checks), and deploys `dist/` with the official Pages actions. Authentication uses GitHub's built-in token; no personal token or deployment secret is needed. Vite's base path comes from the Pages configuration, so assets and the download service worker work on project URLs and custom domains.

GitHub Pages is static hosting: the local `/testfile/` sample endpoint is **not available** there. Use real download URLs whose servers allow CORS, or configure a CORS proxy in Settings.

To check a project-path build locally:

```bash
npm ci
npm run build -- --base /download-manager/
npm run preview -- --base /download-manager/
# Open http://localhost:4173/download-manager/
```

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
