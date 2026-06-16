import os
import sys
import ipaddress
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from routing import parse_rules


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
