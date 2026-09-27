import { FolderOpen, RotateCcw } from 'lucide-react'
import { useStore } from '../store/useStore'
import { Field, Modal, Segmented, SPEED_PRESETS, Toggle } from './ui'

export function SettingsDialog() {
  const open = useStore((s) => s.ui.settingsOpen)
  const setUi = useStore((s) => s.setUi)
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.updateSettings)
  const reset = useStore((s) => s.resetSettings)
  const caps = useStore((s) => s.capabilities)
  const chooseFolder = useStore((s) => s.chooseFolder)
  const clearFolder = useStore((s) => s.clearFolder)

  const close = () => setUi({ settingsOpen: false })

  return (
    <Modal
      open={open}
      onClose={close}
      title="Settings"
      subtitle="Everything is stored locally in this browser."
      width="max-w-2xl"
      footer={
        <>
          <button className="btn btn-ghost" onClick={reset}><RotateCcw size={13} /> Reset defaults</button>
          <button className="btn btn-primary" onClick={close}>Done</button>
        </>
      }
    >
      <div className="space-y-7">
        <Section title="Appearance">
          <Field label="Theme">
            <Segmented value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </Field>
          <Toggle checked={settings.reducedMotion} onChange={(reducedMotion) => update({ reducedMotion })} label="Reduce motion" hint="Disables animations and transitions; also respects your system preference" />
          <Toggle checked={settings.showSegmentView} onChange={(showSegmentView) => update({ showSegmentView })} label="Show connection details" hint="Per-connection table in the details panel" />
        </Section>

        <Section title="Transfers">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={`Default connections · ${settings.defaultConnections}`}>
              <input type="range" min={1} max={16} value={settings.defaultConnections} onChange={(e) => update({ defaultConnections: Number(e.target.value) })} className="mt-2 w-full accent-[var(--brand)]" />
            </Field>
            <Field label={`Concurrent downloads · ${settings.maxConcurrentDownloads}`}>
              <input type="range" min={1} max={8} value={settings.maxConcurrentDownloads} onChange={(e) => update({ maxConcurrentDownloads: Number(e.target.value) })} className="mt-2 w-full accent-[var(--brand)]" />
            </Field>
            <Field label={`Retries per connection · ${settings.maxRetries}`}>
              <input type="range" min={0} max={20} value={settings.maxRetries} onChange={(e) => update({ maxRetries: Number(e.target.value) })} className="mt-2 w-full accent-[var(--brand)]" />
            </Field>
            <Field label="Global speed limit">
              <div className="flex flex-wrap gap-1.5">
                {SPEED_PRESETS.map((p) => (
                  <button key={p.value} type="button" onClick={() => update({ globalSpeedLimit: p.value })} className={`chip ${settings.globalSpeedLimit === p.value ? 'border-[var(--brand)] text-[var(--fg)]' : ''}`}>{p.label}</button>
                ))}
              </div>
            </Field>
          </div>
          <Toggle checked={settings.startImmediately} onChange={(startImmediately) => update({ startImmediately })} label="Start downloads immediately" hint="Otherwise new items wait in the queue as paused" />
        </Section>

        <Section title="Saving">
          <Field label="Save method" hint={describeMode(settings.saveMode, caps)}>
            <Segmented
              value={settings.saveMode}
              onChange={(saveMode) => update({ saveMode })}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'stream', label: 'Browser' },
                { value: 'fsa', label: 'Pick file' },
                { value: 'memory', label: 'Memory' },
              ]}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span className="chip">{caps.sw ? '● streaming available' : '○ streaming unavailable'}</span>
            <span className="chip">{caps.fsa ? '● file picker available' : '○ file picker unavailable'}</span>
          </div>
          {caps.fsa && (
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn" onClick={() => void chooseFolder()}><FolderOpen size={14} /> {settings.defaultFolderName ? `Folder: ${settings.defaultFolderName}` : 'Choose default folder'}</button>
              {settings.defaultFolderName && <button className="btn btn-ghost" onClick={() => void clearFolder()}>Forget</button>}
            </div>
          )}
          <Toggle checked={settings.alwaysAskLocation} onChange={(alwaysAskLocation) => update({ alwaysAskLocation })} label="Always ask where to save" hint="Applies when using the file picker" />
          <Toggle checked={settings.notifyOnComplete} onChange={(notifyOnComplete) => update({ notifyOnComplete })} label="Notify when a download completes" />
          <Toggle checked={settings.autoOpenFile} onChange={(autoOpenFile) => update({ autoOpenFile })} label="Auto-save memory downloads" hint="Trigger the browser save prompt as soon as an in-memory file finishes" />
          <Toggle checked={settings.removeOnComplete} onChange={(removeOnComplete) => update({ removeOnComplete })} label="Remove completed items from the list" />
        </Section>

        <Section title="Network">
          <Field label="CORS proxy" hint="Use {url} or {encoded} as a placeholder, e.g. https://proxy.example/?{encoded}. Only use a proxy you trust — it sees the traffic.">
            <input className="field font-mono text-[12px]" placeholder="https://your-proxy.example/{url}" value={settings.proxyTemplate} onChange={(e) => update({ proxyTemplate: e.target.value })} spellCheck={false} />
          </Field>
          <Field label="Proxy mode">
            <Segmented value={settings.proxyMode} onChange={(proxyMode) => update({ proxyMode })} options={[{ value: 'off', label: 'Off' }, { value: 'auto', label: 'On CORS failure' }, { value: 'always', label: 'Always' }]} />
          </Field>
        </Section>
      </div>
    </Modal>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--faint)]">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function describeMode(mode: string, caps: { sw: boolean; fsa: boolean }): string {
  switch (mode) {
    case 'stream':
      return 'Streams into the browser download shelf via a service worker. No pause/resume across reloads.'
    case 'fsa':
      return 'Writes straight into a file you choose. Resumable, handles huge files. Chromium only.'
    case 'memory':
      return 'Buffers the whole file in RAM, then offers a save button. Fine for small files.'
    default:
      return `Picks the best available: ${caps.sw ? 'browser stream' : caps.fsa ? 'file picker' : 'memory'}.`
  }
}
