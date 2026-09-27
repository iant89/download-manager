import { memo, useMemo } from 'react'
import { motion } from 'framer-motion'
import {
  AlertTriangle,
  Download,
  ExternalLink,
  Gauge,
  HardDriveDownload,
  Pause,
  Play,
  RotateCw,
  X,
} from 'lucide-react'

import type { DownloadTask } from '../types'
import { isActive } from '../types'
import { useStore } from '../store/useStore'
import { cn } from '../lib/cn'
import { formatBytes, formatEta, formatRelative, formatSpeed } from '../lib/format'
import { FileIcon } from './FileIcon'
import { SegmentBar } from './SegmentBar'
import { StatusPill } from './StatusPill'

interface Props {
  task: DownloadTask
  selected: boolean
}

function DownloadCardBase({ task, selected }: Props) {
  const select = useStore((s) => s.select)
  const pause = useStore((s) => s.pause)
  const resume = useStore((s) => s.resume)
  const cancel = useStore((s) => s.cancel)
  const retry = useStore((s) => s.retry)
  const remove = useStore((s) => s.remove)

  const percent = useMemo(() => {
    if (!task.totalBytes || task.totalBytes <= 0) return null
    return Math.min(100, (task.receivedBytes / task.totalBytes) * 100)
  }, [task.receivedBytes, task.totalBytes])

  const eta = useMemo(() => {
    if (!task.totalBytes) return null
    return formatEta(task.totalBytes - task.receivedBytes, task.speed)
  }, [task.totalBytes, task.receivedBytes, task.speed])

  const live = isActive(task.status)
  const canResume = task.status === 'paused' || task.status === 'failed' || task.status === 'canceled' || task.status === 'queued'
  const corsHint =
    task.status === 'failed' && !task.proxyUsed && /fetch|network|blocked|cors/i.test(task.error ?? '')

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: 6, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.99 }}
      className={cn(
        'download-card group relative rounded-2xl border p-3.5 transition-colors duration-100 sm:p-4',
        'bg-[var(--surface)] backdrop-blur-xl',
        selected
          ? 'border-[color-mix(in_oklab,var(--brand)_55%,transparent)] shadow-[0_0_0_1px_color-mix(in_oklab,var(--brand)_25%,transparent),0_18px_40px_-24px_color-mix(in_oklab,var(--brand)_80%,transparent)]'
          : 'border-[var(--hairline)] hover:border-[color-mix(in_oklab,var(--fg)_18%,var(--hairline))]',
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => select(selected ? null : task.id)}
          className="shrink-0 rounded-xl transition-transform duration-100 hover:scale-[1.06] active:scale-95"
          aria-label={`Select ${task.filename}`}
          aria-pressed={selected}
        >
          <FileIcon filename={task.filename} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => select(selected ? null : task.id)}
                className="block max-w-full truncate text-left text-[0.9rem] font-semibold leading-tight tracking-[-0.01em] hover:underline decoration-[var(--faint)] underline-offset-2"
                title={task.filename}
                aria-pressed={selected}
              >
                {task.filename}
              </button>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--muted)]">
                <StatusPill status={task.status} />
                <span className="num">{formatBytes(task.totalBytes)}</span>
                {live && task.speed > 0 && (
                  <>
                    <span className="text-[var(--faint)]">·</span>
                    <span className="num font-medium text-[var(--brand)]">{formatSpeed(task.speed)}</span>
                  </>
                )}
                {eta && live && (
                  <>
                    <span className="text-[var(--faint)]">·</span>
                    <span className="num">{eta} left</span>
                  </>
                )}
                {!live && (
                  <>
                    <span className="text-[var(--faint)]">·</span>
                    <span>{formatRelative(task.completedAt ?? task.createdAt)}</span>
                  </>
                )}
              </div>
            </div>

            <div
              className={cn(
                'card-actions flex shrink-0 items-center gap-1 transition-opacity duration-100',
                selected
                  ? 'opacity-100'
                  : 'opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100',
              )}
            >
              {live ? (
                <button
                  type="button"
                  className="icon-btn"
                  title="Pause"
                  onClick={(e) => {
                    e.stopPropagation()
                    pause(task.id)
                  }}
                >
                  <Pause size={15} />
                </button>
              ) : canResume ? (
                <button
                  type="button"
                  className="icon-btn"
                  title="Resume"
                  onClick={(e) => {
                    e.stopPropagation()
                    task.status === 'failed' ? retry(task.id) : resume(task.id)
                  }}
                >
                  <Play size={15} />
                </button>
              ) : null}

              {task.status === 'failed' && (
                <button
                  type="button"
                  className="icon-btn"
                  title="Retry from the beginning"
                  onClick={(e) => {
                    e.stopPropagation()
                    retry(task.id)
                  }}
                >
                  <RotateCw size={14} />
                </button>
              )}

              {live && (
                <button
                  type="button"
                  className="icon-btn"
                  title="Cancel"
                  onClick={(e) => {
                    e.stopPropagation()
                    cancel(task.id)
                  }}
                >
                  <X size={15} />
                </button>
              )}

              {!live && (
                <button
                  type="button"
                  className="icon-btn hover:text-[var(--danger)]"
                  title="Remove from list"
                  onClick={(e) => {
                    e.stopPropagation()
                    remove(task.id)
                  }}
                >
                  <X size={15} />
                </button>
              )}
            </div>
          </div>

          <div className="mt-3 space-y-1.5">
            <SegmentBar segments={task.segments} total={task.totalBytes} status={task.status} />
            <div className="flex items-center justify-between gap-3 text-[11px] text-[var(--muted)]">
              <span className="num">
                {percent != null ? `${percent.toFixed(percent < 10 ? 1 : 0)}%` : formatBytes(task.receivedBytes)}
                {task.totalBytes ? (
                  <span className="text-[var(--faint)]"> · {formatBytes(task.receivedBytes)}</span>
                ) : null}
              </span>
              <span className="flex items-center gap-1.5">
                {task.speedLimit > 0 && (
                  <span className="chip" title="Per-download speed cap">
                    <Gauge size={10} />
                    {formatSpeed(task.speedLimit)}
                  </span>
                )}
                {task.proxyUsed && (
                  <span className="chip" title="Fetched through the CORS proxy">
                    proxy
                  </span>
                )}
                {task.saveMode && (
                  <span className="chip" title={`Save method: ${task.saveMode}`}>
                    <HardDriveDownload size={10} />
                    {task.saveMode === 'fsa' ? 'disk' : task.saveMode === 'stream' ? 'stream' : 'memory'}
                  </span>
                )}
                {task.segments.length > 1 && (
                  <span className="chip" title={`${task.segments.length} parallel connections`}>
                    {task.segments.length}×
                  </span>
                )}
              </span>
            </div>
          </div>

          {task.error && (
            <div className="mt-2.5 flex items-start gap-2 rounded-xl border border-[color-mix(in_oklab,var(--danger)_28%,transparent)] bg-[color-mix(in_oklab,var(--danger)_10%,transparent)] px-2.5 py-2 text-[11px] text-[var(--danger)]">
              <AlertTriangle size={13} className="mt-[1px] shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium">{task.error}</p>
                {corsHint && (
                  <p className="mt-1 text-[var(--muted)]">
                    Usually the server blocks cross-origin requests. Add a CORS proxy in Settings → Network, or
                    download a same-origin file.
                  </p>
                )}
              </div>
            </div>
          )}

          {task.status === 'completed' && (
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {task.resultUrl && (
                <a
                  className="btn h-7 px-2.5 text-[11px]"
                  href={task.resultUrl}
                  download={task.filename}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Download size={12} />
                  Save file
                </a>
              )}
              <a
                className="btn h-7 px-2.5 text-[11px]"
                href={task.url}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink size={12} />
                Source
              </a>
              <span className="text-[11px] text-[var(--faint)]">
                {task.saveMode === 'fsa'
                  ? 'Written to the file you picked'
                  : task.saveMode === 'stream'
                    ? 'Saved by the browser download shelf'
                    : 'Held in memory — save it before you close the tab'}
              </span>
            </div>
          )}
        </div>
      </div>
    </motion.li>
  )
}

// Subscribe per row: telemetry for one download should not re-render the list
// controls or every other card. Deleted rows can briefly remain during exit.
export const DownloadCard = memo(function DownloadCard({ id, selected }: { id: string; selected: boolean }) {
  const task = useStore((s) => s.tasks[id])
  return task ? <DownloadCardBase task={task} selected={selected} /> : null
})
