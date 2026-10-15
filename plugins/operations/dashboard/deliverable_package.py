"""Deterministic, bounded ``deliverable_package_v1`` builder and verifier.

A deliverable package is the only public evidence shape a production meeting can
approve. It is a ZIP archive whose member set is exactly the canonical manifest
(``deliverable.json``) plus every file the manifest declares, built so that two
runs over identical bytes produce byte-identical archives.

Everything here treats manifest text and package bytes as untrusted data: paths
are validated as safe relative POSIX paths, digests and sizes are recomputed from
the real bytes, and preview policy is an allowlist rather than a sniff.

``game_sha256`` is the certified compatibility name for the manifest's
primary-file digest. It carries no game-specific meaning: for a document, an
audio asset, or a web app it is simply the digest of ``primary_file``.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import stat
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

PACKAGE_SCHEMA = "deliverable_package_v1"
PACKAGE_SCHEMA_VERSION = 1
MANIFEST_MEMBER = "deliverable.json"

# Recommended public starting limits (see docs/public-operations-pack.md).
MAX_PACKAGE_TOTAL_BYTES = 64 * 1024 * 1024
MAX_PACKAGE_FILE_BYTES = 16 * 1024 * 1024
MAX_MANIFEST_BYTES = 256 * 1024
MAX_PACKAGE_FILES = 256
MAX_PATH_CHARS = 512
MAX_PATH_SEGMENTS = 16
MAX_TITLE_CHARS = 200
MAX_SUMMARY_CHARS = 4_000
MAX_MEDIA_TYPE_CHARS = 128
MAX_ROLE_CHARS = 64

# Preview caps for the authenticated artifact endpoint.
MAX_TEXT_PREVIEW_BYTES = 256 * 1024
MAX_IMAGE_PREVIEW_BYTES = 4 * 1024 * 1024

PRODUCT_KINDS = frozenset({
    "interactive_web_app",
    "three_scene",
    "audio_asset",
    "video_asset",
    "document",
})

PREVIEW_POLICIES = frozenset({"text", "image", "download_only"})

# Media types that may be previewed inline, per policy. Anything absent here is
# download-only regardless of what the manifest asked for.
_TEXT_PREVIEW_MEDIA_TYPES = frozenset({
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
})
_IMAGE_PREVIEW_MEDIA_TYPES = frozenset({
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
})

_SHA256_CHARS = frozenset("0123456789abcdef")
_MANIFEST_FIELDS = frozenset({
    "schema",
    "product_kind",
    "title",
    "summary",
    "primary_file",
    "files",
})
_FILE_FIELDS = frozenset({
    "path",
    "media_type",
    "role",
    "preview_policy",
    "byte_size",
    "sha256",
})

_ZIP_DATE_TIME = (1980, 1, 1, 0, 0, 0)
_ZIP_MEMBER_MODE = 0o644
_ZIP_CREATE_SYSTEM = 3  # Unix, so the mode bits above are stable across hosts.


class PackageInvalid(ValueError):
    """The manifest, the workspace tree, or the archive is not a valid package."""


class PackageLimitExceeded(PackageInvalid):
    """The package exceeds a declared public bound."""


@dataclass(frozen=True)
class BuiltPackage:
    manifest: dict[str, Any]
    manifest_bytes: bytes
    manifest_sha256: str
    game_sha256: str
    zip_bytes: bytes
    zip_sha256: str
    total_byte_size: int
    schema_version: int = PACKAGE_SCHEMA_VERSION


@dataclass(frozen=True)
class PackageMember:
    path: str
    payload: bytes
    media_type: str
    preview_policy: str
    role: str
    sha256: str


def _digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def canonical_manifest_bytes(manifest: Mapping[str, Any]) -> bytes:
    """Serialize a manifest to its single canonical byte form."""
    try:
        return json.dumps(
            manifest,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise PackageInvalid("manifest is not canonical JSON") from exc


def manifest_digest(manifest: Mapping[str, Any]) -> str:
    return _digest(canonical_manifest_bytes(manifest))


def _text(value: object, field: str, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum or "\x00" in value:
        raise PackageInvalid(f"manifest {field} is invalid")
    return value


def _sha256_field(value: object, field: str) -> str:
    if not isinstance(value, str) or len(value) != 64 or set(value) - _SHA256_CHARS:
        raise PackageInvalid(f"manifest {field} is not a lowercase SHA-256 digest")
    return value


def _byte_size(value: object, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise PackageInvalid(f"manifest {field} is invalid")
    if value > MAX_PACKAGE_FILE_BYTES:
        raise PackageLimitExceeded(f"manifest {field} exceeds the per-file byte limit")
    return value


def safe_package_path(value: object) -> str:
    """Validate one manifest path as a safe relative POSIX path."""
    if not isinstance(value, str) or not value:
        raise PackageInvalid("package path is invalid")
    if len(value) > MAX_PATH_CHARS:
        raise PackageLimitExceeded("package path exceeds the length limit")
    if "\x00" in value or "\\" in value or "\r" in value or "\n" in value:
        raise PackageInvalid("package path contains an illegal character")
    if value != unicodedata.normalize("NFC", value):
        raise PackageInvalid("package path is not NFC normalized")
    if value.startswith("/") or value.endswith("/"):
        raise PackageInvalid("package path must be relative without a trailing slash")
    if ":" in value:
        raise PackageInvalid("package path must not name a drive or stream")
    segments = value.split("/")
    if not 1 <= len(segments) <= MAX_PATH_SEGMENTS:
        raise PackageInvalid("package path depth is invalid")
    for segment in segments:
        if not segment or segment in {".", ".."}:
            raise PackageInvalid("package path contains an illegal segment")
        if segment != segment.strip() or segment.endswith("."):
            raise PackageInvalid("package path segment is not portable")
    if value == MANIFEST_MEMBER:
        raise PackageInvalid("package path cannot shadow the manifest member")
    normalized = PurePosixPath(value)
    if normalized.is_absolute() or str(normalized) != value:
        raise PackageInvalid("package path is not normalized")
    return value


def _preview_policy(value: object, media_type: str, field: str) -> str:
    if not isinstance(value, str) or value not in PREVIEW_POLICIES:
        raise PackageInvalid(f"manifest {field} preview_policy is not supported")
    if value == "text" and media_type not in _TEXT_PREVIEW_MEDIA_TYPES:
        raise PackageInvalid(f"manifest {field} preview_policy is not allowed for {media_type}")
    if value == "image" and media_type not in _IMAGE_PREVIEW_MEDIA_TYPES:
        raise PackageInvalid(f"manifest {field} preview_policy is not allowed for {media_type}")
    return value


def preview_disposition(media_type: str, preview_policy: str) -> str:
    """Return ``inline`` only for a policy-approved, inline-safe media type."""
    if preview_policy == "text" and media_type in _TEXT_PREVIEW_MEDIA_TYPES:
        return "inline"
    if preview_policy == "image" and media_type in _IMAGE_PREVIEW_MEDIA_TYPES:
        return "inline"
    return "attachment"


def preview_byte_cap(preview_policy: str) -> int:
    if preview_policy == "text":
        return MAX_TEXT_PREVIEW_BYTES
    if preview_policy == "image":
        return MAX_IMAGE_PREVIEW_BYTES
    return 0


def validate_manifest(value: object) -> dict[str, Any]:
    """Validate and canonicalize an untrusted ``deliverable.json`` document."""
    if not isinstance(value, Mapping):
        raise PackageInvalid("manifest must be an object")
    unknown = set(value) - _MANIFEST_FIELDS
    if unknown or not _MANIFEST_FIELDS.issubset(value):
        raise PackageInvalid("manifest fields are invalid")
    if value["schema"] != PACKAGE_SCHEMA:
        raise PackageInvalid("manifest schema is not deliverable_package_v1")

    product_kind = value["product_kind"]
    if not isinstance(product_kind, str) or product_kind not in PRODUCT_KINDS:
        raise PackageInvalid("manifest product_kind is not a public package kind")

    rows = value["files"]
    if not isinstance(rows, list) or not rows:
        raise PackageInvalid("manifest files must be a non-empty array")
    if len(rows) > MAX_PACKAGE_FILES:
        raise PackageLimitExceeded("manifest declares too many files")

    files: list[dict[str, Any]] = []
    seen: set[str] = set()
    folded: set[str] = set()
    total = 0
    for index, row in enumerate(rows):
        if not isinstance(row, Mapping) or set(row) != _FILE_FIELDS:
            raise PackageInvalid(f"manifest files[{index}] fields are invalid")
        path = safe_package_path(row["path"])
        key = path.casefold()
        if path in seen:
            raise PackageInvalid("manifest declares a duplicate path")
        if key in folded:
            raise PackageInvalid("manifest declares a case-fold path collision")
        seen.add(path)
        folded.add(key)
        media_type = _text(row["media_type"], f"files[{index}].media_type", MAX_MEDIA_TYPE_CHARS)
        byte_size = _byte_size(row["byte_size"], f"files[{index}].byte_size")
        total += byte_size
        if total > MAX_PACKAGE_TOTAL_BYTES:
            raise PackageLimitExceeded("manifest exceeds the total uncompressed byte limit")
        files.append({
            "path": path,
            "media_type": media_type,
            "role": _text(row["role"], f"files[{index}].role", MAX_ROLE_CHARS),
            "preview_policy": _preview_policy(row["preview_policy"], media_type, f"files[{index}]"),
            "byte_size": byte_size,
            "sha256": _sha256_field(row["sha256"], f"files[{index}].sha256"),
        })

    primary_file = safe_package_path(value["primary_file"])
    if primary_file not in seen:
        raise PackageInvalid("manifest primary_file is not a declared file")

    manifest = {
        "schema": PACKAGE_SCHEMA,
        "product_kind": product_kind,
        "title": _text(value["title"], "title", MAX_TITLE_CHARS),
        "summary": _text(value["summary"], "summary", MAX_SUMMARY_CHARS),
        "primary_file": primary_file,
        "files": sorted(files, key=lambda row: row["path"]),
    }
    encoded = canonical_manifest_bytes(manifest)
    if len(encoded) > MAX_MANIFEST_BYTES:
        raise PackageLimitExceeded("manifest exceeds the serialized manifest byte limit")
    return manifest


def _open_root(root: Path) -> int:
    try:
        return os.open(root, os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        raise PackageInvalid("package root is not a real directory") from exc


def _open_child_dir(parent_fd: int, name: str) -> int:
    try:
        return os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
    except OSError as exc:
        raise PackageInvalid("package directory is not a real directory") from exc


def _read_member_bytes(root_fd: int, path: str, *, declared_size: int) -> bytes:
    """Read one declared file with descriptor-relative no-follow traversal."""
    segments = path.split("/")
    fds: list[int] = []
    current = root_fd
    try:
        for segment in segments[:-1]:
            current = _open_child_dir(current, segment)
            fds.append(current)
        try:
            handle = os.open(
                segments[-1],
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=current,
            )
        except OSError as exc:
            raise PackageInvalid(f"declared file is missing or not a real file: {path}") from exc
        try:
            info = os.fstat(handle)
            if not stat.S_ISREG(info.st_mode):
                raise PackageInvalid(f"declared file is not a regular file: {path}")
            if info.st_nlink > 1:
                raise PackageInvalid(f"declared file is hard linked: {path}")
            if info.st_size > MAX_PACKAGE_FILE_BYTES:
                raise PackageLimitExceeded(f"declared file exceeds the per-file byte limit: {path}")
            if info.st_size != declared_size:
                raise PackageInvalid(f"declared byte_size does not match the file size: {path}")
            with os.fdopen(handle, "rb", closefd=True) as stream:
                handle = -1
                payload = stream.read(MAX_PACKAGE_FILE_BYTES + 1)
        finally:
            if handle >= 0:
                os.close(handle)
    finally:
        for descriptor in reversed(fds):
            os.close(descriptor)
    if len(payload) > MAX_PACKAGE_FILE_BYTES:
        raise PackageLimitExceeded(f"declared file exceeds the per-file byte limit: {path}")
    return payload


def _declared_tree_entries(root_fd: int, prefix: str = "") -> set[str]:
    """Enumerate the real tree without following any symlink."""
    entries: set[str] = set()
    with os.scandir(root_fd) as scanner:
        for entry in scanner:
            name = entry.name
            relative = f"{prefix}{name}"
            info = os.lstat(name, dir_fd=root_fd)
            mode = info.st_mode
            if stat.S_ISLNK(mode):
                raise PackageInvalid(f"package tree contains a symbolic link: {relative}")
            if stat.S_ISDIR(mode):
                child = _open_child_dir(root_fd, name)
                try:
                    entries |= _declared_tree_entries(child, f"{relative}/")
                finally:
                    os.close(child)
                continue
            if not stat.S_ISREG(mode):
                raise PackageInvalid(f"package tree contains a special file: {relative}")
            if info.st_nlink > 1:
                raise PackageInvalid(f"package tree contains a hard link: {relative}")
            if len(entries) >= MAX_PACKAGE_FILES + 1:
                raise PackageLimitExceeded("package tree contains too many files")
            entries.add(relative)
    return entries


def deterministic_zip_bytes(members: list[tuple[str, bytes]]) -> bytes:
    """Serialize members into a byte-stable archive."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, payload in sorted(members, key=lambda row: row[0]):
            info = zipfile.ZipInfo(filename=name, date_time=_ZIP_DATE_TIME)
            info.create_system = _ZIP_CREATE_SYSTEM
            info.external_attr = (_ZIP_MEMBER_MODE & 0xFFFF) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, payload)
    return buffer.getvalue()


def build_package(output_root: Path | str, manifest: Mapping[str, Any]) -> BuiltPackage:
    """Validate a workspace ``output`` tree and build its deterministic package."""
    root_fd = _open_root(Path(output_root))
    try:
        return build_package_from_descriptor(root_fd, manifest)
    finally:
        os.close(root_fd)


def build_package_from_descriptor(root_fd: int, manifest: Mapping[str, Any]) -> BuiltPackage:
    """Build from an ALREADY-OPEN, pinned ``output`` directory descriptor.

    The caller keeps ownership of ``root_fd``. Every byte of the package is
    read through it, so a collector that validated its traversal by descriptor
    never has to reopen a pathname — there is no window in which a swapped
    ancestor could substitute a different tree between check and build.
    """
    canonical = validate_manifest(manifest)
    present = _declared_tree_entries(root_fd)
    declared = {row["path"] for row in canonical["files"]}
    undeclared = sorted(present - declared - {MANIFEST_MEMBER})
    if undeclared:
        raise PackageInvalid(f"package tree contains an undeclared file: {undeclared[0]}")
    missing = sorted(declared - present)
    if missing:
        raise PackageInvalid(f"declared file is missing or not a real file: {missing[0]}")

    members: list[tuple[str, bytes]] = []
    total = 0
    primary_payload: bytes | None = None
    for row in canonical["files"]:
        payload = _read_member_bytes(root_fd, row["path"], declared_size=row["byte_size"])
        actual = _digest(payload)
        if actual != row["sha256"]:
            raise PackageInvalid(
                f"declared sha256 digest does not match the file bytes: {row['path']}"
            )
        total += len(payload)
        if total > MAX_PACKAGE_TOTAL_BYTES:
            raise PackageLimitExceeded("package exceeds the total uncompressed byte limit")
        members.append((row["path"], payload))
        if row["path"] == canonical["primary_file"]:
            primary_payload = payload

    if primary_payload is None:  # pragma: no cover - validate_manifest guarantees this
        raise PackageInvalid("manifest primary_file is not a declared file")

    manifest_bytes = canonical_manifest_bytes(canonical)
    members.append((MANIFEST_MEMBER, manifest_bytes))
    zip_bytes = deterministic_zip_bytes(members)
    return BuiltPackage(
        manifest=canonical,
        manifest_bytes=manifest_bytes,
        manifest_sha256=_digest(manifest_bytes),
        game_sha256=_digest(primary_payload),
        zip_bytes=zip_bytes,
        zip_sha256=_digest(zip_bytes),
        total_byte_size=total,
    )


def _open_archive(payload: bytes) -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(io.BytesIO(payload))
    except (zipfile.BadZipFile, OSError) as exc:
        raise PackageInvalid("package archive is unreadable") from exc


def _archive_manifest(archive: zipfile.ZipFile) -> tuple[dict[str, Any], bytes]:
    try:
        raw = archive.read(MANIFEST_MEMBER)
    except KeyError as exc:
        raise PackageInvalid("package archive has no manifest member") from exc
    if len(raw) > MAX_MANIFEST_BYTES:
        raise PackageLimitExceeded("package manifest exceeds the manifest byte limit")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise PackageInvalid("package manifest is not valid JSON") from exc
    canonical = validate_manifest(parsed)
    if canonical_manifest_bytes(canonical) != raw:
        raise PackageInvalid("package manifest is not canonically encoded")
    return canonical, raw


def verify_package_bytes(
    payload: bytes,
    *,
    manifest_sha256: str,
    game_sha256: str,
    zip_sha256: str,
) -> dict[str, Any]:
    """Run every deterministic package check and report each outcome by name.

    The result is intentionally structured rather than boolean: an independent
    review may not record a verified verdict while any mandatory check fails.
    """
    checks: dict[str, bool] = {}
    detail: list[str] = []

    checks["zip_digest"] = _digest(payload) == zip_sha256
    try:
        archive = _open_archive(payload)
    except PackageInvalid as exc:
        checks["archive_readable"] = False
        detail.append(str(exc))
        return _verify_result(checks, detail, None)

    checks["archive_readable"] = True
    with archive:
        try:
            manifest, manifest_bytes = _archive_manifest(archive)
        except PackageInvalid as exc:
            checks["manifest_canonical"] = False
            detail.append(str(exc))
            return _verify_result(checks, detail, None)

        checks["manifest_canonical"] = True
        checks["manifest_digest"] = _digest(manifest_bytes) == manifest_sha256

        declared = {row["path"] for row in manifest["files"]}
        names = [info.filename for info in archive.infolist()]
        checks["archive_member_set"] = set(names) == declared | {MANIFEST_MEMBER}
        checks["archive_member_order"] = names == sorted(names)
        checks["archive_metadata_fixed"] = all(
            info.date_time == _ZIP_DATE_TIME and info.external_attr >> 16 == _ZIP_MEMBER_MODE
            for info in archive.infolist()
        )

        per_file = True
        primary_digest = ""
        for row in manifest["files"]:
            try:
                member = archive.read(row["path"])
            except KeyError:
                per_file = False
                detail.append(f"missing member: {row['path']}")
                continue
            if len(member) != row["byte_size"] or _digest(member) != row["sha256"]:
                per_file = False
                detail.append(f"member digest or size mismatch: {row['path']}")
            if row["path"] == manifest["primary_file"]:
                primary_digest = _digest(member)
        checks["per_file_digest"] = per_file
        checks["primary_file_digest"] = bool(primary_digest) and primary_digest == game_sha256
        checks["preview_policy_safe"] = all(
            row["preview_policy"] in PREVIEW_POLICIES
            and (
                row["preview_policy"] == "download_only"
                or preview_disposition(row["media_type"], row["preview_policy"]) == "inline"
            )
            for row in manifest["files"]
        )
        return _verify_result(checks, detail, manifest)


def _verify_result(
    checks: Mapping[str, bool],
    detail: list[str],
    manifest: dict[str, Any] | None,
) -> dict[str, Any]:
    failed = sorted(name for name, passed in checks.items() if not passed)
    return {
        "ok": not failed,
        "checks": dict(sorted(checks.items())),
        "failed_checks": failed,
        "detail": detail[:16],
        "manifest": manifest,
    }


def read_package_member(payload: bytes, path: str) -> PackageMember:
    """Return one declared member after revalidating its stored digest."""
    try:
        requested = safe_package_path(path)
    except PackageInvalid as exc:
        raise PackageInvalid("requested member path is not declared (traversal refused)") from exc
    with _open_archive(payload) as archive:
        manifest, _ = _archive_manifest(archive)
        row = next((item for item in manifest["files"] if item["path"] == requested), None)
        if row is None:
            raise PackageInvalid("requested member is not declared in the manifest")
        try:
            member = archive.read(requested)
        except KeyError as exc:
            raise PackageInvalid("requested member is not declared in the archive") from exc
    if len(member) != row["byte_size"] or _digest(member) != row["sha256"]:
        raise PackageInvalid("stored member digest does not match the manifest")
    return PackageMember(
        path=requested,
        payload=member,
        media_type=row["media_type"],
        preview_policy=row["preview_policy"],
        role=row["role"],
        sha256=row["sha256"],
    )


def package_manifest(payload: bytes) -> dict[str, Any]:
    """Return the canonical manifest stored inside a package archive."""
    with _open_archive(payload) as archive:
        manifest, _ = _archive_manifest(archive)
    return manifest
