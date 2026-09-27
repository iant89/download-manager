import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useStore } from '../store/useStore'

const ICON = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle }
const TONE = { success: 'var(--ok)', error: 'var(--danger)', info: 'var(--brand)', warning: 'var(--warn)' }

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6"
      role="status"
      aria-live="polite"
    >
      <AnimatePresence>
        {toasts.map((t) => {
          const Icon = ICON[t.kind]
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.94 }}
              className="panel-solid pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-2xl px-4 py-3"
            >
              <Icon size={18} style={{ color: TONE[t.kind] }} className="mt-[1px] shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold">{t.title}</p>
                {t.message && <p className="mt-0.5 truncate text-xs text-[var(--muted)]" title={t.message}>{t.message}</p>}
                {t.action && (
                  <button className="btn mt-2 h-7 px-2.5 text-[11px]" onClick={() => { t.action?.run(); dismiss(t.id) }}>{t.action.label}</button>
                )}
              </div>
              <button className="icon-btn h-7 w-7" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X size={14} /></button>
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
