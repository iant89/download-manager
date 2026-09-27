/**
 * In-memory debug log that backs the optional debug console.
 *
 * Entries come from three places:
 *  - explicit `debug.*()` calls in the app (store actions, engine events),
 *  - the global `console` (log/info/warn/error/debug are mirrored, then
 *    forwarded to the real console untouched),
 *  - uncaught errors and unhandled promise rejections.
 *
 * It's a capped ring buffer so it can stay on in the background cheaply.
 * Subscribers are notified asynchronously so logging from inside a React
 * render (e.g. a React warning) never triggers a nested state update.
 */

import { create } from 'zustand'

export type DebugLevel = 'debug' | 'info' | 'warn' | 'error'

export interface DebugEntry {
  id: number
  at: number
  level: DebugLevel
  source: string
  message: string
  /** Pretty-printed extra detail, shown when the row is expanded. */
  detail?: string
}

export const MAX_DEBUG_ENTRIES = 1000

interface DebugStore {
  entries: DebugEntry[]
  clear(): void
}

export const useDebugLog = create<DebugStore>()((set) => ({
  entries: [],
  clear: () => {
    pending = []
    set({ entries: [] })
  },
}))

let nextId = 1
let pending: DebugEntry[] = []
let flushScheduled = false

function flush(): void {
  flushScheduled = false
  if (!pending.length) return
  const batch = pending
  pending = []
  useDebugLog.setState((s) => {
    const merged = s.entries.concat(batch)
    return { entries: merged.length > MAX_DEBUG_ENTRIES ? merged.slice(-MAX_DEBUG_ENTRIES) : merged }
  })
}

function scheduleFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  setTimeout(flush, 0)
}

export function addDebugEntry(level: DebugLevel, source: string, message: string, detail?: unknown): void {
  const entry: DebugEntry = { id: nextId++, at: Date.now(), level, source, message }
  if (detail !== undefined) entry.detail = formatValue(detail, true)
  pending.push(entry)
  if (pending.length > MAX_DEBUG_ENTRIES) pending = pending.slice(-MAX_DEBUG_ENTRIES)
  scheduleFlush()
}

/** Convenience logger: `debug.info('store', 'Added download', { id })`. */
export const debug = {
  debug: (source: string, message: string, detail?: unknown) => addDebugEntry('debug', source, message, detail),
  info: (source: string, message: string, detail?: unknown) => addDebugEntry('info', source, message, detail),
  warn: (source: string, message: string, detail?: unknown) => addDebugEntry('warn', source, message, detail),
  error: (source: string, message: string, detail?: unknown) => addDebugEntry('error', source, message, detail),
}

/** Synchronously apply queued entries (handy for tests). */
export function flushDebugLog(): void {
  flush()
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

export function formatValue(value: unknown, pretty = false): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') return value.toString()
  try {
    const seen = new WeakSet<object>()
    return JSON.stringify(
      value,
      (_key, v: unknown) => {
        if (typeof v === 'bigint') return `${v}n`
        if (v instanceof Error) return { name: v.name, message: v.message }
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]'
          seen.add(v)
          if (typeof Node !== 'undefined' && v instanceof Node) return `[${v.nodeName}]`
        }
        return v
      },
      pretty ? 2 : undefined,
    ) ?? String(value)
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// global capture
// ---------------------------------------------------------------------------

let installed = false
let capturing = false

const CONSOLE_LEVELS: Record<'log' | 'info' | 'warn' | 'error' | 'debug', DebugLevel> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
}

/** Mirror the console and global errors into the debug log. Idempotent. */
export function installDebugCapture(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  for (const method of Object.keys(CONSOLE_LEVELS) as (keyof typeof CONSOLE_LEVELS)[]) {
    const original = console[method]
    if (typeof original !== 'function') continue
    console[method] = function patched(this: Console, ...args: unknown[]) {
      if (!capturing) {
        capturing = true
        try {
          const [first, ...others] = args
          const message = args.length ? args.map((a) => formatValue(a)).join(' ') : ''
          const detail = others.some((a) => typeof a === 'object' && a !== null) || (typeof first === 'object' && first !== null)
            ? args.map((a) => formatValue(a, true)).join('\n')
            : undefined
          addDebugEntry(CONSOLE_LEVELS[method], 'console', truncate(message, 500), detail)
        } catch {
          /* never let logging break the caller */
        } finally {
          capturing = false
        }
      }
      return original.apply(this, args)
    } as Console[typeof method]
  }

  window.addEventListener('error', (e) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''
    addDebugEntry('error', 'window', `${e.message || 'Uncaught error'}${where}`, e.error ?? undefined)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason: unknown = e.reason
    const message = reason instanceof Error ? reason.message : formatValue(reason)
    addDebugEntry('error', 'promise', `Unhandled rejection: ${truncate(message, 300)}`, reason instanceof Error ? reason : undefined)
  })
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
