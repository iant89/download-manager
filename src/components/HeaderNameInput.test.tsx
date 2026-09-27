// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { HeaderNameInput } from './HeaderNameInput'
import { COMMON_REQUEST_HEADERS, filterHeaderSuggestions } from '../lib/commonHeaders'
import { isForbiddenRequestHeader } from '../lib/http'

afterEach(cleanup)

function Harness({ onKey }: { onKey?: () => void }) {
  const [value, setValue] = useState('')
  return (
    <div onKeyDown={onKey}>
      <HeaderNameInput aria-label="Header name" value={value} onChange={setValue} />
      <output data-testid="value">{value}</output>
    </div>
  )
}

const input = () => screen.getByLabelText<HTMLInputElement>('Header name')
const options = () => screen.queryAllByRole('option').map((o) => o.textContent)

it('never suggests browser-forbidden headers', () => {
  expect(COMMON_REQUEST_HEADERS.some((h) => isForbiddenRequestHeader(h))).toBe(false)
})

it('ranks prefix matches before substring matches', () => {
  const list = filterHeaderSuggestions('auth')
  expect(list[0]).toBe('Authorization')
  expect(list).toContain('X-Auth-Token')
})

it('shows all suggestions on focus and filters while typing', () => {
  render(<Harness />)
  fireEvent.focus(input())
  expect(options()).toHaveLength(COMMON_REQUEST_HEADERS.length)
  fireEvent.change(input(), { target: { value: 'if-' } })
  expect(options().every((o) => o!.toLowerCase().startsWith('if-'))).toBe(true)
  expect(input().getAttribute('aria-expanded')).toBe('true')
})

it('hides the drop-down when nothing matches', () => {
  render(<Harness />)
  fireEvent.focus(input())
  fireEvent.change(input(), { target: { value: 'zzz-nope' } })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(input().getAttribute('aria-expanded')).toBe('false')
})

it('picks with the keyboard and with the mouse', () => {
  render(<Harness />)
  fireEvent.focus(input())
  fireEvent.change(input(), { target: { value: 'range' } })
  fireEvent.keyDown(input(), { key: 'ArrowDown' })
  fireEvent.keyDown(input(), { key: 'Enter' })
  expect(input().value).toBe('Range')
  expect(screen.queryByRole('listbox')).toBeNull()

  fireEvent.change(input(), { target: { value: 'user' } })
  fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent === 'User-Agent')!)
  expect(input().value).toBe('User-Agent')
})

it('Escape closes only the list', () => {
  let bubbled = 0
  render(<Harness onKey={() => { bubbled += 1 }} />)
  fireEvent.focus(input())
  fireEvent.keyDown(input(), { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(bubbled).toBe(0)
})
