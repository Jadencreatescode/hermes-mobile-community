"""Focused tests for the public deterministic deliverable_package_v1 builder."""

import hashlib
import importlib.util
import io
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
DASHBOARD = ROOT / "plugins" / "operations" / "dashboard"


def load_package():
    module_path = DASHBOARD / "deliverable_package.py"
    spec = importlib.util.spec_from_file_location("operations_deliverable_package_test", module_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def write_tree(root: Path, files: dict[str, bytes]) -> None:
    for relative, payload in files.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)


def manifest_for(files: dict[str, bytes], *, primary: str, **overrides):
    manifest = {
        "schema": "deliverable_package_v1",
        "product_kind": "document",
        "title": "Quarterly brief",
        "summary": "A short public document.",
        "primary_file": primary,
        "files": [
            {
                "path": path,
                "media_type": "text/plain",
                "role": "primary" if path == primary else "support",
                "preview_policy": "text",
                "byte_size": len(payload),
                "sha256": digest(payload),
            }
            for path, payload in sorted(files.items())
        ],
    }
    manifest.update(overrides)
    return manifest


def build_tree(tmp_path: Path, files: dict[str, bytes], *, primary: str, **overrides) -> tuple[Path, dict]:
    output = tmp_path / "output"
    output.mkdir(parents=True, exist_ok=True)
    write_tree(output, files)
    manifest = manifest_for(files, primary=primary, **overrides)
    return output, manifest


SAMPLE = {
    "index.txt": b"primary body\n",
    "notes/extra.txt": b"support body\n",
}


def test_canonical_manifest_bytes_are_sorted_and_compact():
    api = load_package()
    manifest = manifest_for(SAMPLE, primary="index.txt")

    encoded = api.canonical_manifest_bytes(manifest)

    assert encoded.startswith(b'{"files":[')
    assert b", " not in encoded
    assert api.canonical_manifest_bytes(dict(reversed(list(manifest.items())))) == encoded
    assert api.manifest_digest(manifest) == digest(encoded)


def test_build_is_byte_identical_across_repeated_builds(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, SAMPLE, primary="index.txt")

    first = api.build_package(output, manifest)
    second = api.build_package(output, manifest)

    assert first.zip_bytes == second.zip_bytes
    assert first.zip_sha256 == digest(first.zip_bytes)
    assert first.manifest_sha256 == api.manifest_digest(manifest)
    assert first.game_sha256 == digest(SAMPLE["index.txt"])
    assert first.schema_version == api.PACKAGE_SCHEMA_VERSION
    assert first.total_byte_size == sum(len(value) for value in SAMPLE.values())


def test_archive_members_are_sorted_with_fixed_metadata(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, SAMPLE, primary="index.txt")

    built = api.build_package(output, manifest)

    with zipfile.ZipFile(io.BytesIO(built.zip_bytes)) as archive:
        names = archive.namelist()
        assert names == sorted(names)
        assert names == ["deliverable.json", "index.txt", "notes/extra.txt"]
        for info in archive.infolist():
            assert info.date_time == (1980, 1, 1, 0, 0, 0)
            assert info.create_system == 3
            assert info.external_attr >> 16 == 0o644
            assert info.compress_type == zipfile.ZIP_DEFLATED
        assert archive.read("deliverable.json") == api.canonical_manifest_bytes(manifest)


@pytest.mark.parametrize(
    "path",
    [
        "/absolute.txt",
        "../escape.txt",
        "nested/../../escape.txt",
        "./index.txt",
        "windows\\style.txt",
        "trailing/",
        "nul\x00.txt",
        "",
        "c:/drive.txt",
        "double//slash.txt",
    ],
)
def test_unsafe_manifest_paths_are_refused(tmp_path, path):
    api = load_package()
    output, manifest = build_tree(tmp_path, {"index.txt": b"body\n"}, primary="index.txt")
    manifest["files"].append({
        "path": path,
        "media_type": "text/plain",
        "role": "support",
        "preview_policy": "text",
        "byte_size": 1,
        "sha256": digest(b"x"),
    })

    with pytest.raises(api.PackageInvalid):
        api.build_package(output, manifest)


def test_duplicate_and_case_folded_paths_are_refused(tmp_path):
    api = load_package()
    for second in ("index.txt", "INDEX.TXT"):
        output, manifest = build_tree(tmp_path / second, {"index.txt": b"body\n"}, primary="index.txt")
        manifest["files"].append({
            "path": second,
            "media_type": "text/plain",
            "role": "support",
            "preview_policy": "text",
            "byte_size": 5,
            "sha256": digest(b"body\n"),
        })

        with pytest.raises(api.PackageInvalid, match="duplicate|collision"):
            api.build_package(output, manifest)


def test_declared_digest_and_size_must_match_bytes(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, {"index.txt": b"body\n"}, primary="index.txt")
    manifest["files"][0]["sha256"] = digest(b"tampered")

    with pytest.raises(api.PackageInvalid, match="digest"):
        api.build_package(output, manifest)

    output_two, manifest_two = build_tree(tmp_path / "two", {"index.txt": b"body\n"}, primary="index.txt")
    manifest_two["files"][0]["byte_size"] = 4

    with pytest.raises(api.PackageInvalid, match="size"):
        api.build_package(output_two, manifest_two)


def test_primary_file_must_be_declared(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, {"index.txt": b"body\n"}, primary="index.txt")
    manifest["primary_file"] = "missing.txt"

    with pytest.raises(api.PackageInvalid, match="primary"):
        api.build_package(output, manifest)


def test_undeclared_workspace_file_is_refused(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, {"index.txt": b"body\n"}, primary="index.txt")
    (output / "stowaway.txt").write_bytes(b"surprise\n")

    with pytest.raises(api.PackageInvalid, match="undeclared"):
        api.build_package(output, manifest)


def test_member_count_bomb_is_refused(tmp_path):
    api = load_package()
    files = {f"file-{index:04d}.txt": b"x" for index in range(api.MAX_PACKAGE_FILES + 1)}
    output, manifest = build_tree(tmp_path / "count", files, primary="file-0000.txt")

    with pytest.raises(api.PackageLimitExceeded, match="files"):
        api.build_package(output, manifest)


def test_manifest_size_bomb_inside_an_archive_is_refused(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, SAMPLE, primary="index.txt")
    built = api.build_package(output, manifest)

    hostile = io.BytesIO()
    with zipfile.ZipFile(hostile, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("deliverable.json", b"{" + b" " * (api.MAX_MANIFEST_BYTES + 1) + b"}")

    with pytest.raises(api.PackageLimitExceeded, match="manifest"):
        api.read_package_member(hostile.getvalue(), "index.txt")

    result = api.verify_package_bytes(
        hostile.getvalue(),
        manifest_sha256=built.manifest_sha256,
        game_sha256=built.game_sha256,
        zip_sha256=built.zip_sha256,
    )
    assert result["ok"] is False
    assert "manifest_canonical" in result["failed_checks"]


def test_oversize_file_and_total_are_refused(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, {"index.txt": b"body\n"}, primary="index.txt")
    manifest["files"][0]["byte_size"] = api.MAX_PACKAGE_FILE_BYTES + 1

    with pytest.raises(api.PackageLimitExceeded, match="per-file"):
        api.build_package(output, manifest)

    chunk = api.MAX_PACKAGE_FILE_BYTES
    count = api.MAX_PACKAGE_TOTAL_BYTES // chunk + 1
    manifest["files"] = [
        {
            "path": f"chunk-{index}.txt",
            "media_type": "text/plain",
            "role": "support",
            "preview_policy": "text",
            "byte_size": chunk,
            "sha256": digest(b""),
        }
        for index in range(count)
    ]
    manifest["primary_file"] = "chunk-0.txt"

    with pytest.raises(api.PackageLimitExceeded, match="total"):
        api.build_package(output, manifest)


def test_unsupported_preview_policy_and_media_type_are_refused(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, {"index.txt": b"body\n"}, primary="index.txt")
    manifest["files"][0]["preview_policy"] = "inline_html"

    with pytest.raises(api.PackageInvalid, match="preview_policy"):
        api.build_package(output, manifest)

    output_two, manifest_two = build_tree(tmp_path / "two", {"page.html": b"<p>hi</p>"}, primary="page.html")
    manifest_two["files"][0]["media_type"] = "text/html"
    manifest_two["files"][0]["preview_policy"] = "text"

    with pytest.raises(api.PackageInvalid, match="preview_policy"):
        api.build_package(output_two, manifest_two)


def test_html_and_svg_default_to_download_only(tmp_path):
    api = load_package()
    files = {"page.html": b"<p>hi</p>", "art.svg": b"<svg/>"}
    output, manifest = build_tree(tmp_path, files, primary="page.html")
    for entry in manifest["files"]:
        entry["preview_policy"] = "download_only"
        entry["media_type"] = "text/html" if entry["path"].endswith(".html") else "image/svg+xml"
    manifest["product_kind"] = "interactive_web_app"

    built = api.build_package(output, manifest)

    assert built.manifest["files"][0]["preview_policy"] == "download_only"
    assert api.preview_disposition("text/html", "download_only") == "attachment"
    assert api.preview_disposition("image/svg+xml", "download_only") == "attachment"
    assert api.preview_disposition("text/plain", "text") == "inline"


def test_product_kind_is_bounded(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, {"index.txt": b"body\n"}, primary="index.txt")
    manifest["product_kind"] = "nuclear_reactor"

    with pytest.raises(api.PackageInvalid, match="product_kind"):
        api.build_package(output, manifest)

    assert "document" in api.PRODUCT_KINDS
    assert "interactive_web_app" in api.PRODUCT_KINDS


def test_verify_package_bytes_detects_tampered_members(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, SAMPLE, primary="index.txt")
    built = api.build_package(output, manifest)

    verified = api.verify_package_bytes(
        built.zip_bytes,
        manifest_sha256=built.manifest_sha256,
        game_sha256=built.game_sha256,
        zip_sha256=built.zip_sha256,
    )
    assert verified["ok"] is True
    assert verified["failed_checks"] == []

    tampered = bytearray(built.zip_bytes)
    tampered[-10] ^= 0xFF
    broken = api.verify_package_bytes(
        bytes(tampered),
        manifest_sha256=built.manifest_sha256,
        game_sha256=built.game_sha256,
        zip_sha256=built.zip_sha256,
    )
    assert broken["ok"] is False
    assert "zip_digest" in broken["failed_checks"]


def test_verify_package_bytes_detects_member_set_change(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, SAMPLE, primary="index.txt")
    built = api.build_package(output, manifest)

    rebuilt = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(built.zip_bytes)) as source:
        with zipfile.ZipFile(rebuilt, "w", zipfile.ZIP_DEFLATED) as target:
            for info in source.infolist():
                target.writestr(info, source.read(info.filename))
            target.writestr("extra.txt", b"smuggled\n")

    result = api.verify_package_bytes(
        rebuilt.getvalue(),
        manifest_sha256=built.manifest_sha256,
        game_sha256=built.game_sha256,
        zip_sha256=built.zip_sha256,
    )

    assert result["ok"] is False
    assert "archive_member_set" in result["failed_checks"]


def test_read_member_revalidates_digest(tmp_path):
    api = load_package()
    output, manifest = build_tree(tmp_path, SAMPLE, primary="index.txt")
    built = api.build_package(output, manifest)

    member = api.read_package_member(built.zip_bytes, "notes/extra.txt")
    assert member.payload == SAMPLE["notes/extra.txt"]
    assert member.media_type == "text/plain"
    assert member.preview_policy == "text"

    with pytest.raises(api.PackageInvalid, match="not declared|traversal"):
        api.read_package_member(built.zip_bytes, "../etc/passwd")

    with pytest.raises(api.PackageInvalid, match="not declared"):
        api.read_package_member(built.zip_bytes, "missing.txt")
