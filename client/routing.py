"""
Routing engine for outbound traffic splitting.
Supports geosite (domain) and geoip (IP CIDR) rules.
"""

import ipaddress
import logging
import os
import re
import sys

from geodata_loader import GeodataLoader

logger = logging.getLogger("routing")


def _geodata_dir():
    """Locate geodata directory: compiled app uses executable dir, dev uses this file's dir."""
    if "__compiled__" in globals() or getattr(sys, "frozen", False):
        return os.path.join(os.path.dirname(sys.executable), "geodata")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "geodata")


def parse_rules(rule_strings):
    """Parse a list of rule strings into structured rule tuples.

    Each rule string format: "geosite:tag" or "geoip:code" (with optional "!" for negation)
    Returns: [(type, code, negated), ...]
      type: "geosite" or "geoip"
      code: country/tag name (lowercase)
      negated: bool (True if "!" prefix)

    Invalid or empty lines are silently skipped.
    """
    rules = []
    for line in rule_strings:
        line = line.strip()
        if not line or line.startswith("#"):
            continue

        if ":" not in line:
            logger.warning("Invalid rule (no colon): %s", line)
            continue

        prefix, _, code = line.partition(":")
        prefix = prefix.lower().strip()
        code = code.strip().lower()

        if prefix not in ("geosite", "geoip"):
            logger.warning("Unknown rule type: %s", prefix)
            continue
        if not code:
            logger.warning("Empty code in rule: %s", line)
            continue

        negated = False
        if code.startswith("!"):
            negated = True
            code = code[1:]
        if not code:
            logger.warning("Empty code after negation: %s", line)
            continue

        rules.append((prefix, code, negated))
    return rules


class RoutingEngine:
    """Routing engine that resolves hosts to 'direct' or 'proxy' actions."""

    def __init__(self, config, geodata_dir):
        self._enabled = config.get("enabled", False)
        self._default_action = config.get("default", "proxy")
        self._direct_rules = parse_rules(config.get("direct_rules", []))
        self._proxy_rules = parse_rules(config.get("proxy_rules", []))
        all_rules = self._direct_rules + self._proxy_rules
        needs_geosite = any(rule_type == "geosite" for rule_type, _, _ in all_rules)
        needs_geoip = any(rule_type == "geoip" for rule_type, _, _ in all_rules)
        self._loader = None
        if self._enabled and (needs_geosite or needs_geoip):
            # Selective eager load at construction (called from proxy start thread, not event loop).
            self._loader = GeodataLoader(
                geodata_dir,
                load_geosite=needs_geosite,
                load_geoip=needs_geoip,
            )

    def _geosite_available(self):
        return self._loader is not None and self._loader.geosite_available

    def _geoip_available(self):
        return self._loader is not None and self._loader.geoip_available

    def _geosite_tag_known(self, code):
        return self._geosite_available() and self._loader.has_geosite(code)

    def _geoip_code_known(self, code):
        return self._geoip_available() and self._loader.has_geoip(code)

    def _match_geosite(self, host, code):
        """Check if a domain matches geosite rules for the given country code.
        Returns False if geosite data or tag is not available (safe fallback).
        """
        if not self._geosite_tag_known(code):
            return False
        rules = self._loader.get_geosite(code)
        host_lower = host.lower()
        for rule_type, value in rules:
            if rule_type == "full":
                if host_lower == value:
                    return True
            elif rule_type == "domain":
                if host_lower == value or host_lower.endswith("." + value):
                    return True
            elif rule_type == "plain":
                if value in host_lower:
                    return True
            elif rule_type == "regex":
                try:
                    if re.search(value, host_lower):
                        return True
                except re.error:
                    pass
        return False

    def _match_geoip(self, host, code):
        """Check if an IP address matches geoip CIDR ranges for the given country code.
        Returns False if geoip data is not available (safe fallback).
        """
        if not self._geoip_available():
            return False
        if not self._geoip_code_known(code):
            return False
        networks = self._loader.get_geoip(code)
        try:
            addr = ipaddress.ip_address(host)
        except ValueError:
            return False
        return any(addr in net for net in networks)

    def resolve(self, host, is_domain):
        """Resolve a host to 'direct' or 'proxy'.

        Returns None if routing is disabled (caller should use default proxy behavior).

        Priority: direct rules > proxy rules > default action.
        Domain targets only match geosite rules; IP targets only match geoip rules.

        Safety: when geodata is unavailable, negated rules do NOT match
        (prevents catastrophic mis-routing on data load failure).
        """
        if not self._enabled:
            return None

        def _match_rules(rules):
            for rule_type, code, negated in rules:
                if rule_type == "geosite":
                    if not is_domain:
                        continue
                    # Data unavailable or unknown tag → rules must not match.
                    # This is especially important for negated rules.
                    if not self._geosite_tag_known(code):
                        if self._geosite_available():
                            logger.warning("Unknown geosite tag: %s", code)
                        continue
                    matched = self._match_geosite(host, code)
                elif rule_type == "geoip":
                    if is_domain:
                        continue
                    if not self._geoip_code_known(code):
                        if self._geoip_available():
                            logger.warning("Unknown geoip code: %s", code)
                        continue
                    matched = self._match_geoip(host, code)
                else:
                    continue

                if negated:
                    matched = not matched
                if matched:
                    return True
            return False

        if _match_rules(self._direct_rules):
            return "direct"
        if _match_rules(self._proxy_rules):
            return "proxy"
        return self._default_action
