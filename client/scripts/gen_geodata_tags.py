#!/usr/bin/env python3
"""
Build-time script to generate geodata_tags.json from geosite.dat and geoip.dat.
This file is shipped with the app to enable fast rule validation without parsing protobuf.
"""

import json
import os
import sys

# Add parent directory to path so we can import geodata_loader
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from geodata_loader import GeodataLoader


def main():
    geodata_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "geodata")
    output_path = os.path.join(geodata_dir, "geodata_tags.json")

    print(f"Parsing geodata from: {geodata_dir}")
    loader = GeodataLoader(geodata_dir, load_geosite=True, load_geoip=True)

    geosite_tags = sorted(loader._geosite_cache.keys()) if loader.geosite_available else []
    geoip_codes = sorted(loader._geoip_cache.keys()) if loader.geoip_available else []

    data = {
        "geosite": geosite_tags,
        "geoip": geoip_codes,
    }

    with open(output_path, "w") as f:
        json.dump(data, f)

    print(f"Generated {output_path}")
    print(f"  - {len(geosite_tags)} geosite tags")
    print(f"  - {len(geoip_codes)} geoip codes")


if __name__ == "__main__":
    main()
