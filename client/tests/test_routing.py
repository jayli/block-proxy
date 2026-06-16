import os
import sys
import ipaddress
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from routing import parse_rules, RoutingEngine


class TestParseRules:
    def test_geosite_rule(self):
        rules = parse_rules(["geosite:cn"])
        assert len(rules) == 1
        assert rules[0] == ("geosite", "cn", False)

    def test_geosite_negated(self):
        rules = parse_rules(["geosite:!cn"])
        assert len(rules) == 1
        assert rules[0] == ("geosite", "cn", True)

    def test_geoip_rule(self):
        rules = parse_rules(["geoip:cn"])
        assert len(rules) == 1
        assert rules[0] == ("geoip", "cn", False)

    def test_geoip_negated(self):
        rules = parse_rules(["geoip:!cn"])
        assert len(rules) == 1
        assert rules[0] == ("geoip", "cn", True)

    def test_mixed_rules(self):
        rules = parse_rules(["geosite:cn", "geoip:cn", "geosite:!google"])
        assert len(rules) == 3
        assert rules[0] == ("geosite", "cn", False)
        assert rules[1] == ("geoip", "cn", False)
        assert rules[2] == ("geosite", "google", True)

    def test_empty_and_comment_lines_skipped(self):
        rules = parse_rules(["", "# comment", "geosite:cn", "  ", "# another"])
        assert len(rules) == 1
        assert rules[0] == ("geosite", "cn", False)

    def test_invalid_format_skipped(self):
        rules = parse_rules(["geosite:", "geoip:", "invalid", "geosite:cn"])
        assert len(rules) == 1
        assert rules[0] == ("geosite", "cn", False)

    def test_case_insensitive_prefix(self):
        rules = parse_rules(["GEOSITE:cn", "GeoIP:us"])
        assert len(rules) == 2
        assert rules[0] == ("geosite", "cn", False)
        assert rules[1] == ("geoip", "us", False)


class TestMatchGeosite:
    def _make_engine(self, geosite_data=None):
        """Create a RoutingEngine with mock geosite data."""
        from unittest.mock import MagicMock
        engine = RoutingEngine.__new__(RoutingEngine)
        engine._enabled = True
        engine._default_action = "proxy"
        engine._direct_rules = []
        engine._proxy_rules = []
        mock_loader = MagicMock()
        mock_loader.geosite_available = True
        mock_loader.geoip_available = False
        mock_loader.get_geosite = lambda tag: (geosite_data or {}).get(tag, [])
        mock_loader.has_geosite = lambda tag: tag in (geosite_data or {})
        engine._loader = mock_loader
        return engine

    def test_domain_suffix_match(self):
        engine = self._make_engine({"cn": [("domain", "baidu.com")]})
        assert engine._match_geosite("baidu.com", "cn") is True
        assert engine._match_geosite("www.baidu.com", "cn") is True
        assert engine._match_geosite("a.b.baidu.com", "cn") is True
        assert engine._match_geosite("notbaidu.com", "cn") is False

    def test_domain_full_match(self):
        engine = self._make_engine({"cn": [("full", "qq.com")]})
        assert engine._match_geosite("qq.com", "cn") is True
        assert engine._match_geosite("www.qq.com", "cn") is False
        assert engine._match_geosite("notqq.com", "cn") is False

    def test_domain_plain_match(self):
        engine = self._make_engine({"cn": [("plain", "baidu")]})
        assert engine._match_geosite("baidu.com", "cn") is True
        assert engine._match_geosite("mybaidusite.com", "cn") is True
        assert engine._match_geosite("google.com", "cn") is False

    def test_domain_regex_match(self):
        engine = self._make_engine({"cn": [("regex", r"^test\d+\.com$")]})
        assert engine._match_geosite("test123.com", "cn") is True
        assert engine._match_geosite("test.com", "cn") is False
        assert engine._match_geosite("atest123.com", "cn") is False

    def test_unknown_tag_returns_false(self):
        engine = self._make_engine({"cn": [("domain", "baidu.com")]})
        assert engine._match_geosite("baidu.com", "us") is False

    def test_empty_rules_returns_false(self):
        engine = self._make_engine({"cn": []})
        assert engine._match_geosite("baidu.com", "cn") is False


class TestMatchGeoip:
    def _make_engine(self, geoip_data=None):
        from unittest.mock import MagicMock
        engine = RoutingEngine.__new__(RoutingEngine)
        engine._enabled = True
        engine._default_action = "proxy"
        engine._direct_rules = []
        engine._proxy_rules = []
        mock_loader = MagicMock()
        mock_loader.geosite_available = False
        mock_loader.geoip_available = True
        mock_loader.get_geoip = lambda code: (geoip_data or {}).get(code, [])
        mock_loader.has_geoip = lambda code: code in (geoip_data or {})
        engine._loader = mock_loader
        return engine

    def test_ipv4_in_cidr(self):
        engine = self._make_engine({"cn": [ipaddress.ip_network("1.2.3.0/24")]})
        assert engine._match_geoip("1.2.3.100", "cn") is True
        assert engine._match_geoip("1.2.3.0", "cn") is True
        assert engine._match_geoip("1.2.3.255", "cn") is True
        assert engine._match_geoip("1.2.4.0", "cn") is False

    def test_ipv6_in_cidr(self):
        engine = self._make_engine({"test": [ipaddress.ip_network("2001:db8::/32")]})
        assert engine._match_geoip("2001:db8::1", "test") is True
        assert engine._match_geoip("2001:db9::1", "test") is False

    def test_multiple_cidrs(self):
        engine = self._make_engine({"cn": [ipaddress.ip_network("1.2.3.0/24"), ipaddress.ip_network("10.0.0.0/8")]})
        assert engine._match_geoip("1.2.3.50", "cn") is True
        assert engine._match_geoip("10.1.2.3", "cn") is True
        assert engine._match_geoip("8.8.8.8", "cn") is False

    def test_unknown_code_returns_false(self):
        engine = self._make_engine({"cn": [ipaddress.ip_network("1.2.3.0/24")]})
        assert engine._match_geoip("1.2.3.50", "us") is False

    def test_invalid_ip_returns_false(self):
        engine = self._make_engine({"cn": [ipaddress.ip_network("1.2.3.0/24")]})
        assert engine._match_geoip("not-an-ip", "cn") is False
