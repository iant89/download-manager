/**
 * HTTP helpers: request header construction, CORS-proxy rewriting and remote
 * resource probing.
 *
 * A browser can only read "CORS-safelisted" response headers cross-origin
 * (`Content-Length` and `Content-Type` are safelisted; `Accept-Ranges`,
 * `Content-Range` and `Content-Disposition` are not). So probing is best-effort:
 * we ask for what we can and degrade gracefully when the server hides it.
 */

import type { AuthConfig, HeaderEntry } from '../types'

export interface ProbeResult {
  finalUrl: string
  totalBytes: number | null
  contentType: string | null
  filename: string | null
  /** True only when we positively confirmed range support. */
  supportsRanges: boolean
}

const SAFE_FILENAME = /[^\p{L}\p{N}._\-()[\] ]+/gu

export function buildRequestHeaders(
  auth: AuthConfig,
  headers: HeaderEntry[],
  extra?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of headers) {
    if (!entry.enabled) continue
    const name = entry.name.trim()
    if (!name) continue
    // Forbidden header names are ignored by fetch anyway; filtering keeps the
    // devtools/UI honest about what actually goes on the wire.
    if (FORBIDDEN.has(name.toLowerCase())) continue
    out[name] = entry.value
  }

  switch (auth.kind) {
    case 'basic': {
      const raw = `${auth.username}:${auth.password}`
      const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(raw)))
      out['Authorization'] = `Basic ${encoded}`
      break
    }
    case 'bearer':
      if (auth.token) out['Authorization'] = `Bearer ${auth.token.trim()}`
      break
    case 'none':
    case 'headers':
    default:
      break
  }

  return { ...out, ...extra }
}

const FORBIDDEN = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
])

/** Rewrites a URL through the user-configured CORS proxy template. */
export function applyProxy(url: string, template: string): string {
  const tpl = template.trim()
  if (!tpl) return url
  if (tpl.includes('{url}')) return tpl.replace('{url}', url)
  if (tpl.includes('{encoded}')) return tpl.replace('{encoded}', encodeURIComponent(url))
  return tpl.endsWith('=') || tpl.endsWith('?') || tpl.endsWith('/') ? tpl + encodeURIComponent(url) : tpl + url
}

export function parseContentDispositionFilename(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*([^']*)''([^;]+)/i.exec(header)
  if (star) {
    try {
      return safeFilename(decodeURIComponent(star[2]!.trim()))
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header)
  if (plain) {
    const value = (plain[2] ?? plain[3] ?? '').trim()
    if (value) return safeFilename(value)
  }
  return null
}

export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/]+/g, '_')
    .replace(SAFE_FILENAME, '_')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows-hostile tails: no trailing dots or spaces.
    .replace(/[. ]+$/, '')
  return cleaned.replace(/^\.+/, '') || 'download'
}

export function guessFilename(url: string, contentType?: string | null): string {
  try {
    const u = new URL(url)
    const base = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '')
    if (base) return safeFilename(base)
  } catch {
    /* ignore */
  }
  const ext = contentType ? extensionForType(contentType.split(';')[0]!.trim()) : ''
  return `download${ext}`
}

function extensionForType(mime: string): string {
  const map: Record<string, string> = {
    'application/zip': '.zip',
    'application/pdf': '.pdf',
    'application/json': '.json',
    'application/octet-stream': '',
    'application/x-7z-compressed': '.7z',
    'application/gzip': '.gz',
    'application/x-tar': '.tar',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'text/html': '.html',
    'text/plain': '.txt',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
  }
  return map[mime] ?? ''
}

export function isLikelyCorsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name = (error as { name?: string }).name ?? ''
  return name === 'TypeError' && /failed to fetch|networkerror|load failed|blocked/i.test(error.message)
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: 'http' | 'network' | 'aborted' = 'http',
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Cheap HEAD probe used to learn the size before splitting into segments. */
export async function probeResource(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<ProbeResult> {
  let headOk = false
  let totalBytes: number | null = null
  let contentType: string | null = null
  let filename: string | null = null
  let finalUrl = url

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers,
      signal,
      redirect: 'follow',
      mode: 'cors',
      credentials: 'omit',
    })
    finalUrl = res.url || url
    headOk = res.ok
    if (res.ok) {
      const len = res.headers.get('Content-Length')
      if (len) {
        const parsed = Number.parseInt(len, 10)
        if (Number.isFinite(parsed) && parsed >= 0) totalBytes = parsed
      }
      contentType = res.headers.get('Content-Type')
      filename = parseContentDispositionFilename(res.headers.get('Content-Disposition'))
    }
  } catch (error) {
    if (isAbort(error)) throw error
    // HEAD is frequently blocked (405/501) or disallowed by CORS policy — the
    // caller falls back to learning the size from the first GET response.
  }

  return {
    finalUrl,
    totalBytes,
    contentType,
    filename: filename ?? (headOk ? null : null),
    supportsRanges: false,
  }
}

export function isAbort(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || /aborted/i.test(error.message)
}
