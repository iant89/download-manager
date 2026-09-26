/** Shared domain types for the Flux download manager. */

export type DownloadStatus =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled'

export type AuthKind = 'none' | 'basic' | 'bearer' | 'headers'

export interface AuthConfig {
  kind: AuthKind
  username: string
  password: string
  token: string
}

export interface HeaderEntry {
  id: string
  name: string
  value: string
  enabled: boolean
}

export type SegmentStatus = 'idle' | 'active' | 'retrying' | 'done' | 'error'

export interface SegmentState {
  index: number
  /** Absolute first byte of the segment (inclusive). */
  start: number
  /** Absolute last byte of the segment (inclusive). */
  end: number
  /** Bytes of this segment already persisted. */
  received: number
  status: SegmentStatus
  attempts: number
  /** Instantaneous speed of this connection in bytes/s. */
  speed: number
}

/** Where the finished bytes go once they leave the network. */
export type SaveMode = 'fsa' | 'stream' | 'memory'

export interface DownloadTask {
  id: string
  url: string
  filename: string
  mime: string
  /** Total size in bytes, or null when the server does not report one. */
  totalBytes: number | null
  connections: number
  /** Per-task throttle in bytes/s. 0 = unlimited. */
  speedLimit: number
  maxRetries: number
  auth: AuthConfig
  headers: HeaderEntry[]
  status: DownloadStatus
  receivedBytes: number
  createdAt: number
  startedAt: number | null
  completedAt: number | null
  error: string | null
  supportsRanges: boolean
  segments: SegmentState[]
  /** Overall speed in bytes/s, refreshed by the store ticker. */
  speed: number
  /** Rolling samples of overall speed in bytes/s (newest last). */
  speedHistory: number[]
  saveMode: SaveMode | null
  retries: number
  /** Resolved (possibly proxy-rewritten) URL actually fetched. */
  effectiveUrl: string
  proxyUsed: boolean
  /** Persisted File System Access handle key, when in `fsa` mode. */
  handleKey: string | null
  /** True while we are waiting on the user to pick a save location. */
  awaitingTarget: boolean
  /** Blob URL for in-memory downloads, valid until the task is removed. */
  resultUrl: string | null
}

export interface NewDownloadInput {
  url: string
  filename?: string
  connections?: number
  speedLimit?: number
  maxRetries?: number
  auth?: AuthConfig
  headers?: HeaderEntry[]
  autoStart?: boolean
}

export type FilterKey = 'all' | 'active' | 'downloading' | 'paused' | 'completed' | 'failed'

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  defaultConnections: number
  maxConcurrentDownloads: number
  /** Global throttle in bytes/s. 0 = unlimited. */
  globalSpeedLimit: number
  maxRetries: number
  /** Ask where to save before every download. */
  alwaysAskLocation: boolean
  saveMode: 'auto' | 'fsa' | 'stream' | 'memory'
  /** Directory handle name remembered from `showDirectoryPicker`. */
  defaultFolderName: string | null
  proxyTemplate: string
  proxyMode: 'off' | 'auto' | 'always'
  notifyOnComplete: boolean
  autoOpenFile: boolean
  removeOnComplete: boolean
  startImmediately: boolean
  reducedMotion: boolean
  showSegmentView: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  defaultConnections: 8,
  maxConcurrentDownloads: 3,
  globalSpeedLimit: 0,
  maxRetries: 5,
  alwaysAskLocation: false,
  saveMode: 'auto',
  defaultFolderName: null,
  proxyTemplate: '',
  proxyMode: 'off',
  notifyOnComplete: true,
  autoOpenFile: false,
  removeOnComplete: false,
  startImmediately: true,
  reducedMotion: false,
  showSegmentView: true,
}

export const DEFAULT_AUTH: AuthConfig = { kind: 'none', username: '', password: '', token: '' }

export const ACTIVE_STATUSES: DownloadStatus[] = ['queued', 'probing', 'downloading', 'finalizing']

export function isActive(status: DownloadStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

export function isFinished(status: DownloadStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled'
}
