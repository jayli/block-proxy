"""
Load and parse Xray/V2Ray compatible geoip.dat and geosite.dat files.
Uses the proto_parser module for zero-dependency protobuf parsing.
"""

import ipaddress
import logging
import os
from proto_parser import parse_message, get_string, get_bytes, get_varint, get_message

logger = logging.getLogger("geodata_loader")

# Domain type mapping: protobuf enum → string
_DOMAIN_TYPES = {0: "plain", 1: "regex", 2: "domain", 3: "full"}


def parse_geosite_data(data):
    """Parse GeoSiteList protobuf bytes into a dict.

    Returns: {country_code(str): [(type_str, value_str), ...]}
    country_code is lowercased.
    """
    result = {}
    top_fields = parse_message(data)

    for fn, wt, val in top_fields:
        if fn != 1 or wt != 2:
            continue
        # Each field 1 is a GeoSite message
        site_fields = parse_message(val)
        country_code = get_string(site_fields, 1, "").lower()
        if not country_code:
            continue

        domains = []
        for sfn, swt, sval in site_fields:
            if sfn != 2 or swt != 2:
                continue
            # Each field 2 is a Domain message
            domain_fields = parse_message(sval)
            domain_type = _DOMAIN_TYPES.get(get_varint(domain_fields, 1, 0), "plain")
            domain_value = get_string(domain_fields, 2, "")
            if domain_value:
                domains.append((domain_type, domain_value))

        if domains:
            result[country_code] = domains

    return result


def parse_geoip_data(data):
    """Parse GeoIPList protobuf bytes into a dict.

    Returns: {country_code(str): [ipaddress.IPv4Network/IPV6Network, ...]}
    country_code is lowercased.
    """
    result = {}
    top_fields = parse_message(data)

    for fn, wt, val in top_fields:
        if fn != 1 or wt != 2:
            continue
        # Each field 1 is a GeoIP message
        geoip_fields = parse_message(val)
        country_code = get_string(geoip_fields, 1, "").lower()
        if not country_code:
            continue

        networks = []
        for gfn, gwt, gval in geoip_fields:
            if gfn != 2 or gwt != 2:
                continue
            # Each field 2 is a CIDR message
            cidr_fields = parse_message(gval)
            ip_bytes = get_bytes(cidr_fields, 1, b"")
            prefix = get_varint(cidr_fields, 2, 0)
            if not ip_bytes:
                continue
            try:
                addr = ipaddress.ip_address(ip_bytes)
                net = ipaddress.ip_network(f"{addr}/{prefix}", strict=False)
                networks.append(net)
            except ValueError:
                continue

        if networks:
            result[country_code] = networks

    return result


class GeodataLoader:
    """Selective eager-loading geodata file parser."""

    def __init__(self, data_dir, load_geosite=True, load_geoip=True):
        self._data_dir = data_dir
        self._geosite_cache = {}  # {tag: [(type, value), ...]}
        self._geoip_cache = {}    # {code: [IPv4Network/IPv6Network, ...]}
        self._geosite_loaded = False
        self._geoip_loaded = False
        if load_geosite:
            self._load_geosite()
        if load_geoip:
            self._load_geoip()

    def _load_geosite(self):
        geosite_path = os.path.join(self._data_dir, "geosite.dat")
        if os.path.exists(geosite_path):
            try:
                with open(geosite_path, "rb") as f:
                    self._geosite_cache = parse_geosite_data(f.read())
                self._geosite_loaded = True
                logger.info("Loaded geosite.dat: %d tags", len(self._geosite_cache))
            except Exception:
                logger.warning("Failed to parse geosite.dat", exc_info=True)
        else:
            logger.warning("geosite.dat not found: %s", geosite_path)

    def _load_geoip(self):
        geoip_path = os.path.join(self._data_dir, "geoip.dat")
        if os.path.exists(geoip_path):
            try:
                with open(geoip_path, "rb") as f:
                    self._geoip_cache = parse_geoip_data(f.read())
                self._geoip_loaded = True
                logger.info("Loaded geoip.dat: %d codes", len(self._geoip_cache))
            except Exception:
                logger.warning("Failed to parse geoip.dat", exc_info=True)
        else:
            logger.warning("geoip.dat not found: %s", geoip_path)

    @property
    def geosite_available(self):
        return self._geosite_loaded

    @property
    def geoip_available(self):
        return self._geoip_loaded

    def get_geosite(self, tag):
        """Get domain rules for a geosite tag. Returns list of (type, value)."""
        return self._geosite_cache.get(tag.lower(), [])

    def has_geosite(self, tag):
        """Return True when the geosite tag exists in loaded data."""
        return tag.lower() in self._geosite_cache

    def get_geoip(self, code):
        """Get CIDR networks for a geoip country code. Returns list of IPNetwork."""
        return self._geoip_cache.get(code.lower(), [])

    def has_geoip(self, code):
        """Return True when the geoip code exists in loaded data."""
        return code.lower() in self._geoip_cache
