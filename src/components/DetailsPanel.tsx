import { AnimatePresence, motion } from 'framer-motion'
import { Copy, Gauge, Pause, Play, RotateCw, Trash2, X } from 'lucide-react'
import { useMemo } from 'react'

import { useStore } from '../store/useStore'
import { isActive } from '../types'
import { formatBytes, formatClock, formatDuration, formatEta, formatSpeed } from '../lib/format'
import { FileIcon } from './FileIcon'
import { SegmentBar } from './SegmentBar'
import { Sparkline } from './Sparkline'
import { StatusPill } from './StatusPill'
import { SPEED_PRESETS } from './ui'
import { getManager } from '../store/useStore'

export function DetailsPanel({ asSheet = false }: { asSheet?: boolean }) {
  const task = useStore((s) => (s.selectedId ? s.tasks[s.selectedId] : undefined))
  const select = useStore((s) => s.select)
  const pause = useStore((s) => s.pause)
  const resume = useStore((s) => s.resume)
  const retry = useStore((s) => s.retry)
  const remove = useStore((s) => s.remove)
  const updateTask = useStore((s) => s.updateTask)
  const pushToast = useStore((s) => s.pushToast)
  const showSegments = useStore((s) => s.settings.showSegmentView)

  const stats = useMemo(() => {
    if (!task) return null
    const elapsed = task.startedAt ? (task.completedAt ?? Date.now()) - task.startedAt : null
    const avg = elapsed && elapsed > 0 ? task.receivedBytes / (elapsed / 1000) : 0
    const eta = task.totalBytes ? formatEta(task.totalBytes - task.receivedBytes, task.speed) : null
    const peak = Math.max(0, ...task.speedHistory)
    return { elapsed, avg, eta, peak }
  }, [task])

  const content = task && stats && (
    <div className="flex h-full flex-col">
      <header className="flex items-start gap-3 border-b p-4">
        <FileIcon filename={task.filename} className="h-11 w-11" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]" title={task.filename}>{task.filename}</h2>
          <div className="mt-1 flex items-center gap-2"><StatusPill status={task.status} /><span className="text-xs text-[var(--muted)]">{task.mime}</span></div>
        </div>
        <button className="icon-btn" onClick={() => select(null)} aria-label="Close details"><X size={16} /></button>
      </header>

      <div className="glass-scroll min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        <div>
          <div className="mb-2 flex items-end justify-between">
            <span className="num text-3xl font-semibold tracking-tight">{formatSpeed(task.speed)}</span>
            <span className="num text-xs text-[var(--muted)]">peak {formatSpeed(stats.peak)}</span>
          </div>
          <div className="rounded-2xl border bg-[color-mix(in_oklab,var(--fg)_3%,transparent)] p-2">
            <Sparkline data={task.speedHistory.length ? task.speedHistory : [0, 0]} height={72} width={300} />
          </div>
        </div>

        <SegmentBar segments={task.segments} total={task.totalBytes} status={task.status} height={10} />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <Stat label="Progress" value={task.totalBytes ? `${((task.receivedBytes / task.totalBytes) * 100).toFixed(1)}%` : '—'} />
          <Stat label="Downloaded" value={`${formatBytes(task.receivedBytes)}${task.totalBytes ? ` / ${formatBytes(task.totalBytes)}` : ''}`} />
          <Stat label="Time left" value={isActive(task.status) ? (stats.eta ?? '—') : '—'} />
          <Stat label="Elapsed" value={formatDuration(stats.elapsed)} />
          <Stat label="Average" value={formatSpeed(stats.avg)} />
          <Stat label="Connections" value={`${task.segments.filter((s) => s.status === 'active').length || 0} active · ${task.connections} max`} />
          <Stat label="Ranges" value={task.supportsRanges ? 'Supported' : task.segments.length > 1 ? 'Probing' : 'Not supported'} />
          <Stat label="Added" value={formatClock(task.createdAt)} />
          <Stat label="Auth" value={task.auth.kind === 'none' ? 'None' : task.auth.kind} />
          <Stat label="Save" value={task.saveMode ?? 'pending'} />
        </dl>

        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Source</p>
          <div className="flex items-center gap-2 rounded-xl border bg-[color-mix(in_oklab,var(--fg)_3%,transparent)] px-3 py-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--muted)]" title={task.url}>{task.url}</code>
            <button className="icon-btn h-7 w-7" title="Copy URL" onClick={() => { void navigator.clipboard.writeText(task.url); pushToast({ kind: 'info', title: 'URL copied' }) }}><Copy size={13} /></button>
          </div>
        </div>

        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]"><Gauge size={11} /> Speed limit</p>
          <div className="flex flex-wrap gap-1.5">
            {SPEED_PRESETS.map((p) => (
              <button key={p.value} type="button" onClick={() => { updateTask(task.id, { speedLimit: p.value }); getManager().setSpeedLimit(task.id, p.value) }} className={`chip ${task.speedLimit === p.value ? 'border-[var(--brand)] text-[var(--fg)]' : ''}`}>{p.label}</button>
            ))}
          </div>
        </div>

        {showSegments && task.segments.length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Connections</p>
            <div className="overflow-hidden rounded-xl border">
              <table className="w-full text-[11px]">
                <thead className="bg-[color-mix(in_oklab,var(--fg)_4%,transparent)] text-left text-[var(--faint)]">
                  <tr><th className="px-2.5 py-1.5 font-medium">#</th><th className="px-2.5 py-1.5 font-medium">Range</th><th className="px-2.5 py-1.5 font-medium text-right">Done</th><th className="px-2.5 py-1.5 font-medium text-right">State</th></tr>
                </thead>
                <tbody>
                  {task.segments.map((s) => {
                    const size = s.end === Number.POSITIVE_INFINITY ? null : s.end - s.start + 1
                    return (
                      <tr key={s.index} className="border-t">
                        <td className="num px-2.5 py-1.5 text-[var(--muted)]">{s.index + 1}</td>
                        <td className="num px-2.5 py-1.5 font-mono text-[var(--muted)]">{formatBytes(s.start, 0)} – {size ? formatBytes(s.end, 0) : '∞'}</td>
                        <td className="num px-2.5 py-1.5 text-right">{size ? `${((s.received / size) * 100).toFixed(0)}%` : formatBytes(s.received)}</td>
                        <td className="px-2.5 py-1.5 text-right capitalize">{s.status}{s.attempts > 0 ? ` (${s.attempts})` : ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t p-3">
        {isActive(task.status) ? (
          <button className="btn flex-1" onClick={() => pause(task.id)}><Pause size={14} /> Pause</button>
        ) : task.status === 'failed' ? (
          <button className="btn btn-primary flex-1" onClick={() => retry(task.id)}><RotateCw size={14} /> Retry</button>
        ) : task.status !== 'completed' ? (
          <button className="btn btn-primary flex-1" onClick={() => resume(task.id)}><Play size={14} /> Resume</button>
        ) : null}
        <button className="btn btn-danger" onClick={() => remove(task.id)}><Trash2 size={14} /> Remove</button>
      </footer>
    </div>
  )

  if (asSheet) {
    return (
      <AnimatePresence>
        {task && (
          <motion.div key="details-sheet" className="fixed inset-0 z-40" style={{ bottom: 'var(--debug-offset, 0px)' }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => select(null)} />
            <motion.aside
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              className="panel-solid absolute inset-x-0 bottom-0 h-[86dvh] max-h-full overflow-hidden rounded-t-3xl"
            >
              {content}
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    )
  }

  // Keep the shell mounted when selection changes. Waiting for an outgoing
  // panel to animate out made rapid clicks feel ignored.
  return (
    <aside className="panel h-full overflow-hidden rounded-3xl" aria-label="Download details">
      {task ? content : (
        <div className="grid h-full place-items-center p-6 text-center">
          <div>
            <p className="text-sm font-medium">No download selected</p>
            <p className="mt-1 text-xs text-[var(--muted)]">Click any item to inspect its connections and speed.</p>
          </div>
        </div>
      )}
    </aside>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)]">{label}</dt>
      <dd className="num mt-0.5 truncate font-medium capitalize">{value}</dd>
    </div>
  )
}
