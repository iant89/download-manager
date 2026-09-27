// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DebugConsole } from './DebugConsole'
import { SettingsDialog } from './SettingsDialog'
import { useStore } from '../store/useStore'
import { DEFAULT_SETTINGS } from '../types'
import { debug, flushDebugLog, useDebugLog } from '../lib/debugLog'

Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

beforeEach(() => {
  localStorage.clear()
  useDebugLog.getState().clear()
  useStore.setState({ settings: { ...DEFAULT_SETTINGS }, ui: { ...useStore.getState().ui, settingsOpen: false } })
})
afterEach(cleanup)

const titleBar = () => screen.getByRole('button', { name: /debug console/i })

it('is hidden until debug mode is turned on in settings', () => {
  render(<><SettingsDialog /><DebugConsole /></>)
  expect(screen.queryByLabelText('Debug console')).toBeNull()
  act(() => useStore.getState().setUi({ settingsOpen: true }))
  fireEvent.click(screen.getByRole('switch', { name: /debug mode/i }))
  expect(useStore.getState().settings.debugMode).toBe(true)
  expect(screen.getByLabelText('Debug console')).toBeTruthy()
})

it('starts collapsed as a slim bar and toggles on each title bar click', async () => {
  useStore.setState({ settings: { ...DEFAULT_SETTINGS, debugMode: true } })
  render(<DebugConsole />)
  expect(titleBar().getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByRole('log')).toBeNull()

  fireEvent.click(titleBar())
  expect(titleBar().getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByRole('log')).toBeTruthy()

  fireEvent.click(titleBar())
  expect(titleBar().getAttribute('aria-expanded')).toBe('false')
  await act(() => new Promise((r) => setTimeout(r, 400)))
  expect(screen.queryByRole('log')).toBeNull()
})

it('shows logged entries, filters by level and clears', () => {
  useStore.setState({ settings: { ...DEFAULT_SETTINGS, debugMode: true } })
  render(<DebugConsole />)
  act(() => {
    debug.info('store', 'Added download a.zip')
    debug.error('engine', 'a.zip: downloading → failed')
    flushDebugLog()
  })
  expect(screen.getByText('1 error')).toBeTruthy()
  fireEvent.click(titleBar())
  expect(screen.getByText('Added download a.zip')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /^Errors/ }))
  expect(screen.queryByText('Added download a.zip')).toBeNull()
  expect(screen.getByText('a.zip: downloading → failed')).toBeTruthy()
  fireEvent.click(screen.getByLabelText('Clear log'))
  expect(useDebugLog.getState().entries).toHaveLength(0)
})
