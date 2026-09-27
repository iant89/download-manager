/**
 * Request resolution and CORS-proxy policy (plan P2-01 / P2-02).
 *
 * Decides which URL is actually fetched and whether a failure should be
 * retried through the user's proxy. The store asks; it doesn't need to know
 * how proxies or CORS failures work.
 */

import type { AuthConfig, HeaderEntry, Settings } from '../types'
import { applyProxy, buildRequestHeaders } from './http'

export interface DownloadSource {
  url: string
  headers: HeaderEntry[]
  auth: AuthConfig
}

export interface ResolvedRequest {
  url: string
  headers: Record<string, string>
  proxyUsed: boolean
  /** Credentials/custom headers will be sent to the proxy host. */
  exposesCredentials: boolean
}

type ProxySettings = Pick<Settings, 'proxyMode' | 'proxyTemplate'>

export class RequestResolver {
  constructor(private getSettings: () => ProxySettings) {}

  /** Initial request for a new download. */
  resolve(source: DownloadSource): ResolvedRequest {
    const settings = this.getSettings()
    const proxyUsed = settings.proxyMode === 'always' && Boolean(settings.proxyTemplate.trim())
    return this.build(source, proxyUsed)
  }

  /** Same source, forced through the proxy (automatic CORS fallback). */
  resolveViaProxy(source: DownloadSource): ResolvedRequest {
    return this.build(source, true)
  }

  /**
   * Cross-origin failures surface as an opaque TypeError ("Failed to fetch");
   * in `auto` mode those are retried once through the proxy.
   */
  shouldRetryViaProxy(error: string | null | undefined, alreadyProxied: boolean): boolean {
    const settings = this.getSettings()
    if (settings.proxyMode !== 'auto' || !settings.proxyTemplate.trim() || alreadyProxied) return false
    return !error || /failed to fetch|networkerror|load failed|blocked by cors|blocked/i.test(error)
  }

  /** True when the configured proxy would see the source's credentials. */
  proxyWouldSeeCredentials(source: Pick<DownloadSource, 'auth' | 'headers'>): boolean {
    const settings = this.getSettings()
    if (settings.proxyMode === 'off' || !settings.proxyTemplate.trim()) return false
    return carriesCredentials(source)
  }

  private build(source: DownloadSource, proxyUsed: boolean): ResolvedRequest {
    const template = this.getSettings().proxyTemplate
    return {
      url: proxyUsed ? applyProxy(source.url, template) : source.url,
      headers: buildRequestHeaders(source.auth, source.headers),
      proxyUsed,
      exposesCredentials: proxyUsed && carriesCredentials(source),
    }
  }
}

const SENSITIVE_HEADER = /^(authorization|x-api-key|x-auth-token|x-csrf-token|api-key|token|x-access-token)$/i

/** Auth configured, or a custom header that looks like a credential. */
export function carriesCredentials(source: Pick<DownloadSource, 'auth' | 'headers'>): boolean {
  if (source.auth.kind === 'basic' && (source.auth.username || source.auth.password)) return true
  if (source.auth.kind === 'bearer' && source.auth.token.trim()) return true
  return source.headers.some((h) => h.enabled && h.name.trim() && (SENSITIVE_HEADER.test(h.name.trim()) || /token|secret|key|auth/i.test(h.name)))
}
