/**
 * Decides where a download's bytes go, following the user's preference and
 * degrading gracefully when a capability is missing.
 */

import type { SaveMode } from '../../types'
import { isFsaSupported } from './sinks/fsa'
import { FsaSink } from './sinks/fsaSink'
import { MemorySink } from './sinks/memorySink'
import type { FsaFileHandle } from './sinks/fsa'
import { StreamSink } from './sinks/streamSink'
import type { Sink, SinkContext } from './sinks/types'
import { isSwControlling, prepareStreamSink } from './sinks/swBridge'

export type PreferredMode = 'auto' | SaveMode

let swReady: Promise<boolean> | null = null
let swAvailable = false

/** Kicks off service-worker registration as early as possible. */
export function bootstrapSinks(): void {
  if (!swReady) swReady = prepareStreamSink().catch(() => false)
  void swReady.then((ok) => {
    swAvailable = ok
  })
}

export async function refreshSinkCapabilities(): Promise<{ sw: boolean; fsa: boolean }> {
  swReady = prepareStreamSink().catch(() => false)
  swAvailable = await swReady
  return { sw: swAvailable, fsa: isFsaSupported() }
}

export function getSinkCapabilities(): { sw: boolean; fsa: boolean } {
  return { sw: swAvailable || isSwControlling(), fsa: isFsaSupported() }
}

export async function resolveSaveMode(preferred: PreferredMode): Promise<SaveMode> {
  if (preferred !== 'auto') return preferred
  if (swAvailable || isSwControlling()) return 'stream'
  if (!swReady) {
    swReady = prepareStreamSink().catch(() => false)
    swAvailable = await swReady
    if (swAvailable) return 'stream'
  }
  return isFsaSupported() ? 'fsa' : 'memory'
}

export interface SinkRequest extends SinkContext {
  preferred: PreferredMode
  /** Handle already chosen by the user (or restored from IndexedDB). */
  handle: FsaFileHandle | null
  /** Called when we had to fall back, so the UI can explain why. */
  onFallback?: (mode: SaveMode, reason: string) => void
}

export async function createSink(request: SinkRequest): Promise<Sink> {
  const preferred = request.preferred === 'auto' ? await resolveSaveMode('auto') : request.preferred
  const order: SaveMode[] = [preferred, ...(['stream', 'fsa', 'memory'] as SaveMode[]).filter((m) => m !== preferred)]
  let lastError: unknown = null

  for (const mode of order) {
    try {
      switch (mode) {
        case 'fsa': {
          if (!request.handle) continue
          if (!isFsaSupported()) continue
          return await FsaSink.open(request.handle, request)
        }
        case 'stream': {
          if (!(swAvailable || isSwControlling())) {
            if (preferred === 'stream') {
              const ok = await prepareStreamSink()
              swAvailable = ok
              if (!ok) continue
            } else {
              continue
            }
          }
          return await StreamSink.open(request)
        }
        case 'memory':
          return new MemorySink(request)
      }
    } catch (error) {
      lastError = error
      request.onFallback?.(mode, error instanceof Error ? error.message : String(error))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No download sink is available in this browser')
}
