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
