import { describe, expect, it } from 'vitest'
import { carriesCredentials, RequestResolver } from './requestResolver'
import { DEFAULT_AUTH } from '../types'

const source = { url: 'https://files.example.com/a.zip', headers: [], auth: { ...DEFAULT_AUTH } }
const make = (proxyMode: 'off' | 'auto' | 'always', proxyTemplate = 'https://proxy.test/?u={url}') => new RequestResolver(() => ({ proxyMode, proxyTemplate }))

describe('RequestResolver', () => {
  it('goes direct unless the proxy is always on', () => {
    expect(make('auto').resolve(source)).toMatchObject({ url: source.url, proxyUsed: false })
    expect(make('always').resolve(source).proxyUsed).toBe(true)
    expect(make('always', '  ').resolve(source).proxyUsed).toBe(false)
  })

  it('retries via proxy only for CORS-looking failures in auto mode, once', () => {
    expect(make('auto').shouldRetryViaProxy('Failed to fetch', false)).toBe(true)
    expect(make('auto').shouldRetryViaProxy('Failed to fetch', true)).toBe(false)
    expect(make('auto').shouldRetryViaProxy('HTTP 404', false)).toBe(false)
    expect(make('off').shouldRetryViaProxy('Failed to fetch', false)).toBe(false)
  })

  it('flags credentials that would pass through the proxy', () => {
    const bearer = { ...source, auth: { ...DEFAULT_AUTH, kind: 'bearer' as const, token: 't' } }
    expect(make('always').resolve(bearer).exposesCredentials).toBe(true)
    expect(make('auto').resolve(bearer).exposesCredentials).toBe(false)
    expect(make('auto').resolveViaProxy(bearer).exposesCredentials).toBe(true)
    expect(carriesCredentials({ auth: DEFAULT_AUTH, headers: [{ id: '1', name: 'X-Api-Key', value: 'k', enabled: true }] })).toBe(true)
    expect(carriesCredentials({ auth: DEFAULT_AUTH, headers: [{ id: '1', name: 'Accept', value: '*/*', enabled: true }] })).toBe(false)
  })
})
