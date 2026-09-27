/**
 * Vitest setup: boot a self-contained `/testfile` server so the engine tests
 * never depend on a manually started dev server (`npm test` just works).
 */
import { startTestFileServer } from './testServer'

declare global {
  // eslint-disable-next-line no-var
  var __FLUX_TEST_SERVER__: { server: import('node:http').Server; base: string } | undefined
}

globalThis.__FLUX_TEST_SERVER__ = await startTestFileServer()
