/** Shared domain types for the Flux download manager. */

/** See `lib/engine/stateMachine.ts` for the allowed transitions. */
export type DownloadStatus =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'pausing'
  | 'paused'
  | 'verifying'
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

/** Identifies one specific representation of a URL (plan P0-04). */
export interface ResourceIdentity {
  etag: string | null
  lastModified: string | null
  totalBytes: number | null
  contentType: string | null
}

/**
 * Engine diagnostics — telemetry, rebuilt every session and never used for
 * resuming (plan P1-06, P2-13, P3-10).
 */
export interface DownloadDiagnostics {
  /** Connection-level retries (a segment re-requested after a failure). */
  automaticRetryCount: number
  httpErrors: number
  rangeErrors: number
  integrityErrors: number
  /** A 206 arrived without a readable Content-Range (not CORS-exposed). */
  unverifiedRanges: boolean
  /** If-Range is being sent on resumed requests. */
  ifRange: boolean
  lastCheckpointAt: number | null
}

export const EMPTY_DIAGNOSTICS: DownloadDiagnostics = {
  automaticRetryCount: 0,
  httpErrors: 0,
  rangeErrors: 0,
  integrityErrors: 0,
  unverifiedRanges: false,
  ifRange: false,
  lastCheckpointAt: null,
}

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
  /** Times this download ended in `failed` (not connection-level retries). */
  terminalFailureCount: number
  /** Scheduler priority; higher runs first (plan P1-09). */
  priority: number
  /** FIFO key within a priority, persisted so the queue survives reloads. */
  queuedAt: number
  /** Expected SHA-256 (lowercase hex), verified while finalizing. */
  expectedChecksum: string | null
  /** Outcome of checksum verification once completed. */
  checksumVerified: boolean | null
  /** Representation the partial data came from, once known. */
  identity: ResourceIdentity | null
  diagnostics: DownloadDiagnostics
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
  priority?: number
  /** Expected SHA-256 hex digest. */
  checksum?: string
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
  /** Show the debug console pinned to the bottom of the viewport. */
  debugMode: boolean
  /** Hard cap for in-memory downloads, in MB (plan P2-03). */
  memoryLimitMB: number
  /** Open connections allowed to one host across all downloads (plan P1-10). */
  maxConnectionsPerHost: number
  /** Open connections allowed across all downloads. */
  maxTotalConnections: number
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
  debugMode: false,
  memoryLimitMB: 512,
  maxConnectionsPerHost: 16,
  maxTotalConnections: 48,
}

export const DEFAULT_AUTH: AuthConfig = { kind: 'none', username: '', password: '', token: '' }

export const ACTIVE_STATUSES: DownloadStatus[] = ['queued', 'probing', 'downloading', 'pausing', 'verifying', 'finalizing']

/** Statuses where the engine is actually doing work (occupies a scheduler slot). */
export const RUNNING_STATUSES: DownloadStatus[] = ['probing', 'downloading', 'pausing', 'verifying', 'finalizing']

export function isActive(status: DownloadStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

export function isFinished(status: DownloadStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled'
}
