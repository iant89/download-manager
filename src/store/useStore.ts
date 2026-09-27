/**
 * Single source of truth for the UI: task list, settings, live telemetry and
 * toasts. The heavy lifting happens in `DownloadManager` / `TaskRunner`; this
 * store owns state transitions and persistence.
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { del, get, set } from 'idb-keyval'

import type {
  AuthConfig,
  DownloadTask,
  FilterKey,
  HeaderEntry,
  NewDownloadInput,
  SegmentState,
  Settings,
} from '../types'
import { DEFAULT_AUTH, DEFAULT_SETTINGS, EMPTY_DIAGNOSTICS, isActive } from '../types'
import { guessFilename, safeFilename } from '../lib/http'
import { RequestResolver } from '../lib/requestResolver'
import { DownloadManager, type ManagerEvent } from '../lib/engine/manager'
import type { DownloadCheckpoint } from '../lib/engine/checkpoint'
import { isValidSha256, normalizeChecksum } from '../lib/engine/sha256'
import { handleStore } from '../lib/engine/handleStore'
import { bootstrapSinks, getSinkCapabilities, refreshSinkCapabilities, resolveSaveMode } from '../lib/engine/sinkFactory'
import { ensureWritePermission, isFsaSupported, pickDirectory, pickSaveFile, PickerCancelledError, type FsaFileHandle } from '../lib/engine/sinks/fsa'
import { MEMORY_WARN_LIMIT } from '../lib/engine/sinks/memorySink'
import { debug } from '../lib/debugLog'
import { smoothSpeed } from '../lib/engine/eta'

export interface Toast {
  id: string
  kind: 'success' | 'error' | 'info' | 'warning'
  title: string
  message?: string
  action?: { label: string; run: () => void }
  createdAt: number
}

interface UiState {
  addOpen: boolean
  settingsOpen: boolean
  detailsOpen: boolean
  commandOpen: boolean
  shortcutsOpen: boolean
  /** Task id waiting for the user to pick a save location. */
  pickingFor: string | null
}

interface StoreState {
  tasks: Record<string, DownloadTask>
  order: string[]
  settings: Settings
  selectedId: string | null
  filter: FilterKey
  search: string
  toasts: Toast[]
  ui: UiState
  capabilities: { sw: boolean; fsa: boolean }
  globalSpeed: number
  globalHistory: number[]
  hydrated: boolean

  // lifecycle
  hydrate(): Promise<void>
  tick(): void

  // tasks
  addDownload(input: NewDownloadInput): Promise<string | null>
  pause(id: string): void
  resume(id: string): void
  cancel(id: string): void
  retry(id: string): void
  remove(id: string): void
  pauseAll(): void
  resumeAll(): void
  clearCompleted(): void
  retryFailed(): void
  updateTask(id: string, patch: Partial<DownloadTask>): void
  setPriority(id: string, priority: number): void

  // ui
  select(id: string | null): void
  setFilter(filter: FilterKey): void
  setSearch(search: string): void
  setUi(patch: Partial<UiState>): void
  updateSettings(patch: Partial<Settings>): void
  resetSettings(): void
  pushToast(toast: Omit<Toast, 'id' | 'createdAt'>): void
  dismissToast(id: string): void
  chooseFolder(): Promise<void>
  clearFolder(): Promise<void>
  startPicking(id: string): Promise<void>
}

const SAMPLE_INTERVAL = 500
const HISTORY = 80
const GLOBAL_HISTORY = 120

let manager: DownloadManager | null = null
const resolver = new RequestResolver(() => useStore.getState().settings)
let lastSample: { at: number; bytes: Record<string, number> } = { at: Date.now(), bytes: {} }
let saveTimer: ReturnType<typeof setTimeout> | null = null

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      tasks: {},
      order: [],
      settings: { ...DEFAULT_SETTINGS },
      selectedId: null,
      filter: 'all',
      search: '',
      toasts: [],
      ui: { addOpen: false, settingsOpen: false, detailsOpen: false, commandOpen: false, shortcutsOpen: false, pickingFor: null },
      capabilities: { sw: false, fsa: false },
      globalSpeed: 0,
      globalHistory: [],
      hydrated: false,

      async hydrate() {
        if (get().hydrated) return
        bootstrapSinks()
        const caps = await refreshSinkCapabilities()
        const dirName = await handleStore.getDirectoryName()
        set((state) => ({
          capabilities: caps,
          settings: { ...state.settings, defaultFolderName: dirName ?? state.settings.defaultFolderName },
          hydrated: true,
        }))

        const persisted = await loadTasks()
        if (persisted) {
          // P3-05: restore in deterministic order — priority first, then FIFO
          // (queuedAt). Do not depend on IndexedDB iteration order.
          const sortedPersisted = [...persisted].sort((a, b) => b.priority - a.priority || (a.queuedAt ?? 0) - (b.queuedAt ?? 0))
          const tasks: Record<string, DownloadTask> = {}
          const order: string[] = []
          const checkpoints = new Map<string, DownloadCheckpoint>()
          let corrupt = 0
          for (const task of sortedPersisted) {
            const restored = await restoreTask(task, (cp) => checkpoints.set(task.id, cp), () => (corrupt += 1))
            tasks[task.id] = restored
            order.push(task.id)
          }
          // Preserve the persisted order array (which is already priority-sorted)
          // but ensure the manager's scheduler sees the same priority/sequence.
          set({ tasks, order })
          for (const id of order) {
            const task = tasks[id]!
            manager?.createRunner(task, checkpoints.get(id) ?? null)
          }
          // P3-05: queued items stay queued so the scheduler can restore the
          // queue order after a reload. Only active downloads become paused as
          // they need a user gesture to resume (file handle permission).
          for (const id of order) {
            const task = tasks[id]!
            if (task.status === 'queued') manager?.enqueue(id)
          }
          if (corrupt > 0) {
            get().pushToast({
              kind: 'warning',
              title: 'Some resume data was unreadable',
              message: `${corrupt} download${corrupt === 1 ? '' : 's'} will restart from the beginning.`,
            })
          }
          scheduleSave()
        }

        startTicker()
      },

      tick() {
        const now = Date.now()
        const dt = Math.max(0.2, (now - lastSample.at) / 1000)
        const state = get()
        const tasks = state.tasks
        let changed = false
        let globalSpeed = 0
        const nextTasks: Record<string, DownloadTask> = { ...tasks }

        for (const id of state.order) {
          const task = tasks[id]
          if (!task) continue
          const active = isActive(task.status)
          const previous = lastSample.bytes[id]
          const received = task.receivedBytes
          let speed = 0
          if (active && previous != null && dt > 0) {
            speed = Math.max(0, ((received - previous) / dt) * 1)
          }
          // P3-04: ETA / speed uses exponential moving average to avoid
          // noisy instantaneous values: smoothed = alpha*current + (1-alpha)*prev
          const smoothed = active ? smoothSpeed(task.speed, speed, 0.15) : 0

          // Settled tasks (finished and already decayed to zero) are left
          // untouched so their cards don't re-render on every tick.
          const lastSampled = task.speedHistory.at(-1) ?? 0
          if (!active && task.speed === 0 && lastSampled === 0) continue

          const history = task.speedHistory.length >= HISTORY
            ? [...task.speedHistory.slice(1), smoothed]
            : [...task.speedHistory, smoothed]

          const nextSegments: SegmentState[] | null =
            task.segments.length > 0
              ? task.segments.map((seg) => ({
                  ...seg,
                  speed: seg.status === 'done' ? 0 : Math.max(0, smoothed / Math.max(1, countActive(task.segments))),
                }))
              : null

          if (speed !== task.speed || history.length !== task.speedHistory.length || nextSegments) {
            nextTasks[id] = { ...task, speed: smoothed, speedHistory: history, segments: nextSegments ?? task.segments }
            changed = true
          }
          if (active) globalSpeed += smoothed
        }

        const globalHistory =
          state.globalHistory.length >= GLOBAL_HISTORY
            ? [...state.globalHistory.slice(1), globalSpeed]
            : [...state.globalHistory, globalSpeed]

        lastSample = {
          at: now,
          bytes: Object.fromEntries(state.order.map((id) => [id, tasks[id]?.receivedBytes ?? 0])),
        }

        if (changed || globalSpeed !== state.globalSpeed) {
          set({ tasks: changed ? nextTasks : tasks, globalSpeed, globalHistory })
        } else {
          set({ globalHistory })
        }
      },

      async addDownload(input) {
        const state = get()
        const url = input.url.trim()
        if (!url) return null
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          state.pushToast({ kind: 'error', title: 'That is not a valid URL', message: url.slice(0, 80) })
          return null
        }
        if (!/^https?:$/.test(parsed.protocol)) {
          state.pushToast({
            kind: 'error',
            title: 'Unsupported protocol',
            message: `Browsers can only fetch http(s) URLs (got ${parsed.protocol})`,
          })
          return null
        }

        const settings = state.settings
        const id = newId()
        const filename = safeFilename(input.filename?.trim() || guessFilename(url))
        const connections = input.connections ?? settings.defaultConnections
        const auth = input.auth ?? { ...DEFAULT_AUTH }
        const headers = input.headers ?? []
        let expectedChecksum: string | null = null
        if (input.checksum?.trim()) {
          if (!isValidSha256(input.checksum)) {
            state.pushToast({ kind: 'error', title: 'Invalid SHA-256', message: 'Expected 64 hexadecimal characters.' })
            return null
          }
          expectedChecksum = normalizeChecksum(input.checksum)
        }
        const request = resolver.resolve({ url, auth, headers })
        const effectiveUrl = request.url
        if (request.exposesCredentials) {
          state.pushToast({
            kind: 'warning',
            title: 'Credentials sent via proxy',
            message: 'Auth headers for this download will pass through your CORS proxy.',
          })
        }

        // The save dialog needs a user gesture, so ask before we touch the network.
        let handle: FsaFileHandle | null = null
        const mode = await resolveSaveMode(settings.saveMode)
        if (mode === 'fsa' && isFsaSupported()) {
          const dir = await handleStore.getDirectory()
          if (settings.alwaysAskLocation || !dir) {
            try {
              handle = await pickSaveFile(filename, dir ?? undefined)
              await handleStore.setFile(id, handle)
            } catch (error) {
              if (!(error instanceof PickerCancelledError)) {
                state.pushToast({
                  kind: 'warning',
                  title: 'Could not use that location',
                  message: error instanceof Error ? error.message : String(error),
                })
              }
              handle = null
            }
          } else {
            // A default folder is set: create the file inside it directly,
            // no picker needed.
            try {
              handle = await dir.getFileHandle(filename, { create: true })
              const ok = await ensureWritePermission(dir)
              if (!ok) {
                state.pushToast({
                  kind: 'warning',
                  title: 'Permission needed',
                  message: `Re-allow writes to "${dir.name}" to save there again.`,
                })
                handle = null
              }
            } catch (error) {
              state.pushToast({
                kind: 'warning',
                title: 'Could not use the default folder',
                message: error instanceof Error ? error.message : String(error),
              })
              handle = null
            }
          }
        }

        const task: DownloadTask = {
          id,
          url,
          filename: handle?.name ?? filename,
          mime: 'application/octet-stream',
          totalBytes: null,
          connections,
          speedLimit: input.speedLimit ?? 0,
          maxRetries: input.maxRetries ?? settings.maxRetries,
          auth,
          headers,
          status: settings.startImmediately ? 'queued' : 'paused',
          receivedBytes: 0,
          createdAt: Date.now(),
          startedAt: null,
          completedAt: null,
          error: null,
          supportsRanges: false,
          segments: [],
          speedHistory: [],
          speed: 0,
          saveMode: null,
          terminalFailureCount: 0,
          priority: input.priority ?? 0,
          queuedAt: Date.now(),
          expectedChecksum,
          checksumVerified: null,
          identity: null,
          diagnostics: { ...EMPTY_DIAGNOSTICS },
          effectiveUrl,
          proxyUsed: request.proxyUsed,
          handleKey: handle ? `file:${id}` : null,
          awaitingTarget: false,
          resultUrl: null,
        }

        set((s) => ({
          tasks: { ...s.tasks, [id]: task },
          order: [id, ...s.order],
          selectedId: id,
        }))

        debug.info('store', `Added download ${filename}`, {
          id,
          url,
          effectiveUrl,
          connections,
          speedLimit: task.speedLimit,
          auth: task.auth.kind,
          headers: task.headers.filter((h) => h.enabled && h.name.trim()).map((h) => h.name.trim()),
          saveMode: mode,
          status: task.status,
        })
        manager?.createRunner(task)
        if (settings.startImmediately) manager?.enqueue(id)
        scheduleSave()
        return id
      },

      pause(id) {
        const task = get().tasks[id]
        if (!task) return
        debug.info('store', `Pause ${task.filename}`, { id })
        // Waiting in the queue is scheduling state the store owns; anything
        // running reports pausing → paused itself (plan P1-02).
        // Speed is UI telemetry and drops immediately either way.
        const settleHere = task.status === 'queued' || !manager?.has(id)
        set((s) => ({
          tasks: { ...s.tasks, [id]: { ...s.tasks[id]!, speed: 0, ...(settleHere ? { status: 'paused' as const } : {}) } },
        }))
        void manager?.pause(id)
        scheduleSave()
      },

      resume(id) {
        const task = get().tasks[id]
        if (!task) return
        debug.info('store', `Resume ${task.filename}`, { id, from: task.status })
        // Failed and canceled runners are terminal (their outcome latches in
        // the engine); resuming them means starting over, not continuing.
        if (task.status === 'failed' || task.status === 'canceled') {
          get().retry(id)
          return
        }
        if (task.status === 'queued' || task.status === 'paused') {
          // Resuming goes through the scheduler like everything else.
          set((s) => ({ tasks: { ...s.tasks, [id]: { ...s.tasks[id]!, status: 'queued', error: null } } }))
          manager?.enqueue(id)
          scheduleSave()
        }
      },

      cancel(id) {
        debug.info('store', `Cancel ${get().tasks[id]?.filename ?? id}`, { id })
        void manager?.cancel(id)
        set((s) => {
          const task = s.tasks[id]
          if (!task) return s
          return { tasks: { ...s.tasks, [id]: { ...task, status: 'canceled', speed: 0 } } }
        })
        scheduleSave()
      },

      retry(id) {
        const task = get().tasks[id]
        if (!task) return
        debug.info('store', `Retry ${task.filename}`, { id, previousError: task.error })
        set((s) => ({
          tasks: {
            ...s.tasks,
            [id]: {
              ...task,
              status: 'queued',
              error: null,
              receivedBytes: 0,
              segments: [],
              startedAt: null,
              completedAt: null,
              checksumVerified: null,
              identity: null,
              diagnostics: { ...EMPTY_DIAGNOSTICS },
            },
          },
        }))
        void manager?.retry(id)
        scheduleSave()
      },

      remove(id) {
        const task = get().tasks[id]
        if (!task) return
        debug.info('store', `Remove ${task.filename}`, { id })
        if (isActive(task.status)) void manager?.cancel(id)
        else void manager?.destroy(id)
        if (task.resultUrl) URL.revokeObjectURL(task.resultUrl)
        void handleStore.deleteFile(id)
        set((s) => {
          const tasks = { ...s.tasks }
          delete tasks[id]
          return {
            tasks,
            order: s.order.filter((x) => x !== id),
            selectedId: s.selectedId === id ? null : s.selectedId,
          }
        })
        scheduleSave()
      },

      pauseAll() {
        const { tasks, order } = get()
        for (const id of order) {
          if (isActive(tasks[id]?.status ?? 'completed')) get().pause(id)
        }
      },

      resumeAll() {
        // Queue everything in priority order, FIFO within a priority
        // (plan P1-09 / P3-05). The scheduler enforces concurrency.
        const { tasks, order } = get()
        const ids = [...order].reverse().filter((id) => {
          const status = tasks[id]?.status
          return status === 'paused' || status === 'failed' || status === 'queued'
        })
        ids.sort((a, b) => (tasks[b]!.priority ?? 0) - (tasks[a]!.priority ?? 0) || (tasks[a]!.queuedAt ?? 0) - (tasks[b]!.queuedAt ?? 0))
        for (const id of ids) {
          if (tasks[id]!.status === 'failed') get().retry(id)
          else get().resume(id)
        }
      },

      clearCompleted() {
        const { tasks, order } = get()
        const keep = order.filter((id) => tasks[id]?.status !== 'completed')
        for (const id of order) {
          if (tasks[id]?.status === 'completed') {
            void manager?.destroy(id)
            void handleStore.deleteFile(id)
            const url = tasks[id]?.resultUrl
            if (url) URL.revokeObjectURL(url)
          }
        }
        set((s) => {
          const next: Record<string, DownloadTask> = {}
          for (const id of keep) next[id] = tasks[id]!
          return { tasks: next, order: keep, selectedId: keep.includes(s.selectedId ?? '') ? s.selectedId : null }
        })
        scheduleSave()
      },

      retryFailed() {
        const { tasks, order } = get()
        for (const id of order) {
          if (tasks[id]?.status === 'failed') get().retry(id)
        }
      },

      updateTask(id, patch) {
        set((s) => {
          const task = s.tasks[id]
          if (!task) return s
          return { tasks: { ...s.tasks, [id]: { ...task, ...patch } } }
        })
        scheduleSave()
      },

      setPriority(id, priority) {
        get().updateTask(id, { priority })
        manager?.setPriority(id, priority)
      },

      select(id) {
        set({ selectedId: id })
      },

      setFilter(filter) {
        set({ filter })
      },

      setSearch(search) {
        set({ search })
      },

      setUi(patch) {
        set((s) => ({ ui: { ...s.ui, ...patch } }))
      },

      updateSettings(patch) {
        debug.debug('settings', `Updated ${Object.keys(patch).join(', ')}`, patch)
        set((s) => ({ settings: { ...s.settings, ...patch } }))
        manager?.applySettings(get().settings)
        scheduleSave()
      },

      resetSettings() {
        set({ settings: { ...DEFAULT_SETTINGS, defaultFolderName: null } })
        manager?.applySettings(get().settings)
      },

      pushToast(toast) {
        const level = toast.kind === 'error' ? 'error' : toast.kind === 'warning' ? 'warn' : 'info'
        debug[level]('toast', toast.message ? `${toast.title} — ${toast.message}` : toast.title)
        const id = newId()
        set((s) => ({ toasts: [...s.toasts, { ...toast, id, createdAt: Date.now() }].slice(-4) }))
        const ttl = toast.kind === 'error' ? 9000 : 5000
        setTimeout(() => get().dismissToast(id), ttl)
      },

      dismissToast(id) {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      },

      async chooseFolder() {
        if (!isFsaSupported()) {
          get().pushToast({ kind: 'warning', title: 'Not supported', message: 'This browser cannot remember a folder.' })
          return
        }
        try {
          const dir = await pickDirectory('flux-downloads')
          const ok = await ensureWritePermission(dir)
          if (!ok) {
            get().pushToast({ kind: 'error', title: 'Permission denied', message: `Cannot write to "${dir.name}".` })
            return
          }
          await handleStore.setDirectory(dir)
          set((s) => ({ settings: { ...s.settings, defaultFolderName: dir.name } }))
          get().pushToast({ kind: 'success', title: 'Default folder set', message: dir.name })
        } catch (error) {
          if (!(error instanceof PickerCancelledError)) {
            get().pushToast({
              kind: 'error',
              title: 'Could not open folder',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
      },

      async clearFolder() {
        await handleStore.setDirectory(null)
        await del('flux:dir')
        await del('flux:dir-name')
        set((s) => ({ settings: { ...s.settings, defaultFolderName: null } }))
      },

      async startPicking(id) {
        const task = get().tasks[id]
        if (!task || !isFsaSupported()) return
        set((s) => ({ ui: { ...s.ui, pickingFor: id } }))
        try {
          const dir = await handleStore.getDirectory()
          const handle = await pickSaveFile(task.filename, dir ?? undefined)
          await handleStore.setFile(id, handle)
          set((s) => ({
            ui: { ...s.ui, pickingFor: null },
            tasks: { ...s.tasks, [id]: { ...task, filename: handle.name, handleKey: `file:${id}` } },
          }))
          get().updateTask(id, { handleKey: `file:${id}`, filename: handle.name })
        } catch (error) {
          set((s) => ({ ui: { ...s.ui, pickingFor: null } }))
          if (!(error instanceof PickerCancelledError)) {
            get().pushToast({
              kind: 'error',
              title: 'Could not pick a location',
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }
      },
    }),
    {
      name: 'flux.settings.v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ settings: state.settings }) as unknown as StoreState,
      version: 1,
      // Settings saved by an older build lack newer keys; fill them from defaults.
      merge: (persisted, current) => {
        const saved = (persisted as Partial<StoreState> | undefined)?.settings
        return { ...current, settings: { ...DEFAULT_SETTINGS, ...current.settings, ...(saved ?? {}) } }
      },
    },
  ),
)

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

manager = new DownloadManager({
  getSettings: () => useStore.getState().settings,
  getTask: (id) => useStore.getState().tasks[id],
  emit: (event) => handleManagerEvent(event),
})

export function getManager(): DownloadManager {
  return manager!
}

function handleManagerEvent(event: ManagerEvent): void {
  const store = useStore.getState()
  const task = store.tasks[event.id]
  if (!task) return
  logManagerEvent(event, task)

  switch (event.type) {
    case 'meta': {
      useStore.setState((s) => ({
        tasks: {
          ...s.tasks,
          [event.id]: {
            ...task,
            totalBytes: event.totalBytes ?? task.totalBytes,
            filename: event.filename ?? task.filename,
            mime: event.mime ?? task.mime,
            supportsRanges: event.supportsRanges || task.supportsRanges,
            identity: event.identity,
          },
        },
      }))
      break
    }
    case 'segments': {
      const previous = task.segments
      const merged = event.segments.map((seg, index) => ({ ...(previous[index] ?? seg), ...seg }))
      useStore.setState((s) => ({ tasks: { ...s.tasks, [event.id]: { ...task, segments: merged } } }))
      break
    }
    case 'status': {
      const patch: Partial<DownloadTask> = {
        status: event.status,
        error: event.error ?? null,
        awaitingTarget: Boolean(event.awaitingTarget),
      }
      if (event.status === 'downloading' && !task.startedAt) patch.startedAt = Date.now()
      if (event.status === 'completed') patch.completedAt = Date.now()
      if (event.status === 'failed') patch.terminalFailureCount = (task.terminalFailureCount ?? 0) + 1
      if (event.status === 'paused' || event.status === 'failed' || event.status === 'canceled') patch.speed = 0
      useStore.setState((s) => ({ tasks: { ...s.tasks, [event.id]: { ...task, ...patch } } }))
      if (event.status === 'failed') maybeRetryWithProxy(task, event.error)
      if (event.status === 'completed' || event.status === 'failed' || event.status === 'canceled' || event.status === 'paused') {
        scheduleSave()
      }
      break
    }
    case 'stats': {
      useStore.setState((s) => ({ tasks: { ...s.tasks, [event.id]: { ...task, diagnostics: event.diagnostics } } }))
      break
    }
    case 'progress': {
      useStore.setState((s) => ({ tasks: { ...s.tasks, [event.id]: { ...task, receivedBytes: event.receivedBytes } } }))
      break
    }
    case 'saveMode': {
      useStore.setState((s) => ({ tasks: { ...s.tasks, [event.id]: { ...task, saveMode: event.mode } } }))
      if (event.mode === 'memory' && (task.totalBytes ?? 0) > MEMORY_WARN_LIMIT) {
        store.pushToast({
          kind: 'warning',
          title: 'Buffering in memory',
          message: 'This browser cannot stream to disk, so the file is being held in RAM.',
        })
      }
      break
    }
    case 'complete': {
      const patch: Partial<DownloadTask> = {
        status: 'completed',
        completedAt: Date.now(),
        receivedBytes: event.size || task.receivedBytes,
        saveMode: event.saveMode,
        resultUrl: event.url ?? null,
        checksumVerified: event.checksum ? event.checksum.verified : null,
        speed: 0,
        segments: task.segments.map((s) => ({ ...s, status: 'done' as const, speed: 0 })),
      }
      useStore.setState((s) => ({ tasks: { ...s.tasks, [event.id]: { ...task, ...patch } } }))

      const settings = useStore.getState().settings
      if (settings.notifyOnComplete) {
        const actions: Toast['action'] = event.url
          ? { label: 'Save file', run: () => triggerDownload(event.url!, event.filename) }
          : undefined
        useStore.getState().pushToast({
          kind: 'success',
          title: 'Download complete',
          message: event.filename,
          action: actions,
        })
      }
      if (event.url && settings.autoOpenFile) triggerDownload(event.url, event.filename)

      if (settings.removeOnComplete) {
        setTimeout(() => {
          const current = useStore.getState().tasks[event.id]
          if (current?.status === 'completed') useStore.getState().remove(event.id)
        }, 4000)
      }
      void handleStore.deleteFile(event.id)
      scheduleSave()
      break
    }
  }
}

function logManagerEvent(event: ManagerEvent, task: DownloadTask): void {
  const name = task.filename
  switch (event.type) {
    case 'progress':
      return // far too chatty; the details panel shows live progress
    case 'status': {
      const level = event.status === 'failed' ? 'error' : 'info'
      debug[level]('engine', `${name}: ${task.status} → ${event.status}${event.error ? ` (${event.error})` : ''}`, { id: event.id })
      return
    }
    case 'meta':
      debug.debug('engine', `${name}: probed`, { id: event.id, totalBytes: event.totalBytes, mime: event.mime, filename: event.filename, supportsRanges: event.supportsRanges })
      return
    case 'segments': {
      // Only report connections that just started failing, not every update.
      const failing = event.segments.filter((s, i) => (s.status === 'retrying' || s.status === 'error') && task.segments[i]?.status !== s.status)
      if (event.segments.length !== task.segments.length) {
        debug.debug('engine', `${name}: ${event.segments.length} segment(s) planned`, event.segments.map((s) => ({ index: s.index, start: s.start, end: s.end })))
      } else if (failing.length) {
        debug.warn('engine', `${name}: ${failing.length} connection(s) retrying`, failing.map((s) => ({ index: s.index, status: s.status, attempts: s.attempts })))
      }
      return
    }
    case 'saveMode':
      debug.info('engine', `${name}: saving via ${event.mode}`, { id: event.id })
      return
    case 'stats':
      return
    case 'complete':
      debug.info('engine', `${name}: complete (${event.size} bytes via ${event.saveMode})`, { id: event.id })
      return
  }
}

/** Cross-origin fetches fail with an opaque CORS error; a proxy often fixes it. */
function maybeRetryWithProxy(task: DownloadTask, error?: string | null): void {
  if (!resolver.shouldRetryViaProxy(error, task.proxyUsed)) return
  const request = resolver.resolveViaProxy({ url: task.url, auth: task.auth, headers: task.headers })
  useStore.setState((s) => ({
    tasks: {
      ...s.tasks,
      [task.id]: {
        ...s.tasks[task.id]!,
        effectiveUrl: request.url,
        proxyUsed: true,
        status: 'queued',
        error: null,
        receivedBytes: 0,
        segments: [],
        identity: null,
      },
    },
  }))
  useStore.getState().pushToast({
    kind: 'info',
    title: 'Retrying through the CORS proxy',
    message: request.exposesCredentials
      ? 'The direct request was blocked. Note: your credentials will pass through the proxy.'
      : 'The direct request was blocked by the browser.',
  })
  manager?.destroy(task.id)
  const updated = useStore.getState().tasks[task.id]
  if (updated) {
    void manager?.checkpoints.remove(task.id)
    manager?.createRunner(updated)
    manager?.enqueue(task.id)
  }
}

function triggerDownload(url: string, filename: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

const TASKS_KEY = 'flux.tasks.v1'

/** Older persisted tasks lack newer fields; `retries` was renamed. */
type PersistedTask = DownloadTask & { retries?: number }

export function normalizeTask(t: PersistedTask): DownloadTask {
  const { retries, ...rest } = t
  return {
    ...rest,
    speedHistory: t.speedHistory ?? [],
    segments: t.segments ?? [],
    headers: t.headers ?? [],
    terminalFailureCount: t.terminalFailureCount ?? retries ?? 0,
    priority: t.priority ?? 0,
    queuedAt: t.queuedAt ?? t.createdAt ?? 0,
    expectedChecksum: t.expectedChecksum ?? null,
    checksumVerified: t.checksumVerified ?? null,
    identity: t.identity ?? null,
    diagnostics: { ...EMPTY_DIAGNOSTICS, ...(t.diagnostics ?? {}) },
  }
}

/**
 * Brings one persisted task back after a reload (plan P0-03 / P0-10).
 *
 * Nothing keeps downloading across a reload, so active work is frozen as
 * `paused` — except a browser stream, whose download already died with the
 * page: that becomes `failed`. Partial progress is only kept when a valid
 * checkpoint exists *and* its bytes are durable (a file handle we still
 * have); otherwise progress is reset rather than displayed as resumable.
 */
export async function restoreTask(
  task: DownloadTask,
  onCheckpoint: (checkpoint: DownloadCheckpoint) => void,
  onCorrupt: () => void,
): Promise<DownloadTask> {
  const wasActive = isActive(task.status)
  const restored: DownloadTask = {
    ...task,
    speed: 0,
    speedHistory: [],
    awaitingTarget: false,
    resultUrl: null,
    segments: task.segments.map((s) => ({ ...s, status: s.status === 'done' ? ('done' as const) : ('idle' as const), speed: 0 })),
  }
  if (task.handleKey && !(await handleStore.getFile(task.id))) {
    restored.handleKey = null
    restored.saveMode = null
  }
  if (task.status === 'completed' || task.status === 'canceled') return restored

  if (wasActive && task.saveMode === 'stream' && task.status !== 'queued') {
    restored.status = 'failed'
    restored.error = 'The browser download stream was interrupted by the reload. Retry to start over.'
  } else if (wasActive) {
    // P3-05: keep `queued` as queued so queue order survives a reload.
    // Only truly active downloads (downloading/probing/pausing/...) become
    // paused and need a user gesture to resume.
    if (task.status === 'queued') restored.status = 'queued'
    else restored.status = 'paused'
  }

  let checkpoint: DownloadCheckpoint | null = null
  try {
    checkpoint = (await manager?.checkpoints.load(task.id)) ?? null
  } catch (error) {
    debug.warn('store', `Discarding unreadable checkpoint for ${task.filename}`, { id: task.id, error: String(error) })
    await manager?.checkpoints.remove(task.id).catch(() => undefined)
    onCorrupt()
  }

  const usable = checkpoint != null && checkpoint.saveMode === 'fsa' && restored.handleKey != null && restored.status === 'paused'
  if (usable) {
    onCheckpoint(checkpoint!)
    restored.receivedBytes = checkpoint!.bytesWritten
    restored.totalBytes = checkpoint!.resource.totalBytes ?? restored.totalBytes
    restored.identity = checkpoint!.resource
    restored.supportsRanges = checkpoint!.supportsRanges
  } else {
    if (checkpoint) await manager?.checkpoints.remove(task.id).catch(() => undefined)
    restored.receivedBytes = 0
    restored.segments = []
  }
  return restored
}

async function loadTasks(): Promise<DownloadTask[] | null> {
  try {
    const raw = await get<PersistedTask[]>(TASKS_KEY)
    if (!raw || !Array.isArray(raw)) return null
    return raw
      .filter((t) => t && typeof t.id === 'string' && typeof t.url === 'string')
      .map(normalizeTask)
  } catch {
    return null
  }
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    void saveTasks()
  }, 800)
}

async function saveTasks(): Promise<void> {
  const { tasks, order } = useStore.getState()
  const payload: DownloadTask[] = order
    .map((id) => tasks[id])
    .filter(Boolean)
    .map((task) => ({
      ...task,
      speedHistory: [],
      speed: 0,
      resultUrl: null,
      awaitingTarget: false,
      segments: task.segments.map((s) => ({ ...s, speed: 0 })),
    }))
  try {
    await set(TASKS_KEY, payload)
  } catch {
    /* storage may be full or unavailable — never block the UI */
  }
}

// ---------------------------------------------------------------------------
// ticker
// ---------------------------------------------------------------------------

let ticker: ReturnType<typeof setInterval> | null = null

function startTicker(): void {
  if (ticker) return
  lastSample = { at: Date.now(), bytes: {} }
  ticker = setInterval(() => {
    useStore.getState().tick()
  }, SAMPLE_INTERVAL)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function countActive(segments: SegmentState[]): number {
  return Math.max(1, segments.filter((s) => s.status === 'active' || s.status === 'retrying').length)
}

export type { AuthConfig, HeaderEntry }
export { getSinkCapabilities }
