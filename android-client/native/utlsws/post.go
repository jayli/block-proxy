package utlsws

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type PostOptions struct {
	rawURL                string
	dialHost              string
	serverName            string
	hostHeader            string
	allowInsecure         bool
	connectTimeoutMillis  int
	responseTimeoutMillis int
	headers               [][2]string
}

func NewPostOptions() *PostOptions {
	return &PostOptions{
		connectTimeoutMillis:  10000,
		responseTimeoutMillis: 30000,
	}
}

func (o *PostOptions) SetURL(value string)                { o.rawURL = value }
func (o *PostOptions) SetDialHost(value string)           { o.dialHost = value }
func (o *PostOptions) SetServerName(value string)         { o.serverName = value }
func (o *PostOptions) SetHostHeader(value string)         { o.hostHeader = value }
func (o *PostOptions) SetAllowInsecure(value bool)        { o.allowInsecure = value }
func (o *PostOptions) SetConnectTimeoutMillis(value int)  { o.connectTimeoutMillis = value }
func (o *PostOptions) SetResponseTimeoutMillis(value int) { o.responseTimeoutMillis = value }
func (o *PostOptions) AddHeader(name string, value string) {
	o.headers = append(o.headers, [2]string{name, value})
}

type PostClient struct {
	mu      sync.Mutex
	conn    net.Conn
	reader  *bufio.Reader
	address string
	closed  bool
}

func NewPostClient() *PostClient {
	return &PostClient{}
}

func (c *PostClient) PostPacket(options *PostOptions, body []byte) error {
	if options == nil {
		return fmt.Errorf("post options required")
	}
	payload := append([]byte(nil), body...)

	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return errClosed
	}

	if err := c.postLocked(options, payload); err == nil {
		return nil
	}
	c.closeLocked()
	return c.postLocked(options, payload)
}

func (c *PostClient) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.closeLocked()
}

func (c *PostClient) postLocked(options *PostOptions, body []byte) error {
	conn, reader, err := c.getConnLocked(options)
	if err != nil {
		return err
	}
	timeout := time.Duration(options.responseTimeoutMillis) * time.Millisecond
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	defer conn.SetDeadline(time.Time{})

	if err := writePostRequest(conn, options, body); err != nil {
		return err
	}
	return validatePostResponse(reader)
}

func (c *PostClient) getConnLocked(options *PostOptions) (net.Conn, *bufio.Reader, error) {
	u, err := url.Parse(options.rawURL)
	if err != nil {
		return nil, nil, err
	}
	if u.Scheme != "https" {
		return nil, nil, fmt.Errorf("only https URLs are supported")
	}
	port := u.Port()
	if port == "" {
		port = "443"
	}
	dialHost := options.dialHost
	if dialHost == "" {
		dialHost = u.Hostname()
	}
	address := net.JoinHostPort(dialHost, port)

	if c.conn != nil && c.address == address {
		return c.conn, c.reader, nil
	}
	c.closeLocked()

	timeout := time.Duration(options.connectTimeoutMillis) * time.Millisecond
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	dialer := net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	tcp, err := dialer.Dial("tcp", address)
	if err != nil {
		return nil, nil, err
	}
	if tc, ok := tcp.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
		_ = tc.SetKeepAlive(true)
	}

	tlsOptions := NewOptions()
	tlsOptions.SetURL(options.rawURL)
	tlsOptions.SetDialHost(dialHost)
	tlsOptions.SetServerName(options.serverName)
	tlsOptions.SetHostHeader(options.hostHeader)
	tlsOptions.SetAllowInsecure(options.allowInsecure)
	tlsConn, err := wrapUTLS(tcp, tlsOptions)
	if err != nil {
		_ = tcp.Close()
		return nil, nil, err
	}
	if err := tlsConn.Handshake(); err != nil {
		_ = tlsConn.Close()
		return nil, nil, err
	}

	c.conn = tlsConn
	c.reader = bufio.NewReader(tlsConn)
	c.address = address
	return c.conn, c.reader, nil
}

func (c *PostClient) closeLocked() {
	if c.conn != nil {
		_ = c.conn.Close()
	}
	c.conn = nil
	c.reader = nil
	c.address = ""
}

func writePostRequest(w io.Writer, options *PostOptions, body []byte) error {
	u, err := url.Parse(options.rawURL)
	if err != nil {
		return err
	}
	hostHeader := options.hostHeader
	if hostHeader == "" {
		hostHeader = u.Host
	}

	type headerEntry struct {
		name  string
		value string
	}
	var extra []headerEntry
	managed := map[string]bool{
		"host":           true,
		"connection":     true,
		"content-length": true,
		"content-type":   true,
	}
	for _, h := range options.headers {
		if managed[strings.ToLower(h[0])] {
			continue
		}
		extra = append(extra, headerEntry{h[0], h[1]})
	}
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
	b.WriteString("POST ")
	b.WriteString(requestPath(u))
	b.WriteString(" HTTP/1.1\r\n")
	b.WriteString("Host: ")
	b.WriteString(hostHeader)
	b.WriteString("\r\n")
	b.WriteString("Connection: keep-alive\r\n")
	b.WriteString("Content-Length: ")
	b.WriteString(strconv.Itoa(len(body)))
	b.WriteString("\r\n")
	b.WriteString("Content-Type: application/octet-stream\r\n")
	b.WriteString("Cache-Control: ")
	b.WriteString(lookup("Cache-Control", "no-store"))
	b.WriteString("\r\n")
	b.WriteString("User-Agent: ")
	b.WriteString(lookup("User-Agent", chromeUserAgent))
	b.WriteString("\r\n")
	b.WriteString("Accept: */*\r\n")
	for _, e := range extra {
		b.WriteString(e.name)
		b.WriteString(": ")
		b.WriteString(e.value)
		b.WriteString("\r\n")
	}
	b.WriteString("\r\n")
	b.Write(body)
	_, err = w.Write(b.Bytes())
	return err
}

func validatePostResponse(r *bufio.Reader) error {
	resp, err := http.ReadResponse(r, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	details := fmt.Sprintf(
		"post failed: status=%s server=%q cf-ray=%q location=%q",
		resp.Status,
		resp.Header.Get("server"),
		resp.Header.Get("cf-ray"),
		resp.Header.Get("location"),
	)
	if len(snippet) > 0 {
		return fmt.Errorf("%s body=%q", details, string(snippet))
	}
	return fmt.Errorf("%s", details)
}
