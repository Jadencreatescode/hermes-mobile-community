import unicodedata
import json

# Find all code points where Python casefold differs from lower()
differences = {}
for cp in range(0x110000):
    if 0xD800 <= cp <= 0xDFFF:
        continue
    ch = chr(cp)
    lower = ch.lower()
    casefold = ch.casefold()
    if lower != casefold:
        differences[cp] = casefold

print(f"Code points where casefold != lower: {len(differences)}")

# Group by the casefold result
by_result = {}
for cp, result in differences.items():
    key = result
    by_result.setdefault(key, []).append(cp)

print(f"Unique casefold results: {len(by_result)}")

# Print some examples
for cp in list(differences.keys())[:20]:
    ch = chr(cp)
    print(f"U+{cp:04X} ({ch!r}): lower={ch.lower()!r}, casefold={ch.casefold()!r}")

# Create a compact mapping: code point -> casefold result (only where different)
mapping = {cp: casefold for cp, casefold in differences.items()}

# Write as a JSON object
with open("/opt/data/workspace/hermes-public-bot-naming/apps/desktop/src/plugins/operations/bot-name-casefold.json", "w") as f:
    json.dump(mapping, f, ensure_ascii=False)

print(f"\nWrote casefold mapping to bot-name-casefold.json ({len(mapping)} entries)")
