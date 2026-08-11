# FD Diagnostics Design

## Goal

Make a single log snapshot sufficient to attribute process FD growth without changing proxy forwarding behaviour.

## Design

The SOCKS5 server will count sockets during handshake separately from completed TCP CONNECT tunnels. Its periodic statistics line will include `handshaking`, `udp`, and a supplied FD diagnostic snapshot.

A small diagnostics module will count `/proc/self/fd` entries by Linux descriptor target type and summarise HTTP/HTTPS agents by active, free, and queued sockets. It returns safe zero/unknown values on non-Linux hosts, preserving macOS development and tests.

`proxy/proxy.js` will pass its two outbound keep-alive agents to the diagnostics reporter. The reporter will run on the existing five-minute SOCKS5 cadence, so it adds no new timers in production.

## Scope

- No deployment, configuration migration, or behaviour change to forwarding.
- No credentials, remote endpoints, or individual client addresses in diagnostics.
- Logs use aggregate counts and the largest agent origin buckets only.
