import ipaddress
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from geodata_loader import parse_geosite_data, parse_geoip_data, GeodataLoader

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


# ---- GeoIP-specific protobuf builders ----

def _build_cidr(ip_bytes, prefix):
    """Build a CIDR message: ip=field1(bytes), prefix=field2(varint)"""
    return _encode_bytes_field(1, ip_bytes) + _encode_varint_field(2, prefix)


def _build_geoip(country_code, cidrs):
    """Build a GeoIP message: country_code=field1, cidr[]=field2"""
    msg = _encode_string_field(1, country_code)
    for cidr_bytes in cidrs:
        msg += _encode_message_field(2, cidr_bytes)
    return msg


def _build_geoip_list(entries):
    """Build GeoIPList: entry[]=field1"""
    msg = b""
    for entry_bytes in entries:
        msg += _encode_message_field(1, entry_bytes)
    return msg


class TestParseGeoip:
    def test_single_entry_single_cidr(self):
        ip_bytes = ipaddress.IPv4Address("5.62.60.0").packed
        cidr = _build_cidr(ip_bytes, 24)
        entry = _build_geoip("ru", [cidr])
        data = _build_geoip_list([entry])

        result = parse_geoip_data(data)
        assert "ru" in result
        assert len(result["ru"]) == 1
        assert result["ru"][0] == ipaddress.IPv4Network("5.62.60.0/24")

    def test_multiple_cidrs_per_country(self):
        ip1 = ipaddress.IPv4Address("1.0.0.0").packed
        ip2 = ipaddress.IPv4Address("1.0.1.0").packed
        cidr1 = _build_cidr(ip1, 24)
        cidr2 = _build_cidr(ip2, 24)
        entry = _build_geoip("au", [cidr1, cidr2])
        data = _build_geoip_list([entry])

        result = parse_geoip_data(data)
        assert len(result["au"]) == 2
        assert ipaddress.IPv4Network("1.0.0.0/24") in result["au"]
        assert ipaddress.IPv4Network("1.0.1.0/24") in result["au"]

    def test_ipv6_cidr(self):
        ip_bytes = ipaddress.IPv6Address("2001:db8::").packed
        cidr = _build_cidr(ip_bytes, 32)
        entry = _build_geoip("test6", [cidr])
        data = _build_geoip_list([entry])

        result = parse_geoip_data(data)
        assert "test6" in result
        assert result["test6"][0] == ipaddress.IPv6Network("2001:db8::/32")

    def test_empty_data(self):
        assert parse_geoip_data(b"") == {}

    def test_country_code_lowercase(self):
        ip_bytes = ipaddress.IPv4Address("10.0.0.0").packed
        cidr = _build_cidr(ip_bytes, 8)
        entry = _build_geoip("US", [cidr])
        data = _build_geoip_list([entry])

        result = parse_geoip_data(data)
        assert "us" in result


class TestGeodataLoader:
    def test_load_geosite_from_file(self, tmp_path):
        domain = _build_domain(2, "google.com")
        entry = _build_geosite("google", [domain])
        data = _build_geosite_list([entry])

        geosite_path = tmp_path / "geosite.dat"
        geosite_path.write_bytes(data)

        loader = GeodataLoader(str(tmp_path), load_geosite=True, load_geoip=False)
        assert loader.geosite_available
        assert not loader.geoip_available
        result = loader.get_geosite("google")
        assert result == [("domain", "google.com")]

    def test_load_geoip_from_file(self, tmp_path):
        ip_bytes = ipaddress.IPv4Address("5.62.60.0").packed
        cidr = _build_cidr(ip_bytes, 24)
        entry = _build_geoip("ru", [cidr])
        data = _build_geoip_list([entry])

        geoip_path = tmp_path / "geoip.dat"
        geoip_path.write_bytes(data)

        loader = GeodataLoader(str(tmp_path), load_geosite=False, load_geoip=True)
        assert loader.geoip_available
        assert not loader.geosite_available
        result = loader.get_geoip("ru")
        assert len(result) == 1
        assert result[0] == ipaddress.IPv4Network("5.62.60.0/24")

    def test_missing_file_returns_empty(self, tmp_path):
        loader = GeodataLoader(str(tmp_path), load_geosite=True, load_geoip=True)
        assert loader.geosite_available is False
        assert loader.geoip_available is False
        assert loader.get_geosite("google") == []
        assert loader.get_geoip("cn") == []

    def test_unknown_country_returns_empty(self, tmp_path):
        domain = _build_domain(2, "google.com")
        entry = _build_geosite("google", [domain])
        data = _build_geosite_list([entry])
        (tmp_path / "geosite.dat").write_bytes(data)

        loader = GeodataLoader(str(tmp_path), load_geosite=True, load_geoip=False)
        assert loader.get_geosite("nonexistent") == []

    def test_caching_second_call_no_reparse(self, tmp_path):
        domain = _build_domain(2, "google.com")
        entry = _build_geosite("google", [domain])
        data = _build_geosite_list([entry])
        geosite_path = tmp_path / "geosite.dat"
        geosite_path.write_bytes(data)

        loader = GeodataLoader(str(tmp_path), load_geosite=True, load_geoip=False)
        # Delete file after first load
        geosite_path.unlink()
        # Second call should still return cached data
        result = loader.get_geosite("google")
        assert result == [("domain", "google.com")]

    def test_selective_loading_skips_geoip(self, tmp_path):
        ip_bytes = ipaddress.IPv4Address("5.62.60.0").packed
        cidr = _build_cidr(ip_bytes, 24)
        entry = _build_geoip("ru", [cidr])
        data = _build_geoip_list([entry])
        (tmp_path / "geoip.dat").write_bytes(data)

        loader = GeodataLoader(str(tmp_path), load_geosite=True, load_geoip=False)
        assert not loader.geoip_available
        assert loader.get_geoip("ru") == []
