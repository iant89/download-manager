import { afterAll, expect, it } from 'vitest'
import { buildRequestHeaders, isForbiddenRequestHeader } from './http'
import { DEFAULT_AUTH } from '../types'

afterAll(async () => {
  const server = (globalThis as { __FLUX_TEST_SERVER__?: { server: import('node:http').Server } }).__FLUX_TEST_SERVER__?.server
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

it.each([
  'Accept-Charset', 'Accept-Encoding', 'Access-Control-Request-Headers',
  'Access-Control-Request-Method', 'Connection', 'Content-Length', 'Cookie',
  'Cookie2', 'Date', 'DNT', 'Expect', 'Host', 'Keep-Alive', 'Origin',
  'Permissions-Policy', 'Referer', 'Set-Cookie', 'TE', 'Trailer',
  'Transfer-Encoding', 'Upgrade', 'Via', 'Proxy-Authorization', 'Sec-Fetch-Site',
])('rejects browser-controlled header %s regardless of casing or whitespace', (name) => {
  expect(isForbiddenRequestHeader(` ${name.toUpperCase()} `)).toBe(true)
})

it.each(['X-Api-Key', 'Authorization', 'Content-Type', 'Accept', 'Range', 'X-Cookie', ''])('allows %s', (name) => {
  expect(isForbiddenRequestHeader(name)).toBe(false)
})

it.each(['X-HTTP-Method', 'X-HTTP-Method-Override', 'X-Method-Override'])('checks forbidden methods in %s', (name) => {
  for (const method of ['CONNECT', 'trace', ' TRACK ', 'GET, TRACE']) {
    expect(isForbiddenRequestHeader(name, method)).toBe(true)
  }
  expect(isForbiddenRequestHeader(name, 'PATCH')).toBe(false)
})

it('filters forbidden headers using the same rules as the dialog', () => {
  const headers = ['Cookie', 'Sec-Custom', 'Proxy-Custom', 'Permissions-Policy', 'X-HTTP-Method'].map((name) => ({ id: name, name, value: 'TRACE', enabled: true }))
  headers.push({ id: 'allowed', name: ' X-Api-Key ', value: 'key', enabled: true })
  headers.push({ id: 'disabled', name: 'X-Disabled', value: 'hidden', enabled: false })
  expect(buildRequestHeaders(DEFAULT_AUTH, headers)).toEqual({ 'X-Api-Key': 'key' })
})
