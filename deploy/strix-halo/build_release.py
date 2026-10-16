#!/usr/bin/env python3
"""Build a deterministic Hermes Mobile Strix Halo release archive."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import os
import shutil
import tarfile
import tempfile
from pathlib import Path


def _copy_renderer(source: Path, destination: Path) -> None:
    excluded = {"electron-main.mjs", "electron-preload.js", "node_modules"}

    def ignore(path: str, names: list[str]) -> set[str]:
        return excluded.intersection(names) if Path(path) == source else set()

    shutil.copytree(source, destination, ignore=ignore)


def _normalize_tree(root: Path) -> None:
    executables = {"install", "rollback", "uninstall"}
    for path in [root, *root.rglob("*")]:
        if path.is_symlink():
            raise RuntimeError(f"Release tree contains a symlink: {path}")
        os.chmod(path, 0o755 if path.is_dir() or path.name in executables else 0o644)


def build(repo: Path, output: Path, version: str, source_commit: str) -> Path:
    renderer = repo / "apps" / "desktop" / "dist"
    if not (renderer / "index.html").is_file():
        raise RuntimeError("Desktop renderer is not built; run npm run build in apps/desktop")
    name = f"Hermes-Mobile-Strix-Halo-v{version}"
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="hermes-mobile-release-") as temporary:
        stage = Path(temporary) / name
        stage.mkdir()
        _copy_renderer(renderer, stage / "dist")
        (stage / "server").mkdir()
        shutil.copy2(repo / "server" / "mobile_relay.py", stage / "server" / "mobile_relay.py")
        deploy = repo / "deploy" / "strix-halo"
        for filename in ("installer.py", "install", "rollback", "uninstall", "README.md"):
            shutil.copy2(deploy / filename, stage / filename)
        (stage / "VERSION").write_text(version + "\n", encoding="utf-8")
        (stage / "SOURCE_COMMIT").write_text(source_commit + "\n", encoding="utf-8")
        _normalize_tree(stage)
        entries = []
        for path in sorted(item for item in stage.rglob("*") if item.is_file()):
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            entries.append(f"{digest}  {path.relative_to(stage).as_posix()}")
        (stage / "MANIFEST.sha256").write_text("\n".join(entries) + "\n", encoding="utf-8")
        os.chmod(stage / "MANIFEST.sha256", 0o644)

        def normalize(info: tarfile.TarInfo) -> tarfile.TarInfo:
            info.uid = 0
            info.gid = 0
            info.uname = ""
            info.gname = ""
            info.mtime = 0
            info.mode = 0o755 if info.isdir() or Path(info.name).name in {"install", "rollback", "uninstall"} else 0o644
            return info

        with output.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                    archive.add(stage, arcname=name, recursive=False, filter=normalize)
                    for path in sorted(stage.rglob("*"), key=lambda item: item.relative_to(stage).as_posix()):
                        archive.add(path, arcname=f"{name}/{path.relative_to(stage).as_posix()}", recursive=False, filter=normalize)
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-commit", required=True)
    args = parser.parse_args()
    archive = build(args.repo.resolve(), args.output.resolve(), args.version, args.source_commit)
    print(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
