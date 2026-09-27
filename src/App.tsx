import { useEffect } from 'react'
import { Plus } from 'lucide-react'

import { useStore } from './store/useStore'
import { useTheme } from './hooks/useTheme'
import { useHotkeys } from './hooks/useHotkeys'
import { useIsDesktop } from './hooks/useMediaQuery'
import { Aurora } from './components/Aurora'
import { Header } from './components/Header'
import { DownloadList } from './components/DownloadList'
import { DetailsPanel } from './components/DetailsPanel'
import { AddDownloadDialog } from './components/AddDownloadDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Toasts } from './components/Toasts'
import { MotionPreferences } from './components/MotionPreferences'
import { DebugConsole } from './components/DebugConsole'
import { Modal } from './components/ui'
import { isActive } from './types'

export default function App() {
  return <MotionPreferences><AppContent /></MotionPreferences>
}

function AppContent() {
  useTheme()
  const hydrate = useStore((s) => s.hydrate)
  const setUi = useStore((s) => s.setUi)
  const ui = useStore((s) => s.ui)
  const select = useStore((s) => s.select)
  const isDesktop = useIsDesktop()

  useEffect(() => { void hydrate() }, [hydrate])

  // Warn before leaving while transfers are in flight.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const { tasks } = useStore.getState()
      if (Object.values(tasks).some((t) => isActive(t.status))) { e.preventDefault(); e.returnValue = '' }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  // Paste a URL anywhere to start adding it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return
      const text = e.clipboardData?.getData('text')?.trim() ?? ''
      if (/^https?:\/\/\S+$/i.test(text)) {
        e.preventDefault()
        void useStore.getState().addDownload({ url: text })
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  // Drop a link anywhere to add it.
  useEffect(() => {
    const extractUrl = (e: DragEvent): string | null => {
      const raw = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || ''
      const trimmed = raw.split('\n').find((line) => line.trim() && !line.startsWith('#'))?.trim() ?? ''
      return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null
    }
    const onDragOver = (e: DragEvent) => {
      if (extractUrl(e)) e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      const url = extractUrl(e)
      if (!url) return
      e.preventDefault()
      void useStore.getState().addDownload({ url })
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const dialogOpen = ui.addOpen || ui.settingsOpen || ui.shortcutsOpen
  useHotkeys([
    { key: 'n', when: () => !dialogOpen, run: () => setUi({ addOpen: true }) },
    { key: ',', when: () => !dialogOpen, run: () => setUi({ settingsOpen: true }) },
    { key: '/', when: () => !dialogOpen, run: () => document.getElementById('flux-search')?.focus() },
    { key: '?', shift: true, when: () => !dialogOpen, run: () => setUi({ shortcutsOpen: true }) },
    { key: 'p', shift: true, when: () => !dialogOpen, run: () => useStore.getState().pauseAll() },
    { key: 'r', shift: true, when: () => !dialogOpen, run: () => useStore.getState().resumeAll() },
    { key: 'escape', allowInInput: true, run: () => { if (!dialogOpen) select(null) } },
  ])

  return (
    <div className="flex h-dvh flex-col px-3 pt-3 sm:px-5 sm:pt-5 lg:px-8 lg:pt-6" style={{ paddingBottom: 'var(--debug-offset, 0px)' }}>
      <Aurora />
      <Header />
      <main className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <DownloadList />
        {isDesktop ? <div className="min-h-0 pb-4"><DetailsPanel /></div> : <DetailsPanel asSheet />}
      </main>

      <button
        className="btn btn-primary fixed right-5 z-30 h-13 w-13 rounded-full p-0 shadow-2xl lg:hidden"
        style={{ bottom: 'calc(1.25rem + var(--debug-offset, 0px))' }}
        onClick={() => setUi({ addOpen: true })}
        aria-label="New download"
      >
        <Plus size={22} />
      </button>

      <AddDownloadDialog />
      <SettingsDialog />
      <Modal open={ui.shortcutsOpen} onClose={() => setUi({ shortcutsOpen: false })} title="Keyboard shortcuts" width="max-w-md">
        <ul className="divide-y text-sm">
          {[['N', 'New download'], ['⌘/Ctrl + V', 'Paste a link to add it'], ['/', 'Focus search'], [',', 'Settings'], ['Shift + P', 'Pause everything'], ['Shift + R', 'Resume everything'], ['Esc', 'Close panel'], ['?', 'This list']].map(([k, v]) => (
            <li key={k} className="flex items-center justify-between py-2.5"><span className="text-[var(--muted)]">{v}</span><kbd className="rounded-md border bg-[color-mix(in_oklab,var(--fg)_5%,transparent)] px-2 py-0.5 font-mono text-xs">{k}</kbd></li>
          ))}
        </ul>
      </Modal>
      <Toasts />
      <DebugConsole />
    </div>
  )
}
