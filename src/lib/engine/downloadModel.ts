/**
 * Download domain model split (plan P1-05).
 *
 * Instead of one large DownloadTask, the domain is modeled as six focused
 * pieces. The Zustand store still keeps a flattened DownloadTask for React
 * rendering (to avoid a wide refactor), but the engine and new code interact
 * through the structured `Download` aggregate. Conversion helpers keep both
 * views in sync.
 */

import type {
  Download,
  DownloadCheckpointState,
  DownloadPolicy,
  DownloadSource,
  DownloadTarget,
  DownloadTask,
  DownloadTelemetry,
} from '../../types'

// Re-export the split model types for engine consumers.
export type {
  Download,
  DownloadSource,
  DownloadTarget,
  DownloadPolicy,
  DownloadCheckpointState,
  DownloadTelemetry,
}

/**
 * Splits a flat DownloadTask into the structured aggregate.
 */
export function toDownloadModel(task: DownloadTask): Download {
  return {
    id: task.id,
    source: {
      url: task.url,
      effectiveUrl: task.effectiveUrl,
      headers: task.headers,
      auth: task.auth,
      proxyUsed: task.proxyUsed,
    },
    target: {
      filename: task.filename,
      mime: task.mime,
      saveMode: task.saveMode,
      handleKey: task.handleKey,
      resultUrl: task.resultUrl,
      awaitingTarget: task.awaitingTarget,
    },
    policy: {
      connections: task.connections,
      maxRetries: task.maxRetries,
      speedLimit: task.speedLimit,
      priority: task.priority,
      queuedAt: task.queuedAt,
    },
    status: task.status,
    checkpoint: {
      totalBytes: task.totalBytes,
      supportsRanges: task.supportsRanges,
      segments: task.segments,
      identity: task.identity,
      expectedChecksum: task.expectedChecksum,
      checksumVerified: task.checksumVerified,
    },
    telemetry: {
      receivedBytes: task.receivedBytes,
      speed: task.speed,
      speedHistory: task.speedHistory,
      diagnostics: task.diagnostics,
      error: task.error,
      terminalFailureCount: task.terminalFailureCount,
    },
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
  }
}

/**
 * Flattens a structured Download back to a DownloadTask for storage/UI.
 */
export function fromDownloadModel(download: Download): DownloadTask {
  return {
    id: download.id,
    url: download.source.url,
    effectiveUrl: download.source.effectiveUrl,
    headers: download.source.headers,
    auth: download.source.auth,
    proxyUsed: download.source.proxyUsed,
    filename: download.target.filename,
    mime: download.target.mime,
    saveMode: download.target.saveMode,
    handleKey: download.target.handleKey,
    resultUrl: download.target.resultUrl,
    awaitingTarget: download.target.awaitingTarget,
    connections: download.policy.connections,
    maxRetries: download.policy.maxRetries,
    speedLimit: download.policy.speedLimit,
    priority: download.policy.priority,
    queuedAt: download.policy.queuedAt,
    status: download.status,
    totalBytes: download.checkpoint.totalBytes,
    supportsRanges: download.checkpoint.supportsRanges,
    segments: download.checkpoint.segments,
    identity: download.checkpoint.identity,
    expectedChecksum: download.checkpoint.expectedChecksum,
    checksumVerified: download.checkpoint.checksumVerified,
    receivedBytes: download.telemetry.receivedBytes,
    speed: download.telemetry.speed,
    speedHistory: download.telemetry.speedHistory,
    diagnostics: download.telemetry.diagnostics,
    error: download.telemetry.error,
    terminalFailureCount: download.telemetry.terminalFailureCount,
    createdAt: download.createdAt,
    startedAt: download.startedAt,
    completedAt: download.completedAt,
  }
}
