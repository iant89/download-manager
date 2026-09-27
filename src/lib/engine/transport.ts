/**
 * HTTP transport (plan P2-07): the only place that issues download requests
 * and interprets range-related response headers. `TaskRunner` deals in
 * segments, retries and state; this module deals in HTTP.
 */

import { HttpError, type ProbeResult } from '../http'
import type { ResourceIdentity } from './checkpoint'
import { parseContentRange, parseUnsatisfiedTotal, validateRangeResponse, type ContentRange } from './contentRange'
import { parseRetryAfter } from './retryPolicy'
import { ResourceProbe } from './resourceProbe'

export interface RangeRequest {
  url: string
  headers: Record<string, string>
  signal: AbortSignal
  /** Omit for a plain (non-ranged) GET. */
  range?: { start: number; end: number | null }
  /** Validator for `If-Range` (strong ETag or Last-Modified). */
  ifRange?: string | null
  /** Size we already believe the resource has; used to validate Content-Range totals. */
  expectedTotal: number | null
}

export type RangeResponseKind =
  /** 206 whose Content-Range was validated (or unreadable — see `rangeVerified`). */
  | 'partial'
  /** 200: the whole representation from byte 0. */
  | 'full'
  /** 416: nothing satisfiable at the requested offset. */
  | 'unsatisfiable'

export interface RangeResponse {
  kind: RangeResponseKind
  status: number
  body: ReadableStream<Uint8Array> | null
  /** Parsed Content-Range for 206 responses, null when the header is not exposed. */
  contentRange: ContentRange | null
  /** False when a 206's Content-Range could not be read (not CORS-exposed). */
  rangeVerified: boolean
  contentLength: number | null
  /** Total from a 416's `bytes * /total`. */
  unsatisfiedTotal: number | null
  identity: Partial<ResourceIdentity>
  /** True if an If-Range validator accompanied the request. */
  sentIfRange: boolean
  cancel(): Promise<void>
}

export interface HttpTransport {
  probe(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<ProbeResult>
  fetchRange(request: RangeRequest): Promise<RangeResponse>
}

export class FetchTransport implements HttpTransport {
  private probeDelegate = new ResourceProbe()

  probe(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<ProbeResult> {
    // Delegates to the dedicated ResourceProbe (plan P2-08); HttpTransport keeps
    // the transport-level concerns (headers / range validation).
    return this.probeDelegate.probe(url, headers, signal).then((info) => ({
      finalUrl: info.finalUrl,
      totalBytes: info.size,
      contentType: info.contentType,
      filename: info.filename,
      supportsRanges: info.acceptsRanges,
      acceptsRangesHeader: info.acceptsRangesHeader,
      etag: info.etag,
      lastModified: info.lastModified,
    }))
  }

  async fetchRange(request: RangeRequest): Promise<RangeResponse> {
    const headers: Record<string, string> = { ...request.headers }
    if (request.range) {
      headers['Range'] = `bytes=${request.range.start}-${request.range.end ?? ''}`
      if (request.ifRange) headers['If-Range'] = request.ifRange
    }
    const sentIfRange = Boolean(request.range && request.ifRange)

    const response = await fetch(request.url, {
      headers,
      signal: request.signal,
      mode: 'cors',
      credentials: 'omit',
      redirect: 'follow',
    })

    const contentLength = readContentLength(response)
    const identity: Partial<ResourceIdentity> = {
      etag: response.headers.get('ETag'),
      lastModified: response.headers.get('Last-Modified'),
      contentType: response.headers.get('Content-Type'),
    }
    const base = {
      status: response.status,
      body: response.body,
      contentLength,
      identity,
      sentIfRange,
      cancel: async () => {
        try {
          await response.body?.cancel()
        } catch {
          /* ignore */
        }
      },
    }

    if (response.status === 416) {
      const unsatisfiedTotal = parseUnsatisfiedTotal(response.headers.get('Content-Range'))
      await base.cancel()
      return { ...base, body: null, kind: 'unsatisfiable', contentRange: null, rangeVerified: false, unsatisfiedTotal }
    }

    if (response.status === 206) {
      if (!request.range) {
        await base.cancel()
        throw new HttpError('Server sent 206 Partial Content to a non-ranged request', 206)
      }
      const header = response.headers.get('Content-Range')
      let contentRange: ContentRange | null = null
      if (header) {
        try {
          contentRange = parseContentRange(header)
          validateRangeResponse(request.range.start, request.range.end, contentRange, request.expectedTotal)
        } catch (error) {
          await base.cancel()
          throw error
        }
        identity.totalBytes = contentRange.total
      }
      return { ...base, kind: 'partial', contentRange, rangeVerified: contentRange != null, unsatisfiedTotal: null }
    }

    if (response.ok) {
      identity.totalBytes = contentLength
      return { ...base, kind: 'full', contentRange: null, rangeVerified: false, unsatisfiedTotal: null }
    }

    await base.cancel()
    throw new HttpError(
      `Server responded ${response.status} ${response.statusText}`.trim(),
      response.status,
      'http',
      parseRetryAfter(response.headers.get('Retry-After')),
    )
  }
}

export function readContentLength(response: Response): number | null {
  const raw = response.headers.get('Content-Length')
  if (!raw) return null
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

export const defaultTransport: HttpTransport = new FetchTransport()
