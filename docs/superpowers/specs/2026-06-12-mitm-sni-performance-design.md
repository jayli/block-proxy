# MITM SNI Performance Design

## Overview

Improve the hot path of HTTPS MITM handshakes while keeping the change small and low risk. This design covers only the agreed P0/P1 scope: cache SNI `SecureContext` objects and clean stale socket references in the CONNECT bookkeeping maps.

It intentionally does not worker-ize first-time certificate generation. That path is still expensive, but changing it requires deeper changes to `node-easy-cert` synchronous APIs, filesystem writes, and error propagation.

## Requirements

1. **Avoid repeated SNI certificate work** — repeated TLS handshakes for the same hostname should not reread certificate files or recreate `SecureContext`.
2. **Keep memory bounded** — the SNI context cache must have a maximum size and deterministic eviction.
3. **Preserve MITM behavior** — certificate selection, ALPN settings, WebSocket handling, and HTTPS request flow must remain unchanged.
4. **Clean stale socket references** — `conns` and `cltSockets` should delete entries when the sockets they track close.
5. **Avoid new dependencies** — implement simple LRU behavior with native `Map`.

## Non-Goals

- Moving certificate generation to worker threads.
- Changing TLS session cache settings for `_httpsAgent`.
- Refactoring AnyProxy request routing.
- Optimizing response buffering, throttle streams, regex compilation, or URL parsing.

## Current Behavior

In this checkout, `node_modules/@bachi/anyproxy` is a symlink to the local AnyProxy fork at `/Users/bachi/jaylli/anyproxy`. The implementation should be made and committed in that fork, not by committing ignored `node_modules` files from `block-proxy`.

`/Users/bachi/jaylli/anyproxy/lib/httpsServerMgr.js` creates one shared SNI HTTPS server for normal domain names. Every SNI callback calls `certMgr.getCertificate(serverName, ...)`, then creates a new `SecureContext` from the returned key and certificate.

For existing certificates, `node-easy-cert` still reads key and cert files synchronously. For first-time hostnames, it synchronously generates and writes a certificate. The first-time generation cost remains out of scope for this change, but repeated hostnames can be made much cheaper by caching the resulting `SecureContext`.

`/Users/bachi/jaylli/anyproxy/lib/requestHandler.js` stores CONNECT-side sockets in `reqHandlerCtx.conns` and `reqHandlerCtx.cltSockets`. These maps are used to recover the original client IP for HTTPS MITM requests. Entries are overwritten but not explicitly removed on socket close.

## Architecture

### SNI SecureContext LRU Cache

Add a small cache inside `createHttpsSNIServer()`:

```text
serverName -> tls.SecureContext
```

The cache is scoped to the HTTPS SNI server, which matches the existing architecture: normal domain MITM traffic shares one SNI server, while IP-host MITM uses a direct certificate server path.

On each `SNIPrepareCert(serverName, SNICallback)`:

1. Normalize the hostname enough to make cache keys stable: lowercase string form.
2. Check the cache.
3. If found, refresh its LRU position and call `SNICallback(null, ctx)`.
4. If missing, run the existing certificate lookup and `createSecureContext()` flow.
5. Store the new context in the cache.
6. If the cache exceeds the configured limit, evict the oldest key.

The default limit should be `1000` hostnames. This is large enough for normal browsing sessions and bounded enough for long-running routers.

### Socket Map Cleanup

After `reqHandlerCtx.conns.set(key, conn)` and `reqHandlerCtx.cltSockets.set(key, cltSocket)`, register close cleanup handlers:

```text
conn close      -> delete conns[key] only if conns[key] is this conn
cltSocket close -> delete cltSockets[key] only if cltSockets[key] is this cltSocket
```

The identity check matters because the same key may be overwritten by a newer CONNECT tunnel before the older socket emits `close`. Cleanup must not delete the newer entry.

Use a small idempotent helper so duplicate close/error sequences cannot cause inconsistent cleanup.

## Data Flow

### HTTPS MITM Handshake

```text
Client CONNECT host:443
  -> requestHandler chooses shared local SNI server
  -> client starts TLS to local SNI server
  -> SNICallback(serverName)
     -> SecureContext cache hit: return cached context
     -> cache miss: certMgr.getCertificate + createSecureContext + cache set
  -> AnyProxy handles decrypted HTTP request
  -> fetchRemoteResponse forwards upstream with existing keep-alive agent
```

### CONNECT Socket Tracking

```text
CONNECT tunnel established
  -> key = serverInfo.host + ":" + serverInfo.port
  -> conns[key] = local target socket
  -> cltSockets[key] = client socket
  -> close handlers delete only matching map entries
```

## Error Handling

- If `certMgr.getCertificate()` fails, preserve the existing error log and `SNICallback(err)` behavior.
- If `createSecureContext()` throws, preserve the existing error path.
- Cache insertion happens only after successful `createSecureContext()`.
- Socket cleanup must never throw. Delete operations should be guarded by map identity checks.

## Testing Strategy

Add focused Node tests for the new behavior instead of relying only on the existing proxy integration suite.

1. **LRU cache unit test**
   - Same hostname returns the cached value.
   - Inserting past the limit evicts the oldest hostname.
   - Re-reading a hostname refreshes its LRU position.

2. **SNI cache behavior test**
   - Stub `certMgr.getCertificate()` and `tls.createSecureContext()`.
   - Trigger SNI preparation twice for the same hostname.
   - Verify certificate lookup and context creation happen once.

3. **Socket cleanup behavior test**
   - Populate maps with a socket pair.
   - Emit close on the tracked socket.
   - Verify the map entry is removed.
   - Overwrite the key with a newer socket, close the old socket, and verify the newer entry remains.

4. **Integration smoke**
   - Run the existing proxy test entry after implementation:
     `npm run test:proxy -- --skip-external`

## File Changes

| File | Change |
|------|--------|
| `/Users/bachi/jaylli/anyproxy/lib/httpsServerMgr.js` | Add bounded LRU cache for SNI `SecureContext` objects |
| `/Users/bachi/jaylli/anyproxy/lib/requestHandler.js` | Add identity-safe cleanup for `conns` and `cltSockets` |
| `/Users/bachi/jaylli/anyproxy/test/lib/httpsServerMgr.spec.js` | Add focused Jest coverage for SNI context cache behavior |
| `/Users/bachi/jaylli/anyproxy/test/lib/requestHandlerSocketCleanup.spec.js` | New focused Jest coverage for socket map cleanup |

## Risks

- `block-proxy/node_modules/@bachi/anyproxy` is ignored by git and currently symlinked to `/Users/bachi/jaylli/anyproxy`. Implementers must commit the code in the AnyProxy fork. If a future environment uses the npm package instead of the symlink, the fix must be published as a new `@bachi/anyproxy` version or carried as a package patch.
- If a hostname certificate is regenerated while the process runs, the cache will continue serving the old `SecureContext` until eviction or restart. This is acceptable because certificates are normally stable for the lifetime of the root CA.
- Cache size tuning is approximate. The default of `1000` favors practical browsing performance while keeping memory bounded.

## Review

Automatic subagent review was not run because the available subagent tool is restricted to explicit user-requested delegation. This document should be reviewed manually before implementation.
