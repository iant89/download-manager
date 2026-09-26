/**
 * File System Access API types + helpers.
 *
 * These APIs are still not part of the standard DOM typings, so the minimal
 * surface Flux needs is declared locally instead of pulling in a WICG package.
 */

export interface FsaWritable {
  write(data: BufferSource | { type: 'seek'; position: number } | { type: 'truncate'; size: number }): Promise<void>
  close(): Promise<void>
  abort(reason?: unknown): Promise<void>
}

export interface FsaFileHandle {
  name: string
  getFile(): Promise<File>
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsaWritable>
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  isSameEntry?(other: FsaFileHandle): Promise<boolean>
}

export interface FsaDirectoryHandle {
  name: string
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsaFileHandle>
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
}

export interface SaveFilePickerOptions {
  suggestedName?: string
  types?: { description: string; accept: Record<string, string[]> }[]
  excludeAcceptAllOption?: boolean
  id?: string
  startIn?: FsaDirectoryHandle | string
}

type PickerWindow = Window & {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FsaFileHandle>
  showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: unknown }) => Promise<FsaDirectoryHandle>
}

export function isFsaSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showSaveFilePicker === 'function'
}

export function isDirectoryPickerSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function'
}

export class PickerCancelledError extends Error {
  constructor() {
    super('Save location dialog was dismissed')
    this.name = 'PickerCancelledError'
  }
}

export async function pickSaveFile(
  suggestedName: string,
  startIn?: FsaDirectoryHandle,
  types?: SaveFilePickerOptions['types'],
): Promise<FsaFileHandle> {
  const picker = (window as PickerWindow).showSaveFilePicker
  if (!picker) throw new Error('File System Access API is not available in this browser')
  try {
    return await picker.call(window, {
      suggestedName,
      ...(startIn ? { startIn } : {}),
      ...(types ? { types } : {}),
    })
  } catch (error) {
    if (isAbortError(error)) throw new PickerCancelledError()
    throw error
  }
}

export async function pickDirectory(id?: string): Promise<FsaDirectoryHandle> {
  const picker = (window as PickerWindow).showDirectoryPicker
  if (!picker) throw new Error('Directory picker is not available in this browser')
  try {
    return await picker.call(window, { id, mode: 'readwrite' })
  } catch (error) {
    if (isAbortError(error)) throw new PickerCancelledError()
    throw error
  }
}

export async function ensureWritePermission(handle: FsaFileHandle | FsaDirectoryHandle): Promise<boolean> {
  const descriptor = { mode: 'readwrite' as const }
  try {
    if (!handle.queryPermission) return true
    const state = await handle.queryPermission(descriptor)
    if (state === 'granted') return true
    if (handle.requestPermission) {
      return (await handle.requestPermission(descriptor)) === 'granted'
    }
    return false
  } catch {
    return false
  }
}

export async function getFileIn(
  directory: FsaDirectoryHandle,
  name: string,
  create = true,
): Promise<FsaFileHandle> {
  return directory.getFileHandle(name, { create })
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'AbortError' || error.code === DOMException.ABORT_ERR)
  )
}
