"""Server-owned producer workspaces and content-addressed package storage.

The producer never chooses a host path. Operations mints a workspace under its
own artifact root, hands the producer only that assigned cwd plus an opaque,
single-use collection claim, and collects the result with descriptor-relative
no-follow traversal.

Collection is idempotent by receipt: once a run is collected, replaying the
claim returns the original receipt byte-for-byte instead of rebuilding.

Package bytes live in a file-backed content-addressed store keyed by the
lowercase SHA-256 of the archive. Writes are staged in a mode-0600 temporary
file inside the artifact root, stream-hashed, fsynced, atomically renamed into
``sha256/<prefix>/<digest>``, and the parent directory is fsynced before any
metadata row references them. A crash may therefore leave an unreferenced blob,
but never a row pointing at missing bytes.
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import json
import os
import re
import secrets
import stat
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


def _load_sibling(name: str, module_name: str):
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:  # pragma: no cover - packaging guard
        raise RuntimeError(f"Operations module could not load: {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


package_module = _load_sibling("deliverable_package.py", "hermes_operations_deliverable_package")

PackageInvalid = package_module.PackageInvalid
PackageLimitExceeded = package_module.PackageLimitExceeded

OUTPUT_DIRECTORY = "output"
WORKSPACES_DIRECTORY = "workspaces"
BLOBS_DIRECTORY = "sha256"
STAGING_DIRECTORY = "staging"
MANIFEST_MEMBER = package_module.MANIFEST_MEMBER
MAX_WORKSPACE_ID_CHARS = 64
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class WorkspaceError(ValueError):
    """The workspace could not be minted, claimed, or collected."""


class WorkspaceClaimInvalid(WorkspaceError):
    """The presented collection claim does not match the durable binding."""


@dataclass(frozen=True)
class MintedWorkspace:
    run_id: str
    #: Absolute assigned cwd. Returned ONLY to the authenticated run
    #: dispatcher; never persisted in a public meeting record or DTO.
    cwd: Path
    relative_root: str
    claim_token: str
    claim_token_hash: str


@dataclass(frozen=True)
class CollectedPackage:
    run_id: str
    manifest: dict[str, Any]
    manifest_sha256: str
    game_sha256: str
    zip_sha256: str
    total_byte_size: int
    blob_digest: str
    schema_version: int
    zip_bytes: bytes


def hash_claim_token(token: str) -> str:
    """Hash a claim token for durable storage; raw tokens are never persisted."""
    if not isinstance(token, str) or not 16 <= len(token) <= 256:
        raise WorkspaceClaimInvalid("collection claim is invalid")
    return hashlib.sha256(b"hermes.operations.workspace.claim.v1\x00" + token.encode("utf-8")).hexdigest()


def mint_claim_token() -> str:
    return secrets.token_urlsafe(32)


def _validate_run_id(run_id: object) -> str:
    if not isinstance(run_id, str) or not _RUN_ID_RE.fullmatch(run_id):
        raise WorkspaceError("run id is invalid")
    return run_id


class ArtifactStore:
    """Content-addressed package blob storage under the Operations root."""

    def __init__(self, root: Path | str):
        self.root = Path(root)
        if self.root.is_symlink():
            # Refuse before creating anything: a linked root would place every
            # blob and workspace somewhere the server never chose.
            raise WorkspaceError("the artifact root must be a real directory, not a link")
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            self.root.chmod(0o700)
        except OSError:  # pragma: no cover - platform dependent
            pass
        self.blobs = self.root / BLOBS_DIRECTORY
        self.staging = self.root / STAGING_DIRECTORY
        with self._root_descriptor() as root_fd:
            for name in (BLOBS_DIRECTORY, STAGING_DIRECTORY, WORKSPACES_DIRECTORY):
                os.close(self._open_child(root_fd, name, create=True))

    # -- descriptor-relative plumbing --------------------------------------

    @contextlib.contextmanager
    def _root_descriptor(self):
        """A trusted descriptor for the configured artifact root.

        Every child below it is then opened relative to a descriptor with
        ``O_NOFOLLOW``, so a swapped or symlinked ``sha256``/``staging``/
        ``workspaces`` name can never move a write, a read, a mint, or a sweep
        outside the root.
        """
        if self.root.is_symlink():
            raise WorkspaceError("the artifact root must be a real directory, not a link")
        try:
            descriptor = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
        except OSError as exc:
            raise WorkspaceError("the artifact root is unavailable") from exc
        try:
            # One tripwire for every artifact operation: if ANY server-owned
            # child of the root has been replaced by a link or a file, the root
            # is not the tree the server built, so no operation proceeds --
            # not a blob write, not a read, not a mint, not a sweep.
            for name in (BLOBS_DIRECTORY, STAGING_DIRECTORY, WORKSPACES_DIRECTORY):
                try:
                    info = os.lstat(name, dir_fd=descriptor)
                except OSError:
                    continue
                if stat.S_ISLNK(info.st_mode):
                    raise WorkspaceError(f"the artifact directory {name} is a symbolic link")
                if not stat.S_ISDIR(info.st_mode):
                    raise WorkspaceError(f"the artifact directory {name} is not a directory")
            yield descriptor
        finally:
            os.close(descriptor)

    @staticmethod
    def _open_child(parent_fd: int, name: str, *, create: bool = False) -> int:
        """Open one server-owned child directory, refusing a link or a swap."""
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=parent_fd)
            except FileExistsError:
                pass
            except OSError as exc:
                raise WorkspaceError(f"the artifact directory {name} is unavailable") from exc
        try:
            info = os.lstat(name, dir_fd=parent_fd)
        except OSError as exc:
            raise WorkspaceError(f"the artifact directory {name} is missing") from exc
        if stat.S_ISLNK(info.st_mode):
            raise WorkspaceError(f"the artifact directory {name} is a symbolic link")
        if not stat.S_ISDIR(info.st_mode):
            raise WorkspaceError(f"the artifact directory {name} is not a directory")
        try:
            handle = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=parent_fd,
            )
        except OSError as exc:
            raise WorkspaceError(f"the artifact directory {name} could not be opened") from exc
        opened = os.fstat(handle)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            os.close(handle)
            raise WorkspaceError(f"the artifact directory {name} changed while opening")
        if create:
            try:
                os.fchmod(handle, 0o700)
            except OSError:  # pragma: no cover - platform dependent
                pass
        return handle

    @contextlib.contextmanager
    def _child_descriptor(self, name: str, *, create: bool = False):
        with self._root_descriptor() as root_fd:
            handle = self._open_child(root_fd, name, create=create)
        try:
            yield handle
        finally:
            os.close(handle)

    @staticmethod
    def _validate_digest(digest: object) -> str:
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise WorkspaceError("blob digest is invalid")
        return digest

    def blob_path(self, digest: str) -> Path:
        """The server's own name for a blob. IO goes through descriptors."""
        return self.blobs / self._validate_digest(digest)[:2] / digest

    def put_blob(self, payload: bytes) -> str:
        """Durably store bytes and return their digest."""
        digest = hashlib.sha256(payload).hexdigest()
        with self._child_descriptor(BLOBS_DIRECTORY) as blobs_fd:
            prefix_fd = self._open_child(blobs_fd, digest[:2], create=True)
            try:
                try:
                    os.lstat(digest, dir_fd=prefix_fd)

                    return digest
                except OSError:
                    pass
                with self._child_descriptor(STAGING_DIRECTORY) as staging_fd:
                    temporary = f"blob-{secrets.token_hex(16)}.part"
                    descriptor = os.open(
                        temporary,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                        0o600,
                        dir_fd=staging_fd,
                    )
                    try:
                        hasher = hashlib.sha256()
                        view = memoryview(payload)
                        while view:
                            chunk = view[:1024 * 1024]
                            os.write(descriptor, chunk)
                            hasher.update(chunk)
                            view = view[len(chunk):]
                        if hasher.hexdigest() != digest:  # pragma: no cover - defensive
                            raise WorkspaceError("package digest changed while writing")
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                    os.rename(
                        temporary, digest, src_dir_fd=staging_fd, dst_dir_fd=prefix_fd
                    )
                os.fsync(prefix_fd)
            finally:
                os.close(prefix_fd)
        return digest

    def _read_blob(self, digest: str) -> bytes:
        with self._child_descriptor(BLOBS_DIRECTORY) as blobs_fd:
            prefix_fd = self._open_child(blobs_fd, digest[:2])
            try:
                handle = os.open(
                    digest, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=prefix_fd
                )
            finally:
                os.close(prefix_fd)
        with os.fdopen(handle, "rb", closefd=True) as stream:
            return stream.read()

    def get_blob(self, digest: str) -> bytes:
        self._validate_digest(digest)
        try:
            payload = self._read_blob(digest)
        except WorkspaceError:
            raise
        except OSError as exc:
            raise WorkspaceError("stored package bytes are unavailable") from exc
        if hashlib.sha256(payload).hexdigest() != digest:
            raise WorkspaceError("stored package bytes do not match their digest")
        return payload

    def has_blob(self, digest: str) -> bool:
        try:
            self._validate_digest(digest)
            with self._child_descriptor(BLOBS_DIRECTORY) as blobs_fd:
                prefix_fd = self._open_child(blobs_fd, digest[:2])
                try:
                    info = os.lstat(digest, dir_fd=prefix_fd)
                finally:
                    os.close(prefix_fd)
        except (WorkspaceError, OSError):
            return False
        return stat.S_ISREG(info.st_mode)

    # -- workspaces --------------------------------------------------------

    @property
    def workspaces(self) -> Path:
        """The server's own name for the workspaces root. No IO happens here."""
        return self.root / WORKSPACES_DIRECTORY

    def mint_workspace(self, run_id: str) -> MintedWorkspace:
        """Create the server-chosen cwd for one production or revision run."""
        run_id = _validate_run_id(run_id)
        relative = f"{WORKSPACES_DIRECTORY}/{run_id}"
        cwd = self.workspaces / run_id
        with self._child_descriptor(WORKSPACES_DIRECTORY, create=True) as workspaces_fd:
            try:
                os.mkdir(run_id, 0o700, dir_fd=workspaces_fd)
            except FileExistsError as exc:
                raise WorkspaceError("the workspace for this run already exists") from exc
            except OSError as exc:
                raise WorkspaceError("the run workspace could not be created") from exc
            run_fd = self._open_child(workspaces_fd, run_id)
            try:
                os.close(self._open_child(run_fd, OUTPUT_DIRECTORY, create=True))
            finally:
                os.close(run_fd)
        token = mint_claim_token()
        return MintedWorkspace(
            run_id=run_id,
            cwd=cwd,
            relative_root=relative,
            claim_token=token,
            claim_token_hash=hash_claim_token(token),
        )

    def workspace_path(self, run_id: str) -> Path:
        return self.workspaces / _validate_run_id(run_id)

    @staticmethod
    def _open_contained_directory(parent_fd: int, name: str) -> int:
        """Open one server-created path component, refusing a link or a swap.

        Every component below the artifact root is opened relative to its
        parent descriptor with ``O_NOFOLLOW``, so a symlinked or swapped
        ancestor (``workspaces``, the run directory) can never redirect
        collection outside the root the server minted.
        """
        try:
            info = os.lstat(name, dir_fd=parent_fd)
        except OSError as exc:
            raise PackageInvalid(f"the workspace path component {name} is missing") from exc
        if stat.S_ISLNK(info.st_mode):
            raise PackageInvalid(f"the workspace path component {name} is a symbolic link")
        if not stat.S_ISDIR(info.st_mode):
            raise PackageInvalid(f"the workspace path component {name} is not a directory")
        try:
            handle = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=parent_fd,
            )
        except OSError as exc:
            raise PackageInvalid(
                f"the workspace path component {name} could not be opened safely"
            ) from exc
        opened = os.fstat(handle)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            os.close(handle)
            raise PackageInvalid(f"the workspace path component {name} changed while opening")
        return handle

    @staticmethod
    def _read_manifest_bytes(output_fd: int) -> bytes:
        """Read the declared manifest through the pinned output descriptor."""
        try:
            info = os.lstat(MANIFEST_MEMBER, dir_fd=output_fd)
        except OSError as exc:
            raise PackageInvalid("the workspace manifest is missing") from exc
        if stat.S_ISLNK(info.st_mode):
            raise PackageInvalid("the workspace manifest is a symbolic link")
        if not stat.S_ISREG(info.st_mode):
            raise PackageInvalid("the workspace manifest is not a regular file")
        if info.st_nlink > 1:
            raise PackageInvalid("the workspace manifest is hard linked")
        if info.st_size > package_module.MAX_MANIFEST_BYTES:
            raise PackageLimitExceeded("the workspace manifest exceeds the manifest byte limit")
        try:
            handle = os.open(
                MANIFEST_MEMBER,
                os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
                dir_fd=output_fd,
            )
        except OSError as exc:
            raise PackageInvalid("the workspace manifest is missing") from exc
        with os.fdopen(handle, "rb", closefd=True) as stream:
            raw = stream.read(package_module.MAX_MANIFEST_BYTES + 1)
        if len(raw) > package_module.MAX_MANIFEST_BYTES:
            raise PackageLimitExceeded("the workspace manifest exceeds the manifest byte limit")
        return raw

    def collect_workspace(self, run_id: str) -> CollectedPackage:
        """Verify a workspace tree and build its immutable package bytes."""
        run_id = _validate_run_id(run_id)
        root = self.workspace_path(run_id)
        if not root.is_dir() or root.is_symlink():
            raise WorkspaceError("the run workspace is unavailable")

        # Walk down from the artifact root by descriptor. The root itself is
        # server configuration; everything below it is server-created and must
        # be neither a symbolic link nor a replaced directory.
        with self._child_descriptor(WORKSPACES_DIRECTORY) as workspaces_fd:
            root_fd = self._open_contained_directory(workspaces_fd, run_id)

        try:
            output_fd = self._open_contained_directory(root_fd, OUTPUT_DIRECTORY)
            try:
                raw = self._read_manifest_bytes(output_fd)
                try:
                    declared = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, ValueError) as exc:
                    raise PackageInvalid("the workspace manifest is not valid JSON") from exc
                # Build through the SAME pinned descriptor the traversal
                # validated. Nothing is reopened by pathname, so no swap
                # between check and build is possible.
                built = package_module.build_package_from_descriptor(output_fd, declared)
            finally:
                os.close(output_fd)
        finally:
            os.close(root_fd)

        blob_digest = self.put_blob(built.zip_bytes)
        return CollectedPackage(
            run_id=run_id,
            manifest=built.manifest,
            manifest_sha256=built.manifest_sha256,
            game_sha256=built.game_sha256,
            zip_sha256=built.zip_sha256,
            total_byte_size=built.total_byte_size,
            blob_digest=blob_digest,
            schema_version=built.schema_version,
            zip_bytes=built.zip_bytes,
        )

    def sweep_uncollected_workspaces(self, keep_run_ids: Mapping[str, Any] | set[str]) -> list[str]:
        """Remove workspaces no durable run still references.

        Immutable artifact versions live in the blob store, never in a
        workspace, so sweeping a workspace can never remove approved evidence.
        Removal is descriptor-relative: a swapped ``workspaces`` name is
        refused, and a symlinked entry inside it is skipped rather than
        followed, so a sweep can never unlink anything outside the root.
        """
        removed: list[str] = []
        keep = set(keep_run_ids)
        with self._child_descriptor(WORKSPACES_DIRECTORY) as workspaces_fd:
            for name in sorted(os.listdir(workspaces_fd)):
                if name in keep:
                    continue
                try:
                    info = os.lstat(name, dir_fd=workspaces_fd)
                except OSError:  # pragma: no cover - raced removal
                    continue
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                    continue
                _remove_tree_at(workspaces_fd, name)
                removed.append(name)
        return removed


def _remove_tree_at(parent_fd: int, name: str) -> None:
    """Remove one directory tree without ever following a symbolic link."""
    try:
        handle = os.open(
            name,
            os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
    except OSError:  # pragma: no cover - raced removal
        return
    try:
        for child in sorted(os.listdir(handle)):
            info = os.lstat(child, dir_fd=handle)
            if stat.S_ISDIR(info.st_mode):
                _remove_tree_at(handle, child)
            else:
                os.unlink(child, dir_fd=handle)
    finally:
        os.close(handle)
    os.rmdir(name, dir_fd=parent_fd)
