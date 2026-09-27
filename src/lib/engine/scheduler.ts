/**
 * Download scheduler (plan P1-08, P1-09, P3-03).
 *
 * Owns *which* downloads run: the queue, the active set, the concurrency cap
 * and priority ordering. It never touches the network — the manager asks it
 * what to dispatch and tells it when a slot frees up.
 *
 * Ordering: highest priority first; FIFO (by enqueue time) within a priority.
 */

export interface SchedulerLimits {
  /** Downloads allowed to run at once. */
  maxConcurrent: number
}

export interface EnqueueOptions {
  priority?: number
  /** Explicit FIFO key (e.g. a persisted `queuedAt`); defaults to enqueue order. */
  sequence?: number
}

interface QueueEntry {
  id: string
  priority: number
  sequence: number
}

export class DownloadScheduler {
  private queue = new Map<string, QueueEntry>()
  private active = new Set<string>()
  private limits: SchedulerLimits
  private nextSequence = 0

  constructor(limits: SchedulerLimits = { maxConcurrent: 3 }) {
    this.limits = { ...limits }
  }

  setLimits(limits: Partial<SchedulerLimits>): void {
    this.limits = { ...this.limits, ...limits }
  }

  getLimits(): SchedulerLimits {
    return { ...this.limits }
  }

  /** Adds a download to the queue (no-op if it is already queued or running). */
  enqueue(id: string, options: EnqueueOptions = {}): void {
    if (this.active.has(id)) return
    const existing = this.queue.get(id)
    const sequence = options.sequence ?? existing?.sequence ?? this.nextSequence++
    if (options.sequence != null) this.nextSequence = Math.max(this.nextSequence, options.sequence + 1)
    this.queue.set(id, { id, priority: options.priority ?? existing?.priority ?? 0, sequence })
  }

  setPriority(id: string, priority: number): void {
    const entry = this.queue.get(id)
    if (entry) entry.priority = priority
  }

  /** Removes a download from both the queue and the active set (pause, cancel, remove). */
  cancel(id: string): void {
    this.queue.delete(id)
    this.active.delete(id)
  }

  /** Frees the slot held by a download that finished, failed or paused. */
  completed(id: string): void {
    this.active.delete(id)
  }

  /** Marks a download as running outside of `pump()` (e.g. a direct start). */
  markActive(id: string): void {
    this.queue.delete(id)
    this.active.add(id)
  }

  isActive(id: string): boolean {
    return this.active.has(id)
  }

  isQueued(id: string): boolean {
    return this.queue.has(id)
  }

  activeCount(): number {
    return this.active.size
  }

  /** Queued ids in dispatch order. */
  queued(): string[] {
    return [...this.queue.values()].sort(compareEntries).map((e) => e.id)
  }

  /**
   * Moves as many queued downloads to active as the limits allow and returns
   * them; the caller is responsible for actually starting each one.
   */
  pump(): string[] {
    const started: string[] = []
    const limit = Math.max(1, this.limits.maxConcurrent)
    if (this.active.size >= limit) return started
    for (const entry of [...this.queue.values()].sort(compareEntries)) {
      if (this.active.size >= limit) break
      this.queue.delete(entry.id)
      this.active.add(entry.id)
      started.push(entry.id)
    }
    return started
  }
}

function compareEntries(a: QueueEntry, b: QueueEntry): number {
  return b.priority - a.priority || a.sequence - b.sequence
}

/** UI-facing priority levels (plan P3-03). */
export const PRIORITY_LEVELS = [
  { value: -10, label: 'Low' },
  { value: 0, label: 'Normal' },
  { value: 10, label: 'High' },
  { value: 20, label: 'Critical' },
] as const
