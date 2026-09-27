/**
 * ETA calculation with exponential moving average (plan P3-04).
 *
 * Instantaneous speed is noisy (especially with parallel connections and
 * throttling), so ETA is driven by a smoothed throughput. The store's ticker
 * already keeps a smoothed speed; this module makes the smoothing explicit
 * and testable.
 */

export const DEFAULT_ETA_ALPHA = 0.15

/**
 * Exponential moving average step:
 *   smoothed = alpha * current + (1 - alpha) * previous
 */
export function smoothSpeed(previous: number, current: number, alpha = DEFAULT_ETA_ALPHA): number {
  if (!Number.isFinite(previous) || previous < 0) return current
  if (!Number.isFinite(current) || current < 0) return previous
  if (previous === 0) return current
  return alpha * current + (1 - alpha) * previous
}

/**
 * ETA in milliseconds, or null when speed is unknown.
 */
export function calculateEta(remainingBytes: number, smoothedBytesPerSecond: number): number | null {
  if (!Number.isFinite(remainingBytes) || remainingBytes <= 0) return 0
  if (!Number.isFinite(smoothedBytesPerSecond) || smoothedBytesPerSecond <= 0) return null
  return (remainingBytes / smoothedBytesPerSecond) * 1000
}

/**
 * Formats ETA for display; delegates to formatDuration.
 */
export function formatEtaFromSpeed(remainingBytes: number, smoothedBytesPerSecond: number): string | null {
  const ms = calculateEta(remainingBytes, smoothedBytesPerSecond)
  if (ms == null) return null
  if (ms <= 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (hours < 24) return `${hours}h ${mins}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}
