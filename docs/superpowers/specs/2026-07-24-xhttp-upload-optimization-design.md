# xhttp Upload Optimization Design

Date: 2026-07-24

## Scope

This design covers only the Android client xhttp transport and the Node tunnel server. It does not change macOS, iOS, proxy-core request handling, routing, MITM, admin UI, or non-tunnel behavior.

The tunnel remains packet-up: Android sends upstream data through bounded HTTP POST requests. This design does not introduce a long-lived streaming upload POST.

## Goals

- Reduce upstream POST overhead for LLM-style small, frequent client-to-server frames.
- Keep four Android upload workers.
- Improve HTTP/1.1 connection reuse through CDN paths.
- Add multi-frame POST batching without hurting first-token latency.
- Add optional HTTP/2 support with automatic HTTP/1.1 fallback.
- Preserve existing clients and servers through capability negotiation.
- Keep the transport friendly to Cloudflare CDN and Alibaba Cloud CDN.

## Non-Goals

- No true stream-up long POST body.
- No WebSocket reintroduction.
- No changes to reverse tunnel frame semantics.
- No change to the frame wire format for individual frames.
- No mandatory HTTP/2 requirement.
- No source-wide refactor outside Android tunnel and Node tunnel server files.

## Current State

Android currently uses `XhttpUploadScheduler` with four upload workers. Each worker sends one encoded tunnel frame per `POST /xhttp/upload/:sessionId/:seq`.

The OkHttp transport currently pins HTTP/1.1 and uses `ConnectionPool(0, 1ms)`, which effectively disables idle connection reuse. The native uTLS POST client already reuses one HTTP/1.1 connection, but serializes access through a mutex.

The Node tunnel server uses `https.createServer` and handles HTTP/1.1 requests. `XhttpHandler._handleUpload()` reads one POST body and pushes it into `UploadQueue`. The consume loop decodes the payload as a single frame.

## CDN Constraints

Cloudflare and Alibaba Cloud CDN are expected tunnel paths. The upload path should therefore avoid assumptions that CDN edges will stream request bodies to origin in real time.

The design keeps fixed-size POST requests with `Content-Length`. It avoids chunked long upload streams, keeps body sizes small, and keeps cache-bypass headers on xhttp routes.

CDN route requirements:

- `/xhttp/create` bypasses cache.
- `/xhttp/upload/*` bypasses cache.
- `/xhttp/stream` bypasses cache and keeps SSE buffering disabled where supported.
- Upload POST bodies use `Content-Length`, not chunked transfer.
- SSE keepalive stays below common CDN idle/read timeout windows.

## Capability Negotiation

Add two upload capabilities to the existing AUTH/CAPABILITIES flow:

- `upload-batch-v1`
- `upload-h2-v1`

The Android client advertises capabilities it can use. The Node server returns only capabilities enabled and supported for that session.

Behavior:

- If `upload-batch-v1` is not negotiated, Android keeps the current one-frame-per-POST behavior.
- If `upload-batch-v1` is negotiated, Android may send one or more encoded frames in a single upload POST body.
- If `upload-h2-v1` is negotiated and the client successfully establishes HTTP/2, Android may use h2 for create/upload/stream requests.
- h2 failure always falls back to HTTP/1.1 without requiring server-side session state changes.
- Batch and h2 are independent. Valid modes are h1 single-frame, h1 batch, h2 single-frame, and h2 batch.

## Phase 1: HTTP/1.1 Connection Reuse

Update the Android OkHttp xhttp client factory:

- Keep `DEFAULT_MAX_CONCURRENT_POSTS = 4`.
- Replace the disabled connection pool with a small reusable pool, initially `ConnectionPool(4, 60s)`.
- Keep `connectTimeout(10s)`, `readTimeout(0)`, and `writeTimeout(0)` unless testing shows a CDN-specific issue.
- Keep `Proxy.NO_PROXY` and `ProtectedSocketFactory` behavior unchanged.
- Keep upload request bodies as fixed byte arrays so OkHttp sends `Content-Length`.

The native uTLS POST path remains HTTP/1.1 in this phase. It already reuses one connection and retries once after closing a broken connection. A native four-connection pool is not part of this design because it adds more TLS fingerprint and connection-lifecycle risk. It can be evaluated later if upload worker concurrency is shown to be ineffective on native uTLS.

## Phase 2: Multi-Frame Upload Batching

Add a batching layer to Android upload scheduling while preserving the existing priority model.

Default flush thresholds:

- Time: 10 ms
- Body size: 16 KiB
- Frame count: 32

Flush rules:

- CONTROL frames flush immediately.
- CONNECT and CLOSE frames flush immediately.
- DATA frames may batch until one threshold fires.
- PADDING frames may batch with DATA when padding is negotiated.
- Closing the transport flushes queued frames before shutdown where possible.

Batch body format:

- A batch body is the byte concatenation of one or more existing encoded frames.
- Each frame already has a 2-byte length prefix.
- A legacy single-frame POST is also a valid batch of one frame.

Sequence semantics:

- `seq` remains attached to the upload POST.
- A batch consumes one `seq`, regardless of the number of frames inside.
- `UploadQueue` continues to reorder POST bodies by `seq`.
- Frames inside one batch are delivered in body order.

Server behavior:

- `_handleUpload()` continues to read the full POST body and enqueue it by `seq`.
- The upload consume loop decodes one or more frames from each queued body.
- If body parsing finds trailing bytes, an incomplete frame, or an oversized frame, the server logs a malformed batch event and drops the remaining frames in that POST body.
- A malformed batch does not close the session by default. Repeated malformed batches may close the session if a configurable error threshold is exceeded.

Backpressure:

- Existing bounded queues remain in place.
- Batch formation must not bypass the current backpressure behavior. If queues are full, producers still suspend rather than dropping tunnel bytes.
- Batch wait time is capped by the flush timer so LLM token latency remains bounded.

## Phase 3: Optional HTTP/2

HTTP/2 is an enhancement, not a required transport.

Node server:

- Replace or wrap `https.createServer` with `http2.createSecureServer({ allowHTTP1: true })`.
- Route both HTTP/1.1 and HTTP/2 request objects through a small adapter into `XhttpHandler`.
- Avoid HTTP/1.1-only response headers on h2 responses. In particular, do not emit `connection: keep-alive` on h2.
- Record `req.httpVersion` for tunnel diagnostics.

Android:

- Add an h2-enabled OkHttp mode with `protocols(listOf(Protocol.HTTP_2, Protocol.HTTP_1_1))`.
- Use h2 mode only when `upload-h2-v1` is negotiated and the client configuration enables h2.
- If create, stream, or upload fails due to protocol negotiation, CDN behavior, or server response, rebuild the session with HTTP/1.1 mode.
- Native uTLS remains HTTP/1.1 fallback in this design.

CDN behavior:

- Cloudflare deployments can benefit from h2 edge-to-origin when origin h2 is enabled and stable.
- Alibaba Cloud CDN support must be validated in deployment because edge-to-origin behavior and timeout handling can vary by product configuration.
- If h2 causes 5xx, stream instability, or upload retry spikes, disable h2 while keeping batch POST enabled over h1.

## Configuration

Initial implementation can use conservative constants. Optional config keys may be added later if field testing needs tuning.

Recommended defaults:

- `tunnel_upload_batch_enabled`: true for Android sessions that negotiate support.
- `tunnel_upload_batch_flush_ms`: 10
- `tunnel_upload_batch_max_bytes`: 16384
- `tunnel_upload_batch_max_frames`: 32
- `tunnel_upload_h2_enabled`: false initially, then enabled after CDN validation.
- `tunnel_upload_connection_pool_size`: 4
- `tunnel_upload_connection_keepalive_seconds`: 60

The first implementation may keep h2 behind an Android-side developer flag while Node support is being validated.

## Error Handling

- Upload POST failure returns `false` to the sender, preserving current behavior.
- Batch upload failure fails all frames in that batch as one unit.
- If a batch POST is retried, the same POST `seq` and body must be retried together.
- Server duplicate `seq` behavior remains idempotent: already-consumed POST bodies are ignored.
- Server queue overflow still returns 503 and may close the upload queue.
- h2 fallback creates a new xhttp session instead of mutating an active session in place.

## Observability

Add diagnostics on Android:

- `upload.protocol`: `h1` or `h2`
- `upload.batch.frames`
- `upload.batch.bytes`
- `upload.batch.flush_reason`: `time`, `bytes`, `count`, `control`, `close`
- `upload.rtt_ms`
- `upload.fallback_reason`

Add diagnostics on Node:

- `xhttp.upload.http_version`
- `xhttp.upload.batch_frames`
- `xhttp.upload.batch_bytes`
- `xhttp.upload.malformed_batch`
- `xhttp.upload.queue_overflow`

Logs should avoid frame payload contents.

## Test Plan

Node tests:

- Legacy single-frame POST still decodes and delivers one frame.
- Batch POST with multiple DATA frames delivers all frames in body order.
- Multiple batch POSTs arriving out of order are delivered by POST seq order.
- Malformed batch records an error and does not corrupt later valid POSTs.
- HTTP/2 server accepts create, upload, and stream routes.
- HTTP/1.1 still works when served by the h2 server with `allowHTTP1`.

Android tests:

- Connection pool settings keep four upload workers and nonzero idle reuse.
- Batch flushes by time.
- Batch flushes by max bytes.
- Batch flushes by max frame count.
- CONTROL, CONNECT, and CLOSE frames flush immediately.
- Batch is disabled when `upload-batch-v1` is not negotiated.
- h2 mode falls back to h1 after protocol failure.

Integration tests:

- Android client through direct origin with h1 batch.
- Android client through Cloudflare with h1 batch.
- Android client through Alibaba Cloud CDN with h1 batch.
- Optional Cloudflare h2 path with h2 enabled.
- SSE stream remains stable while LLM-style upstream tokens are sent for several minutes.

## Rollout

1. Land HTTP/1.1 connection pool reuse.
2. Land server multi-frame decode while keeping clients unchanged.
3. Land Android batch upload behind negotiated `upload-batch-v1`.
4. Enable batch by default for Android after direct-origin and CDN validation.
5. Land Node h2 server support with `allowHTTP1`.
6. Land Android h2 mode behind `upload-h2-v1` and a disabled-by-default flag.
7. Enable h2 only after CDN-specific soak testing.

## Open Risks

- Some CDN configurations may buffer, rewrite, or time out SSE despite correct headers.
- h2 edge-to-origin behavior can differ from client-to-CDN h2 behavior.
- Native uTLS remains serialized on one connection, so OkHttp may show higher upload concurrency than native uTLS.
- Batch retry semantics treat several frames as one retry unit, which is acceptable for ordered tunnel delivery but should be verified under packet loss.
