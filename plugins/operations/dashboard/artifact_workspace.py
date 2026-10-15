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
but never a row pointing at missing bytes. An entry that already carries a
blob's name proves nothing: its bytes are re-hashed through its own descriptor
before they are trusted, and an entry that fails that check is replaced (or the
write fails) before any metadata can reference it.
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
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping

try:  # pragma: no cover - POSIX advisory locking
    import fcntl
except ImportError:  # pragma: no cover - non-POSIX hosts
    fcntl = None


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
SWEEP_LOCK_NAME = ".sweep.lock"
MANIFEST_MEMBER = package_module.MANIFEST_MEMBER
MAX_WORKSPACE_ID_CHARS = 64
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)

#: A stored blob is never larger than one whole package.
MAX_BLOB_BYTES = package_module.MAX_PACKAGE_TOTAL_BYTES

#: How long a workspace that NO durable run references is left alone. A mint
#: creates the directory inside the lifecycle transaction, so between the mint
#: and the commit the workspace exists on disk while its run row is invisible
#: to every other connection. The cutoff is the window that race lives in.
WORKSPACE_SWEEP_GRACE_SECONDS = 60 * 60

#: Removals per sweep. A sweep runs on a request path, so it is bounded.
MAX_SWEEP_REMOVALS = 64


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
    workspace_device: int
    workspace_inode: int
    output_device: int
    output_inode: int


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
        # Absolute but NOT resolved: the configured pathname is what the server
        # was told to use, and resolving it here would silently accept the very
        # links the walk below exists to refuse.
        self.root = Path(os.path.normpath(Path(root).absolute()))
        descriptor = self._establish_root(self.root)
        try:
            opened = os.fstat(descriptor)
            #: The root's identity, pinned once. Every later open of the root by
            #: pathname must land on this exact directory or no operation runs.
            self.root_identity = (opened.st_dev, opened.st_ino)
            try:
                os.fchmod(descriptor, 0o700)
            except OSError:  # pragma: no cover - platform dependent
                pass
            for name in (BLOBS_DIRECTORY, STAGING_DIRECTORY, WORKSPACES_DIRECTORY):
                os.close(self._open_child(descriptor, name, create=True))
        finally:
            os.close(descriptor)
        self.blobs = self.root / BLOBS_DIRECTORY
        self.staging = self.root / STAGING_DIRECTORY

    # -- root creation and identity ----------------------------------------

    @staticmethod
    def _establish_root(root: Path) -> int:
        """Open the configured artifact root, creating it by descriptor walk.

        The deepest component that ALREADY exists is server configuration --
        Operations is told where to keep its artifacts the same way it is told
        where to keep its database -- so it is the walk's trusted starting
        descriptor, and it must be a real directory rather than a link or a
        file. Every component below it is created with ``mkdirat`` and opened
        with ``openat`` + ``O_NOFOLLOW`` relative to its parent descriptor, and
        each one's ``lstat`` identity is compared against the ``fstat`` of the
        descriptor actually opened.

        A ``mkdir(parents=True)`` would instead have followed a pre-planted
        link and built the whole artifact tree -- every blob, every workspace,
        every assigned cwd -- inside the link's target.

        Refusals name no path: an error body must never leak a host path.
        """
        # Start at the filesystem anchor, not at the deepest existing parent.
        # Opening an apparently real child pathname directly would still follow
        # a symlink in one of its already-existing ancestors.
        parts = root.parts
        if len(parts) < 2 or not root.anchor:
            raise WorkspaceError("the artifact root path is invalid")
        try:
            descriptor = os.open(root.anchor, os.O_RDONLY | os.O_DIRECTORY | _O_NOFOLLOW)
        except OSError as exc:
            raise WorkspaceError("the artifact root is unavailable") from exc
        try:
            components = parts[1:]
            for index, name in enumerate(components):
                child = ArtifactStore._open_root_component(
                    descriptor,
                    name,
                    owner_only=index == len(components) - 1,
                )
                os.close(descriptor)
                descriptor = child
        except BaseException:
            os.close(descriptor)
            raise
        return descriptor

    @staticmethod
    def _open_root_component(parent_fd: int, name: str, *, owner_only: bool = False) -> int:
        """Create/open one root component without following any ancestor link."""
        if name in ("", ".", ".."):  # pragma: no cover - normpath removes these
            raise WorkspaceError("the artifact root path is invalid")
        created = False
        try:
            os.mkdir(name, 0o700, dir_fd=parent_fd)
            created = True
        except FileExistsError:
            pass
        except OSError as exc:
            raise WorkspaceError("the artifact root could not be created") from exc
        try:
            info = os.lstat(name, dir_fd=parent_fd)
        except OSError as exc:
            raise WorkspaceError("the artifact root is unavailable") from exc
        if stat.S_ISLNK(info.st_mode):
            raise WorkspaceError("the artifact root must be a real directory, not a link")
        if not stat.S_ISDIR(info.st_mode):
            raise WorkspaceError("the artifact root must be a real directory, not a file")
        try:
            handle = os.open(
                name, os.O_RDONLY | os.O_DIRECTORY | _O_NOFOLLOW, dir_fd=parent_fd
            )
        except OSError as exc:
            raise WorkspaceError("the artifact root could not be opened safely") from exc
        opened = os.fstat(handle)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            os.close(handle)
            raise WorkspaceError("the artifact root changed while it was being opened")
        if created or owner_only:
            try:
                os.fchmod(handle, 0o700)
            except OSError:  # pragma: no cover - platform dependent
                pass
        return handle

    def verify_root(self) -> None:
        """Refuse before exposing an assigned cwd if the root is not ours."""
        with self._root_descriptor():
            pass

    # -- descriptor-relative plumbing --------------------------------------

    @contextlib.contextmanager
    def _root_descriptor(self):
        """A verified descriptor for the configured artifact root.

        The root is reopened by pathname with ``O_NOFOLLOW`` and accepted only
        when its device and inode still match the identity pinned at
        construction, so a root swapped between the check and the open -- for a
        link OR for a different real directory at the same name -- is refused
        before any operation. Every child below it is then opened relative to a
        descriptor with ``O_NOFOLLOW``, so a swapped or symlinked
        ``sha256``/``staging``/``workspaces`` name can never move a write, a
        read, a mint, or a sweep outside the root.
        """
        try:
            descriptor = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | _O_NOFOLLOW)
        except OSError as exc:
            raise WorkspaceError("the artifact root is unavailable") from exc
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != self.root_identity:
                raise WorkspaceError(
                    "the artifact root is not the directory Operations opened"
                )
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

    @staticmethod
    def _verified_blob(prefix_fd: int, digest: str) -> bool:
        """Does the entry already named ``digest`` really hold those bytes?

        The NAME proves nothing: anyone who can write into the shard can
        pre-plant a link, a directory, a hard link to a file they keep, or
        truncated bytes under a digest the server is about to store, and a
        bare existence check would then record metadata for bytes the server
        never wrote. So the entry is opened through its own descriptor with
        ``O_NOFOLLOW``, required by ``fstat`` to be a single-link bounded
        regular file, stream-hashed, and accepted only on an exact digest
        match.
        """
        try:
            info = os.lstat(digest, dir_fd=prefix_fd)
        except OSError:
            return False
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            return False
        try:
            handle = os.open(digest, os.O_RDONLY | _O_NOFOLLOW, dir_fd=prefix_fd)
        except OSError:
            return False
        with os.fdopen(handle, "rb", closefd=True) as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                return False
            if opened.st_size > MAX_BLOB_BYTES:
                return False
            hasher = hashlib.sha256()
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                hasher.update(chunk)
        return secrets.compare_digest(hasher.hexdigest(), digest)

    @staticmethod
    def _discard_blob_entry(prefix_fd: int, digest: str) -> None:
        """Clear an entry that failed verification, or refuse the write.

        A blob is content addressed, so replacing bytes that do not hash to
        their own name loses nothing -- no row can legitimately reference them.
        What is NOT safe is unlinking a tree the server never wrote, so a
        directory is reclaimed only when it is empty and anything else fails
        the write outright, before any metadata can reference the slot.
        """
        try:
            info = os.lstat(digest, dir_fd=prefix_fd)
        except OSError:
            return
        try:
            if stat.S_ISDIR(info.st_mode):
                os.rmdir(digest, dir_fd=prefix_fd)
            else:
                os.unlink(digest, dir_fd=prefix_fd)
        except OSError as exc:
            raise WorkspaceError(
                "the stored package slot could not be replaced safely"
            ) from exc

    def put_blob(self, payload: bytes) -> str:
        """Durably store bytes and return their digest."""
        digest = hashlib.sha256(payload).hexdigest()
        with self._child_descriptor(BLOBS_DIRECTORY) as blobs_fd:
            prefix_fd = self._open_child(blobs_fd, digest[:2], create=True)
            try:
                if self._verified_blob(prefix_fd, digest):
                    return digest
                # Whatever is sitting in the slot is not these bytes. It goes
                # before anything is staged, so a slot that cannot be cleared
                # fails the write instead of leaving a half-trusted entry.
                self._discard_blob_entry(prefix_fd, digest)
                with self._child_descriptor(STAGING_DIRECTORY) as staging_fd:
                    temporary = f"blob-{secrets.token_hex(16)}.part"
                    published = False
                    try:
                        descriptor = os.open(
                            temporary,
                            os.O_RDWR | os.O_CREAT | os.O_EXCL,
                            0o600,
                            dir_fd=staging_fd,
                        )
                        try:
                            view = memoryview(payload)
                            while view:
                                written = os.write(descriptor, view[:1024 * 1024])
                                if written <= 0:
                                    raise WorkspaceError("the package blob write made no progress")
                                view = view[written:]
                            os.fsync(descriptor)
                            staged = os.fstat(descriptor)
                            if staged.st_size != len(payload):
                                raise WorkspaceError("the staged package size is invalid")
                            os.lseek(descriptor, 0, os.SEEK_SET)
                            hasher = hashlib.sha256()
                            while True:
                                chunk = os.read(descriptor, 1024 * 1024)
                                if not chunk:
                                    break
                                hasher.update(chunk)
                            if hasher.hexdigest() != digest:
                                raise WorkspaceError("the staged package digest is invalid")
                            # Keep the verified inode open through publication.
                            # The staging name is not trusted after verification.
                            os.rename(
                                temporary, digest, src_dir_fd=staging_fd, dst_dir_fd=prefix_fd
                            )
                            published = True
                            published_fd = os.open(
                                digest, os.O_RDONLY | _O_NOFOLLOW, dir_fd=prefix_fd
                            )
                            try:
                                committed = os.fstat(published_fd)
                                if (committed.st_dev, committed.st_ino) != (
                                    staged.st_dev, staged.st_ino
                                ):
                                    raise WorkspaceError("the package blob changed during publication")
                                if committed.st_size != len(payload):
                                    raise WorkspaceError("the published package size is invalid")
                                os.lseek(published_fd, 0, os.SEEK_SET)
                                committed_hash = hashlib.sha256()
                                while True:
                                    chunk = os.read(published_fd, 1024 * 1024)
                                    if not chunk:
                                        break
                                    committed_hash.update(chunk)
                                if committed_hash.hexdigest() != digest:
                                    raise WorkspaceError("the published package digest is invalid")
                            finally:
                                os.close(published_fd)
                        finally:
                            os.close(descriptor)
                    except BaseException:
                        try:
                            os.unlink(temporary, dir_fd=staging_fd)
                        except FileNotFoundError:
                            pass
                        if published:
                            self._discard_blob_entry(prefix_fd, digest)
                        raise
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

    @contextlib.contextmanager
    def _sweep_lock(self, root_fd: int):
        """Serialize minting against sweeping over the shared artifact root.

        The lock lives in the root itself, so every process that shares the
        root shares it. It guarantees a sweep never walks a workspace that is
        half-created and a mint never lands inside a tree a sweep is deleting.

        It is NOT what protects an unpublished run: a mint releases the lock
        when its directory exists, long before its run row commits. That window
        is closed by the grace cutoff and the pre-deletion recheck instead.
        """
        if fcntl is None:  # pragma: no cover - non-POSIX hosts
            yield
            return
        try:
            handle = os.open(
                SWEEP_LOCK_NAME,
                os.O_RDWR | os.O_CREAT | _O_NOFOLLOW,
                0o600,
                dir_fd=root_fd,
            )
        except OSError as exc:
            raise WorkspaceError("the artifact root lock is unavailable") from exc
        try:
            fcntl.flock(handle, fcntl.LOCK_EX)
            yield
        finally:
            os.close(handle)

    def mint_workspace(self, run_id: str) -> MintedWorkspace:
        """Create the server-chosen cwd for one production or revision run."""
        run_id = _validate_run_id(run_id)
        relative = f"{WORKSPACES_DIRECTORY}/{run_id}"
        cwd = self.workspaces / run_id
        with self._root_descriptor() as root_fd, self._sweep_lock(root_fd):
            workspaces_fd = self._open_child(root_fd, WORKSPACES_DIRECTORY, create=True)
            try:
                try:
                    os.mkdir(run_id, 0o700, dir_fd=workspaces_fd)
                except FileExistsError as exc:
                    raise WorkspaceError("the workspace for this run already exists") from exc
                except OSError as exc:
                    raise WorkspaceError("the run workspace could not be created") from exc
                run_fd = self._open_child(workspaces_fd, run_id)
                try:
                    run_identity = os.fstat(run_fd)
                    output_fd = self._open_child(run_fd, OUTPUT_DIRECTORY, create=True)
                    try:
                        output_identity = os.fstat(output_fd)
                    finally:
                        os.close(output_fd)
                finally:
                    os.close(run_fd)
            finally:
                os.close(workspaces_fd)
        token = mint_claim_token()
        return MintedWorkspace(
            run_id=run_id,
            cwd=cwd,
            relative_root=relative,
            claim_token=token,
            claim_token_hash=hash_claim_token(token),
            workspace_device=run_identity.st_dev,
            workspace_inode=run_identity.st_ino,
            output_device=output_identity.st_dev,
            output_inode=output_identity.st_ino,
        )

    def verified_workspace_path(
        self,
        run_id: str,
        *,
        workspace_identity: tuple[int, int],
        output_identity: tuple[int, int],
    ) -> Path:
        """Validate the exact minted run and output directories before exposing cwd."""
        run_id = _validate_run_id(run_id)
        with self._child_descriptor(WORKSPACES_DIRECTORY) as workspaces_fd:
            run_fd = self._open_child(workspaces_fd, run_id)
            try:
                opened_run = os.fstat(run_fd)
                if (opened_run.st_dev, opened_run.st_ino) != workspace_identity:
                    raise WorkspaceError("the run workspace is not the directory Operations minted")
                output_fd = self._open_child(run_fd, OUTPUT_DIRECTORY)
                try:
                    opened_output = os.fstat(output_fd)
                    if (opened_output.st_dev, opened_output.st_ino) != output_identity:
                        raise WorkspaceError(
                            "the run output directory is not the directory Operations minted"
                        )
                finally:
                    os.close(output_fd)
            finally:
                os.close(run_fd)
        return self.workspace_path(run_id)

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

    def collect_workspace(
        self,
        run_id: str,
        *,
        workspace_identity: tuple[int, int],
        output_identity: tuple[int, int],
    ) -> CollectedPackage:
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
            root_info = os.fstat(root_fd)
            if (root_info.st_dev, root_info.st_ino) != workspace_identity:
                raise WorkspaceError("the run workspace identity changed")
            output_fd = self._open_contained_directory(root_fd, OUTPUT_DIRECTORY)
            try:
                output_info = os.fstat(output_fd)
                if (output_info.st_dev, output_info.st_ino) != output_identity:
                    raise WorkspaceError("the run output identity changed")
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

    @staticmethod
    def _sweepable(
        parent_fd: int,
        name: str,
        keep: set[str],
        known: set[str] | None,
        cutoff: float,
    ) -> bool:
        """May this workspace entry be removed right now?"""
        if name in keep:
            # A durable open run still needs it, at any age.
            return False
        try:
            info = os.lstat(name, dir_fd=parent_fd)
        except OSError:  # pragma: no cover - raced removal
            return False
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return False
        if known is not None and name in known:
            # A durable row exists and it is not open, so the run is collected
            # or failed. Its immutable bytes live in the content-addressed
            # store, never in the workspace, so this is reclaimable now.
            return True
        # Nothing durable references it. From here an abandoned workspace and a
        # mint whose transaction has not committed yet look identical, so only
        # age separates them.
        return info.st_mtime <= cutoff

    def sweep_uncollected_workspaces(
        self,
        keep_run_ids: Mapping[str, Any] | set[str] = (),
        *,
        durable_state: Callable[[], tuple[Any, Any]] | None = None,
        grace_seconds: float = WORKSPACE_SWEEP_GRACE_SECONDS,
        now: float | None = None,
        limit: int = MAX_SWEEP_REMOVALS,
    ) -> list[str]:
        """Remove workspaces no durable run still references.

        Immutable artifact versions live in the blob store, never in a
        workspace, so sweeping a workspace can never remove approved evidence.
        What a sweep CAN race is a mint: the directory exists before the run
        row commits. Three things close that race:

        * the shared root lock, so a mint and a sweep never interleave;
        * an explicit grace cutoff, so a workspace that no durable row
          references is only reclaimed once it is older than the window a
          lifecycle transaction can be open for;
        * a re-read of durable state and of the entry's own age immediately
          before each removal, so a run published since the listing keeps its
          workspace.

        ``durable_state`` returns ``(keep, known)``: the run ids that must be
        preserved and the run ids that have ANY durable row. Without it the
        caller only supplies ``keep`` and every other entry is treated as
        unreferenced, which means the grace cutoff governs all of them.

        Removal is descriptor-relative: a swapped ``workspaces`` name is
        refused, and a symlinked entry inside it is skipped rather than
        followed, so a sweep can never unlink anything outside the root. It is
        bounded to ``limit`` removals per call and returns exactly what it
        removed, so a caller is never told more was reclaimed than was.
        """
        moment = time.time() if now is None else float(now)
        cutoff = moment - max(0.0, float(grace_seconds))

        def state() -> tuple[set[str], set[str] | None]:
            if durable_state is None:
                return set(keep_run_ids), None
            keep, known = durable_state()
            return set(keep), None if known is None else set(known)

        removed: list[str] = []
        keep, known = state()
        with self._root_descriptor() as root_fd, self._sweep_lock(root_fd):
            workspaces_fd = self._open_child(root_fd, WORKSPACES_DIRECTORY, create=True)
            try:
                for name in sorted(os.listdir(workspaces_fd)):
                    if len(removed) >= limit:
                        break
                    if not self._sweepable(workspaces_fd, name, keep, known, cutoff):
                        continue
                    # Re-read durable truth and re-check the age against the
                    # entry itself immediately before unlinking anything.
                    keep, known = state()
                    if not self._sweepable(workspaces_fd, name, keep, known, cutoff):
                        continue
                    _remove_tree_at(workspaces_fd, name)
                    removed.append(name)
            finally:
                os.close(workspaces_fd)
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
