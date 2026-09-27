/**
 * Structured engine errors (plan P2-06).
 *
 * Integrity problems must never be reported as a generic `Error`: the retry
 * policy, the store and the UI all branch on *what kind* of failure happened.
 */

export class DownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadError'
  }
}

/** The bytes we received are not the bytes we asked for. */
export class DownloadIntegrityError extends DownloadError {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadIntegrityError'
  }
}

/** A 206 described (or implied) a different range than requested. */
export class RangeMismatchError extends DownloadIntegrityError {
  constructor(message: string) {
    super(message)
    this.name = 'RangeMismatchError'
  }
}

/** The body ended before (or ran past) the length the headers promised. */
export class BodyLengthError extends DownloadIntegrityError {
  constructor(
    message: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(message)
    this.name = 'BodyLengthError'
  }
}

/** The completed file does not match the checksum the user supplied. */
export class ChecksumMismatchError extends DownloadIntegrityError {
  constructor(
    readonly algorithm: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`${algorithm.toUpperCase()} mismatch: expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…`)
    this.name = 'ChecksumMismatchError'
  }
}

/**
 * The remote representation is no longer the one our partial data came from
 * (ETag / Last-Modified / size changed). Resuming would splice two different
 * files together, so the download must restart from zero.
 */
export class ResourceChangedError extends DownloadError {
  constructor(message = 'The remote file changed since the download started') {
    super(message)
    this.name = 'ResourceChangedError'
  }
}

/** Persisted resume state is unreadable, inconsistent or from an unknown version. */
export class CheckpointError extends DownloadError {
  constructor(message: string) {
    super(message)
    this.name = 'CheckpointError'
  }
}

export class CheckpointVersionError extends CheckpointError {
  constructor(readonly version: unknown) {
    super(`Unsupported checkpoint version: ${String(version)}`)
    this.name = 'CheckpointVersionError'
  }
}

/** A MemorySink would exceed its configured hard cap. */
export class MemoryLimitError extends DownloadError {
  constructor(readonly limit: number) {
    super(`In-memory downloads are limited to ${Math.round(limit / 1024 / 1024)} MB. Choose "Pick file" as the save method for larger files.`)
    this.name = 'MemoryLimitError'
  }
}
