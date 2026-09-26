/** Human readable formatters. */

const KIB = 1024

export function formatBytes(bytes: number | null | undefined, digits?: number): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—'
  if (bytes < 0) return '—'
  if (bytes < KIB) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / KIB
  let unit = 0
  while (value >= KIB && unit < units.length - 1) {
    value /= KIB
    unit += 1
  }
  const d = digits ?? (value < 10 ? 2 : value < 100 ? 1 : 0)
  return `${value.toFixed(d)} ${units[unit]}`
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 B/s'
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

export function formatEta(remainingBytes: number, bytesPerSecond: number): string | null {
  if (!bytesPerSecond || bytesPerSecond <= 0) return null
  if (remainingBytes <= 0) return '0s'
  return formatDuration((remainingBytes / bytesPerSecond) * 1000)
}

export function formatBitrate(bytesPerSecond: number): string {
  const bits = bytesPerSecond * 8
  if (bits < 1_000_000) return `${(bits / 1000).toFixed(0)} kbps`
  return `${(bits / 1_000_000).toFixed(1)} Mbps`
}

export function formatClock(timestamp: number): string {
  const d = new Date(timestamp)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return time
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${time}`
}

export function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 45_000) return 'just now'
  const mins = Math.round(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatClock(timestamp)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
