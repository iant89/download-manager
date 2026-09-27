/**
 * Explicit download state machine (plan P1-04).
 *
 *   queued → probing → downloading → verifying → finalizing → completed
 *                           │
 *                           ├→ pausing → paused → (queued | probing | downloading)
 *                           ├→ failed
 *                           └→ canceled
 *
 * Connection-level retries are tracked per segment (`SegmentState.status =
 * 'retrying'`), so the task itself stays `downloading` while one of its
 * connections backs off.
 */

import type { DownloadStatus } from '../../types'

export const TRANSITIONS: Readonly<Record<DownloadStatus, readonly DownloadStatus[]>> = {
  queued: ['probing', 'downloading', 'paused', 'failed', 'canceled'],
  // `probing` covers "waiting for the user to pick a save location" too.
  probing: ['downloading', 'verifying', 'pausing', 'paused', 'failed', 'canceled'],
  downloading: ['pausing', 'verifying', 'failed', 'canceled'],
  pausing: ['paused', 'failed', 'canceled'],
  paused: ['queued', 'probing', 'downloading', 'failed', 'canceled'],
  verifying: ['finalizing', 'failed', 'canceled'],
  finalizing: ['completed', 'failed'],
  completed: [],
  // Retrying a failed/canceled download starts over.
  failed: ['queued', 'probing', 'canceled'],
  canceled: ['queued', 'probing'],
}

export function canTransition(from: DownloadStatus, to: DownloadStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

/** Returns the first invalid step in a sequence of statuses, or null. */
export function findInvalidTransition(sequence: DownloadStatus[]): { from: DownloadStatus; to: DownloadStatus; index: number } | null {
  for (let i = 1; i < sequence.length; i += 1) {
    const from = sequence[i - 1]!
    const to = sequence[i]!
    if (!canTransition(from, to)) return { from, to, index: i }
  }
  return null
}
