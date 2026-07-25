import hashlib
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import proxy_core


class FakeSslObject:
    def __init__(self, der):
        self.der = der
        self.calls = 0

    def getpeercert(self, binary_form=False):
        self.calls += 1
        return self.der if binary_form else {}


def _pin(der):
    return hashlib.sha256(der).hexdigest()


def test_verify_cert_pin_disabled_does_not_read_certificate_or_emit_event():
    core = proxy_core.ProxyCore()
    events = []
    ssl_obj = FakeSslObject(b"leaf-cert")
    core.set_pin_callback(lambda event_type, data: events.append((event_type, data)))

    core._cert_bind_enabled = False
    core._verify_cert_pin(ssl_obj)

    assert ssl_obj.calls == 0
    assert events == []


def test_verify_cert_pin_tofu_saves_new_pin_and_emits_event():
    core = proxy_core.ProxyCore()
    events = []
    core.set_pin_callback(lambda event_type, data: events.append((event_type, data)))
    core._cert_bind_enabled = True
    core._cert_pin = ""

    core._verify_cert_pin(FakeSslObject(b"leaf-cert"))

    expected = _pin(b"leaf-cert")
    assert core._cert_pin == expected
    assert core._cert_pin_mismatch_reported is False
    assert events == [("tofu", expected)]


def test_verify_cert_pin_match_passes_without_event():
    core = proxy_core.ProxyCore()
    events = []
    core.set_pin_callback(lambda event_type, data: events.append((event_type, data)))
    core._cert_bind_enabled = True
    core._cert_pin = _pin(b"leaf-cert")

    core._verify_cert_pin(FakeSslObject(b"leaf-cert"))

    assert events == []


def test_verify_cert_pin_match_after_reported_mismatch_emits_match_event():
    core = proxy_core.ProxyCore()
    events = []
    core.set_pin_callback(lambda event_type, data: events.append((event_type, data)))
    core._cert_bind_enabled = True
    core._cert_pin = _pin(b"leaf-cert")
    core._cert_pin_mismatch_reported = True

    core._verify_cert_pin(FakeSslObject(b"leaf-cert"))

    assert core._cert_pin_mismatch_reported is False
    assert events == [("match", _pin(b"leaf-cert"))]


def test_verify_cert_pin_mismatch_emits_event_and_raises():
    core = proxy_core.ProxyCore()
    events = []
    core.set_pin_callback(lambda event_type, data: events.append((event_type, data)))
    core._cert_bind_enabled = True
    core._cert_pin = _pin(b"old-cert")

    with pytest.raises(proxy_core.CertPinMismatchError) as exc:
        core._verify_cert_pin(FakeSslObject(b"new-cert"))

    assert exc.value.saved_pin == _pin(b"old-cert")
    assert exc.value.new_pin == _pin(b"new-cert")
    assert core._cert_pin_mismatch_reported is True
    assert events == [("mismatch", (_pin(b"old-cert"), _pin(b"new-cert")))]


def test_verify_cert_pin_repeated_mismatch_raises_without_duplicate_event():
    core = proxy_core.ProxyCore()
    events = []
    core.set_pin_callback(lambda event_type, data: events.append((event_type, data)))
    core._cert_bind_enabled = True
    core._cert_pin = _pin(b"old-cert")
    core._cert_pin_mismatch_reported = True

    with pytest.raises(proxy_core.CertPinMismatchError):
        core._verify_cert_pin(FakeSslObject(b"new-cert"))

    assert events == []


def test_verify_cert_pin_unavailable_certificate_raises_clear_error():
    core = proxy_core.ProxyCore()
    core._cert_bind_enabled = True
    core._cert_pin = ""

    with pytest.raises(proxy_core.CertPinUnavailableError, match="peer certificate unavailable"):
        core._verify_cert_pin(FakeSslObject(None))


def test_build_ssl_context_resets_pin_runtime_state_when_tls_disabled():
    core = proxy_core.ProxyCore()
    core._server_config = {
        "tls": False,
        "allowInsecure": True,
        "certBindEnabled": True,
        "certPin": _pin(b"leaf-cert"),
        "certPinMismatch": True,
    }

    core._build_ssl_context()

    assert core._ssl_ctx is None
    assert core._cert_bind_enabled is False
    assert core._cert_pin == ""
    assert core._cert_pin_mismatch_reported is False
