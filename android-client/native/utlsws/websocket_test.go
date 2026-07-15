package utlsws

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestAcceptKey(t *testing.T) {
	got := websocketAcceptKey("dGhlIHNhbXBsZSBub25jZQ==")
	want := "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
	if got != want {
		t.Fatalf("accept key = %q, want %q", got, want)
	}
}

func parseUpgradeHeaders(t *testing.T, raw string) (string, []string) {
	t.Helper()
	parts := strings.SplitN(raw, "\r\n\r\n", 2)
	if len(parts) != 2 {
		t.Fatal("missing header terminator")
	}
	lines := strings.Split(strings.TrimRight(parts[0], "\r\n"), "\r\n")
	return lines[0], lines[1:]
}

func headerValue(lines []string, name string) string {
	prefix := name + ": "
	for _, l := range lines {
		if strings.HasPrefix(l, prefix) {
			return strings.TrimPrefix(l, prefix)
		}
	}
	return ""
}

func headerIndex(lines []string, name string) int {
	for i, l := range lines {
		if strings.HasPrefix(l, name+":") {
			return i
		}
	}
	return -1
}

func TestWriteUpgradeRequestChromeHeaders(t *testing.T) {
	var out bytes.Buffer
	if err := writeUpgradeRequest(&out, "/ws", "example.com", "https://example.com", nil, "testkey123"); err != nil {
		t.Fatal(err)
	}

	requestLine, lines := parseUpgradeHeaders(t, out.String())
	if requestLine != "GET /ws HTTP/1.1" {
		t.Fatalf("request line = %q", requestLine)
	}

	// All expected Chrome-like headers must be present.
	expected := map[string]string{
		"Host":                  "example.com",
		"Connection":            "Upgrade",
		"Pragma":                "no-cache",
		"Cache-Control":         "no-cache",
		"Upgrade":               "websocket",
		"Origin":                "https://example.com",
		"Sec-WebSocket-Version": "13",
		"Accept-Language":       "en-US,en;q=0.9",
		"Sec-WebSocket-Key":     "testkey123",
	}
	for name, want := range expected {
		if got := headerValue(lines, name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}

	// User-Agent must be the Chrome 120 Android UA.
	ua := headerValue(lines, "User-Agent")
	if !strings.Contains(ua, "Chrome/120.0") {
		t.Errorf("User-Agent = %q, want Chrome/120", ua)
	}
	if !strings.Contains(ua, "Android") {
		t.Errorf("User-Agent = %q, want Android", ua)
	}

	// Header order must match Chrome's real order.
	ordered := []string{
		"Host", "Connection", "Pragma", "Cache-Control",
		"User-Agent", "Upgrade", "Origin", "Sec-WebSocket-Version",
		"Accept-Language", "Sec-WebSocket-Key",
	}
	for i := 1; i < len(ordered); i++ {
		prev := headerIndex(lines, ordered[i-1])
		curr := headerIndex(lines, ordered[i])
		if prev < 0 || curr < 0 {
			t.Errorf("missing header: %s or %s", ordered[i-1], ordered[i])
			continue
		}
		if prev >= curr {
			t.Errorf("%s (index %d) must come before %s (index %d)",
				ordered[i-1], prev, ordered[i], curr)
		}
	}
}

func TestWriteUpgradeRequestUserOverrides(t *testing.T) {
	custom := [][2]string{
		{"User-Agent", "CustomUA/1.0"},
		{"Origin", "https://custom.example"},
		{"Accept-Language", "zh-CN,zh;q=0.9"},
		{"X-Custom-Header", "custom-value"},
	}
	var out bytes.Buffer
	if err := writeUpgradeRequest(&out, "/", "h.com", "https://h.com", custom, "k"); err != nil {
		t.Fatal(err)
	}

	_, lines := parseUpgradeHeaders(t, out.String())

	if got := headerValue(lines, "User-Agent"); got != "CustomUA/1.0" {
		t.Errorf("User-Agent override = %q", got)
	}
	if got := headerValue(lines, "Origin"); got != "https://custom.example" {
		t.Errorf("Origin override = %q", got)
	}
	if got := headerValue(lines, "Accept-Language"); got != "zh-CN,zh;q=0.9" {
		t.Errorf("Accept-Language override = %q", got)
	}
	if got := headerValue(lines, "X-Custom-Header"); got != "custom-value" {
		t.Errorf("X-Custom-Header = %q", got)
	}

	// Overridden headers must stay in their original Chrome position.
	uaIdx := headerIndex(lines, "User-Agent")
	originIdx := headerIndex(lines, "Origin")
	if uaIdx >= originIdx {
		t.Errorf("User-Agent (%d) must come before Origin (%d)", uaIdx, originIdx)
	}
}

func TestWriteUpgradeRequestProtocolHeadersNotDuplicated(t *testing.T) {
	// Even if the caller passes protocol headers, they must not be duplicated.
	custom := [][2]string{
		{"Host", "evil.com"},
		{"Sec-WebSocket-Key", "evil-key"},
		{"Upgrade", "h2c"},
		{"Connection", "keep-alive"},
	}
	var out bytes.Buffer
	if err := writeUpgradeRequest(&out, "/", "real.com", "https://real.com", custom, "realkey"); err != nil {
		t.Fatal(err)
	}

	_, lines := parseUpgradeHeaders(t, out.String())

	// Protocol headers must use the correct values, not attacker-supplied ones.
	if got := headerValue(lines, "Host"); got != "real.com" {
		t.Errorf("Host = %q, want real.com", got)
	}
	if got := headerValue(lines, "Sec-WebSocket-Key"); got != "realkey" {
		t.Errorf("Sec-WebSocket-Key = %q, want realkey", got)
	}
	if got := headerValue(lines, "Upgrade"); got != "websocket" {
		t.Errorf("Upgrade = %q, want websocket", got)
	}
	if got := headerValue(lines, "Connection"); got != "Upgrade" {
		t.Errorf("Connection = %q, want Upgrade", got)
	}

	// Each protocol header must appear exactly once.
	protocolNames := []string{"Host", "Connection", "Upgrade", "Sec-WebSocket-Version", "Sec-WebSocket-Key"}
	for _, name := range protocolNames {
		count := 0
		for _, l := range lines {
			if strings.HasPrefix(l, name+":") {
				count++
			}
		}
		if count != 1 {
			t.Errorf("%s appears %d times, want 1", name, count)
		}
	}
}

func TestClientBinaryFrameIsMasked(t *testing.T) {
	var out bytes.Buffer
	payload := []byte("hello")

	if err := writeClientBinaryFrame(&out, payload); err != nil {
		t.Fatalf("writeClientBinaryFrame: %v", err)
	}
	raw := out.Bytes()
	if len(raw) < 6 {
		t.Fatalf("frame too short: %d", len(raw))
	}
	if raw[0] != 0x82 {
		t.Fatalf("first byte = %#x, want binary FIN frame", raw[0])
	}
	if raw[1]&0x80 == 0 {
		t.Fatalf("client frame is not masked")
	}

	got, err := readServerBinaryMessage(bytes.NewReader(raw), maxTunnelMessageBytes)
	if err != nil {
		t.Fatalf("readServerBinaryMessage: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("payload = %q, want %q", got, payload)
	}
}

func TestServerMaskedFrameIsRejected(t *testing.T) {
	var out bytes.Buffer
	if err := writeClientBinaryFrame(&out, []byte("bad")); err != nil {
		t.Fatalf("writeClientBinaryFrame: %v", err)
	}

	_, err := readClientBinaryMessage(bytes.NewReader(out.Bytes()), maxTunnelMessageBytes)
	if err == nil || !strings.Contains(err.Error(), "masked") {
		t.Fatalf("error = %v, want masked-frame rejection", err)
	}
}

func TestFragmentedBinaryReassembly(t *testing.T) {
	raw := append(serverFrame(0x02, []byte("hel")), serverFrame(0x80, []byte("lo"))...)

	got, err := readClientBinaryMessage(bytes.NewReader(raw), maxTunnelMessageBytes)
	if err != nil {
		t.Fatalf("readClientBinaryMessage: %v", err)
	}
	if string(got) != "hello" {
		t.Fatalf("message = %q, want hello", got)
	}
}

func TestOversizedMessageRejected(t *testing.T) {
	raw := serverFrame(0x82, bytes.Repeat([]byte{'x'}, maxTunnelMessageBytes+1))

	_, err := readClientBinaryMessage(bytes.NewReader(raw), maxTunnelMessageBytes)
	if err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("error = %v, want oversized rejection", err)
	}
}

func TestOversizedControlFrameRejected(t *testing.T) {
	raw := serverFrame(0x89, bytes.Repeat([]byte{'x'}, 126))

	_, err := readClientBinaryMessage(bytes.NewReader(raw), maxTunnelMessageBytes)
	if err == nil || !strings.Contains(err.Error(), "control") {
		t.Fatalf("error = %v, want control-frame rejection", err)
	}
}

func TestNon101ResponseIncludesStatusAndSnippet(t *testing.T) {
	response := "HTTP/1.1 403 Forbidden\r\nContent-Length: 9\r\n\r\nforbidden"
	err := validateUpgradeResponse(strings.NewReader(response), "unused")
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "403") || !strings.Contains(err.Error(), "forbidden") {
		t.Fatalf("error = %q, want status and body snippet", err.Error())
	}
}

func TestSendBinaryCopiesPayloadBeforeQueue(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	conn := newTestConn(client, nil)
	defer conn.Close(1000, "done")

	payload := []byte("hello")
	if !conn.SendBinary(payload) {
		t.Fatal("SendBinary returned false")
	}
	copy(payload, []byte("xxxxx"))

	got, err := readServerBinaryMessage(server, maxTunnelMessageBytes)
	if err != nil {
		t.Fatalf("readServerBinaryMessage: %v", err)
	}
	if string(got) != "hello" {
		t.Fatalf("message = %q, want copied hello", got)
	}
}

func TestConcurrentSendBinarySerializesMessages(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	conn := newTestConn(client, nil)
	defer conn.Close(1000, "done")

	const count = 20
	errCh := make(chan error, count)
	for i := 0; i < count; i++ {
		go func() {
			if !conn.SendBinary([]byte("x")) {
				errCh <- io.ErrClosedPipe
				return
			}
			errCh <- nil
		}()
	}
	for i := 0; i < count; i++ {
		if err := <-errCh; err != nil {
			t.Fatalf("send failed: %v", err)
		}
	}

	for i := 0; i < count; i++ {
		got, err := readServerBinaryMessage(server, maxTunnelMessageBytes)
		if err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		if string(got) != "x" {
			t.Fatalf("message %d = %q", i, got)
		}
	}
}

func TestSendAfterCloseReturnsFalse(t *testing.T) {
	client, server := net.Pipe()
	defer server.Close()

	conn := newTestConn(client, nil)
	conn.Close(1000, "done")

	if conn.SendBinary([]byte("late")) {
		t.Fatal("SendBinary after close returned true")
	}
}

func TestQueueFullReturnsFalse(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	conn := newTestConnWithLimits(client, nil, 1, 1)
	defer conn.Close(1000, "done")

	if !conn.SendBinary([]byte("a")) {
		t.Fatal("first send failed")
	}
	if conn.SendBinary([]byte("b")) {
		t.Fatal("second send should fail due queue bounds")
	}
}

func TestInboundBufferCopiedBeforeCallback(t *testing.T) {
	listener := &recordingListener{done: make(chan struct{}, 1)}
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	conn := newTestConn(client, listener)
	defer conn.Close(1000, "done")
	go conn.readLoop()

	if _, err := server.Write(serverFrame(0x82, []byte("hello"))); err != nil {
		t.Fatalf("server write: %v", err)
	}
	select {
	case <-listener.done:
	case <-time.After(time.Second):
		t.Fatal("timeout waiting for callback")
	}
	if string(listener.messages[0]) != "hello" {
		t.Fatalf("message = %q", listener.messages[0])
	}
}

func serverFrame(opcode byte, payload []byte) []byte {
	var out bytes.Buffer
	out.WriteByte(opcode)
	switch {
	case len(payload) < 126:
		out.WriteByte(byte(len(payload)))
	case len(payload) <= 0xffff:
		out.WriteByte(126)
		out.WriteByte(byte(len(payload) >> 8))
		out.WriteByte(byte(len(payload)))
	default:
		out.WriteByte(127)
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(len(payload)))
		out.Write(ext[:])
	}
	out.Write(payload)
	return out.Bytes()
}

func readServerBinaryMessage(r io.Reader, max int) ([]byte, error) {
	return readWebSocketMessage(r, max, true, nil)
}

type recordingListener struct {
	done     chan struct{}
	messages [][]byte
}

func (r *recordingListener) OnOpen() {}

func (r *recordingListener) OnBinaryMessage(data []byte) {
	r.messages = append(r.messages, data)
	r.done <- struct{}{}
}

func (r *recordingListener) OnClosed(code int, reason string) {}

func (r *recordingListener) OnFailure(message string) {}

func init() {
	rand.Reader = rand.Reader
}
