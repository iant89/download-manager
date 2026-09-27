import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { handleTestFile } from './tests/testServer.ts'

/**
 * Dev/preview-only endpoint that serves deterministic synthetic files with full
 * HTTP Range + HEAD support (and optional fault injection), so the engine can
 * be exercised without depending on a CORS-friendly host. The handler is
 * shared with the vitest setup; see `tests/testServer.ts` for the options.
 */
function testFilePlugin(): Plugin {
  const install = (server: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/testfile/')) void handleTestFile(req, res)
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
