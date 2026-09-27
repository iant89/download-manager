/**
 * Resource prober (plan P2-08).
 *
 * Dedicated class that learns everything we can about a URL before committing
 * to a download plan. It encapsulates HEAD probing, CORS-aware header reading,
 * and the fallback to the first GET. Transport delegates to it, taskRunner
 * consumes its result.
 */

import { probeResource, type ProbeResult } from '../http'
import type { ResourceIdentity } from './checkpoint'

export interface ResourceInfo {
  size: number | null
  acceptsRanges: boolean
  etag: string | null
  lastModified: string | null
  contentType: string | null
  filename: string | null
  finalUrl: string
  /** Raw Accept-Ranges header value, when readable */
  acceptsRangesHeader: string | null
}

export class ResourceProbe {
  /**
   * Probes the remote resource via HEAD. Never throws for a blocked HEAD;
   * callers learn the size from the first GET instead. Only aborts are
   * re-thrown.
   */
  async probe(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<ResourceInfo> {
    const result: ProbeResult = await probeResource(url, headers, signal)
    return {
      size: result.totalBytes,
      acceptsRanges: result.supportsRanges,
      etag: result.etag,
      lastModified: result.lastModified,
      contentType: result.contentType,
      filename: result.filename,
      finalUrl: result.finalUrl,
      acceptsRangesHeader: result.acceptsRangesHeader,
    }
  }

  /**
   * Converts probe result into a ResourceIdentity for checkpointing.
   */
  toIdentity(info: ResourceInfo): Partial<ResourceIdentity> {
    return {
      etag: info.etag,
      lastModified: info.lastModified,
      totalBytes: info.size,
      contentType: info.contentType,
    }
  }
}

export const defaultResourceProbe = new ResourceProbe()
