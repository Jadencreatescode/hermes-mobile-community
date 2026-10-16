#!/usr/bin/env python3
"""Verify an exact Hermes Mobile release archive without extracting it."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import tarfile
from pathlib import PurePosixPath

DIGEST_LINE = re.compile(r"^([0-9a-f]{64})  (.+)$")


def verify(path, expected_version: str | None = None, expected_commit: str | None = None) -> dict:
    with tarfile.open(path, "r:gz") as archive:
        members = archive.getmembers()
        names: set[str] = set()
        roots: set[str] = set()
        for member in members:
            candidate = PurePosixPath(member.name)
            if (
                member.name in names
                or candidate.is_absolute()
                or ".." in candidate.parts
                or member.issym()
                or member.islnk()
                or not (member.isfile() or member.isdir())
            ):
                raise RuntimeError(f"Unsafe archive member: {member.name}")
            names.add(member.name)
            if candidate.parts:
                roots.add(candidate.parts[0])
        if len(roots) != 1:
            raise RuntimeError("Archive must contain exactly one top-level directory")
        root = next(iter(roots))

        def read(relative: str) -> bytes:
            member = archive.getmember(f"{root}/{relative}")
            handle = archive.extractfile(member)
            if handle is None:
                raise RuntimeError(f"Archive member is not a file: {relative}")
            return handle.read()

        version = read("VERSION").decode("utf-8").strip()
        source_commit = read("SOURCE_COMMIT").decode("utf-8").strip()
        if expected_version is not None and version != expected_version:
            raise RuntimeError(f"Version mismatch: {version}")
        if expected_commit is not None and source_commit != expected_commit:
            raise RuntimeError(f"Source commit mismatch: {source_commit}")
        manifest: dict[str, str] = {}
        for line in read("MANIFEST.sha256").decode("utf-8").splitlines():
            match = DIGEST_LINE.fullmatch(line)
            if not match or match.group(2) in manifest:
                raise RuntimeError("Malformed or duplicate manifest entry")
            relative = match.group(2)
            candidate = PurePosixPath(relative)
            if candidate.is_absolute() or ".." in candidate.parts or "\\" in relative:
                raise RuntimeError(f"Unsafe manifest path: {relative}")
            manifest[relative] = match.group(1)
        actual_files = {
            member.name.removeprefix(root + "/")
            for member in members
            if member.isfile() and member.name != f"{root}/MANIFEST.sha256"
        }
        if actual_files != set(manifest):
            raise RuntimeError("Manifest does not match the exact archive file set")
        for relative, expected in manifest.items():
            actual = hashlib.sha256(read(relative)).hexdigest()
            if actual != expected:
                raise RuntimeError(f"Digest mismatch: {relative}")
    return {
        "archive_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "members": len(members),
        "manifest_entries": len(manifest),
        "version": version,
        "source_commit": source_commit,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("archive", type=__import__("pathlib").Path)
    parser.add_argument("--version")
    parser.add_argument("--source-commit")
    args = parser.parse_args()
    print(json.dumps(verify(args.archive, args.version, args.source_commit), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
