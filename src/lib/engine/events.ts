/**
 * Structured engine events (plan P3-08 / P3-09).
 *
 * The engine never calls `console.*` directly. Every noteworthy step is a
 * named event with a small data payload, routed to the in-app debug log (which
 * backs the Debug console). Nothing is rendered unless debug mode is on, and
 * the ring buffer keeps the cost bounded.
 */

import { addDebugEntry, type DebugLevel } from '../debugLog'

export type EngineEventName =
  | 'download.probe.start'
  | 'download.probe.complete'
  | 'download.plan'
  | 'download.segment.start'
  | 'download.segment.retry'
  | 'download.segment.complete'
  | 'download.segment.short'
  | 'download.range.unverified'
  | 'download.pause.requested'
  | 'download.checkpoint.saved'
  | 'download.checkpoint.restored'
  | 'download.checkpoint.discarded'
  | 'download.resume'
  | 'download.fallback.plain'
  | 'download.integrity.failure'
  | 'download.resource.changed'
  | 'download.verify'
  | 'download.checksum'
  | 'download.complete'
  | 'download.failed'
  | 'download.status.invalid'

const LEVEL: Partial<Record<EngineEventName, DebugLevel>> = {
  'download.segment.retry': 'warn',
  'download.segment.short': 'warn',
  'download.range.unverified': 'warn',
  'download.fallback.plain': 'warn',
  'download.checkpoint.discarded': 'warn',
  'download.status.invalid': 'warn',
  'download.integrity.failure': 'error',
  'download.resource.changed': 'error',
  'download.failed': 'error',
  'download.pause.requested': 'info',
  'download.checkpoint.saved': 'info',
  'download.checkpoint.restored': 'info',
  'download.resume': 'info',
  'download.complete': 'info',
  'download.checksum': 'info',
}

export type EngineEventListener = (name: EngineEventName, data: Record<string, unknown>) => void

const listeners = new Set<EngineEventListener>()

/** Subscribe to raw engine events (tests, diagnostics). Returns an unsubscribe function. */
export function onEngineEvent(listener: EngineEventListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function engineEvent(name: EngineEventName, data: Record<string, unknown> = {}): void {
  const label = typeof data.file === 'string' ? `${name} · ${data.file}` : name
  addDebugEntry(LEVEL[name] ?? 'debug', 'engine', label, data)
  for (const listener of listeners) {
    try {
      listener(name, data)
    } catch {
      /* listeners must never break the engine */
    }
  }
}
