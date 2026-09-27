import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Link2, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'

import { useStore } from '../store/useStore'
import { PRIORITY_LEVELS } from '../lib/engine/scheduler'
import { isValidSha256 } from '../lib/engine/sha256'
import type { AuthConfig, HeaderEntry } from '../types'
import { DEFAULT_AUTH } from '../types'
import { guessFilename, isForbiddenRequestHeader } from '../lib/http'
import { Field, Modal, Segmented, SPEED_PRESETS } from './ui'
import { HeaderNameInput } from './HeaderNameInput'

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
  const [checksum, setChecksum] = useState('')
  const [priority, setPriority] = useState(0)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)

  const checksumInvalid = checksum.trim() !== '' && !isValidSha256(checksum)
  const urlInput = useRef<HTMLInputElement>(null)
  const urlEdited = useRef(false)
  const selectClipboardUrl = useRef(false)
  const session = useRef(0)

  useEffect(() => {
    if (!open) return
    const currentSession = ++session.current
    setUrl('')
    setFilename('')
    setConnections(useStore.getState().settings.defaultConnections)
    setSpeedLimit(0)
    setAuth({ ...DEFAULT_AUTH })
    setHeaders([])
    setChecksum('')
    setPriority(0)
    setAdvanced(false)
    setBusy(false)
    urlEdited.current = false
    selectClipboardUrl.current = false
    urlInput.current?.focus()

    // Permission failures are harmless. A late read must not overwrite typing
    // or populate a later opening of the dialog.
    void navigator.clipboard?.readText?.().then((text) => {
      const link = text.trim()
      if (session.current !== currentSession || urlEdited.current || !/^https?:\/\/\S+$/i.test(link)) return
      try {
        new URL(link)
      } catch {
        return
      }
      selectClipboardUrl.current = true
      setUrl(link)
    }).catch(() => undefined)
    return () => { session.current += 1 }
  }, [open])

  useLayoutEffect(() => {
    if (!selectClipboardUrl.current) return
    selectClipboardUrl.current = false
    urlInput.current?.focus()
    urlInput.current?.select()
  }, [url])

  const resolvedUrl = useMemo(() => {
    const t = url.trim()
    if (!t) return ''
    if (t.startsWith('/')) return new URL(t, window.location.origin).toString()
    return t
  }, [url])

  const placeholder = useMemo(() => (resolvedUrl ? guessFilename(resolvedUrl) : 'auto-detect'), [resolvedUrl])
  const valid = /^https?:\/\/\S+/i.test(resolvedUrl) && !headers.some((h) => h.enabled && isForbiddenRequestHeader(h.name, h.value))

  const close = () => setUi({ addOpen: false })
  const submit = async () => {
    if (!valid || busy) return
    const currentSession = session.current
    setBusy(true)
    try {
      const id = await addDownload({ url: resolvedUrl, filename: filename || undefined, connections, speedLimit, auth, headers, priority, checksum: checksum.trim() || undefined })
      if (id && session.current === currentSession) {
        close()
      }
    } finally {
      if (session.current === currentSession) setBusy(false)
    }
  }

  const focusHeader = useRef<string | null>(null)
  const addHeader = () => {
    const id = crypto.randomUUID()
    focusHeader.current = id
    setHeaders((h) => [...h, { id, name: '', value: '', enabled: true }])
  }
  // Focus a freshly added header name so its suggestions appear straight away.
  useEffect(() => {
    const id = focusHeader.current
    if (!id) return
    focusHeader.current = null
    document.getElementById(`header-${id}-name`)?.focus()
  }, [headers])

  return (
    <Modal
      open={open}
      onClose={close}
      title="New download"
      subtitle="Paste a direct link. Flux probes it, splits it across connections and streams it to disk."
      footer={
        <>
          <button className="btn btn-ghost" onClick={close}>Cancel</button>
          <button className="btn btn-primary min-w-[140px]" onClick={submit} disabled={!valid || busy} aria-busy={busy}>
            {busy ? <LoaderCircle size={14} className="animate-spin-slow" aria-hidden /> : <Plus size={14} />} {busy ? 'Adding…' : 'Add download'}
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
              ref={urlInput}
              autoFocus
              className="field pl-9 font-mono text-[12px]"
              placeholder="https://example.com/file.zip"
              value={url}
              onChange={(e) => { urlEdited.current = true; setUrl(e.target.value) }}
              spellCheck={false}
            />
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Save as" hint="Leave blank to use the URL filename">
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

        <button type="button" aria-expanded={advanced} aria-controls="download-advanced" onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1.5 text-xs font-medium text-[var(--muted)] hover:text-[var(--fg)]">
          <motion.span animate={{ rotate: advanced ? 180 : 0 }}><ChevronDown size={14} /></motion.span>
          Authentication, headers, limits & integrity
        </button>

        <AnimatePresence initial={false}>
          {advanced && (
            <motion.div
              id="download-advanced"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
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

                <Field label="Priority" hint="Higher priority downloads start first when the queue is full.">
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Priority">
                    {PRIORITY_LEVELS.map((p) => (
                      <button
                        key={p.value}
                        type="button"
                        aria-pressed={priority === p.value}
                        onClick={() => setPriority(p.value)}
                        className={`chip ${priority === p.value ? 'border-[var(--brand)] text-[var(--fg)]' : ''}`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </Field>

                <Field
                  label="Expected SHA-256"
                  hint={checksumInvalid ? 'Needs 64 hexadecimal characters.' : 'Optional. The finished file is hashed and must match.'}
                >
                  <input
                    className="field font-mono text-[12px]"
                    placeholder="e3b0c44298fc1c149afbf4c8996fb924…"
                    aria-label="Expected SHA-256"
                    aria-invalid={checksumInvalid}
                    spellCheck={false}
                    autoComplete="off"
                    value={checksum}
                    onChange={(e) => setChecksum(e.target.value)}
                  />
                </Field>

                <Field label="Custom headers" hint="Cookies, Origin and other forbidden headers cannot be set by a web page.">
                  <div className="space-y-2">
                    {headers.map((h) => {
                      const forbidden = isForbiddenRequestHeader(h.name, h.value)
                      const errorId = `header-${h.id}-error`
                      return (
                        <div key={h.id}>
                          <div className="flex gap-2">
                            <HeaderNameInput
                              id={`header-${h.id}-name`}
                              className="field font-mono text-[12px]"
                              aria-label="Header name"
                              aria-invalid={forbidden}
                              aria-describedby={forbidden ? errorId : undefined}
                              placeholder="X-Api-Key"
                              value={h.name}
                              onChange={(name) => setHeaders((all) => all.map((x) => (x.id === h.id ? { ...x, name } : x)))}
                              onPick={() => document.getElementById(`header-${h.id}-value`)?.focus()}
                            />
                            <input id={`header-${h.id}-value`} aria-label="Header value" className="field font-mono text-[12px]" placeholder="value" value={h.value} onChange={(e) => setHeaders(headers.map((x) => (x.id === h.id ? { ...x, value: e.target.value } : x)))} />
                            <button type="button" aria-label="Remove header" className="icon-btn shrink-0" onClick={() => setHeaders(headers.filter((x) => x.id !== h.id))}><Trash2 size={14} /></button>
                          </div>
                          {forbidden && <p id={errorId} role="alert" className="mt-1 text-xs text-[var(--danger)]">This header is forbidden by the browser. Remove it or use a different header.</p>}
                        </div>
                      )
                    })}
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
