/**
 * Bridge to the app-scoped `sw.js` service worker that streams downloads to the browser's
 * native download shelf (see public/sw.js for the receiving half).
 */

const BASE_URL = import.meta.env.BASE_URL
const SW_URL = `${BASE_URL}sw.js`
let registration: Promise<ServiceWorkerRegistration | null> | null = null

export function isSwSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
}

export function isSwControlling(): boolean {
  return isSwSupported() && Boolean(navigator.serviceWorker.controller)
}

/** Registers the worker and resolves once it controls this page. */
export async function prepareStreamSink(timeoutMs = 6000): Promise<boolean> {
  if (!isSwSupported()) return false
  if (!registration) {
    registration = navigator.serviceWorker
      .register(SW_URL, { scope: BASE_URL })
      .then(async (reg) => {
        await navigator.serviceWorker.ready
        return reg
      })
      .catch(() => null)
  }
  const reg = await registration
  if (!reg) return false
  if (navigator.serviceWorker.controller) return true

  return new Promise<boolean>((resolve) => {
    const done = (ok: boolean) => {
      cleanup()
      resolve(ok)
    }
    const onChange = () => {
      if (navigator.serviceWorker.controller) done(true)
    }
    const timer = setTimeout(() => done(Boolean(navigator.serviceWorker.controller)), timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      navigator.serviceWorker.removeEventListener('controllerchange', onChange)
    }
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
    onChange()
  })
}

export interface StreamRegistration {
  id: string
  filename: string
  mime: string
  size: number | null
  readable: ReadableStream<Uint8Array>
}

/** Hands a stream to the worker, then triggers the browser download. */
export async function registerStream(info: StreamRegistration): Promise<string> {
  const controller = navigator.serviceWorker.controller
  if (!controller) throw new Error('Service worker is not controlling this page yet')
  const url = `${BASE_URL}flux-stream/${encodeURIComponent(info.id)}`

  const ack = new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => reject(new Error('Service worker did not acknowledge the stream')), 8000)
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer)
      if (event.data?.ok) resolve()
      else reject(new Error('Service worker refused the stream'))
      channel.port1.close()
    }
    try {
      controller.postMessage(
        {
          type: 'STREAM_REGISTER',
          url,
          filename: info.filename,
          mime: info.mime,
          size: info.size,
          readable: info.readable,
        },
        [info.readable],
      )
    } catch (error) {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })

  await ack
  return url
}

/** Navigates a hidden iframe to the synthetic URL so the browser saves it. */
export function triggerStreamDownload(url: string): void {
  if (typeof document === 'undefined') return
  const iframe = document.createElement('iframe')
  iframe.hidden = true
  iframe.style.display = 'none'
  iframe.src = url
  iframe.name = 'flux-stream'
  document.body.appendChild(iframe)
  window.setTimeout(() => iframe.remove(), 60_000)
}

export function abortStream(id: string, reason = 'canceled'): void {
  if (!isSwSupported()) return
  const controller = navigator.serviceWorker.controller
  if (!controller) return
  const url = `${BASE_URL}flux-stream/${encodeURIComponent(id)}`
  const channel = new MessageChannel()
  channel.port1.onmessage = () => channel.port1.close()
  try {
    controller.postMessage({ type: 'STREAM_ABORT', url, reason }, [])
  } catch {
    /* ignore */
  }
}
