import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from geodata_loader import parse_geosite_data

# ---- Protobuf encoding helpers (same as test_proto_parser.py) ----

def _encode_varint(value):
    parts = []
    while value > 0x7F:
        parts.append((value & 0x7F) | 0x80)
        value >>= 7
    parts.append(value & 0x7F)
    return bytes(parts)


def _encode_tag(field_number, wire_type):
    return _encode_varint((field_number << 3) | wire_type)


def _encode_string_field(field_number, value):
    data = value.encode("utf-8")
    return _encode_tag(field_number, 2) + _encode_varint(len(data)) + data


def _encode_bytes_field(field_number, value):
    return _encode_tag(field_number, 2) + _encode_varint(len(value)) + value


def _encode_varint_field(field_number, value):
    return _encode_tag(field_number, 0) + _encode_varint(value)


def _encode_message_field(field_number, message_bytes):
    return _encode_tag(field_number, 2) + _encode_varint(len(message_bytes)) + message_bytes


# ---- Geosite-specific protobuf builders ----

def _build_domain(type_val, value):
    """Build a Domain protobuf message: type=field1(varint), value=field2(string)"""
    msg = b""
    if type_val != 0:  # protobuf omits default (0) values
        msg += _encode_varint_field(1, type_val)
    msg += _encode_string_field(2, value)
    return msg


def _build_geosite(country_code, domains):
    """Build a GeoSite message: country_code=field1, domain[]=field2"""
    msg = _encode_string_field(1, country_code)
    for domain_bytes in domains:
        msg += _encode_message_field(2, domain_bytes)
    return msg


def _build_geosite_list(entries):
    """Build GeoSiteList: entry[]=field1"""
    msg = b""
    for entry_bytes in entries:
        msg += _encode_message_field(1, entry_bytes)
    return msg


class TestParseGeosite:
    def test_single_entry_single_domain(self):
        domain = _build_domain(2, "google.com")
        entry = _build_geosite("google", [domain])
        data = _build_geosite_list([entry])

        result = parse_geosite_data(data)
        assert "google" in result
        assert result["google"] == [("domain", "google.com")]

    def test_multiple_entries_multiple_domains(self):
        cn_domain = _build_domain(2, "baidu.com")
        cn = _build_geosite("cn", [cn_domain])
        google_domain = _build_domain(2, "google.com")
        google = _build_geosite("google", [google_domain])
        data = _build_geosite_list([cn, google])

        result = parse_geosite_data(data)
        assert "cn" in result
        assert "google" in result
        assert result["cn"] == [("domain", "baidu.com")]
        assert result["google"] == [("domain", "google.com")]

    def test_all_domain_types(self):
        plain = _build_domain(0, "example.com")
        regex = _build_domain(1, r"^.*\.example\.com$")
        domain = _build_domain(2, "example.org")
        full = _build_domain(3, "www.example.com")
        entry = _build_geosite("test", [plain, regex, domain, full])
        data = _build_geosite_list([entry])

        result = parse_geosite_data(data)
        assert result["test"] == [
            ("plain", "example.com"),
            ("regex", r"^.*\.example\.com$"),
            ("domain", "example.org"),
            ("full", "www.example.com"),
        ]

    def test_empty_data(self):
        assert parse_geosite_data(b"") == {}

    def test_country_code_lowercase(self):
        domain = _build_domain(2, "example.com")
        entry = _build_geosite("CN", [domain])
        data = _build_geosite_list([entry])

        result = parse_geosite_data(data)
        assert "cn" in result
