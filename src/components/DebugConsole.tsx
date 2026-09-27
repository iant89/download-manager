import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ArrowDownToLine, ChevronUp, Copy, Search, SquareTerminal, Trash2, X } from 'lucide-react'

import { cn } from '../lib/cn'
import { useStore } from '../store/useStore'
import { formatValue, useDebugLog, type DebugEntry, type DebugLevel } from '../lib/debugLog'

const EXPANDED_KEY = 'flux.debug.expanded'
/** CSS variable other fixed UI reads to stay clear of the console. */
export const DEBUG_OFFSET_VAR = '--debug-offset'

type LevelFilter = 'all' | DebugLevel

const LEVEL_TONE: Record<DebugLevel, string> = {
  debug: 'var(--faint)',
  info: 'var(--accent)',
  warn: 'var(--warn)',
  error: 'var(--danger)',
}

const FILTERS: { value: LevelFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Errors' },
  { value: 'warn', label: 'Warnings' },
  { value: 'info', label: 'Info' },
  { value: 'debug', label: 'Debug' },
]

/** Mounts the console only while debug mode is on. */
export function DebugConsole() {
  const enabled = useStore((s) => Boolean(s.settings.debugMode))
  // Clear the layout offset once the console goes away.
  useEffect(() => {
    if (!enabled) document.documentElement.style.removeProperty(DEBUG_OFFSET_VAR)
  }, [enabled])
  return enabled ? <DebugConsolePanel /> : null
}

function readExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}

function DebugConsolePanel() {
  const entries = useDebugLog((s) => s.entries)
  const clear = useDebugLog((s) => s.clear)
  const update = useStore((s) => s.updateSettings)

  const [expanded, setExpanded] = useState(readExpanded)
  const [filter, setFilter] = useState<LevelFilter>('all')
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const [openRows, setOpenRows] = useState<Set<number>>(() => new Set())
  const [copied, setCopied] = useState(false)

  const rootRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0')
    } catch {
      /* private mode */
    }
  }, [expanded])

  // Publish the console's height so the app, dialogs, toasts and the mobile
  // add button sit above it instead of underneath.
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const root = document.documentElement
    const publish = () => root.style.setProperty(DEBUG_OFFSET_VAR, `${Math.round(el.getBoundingClientRect().height)}px`)
    publish()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      root.style.removeProperty(DEBUG_OFFSET_VAR)
    }
  }, [])

  const counts = useMemo(() => {
    const c = { debug: 0, info: 0, warn: 0, error: 0 }
    for (const e of entries) c[e.level] += 1
    return c
  }, [entries])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter((e) => {
      if (filter !== 'all' && e.level !== filter) return false
      if (!q) return true
      return e.message.toLowerCase().includes(q) || e.source.toLowerCase().includes(q) || (e.detail?.toLowerCase().includes(q) ?? false)
    })
  }, [entries, filter, query])

  // Stick to the newest entry while following.
  useLayoutEffect(() => {
    if (!expanded || !follow) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [visible, expanded, follow])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    if (atBottom !== follow) setFollow(atBottom)
  }

  const toggleRow = (id: number) =>
    setOpenRows((rows) => {
      const next = new Set(rows)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const copy = async () => {
    const text = visible.map(formatEntry).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <section
      ref={rootRef}
      aria-label="Debug console"
      className="debug-console fixed inset-x-0 bottom-0 z-[55] flex flex-col border-t font-mono text-[11.5px]"
    >
      {/* Slim title bar: the whole bar toggles the console. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls="debug-console-body"
        className="flex h-8 w-full shrink-0 items-center gap-2 px-3 text-left font-sans text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)] hover:text-[var(--fg)]"
      >
        <SquareTerminal size={13} className="text-[var(--brand)]" aria-hidden />
        <span>Debug console</span>
        <span className="font-mono font-normal normal-case tracking-normal text-[var(--faint)]">{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
        {counts.error > 0 && <Badge tone={LEVEL_TONE.error} label={`${counts.error} error${counts.error === 1 ? '' : 's'}`} />}
        {counts.warn > 0 && <Badge tone={LEVEL_TONE.warn} label={`${counts.warn} warning${counts.warn === 1 ? '' : 's'}`} />}
        {!expanded && entries.length > 0 && (
          <span className="hidden min-w-0 flex-1 truncate font-mono font-normal normal-case tracking-normal text-[var(--faint)] sm:block">
            {entries.at(-1)!.message}
          </span>
        )}
        <motion.span className="ml-auto shrink-0" animate={{ rotate: expanded ? 180 : 0 }} aria-hidden>
          <ChevronUp size={14} />
        </motion.span>
        <span className="sr-only">{expanded ? 'Collapse' : 'Expand'}</span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            id="debug-console-body"
            key="body"
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex h-[min(40dvh,420px)] min-h-[180px] flex-col border-t">
              <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 font-sans">
                <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by level">
                  {FILTERS.map((f) => {
                    const n = f.value === 'all' ? entries.length : counts[f.value]
                    return (
                      <button
                        key={f.value}
                        type="button"
                        aria-pressed={filter === f.value}
                        onClick={() => setFilter(f.value)}
                        className={cn('chip h-6 px-2 text-[11px]', filter === f.value && 'border-[var(--brand)] text-[var(--fg)]')}
                      >
                        {f.label}
                        <span className="text-[var(--faint)]">{n}</span>
                      </button>
                    )
                  })}
                </div>
                <label className="relative ml-auto min-w-[140px] flex-1 sm:max-w-[260px]">
                  <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--faint)]" aria-hidden />
                  <input
                    className="debug-filter h-6 w-full rounded-md border bg-transparent pl-6 pr-2 font-mono text-[11px] outline-none focus:border-[var(--brand)]"
                    placeholder="Filter…"
                    aria-label="Filter log"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    spellCheck={false}
                  />
                </label>
                <IconButton label={follow ? 'Following newest' : 'Jump to newest'} active={follow} onClick={() => setFollow(true)}>
                  <ArrowDownToLine size={13} />
                </IconButton>
                <IconButton label={copied ? 'Copied' : 'Copy visible entries'} onClick={() => void copy()}>
                  <Copy size={13} />
                </IconButton>
                <IconButton label="Clear log" onClick={() => { clear(); setOpenRows(new Set()) }}>
                  <Trash2 size={13} />
                </IconButton>
                <IconButton label="Turn off debug mode" onClick={() => update({ debugMode: false })}>
                  <X size={13} />
                </IconButton>
              </div>

              <div ref={scrollRef} onScroll={onScroll} className="glass-scroll min-h-0 flex-1 overflow-y-auto border-t" role="log" aria-live="off">
                {visible.length === 0 ? (
                  <p className="px-3 py-6 text-center font-sans text-xs text-[var(--faint)]">
                    {entries.length === 0 ? 'Nothing logged yet. Actions, engine events, console output and errors show up here.' : 'No entries match the filter.'}
                  </p>
                ) : (
                  <ul>
                    {visible.map((e) => (
                      <Row key={e.id} entry={e} open={openRows.has(e.id)} onToggle={() => toggleRow(e.id)} />
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}

function Row({ entry, open, onToggle }: { entry: DebugEntry; open: boolean; onToggle: () => void }) {
  const expandable = Boolean(entry.detail)
  const tone = LEVEL_TONE[entry.level]
  const content = (
    <>
      <span className="shrink-0 tabular-nums text-[var(--faint)]">{formatTime(entry.at)}</span>
      <span className="w-11 shrink-0 font-semibold uppercase" style={{ color: tone }}>{entry.level}</span>
      <span className="w-16 shrink-0 truncate text-[var(--muted)]">{entry.source}</span>
      <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words', entry.level === 'error' ? 'text-[var(--danger)]' : 'text-[var(--fg)]')}>
        {entry.message}
      </span>
      {expandable && <span className="shrink-0 text-[var(--faint)]" aria-hidden>{open ? '▾' : '▸'}</span>}
    </>
  )
  return (
    <li
      className="border-b border-[color-mix(in_oklab,var(--hairline)_70%,transparent)]"
      style={entry.level === 'error' || entry.level === 'warn' ? { background: `color-mix(in oklab, ${tone} 7%, transparent)` } : undefined}
    >
      {expandable ? (
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-2 px-3 py-1 text-left hover:bg-[color-mix(in_oklab,var(--fg)_4%,transparent)]">
          {content}
        </button>
      ) : (
        <div className="flex items-start gap-2 px-3 py-1">{content}</div>
      )}
      {expandable && open && (
        <pre className="mx-3 mb-1.5 max-h-60 overflow-auto rounded-md bg-[color-mix(in_oklab,var(--fg)_5%,transparent)] p-2 text-[11px] text-[var(--muted)]">{entry.detail}</pre>
      )}
    </li>
  )
}

function Badge({ tone, label }: { tone: string; label: string }) {
  return (
    <span
      className="rounded-full px-1.5 py-px font-mono text-[10px] font-semibold normal-case tracking-normal"
      style={{ color: tone, background: `color-mix(in oklab, ${tone} 16%, transparent)` }}
    >
      {label}
    </span>
  )
}

function IconButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'grid h-6 w-6 place-items-center rounded-md text-[var(--muted)] hover:bg-[color-mix(in_oklab,var(--fg)_7%,transparent)] hover:text-[var(--fg)]',
        active && 'text-[var(--brand)]',
      )}
    >
      {children}
    </button>
  )
}

function formatTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

function formatEntry(e: DebugEntry): string {
  const line = `${new Date(e.at).toISOString()} [${e.level.toUpperCase()}] ${e.source}: ${e.message}`
  return e.detail ? `${line}\n${formatValue(e.detail)}` : line
}
