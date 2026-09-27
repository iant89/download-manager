import { motion, AnimatePresence } from 'framer-motion'
import { X } from 'lucide-react'
import { useEffect, useId, type ReactNode } from 'react'
import { cn } from '../lib/cn'

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'max-w-xl',
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  children: ReactNode
  footer?: ReactNode
  width?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-end sm:place-items-center p-0 sm:p-6"
          style={{ bottom: 'var(--debug-offset, 0px)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal
            aria-label={title}
            initial={{ opacity: 0, y: 12, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            className={cn(
              'panel-solid relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl sm:rounded-3xl',
              width,
            )}
          >
            <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
              <div>
                <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
                {subtitle && <p className="mt-0.5 text-xs text-[var(--muted)]">{subtitle}</p>}
              </div>
              <button className="icon-btn" onClick={onClose} aria-label="Close">
                <X size={16} />
              </button>
            </header>
            <div className="glass-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && <footer className="flex items-center justify-end gap-2 border-t px-5 py-3.5">{footer}</footer>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[var(--faint)]">{hint}</span>}
    </label>
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="toggle-control flex w-full items-center justify-between gap-4 rounded-xl px-1 py-2 text-left"
    >
      <span>
        <span className="block text-[13px] font-medium">{label}</span>
        {hint && <span className="block text-[11px] text-[var(--faint)]">{hint}</span>}
      </span>
      <span
        className={cn(
          'relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors duration-100',
          checked ? 'bg-[var(--brand)]' : 'bg-[color-mix(in_oklab,var(--fg)_16%,transparent)]',
        )}
      >
        <span
          className="toggle-thumb absolute left-[3px] top-[3px] h-4 w-4 rounded-full bg-white shadow"
          style={{ transform: `translateX(${checked ? 15 : 0}px)` }}
        />
      </span>
    </button>
  )
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  const groupId = useId()
  return (
    <div className="inline-flex rounded-xl border bg-[color-mix(in_oklab,var(--fg)_4%,transparent)] p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'control-tab relative rounded-[9px] px-3 py-1.5 text-xs font-medium transition-colors',
            value === o.value ? 'text-[var(--fg)]' : 'text-[var(--muted)] hover:text-[var(--fg)]',
          )}
        >
          {value === o.value && (
            <motion.span
              layoutId={`seg-${groupId}`}
              className="absolute inset-0 rounded-[9px] bg-[var(--solid)] shadow-sm"
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export const SPEED_PRESETS: { label: string; value: number }[] = [
  { label: 'Unlimited', value: 0 },
  { label: '256 KB/s', value: 256 * 1024 },
  { label: '1 MB/s', value: 1024 ** 2 },
  { label: '5 MB/s', value: 5 * 1024 ** 2 },
  { label: '20 MB/s', value: 20 * 1024 ** 2 },
]
