// @vitest-environment happy-dom
import { it, expect, vi, afterAll } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import App from './App'

const BASE =
  (globalThis as { __FLUX_TEST_SERVER__?: { base: string } }).__FLUX_TEST_SERVER__?.base ??
  'http://localhost:5173'

// happy-dom's Web Animations shim rejects on cancel(); real browsers don't.
// Force framer-motion onto its JS fallback so the test stays quiet.
Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

it('renders, opens the add dialog and enqueues a download', async () => {
  const errors: unknown[] = []
  vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a))
  render(<App />)
  expect(screen.getByText('Flux')).toBeTruthy()
  expect(screen.getByText('Nothing here yet')).toBeTruthy()
  fireEvent.click(screen.getAllByText('New download')[0]!)
  const input = await screen.findByPlaceholderText('https://example.com/file.zip')
  fireEvent.change(input, { target: { value: `${BASE}/testfile/2mb` } })
  fireEvent.click(screen.getByText('Add download'))
  await waitFor(() => expect(screen.getByText('flux-test-2mb.bin')).toBeTruthy(), { timeout: 12000 })
  await act(() => new Promise((r) => setTimeout(r, 1500)))
  fireEvent.click(screen.getAllByText('flux-test-2mb.bin')[0]!)
  expect(await screen.findByText('Source')).toBeTruthy()
  // Settings dialog renders
  fireEvent.click(screen.getByTitle('Settings (,)'))
  expect(await screen.findByText('Appearance')).toBeTruthy()
  const real = errors.filter((e) => !String(e).includes('act(') && !String(e).includes('not wrapped'))
  expect(real, JSON.stringify(real).slice(0, 800)).toHaveLength(0)
}, 20000)

afterAll(async () => {
  const server = (globalThis as { __FLUX_TEST_SERVER__?: { server: { closeAllConnections?(): void; close(cb: () => void): void } } }).__FLUX_TEST_SERVER__?.server
  if (server) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
