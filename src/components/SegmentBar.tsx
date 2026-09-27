import type { DownloadStatus, SegmentState } from '../types'
import { isActive } from '../types'
import { cn } from '../lib/cn'

interface SegmentBarProps {
  segments: SegmentState[]
  total: number | null
  status: DownloadStatus
  height?: number
}

/**
 * The signature visual: one cell per connection, each filling up on its own.
 * Watching eight cells race each other is the fastest way to *see* whether the
 * server is actually serving ranges.
 */
export function SegmentBar({ segments, total, status, height = 8 }: SegmentBarProps) {
  const active = isActive(status)
  const indeterminate = total == null || total <= 0 || segments.length === 0

  if (indeterminate) {
    return (
      <div
        className="relative w-full overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--fg)_9%,transparent)]"
        style={{ height }}
      >
        {active ? (
          <>
            <div
              className="animate-flow absolute inset-y-0 left-0 w-full rounded-full opacity-90"
              style={{
                background:
                  'linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--brand) 85%, transparent) 45%, color-mix(in oklab, var(--accent) 90%, transparent) 55%, transparent 100%)',
              }}
            />
            <div className="shimmer absolute inset-0 overflow-hidden rounded-full" />
          </>
        ) : (
          <div className="h-full w-1/3 rounded-full bg-[color-mix(in_oklab,var(--fg)_16%,transparent)]" />
        )}
      </div>
    )
  }

  const settled = status === 'completed'

  return (
    <div className="flex w-full items-stretch gap-[3px] overflow-hidden" style={{ height }}>
      {segments.map((segment, index) => {
        const size = segment.end === Number.POSITIVE_INFINITY
          ? Math.max(segment.received, total - segment.start)
          : segment.end - segment.start + 1
        const ratio = size > 0 ? Math.min(1, segment.received / size) : 0
        const weight = Math.max(0.04, size / total)
        const working = active && (segment.status === 'active' || segment.status === 'retrying')
        const done = segment.status === 'done' || settled

        return (
          <div
            key={segment.index}
            className={cn(
              'relative overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--fg)_8%,transparent)]',
              working && 'shimmer',
            )}
            style={{ flexGrow: weight, flexBasis: 0, minWidth: 3 }}
            title={`Connection ${index + 1}: ${(ratio * 100).toFixed(1)}%`}
          >
            <div
              className="progress-fill absolute inset-0 rounded-full"
              style={{
                transform: `scaleX(${Math.max(done ? 1 : 0.02, ratio)})`,
                background: settled
                  ? 'color-mix(in oklab, var(--ok) 80%, transparent)'
                  : segment.status === 'error'
                    ? 'color-mix(in oklab, var(--danger) 85%, transparent)'
                    : `color-mix(in oklab, var(--accent) ${Math.round((index / Math.max(1, segments.length - 1)) * 100)}%, var(--brand))`,
                boxShadow: working ? '0 0 12px -2px color-mix(in oklab, var(--brand) 70%, transparent)' : undefined,
              }}
            />
          </div>
        )
      })}
    </div>
  )
}
