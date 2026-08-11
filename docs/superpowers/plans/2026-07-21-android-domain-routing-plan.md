# Android Domain Routing Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Android client domain-based routing rules such as `geosite:cn` work for ordinary TUN/tun2socks TCP traffic by recovering domain names before route selection.

**Architecture:** Implement this in two optional phases. Phase 1 adds TCP first-payload sniffing for TLS SNI and HTTP Host on IP-only SOCKS5 CONNECT requests, then routes using the recovered domain. Phase 2, if approved later, adds VPN DNS capture and fake DNS to provide complete domain recovery through `DomainMappingStore`.

**Tech Stack:** Kotlin, Coroutines, Android VpnService, tun2socks, local SOCKS5, Xray geosite assets, existing `RoutingEngine`, existing xhttp tunnel and Forward CONNECT.

---

## Scope

This plan is intentionally split into two phases:

- Phase 1 is the recommended first implementation. It is client-only, TCP-only, and does not change the tunnel protocol.
- Phase 2 is a future complete solution. Do not implement it unless the design is separately approved after Phase 1 review or testing.

## Global Constraints

- Do not modify server tunnel protocol in Phase 1.
- Do not modify `ReverseConnectHandler` behavior.
- Do not change reqid ranges.
- Do not capture DNS in Phase 1.
- Do not MITM or decrypt TLS.
- Do not drop sniffed payload bytes. Any bytes read for sniffing must be replayed to the selected upstream path.
- Do not allow sniffing to wait indefinitely. Use a bounded timeout and bounded buffer.
- If sniffing fails, route with current fallback behavior: default DIRECT when routing is enabled.
- Keep Android app tunnel sockets excluded from VPN using current `addDisallowedApplication` and `protect()` behavior.
- Tests must be written before implementation changes.
- Commit only after user approval, following project rules.

## Files

### Phase 1 New Files

- Create: `android-client/app/src/main/java/com/blockproxy/android/socks/TrafficSniffer.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/socks/TlsClientHelloParser.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/socks/HttpHostParser.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/TrafficSnifferTest.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/TlsClientHelloParserTest.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/HttpHostParserTest.kt`

### Phase 1 Modified Files

- Modify: `android-client/app/src/main/java/com/blockproxy/android/socks/SocksSession.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/socks/LocalSocksServer.kt`
- Modify: `android-client/app/src/test/java/com/blockproxy/android/socks/LocalSocksServerTest.kt`
- Optionally modify: `android-client/app/src/main/java/com/blockproxy/android/routing/RoutingEngine.kt`
- Optionally test: `android-client/app/src/test/java/com/blockproxy/android/routing/RoutingEngineTest.kt`

### Phase 2 Future Files

- Create: `android-client/app/src/main/java/com/blockproxy/android/dns/FakeDnsServer.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/dns/FakeIpAllocator.kt`
- Create: `android-client/app/src/main/java/com/blockproxy/android/dns/DnsMessageCodec.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/socks/DomainMappingStore.kt`

---

## Phase 1: TCP SNI/HTTP Host Sniffing

### Task 1: TLS ClientHello SNI Parser

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/socks/TlsClientHelloParser.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/TlsClientHelloParserTest.kt`

- [ ] **Step 1: Write failing parser tests**

Cover:

- valid TLS ClientHello with SNI returns hostname
- ClientHello without SNI returns null
- non-TLS bytes return null
- truncated record returns null
- IP-literal SNI returns null
- uppercase hostname normalizes to lowercase

- [ ] **Step 2: Run focused tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*TlsClientHelloParserTest'
```

Expected: fail because parser does not exist.

- [ ] **Step 3: Implement minimal parser**

Implement a no-allocation-heavy parser over `ByteArray`:

- verify TLS record type `0x16`
- parse record length
- verify handshake type `0x01`
- skip client version, random, session id, cipher suites, compression methods
- walk extensions
- find extension `0x0000`
- extract first host_name entry
- validate hostname characters and reject IP literals

- [ ] **Step 4: Verify parser tests pass**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*TlsClientHelloParserTest'
```

Expected: pass.

### Task 2: HTTP Host Parser

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/socks/HttpHostParser.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/HttpHostParserTest.kt`

- [ ] **Step 1: Write failing parser tests**

Cover:

- `GET / HTTP/1.1` with `Host: example.com`
- lowercase `host:`
- `Host: example.com:8080` strips port
- malformed request returns null
- incomplete headers return null
- IP-literal Host returns null for domain routing

- [ ] **Step 2: Run focused tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*HttpHostParserTest'
```

Expected: fail because parser does not exist.

- [ ] **Step 3: Implement minimal parser**

Parse only ASCII HTTP/1.x headers up to the first blank line. Keep behavior conservative:

- only inspect methods that look like HTTP tokens
- match `Host:` case-insensitively
- trim whitespace
- strip optional port
- validate hostname

- [ ] **Step 4: Verify parser tests pass**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*HttpHostParserTest'
```

Expected: pass.

### Task 3: TrafficSniffer

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/socks/TrafficSniffer.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/TrafficSnifferTest.kt`

- [ ] **Step 1: Write failing sniffer tests**

Cover:

- port 443 reads first bytes and returns TLS SNI
- port 80 reads first bytes and returns HTTP Host
- unsupported port returns without reading
- timeout returns `SniffSource.TIMEOUT` with empty or partial buffer
- large first payload caps at max bytes and still returns buffered bytes
- parser failure returns buffered bytes with no domain

- [ ] **Step 2: Run focused tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*TrafficSnifferTest'
```

Expected: fail because sniffer does not exist.

- [ ] **Step 3: Implement sniffer**

Create:

```kotlin
data class SniffResult(
    val domain: String?,
    val bufferedBytes: ByteArray,
    val source: SniffSource,
)

enum class SniffSource {
    TLS_SNI,
    HTTP_HOST,
    NONE,
    TIMEOUT,
    TOO_LARGE,
    UNSUPPORTED,
}
```

Implementation rules:

- only sniff when endpoint has no domain and address type/source indicates IP-only
- default timeout: `500ms`
- default max buffer: `16 * 1024`
- never throw parser errors into session flow
- always return bytes already read

- [ ] **Step 4: Verify sniffer tests pass**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*TrafficSnifferTest'
```

Expected: pass.

### Task 4: Integrate Sniffing Into SocksSession

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/socks/SocksSession.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/socks/LocalSocksServer.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/LocalSocksServerTest.kt`

- [ ] **Step 1: Write failing integration tests**

Add tests for:

- IP-only HTTPS CONNECT with sniffed `weibo.cn` and proxy rule `geosite:cn` opens forward connector
- IP-only HTTP CONNECT with sniffed `ip.cn` and proxy rule `domain:ip.cn` opens forward connector
- sniff failure falls back to direct when routing enabled
- `ATYP_DOMAIN` request does not use sniffer and keeps current behavior
- buffered first bytes are written to selected target/session before relay continues

- [ ] **Step 2: Run focused tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*LocalSocksServerTest'
```

Expected: fail until integration exists.

- [ ] **Step 3: Inject TrafficSniffer**

Update `LocalSocksServer` and `SocksSession` constructors to accept a `TrafficSniffer`, with a production default.

Tests should inject a fake sniffer so integration behavior does not depend on real TLS bytes in every test.

- [ ] **Step 4: Split SOCKS handling paths**

Keep existing path for domain-known endpoints:

```text
route -> connect -> SOCKS success -> relay
```

Add IP-only sniff path:

```text
SOCKS success -> sniff -> route -> connect -> replay buffered bytes -> relay
```

Add a helper such as:

```kotlin
private suspend fun relayWithInitialClientBytes(
    initialClientBytes: ByteArray,
    clientIn: InputStream,
    clientOut: OutputStream,
    upstream: ...
)
```

- [ ] **Step 5: Add route logs**

Log enough to verify true phone behavior:

```text
SocksSession ROUTE original=<ip:port> domain=<domain|null> source=<source> decision=<DIRECT|PROXY>
```

Do not log payload bytes.

- [ ] **Step 6: Verify integration tests pass**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*LocalSocksServerTest'
```

Expected: pass.

### Task 5: Optional Route Diagnostics

**Files:**
- Optionally modify: `android-client/app/src/main/java/com/blockproxy/android/routing/RoutingEngine.kt`
- Optionally test: `android-client/app/src/test/java/com/blockproxy/android/routing/RoutingEngineTest.kt`

- [ ] **Step 1: Decide whether diagnostics are needed**

If logs without matched rule are enough, skip this task.

- [ ] **Step 2: Add `RouteResult` tests**

Cover:

- direct rule hit returns matched direct rule
- proxy rule hit returns matched proxy rule
- no match returns null matched rule
- disabled config returns direct with null matched rule

- [ ] **Step 3: Implement `resolveDetailed()`**

Keep existing `resolve()` API for compatibility:

```kotlin
fun resolveDetailed(targetHost: String, domain: String?): RouteResult
fun resolve(targetHost: String, domain: String?): RouteDecision =
    resolveDetailed(targetHost, domain).decision
```

- [ ] **Step 4: Verify routing tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest --tests '*RoutingEngineTest'
```

Expected: pass.

### Task 6: Regression Verification

**Files:**
- No source file changes unless tests expose an issue.

- [ ] **Step 1: Run Android unit tests**

Run:

```bash
cd android-client && ./gradlew :app:testPhoneDebugUnitTest
```

Expected: pass.

- [ ] **Step 2: Build phone APK**

Run:

```bash
cd android-client && ./gradlew :app:assemblePhoneDebug
```

Expected: build success and APK at:

```text
android-client/app/build/outputs/apk/phone/debug/BlockProxyClient-android.apk
```

- [ ] **Step 3: Install to true phone when requested**

Run:

```bash
~/Library/Android/sdk/platform-tools/adb -s Z985KV5DMRIFSCQO install -r android-client/app/build/outputs/apk/phone/debug/BlockProxyClient-android.apk
```

Expected: `Success`.

- [ ] **Step 4: True phone test**

User steps:

- enable tunnel
- enable routing
- set proxy list to `geosite:cn`
- reconnect tunnel
- visit `https://weibo.cn`, `http://ip.cn`, `https://www.baidu.com`

Expected client logs:

```text
SocksSession ROUTE original=<ip>:443 domain=<domain> source=TLS_SNI decision=PROXY
SocksSession PROXY -> <domain>:443
```

Expected server logs:

```text
[Tunnel] Forward CONNECT ... <domain-or-resolved-target>:443
```

- [ ] **Step 5: Reverse tunnel regression**

From server, run the existing reverse CONNECT validation used for this project. Confirm:

- server-originated CONNECT still reaches Android client
- Android client still opens protected target socket
- reverse DATA and CLOSE still work
- no forward sniffing logs appear for reverse sessions

---

## Phase 2: Future fake DNS Plan

Do not execute this phase until separately approved.

### Task 7: DNS Codec

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/dns/DnsMessageCodec.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/dns/DnsMessageCodecTest.kt`

- [ ] Parse A/AAAA queries.
- [ ] Encode A response with fake IPv4.
- [ ] Encode empty AAAA response or future fake IPv6 response.
- [ ] Preserve transaction id.
- [ ] Reject malformed queries safely.

### Task 8: Fake IP Allocator

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/dns/FakeIpAllocator.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/dns/FakeIpAllocatorTest.kt`

- [ ] Use `198.18.0.0/15`.
- [ ] Return stable IP for same domain within TTL.
- [ ] Expire old mappings.
- [ ] Reuse old IPs safely.
- [ ] Expose mapping writes to `DomainMappingStore`.

### Task 9: FakeDnsServer

**Files:**
- Create: `android-client/app/src/main/java/com/blockproxy/android/dns/FakeDnsServer.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/service/BlockProxyVpnService.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/dns/FakeDnsServerTest.kt`

- [ ] Start UDP DNS server before VPN establishment.
- [ ] Configure VPN DNS with `builder.addDnsServer(...)`.
- [ ] Ensure app tunnel traffic remains excluded from VPN.
- [ ] Return fake IP and populate `DomainMappingStore`.
- [ ] Shut down DNS server cleanly with VPN service.

### Task 10: fake DNS SOCKS Integration

**Files:**
- Modify: `android-client/app/src/main/java/com/blockproxy/android/socks/DomainMappingStore.kt`
- Modify: `android-client/app/src/main/java/com/blockproxy/android/socks/SocksSession.kt`
- Test: `android-client/app/src/test/java/com/blockproxy/android/socks/LocalSocksServerTest.kt`

- [ ] Ensure fake IP CONNECT resolves to mapped domain.
- [ ] Ensure direct connector receives domain, not fake IP.
- [ ] Ensure forward connector receives domain, not fake IP.
- [ ] Ensure unmapped fake IP does not accidentally connect to fake address.

---

## Review Checklist

- [ ] The design accepts that TUN packets do not contain domains.
- [ ] Phase 1 is small enough to implement and test quickly.
- [ ] Phase 1 limitations are explicit: TCP-only, SNI/HTTP-only, no QUIC.
- [ ] Phase 2 remains optional and isolated.
- [ ] Reverse tunnel behavior is protected by explicit non-goals and regression checks.
- [ ] The plan does not require service-side changes for Phase 1.
