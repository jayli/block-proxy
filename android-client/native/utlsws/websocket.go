package utlsws

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"strings"
)

const websocketGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

// Chrome 120 Android User-Agent — matches the TLS fingerprint version.
const chromeUserAgent = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36"

func websocketAcceptKey(key string) string {
	sum := sha1.Sum([]byte(key + websocketGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func newWebSocketKey() (string, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(nonce[:]), nil
}

func writeUpgradeRequest(w io.Writer, path string, hostHeader string, origin string, headers [][2]string, key string) error {
	if path == "" {
		path = "/"
	}

	// Build a set of user-provided header names for override lookup.
	// Names are stored in their original casing for comparison.
	type headerEntry struct {
		name  string
		value string
	}
	var extra []headerEntry
	// These are WebSocket protocol headers managed by this function;
	// skip them if the caller accidentally includes them.
	wsProtocolHeaders := map[string]bool{
		"host":                 true,
		"connection":           true,
		"upgrade":              true,
		"sec-websocket-version": true,
		"sec-websocket-key":    true,
	}
	for _, h := range headers {
		lower := strings.ToLower(h[0])
		if wsProtocolHeaders[lower] {
			continue
		}
		extra = append(extra, headerEntry{h[0], h[1]})
	}

	// lookup returns the user-provided value for a header name, or the
	// fallback default. The entry is consumed so it won't appear twice.
	lookup := func(name string, fallback string) string {
		lower := strings.ToLower(name)
		for i, e := range extra {
			if strings.ToLower(e.name) == lower {
				extra = append(extra[:i], extra[i+1:]...)
				return e.value
			}
		}
		return fallback
	}

	var b bytes.Buffer
	b.WriteString("GET ")
	b.WriteString(path)
	b.WriteString(" HTTP/1.1\r\n")

	// Chrome WebSocket Upgrade header order (Chrome 120 on Android).
	b.WriteString("Host: ")
	b.WriteString(hostHeader)
	b.WriteString("\r\n")

	b.WriteString("Connection: Upgrade\r\n")

	b.WriteString("Pragma: ")
	b.WriteString(lookup("Pragma", "no-cache"))
	b.WriteString("\r\n")

	b.WriteString("Cache-Control: ")
	b.WriteString(lookup("Cache-Control", "no-cache"))
	b.WriteString("\r\n")

	b.WriteString("User-Agent: ")
	b.WriteString(lookup("User-Agent", chromeUserAgent))
	b.WriteString("\r\n")

	b.WriteString("Upgrade: websocket\r\n")

	if origin == "" {
		origin = "https://" + hostHeader
	}
	b.WriteString("Origin: ")
	b.WriteString(lookup("Origin", origin))
	b.WriteString("\r\n")

	b.WriteString("Sec-WebSocket-Version: 13\r\n")

	b.WriteString("Accept-Language: ")
	b.WriteString(lookup("Accept-Language", "en-US,en;q=0.9"))
	b.WriteString("\r\n")

	b.WriteString("Sec-WebSocket-Key: ")
	b.WriteString(key)
	b.WriteString("\r\n")

	// Remaining user headers not already consumed by lookup().
	for _, e := range extra {
		b.WriteString(e.name)
		b.WriteString(": ")
		b.WriteString(e.value)
		b.WriteString("\r\n")
	}

	b.WriteString("\r\n")
	_, err := w.Write(b.Bytes())
	return err
}

func validateUpgradeResponse(r io.Reader, key string) error {
	br := bufio.NewReader(r)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusSwitchingProtocols {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		if len(snippet) > 0 {
			return fmt.Errorf("websocket upgrade failed: status=%d body=%q", resp.StatusCode, string(snippet))
		}
		return fmt.Errorf("websocket upgrade failed: status=%d", resp.StatusCode)
	}
	if !strings.EqualFold(resp.Header.Get("Upgrade"), "websocket") {
		return fmt.Errorf("websocket upgrade failed: missing Upgrade header")
	}
	if !headerContainsToken(resp.Header.Get("Connection"), "upgrade") {
		return fmt.Errorf("websocket upgrade failed: missing Connection upgrade")
	}
	if key != "" {
		if got, want := resp.Header.Get("Sec-WebSocket-Accept"), websocketAcceptKey(key); got != want {
			return fmt.Errorf("websocket upgrade failed: bad accept key")
		}
	}
	return nil
}

func headerContainsToken(value string, token string) bool {
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), token) {
			return true
		}
	}
	return false
}

func writeClientBinaryFrame(w io.Writer, payload []byte) error {
	return writeFrame(w, 0x2, true, true, payload)
}

func writePongFrame(w io.Writer, payload []byte) error {
	return writeFrame(w, 0xA, true, true, payload)
}

func writeCloseFrame(w io.Writer, code int, reason string) error {
	var payload bytes.Buffer
	if code > 0 {
		_ = binary.Write(&payload, binary.BigEndian, uint16(code))
		payload.WriteString(reason)
	}
	return writeFrame(w, 0x8, true, true, payload.Bytes())
}

func writeFrame(w io.Writer, opcode byte, fin bool, masked bool, payload []byte) error {
	if opcode >= 0x8 && len(payload) > 125 {
		return fmt.Errorf("control frame too large: %d", len(payload))
	}
	first := opcode
	if fin {
		first |= 0x80
	}

	var header [14]byte
	header[0] = first
	offset := 2
	maskBit := byte(0)
	if masked {
		maskBit = 0x80
	}
	switch {
	case len(payload) < 126:
		header[1] = maskBit | byte(len(payload))
	case len(payload) <= 0xffff:
		header[1] = maskBit | 126
		binary.BigEndian.PutUint16(header[2:4], uint16(len(payload)))
		offset = 4
	default:
		header[1] = maskBit | 127
		binary.BigEndian.PutUint64(header[2:10], uint64(len(payload)))
		offset = 10
	}

	body := payload
	if masked {
		var mask [4]byte
		if _, err := rand.Read(mask[:]); err != nil {
			return err
		}
		copy(header[offset:offset+4], mask[:])
		offset += 4
		body = append([]byte(nil), payload...)
		for i := range body {
			body[i] ^= mask[i%4]
		}
	}

	if _, err := w.Write(header[:offset]); err != nil {
		return err
	}
	_, err := w.Write(body)
	return err
}

func readClientBinaryMessage(r io.Reader, max int) ([]byte, error) {
	return readWebSocketMessage(r, max, false, nil)
}

func readWebSocketMessage(r io.Reader, max int, expectMasked bool, controlWriter io.Writer) ([]byte, error) {
	var fragments bytes.Buffer
	inFragment := false

	for {
		opcode, fin, payload, err := readFrame(r, expectMasked)
		if err != nil {
			return nil, err
		}
		switch opcode {
		case 0x0:
			if !inFragment {
				return nil, fmt.Errorf("unexpected continuation frame")
			}
			if fragments.Len()+len(payload) > max {
				return nil, fmt.Errorf("websocket message too large")
			}
			fragments.Write(payload)
			if fin {
				return fragments.Bytes(), nil
			}
		case 0x2:
			if len(payload) > max {
				return nil, fmt.Errorf("websocket message too large")
			}
			if fin {
				return payload, nil
			}
			inFragment = true
			fragments.Write(payload)
		case 0x8:
			return nil, errClosed
		case 0x9:
			if controlWriter != nil {
				_ = writePongFrame(controlWriter, payload)
			}
		case 0xA:
			continue
		case 0x1:
			return nil, fmt.Errorf("text messages are not supported")
		default:
			return nil, fmt.Errorf("unsupported websocket opcode: %d", opcode)
		}
	}
}

func readFrame(r io.Reader, expectMasked bool) (opcode byte, fin bool, payload []byte, err error) {
	var h [2]byte
	if _, err = io.ReadFull(r, h[:]); err != nil {
		return 0, false, nil, err
	}
	fin = h[0]&0x80 != 0
	opcode = h[0] & 0x0f
	masked := h[1]&0x80 != 0
	if masked != expectMasked {
		if masked {
			return 0, false, nil, fmt.Errorf("unexpected masked server frame")
		}
		return 0, false, nil, fmt.Errorf("unmasked client frame")
	}
	length := uint64(h[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return 0, false, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return 0, false, nil, err
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if opcode >= 0x8 && length > 125 {
		return 0, false, nil, fmt.Errorf("control frame too large")
	}

	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(r, mask[:]); err != nil {
			return 0, false, nil, err
		}
	}
	if length > uint64(maxTunnelMessageBytes+1) {
		return 0, false, nil, fmt.Errorf("websocket message too large")
	}
	payload = make([]byte, int(length))
	if _, err = io.ReadFull(r, payload); err != nil {
		return 0, false, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return opcode, fin, payload, nil
}
