import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Link2, Plus, Trash2, FlaskConical } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'

import { useStore } from '../store/useStore'
import type { AuthConfig, HeaderEntry } from '../types'
import { DEFAULT_AUTH } from '../types'
import { guessFilename } from '../lib/http'
import { Field, Modal, Segmented, SPEED_PRESETS } from './ui'

const SAMPLES = [
  { label: '20 MB · 8 connections', url: '/testfile/20mb?name=sample-20mb.bin' },
  { label: '100 MB · throttled server', url: '/testfile/100mb?delay=2&name=slow-100mb.bin' },
  { label: '5 MB · no range support', url: '/testfile/5mb?noranges=1&name=single-stream.bin' },
  { label: '8 MB · Basic auth (flux / demo)', url: '/testfile/8mb?auth=flux:demo&name=protected.bin' },
]

export function AddDownloadDialog() {
  const open = useStore((s) => s.ui.addOpen)
  const setUi = useStore((s) => s.setUi)
  const addDownload = useStore((s) => s.addDownload)
  const settings = useStore((s) => s.settings)

  const [url, setUrl] = useState('')
  const [filename, setFilename] = useState('')
  const [connections, setConnections] = useState(settings.defaultConnections)
  const [speedLimit, setSpeedLimit] = useState(0)
  const [auth, setAuth] = useState<AuthConfig>({ ...DEFAULT_AUTH })
  const [headers, setHeaders] = useState<HeaderEntry[]>([])
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setConnections(settings.defaultConnections)
    // Pre-fill from clipboard when it holds a URL — a small courtesy.
    void navigator.clipboard?.readText?.().then((text) => {
      if (!url && /^https?:\/\/\S+$/i.test(text.trim())) setUrl(text.trim())
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const resolvedUrl = useMemo(() => {
    const t = url.trim()
    if (!t) return ''
    if (t.startsWith('/')) return new URL(t, window.location.origin).toString()
    return t
  }, [url])

  const placeholder = useMemo(() => (resolvedUrl ? guessFilename(resolvedUrl) : 'auto-detect'), [resolvedUrl])
  const valid = /^https?:\/\/\S+/i.test(resolvedUrl)

  const close = () => setUi({ addOpen: false })
  const reset = () => {
    setUrl('')
    setFilename('')
    setSpeedLimit(0)
    setAuth({ ...DEFAULT_AUTH })
    setHeaders([])
    setAdvanced(false)
  }

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    try {
      const id = await addDownload({ url: resolvedUrl, filename: filename || undefined, connections, speedLimit, auth, headers })
      if (id) {
        reset()
        close()
      }
    } finally {
      setBusy(false)
    }
  }

  const addHeader = () => setHeaders((h) => [...h, { id: crypto.randomUUID(), name: '', value: '', enabled: true }])

  return (
    <Modal
      open={open}
      onClose={close}
      title="New download"
      subtitle="Paste a direct link. Flux probes it, splits it across connections and streams it to disk."
      footer={
        <>
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={!valid || busy}>
            <Plus size={14} /> {busy ? 'Adding…' : 'Add download'}
          </button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field label="URL">
          <div className="relative">
            <Link2 size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
            <input
              autoFocus
              className="field pl-9 font-mono text-[12px]"
              placeholder="https://example.com/file.zip"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
            />
          </div>
        </Field>

        <div className="flex flex-wrap gap-1.5">
          <span className="chip"><FlaskConical size={10} /> try a sample</span>
          {SAMPLES.map((s) => (
            <button key={s.url} type="button" className="chip hover:border-[var(--brand)] hover:text-[var(--fg)]" onClick={() => setUrl(s.url)}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Save as" hint="Leave blank to use the server's name">
            <input className="field" placeholder={placeholder} value={filename} onChange={(e) => setFilename(e.target.value)} />
          </Field>
          <Field label={`Connections · ${connections}`} hint="Parallel HTTP range requests">
            <input
              type="range"
              min={1}
              max={16}
              value={connections}
              onChange={(e) => setConnections(Number(e.target.value))}
              className="mt-2 w-full accent-[var(--brand)]"
            />
          </Field>
        </div>

        <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--fg)]">
          <motion.span animate={{ rotate: advanced ? 180 : 0 }}><ChevronDown size={14} /></motion.span>
          Authentication, headers & limits
        </button>

        <AnimatePresence initial={false}>
          {advanced && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
              className="overflow-hidden"
            >
              <div className="space-y-4 rounded-2xl border bg-[color-mix(in_oklab,var(--fg)_3%,transparent)] p-4">
                <Field label="Authentication">
                  <Segmented
                    value={auth.kind}
                    onChange={(kind) => setAuth((a) => ({ ...a, kind }))}
                    options={[
                      { value: 'none', label: 'None' },
                      { value: 'basic', label: 'Basic' },
                      { value: 'bearer', label: 'Bearer' },
                    ]}
                  />
                </Field>
                {auth.kind === 'basic' && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <input className="field" placeholder="Username" autoComplete="off" value={auth.username} onChange={(e) => setAuth({ ...auth, username: e.target.value })} />
                    <input className="field" placeholder="Password" type="password" autoComplete="new-password" value={auth.password} onChange={(e) => setAuth({ ...auth, password: e.target.value })} />
                  </div>
                )}
                {auth.kind === 'bearer' && (
                  <input className="field font-mono text-[12px]" placeholder="Token" value={auth.token} onChange={(e) => setAuth({ ...auth, token: e.target.value })} />
                )}

                <Field label="Speed limit">
                  <div className="flex flex-wrap gap-1.5">
                    {SPEED_PRESETS.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => setSpeedLimit(p.value)}
                        className={`chip ${speedLimit === p.value ? 'border-[var(--brand)] text-[var(--fg)]' : ''}`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </Field>

                <Field label="Custom headers" hint="Cookies, Origin and other forbidden headers cannot be set by a web page.">
                  <div className="space-y-2">
                    {headers.map((h) => (
                      <div key={h.id} className="flex gap-2">
                        <input className="field font-mono text-[12px]" placeholder="X-Api-Key" value={h.name} onChange={(e) => setHeaders(headers.map((x) => (x.id === h.id ? { ...x, name: e.target.value } : x)))} />
                        <input className="field font-mono text-[12px]" placeholder="value" value={h.value} onChange={(e) => setHeaders(headers.map((x) => (x.id === h.id ? { ...x, value: e.target.value } : x)))} />
                        <button type="button" className="icon-btn shrink-0" onClick={() => setHeaders(headers.filter((x) => x.id !== h.id))}><Trash2 size={14} /></button>
                      </div>
                    ))}
                    <button type="button" className="btn h-8 text-xs" onClick={addHeader}><Plus size={12} /> Add header</button>
                  </div>
                </Field>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </form>
    </Modal>
  )
}
