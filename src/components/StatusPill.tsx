import type { DownloadStatus } from '../types'
import { STATUS_META, TONE_BG, TONE_HEX, TONE_TEXT } from '../lib/status'
import { cn } from '../lib/cn'

export function StatusPill({
  status,
  className,
  pulse = true,
}: {
  status: DownloadStatus
  className?: string
  pulse?: boolean
}) {
  const meta = STATUS_META[status]
  const live =
    status === 'downloading' || status === 'probing' || status === 'verifying' || status === 'finalizing' || status === 'queued' || status === 'pausing'

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] text-[11px] font-semibold tracking-wide',
        TONE_BG[meta.tone],
        TONE_TEXT[meta.tone],
        className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {live && pulse && (
          <span
            className="animate-ping-slow absolute inline-flex h-full w-full rounded-full opacity-75"
            style={{ background: TONE_HEX[meta.tone] }}
          />
        )}
        <span
          className="relative inline-flex h-1.5 w-1.5 rounded-full"
          style={{ background: TONE_HEX[meta.tone] }}
        />
      </span>
      {meta.label}
    </span>
  )
}
