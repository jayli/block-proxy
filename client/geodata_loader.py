"""
Load and parse Xray/V2Ray compatible geoip.dat and geosite.dat files.
Uses the proto_parser module for zero-dependency protobuf parsing.
"""

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
