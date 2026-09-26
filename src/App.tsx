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
import { Modal } from './components/ui'
import { isActive } from './types'

export default function App() {
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

  useHotkeys([
    { key: 'n', run: () => setUi({ addOpen: true }) },
    { key: ',', run: () => setUi({ settingsOpen: true }) },
    { key: '/', run: () => document.getElementById('flux-search')?.focus() },
    { key: '?', shift: true, run: () => setUi({ shortcutsOpen: true }) },
    { key: 'escape', allowInInput: true, run: () => { if (!ui.addOpen && !ui.settingsOpen && !ui.shortcutsOpen) select(null) } },
    { key: 'p', shift: true, run: () => useStore.getState().pauseAll() },
    { key: 'r', shift: true, run: () => useStore.getState().resumeAll() },
  ])

  return (
    <div className="flex h-dvh flex-col px-3 pt-3 sm:px-5 sm:pt-5 lg:px-8 lg:pt-6">
      <Aurora />
      <Header />
      <main className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[minmax(0,1fr)_420px]">
        <DownloadList />
        {isDesktop ? <div className="min-h-0 pb-4"><DetailsPanel /></div> : <DetailsPanel asSheet />}
      </main>

      <button
        className="btn btn-primary fixed bottom-5 right-5 z-30 h-13 w-13 rounded-full p-0 shadow-2xl lg:hidden"
        style={{ height: 52, width: 52 }}
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
    </div>
  )
}
