# CONNECT Half-Close Cleanup Design

## Goal

Release orphaned CONNECT upstream socket file descriptors when the downstream
client has fully closed, without truncating data that is still flowing in the
opposite direction after a normal TCP half-close.

## Scope

The change covers only the raw CONNECT relay in
`proxy/proxy-core/request-handler.js`. Production FD diagnostics attribute the
leaks to its outbound `net.connect()` sockets, not to SOCKS5 or HTTP
keep-alive agents. It does not change proxy limits or timeout durations.

## Connection Semantics

A received `end` is a normal TCP half-close, not an error. The existing pipes
must continue forwarding the reverse direction until it drains. A full
downstream `close` is terminal: Node removes the `conn.pipe(cltSocket)` pipe,
but does not close `conn`; an upstream FIN then remains unread in the kernel as
`CLOSE_WAIT`. The relay must destroy that orphaned upstream socket.

## CONNECT Relay

`cltSocket` and `conn` continue to use the existing `pipe()` calls, preserving
backpressure and normal data forwarding. Before an upstream connection is
available, record whether `cltSocket` has closed. When it closes, destroy an
already-attached `conn`; when an asynchronous `customConnect` later resolves,
destroy its returned socket instead of attaching it. Do not act on
`cltSocket`'s `end` event.

## Tests

Add regressions for a downstream full close after attachment and before an
asynchronous `customConnect` resolves. Add a half-close regression proving an
upstream response remains deliverable after downstream `end`. Existing CONNECT,
MITM, SOCKS5, and FD diagnostics suites remain required.
