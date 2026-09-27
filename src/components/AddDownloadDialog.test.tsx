// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AddDownloadDialog } from './AddDownloadDialog'
import { useStore } from '../store/useStore'
import { DEFAULT_AUTH, DEFAULT_SETTINGS, type NewDownloadInput } from '../types'

Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

const readText = vi.fn<() => Promise<string>>()
const addDownload = vi.fn<(input: NewDownloadInput) => Promise<string | null>>()
const urlInput = () => screen.getByPlaceholderText<HTMLInputElement>('https://example.com/file.zip')
const open = () => act(() => useStore.getState().setUi({ addOpen: true }))
const expand = () => fireEvent.click(screen.getByText('Authentication, headers & limits'))
const addButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Add download' })

beforeEach(() => {
  readText.mockReset().mockResolvedValue('')
  addDownload.mockReset().mockResolvedValue('download-id')
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ readText } as unknown as Clipboard)
  useStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    ui: { ...useStore.getState().ui, addOpen: false },
    addDownload,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

afterAll(async () => {
  const server = (globalThis as { __FLUX_TEST_SERVER__?: { server: import('node:http').Server } }).__FLUX_TEST_SERVER__?.server
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it.each(['Cancel', 'Close', 'Escape', 'backdrop'])('resets all values after closing with %s', async (method) => {
  render(<AddDownloadDialog />)
  open()
  await act(async () => {})
  fireEvent.change(urlInput(), { target: { value: 'https://example.com/old.zip' } })
  fireEvent.change(screen.getByPlaceholderText('old.zip'), { target: { value: 'renamed.zip' } })
  fireEvent.change(screen.getByRole('slider'), { target: { value: '16' } })
  expand()
  fireEvent.click(screen.getByText('Basic'))
  fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'user' } })
  fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByText('Bearer'))
  fireEvent.change(screen.getByPlaceholderText('Token'), { target: { value: 'token' } })
  fireEvent.click(screen.getByText('1 MB/s'))
  fireEvent.click(screen.getByText('Add header'))
  fireEvent.change(screen.getByLabelText('Header name'), { target: { value: 'Cookie' } })
  fireEvent.change(screen.getByLabelText('Header value'), { target: { value: 'private' } })

  if (method === 'Escape') fireEvent.keyDown(window, { key: 'Escape' })
  else if (method === 'backdrop') fireEvent.click(screen.getByRole('dialog').previousElementSibling!)
  else fireEvent.click(screen.getByRole('button', { name: method }))
  expect(useStore.getState().ui.addOpen).toBe(false)
  act(() => useStore.setState({ settings: { ...DEFAULT_SETTINGS, defaultConnections: 4 } }))
  open()
  await act(async () => {})
  expect(urlInput().value).toBe('')
  expect(screen.getByPlaceholderText<HTMLInputElement>('auto-detect').value).toBe('')
  expect(screen.getByRole<HTMLInputElement>('slider').value).toBe('4')
  await waitFor(() => expect(screen.queryByText('Add header')).toBeNull())
  expand()
  expect(screen.queryByPlaceholderText('Token')).toBeNull()
  expect(screen.queryByLabelText('Header name')).toBeNull()
  // Switching auth modes must not reveal credentials from the previous opening.
  fireEvent.click(screen.getByText('Basic'))
  expect(screen.getByPlaceholderText<HTMLInputElement>('Username').value).toBe('')
  expect(screen.getByPlaceholderText<HTMLInputElement>('Password').value).toBe('')
  fireEvent.click(screen.getByText('Bearer'))
  expect(screen.getByPlaceholderText<HTMLInputElement>('Token').value).toBe('')
  fireEvent.click(screen.getByText('None'))
  fireEvent.change(urlInput(), { target: { value: 'https://example.com/new.zip' } })
  fireEvent.click(addButton())
  expect(addDownload).toHaveBeenCalledWith({ url: 'https://example.com/new.zip', filename: undefined, connections: 4, speedLimit: 0, auth: DEFAULT_AUTH, headers: [] })
  await waitFor(() => expect(useStore.getState().ui.addOpen).toBe(false))
})

it('prefills, focuses and selects the entire clipboard URL on every opening', async () => {
  readText.mockResolvedValueOnce('  https://example.com/first.zip\n').mockResolvedValueOnce('https://example.com/second.zip')
  render(<AddDownloadDialog />)
  for (const name of ['first', 'second']) {
    open()
    const url = `https://example.com/${name}.zip`
    await waitFor(() => expect(urlInput().value).toBe(url))
    expect(document.activeElement).toBe(urlInput())
    expect(urlInput().selectionStart).toBe(0)
    expect(urlInput().selectionEnd).toBe(url.length)
    fireEvent.click(screen.getByText('Cancel'))
  }
  expect(readText).toHaveBeenCalledTimes(2)
})

it.each(['plain text', 'https://', 'ftp://example.com/file', 'https://example.com/one https://example.com/two'])('ignores non-links in the clipboard: %s', async (text) => {
  readText.mockResolvedValue(text)
  render(<AddDownloadDialog />)
  open()
  await act(async () => {})
  expect(urlInput().value).toBe('')
})

it('opens normally when clipboard access is denied or unavailable', async () => {
  readText.mockRejectedValue(new Error('Permission denied'))
  render(<AddDownloadDialog />)
  open()
  await act(async () => {})
  expect(urlInput().value).toBe('')
  fireEvent.click(screen.getByText('Cancel'))
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as unknown as Clipboard)
  open()
  expect(urlInput().value).toBe('')
})

it('does not overwrite user edits with a delayed clipboard read, even after clearing the field', async () => {
  let resolve!: (text: string) => void
  readText.mockReturnValue(new Promise<string>((r) => { resolve = r }))
  render(<AddDownloadDialog />)
  open()
  fireEvent.change(urlInput(), { target: { value: 'https://example.com/typed.zip' } })
  fireEvent.change(urlInput(), { target: { value: '' } })
  await act(async () => resolve('https://example.com/clipboard.zip'))
  expect(urlInput().value).toBe('')
})

it('ignores clipboard reads from previous openings', async () => {
  let resolve!: (text: string) => void
  readText.mockReturnValueOnce(new Promise<string>((r) => { resolve = r })).mockResolvedValueOnce('https://example.com/current.zip')
  render(<AddDownloadDialog />)
  open()
  fireEvent.click(screen.getByText('Cancel'))
  open()
  await waitFor(() => expect(urlInput().value).toBe('https://example.com/current.zip'))
  await act(async () => resolve('https://example.com/stale.zip'))
  expect(urlInput().value).toBe('https://example.com/current.zip')
})

it('resets pending submission state and ignores completions from a previous opening', async () => {
  let resolve!: (id: string) => void
  addDownload.mockReturnValueOnce(new Promise<string>((r) => { resolve = r }))
  render(<AddDownloadDialog />)
  open()
  fireEvent.change(urlInput(), { target: { value: 'https://example.com/old.zip' } })
  fireEvent.click(addButton())
  expect(screen.getByText('Adding…')).toBeTruthy()
  fireEvent.click(screen.getByText('Cancel'))
  open()
  expect(urlInput().value).toBe('')
  fireEvent.change(urlInput(), { target: { value: 'https://example.com/new.zip' } })
  expect(addButton().disabled).toBe(false)
  await act(async () => resolve('old-id'))
  expect(useStore.getState().ui.addOpen).toBe(true)
  expect(urlInput().value).toBe('https://example.com/new.zip')
})

it('shows forbidden headers as invalid and blocks submission until corrected or removed', async () => {
  render(<AddDownloadDialog />)
  open()
  fireEvent.change(urlInput(), { target: { value: 'https://example.com/file.zip' } })
  expand()
  fireEvent.click(screen.getByText('Add header'))
  const name = screen.getByLabelText('Header name')
  for (const forbidden of ['Cookie', ' ORIGIN ', 'Sec-Fetch-Site', 'Proxy-Authorization', 'Content-Length']) {
    fireEvent.change(name, { target: { value: forbidden } })
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('alert').id).toBe(name.getAttribute('aria-describedby'))
    expect(addButton().disabled).toBe(true)
    fireEvent.submit(urlInput().closest('form')!)
    expect(addDownload).not.toHaveBeenCalled()
  }
  fireEvent.change(name, { target: { value: 'X-Api-Key' } })
  expect(name.getAttribute('aria-invalid')).toBe('false')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(addButton().disabled).toBe(false)
  fireEvent.change(name, { target: { value: 'X-HTTP-Method-Override' } })
  fireEvent.change(screen.getByLabelText('Header value'), { target: { value: 'TRACE' } })
  expect(name.getAttribute('aria-invalid')).toBe('true')
  fireEvent.click(screen.getByLabelText('Remove header'))
  expect(addButton().disabled).toBe(false)
  fireEvent.click(addButton())
  await waitFor(() => expect(addDownload).toHaveBeenCalledTimes(1))
})

it('shows the URL filename hint without sample download buttons', () => {
  render(<AddDownloadDialog />)
  open()
  expect(screen.getByText('Leave blank to use the URL filename')).toBeTruthy()
  expect(screen.queryByText('try a sample')).toBeNull()
  expect(screen.queryByText(/20 MB/)).toBeNull()
})
