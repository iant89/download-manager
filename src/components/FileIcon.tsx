import { FileArchive, FileAudio, FileCode, FileImage, FileText, FileVideo, File as FileIconBase } from 'lucide-react'
import { cn } from '../lib/cn'

const MAP: { test: RegExp; icon: typeof FileIconBase; tint: string }[] = [
  { test: /\.(zip|rar|7z|tar|gz|bz2|xz|iso|dmg)$/i, icon: FileArchive, tint: 'var(--warn)' },
  { test: /\.(mp4|mkv|webm|mov|avi|m4v)$/i, icon: FileVideo, tint: 'var(--accent)' },
  { test: /\.(mp3|wav|flac|ogg|m4a|aac)$/i, icon: FileAudio, tint: 'var(--brand)' },
  { test: /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i, icon: FileImage, tint: 'var(--ok)' },
  { test: /\.(json|ya?ml|toml|xml|csv|tsx?|jsx?|py|rs|go|sh|html?|css)$/i, icon: FileCode, tint: 'var(--muted)' },
  { test: /\.(txt|md|pdf|docx?|rtf|epub|log)$/i, icon: FileText, tint: 'var(--muted)' },
]

export function FileIcon({ filename, className }: { filename: string; className?: string }) {
  const match = MAP.find((entry) => entry.test.test(filename))
  const Icon = match?.icon ?? FileIconBase
  const tint = match?.tint ?? 'var(--muted)'

  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-xl border border-[var(--hairline)]',
        'bg-[color-mix(in_oklab,var(--fg)_5%,transparent)]',
        className ?? 'h-10 w-10',
      )}
      style={{ color: tint }}
    >
      <Icon size={18} strokeWidth={1.8} />
    </span>
  )
}
