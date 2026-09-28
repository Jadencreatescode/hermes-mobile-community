import unicodedata
import json
import sys
from pathlib import Path

print(f"Python {sys.version}")
print(f"unicodedata version: {unicodedata.unidata_version}")

spaces = []
for cp in range(0x110000):
    if 0xD800 <= cp <= 0xDFFF:
        continue
    ch = chr(cp)
    if ch.isspace():
        spaces.append(cp)

print(f"Whitespace code points count: {len(spaces)}")
print(f"First 30: {spaces[:30]}")
print(f"U+FEFF is space: {chr(0xFEFF).isspace()}")
print(f"U+001C is space: {chr(0x001C).isspace()}")
print(f"U+001D is space: {chr(0x001D).isspace()}")
print(f"U+001E is space: {chr(0x001E).isspace()}")
print(f"U+001F is space: {chr(0x001F).isspace()}")
print(f"U+0085 is space: {chr(0x0085).isspace()}")

# Generate compact JSON representation of whitespace ranges
ranges = []
start = None
prev = None
for cp in spaces:
    if start is None:
        start = cp
        prev = cp
    elif cp == prev + 1:
        prev = cp
    else:
        ranges.append([start, prev])
        start = cp
        prev = cp
if start is not None:
    ranges.append([start, prev])

output_path = Path(__file__).resolve().parents[1] / "apps/desktop/src/plugins/operations/bot-name-whitespace-ranges.json"
with open(output_path, "w") as f:
    json.dump(ranges, f)

print(f"Wrote {len(ranges)} whitespace ranges to {output_path}")
