/**
 * Persists File System Access handles in IndexedDB so a download can be resumed
 * after a page reload without asking the user to pick the file again.
 */

import { del, get, set } from 'idb-keyval'
import type { FsaDirectoryHandle, FsaFileHandle } from './sinks/fsa'

const FILE_PREFIX = 'flux:file:'
const DIR_KEY = 'flux:dir'
const DIR_NAME_KEY = 'flux:dir-name'

const available = (): boolean => typeof indexedDB !== 'undefined'

export const handleStore = {
  async getFile(id: string): Promise<FsaFileHandle | null> {
    if (!available()) return null
    try {
      return (await get<FsaFileHandle>(FILE_PREFIX + id)) ?? null
    } catch {
      return null
    }
  },
  async setFile(id: string, handle: FsaFileHandle): Promise<void> {
    if (!available()) return
    try {
      await set(FILE_PREFIX + id, handle)
    } catch {
      /* ignore */
    }
  },
  async deleteFile(id: string): Promise<void> {
    if (!available()) return
    try {
      await del(FILE_PREFIX + id)
    } catch {
      /* ignore */
    }
  },
  async getDirectory(): Promise<FsaDirectoryHandle | null> {
    if (!available()) return null
    try {
      return (await get<FsaDirectoryHandle>(DIR_KEY)) ?? null
    } catch {
      return null
    }
  },
  async setDirectory(handle: FsaDirectoryHandle | null): Promise<void> {
    if (!available() || !handle) return
    try {
      await set(DIR_KEY, handle)
      await set(DIR_NAME_KEY, handle.name)
    } catch {
      /* ignore */
    }
  },
  async getDirectoryName(): Promise<string | null> {
    if (!available()) return null
    try {
      return (await get<string>(DIR_NAME_KEY)) ?? null
    } catch {
      return null
    }
  },
}
