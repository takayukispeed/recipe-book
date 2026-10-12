#!/usr/bin/env python3
"""Fill in missing lat/lng in places/<city>/*.md from each address, using OpenStreetMap's
Nominatim geocoder (free, 1 request a second). Runs on GitHub after places change.

Usage: python3 scripts/geocode_places.py
"""
import json
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AGENT = "recipe-book-places/1.0 (personal restaurant list; github.com)"


def field(text, key):
    m = re.search(rf"^{key}:[ \t]*(.*)$", text, re.M)
    return m.group(1).strip() if m else ""


def geocode(query):
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": query, "format": "jsonv2", "limit": 1})
    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(req, timeout=20) as res:
        hits = json.load(res)
    return (float(hits[0]["lat"]), float(hits[0]["lon"])) if hits else None


def main():
    filled = 0
    for path in sorted(ROOT.glob("places/*/*.md")):
        text = path.read_text(encoding="utf-8")
        if not text.startswith("---") or (field(text, "lat") and field(text, "lng")):
            continue
        address = field(text, "address")
        if not address:
            continue
        try:
            hit = geocode(address)
            time.sleep(1.1)
            if not hit:  # "(basement)" notes and postal codes can confuse the geocoder
                hit = geocode(re.sub(r"\s*\([^)]*\)|,?\s*[A-Z]\d[A-Z] ?\d[A-Z]\d", "", address))
                time.sleep(1.1)
        except Exception as err:  # network trouble: leave it for the next run
            print(f"{path.relative_to(ROOT)}: {err}")
            continue
        if not hit:
            print(f"{path.relative_to(ROOT)}: not found ({address})")
            continue
        text = re.sub(r"^lat:.*$", f"lat: {hit[0]:.6f}", text, count=1, flags=re.M)
        text = re.sub(r"^lng:.*$", f"lng: {hit[1]:.6f}", text, count=1, flags=re.M)
        path.write_text(text, encoding="utf-8")
        filled += 1
    print(f"geocoded {filled} places")


if __name__ == "__main__":
    main()
