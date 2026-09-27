// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useContext } from 'react'
import { MotionConfigContext } from 'framer-motion'
import { DownloadList } from './components/DownloadList'
import { DetailsPanel } from './components/DetailsPanel'
import { MotionPreferences } from './components/MotionPreferences'
import { SegmentBar } from './components/SegmentBar'
import { useStore } from './store/useStore'
import { DEFAULT_AUTH, EMPTY_DIAGNOSTICS, DEFAULT_SETTINGS, type DownloadTask } from './types'

// Track list-control renders without mocking the store or the download cards.
const { searchRenders } = vi.hoisted(() => ({ searchRenders: vi.fn() }))
vi.mock('lucide-react', async (original) => ({
  ...await original<typeof import('lucide-react')>(),
  Search: () => { searchRenders(); return <svg /> },
}))
Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

function task(id: string, status: DownloadTask['status'] = 'downloading'): DownloadTask {
  return {
    id, url: `https://example.com/${id}.zip`, filename: `${id}.zip`, mime: 'application/zip',
    status, totalBytes: 1000, receivedBytes: 100, connections: 8, speedLimit: 0, maxRetries: 5,
    auth: { ...DEFAULT_AUTH }, headers: [], createdAt: Date.now(), startedAt: null, completedAt: null,
    error: null, supportsRanges: true, segments: [], speed: 256, speedHistory: [], saveMode: 'memory',
    terminalFailureCount: 0, priority: 0, queuedAt: 0, expectedChecksum: null, checksumVerified: null,
    identity: null, diagnostics: { ...EMPTY_DIAGNOSTICS }, effectiveUrl: `https://example.com/${id}.zip`, proxyUsed: false, handleKey: null,
    awaitingTarget: false, resultUrl: null,
  }
}

beforeEach(() => {
  searchRenders.mockClear()
  useStore.setState({
    tasks: { first: task('first'), second: task('second', 'paused') }, order: ['first', 'second'],
    selectedId: null, filter: 'all', search: '', settings: { ...DEFAULT_SETTINGS },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
afterAll(async () => {
  const server = (globalThis as { __FLUX_TEST_SERVER__?: { server: import('node:http').Server } }).__FLUX_TEST_SERVER__?.server
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it('updates only the affected row on progress, not list controls', () => {
  render(<MotionPreferences><DownloadList /></MotionPreferences>)
  const renders = searchRenders.mock.calls.length
  const otherRow = screen.getByRole('button', { name: 'second.zip' }).closest('li')!
  const previousMarkup = otherRow.innerHTML
  act(() => useStore.getState().updateTask('first', { receivedBytes: 500 }))
  expect(screen.getByText('50%')).toBeTruthy()
  expect(searchRenders).toHaveBeenCalledTimes(renders)
  expect(otherRow.innerHTML).toBe(previousMarkup)
})

it('keeps filters and counts current when a task changes status', async () => {
  render(<MotionPreferences><DownloadList /></MotionPreferences>)
  fireEvent.click(screen.getByRole('button', { name: 'Active 1' }))
  act(() => useStore.getState().updateTask('first', { status: 'completed' }))
  expect(screen.getByText('No matches')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Completed 1' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Completed 1' }))
  expect(await screen.findByRole('button', { name: 'first.zip' })).toBeTruthy()
})

it('filters while typing and restores focus when clearing search', async () => {
  render(<MotionPreferences><DownloadList /></MotionPreferences>)
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Filter downloads' })
  fireEvent.change(input, { target: { value: 'second' } })
  expect(input.value).toBe('second')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'first.zip' })).toBeNull())
  expect(screen.getByRole('button', { name: 'second.zip' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
  expect(input.value).toBe('')
  expect(document.activeElement).toBe(input)
  expect(await screen.findByRole('button', { name: 'first.zip' })).toBeTruthy()
})

it('switches details immediately without unmounting the panel', () => {
  render(<MotionPreferences><DownloadList /><DetailsPanel /></MotionPreferences>)
  const panel = screen.getByRole('complementary', { name: 'Download details' })
  for (const name of ['first', 'second', 'first']) {
    fireEvent.click(screen.getByRole('button', { name: `${name}.zip` }))
    expect(screen.getByRole('complementary', { name: 'Download details' })).toBe(panel)
    expect(within(panel).getByRole('heading', { name: `${name}.zip` })).toBeTruthy()
  }
})

it('shows paused state and zero speed immediately after pausing', () => {
  act(() => useStore.getState().select('first'))
  render(<MotionPreferences><DetailsPanel /></MotionPreferences>)
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  expect(useStore.getState().tasks.first?.speed).toBe(0)
  expect(screen.getByText('Paused')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
})

it('uses transforms for progress and fills completed segments completely', () => {
  const segment = { index: 0, start: 0, end: 999, received: 500, status: 'active' as const, attempts: 0, speed: 1 }
  const { container, rerender } = render(<SegmentBar segments={[segment]} total={1000} status="downloading" />)
  const fill = container.querySelector<HTMLElement>('.progress-fill')!
  expect(fill.style.transform).toBe('scaleX(0.5)')
  expect(fill.style.width).toBe('')
  rerender(<SegmentBar segments={[segment]} total={1000} status="completed" />)
  expect(fill.style.transform).toBe('scaleX(1)')
})

function MotionProbe() {
  const config = useContext(MotionConfigContext)
  return <output data-testid="motion">{JSON.stringify({ reduced: config.reducedMotion, duration: config.transition?.duration })}</output>
}

it('uses quick transitions and turns all JS transitions off when Reduce motion is enabled', () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList)
  render(<MotionPreferences><MotionProbe /></MotionPreferences>)
  expect(JSON.parse(screen.getByTestId('motion').textContent!)).toEqual({ reduced: 'never', duration: 0.16 })
  act(() => useStore.getState().updateSettings({ reducedMotion: true }))
  expect(JSON.parse(screen.getByTestId('motion').textContent!)).toEqual({ reduced: 'always', duration: 0 })
  act(() => useStore.getState().updateSettings({ reducedMotion: false }))
  expect(JSON.parse(screen.getByTestId('motion').textContent!)).toEqual({ reduced: 'never', duration: 0.16 })
})

it('follows live OS reduced-motion changes even when the in-app option is off', () => {
  const media = new EventTarget()
  Object.assign(media, { matches: false })
  vi.spyOn(window, 'matchMedia').mockReturnValue(media as MediaQueryList)
  render(<MotionPreferences><MotionProbe /></MotionPreferences>)
  act(() => {
    Object.assign(media, { matches: true })
    media.dispatchEvent(new Event('change'))
  })
  expect(JSON.parse(screen.getByTestId('motion').textContent!)).toEqual({ reduced: 'always', duration: 0 })
})
