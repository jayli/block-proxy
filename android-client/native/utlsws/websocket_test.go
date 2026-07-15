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
