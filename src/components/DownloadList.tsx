import { AnimatePresence, motion } from 'framer-motion'
import { Inbox, Search, X } from 'lucide-react'
import { useMemo } from 'react'

import { useStore } from '../store/useStore'
import type { FilterKey } from '../types'
import { isActive } from '../types'
import { cn } from '../lib/cn'
import { DownloadCard } from './DownloadCard'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
]

export function DownloadList() {
  const tasks = useStore((s) => s.tasks)
  const order = useStore((s) => s.order)
  const filter = useStore((s) => s.filter)
  const setFilter = useStore((s) => s.setFilter)
  const search = useStore((s) => s.search)
  const setSearch = useStore((s) => s.setSearch)
  const selectedId = useStore((s) => s.selectedId)
  const setUi = useStore((s) => s.setUi)

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return order.filter((id) => {
      const t = tasks[id]
      if (!t) return false
      if (filter === 'active' && !isActive(t.status)) return false
      if (filter === 'paused' && t.status !== 'paused' && t.status !== 'queued') return false
      if (filter === 'completed' && t.status !== 'completed') return false
      if (filter === 'failed' && t.status !== 'failed' && t.status !== 'canceled') return false
      if (q && !t.filename.toLowerCase().includes(q) && !t.url.toLowerCase().includes(q)) return false
      return true
    })
  }, [order, tasks, filter, search])

  const counts = useMemo(() => {
    const c: Record<FilterKey, number> = { all: 0, active: 0, downloading: 0, paused: 0, completed: 0, failed: 0 }
    for (const id of order) {
      const t = tasks[id]; if (!t) continue
      c.all += 1
      if (isActive(t.status)) c.active += 1
      else if (t.status === 'paused' || t.status === 'queued') c.paused += 1
      else if (t.status === 'completed') c.completed += 1
      else c.failed += 1
    }
    return c
  }, [order, tasks])

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex overflow-x-auto rounded-xl border bg-[color-mix(in_oklab,var(--fg)_4%,transparent)] p-[3px]">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={cn('relative shrink-0 rounded-[9px] px-3 py-1.5 text-xs font-medium transition-colors', filter === f.key ? 'text-[var(--fg)]' : 'text-[var(--muted)] hover:text-[var(--fg)]')}>
              {filter === f.key && <motion.span layoutId="filter-pill" className="absolute inset-0 rounded-[9px] bg-[var(--solid)] shadow-sm" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
              <span className="relative">{f.label}{counts[f.key] > 0 && <span className="num ml-1.5 text-[10px] text-[var(--faint)]">{counts[f.key]}</span>}</span>
            </button>
          ))}
        </div>
        <div className="relative ml-auto min-w-[160px] flex-1 sm:max-w-xs">
          <Search size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
          <input id="flux-search" className="field h-9 pl-8 pr-8" placeholder="Filter downloads… ( / )" value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && <button className="icon-btn absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2" onClick={() => setSearch('')}><X size={13} /></button>}
        </div>
      </div>

      <div className="glass-scroll min-h-0 flex-1 overflow-y-auto pb-24 pr-0.5 lg:pb-2">
        {visible.length === 0 ? (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="panel mt-2 grid place-items-center rounded-3xl px-6 py-16 text-center">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-[var(--brand-soft)] text-[var(--brand)]"><Inbox size={26} /></div>
            <h3 className="mt-4 text-base font-semibold">{order.length === 0 ? 'Nothing here yet' : 'No matches'}</h3>
            <p className="mt-1 max-w-sm text-sm text-[var(--muted)]">
              {order.length === 0 ? 'Add a link and Flux will split it across parallel connections and stream it to your disk.' : 'Try a different filter or search term.'}
            </p>
            {order.length === 0 && <button className="btn btn-primary mt-5" onClick={() => setUi({ addOpen: true })}>Add your first download</button>}
          </motion.div>
        ) : (
          <ul className="space-y-2.5">
            <AnimatePresence initial={false}>
              {visible.map((id) => <DownloadCard key={id} task={tasks[id]!} selected={selectedId === id} />)}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </section>
  )
}
