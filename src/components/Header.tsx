import { motion } from 'framer-motion'
import { Keyboard, Moon, Pause, Play, Plus, Settings, Sun, Trash2 } from 'lucide-react'
import { useMemo } from 'react'

import { useStore } from '../store/useStore'
import { isActive } from '../types'
import { formatBytes, formatSpeed } from '../lib/format'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { Sparkline } from './Sparkline'

export function Header() {
  const setUi = useStore((s) => s.setUi)
  const theme = useStore((s) => s.settings.theme)
  const update = useStore((s) => s.updateSettings)
  const globalSpeed = useStore((s) => s.globalSpeed)
  const history = useStore((s) => s.globalHistory)
  const tasks = useStore((s) => s.tasks)
  const order = useStore((s) => s.order)
  const pauseAll = useStore((s) => s.pauseAll)
  const resumeAll = useStore((s) => s.resumeAll)
  const clearCompleted = useStore((s) => s.clearCompleted)
  const showConfirm = useStore((s) => s.showConfirm)
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')

  const requestClearCompleted = (count: number) => {
    if (count === 0) return
    showConfirm({
      title: `Clear ${count} completed download${count === 1 ? '' : 's'}?`,
      message:
        count === 1
          ? 'This will remove the completed download from your list. The file itself will stay on disk.'
          : `This will remove all ${count} completed downloads from your list. Files on disk will not be deleted.`,
      confirmLabel: count === 1 ? 'Clear' : `Clear ${count}`,
      variant: 'danger',
      icon: 'clear',
      onConfirm: () => clearCompleted(),
    })
  }

  const requestPauseAll = (count: number) => {
    if (count === 0) return
    if (count <= 2) {
      pauseAll()
      return
    }
    showConfirm({
      title: `Pause ${count} active download${count === 1 ? '' : 's'}?`,
      message: `This will pause all ${count} active transfers. You can resume them individually or all at once later.`,
      confirmLabel: `Pause ${count}`,
      variant: 'default',
      icon: 'alert',
      onConfirm: () => pauseAll(),
    })
  }

  const summary = useMemo(() => {
    let active = 0, paused = 0, done = 0, remaining = 0, total = 0
    for (const id of order) {
      const t = tasks[id]
      if (!t) continue
      if (isActive(t.status)) {
        active += 1
        if (t.totalBytes) {
          remaining += Math.max(0, t.totalBytes - t.receivedBytes)
          total += t.totalBytes
        }
      }
      else if (t.status === 'paused' || t.status === 'failed') paused += 1
      else if (t.status === 'completed') done += 1
    }
    return { active, paused, done, remaining, total }
  }, [tasks, order])

  const isDark = theme === 'dark' || (theme === 'system' && systemDark)
  const overallProgress = summary.total > 0 ? Math.max(0, Math.min(1, 1 - summary.remaining / summary.total)) : null

  return (
    <header className="flex flex-wrap items-center gap-3 px-1 pb-4 sm:gap-4">
      <div className="flex items-center gap-3">
        <motion.div
          className="grid h-10 w-10 place-items-center rounded-2xl text-white shadow-lg"
          style={{ background: 'linear-gradient(135deg, var(--accent), var(--brand))' }}
          whileHover={{ rotate: -6, scale: 1.05 }}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" opacity=".6" /></svg>
        </motion.div>
        <div>
          <h1 className="text-lg font-bold leading-none tracking-[-0.02em]">Flux</h1>
          <p className="mt-1 text-[11px] text-[var(--muted)]">Browser download manager</p>
        </div>
      </div>

      <div className="panel hidden items-center gap-4 rounded-2xl px-4 py-2 md:flex">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--faint)]">Throughput</p>
          <p className="num text-base font-semibold leading-tight">{formatSpeed(globalSpeed)}</p>
        </div>
        <div className="w-32"><Sparkline data={history.length ? history : [0, 0]} height={30} width={128} /></div>
        <div className="h-8 w-px bg-[var(--hairline)]" />
        <div className="num flex gap-3 text-xs text-[var(--muted)]">
          <span><b className="text-[var(--fg)]">{summary.active}</b> active</span>
          <span><b className="text-[var(--fg)]">{summary.paused}</b> waiting</span>
          <span><b className="text-[var(--fg)]">{summary.done}</b> done</span>
          {summary.remaining > 0 && <span>{formatBytes(summary.remaining)} left</span>}
        </div>
        {overallProgress != null && (
          <div className="w-full">
            <div className="h-1 w-28 overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--fg)_10%,transparent)]">
              <div
                className="progress-fill h-full w-full rounded-full"
                style={{ background: 'linear-gradient(90deg, var(--brand), var(--accent))', transform: `scaleX(${overallProgress})` }}
              />
            </div>
          </div>
        )}
      </div>

      <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">
        <button className="icon-btn" title="Resume all" onClick={resumeAll} disabled={summary.paused === 0}><Play size={16} /></button>
        <button className="icon-btn" title="Pause all" onClick={() => requestPauseAll(summary.active)} disabled={summary.active === 0}><Pause size={16} /></button>
        <button className="icon-btn" title="Clear completed" onClick={() => requestClearCompleted(summary.done)} disabled={summary.done === 0}><Trash2 size={16} /></button>
        <div className="mx-1 h-6 w-px bg-[var(--hairline)]" />
        <button className="icon-btn" title="Toggle theme" onClick={() => update({ theme: isDark ? 'light' : 'dark' })}>{isDark ? <Sun size={16} /> : <Moon size={16} />}</button>
        <button className="icon-btn hidden sm:inline-flex" title="Keyboard shortcuts (?)" onClick={() => setUi({ shortcutsOpen: true })}><Keyboard size={16} /></button>
        <button className="icon-btn" title="Settings (,)" onClick={() => setUi({ settingsOpen: true })}><Settings size={16} /></button>
        <button className="btn btn-primary ml-1" onClick={() => setUi({ addOpen: true })}>
          <Plus size={15} /> <span className="hidden sm:inline">New download</span><span className="sm:hidden">Add</span>
          <kbd className="ml-1 hidden rounded-md bg-white/20 px-1.5 py-0.5 text-[10px] font-semibold sm:inline">N</kbd>
        </button>
      </div>
    </header>
  )
}
