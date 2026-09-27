import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, FolderX, RotateCcw, Trash2, XCircle } from 'lucide-react'
import { cn } from '../lib/cn'
import { useStore } from '../store/useStore'

export type ConfirmVariant = 'danger' | 'warning' | 'default'
export type ConfirmIcon = 'trash' | 'alert' | 'cancel' | 'reset' | 'folder' | 'clear'

export interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message?: string
  details?: string | React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  variant?: ConfirmVariant
  icon?: ConfirmIcon
  /** When true, the confirm button gets autofocus (use for non-destructive). For destructive, cancel gets focus. */
  autoFocusConfirm?: boolean
}

function IconFor({ icon, variant }: { icon: ConfirmIcon; variant: ConfirmVariant }) {
  const base = 'grid h-11 w-11 place-items-center rounded-2xl'
  const variantClass =
    variant === 'danger'
      ? 'bg-[color-mix(in_oklab,var(--danger)_14%,transparent)] text-[var(--danger)]'
      : variant === 'warning'
        ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
        : 'bg-[var(--brand-soft)] text-[var(--brand)]'

  const content = (() => {
    switch (icon) {
      case 'trash':
        return <Trash2 size={20} />
      case 'cancel':
        return <XCircle size={20} />
      case 'reset':
        return <RotateCcw size={18} />
      case 'folder':
        return <FolderX size={20} />
      case 'clear':
        return <Trash2 size={20} />
      case 'alert':
      default:
        return <AlertTriangle size={20} />
    }
  })()

  return <div className={cn(base, variantClass)}>{content}</div>
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  details,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  icon = 'alert',
  autoFocusConfirm = false,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => {
      if (autoFocusConfirm) confirmRef.current?.focus()
      else cancelRef.current?.focus()
    }, 60)
    return () => clearTimeout(t)
  }, [open, autoFocusConfirm])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[70] grid place-items-end sm:place-items-center p-0 sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal
            aria-label={title}
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: 'spring', damping: 24, stiffness: 320 }}
            className="panel-solid relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl sm:rounded-3xl max-w-[440px]"
          >
            <div className="p-5 sm:p-6">
              <div className="flex items-start gap-4">
                <IconFor icon={icon} variant={variant} />
                <div className="min-w-0 flex-1">
                  <h2 className="text-[15px] font-semibold leading-tight tracking-[-0.01em]">{title}</h2>
                  {message && <p className="mt-2 text-[13px] leading-[1.5] text-[var(--muted)]">{message}</p>}
                  {details && (
                    <div className="mt-3 rounded-xl border bg-[color-mix(in_oklab,var(--fg)_3%,transparent)] px-3 py-2.5 text-[12px] leading-[1.5] text-[var(--muted)]">
                      {typeof details === 'string' ? <p className="break-words">{details}</p> : details}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <footer className="flex items-center justify-end gap-2 border-t bg-[color-mix(in_oklab,var(--fg)_2%,transparent)] px-5 py-3.5">
              <button ref={cancelRef} type="button" className="btn" onClick={onClose}>
                {cancelLabel}
              </button>
              <button
                ref={confirmRef}
                type="button"
                className={cn(
                  'btn',
                  variant === 'danger'
                    ? 'btn-danger'
                    : variant === 'warning'
                      ? 'bg-amber-600 hover:bg-amber-700 text-white border-transparent shadow-[0_10px_30px_-12px_rgba(217,119,6,0.6)]'
                      : 'btn-primary',
                )}
                onClick={() => {
                  onConfirm()
                  onClose()
                }}
              >
                {variant === 'danger' && icon === 'trash' ? <Trash2 size={14} /> : null}
                {confirmLabel}
              </button>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ---------------------------------------------------------------------------
// Preset models for important actions
// ---------------------------------------------------------------------------

export interface ConfirmModel {
  title: string
  message: string
  details?: string
  confirmLabel: string
  cancelLabel?: string
  variant: ConfirmVariant
  icon: ConfirmIcon
}

export const ConfirmModels = {
  removeDownload: (filename: string, status: string): ConfirmModel => ({
    title: `Remove "${filename}"?`,
    message:
      status === 'completed'
        ? 'This will remove the download from your list. The file on disk will not be deleted, but the entry and its history will be gone.'
        : status === 'failed' || status === 'canceled'
          ? 'This will remove the failed download from your list. You can add it again later if you want to retry.'
          : 'This download is still in progress. Removing it will cancel the transfer and discard its progress.',
    details: `File: ${filename}`,
    confirmLabel: 'Remove',
    variant: 'danger',
    icon: 'trash',
  }),

  cancelDownload: (filename: string, receivedBytes?: number, totalBytes?: number | null): ConfirmModel => {
    const progress =
      totalBytes && totalBytes > 0 && receivedBytes != null
        ? `${Math.min(100, (receivedBytes / totalBytes) * 100).toFixed(1)}% downloaded`
        : receivedBytes
          ? `${(receivedBytes / (1024 * 1024)).toFixed(1)} MB downloaded`
          : 'Progress will be lost if the save method is not resumable'
    return {
      title: `Cancel "${filename}"?`,
      message: `The download will be stopped and marked as canceled. ${progress}. You can retry it later from the beginning or from the last checkpoint if available.`,
      details: `File: ${filename}`,
      confirmLabel: 'Cancel download',
      variant: 'warning',
      icon: 'cancel',
    }
  },

  clearCompleted: (count: number): ConfirmModel => ({
    title: `Clear ${count} completed download${count === 1 ? '' : 's'}?`,
    message:
      count === 1
        ? 'This will remove the completed download from your list. The file itself will stay on disk.'
        : `This will remove all ${count} completed downloads from your list. Files on disk will not be deleted.`,
    confirmLabel: count === 1 ? 'Clear' : `Clear ${count}`,
    variant: 'danger',
    icon: 'clear',
  }),

  removeAllFiltered: (count: number, filterLabel: string): ConfirmModel => ({
    title: `Remove ${count} ${filterLabel} download${count === 1 ? '' : 's'}?`,
    message: `This will permanently remove ${count} download${count === 1 ? '' : 's'} matching the current filter. This action cannot be undone.`,
    confirmLabel: `Remove ${count}`,
    variant: 'danger',
    icon: 'trash',
  }),

  resetSettings: (): ConfirmModel => ({
    title: 'Reset settings to defaults?',
    message:
      'All your custom settings — theme, connections, speed limits, save preferences, proxy and notifications — will be restored to their default values. This cannot be undone.',
    confirmLabel: 'Reset settings',
    cancelLabel: 'Keep settings',
    variant: 'warning',
    icon: 'reset',
  }),

  forgetFolder: (folderName: string): ConfirmModel => ({
    title: `Forget folder "${folderName}"?`,
    message:
      'Flux will no longer save new downloads to this folder automatically. You will be asked where to save each new download, or you can pick a new default folder later.',
    confirmLabel: 'Forget folder',
    variant: 'warning',
    icon: 'folder',
  }),

  pauseAll: (count: number): ConfirmModel => ({
    title: `Pause ${count} active download${count === 1 ? '' : 's'}?`,
    message: `This will pause all ${count} active transfers. You can resume them individually or all at once later.`,
    confirmLabel: `Pause ${count}`,
    variant: 'default',
    icon: 'alert',
  }),

  cancelAll: (count: number): ConfirmModel => ({
    title: `Cancel ${count} active download${count === 1 ? '' : 's'}?`,
    message: `This will cancel all ${count} active transfers. Progress may be lost if the save method is not resumable. You can retry them later.`,
    confirmLabel: `Cancel ${count}`,
    variant: 'danger',
    icon: 'cancel',
  }),
} as const

// ---------------------------------------------------------------------------
// Global host that reads from the Zustand store
// ---------------------------------------------------------------------------

export function GlobalConfirmDialog() {
  const dialog = useStore((s) => s.ui.confirmDialog)
  const dismiss = useStore((s) => s.dismissConfirm)

  if (!dialog) return null

  return (
    <ConfirmDialog
      open={!!dialog}
      onClose={dismiss}
      onConfirm={dialog.onConfirm}
      title={dialog.title}
      message={dialog.message}
      details={dialog.details}
      confirmLabel={dialog.confirmLabel}
      cancelLabel={dialog.cancelLabel}
      variant={dialog.variant}
      icon={dialog.icon}
    />
  )
}
