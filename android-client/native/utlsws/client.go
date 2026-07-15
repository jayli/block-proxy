package utlsws

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"sync"
	"time"
)

type Listener interface {
	OnOpen()
	OnBinaryMessage(data []byte)
	OnClosed(code int, reason string)
	OnFailure(message string)
}

type Options struct {
	rawURL               string
	dialHost             string
	serverName           string
	hostHeader           string
	allowInsecure        bool
	chromeProfile        string
	connectTimeoutMillis int
	readBufferBytes      int
	headers              [][2]string
	initialBinaryMessage []byte
}

func NewOptions() *Options {
	return &Options{
		connectTimeoutMillis: 10000,
		readBufferBytes:      64 * 1024,
		chromeProfile:        "chrome_auto_stable",
	}
}

func (o *Options) SetURL(value string)               { o.rawURL = value }
func (o *Options) SetDialHost(value string)          { o.dialHost = value }
func (o *Options) SetServerName(value string)        { o.serverName = value }
func (o *Options) SetHostHeader(value string)        { o.hostHeader = value }
func (o *Options) SetAllowInsecure(value bool)       { o.allowInsecure = value }
func (o *Options) SetChromeProfile(value string)     { o.chromeProfile = value }
func (o *Options) SetConnectTimeoutMillis(value int) { o.connectTimeoutMillis = value }
func (o *Options) SetReadBufferBytes(value int)      { o.readBufferBytes = value }
func (o *Options) AddHeader(name string, value string) {
	o.headers = append(o.headers, [2]string{name, value})
}
func (o *Options) SetInitialBinaryMessage(data []byte) {
	o.initialBinaryMessage = append([]byte(nil), data...)
}

type Conn struct {
	netConn net.Conn

	mu           sync.Mutex
	closed       bool
	pendingBytes int
	listener     Listener

	writeQueue  chan []byte
	maxMessages int
	maxBytes    int
	cancel      context.CancelFunc
	closeOnce   sync.Once
	done        chan struct{}
}

func Connect(options *Options, listener Listener) (*Conn, error) {
	if options == nil {
		return nil, fmt.Errorf("options required")
	}
	u, err := url.Parse(options.rawURL)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "wss" {
		return nil, fmt.Errorf("only wss URLs are supported")
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
	timeout := time.Duration(options.connectTimeoutMillis) * time.Millisecond
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	dialer := net.Dialer{Timeout: timeout, KeepAlive: 30 * time.Second}
	tcp, err := dialer.Dial("tcp", address)
	if err != nil {
		return nil, err
	}
	if tc, ok := tcp.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
		_ = tc.SetKeepAlive(true)
	}

	tlsConn, err := wrapUTLS(tcp, options)
	if err != nil {
		_ = tcp.Close()
		return nil, err
	}
	if err := tlsConn.Handshake(); err != nil {
		_ = tlsConn.Close()
		return nil, err
	}

	hostHeader := options.hostHeader
	if hostHeader == "" {
		hostHeader = u.Host
	}
	key, err := newWebSocketKey()
	if err != nil {
		_ = tlsConn.Close()
		return nil, err
	}
	if err := writeUpgradeRequest(tlsConn, requestPath(u), hostHeader, options.headers, key); err != nil {
		_ = tlsConn.Close()
		return nil, err
	}
	if err := validateUpgradeResponse(tlsConn, key); err != nil {
		_ = tlsConn.Close()
		return nil, err
	}

	conn := newConnWithLimits(tlsConn, listener, defaultQueueMessages, defaultQueueBytes)
	if len(options.initialBinaryMessage) > 0 && !conn.SendBinary(options.initialBinaryMessage) {
		conn.Close(1000, "initial message failed")
		return nil, errQueueFull
	}
	listener.OnOpen()
	go conn.readLoop()
	return conn, nil
}

func requestPath(u *url.URL) string {
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	return path
}

func (c *Conn) SendBinary(data []byte) bool {
	if c == nil {
		return false
	}
	payload := append([]byte(nil), data...)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return false
	}
	if len(c.writeQueue) >= c.maxMessages || c.pendingBytes+len(payload) > c.maxBytes {
		c.mu.Unlock()
		return false
	}
	c.pendingBytes += len(payload)
	c.mu.Unlock()

	select {
	case c.writeQueue <- payload:
		return true
	default:
		c.mu.Lock()
		c.pendingBytes -= len(payload)
		c.mu.Unlock()
		return false
	}
}

func (c *Conn) Close(code int, reason string) {
	if c == nil {
		return
	}
	c.closeOnce.Do(func() {
		c.mu.Lock()
		c.closed = true
		c.listener = nil
		c.mu.Unlock()
		if c.cancel != nil {
			c.cancel()
		}
		_ = c.netConn.Close()
		close(c.done)
	})
}

func (c *Conn) writerLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case payload := <-c.writeQueue:
			err := writeClientBinaryFrame(c.netConn, payload)
			c.mu.Lock()
			c.pendingBytes -= len(payload)
			listener := c.listener
			c.mu.Unlock()
			if err != nil {
				if listener != nil {
					listener.OnFailure(err.Error())
				}
				c.Close(1001, "write failed")
				return
			}
		}
	}
}

func (c *Conn) readLoop() {
	for {
		message, err := readClientBinaryMessage(c.netConn, maxTunnelMessageBytes)
		if err != nil {
			c.mu.Lock()
			listener := c.listener
			c.mu.Unlock()
			if listener != nil {
				if err == errClosed {
					listener.OnClosed(1000, "closed")
				} else {
					listener.OnFailure(err.Error())
				}
			}
			c.Close(1001, "read stopped")
			return
		}
		c.mu.Lock()
		listener := c.listener
		c.mu.Unlock()
		if listener != nil {
			listener.OnBinaryMessage(append([]byte(nil), message...))
		}
	}
}

func newTestConn(conn net.Conn, listener Listener) *Conn {
	return newConnWithLimits(conn, listener, defaultQueueMessages, defaultQueueBytes)
}

func newTestConnWithLimits(conn net.Conn, listener Listener, maxMessages int, maxBytes int) *Conn {
	return newConnWithLimits(conn, listener, maxMessages, maxBytes)
}

func newConnWithLimits(conn net.Conn, listener Listener, maxMessages int, maxBytes int) *Conn {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Conn{
		netConn:     conn,
		listener:    listener,
		writeQueue:  make(chan []byte, maxMessages),
		maxMessages: maxMessages,
		maxBytes:    maxBytes,
		cancel:      cancel,
		done:        make(chan struct{}),
	}
	go c.writerLoop(ctx)
	return c
}

func authority(host string, port int) string {
	if port == 443 {
		return host
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}
