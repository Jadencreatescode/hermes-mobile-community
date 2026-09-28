import unicodedata
import sys
import json

print(f"Python {sys.version}")
print(f"unicodedata version: {unicodedata.unidata_version}")

pairs = [
    ("Strasse", "Stra\u00dfe"),
    ("\u00df", "ss"),
    ("\ufb00", "ff"),
    ("\ufb01", "fi"),
    ("\u03a3", "\u03c2"),
    ("\u0130", "i\u0307"),
    ("I", "\u0131"),
    ("\uff24arrell", "darrell"),
    ("\u00e9", "e\u0301"),
]

for a, b in pairs:
    print(f"  {repr(a)}.casefold() = {repr(a.casefold())}")
    print(f"  {repr(b)}.casefold() = {repr(b.casefold())}")
    print(f"  equal: {a.casefold() == b.casefold()}")
    print()

alpha_count = 0
alpha_ranges = []
start = None
prev = None

for cp in range(0x110000):
    if 0xD800 <= cp <= 0xDFFF:
        continue
    ch = chr(cp)
    if ch.isalpha():
        alpha_count += 1
        if start is None:
            start = cp
            prev = cp
        elif cp == prev + 1:
            prev = cp
        else:
            alpha_ranges.append((start, prev))
            start = cp
            prev = cp

if start is not None:
    alpha_ranges.append((start, prev))

print(f"Python isalpha count: {alpha_count}")
print(f"Number of ranges: {len(alpha_ranges)}")

for ch in ["\U0001E4D0", "\U0001E4D1", "\U0001E4D2", "\U0001E4D3", "\U00016D40", "\U0001E5D0"]:
    print(f"U+{ord(ch):04X}: isalpha={ch.isalpha()}, category={unicodedata.category(ch)}")

# Generate a compact JSON representation of alpha ranges
with open("/opt/data/workspace/hermes-public-bot-naming/apps/desktop/src/plugins/operations/bot-name-alpha-ranges.json", "w") as f:
    json.dump(alpha_ranges, f)

print(f"\nWrote alpha ranges to bot-name-alpha-ranges.json")
