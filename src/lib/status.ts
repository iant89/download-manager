import type { DownloadStatus } from '../types'

export interface StatusMeta {
  label: string
  tone: 'brand' | 'ok' | 'warn' | 'danger' | 'muted'
}

export const STATUS_META: Record<DownloadStatus, StatusMeta> = {
  queued: { label: 'Queued', tone: 'muted' },
  probing: { label: 'Connecting', tone: 'brand' },
  downloading: { label: 'Downloading', tone: 'brand' },
  pausing: { label: 'Pausing', tone: 'warn' },
  paused: { label: 'Paused', tone: 'warn' },
  verifying: { label: 'Verifying', tone: 'brand' },
  finalizing: { label: 'Finishing', tone: 'brand' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'muted' },
}

export const TONE_TEXT: Record<StatusMeta['tone'], string> = {
  brand: 'text-[var(--brand)]',
  ok: 'text-[var(--ok)]',
  warn: 'text-[var(--warn)]',
  danger: 'text-[var(--danger)]',
  muted: 'text-[var(--muted)]',
}

export const TONE_BG: Record<StatusMeta['tone'], string> = {
  brand: 'bg-[color-mix(in_oklab,var(--brand)_16%,transparent)]',
  ok: 'bg-[color-mix(in_oklab,var(--ok)_16%,transparent)]',
  warn: 'bg-[color-mix(in_oklab,var(--warn)_18%,transparent)]',
  danger: 'bg-[color-mix(in_oklab,var(--danger)_16%,transparent)]',
  muted: 'bg-[color-mix(in_oklab,var(--fg)_8%,transparent)]',
}

export const TONE_HEX: Record<StatusMeta['tone'], string> = {
  brand: 'var(--brand)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  danger: 'var(--danger)',
  muted: 'var(--faint)',
}
