# Download Manager — Modification / Hardening Plan

> The plan below is kept verbatim. See **[Implementation status](#implementation-status)**
> at the end of this file for what has been done in the codebase.

```text
DOWNLOAD MANAGER
MODIFICATION / HARDENING PLAN
========================================

PURPOSE
-------
This document lists the modifications I recommend for the current
download-manager implementation, with examples of how I would implement
each change.

The goal is NOT to rewrite the application.

The existing architecture is good and should be evolved:

    React UI
        |
        v
    Zustand Store
        |
        v
    DownloadManager
        |
        v
    TaskRunner
        |
        +-- HTTP / Range Transport
        +-- Retry Policy
        +-- Rate Limiter
        +-- Write Queue
        |
        v
    Sink
        +-- FsaSink
        +-- StreamSink
        +-- MemorySink

The primary weakness is that the persistence/resume model is not yet as
rigorous as the download engine.

Priority levels:

    P0 = correctness / data integrity
    P1 = important architecture / lifecycle
    P2 = robustness / maintainability
    P3 = future improvements


======================================================================
P0-01: IMPLEMENT STRICT CONTENT-RANGE VALIDATION
======================================================================

CURRENT PROBLEM
---------------
A ranged request such as:

    Range: bytes=1000000-1999999

must return something like:

    HTTP/1.1 206 Partial Content
    Content-Range: bytes 1000000-1999999/5000000

The downloader should not blindly trust that the response contains
the bytes that were requested.

A bad server, proxy, cache, CDN, or intermediary could theoretically
return a different range.

RECOMMENDED CHANGE
------------------
Create a dedicated Content-Range parser.

Example:

    interface ContentRange {
        start: number;
        end: number;
        total: number | null;
    }

    function parseContentRange(value: string): ContentRange {
        const match =
            /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value.trim());

        if (!match) {
            throw new DownloadIntegrityError(
                "Invalid Content-Range header"
            );
        }

        return {
            start: Number(match[1]),
            end: Number(match[2]),
            total:
                match[3] === "*"
                    ? null
                    : Number(match[3])
        };
    }

Then validate it against the requested range:

    function validateRangeResponse(
        requestedStart: number,
        requestedEnd: number,
        range: ContentRange
    ): void {
        if (range.start !== requestedStart) {
            throw new DownloadIntegrityError(
                `Expected range ${requestedStart}, ` +
                `received ${range.start}`
            );
        }

        if (range.end > requestedEnd) {
            throw new DownloadIntegrityError(
                "Server returned bytes outside requested range"
            );
        }
    }

DO THIS FOR EVERY 206 RESPONSE.


======================================================================
P0-02: VALIDATE RESPONSE BODY LENGTH
======================================================================

CURRENT PROBLEM
---------------
Even if Content-Range is correct, the actual response body may be
shorter or longer than expected.

Example:

    Requested:
        bytes=0-999999

    Content-Range:
        bytes 0-999999/5000000

    Actual body:
        800000 bytes

That should not silently become a successful segment.

RECOMMENDED CHANGE
------------------

Track:

    expectedBytes
    actualBytes

For a complete response:

    expectedBytes = range.end - range.start + 1

At completion:

    if (actualBytes !== expectedBytes) {
        throw new DownloadIntegrityError(
            "Response body length does not match Content-Range"
        );
    }

For the final partial response, allow the actual final range to be
smaller only when Content-Range explicitly says so.

Never infer correctness from Content-Length alone.


======================================================================
P0-03: FIX HTTP 416 HANDLING
======================================================================

CURRENT PROBLEM
---------------
A 416 response currently risks being interpreted as:

    "This segment is already complete."

That isn't necessarily true.

A server can return:

    HTTP 416 Range Not Satisfiable
    Content-Range: bytes */800000

while the downloader believes the resource is:

    1000000 bytes

That means the resource changed.

RECOMMENDED CHANGE
------------------

Parse:

    Content-Range: bytes */<total>

Example:

    if (response.status === 416) {
        const total = parse416Total(
            response.headers.get("Content-Range")
        );

        if (
            expectedTotal !== null &&
            total !== null &&
            total !== expectedTotal
        ) {
            throw new ResourceChangedError(
                "Remote resource size changed"
            );
        }

        /*
         * Only consider the segment complete when
         * the server's resource identity is still
         * compatible with the checkpoint.
         */
    }


======================================================================
P0-04: ADD RESOURCE IDENTITY
======================================================================

CURRENT PROBLEM
---------------
A URL does not necessarily identify a specific file version.

Example:

    https://example.com/latest.zip

Monday:

    ETag: "abc"

Tuesday:

    ETag: "def"

Resuming Tuesday's resource using Monday's partial file can produce:

    OLD FILE DATA
          +
    NEW FILE DATA
          =
    CORRUPTED FILE


RECOMMENDED CHANGE
------------------

Add:

    interface ResourceIdentity {
        etag: string | null;
        lastModified: string | null;
        totalBytes: number | null;
        contentType: string | null;
    }

Store it in the download checkpoint.

Example:

    interface DownloadCheckpoint {
        version: 1;

        resource: ResourceIdentity;

        bytesReceived: number;

        segments: SegmentCheckpoint[];
    }


======================================================================
P0-05: USE IF-RANGE WHEN RESUMING
======================================================================

Once ETag or Last-Modified is known, use it when resuming.

Example:

    If-Range: "abc123"

or:

    If-Range: Wed, 23 Sep 2026 12:00:00 GMT

This allows the server to say, effectively:

    "Yes, this is still the same representation."

If it changed, the downloader must NOT blindly append new data to the
old file.


======================================================================
P0-06: PERSIST SEGMENT CHECKPOINTS
======================================================================

CURRENT PROBLEM
---------------
The current implementation primarily persists aggregate progress:

    receivedBytes

That isn't enough for segmented downloading.

Example:

    Segment 0 -> COMPLETE
    Segment 1 -> COMPLETE
    Segment 2 -> 50%
    Segment 3 -> NOT STARTED

Persisting only:

    receivedBytes = 75%

does not tell the engine WHICH 75% exists.

RECOMMENDED CHANGE
------------------

Persist:

    interface SegmentCheckpoint {
        index: number;
        start: number;
        end: number;
        received: number;
        status: SegmentStatus;
        attempts: number;
    }

Example persisted state:

    {
        "version": 1,
        "bytesReceived": 393216000,
        "segments": [
            {
                "index": 0,
                "start": 0,
                "end": 131071999,
                "received": 131072000,
                "status": "complete"
            },
            {
                "index": 1,
                "start": 131072000,
                "end": 262143999,
                "received": 131072000,
                "status": "complete"
            },
            {
                "index": 2,
                "start": 262144000,
                "end": 393215999,
                "received": 131072000,
                "status": "complete"
            }
        ]
    }

This becomes the canonical resume state.


======================================================================
P0-07: RESUME FROM SEGMENTS, NOT A SINGLE BYTE OFFSET
======================================================================

CURRENT PROBLEM
---------------
The current conceptual model is approximately:

    resumeFrom = receivedBytes

That assumes progress is contiguous.

Segmented downloading makes that assumption invalid.

Example:

    Segment 0 = complete
    Segment 1 = incomplete
    Segment 2 = complete
    Segment 3 = incomplete

The completed data isn't necessarily one contiguous prefix.

RECOMMENDED CHANGE
------------------

On resume:

    for each segment:
        if segment.status == COMPLETE:
            skip it

        else:
            calculate remaining range

Example:

    original:
        1000000-1999999

    received:
        1000000-1499999

    resume request:
        Range: bytes=1500000-1999999


======================================================================
P0-08: SEPARATE NETWORK BYTES FROM DURABLE BYTES
======================================================================

CURRENT PROBLEM
---------------
These are currently too easy to treat as the same thing:

    received from network
    queued for writing
    actually written
    durably checkpointed

They are not equivalent.

RECOMMENDED MODEL
-----------------

    NETWORK
       |
       v
    RECEIVED
       |
       v
    QUEUED
       |
       v
    WRITTEN
       |
       v
    CHECKPOINTED

Only checkpointed data should be considered safely resumable.

Example:

    networkReceived += chunk.length

should NOT necessarily mean:

    checkpoint.received += chunk.length

Instead:

    await writeQueue.write(...)

    checkpoint.received += writtenBytes

    await checkpointStore.save(...)


======================================================================
P0-09: ADD CRASH-RECOVERY TEST
======================================================================

Create a test that simulates:

    1. Start download
    2. Download 40%
    3. Persist checkpoint
    4. Destroy TaskRunner
    5. Create a NEW TaskRunner
    6. Restore checkpoint
    7. Resume
    8. Verify final file

Pseudo-test:

    const first = createRunner(task);

    await first.downloadUntil(40);

    const checkpoint =
        await first.createCheckpoint();

    first.destroy();

    const second =
        createRunner(task, checkpoint);

    await second.resume();

    expect(await readFinalFile())
        .toEqual(originalData);


======================================================================
P0-10: ADD RANGE INVARIANT TESTS
======================================================================

Test that segment creation always produces:

    no gaps
    no overlaps
    correct first byte
    correct last byte

Example:

    segments = buildSegments(
        totalBytes,
        connectionCount
    );

    expect(segments[0].start).toBe(0);

    for (let i = 1; i < segments.length; i++) {
        expect(segments[i].start)
            .toBe(segments[i - 1].end + 1);
    }

    expect(
        segments.at(-1)!.end
    ).toBe(totalBytes - 1);


======================================================================
P1-01: ADD AN EXPLICIT "PAUSING" STATE
======================================================================

CURRENT PROBLEM
---------------
Pause currently looks conceptually like:

    user clicks pause
        |
        +--> UI immediately says "paused"
        |
        +--> engine stops asynchronously

That creates a race.

RECOMMENDED STATE FLOW
----------------------

    DOWNLOADING
        |
        v
    PAUSING
        |
        +--> stop network
        +--> drain WriteQueue
        +--> checkpoint sink
        +--> persist checkpoint
        |
        v
    PAUSED

Add:

    "pausing"

to DownloadStatus.


======================================================================
P1-02: MAKE THE ENGINE THE AUTHORITY FOR STATUS
======================================================================

CURRENT PROBLEM
---------------
The Zustand store can optimistically change status while the engine
is still performing the requested operation.

This creates two potential sources of truth:

    Zustand
    TaskRunner

RECOMMENDED FLOW
----------------

    UI
     |
     v
    Store
     |
     v
    DownloadManager
     |
     v
    TaskRunner
     |
     v
    emits "paused"
     |
     v
    Store updates UI


The store should request actions, not declare their completion.

Instead of:

    set({ status: "paused" });
    manager.pause(id);

prefer:

    await manager.pause(id);

and let the engine emit:

    PAUSING
    PAUSED


======================================================================
P1-03: MAKE PAUSE FULLY ASYNCHRONOUS
======================================================================

Recommended API:

    async pause(id: string): Promise<void>

Inside:

    runner.requestPause();

    await runner.waitForWorkers();

    await runner.drainWrites();

    const checkpoint =
        await runner.createCheckpoint();

    await checkpointStore.save(checkpoint);

    runner.emitStatus("paused");


This creates a reliable persistence boundary.


======================================================================
P1-04: INTRODUCE A DOWNLOAD STATE MACHINE
======================================================================

The project already has an implicit state machine.

Make it explicit.

Example:

    type DownloadStatus =
        | "queued"
        | "probing"
        | "downloading"
        | "pausing"
        | "paused"
        | "retrying"
        | "finalizing"
        | "completed"
        | "failed"
        | "cancelled";

Define valid transitions.

Example:

    const transitions = {
        queued: ["probing", "cancelled"],

        probing: [
            "downloading",
            "retrying",
            "failed",
            "cancelled"
        ],

        downloading: [
            "pausing",
            "retrying",
            "finalizing",
            "failed",
            "cancelled"
        ],

        pausing: [
            "paused",
            "failed"
        ],

        paused: [
            "downloading",
            "cancelled"
        ],

        finalizing: [
            "completed",
            "failed"
        ]
    };


======================================================================
P1-05: SPLIT DOWNLOAD TASK INTO SMALLER MODELS
======================================================================

CURRENT PROBLEM
---------------
DownloadTask is becoming responsible for too many concerns.

Instead of one large object:

    DownloadTask

split it into:

    Download
    DownloadSource
    DownloadTarget
    DownloadPolicy
    DownloadCheckpoint
    DownloadTelemetry

Example:

    interface Download {
        id: string;
        source: DownloadSource;
        target: DownloadTarget;
        policy: DownloadPolicy;
        status: DownloadStatus;
        checkpoint: DownloadCheckpoint;
        createdAt: number;
    }

    interface DownloadSource {
        url: string;
        headers: HeaderEntry[];
        auth: AuthConfig;
    }

    interface DownloadTarget {
        filename: string;
        mime: string;
        saveMode: SaveMode;
        handleKey: string | null;
    }

    interface DownloadPolicy {
        connections: number;
        maxRetries: number;
        speedLimit: number | null;
    }


======================================================================
P1-06: SEPARATE TELEMETRY FROM DURABLE STATE
======================================================================

Do not persist unnecessary high-frequency values such as:

    speed history
    instantaneous speed
    temporary worker state

Separate:

    DownloadCheckpoint

from:

    DownloadTelemetry

Example:

    interface DownloadTelemetry {
        receivedBytes: number;
        speed: number;
        peakSpeed: number;
        activeSegments: number;
    }

Telemetry can be destroyed and rebuilt.

Checkpoint data cannot.


======================================================================
P1-07: CREATE A DEDICATED CHECKPOINT STORE
======================================================================

Instead of allowing persistence logic to spread through the engine,
create:

    interface CheckpointStore {
        save(
            id: string,
            checkpoint: DownloadCheckpoint
        ): Promise<void>;

        load(
            id: string
        ): Promise<DownloadCheckpoint | null>;

        remove(
            id: string
        ): Promise<void>;
    }

Then:

    TaskRunner
        |
        v
    CheckpointStore

This will also make crash-recovery tests much easier.


======================================================================
P1-08: CREATE A DOWNLOAD SCHEDULER
======================================================================

CURRENT PROBLEM
---------------
The current manager relies heavily on pumping the queue when certain
events occur.

This works, but an explicit scheduler is cleaner.

Recommended:

    DownloadManager
        |
        +-- DownloadScheduler
        |
        +-- TaskRunner instances
        |
        +-- GlobalRateLimiter

Scheduler:

    class DownloadScheduler {
        private queue: string[] = [];
        private active = new Set<string>();
        private maxConcurrent = 3;

        enqueue(id: string): void;
        cancel(id: string): void;
        completed(id: string): void;
        pump(): void;
    }

This gives the scheduler clear ownership of:

    queued
    active
    concurrency
    dispatch


======================================================================
P1-09: ADD PRIORITY SUPPORT TO THE SCHEDULER
======================================================================

Once a scheduler exists, support:

    priority: number

Example:

    {
        id: "game.iso",
        priority: 100
    }

    {
        id: "backup.zip",
        priority: 10
    }

The scheduler chooses the highest-priority eligible task.

This should be implemented at the scheduler level, not in React.


======================================================================
P1-10: ADD PER-HOST CONNECTION LIMITS
======================================================================

Current possibility:

    Download A = 8 connections
    Download B = 8 connections
    Download C = 8 connections

Potentially:

    24 connections to one host

Add:

    globalLimit
    perDownloadLimit
    perHostLimit

Example:

    scheduler.setLimits({
        global: 32,
        perDownload: 8,
        perHost: 8
    });

Host accounting:

    example.com -> 8
    cdn.example.com -> 4
    another.com -> 8


======================================================================
P1-11: IMPROVE RETRY CLASSIFICATION
======================================================================

Instead of simply deciding:

    retry / don't retry

introduce:

    RetryDecision

Example:

    type RetryDecision =
        | {
            type: "retry";
            delayMs: number;
          }
        | {
            type: "fallback";
          }
        | {
            type: "fatal";
          }
        | {
            type: "resource-changed";
          };


Examples:

    429
        -> retry after Retry-After

    500
        -> exponential backoff

    401
        -> fatal

    network failure
        -> retry

    changed ETag
        -> resource-changed


======================================================================
P1-12: HONOR RETRY-AFTER
======================================================================

If the server responds:

    HTTP/1.1 429 Too Many Requests
    Retry-After: 30

do not immediately retry.

Instead:

    await delay(30_000);

Then retry.

Support both forms:

    Retry-After: 30

and HTTP-date values.


======================================================================
P2-01: MOVE CORS PROXY LOGIC OUT OF ZUSTAND
======================================================================

CORS/proxy resolution is networking logic.

Move it out of the store.

Create:

    RequestResolver

Example:

    interface ResolvedRequest {
        url: string;
        headers: Headers;
        proxyUsed: boolean;
    }

    class RequestResolver {
        resolve(
            source: DownloadSource
        ): ResolvedRequest {
            ...
        }
    }

The Zustand store should not need to understand the details of
network fallback.


======================================================================
P2-02: WARN WHEN AUTHENTICATION HEADERS GO THROUGH A PROXY
======================================================================

If the user has:

    Authorization: Bearer SECRET

and a proxy is being used, explicitly tell the user:

    WARNING:
    Authentication headers may be sent to the configured
    CORS proxy.

This should be especially obvious when:

    proxy mode = always


======================================================================
P2-03: ADD A HARD MEMORY LIMIT TO MEMORYSINK
======================================================================

The current warning threshold is not a real limit.

A browser can still continue allocating memory.

Add:

    const MAX_MEMORY_DOWNLOAD =
        512 * 1024 * 1024;

Before accepting another chunk:

    if (
        this.totalBuffered +
        chunk.byteLength >
        MAX_MEMORY_DOWNLOAD
    ) {
        throw new DownloadError(
            "Memory download limit exceeded"
        );
    }

The exact limit should probably be configurable.


======================================================================
P2-04: STRENGTHEN STREAMSINK FINALIZATION
======================================================================

Before closing StreamSink:

    if (this.nextOffset !== this.size) {
        throw new DownloadIntegrityError(
            "Stream finished before expected size"
        );
    }

Also verify:

    parked.size === 0

Final invariant:

    nextOffset === expectedSize
    parked.size === 0


======================================================================
P2-05: IMPROVE STREAMSINK LIFECYCLE HANDLING
======================================================================

The service worker keeps streams in:

    Map<string, ...>

This is fine for an active stream, but service workers can be
terminated by the browser.

Do not try to make the stream itself persistent.

Instead:

    StreamSink
        = non-resumable browser transport

    FsaSink
        = durable resumable transport

The UI should clearly distinguish the two.

If a StreamSink dies:

    FAILED

not:

    PAUSED


======================================================================
P2-06: ADD DOWNLOAD INTEGRITY ERRORS
======================================================================

Do not use generic Error for important corruption conditions.

Create:

    class DownloadIntegrityError
        extends Error

    class ResourceChangedError
        extends Error

    class RangeMismatchError
        extends DownloadIntegrityError

    class CheckpointError
        extends Error

This makes error handling and UI messaging much cleaner.


======================================================================
P2-07: SEPARATE HTTP TRANSPORT FROM TASKRUNNER
======================================================================

TaskRunner currently has knowledge of too many HTTP details.

Eventually create:

    HttpTransport

Example:

    interface HttpTransport {
        probe(
            request: HttpRequest
        ): Promise<HttpProbeResult>;

        fetchRange(
            request: RangeRequest
        ): Promise<RangeResponse>;
    }

TaskRunner then becomes responsible for:

    scheduling
    segments
    retries
    state

rather than low-level HTTP parsing.


======================================================================
P2-08: CREATE A RESOURCE PROBER
======================================================================

Create:

    ResourceProbe

Responsibilities:

    HEAD
    GET fallback
    Content-Length
    Accept-Ranges
    ETag
    Last-Modified
    Content-Type
    range capability

Example result:

    interface ResourceInfo {
        size: number | null;
        acceptsRanges: boolean;
        etag: string | null;
        lastModified: string | null;
        contentType: string | null;
    }


======================================================================
P2-09: ADD PROPERTY-BASED RANGE TESTING
======================================================================

Do not test only:

    1000 bytes / 4 connections

Generate many random combinations.

Example:

    for (let i = 0; i < 10000; i++) {
        const size = randomSize();
        const connections = randomConnections();

        const segments =
            buildSegments(size, connections);

        assertCoverage(segments, size);
    }

Assertions:

    first.start === 0

    each next.start =
        previous.end + 1

    final.end =
        size - 1

    no overlaps

    no gaps


======================================================================
P2-10: ADD NETWORK FAILURE TESTING
======================================================================

Create a programmable test HTTP server that can simulate:

    connection reset
    timeout
    429
    500
    502
    503
    504
    malformed Content-Range
    short body
    incorrect Content-Length
    416
    changed ETag

Example:

    testServer.failRange({
        start: 1000000,
        error: "connection-reset",
        times: 2
    });

Then verify retry behavior.


======================================================================
P2-11: TEST CONCURRENT DOWNLOAD SCHEDULING
======================================================================

Test:

    maxConcurrent = 1

with:

    A
    B
    C

Expected:

    A starts
    B waits
    C waits

    A completes
    B starts

    B completes
    C starts

Also test:

    A active
    B queued
    C queued

    cancel A

Expected:

    B starts immediately


======================================================================
P2-12: TEST GLOBAL RATE LIMITING
======================================================================

Test multiple workers sharing one limiter.

Example:

    globalLimit = 1 MB/s

    worker A = 500 KB/s
    worker B = 500 KB/s

Total should remain approximately:

    1 MB/s

rather than:

    1 MB/s per worker


======================================================================
P2-13: MAKE SEGMENT ATTEMPTS AND TASK RETRIES DISTINCT
======================================================================

Use clearer names.

Instead of:

    attempts
    retries

use:

    segmentAttempts
    automaticRetryCount
    terminalFailureCount

This prevents telemetry and UI from confusing:

    "this segment has been attempted 4 times"

with:

    "this download has failed 4 times."


======================================================================
P2-14: ADD EXPLICIT FINALIZATION PHASE
======================================================================

Currently completion can conceptually happen immediately after the
last network operation.

Make it:

    DOWNLOADING
        |
        v
    VERIFYING
        |
        v
    FINALIZING
        |
        v
    COMPLETED

This provides a place for future:

    checksum verification
    file-size validation
    metadata validation
    atomic rename


======================================================================
P2-15: ADD CHECKSUM SUPPORT
======================================================================

Future enhancement:

    SHA-256
    SHA-1
    MD5

Prefer SHA-256.

Example:

    expectedChecksum: {
        algorithm: "sha256",
        value: "..."
    }

After download:

    calculate SHA-256

    if mismatch:
        FAILED / INTEGRITY_ERROR

This should happen during FINALIZING.


======================================================================
P3-01: ADAPTIVE CONNECTION COUNT
======================================================================

Instead of permanently using:

    8 connections

allow the engine to learn.

Example:

    start = 2

    measure throughput

    if throughput improves:
        2 -> 4

    if improves again:
        4 -> 8

    if no improvement:
        remain at 8

    if server starts returning 429:
        reduce connections


======================================================================
P3-02: HOST HEALTH TRACKING
======================================================================

Track:

    latency
    failures
    throughput
    429 rate
    connection resets

Example:

    HostStats {
        host: "example.com",
        averageLatency: 120,
        throughput: 8_500_000,
        failures: 2,
        rateLimited: false
    }


======================================================================
P3-03: DOWNLOAD PRIORITY
======================================================================

Expose:

    priority

in the UI.

Example:

    Critical
    High
    Normal
    Low

The scheduler decides execution order.

Do not implement this as:

    React array sorting

It belongs in DownloadScheduler.


======================================================================
P3-04: ETA CALCULATION
======================================================================

Base ETA on smoothed throughput.

Avoid:

    remaining / instantaneousSpeed

because instantaneous speed is noisy.

Use an exponential moving average:

    smoothedSpeed =
        alpha * currentSpeed +
        (1 - alpha) * previousSpeed;

Then:

    ETA =
        remainingBytes /
        smoothedSpeed;


======================================================================
P3-05: PERSIST QUEUE ORDER
======================================================================

When the browser reloads, restore:

    queued downloads
    priority
    order
    paused downloads
    completed history

Do not depend on the order in which IndexedDB happens to return
records.


======================================================================
P3-06: ADD VERSIONED CHECKPOINT MIGRATIONS
======================================================================

Checkpoint format should contain:

    version: 1

Future format:

    version: 2

Migration:

    function migrateCheckpoint(
        checkpoint: unknown
    ): DownloadCheckpoint {
        switch (checkpoint.version) {
            case 1:
                return migrateV1(checkpoint);

            case 2:
                return checkpoint;

            default:
                throw new CheckpointVersionError();
        }
    }


======================================================================
P3-07: ADD CHECKPOINT CORRUPTION RECOVERY
======================================================================

If persisted state is corrupt:

    do NOT crash the entire application.

Instead:

    mark task as recovery-required

or:

    safely discard invalid checkpoint

Example UI:

    "Download state could not be restored.
     The download must be restarted."


======================================================================
P3-08: ADD OBSERVABILITY
======================================================================

Add structured internal events.

Example:

    download.probe.start
    download.probe.complete
    download.segment.start
    download.segment.retry
    download.segment.complete
    download.pause.requested
    download.checkpoint.saved
    download.resume
    download.integrity.failure
    download.complete

This will make debugging difficult network problems much easier.


======================================================================
P3-09: ADD DEBUG LOGGING THAT CAN BE DISABLED
======================================================================

Use:

    logger.debug(...)
    logger.info(...)
    logger.warn(...)
    logger.error(...)

rather than scattered:

    console.log(...)

Allow:

    debug = false

in production.

This will be particularly useful when debugging:

    segment scheduling
    retries
    resume
    range mismatches


======================================================================
P3-10: ADD A DOWNLOAD ENGINE DIAGNOSTICS VIEW
======================================================================

Since the engine already tracks segments, expose an optional developer
view:

    Download
    -----------------------------
    Status: Downloading
    Speed: 82.4 MB/s
    Connections: 8
    Host: example.com

    Segment 0   ██████████ 100%
    Segment 1   ██████████ 100%
    Segment 2   ███████░░░  74%
    Segment 3   █████░░░░░  51%

    Retries: 1
    HTTP errors: 0
    Range errors: 0

This would make troubleshooting significantly easier.


======================================================================
TESTING PLAN
======================================================================

Before considering the engine production-ready, add these test groups:

    01. RangePlanner tests
        - normal sizes
        - odd sizes
        - 1 connection
        - many connections
        - tiny files

    02. ContentRange tests
        - valid 206
        - invalid start
        - invalid end
        - invalid total
        - malformed header

    03. Resume tests
        - pause
        - persist
        - destroy
        - recreate
        - resume

    04. Resource identity tests
        - same ETag
        - changed ETag
        - changed Last-Modified
        - changed size

    05. HTTP failure tests
        - timeout
        - connection reset
        - 429
        - 500
        - 503
        - 416
        - malformed response

    06. Sink tests
        - sequential writes
        - out-of-order writes
        - overlapping writes
        - gaps
        - finalization

    07. Scheduler tests
        - concurrency
        - cancellation
        - queue ordering
        - priority
        - per-host limits

    08. RateLimiter tests
        - single worker
        - multiple workers
        - dynamic rate changes
        - unlimited mode

    09. Crash recovery
        - checkpoint
        - reload
        - resume
        - final integrity

    10. Property tests
        - random segment layouts
        - random sizes
        - random connection counts


======================================================================
RECOMMENDED IMPLEMENTATION ORDER
======================================================================

PHASE 1
-------
DOWNLOAD INTEGRITY

    [ ] Content-Range parser
    [ ] Strict 206 validation
    [ ] Response-size validation
    [ ] Correct 416 handling
    [ ] DownloadIntegrityError
    [ ] ResourceChangedError


PHASE 2
-------
RESOURCE IDENTITY

    [ ] ETag
    [ ] Last-Modified
    [ ] ResourceIdentity
    [ ] If-Range
    [ ] Resource-change detection


PHASE 3
-------
REAL RESUME SUPPORT

    [ ] DownloadCheckpoint
    [ ] SegmentCheckpoint
    [ ] CheckpointStore
    [ ] Persist segment state
    [ ] Resume individual incomplete ranges
    [ ] Crash recovery tests


PHASE 4
-------
LIFECYCLE

    [ ] PAUSING state
    [ ] Engine-owned status
    [ ] Async pause
    [ ] Drain WriteQueue
    [ ] Checkpoint before PAUSED
    [ ] Explicit FINALIZING state


PHASE 5
-------
NETWORK ROBUSTNESS

    [ ] RetryDecision
    [ ] Retry-After
    [ ] Resource-change handling
    [ ] HTTP transport abstraction
    [ ] ResourceProbe


PHASE 6
-------
SCHEDULING

    [ ] DownloadScheduler
    [ ] Global concurrency
    [ ] Per-download concurrency
    [ ] Per-host concurrency
    [ ] Priority
    [ ] Queue persistence


PHASE 7
-------
ARCHITECTURAL CLEANUP

    [ ] Split DownloadTask
    [ ] Separate telemetry
    [ ] Move proxy logic out of Zustand
    [ ] Dedicated HTTP transport
    [ ] Dedicated checkpoint store
    [ ] State machine


PHASE 8
-------
HARDENING

    [ ] MemorySink hard limit
    [ ] StreamSink final invariants
    [ ] Structured errors
    [ ] Structured logging
    [ ] Diagnostics


PHASE 9
-------
ADVANCED ENGINE

    [ ] Adaptive connection count
    [ ] Host health
    [ ] SHA-256 verification
    [ ] ETA smoothing
    [ ] Advanced telemetry
    [ ] Developer diagnostics


======================================================================
WHAT I WOULD NOT CHANGE
======================================================================

DO NOT rewrite the entire project.

Keep:

    [x] TypeScript
    [x] React
    [x] Vite
    [x] Zustand
    [x] TaskRunner concept
    [x] DownloadManager concept
    [x] Sink abstraction
    [x] FsaSink
    [x] StreamSink
    [x] MemorySink
    [x] WriteQueue
    [x] RateLimiter
    [x] Dynamic range segmentation
    [x] Existing UI architecture

The current architecture is fundamentally sound.

The major improvement is to make the engine's state and persistence
model as rigorous as the networking implementation.


======================================================================
TARGET ARCHITECTURE
======================================================================

                         React UI
                            |
                            v
                     Zustand Store
                            |
                            v
                    DownloadManager
                            |
              +-------------+-------------+
              |                           |
              v                           v
      DownloadScheduler            Global RateLimiter
              |
              v
         TaskRunner
              |
      +-------+-------+
      |       |       |
      v       v       v
   Probe   HTTP    Retry
              |
              v
        RangePlanner
              |
              v
          Workers
              |
              v
         WriteQueue
              |
              v
             Sink
        +-----+-----+
        |     |     |
        v     v     v
       FSA  Stream Memory


Persistence:

    Download
        |
        +-- DownloadCheckpoint
        |       |
        |       +-- ResourceIdentity
        |       +-- SegmentCheckpoint[]
        |       +-- bytesWritten
        |
        v
    CheckpointStore


The critical invariant should become:

    NETWORK DATA
        !=
    WRITTEN DATA
        !=
    CHECKPOINTED DATA

And the resume invariant should become:

    Every byte considered "complete" MUST be backed by
    a verified persisted segment checkpoint.

The final file should only become COMPLETED after:

    all segments complete
        +
    expected byte count matches
        +
    sink finalization succeeds
        +
    optional checksum verification succeeds


======================================================================
END STATE
======================================================================

The ultimate goal should be:

    QUEUED
       |
       v
    PROBING
       |
       v
    PLANNING
       |
       v
    DOWNLOADING
       |
       +----> PAUSING
       |          |
       |          v
       |        CHECKPOINT
       |          |
       |          v
       |        PAUSED
       |          |
       |          +---- RESUME
       |                   |
       |                   v
       |             RESOURCE VALIDATION
       |                   |
       |                   v
       |              DOWNLOADING
       |
       +----> RETRYING
       |
       +----> FAILED
       |
       v
    VERIFYING
       |
       v
    FINALIZING
       |
       v
    COMPLETED


This gives the application a much stronger foundation without
discarding the architecture that is already working well.
```

---

## Implementation status

Status of this plan in the codebase (branch `arena/01a0e0f4-download-manager`).
✅ done · 🟡 partial · ⬜ not started. Tests live in
`src/lib/engine/hardening.test.ts` (units, properties),
`src/lib/engine/faults.test.ts` (end-to-end against a fault-injecting server),
`src/lib/engine/engine.test.ts`, `src/store/restore.test.ts` and
`src/lib/requestResolver.test.ts`.

### P0 — correctness

- ✅ **P0-01 Strict Content-Range validation.** `engine/contentRange.ts`; every 206 is checked for start, end and total before any byte is written. If Content-Range isn't CORS-exposed, only Content-Length is checked and the range is flagged *unverified* in diagnostics.
- ✅ **P0-02 Body length validation.** Short bodies raise `BodyLengthError` and the remainder is re-requested. Excess bytes are never written past the credited range.
- ✅ **P0-03 416 handling.** A 416 counts as complete only when the start is past a *known, unchanged* total. A different total is treated as resource changed; an in-file 416 is an error.
- ✅ **P0-04 Resource identity.** `ResourceIdentity` (ETag, Last-Modified, size, type) is locked on first response and checked on every later response and on resume.
- ✅ **P0-05 If-Range.** Sent on resumed and continued ranges (strong ETag, else Last-Modified). A 200 in reply means the resource changed. If a CORS preflight rejects If-Range, it is disabled for that run.
- ✅ **P0-06 Segment checkpoints.** `engine/checkpoint.ts` and `engine/checkpointStore.ts` (IndexedDB, versioned). Written on pause for durable sinks only, after `sink.checkpoint()` has flushed.
  - *Limitation:* there are no periodic checkpoints while running, because FSA only commits on close. A crash keeps the last pause checkpoint.
- ✅ **P0-07 Resume from segments.** `TaskRunner` is restored from the checkpoint's segment map, not from a byte offset.
- ✅ **P0-08 Network vs durable bytes.** `segment.received` advances only on sink acknowledgement (contiguous watermark per segment). Network position is tracked separately for splitting.
- ✅ **P0-09 Crash-recovery test.** `faults.test.ts › durable checkpoints` covers pause, checkpoint, `dispose()` (simulated crash), a fresh runner and a byte-exact result. A replaced file fails instead of being spliced.
- ✅ **P0-10 Range invariant tests.** Covers coverage verification before finalize, checkpoint tiling validation, fault-server tests, and hydration rules (`restore.test.ts`).

### P1 — lifecycle and scheduling

- ✅ **P1-01 `pausing` state.** Also added `verifying`.
- ✅ **P1-02 Engine is the status authority.** The store only sets `queued` (scheduling) and optimistic `paused` when no runner is live. Everything else comes from runner events.
- ✅ **P1-03 Fully async pause.** Pause aborts, awaits workers, drains the write queue, checkpoints, then reports `paused`. Workers never block on a drain while pausing.
- ✅ **P1-04 State machine.** `engine/stateMachine.ts`; invalid transitions are logged, and tests assert valid sequences.
- 🟡 **P1-05 Split DownloadTask.** Identity and diagnostics are separate sub-objects; the task itself is still one record.
- ✅ **P1-06 Telemetry vs durable state.** Speed, history and diagnostics are never used for resume; the checkpoint is the only resume source.
- ✅ **P1-07 Checkpoint store.**
- ✅ **P1-08 Scheduler.** `engine/scheduler.ts`, owned by `DownloadManager`; resume and retry go through the queue.
- ✅ **P1-09 Priority.** Low, Normal, High and Critical, available in the Add dialog and the Details panel.
- ✅ **P1-10 Per-host connection limits.** `engine/connectionPool.ts` (per host and global); configurable in Settings.
- ✅ **P1-11 Retry classification.** `engine/retryPolicy.ts` returns retry, fallback, fatal, resource-changed or aborted.
- ✅ **P1-12 Retry-After.** Supports delta-seconds and HTTP-date forms, capped at 5 minutes.

### P2 — structure, sinks, testing

- ✅ **P2-01 Proxy logic out of Zustand.** `lib/requestResolver.ts`.
- ✅ **P2-02 Credential/proxy warning.** A toast appears when auth or credential-like headers will pass through the proxy.
- ✅ **P2-03 MemorySink hard limit.** `MemoryLimitError`; the limit is configurable (default 512 MB).
- ✅ **P2-04 StreamSink finalization.** Checks that all bytes were pushed, nothing is parked, and the checksum matches; otherwise it aborts instead of closing.
  - Duplicate or misaligned retransmissions are merged instead of stalling or failing, which was found by the property test.
- 🟡 **P2-05 StreamSink lifecycle.** A stream interrupted by a reload is shown as *failed* (it can't be resumed). There is no service-worker heartbeat.
- ✅ **P2-06 Integrity errors.** `engine/errors.ts`.
- ✅ **P2-07 HTTP transport.** `engine/transport.ts` (`HttpTransport`, injectable).
- 🟡 **P2-08 Resource prober.** Lives in `transport.probe()`, not a separate class.
- ✅ **P2-09 Property-based tests.** Seeded random segment tiling, and random chunking, order and duplicates through StreamSink and WriteQueue.
- ✅ **P2-10 Network failure tests.** The shared test server injects short bodies, bad ranges, overflow, 503 with Retry-After, 416, ETag changes and size changes.
- ✅ **P2-11 Concurrent scheduling tests.**
- ✅ **P2-12 Global rate limiting test.**
- ✅ **P2-13 Attempts vs task retries.** `diagnostics.automaticRetryCount` and `terminalFailureCount`; the old `retries` field is migrated.
- ✅ **P2-14 Explicit finalization.** The sequence is `verifying`, then `finalizing`, then `completed`.
- ✅ **P2-15 Checksum support.** SHA-256 is computed incrementally for stream downloads and read back from the file for FSA and memory. A mismatch fails the download.

### P3 — improvements

- ⬜ **P3-01 Adaptive connection count.**
- ⬜ **P3-02 Host health tracking.**
- ✅ **P3-03 Download priority.**
- ⬜ **P3-04 ETA improvements.** The existing smoothed ETA is unchanged.
- 🟡 **P3-05 Persist queue order.** `queuedAt` and priority are persisted and Resume all restores the order. Queued items come back paused after a reload, because file permissions need a user gesture.
- ✅ **P3-06 Versioned checkpoint migrations.**
- ✅ **P3-07 Checkpoint corruption recovery.** An invalid checkpoint is discarded, the download restarts from 0, and a toast explains it.
- ✅ **P3-08 Observability.** `engine/events.ts` structured events feed the debug console.
- ✅ **P3-09 Toggleable debug logging.** This comes from the earlier debug-mode work.
- ✅ **P3-10 Diagnostics view.** The Details panel has an *Integrity* section: checksum, validator, If-Range, range verification, retry and error counts, and last checkpoint.
