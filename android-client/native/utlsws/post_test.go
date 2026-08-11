package utlsws

import (
	"bufio"
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestWritePostRequestUsesHTTP11KeepAlive(t *testing.T) {
	opts := NewPostOptions()
	opts.SetURL("https://example.com:8443/xhttp/upload/session/7")
	opts.SetHostHeader("example.com:8443")
	opts.AddHeader("Cache-Control", "no-store")
	body := []byte("frame")

	var out bytes.Buffer
	if err := writePostRequest(&out, opts, body); err != nil {
		t.Fatal(err)
	}

	req, err := http.ReadRequest(bufio.NewReader(&out))
	if err != nil {
		t.Fatal(err)
	}
	defer req.Body.Close()

	if req.Method != http.MethodPost {
		t.Fatalf("method = %s", req.Method)
	}
	if req.URL.RequestURI() != "/xhttp/upload/session/7" {
		t.Fatalf("uri = %s", req.URL.RequestURI())
	}
	if req.Host != "example.com:8443" {
		t.Fatalf("host = %s", req.Host)
	}
	if got := req.Header.Get("Connection"); !strings.EqualFold(got, "keep-alive") {
		t.Fatalf("Connection = %q", got)
	}
	if got := req.Header.Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := req.ContentLength; got != int64(len(body)) {
		t.Fatalf("ContentLength = %d", got)
	}
	gotBody, _ := io.ReadAll(req.Body)
	if !bytes.Equal(gotBody, body) {
		t.Fatalf("body = %q", string(gotBody))
	}
}

func TestValidatePostResponseRequires2xx(t *testing.T) {
	ok := "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"
	if err := validatePostResponse(bufio.NewReader(strings.NewReader(ok))); err != nil {
		t.Fatalf("200 response failed: %v", err)
	}

	bad := "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 12\r\n\r\nbackend-down"
	err := validatePostResponse(bufio.NewReader(strings.NewReader(bad)))
	if err == nil || !strings.Contains(err.Error(), "503") || !strings.Contains(err.Error(), "backend-down") {
		t.Fatalf("bad response err = %v", err)
	}
}
