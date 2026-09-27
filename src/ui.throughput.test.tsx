// @vitest-environment happy-dom
/**
 * End-to-end check of the two throughput graphs: the header sparkline and the
 * one in the details panel. A real transfer has to leave non-zero samples in
 * the store and a non-flat, well-formed path in the DOM.
 */
import { afterAll, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import App from './App'
import { useStore } from './store/useStore'
import { sparklineGeometry } from './components/Sparkline'

const BASE =
  (globalThis as { __FLUX_TEST_SERVER__?: { base: string } }).__FLUX_TEST_SERVER__?.base ??
  'http://localhost:5173'

// happy-dom's Web Animations shim rejects on cancel(); real browsers don't.
Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

/** Every y coordinate of an SVG path, in drawing order. */
function pathYs(d: string): number[] {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  const out: number[] = []
  if (nums.length < 2) return out
  out.push(nums[1]!)
  for (let i = 2; i + 5 < nums.length + 1; i += 6) out.push(nums[i + 1]!, nums[i + 3]!, nums[i + 5]!)
  return out
}

it('shows throughput while a download runs', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  render(<App />)
  fireEvent.click(screen.getAllByText('New download')[0]!)
  const input = await screen.findByPlaceholderText('https://example.com/file.zip')
  // Throttled so the transfer outlives several 500 ms samples.
  fireEvent.change(input, { target: { value: `${BASE}/testfile/8mb?delay=100&key=ui-throughput&name=graph.bin` } })
  fireEvent.click(screen.getByText('Add download'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'graph.bin' })).toBeTruthy(), { timeout: 20000 })

  let peakTask = 0
  let peakGlobal = 0
  for (let i = 0; i < 40; i += 1) {
    await act(() => new Promise((r) => setTimeout(r, 250)))
    const s = useStore.getState()
    const task = s.tasks[s.order[0]!]!
    peakTask = Math.max(peakTask, ...task.speedHistory)
    peakGlobal = Math.max(peakGlobal, ...s.globalHistory)
    if (task.status === 'completed') break
  }

  const state = useStore.getState()
  const task = state.tasks[state.order[0]!]!
  expect(task.status).toBe('completed')
  expect(peakTask, `speedHistory: ${task.speedHistory.map((v) => Math.round(v)).join(',')}`).toBeGreaterThan(100_000)
  expect(peakGlobal, `globalHistory: ${state.globalHistory.map((v) => Math.round(v)).join(',')}`).toBeGreaterThan(100_000)

  // The details panel is open on the new download; both graphs must have drawn.
  const header = document.querySelector('svg[viewBox="0 0 128 30"] path[fill="none"]')?.getAttribute('d')
  const details = document.querySelector('svg[viewBox="0 0 300 72"] path[fill="none"]')?.getAttribute('d')
  for (const d of [header, details]) {
    expect(d, 'sparkline drew nothing').toBeTruthy()
    const ys = pathYs(d!)
    expect(ys.length).toBeGreaterThan(2)
    expect(ys.every(Number.isFinite)).toBe(true)
    expect(Math.max(...ys) - Math.min(...ys), `flat line: ${d}`).toBeGreaterThan(5)
  }

  // Sanity check on the scaler itself with the samples the run produced.
  const { coords } = sparklineGeometry(task.speedHistory, 300, 72)
  expect(coords.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))).toBe(true)
}, 60000)

afterAll(async () => {
  const server = (globalThis as { __FLUX_TEST_SERVER__?: { server: { closeAllConnections?(): void; close(cb: () => void): void } } }).__FLUX_TEST_SERVER__?.server
  if (server) {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
