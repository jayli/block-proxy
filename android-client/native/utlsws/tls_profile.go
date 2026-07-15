package utlsws

import (
	"fmt"
	"net"

	utls "github.com/refraction-networking/utls"
)

type tlsConn interface {
	net.Conn
	Handshake() error
}

func wrapUTLS(conn net.Conn, options *Options) (tlsConn, error) {
	serverName := options.serverName
	if serverName == "" {
		serverName = options.hostHeader
	}
	config := &utls.Config{
		ServerName:         serverName,
		InsecureSkipVerify: options.allowInsecure,
		NextProtos:         []string{"http/1.1"},
	}
	spec, err := chromeHTTP11Spec()
	if err != nil {
		return nil, err
	}
	uconn := utls.UClient(conn, config, utls.HelloCustom)
	if err := uconn.ApplyPreset(spec); err != nil {
		return nil, fmt.Errorf("apply utls chrome http/1.1 preset: %w", err)
	}
	return uconn, nil
}

func chromeHTTP11Spec() (*utls.ClientHelloSpec, error) {
	spec, err := utls.UTLSIdToSpec(utls.HelloChrome_Auto)
	if err != nil {
		return nil, fmt.Errorf("build chrome utls spec: %w", err)
	}
	spec.Extensions = forceHTTP11Extensions(spec.Extensions)
	return &spec, nil
}

func forceHTTP11Extensions(extensions []utls.TLSExtension) []utls.TLSExtension {
	out := make([]utls.TLSExtension, 0, len(extensions))
	for _, ext := range extensions {
		switch e := ext.(type) {
		case *utls.ALPNExtension:
			e.AlpnProtocols = []string{"http/1.1"}
			out = append(out, e)
		case *utls.ApplicationSettingsExtension:
			// ALPS is only meaningful for h2. Keeping it while pinning ALPN to
			// http/1.1 can make servers select or emit HTTP/2 state unexpectedly.
			continue
		default:
			out = append(out, ext)
		}
	}
	return out
}
