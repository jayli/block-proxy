package utlsws

import (
	"testing"

	utls "github.com/refraction-networking/utls"
)

func TestChromeHTTP11SpecPinsALPNToHTTP11(t *testing.T) {
	spec, err := chromeHTTP11Spec()
	if err != nil {
		t.Fatalf("chromeHTTP11Spec: %v", err)
	}

	var got []string
	for _, ext := range spec.Extensions {
		if alpn, ok := ext.(*utls.ALPNExtension); ok {
			got = alpn.AlpnProtocols
		}
	}
	if len(got) != 1 || got[0] != "http/1.1" {
		t.Fatalf("ALPN = %#v, want only http/1.1", got)
	}
}

func TestChromeHTTP11SpecRemovesHTTP2ApplicationSettings(t *testing.T) {
	spec, err := chromeHTTP11Spec()
	if err != nil {
		t.Fatalf("chromeHTTP11Spec: %v", err)
	}

	for _, ext := range spec.Extensions {
		if _, ok := ext.(*utls.ApplicationSettingsExtension); ok {
			t.Fatal("ApplicationSettingsExtension present, want removed for HTTP/1.1 WebSocket")
		}
	}
}
