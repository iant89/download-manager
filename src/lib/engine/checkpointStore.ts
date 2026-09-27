/**
 * Dedicated persistence for resume state (plan P1-07).
 *
 * The runner is the only writer; the store's hydrate path is the only reader.
 * Keeping it behind an interface lets tests swap in an in-memory store to
 * simulate a crash and reload.
 */

import { del, get, set } from 'idb-keyval'
import type { DownloadCheckpoint } from './checkpoint'
import { migrateCheckpoint } from './checkpoint'
import { CheckpointError } from './errors'

export interface CheckpointStore {
  save(id: string, checkpoint: DownloadCheckpoint): Promise<void>
  /**
   * Resolves null when there is no checkpoint. Rejects with a
   * `CheckpointError` when one exists but is corrupt or from an unknown
   * version, so callers can tell "nothing saved" from "cannot restore".
   */
  load(id: string): Promise<DownloadCheckpoint | null>
  remove(id: string): Promise<void>
}

const KEY_PREFIX = 'flux.checkpoint.'

export class IdbCheckpointStore implements CheckpointStore {
  async save(id: string, checkpoint: DownloadCheckpoint): Promise<void> {
    await set(KEY_PREFIX + id, checkpoint)
  }

  async load(id: string): Promise<DownloadCheckpoint | null> {
    let raw: unknown
    try {
      raw = await get(KEY_PREFIX + id)
    } catch (error) {
      throw new CheckpointError(`Checkpoint storage unavailable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (raw == null) return null
    return migrateCheckpoint(raw)
  }

  async remove(id: string): Promise<void> {
    try {
      await del(KEY_PREFIX + id)
    } catch {
      /* best effort */
    }
  }
}

/** Test double; also used when IndexedDB is unavailable. */
export class MemoryCheckpointStore implements CheckpointStore {
  readonly data = new Map<string, unknown>()
  saves = 0

  async save(id: string, checkpoint: DownloadCheckpoint): Promise<void> {
    this.saves += 1
    // Round-trip through JSON: a persisted checkpoint never shares references.
    this.data.set(id, JSON.parse(JSON.stringify(checkpoint)))
  }

  async load(id: string): Promise<DownloadCheckpoint | null> {
    const raw = this.data.get(id)
    if (raw == null) return null
    return migrateCheckpoint(raw)
  }

  async remove(id: string): Promise<void> {
    this.data.delete(id)
  }
}

export const checkpointStore: CheckpointStore =
  typeof indexedDB !== 'undefined' ? new IdbCheckpointStore() : new MemoryCheckpointStore()
