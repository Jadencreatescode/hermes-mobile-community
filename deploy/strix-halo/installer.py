#!/usr/bin/env python3
"""Transactional installer for the Hermes mobile relay on Linux.

This module intentionally has no third-party dependencies.  All mutable state is
kept below ~/.local/share/hermes-mobile and ~/.config/systemd/user.  It never
opens, copies, or modifies HERMES_HOME.
"""
from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from contextlib import contextmanager
from pathlib import Path, PurePosixPath
from typing import Callable, Protocol, Sequence

APP = "hermes-mobile"
RELAY_UNIT = "hermes-mobile-relay.service"
BACKEND_UNIT = "hermes-mobile-backend.service"
VERSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$")
DNS_NAME_RE = re.compile(r"^(?=.{3,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
SENSITIVE_PROBE = "http://127.0.0.1:9119/api/config"
STATUS_PROBE = "http://127.0.0.1:9119/api/status"
STATE_SCHEMA_VERSION = 1
TRANSACTION_SCHEMA_VERSION = 1
STATE_KEYS = {
    "schema_version", "version", "history", "relay_port", "https_port",
    "dns_name", "url", "backend_owned", "tailscale_original",
}
TRANSACTION_KEYS = {
    "schema_version", "operation", "phase", "old_state", "old_current",
    "unit_backups", "snapshot_before", "serve_before", "dns_name",
    "relay_port", "https_port", "release_version", "release_existed_before",
    "backend_will_create",
}


class InstallError(RuntimeError):
    pass


class CommandError(InstallError):
    pass


class Runner(Protocol):
    def run(self, args: Sequence[str | Path], *, input_text: str | None = None, check: bool = True) -> str: ...


class SubprocessRunner:
    def run(self, args: Sequence[str | Path], *, input_text: str | None = None, check: bool = True) -> str:
        command = [str(item) for item in args]
        try:
            result = subprocess.run(
                command,
                input=input_text,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )
        except OSError as exc:
            raise CommandError(f"Could not run {command[0]}: {exc}") from exc
        if check and result.returncode:
            detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
            raise CommandError(f"{' '.join(command)} failed: {detail}")
        return result.stdout


@dataclass(frozen=True)
class InstallResult:
    version: str
    url: str
    relay_port: int
    https_port: int


def _default_http_status(url: str) -> int:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0


def _pick_local_port(used: set[int]) -> int:
    for port in range(4175, 4275):
        if port in used:
            continue
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise InstallError("No unused loopback relay port is available in 4175-4274")


def _pick_https_port(used: set[int]) -> int:
    for port in range(8443, 8543):
        if port not in used:
            return port
    raise InstallError("No unused Tailscale HTTPS port is available in 8443-8542")


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _atomic_write(path: Path, content: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _atomic_link(target: Path, link: Path) -> None:
    link.parent.mkdir(parents=True, exist_ok=True)
    temporary = link.with_name(f".{link.name}.{os.getpid()}.tmp")
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    os.replace(temporary, link)
    directory_fd = os.open(link.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def _secure_tree(root: Path) -> None:
    """Restrict an installer-owned release tree to its owning user."""
    for path in [root, *root.rglob("*")]:
        if path.is_symlink():
            raise InstallError(f"Installer-owned trees may not contain symlinks: {path}")
        os.chmod(path, 0o700 if path.is_dir() else 0o600)


def _unit_arg(value: str | Path) -> str:
    text = str(value)
    if "\n" in text or "\r" in text:
        raise InstallError("A service path contains a newline")
    if not any(ch.isspace() or ch in '\\"' for ch in text):
        return text
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


class FriendInstaller:
    def __init__(
        self,
        *,
        home: Path,
        hermes_home: Path,
        hermes_executable: Path,
        runner: Runner | None = None,
        http_status: Callable[[str], int] = _default_http_status,
        choose_port: Callable[[set[int]], int] = _pick_local_port,
        choose_https_port: Callable[[set[int]], int] = _pick_https_port,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self.home = home.resolve()
        self.hermes_home = hermes_home.resolve()
        self.hermes_executable = hermes_executable.resolve()
        self.runner = runner or SubprocessRunner()
        self.http_status = http_status
        self.choose_port = choose_port
        self.choose_https_port = choose_https_port
        self.sleep = sleep
        self.install_root = self.home / ".local" / "share" / APP
        self.releases = self.install_root / "releases"
        self.current = self.install_root / "current"
        self.state_path = self.install_root / "state.json"
        self.snapshot_path = self.install_root / "tailscale-original.json"
        self.transaction_path = self.install_root.parent / ".hermes-mobile.transaction.json"
        self.lock_path = self.install_root.parent / ".hermes-mobile.lock"
        self.unit_dir = self.home / ".config" / "systemd" / "user"

    @contextmanager
    def _lifecycle_lock(self):
        cursor = self.home
        try:
            relative_parent = self.install_root.parent.relative_to(self.home)
        except ValueError as exc:
            raise InstallError("Lifecycle lock parent escapes the user home") from exc
        for part in relative_parent.parts:
            cursor = cursor / part
            if cursor.is_symlink():
                raise InstallError(f"Lifecycle lock ancestor is a symlink: {cursor}")
        self.install_root.parent.mkdir(parents=True, exist_ok=True)
        if self.lock_path.is_symlink():
            raise InstallError(f"Lifecycle lock is a symlink: {self.lock_path}")
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(self.lock_path, flags, 0o600)
        except OSError as exc:
            raise InstallError(f"Could not open lifecycle lock: {exc}") from exc
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise InstallError("Lifecycle lock is not an owner-controlled regular file")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise InstallError("Another Hermes mobile lifecycle operation is already running") from exc
            yield
        finally:
            os.close(descriptor)

    def _validate_prerequisites(self) -> None:
        if not self.hermes_executable.is_file() or not os.access(self.hermes_executable, os.X_OK):
            raise InstallError(f"Resolved Hermes executable is not executable: {self.hermes_executable}")
        if isinstance(self.runner, SubprocessRunner):
            missing = [name for name in ("tailscale", "systemctl") if shutil.which(name) is None]
            if missing:
                raise InstallError(f"Required command(s) missing: {', '.join(missing)}")
        self.runner.run([
            self._python_executable(), "-I", "-c",
            "import aiohttp, multidict, yarl",
        ])

    def _validate_managed_paths(self) -> None:
        for managed_parent in (self.install_root.parent, self.unit_dir):
            try:
                relative_parent = managed_parent.relative_to(self.home)
            except ValueError as exc:
                raise InstallError("Managed installation root escapes the user home") from exc

            cursor = self.home
            for part in relative_parent.parts:
                cursor = cursor / part
                if cursor.is_symlink():
                    raise InstallError(f"Managed installation ancestor is a symlink: {cursor}")

        for path in (
            self.install_root,
            self.releases,
            self.state_path,
            self.snapshot_path,
            self.transaction_path,
            self.lock_path,
            self.unit_dir / RELAY_UNIT,
            self.unit_dir / BACKEND_UNIT,
        ):
            if path.is_symlink():
                raise InstallError(f"Managed installation path is a symlink: {path}")

        if self.current.exists() and not self.current.is_symlink():
            raise InstallError(f"Managed current release path is not a symlink: {self.current}")
        if self.current.is_symlink():
            target = self.current.resolve(strict=False)
            try:
                target.relative_to(self.releases.resolve(strict=False))
            except ValueError as exc:
                raise InstallError("Managed current release symlink escapes the releases directory") from exc

    def _validate_bundle(self, bundle: Path) -> tuple[Path, str]:
        source = bundle.resolve(strict=True)
        if not source.is_dir():
            raise InstallError(f"Release bundle is not a directory: {source}")
        required = (
            source / "dist" / "index.html",
            source / "server" / "mobile_relay.py",
            source / "VERSION",
            source / "MANIFEST.sha256",
        )
        if not all(path.is_file() for path in required):
            raise InstallError(
                "Bundle must contain VERSION, MANIFEST.sha256, dist/index.html, and server/mobile_relay.py"
            )
        version = required[2].read_text(encoding="utf-8").strip()
        if not VERSION_RE.fullmatch(version):
            raise InstallError(f"Unsafe or invalid release VERSION: {version!r}")
        for path in source.rglob("*"):
            if path.is_symlink():
                raise InstallError(f"Release bundles may not contain symlinks: {path.relative_to(source)}")
        manifest_entries: dict[str, str] = {}
        for line_number, line in enumerate(required[3].read_text(encoding="utf-8").splitlines(), 1):
            if "  " not in line:
                raise InstallError(f"Malformed release manifest line {line_number}")
            digest, relative = line.split("  ", 1)
            posix_path = PurePosixPath(relative)
            if (
                not re.fullmatch(r"[0-9a-f]{64}", digest)
                or not relative
                or "\\" in relative
                or posix_path.is_absolute()
                or ".." in posix_path.parts
                or relative in manifest_entries
                or relative == "MANIFEST.sha256"
            ):
                raise InstallError(f"Unsafe release manifest entry on line {line_number}")
            manifest_entries[relative] = digest

        actual_files = {
            path.relative_to(source).as_posix()
            for path in source.rglob("*")
            if path.is_file() and path != required[3]
        }
        if actual_files != set(manifest_entries):
            raise InstallError("Release manifest does not match the exact bundle file set")
        for relative, expected_digest in manifest_entries.items():
            actual_digest = hashlib.sha256((source / relative).read_bytes()).hexdigest()
            if actual_digest != expected_digest:
                raise InstallError(f"Release digest mismatch: {relative}")
        return source, version

    def _read_state(self) -> dict | None:
        if not self.state_path.is_file():
            return None
        try:
            state = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise InstallError(f"Installer state is unreadable: {exc}") from exc
        if not isinstance(state, dict):
            raise InstallError("Installer state schema requires a JSON object")
        legacy_keys = STATE_KEYS - {"schema_version"}
        if set(state) == legacy_keys:
            state = {"schema_version": STATE_SCHEMA_VERSION, **state}
        if set(state) != STATE_KEYS or not self._state_valid(state):
            raise InstallError("Installer state schema has missing, unknown, or unsupported fields")
        return state

    @staticmethod
    def _state_valid(state: object) -> bool:
        if not isinstance(state, dict) or set(state) != STATE_KEYS:
            return False
        return bool(
            type(state.get("schema_version")) is int
            and state["schema_version"] == STATE_SCHEMA_VERSION
            and isinstance(state.get("version"), str)
            and VERSION_RE.fullmatch(state["version"])
            and isinstance(state.get("history"), list)
            and all(isinstance(item, str) and VERSION_RE.fullmatch(item) for item in state["history"])
            and type(state.get("relay_port")) is int
            and 4175 <= state["relay_port"] <= 4274
            and type(state.get("https_port")) is int
            and 8443 <= state["https_port"] <= 8542
            and isinstance(state.get("dns_name"), str)
            and DNS_NAME_RE.fullmatch(state["dns_name"])
            and state.get("url") == f"https://{state['dns_name']}:{state['https_port']}/"
            and type(state.get("backend_owned")) is bool
            and isinstance(state.get("tailscale_original"), dict)
        )

    def _write_state(self, state: dict) -> None:
        if not self._state_valid(state):
            raise InstallError("Refusing to write an invalid installer state schema")
        _atomic_write(self.state_path, json.dumps(state, indent=2, sort_keys=True) + "\n")

    def _write_transaction(self, transaction: dict) -> None:
        if not self._transaction_valid(transaction):
            raise InstallError("Refusing to write an invalid lifecycle transaction schema")
        _atomic_write(self.transaction_path, json.dumps(transaction, indent=2, sort_keys=True) + "\n")

    def _transaction_valid(self, transaction: object) -> bool:
        if not isinstance(transaction, dict) or set(transaction) != TRANSACTION_KEYS:
            return False
        unit_backups = transaction.get("unit_backups")
        old_state = transaction.get("old_state")
        old_current = transaction.get("old_current")
        old_current_valid = old_current is None
        if isinstance(old_current, str) and Path(old_current).is_absolute():
            try:
                Path(old_current).resolve(strict=False).relative_to(self.releases.resolve(strict=False))
                old_current_valid = True
            except ValueError:
                old_current_valid = False
        return bool(
            type(transaction.get("schema_version")) is int
            and transaction["schema_version"] == TRANSACTION_SCHEMA_VERSION
            and transaction.get("operation") in {"install", "rollback", "uninstall"}
            and transaction.get("phase") in {"mutating", "committed"}
            and (old_state is None or (
                isinstance(old_state, dict)
                and self._state_valid(old_state)
            ))
            and old_current_valid
            and isinstance(unit_backups, dict)
            and set(unit_backups) == {RELAY_UNIT, BACKEND_UNIT}
            and all(value is None or isinstance(value, str) for value in unit_backups.values())
            and (transaction.get("snapshot_before") is None or isinstance(transaction.get("snapshot_before"), str))
            and isinstance(transaction.get("serve_before"), dict)
            and isinstance(transaction.get("dns_name"), str)
            and DNS_NAME_RE.fullmatch(transaction["dns_name"])
            and type(transaction.get("relay_port")) is int
            and 4175 <= transaction["relay_port"] <= 4274
            and type(transaction.get("https_port")) is int
            and 8443 <= transaction["https_port"] <= 8542
            and isinstance(transaction.get("release_version"), str)
            and VERSION_RE.fullmatch(transaction["release_version"])
            and type(transaction.get("release_existed_before")) is bool
            and type(transaction.get("backend_will_create")) is bool
        )

    def _read_transaction(self) -> dict | None:
        if not self.transaction_path.exists():
            return None
        if self.transaction_path.is_symlink() or not self.transaction_path.is_file():
            raise InstallError("Lifecycle transaction path is not a regular file")
        try:
            transaction = json.loads(self.transaction_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise InstallError(f"Lifecycle transaction is unreadable: {exc}") from exc
        if not self._transaction_valid(transaction):
            raise InstallError("Lifecycle transaction schema is invalid")
        return transaction

    def _clear_transaction(self) -> None:
        self.transaction_path.unlink(missing_ok=True)
        directory_fd = os.open(self.transaction_path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def _serve_config(self) -> tuple[dict, str]:
        raw = self.runner.run(["tailscale", "serve", "status", "--json"])
        try:
            config = json.loads(raw or "{}")
        except json.JSONDecodeError as exc:
            raise InstallError(f"tailscale serve status returned invalid JSON: {exc}") from exc
        if not isinstance(config, dict):
            raise InstallError("Tailscale Serve config must be a JSON object")
        return config, raw

    def _add_serve_handler(self, https_port: int, relay_port: int) -> None:
        self.runner.run([
            "tailscale", "serve", "--bg", "--yes", f"--https={https_port}",
            f"http://127.0.0.1:{relay_port}",
        ])

    def _remove_serve_handler(self, https_port: int) -> None:
        self.runner.run(["tailscale", "serve", "--yes", f"--https={https_port}", "off"])

    def _tailscale_name(self) -> str:
        raw = self.runner.run(["tailscale", "status", "--json"])
        try:
            name = json.loads(raw)["Self"]["DNSName"].rstrip(".")
        except (KeyError, TypeError, json.JSONDecodeError, AttributeError) as exc:
            raise InstallError("Tailscale is not authenticated or has no MagicDNS name") from exc
        if not name or "." not in name:
            raise InstallError("Tailscale returned an invalid MagicDNS name")
        return name

    @staticmethod
    def _used_ports(config: dict) -> set[int]:
        used: set[int] = set()
        for key in config.get("TCP", {}) or {}:
            try:
                used.add(int(key))
            except (TypeError, ValueError):
                pass
        for key in config.get("Web", {}) or {}:
            try:
                used.add(int(str(key).rsplit(":", 1)[1]))
            except (IndexError, ValueError):
                pass
        return used

    @staticmethod
    def _add_handler(config: dict, *, dns_name: str, https_port: int, relay_port: int) -> dict:
        target = copy.deepcopy(config)
        tcp = target.setdefault("TCP", {})
        web = target.setdefault("Web", {})
        if not isinstance(tcp, dict) or not isinstance(web, dict):
            raise InstallError("Unsupported Tailscale Serve config shape")
        port_key = str(https_port)
        host_key = f"{dns_name}:{https_port}"
        if port_key in tcp or host_key in web:
            raise InstallError(f"Tailscale Serve HTTPS port {https_port} is already configured")
        tcp[port_key] = {"HTTPS": True}
        web[host_key] = {"Handlers": {"/": {"Proxy": f"http://127.0.0.1:{relay_port}"}}}

        # Security invariant: every pre-existing byte-equivalent JSON subtree is
        # unchanged; the only additions are one listener and one handler.
        check = copy.deepcopy(target)
        del check["TCP"][port_key]
        del check["Web"][host_key]
        if not check["TCP"] and "TCP" not in config:
            del check["TCP"]
        if not check["Web"] and "Web" not in config:
            del check["Web"]
        if _canonical(check) != _canonical(config):
            raise InstallError("Refusing a Tailscale mutation that changes existing handlers")
        return target

    @staticmethod
    def _without_owned_handler(
        config: dict, *, dns_name: str, https_port: int, relay_port: int
    ) -> dict:
        target = copy.deepcopy(config)
        port_key = str(https_port)
        host_key = f"{dns_name}:{https_port}"
        expected_tcp = {"HTTPS": True}
        expected_web = {"Handlers": {"/": {"Proxy": f"http://127.0.0.1:{relay_port}"}}}

        if target.get("TCP", {}).get(port_key) != expected_tcp or target.get("Web", {}).get(host_key) != expected_web:
            raise InstallError("Tailscale handler changed ownership; refusing to remove it")

        del target["TCP"][port_key]
        del target["Web"][host_key]
        if not target["TCP"]:
            del target["TCP"]
        if not target["Web"]:
            del target["Web"]
        return target

    def _wait_for(self, url: str, expected: int, attempts: int = 10) -> bool:
        for attempt in range(attempts):
            if self.http_status(url) == expected:
                return True
            if attempt + 1 < attempts:
                self.sleep(0.25)
        return False

    def _backend_preflight(self, status: int | None = None) -> bool:
        status = self.http_status(SENSITIVE_PROBE) if status is None else status
        if status == 401:
            return False
        if status != 0:
            raise InstallError(
                f"Unauthenticated {SENSITIVE_PROBE} returned {status}, not 401; refusing exposure"
            )
        self._write_backend_unit()
        self.runner.run(["systemctl", "--user", "daemon-reload"])
        self.runner.run(["systemctl", "--user", "enable", "--now", BACKEND_UNIT])
        if not self._wait_for(SENSITIVE_PROBE, 401):
            raise InstallError("Installed backend did not return 401 for an unauthenticated sensitive route")
        return True

    def _python_executable(self) -> Path:
        sibling = self.hermes_executable.parent / "python"
        return sibling.resolve() if sibling.is_file() and os.access(sibling, os.X_OK) else Path(sys.executable).resolve()

    def _write_backend_unit(self) -> None:
        command = " ".join(
            _unit_arg(item)
            for item in (
                self.hermes_executable, "serve", "--host", "127.0.0.1",
                "--port", "9119", "--skip-build",
            )
        )
        content = (
            "[Unit]\nDescription=Hermes authenticated loopback backend for mobile relay\n"
            "After=network.target\n\n[Service]\nType=simple\n"
            f"Environment={_unit_arg(f'HERMES_HOME={self.hermes_home}')}\n"
            f"ExecStart={command}\nRestart=on-failure\nRestartSec=3\n\n"
            "[Install]\nWantedBy=default.target\n"
        )
        _atomic_write(self.unit_dir / BACKEND_UNIT, content, 0o644)

    def _write_relay_unit(self, release: Path, relay_port: int) -> None:
        command = " ".join(
            _unit_arg(item)
            for item in (
                self._python_executable(),
                "-I",
                release / "server" / "mobile_relay.py",
                "--static-root", release / "dist",
                "--upstream", "http://127.0.0.1:9119",
                "--backend-id", "strix-halo",
                "--backend-label", "Strix Halo",
                "--host", "127.0.0.1",
                "--port", str(relay_port),
            )
        )
        content = (
            "[Unit]\nDescription=Hermes private mobile relay\nAfter=network.target\n\n"
            "[Service]\nType=simple\n" f"ExecStart={command}\n"
            "Restart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\n\n"
            "[Install]\nWantedBy=default.target\n"
        )
        _atomic_write(self.unit_dir / RELAY_UNIT, content, 0o644)

    @staticmethod
    def _verify_existing_release(source: Path, destination: Path) -> None:
        if not destination.is_dir():
            raise InstallError(f"Release destination is not a directory: {destination}")
        expected: dict[str, str] = {}
        for source_root_name in ("dist", "server"):
            source_root = source / source_root_name
            for path in source_root.rglob("*"):
                if path.is_symlink():
                    raise InstallError(f"Verified bundle contains a symlink: {path}")
                if path.is_file():
                    relative = path.relative_to(source).as_posix()
                    expected[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        expected["VERSION"] = hashlib.sha256((source / "VERSION").read_bytes()).hexdigest()

        actual: dict[str, str] = {}
        for path in destination.rglob("*"):
            if path.is_symlink():
                raise InstallError(f"Existing release contains a symlink: {path}")
            if path.is_file():
                relative = path.relative_to(destination).as_posix()
                actual[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            raise InstallError("Existing release does not match the verified bundle bytes")

    def _stage_release(self, source: Path, version: str) -> tuple[Path, bool]:
        self.releases.mkdir(parents=True, exist_ok=True)
        os.chmod(self.install_root, 0o700)
        os.chmod(self.releases, 0o700)
        destination = self.releases / version
        if destination.exists():
            self._verify_existing_release(source, destination)
            return destination, False
        temporary = self.releases / f".{version}.{os.getpid()}.tmp"
        shutil.rmtree(temporary, ignore_errors=True)
        temporary.mkdir(mode=0o700)
        try:
            shutil.copytree(source / "dist", temporary / "dist")
            shutil.copytree(source / "server", temporary / "server")
            shutil.copy2(source / "VERSION", temporary / "VERSION")
            _secure_tree(temporary)
            os.replace(temporary, destination)
        finally:
            shutil.rmtree(temporary, ignore_errors=True)
        return destination, True

    def _transaction_record(
        self,
        *,
        operation: str,
        old_state: dict | None,
        old_current: Path | None,
        unit_backups: dict[str, str | None],
        snapshot_before: str | None,
        serve_before: dict,
        dns_name: str,
        relay_port: int,
        https_port: int,
        release_version: str,
        release_existed_before: bool,
        backend_will_create: bool,
    ) -> dict:
        return {
            "schema_version": TRANSACTION_SCHEMA_VERSION,
            "operation": operation,
            "phase": "mutating",
            "old_state": old_state,
            "old_current": str(old_current) if old_current is not None else None,
            "unit_backups": unit_backups,
            "snapshot_before": snapshot_before,
            "serve_before": serve_before,
            "dns_name": dns_name,
            "relay_port": relay_port,
            "https_port": https_port,
            "release_version": release_version,
            "release_existed_before": release_existed_before,
            "backend_will_create": backend_will_create,
        }

    def _remove_transaction_handler_if_owned(self, transaction: dict) -> None:
        current, _ = self._serve_config()
        dns_name = str(transaction["dns_name"])
        https_port = int(transaction["https_port"])
        relay_port = int(transaction["relay_port"])
        port_key = str(https_port)
        host_key = f"{dns_name}:{https_port}"
        expected_tcp = {"HTTPS": True}
        expected_web = {"Handlers": {"/": {"Proxy": f"http://127.0.0.1:{relay_port}"}}}
        before = transaction["serve_before"]
        existed_before = (
            before.get("TCP", {}).get(port_key) == expected_tcp
            and before.get("Web", {}).get(host_key) == expected_web
        )
        if existed_before:
            return
        tcp_value = current.get("TCP", {}).get(port_key)
        web_value = current.get("Web", {}).get(host_key)
        if tcp_value is None and web_value is None:
            return
        expected_after = self._without_owned_handler(
            current, dns_name=dns_name, https_port=https_port, relay_port=relay_port
        )
        self._remove_serve_handler(https_port)
        restored, _ = self._serve_config()
        if _canonical(restored) != _canonical(expected_after):
            raise InstallError("Interrupted transaction could not remove only its owned Tailscale handler")

    def _restore_interrupted_transaction(self, transaction: dict) -> None:
        self._remove_transaction_handler_if_owned(transaction)
        self.runner.run(["systemctl", "--user", "stop", RELAY_UNIT], check=False)
        unit_backups = transaction["unit_backups"]
        if set(unit_backups) != {RELAY_UNIT, BACKEND_UNIT}:
            raise InstallError("Lifecycle transaction unit backup schema is invalid")
        if unit_backups[BACKEND_UNIT] is None and transaction["backend_will_create"]:
            self.runner.run(["systemctl", "--user", "disable", "--now", BACKEND_UNIT], check=False)
        for name, content in unit_backups.items():
            path = self.unit_dir / name
            if content is None:
                path.unlink(missing_ok=True)
            elif isinstance(content, str):
                _atomic_write(path, content, 0o644)
            else:
                raise InstallError("Lifecycle transaction unit backup is invalid")

        old_current = transaction["old_current"]
        if old_current is None:
            self.current.unlink(missing_ok=True)
        else:
            target = Path(old_current).resolve(strict=False)
            try:
                target.relative_to(self.releases.resolve(strict=False))
            except ValueError as exc:
                raise InstallError("Lifecycle transaction current target escapes releases") from exc
            if not target.is_dir() or target.is_symlink():
                raise InstallError("Lifecycle transaction current target is missing or unsafe")
            _atomic_link(target, self.current)

        if not transaction["release_existed_before"]:
            release = self.releases / str(transaction["release_version"])
            if release.exists():
                if release.is_symlink() or not release.is_dir():
                    raise InstallError("Interrupted release cleanup target is unsafe")
                shutil.rmtree(release)

        old_state = transaction["old_state"]
        if old_state is None:
            self.state_path.unlink(missing_ok=True)
        else:
            self._write_state(old_state)
        snapshot_before = transaction["snapshot_before"]
        if snapshot_before is None:
            self.snapshot_path.unlink(missing_ok=True)
        elif isinstance(snapshot_before, str):
            _atomic_write(self.snapshot_path, snapshot_before)
        else:
            raise InstallError("Lifecycle transaction snapshot backup is invalid")
        self.runner.run(["systemctl", "--user", "daemon-reload"], check=False)
        if old_state is not None:
            self.runner.run(["systemctl", "--user", "enable", "--now", RELAY_UNIT], check=False)
        self._clear_transaction()

    def _complete_uninstall_transaction(self, transaction: dict) -> None:
        current, _ = self._serve_config()
        dns_name = str(transaction["dns_name"])
        https_port = int(transaction["https_port"])
        relay_port = int(transaction["relay_port"])
        port_key = str(https_port)
        host_key = f"{dns_name}:{https_port}"
        tcp_value = current.get("TCP", {}).get(port_key)
        web_value = current.get("Web", {}).get(host_key)
        if tcp_value is not None or web_value is not None:
            expected_after = self._without_owned_handler(
                current, dns_name=dns_name, https_port=https_port, relay_port=relay_port
            )
            self._remove_serve_handler(https_port)
            restored, _ = self._serve_config()
            if _canonical(restored) != _canonical(expected_after):
                raise InstallError("Uninstall could not remove only its owned Tailscale handler")
        state = transaction["old_state"] or {}
        self.runner.run(["systemctl", "--user", "disable", "--now", RELAY_UNIT], check=False)
        if state.get("backend_owned"):
            self.runner.run(["systemctl", "--user", "disable", "--now", BACKEND_UNIT], check=False)
        (self.unit_dir / RELAY_UNIT).unlink(missing_ok=True)
        if state.get("backend_owned"):
            (self.unit_dir / BACKEND_UNIT).unlink(missing_ok=True)
        self.runner.run(["systemctl", "--user", "daemon-reload"], check=False)
        if self.install_root.exists():
            if self.install_root.is_symlink() or not self.install_root.is_dir():
                raise InstallError("Install root became unsafe during uninstall recovery")
            shutil.rmtree(self.install_root)
        self._clear_transaction()

    def _recover_pending(self) -> None:
        transaction = self._read_transaction()
        if transaction is None:
            return
        if transaction["phase"] == "committed":
            self._clear_transaction()
            return
        if transaction["operation"] == "uninstall":
            self._complete_uninstall_transaction(transaction)
        else:
            self._restore_interrupted_transaction(transaction)

    def install(self, bundle: Path) -> InstallResult:
        with self._lifecycle_lock():
            self._validate_managed_paths()
            self._recover_pending()
            return self._install_locked(bundle)

    def _install_locked(self, bundle: Path) -> InstallResult:
        source, version = self._validate_bundle(bundle)
        self._validate_managed_paths()
        destination = self.releases / version
        if destination.exists():
            self._verify_existing_release(source, destination)
        self._validate_prerequisites()
        old_state = self._read_state()
        old_current = None
        if self.current.is_symlink():
            old_current = self.current.resolve(strict=False)
        unit_backups = {
            name: path.read_text(encoding="utf-8") if path.is_file() else None
            for name, path in ((RELAY_UNIT, self.unit_dir / RELAY_UNIT), (BACKEND_UNIT, self.unit_dir / BACKEND_UNIT))
        }
        snapshot_before = self.snapshot_path.read_text(encoding="utf-8") if self.snapshot_path.is_file() else None
        backend_owned = False
        release: Path | None = None
        release_created = False
        serve_before: dict | None = None
        https_port: int | None = None
        serve_changed = False
        serve_before, raw_snapshot = self._serve_config()
        dns_name = self._tailscale_name()

        if old_state:
            relay_port = int(old_state["relay_port"])
            https_port = int(old_state["https_port"])
            target_config = serve_before
        else:
            used = self._used_ports(serve_before)
            relay_port = self.choose_port(set())
            https_port = self.choose_https_port(used)
            target_config = self._add_handler(
                serve_before, dns_name=dns_name, https_port=https_port, relay_port=relay_port
            )
        transaction = self._transaction_record(
            operation="install",
            old_state=old_state,
            old_current=old_current,
            unit_backups=unit_backups,
            snapshot_before=snapshot_before,
            serve_before=serve_before,
            dns_name=dns_name,
            relay_port=relay_port,
            https_port=https_port,
            release_version=version,
            release_existed_before=(self.releases / version).exists(),
            backend_will_create=False,
        )
        backend_status = self.http_status(SENSITIVE_PROBE)
        if backend_status not in {0, 401}:
            self._clear_transaction()
            raise InstallError(
                f"Unauthenticated {SENSITIVE_PROBE} returned {backend_status}, not 401; refusing exposure"
            )
        transaction["backend_will_create"] = backend_status == 0
        self._write_transaction(transaction)
        try:
            backend_owned = self._backend_preflight(backend_status)

            if old_state and old_state.get("version") == version:
                release = self.releases / version
                if not release.is_dir():
                    raise InstallError("Installed release directory is missing")
                self._write_relay_unit(release, relay_port)
                self.runner.run(["systemctl", "--user", "daemon-reload"])
                self.runner.run(["systemctl", "--user", "enable", "--now", RELAY_UNIT])
                if not self._wait_for(f"http://127.0.0.1:{relay_port}/", 200):
                    raise InstallError("Relay health check failed during idempotent install")
                if backend_owned and not old_state["backend_owned"]:
                    old_state["backend_owned"] = True
                    self._write_state(old_state)
                transaction["phase"] = "committed"
                self._write_transaction(transaction)
                self._clear_transaction()
                return InstallResult(version, old_state["url"], relay_port, https_port)

            release, release_created = self._stage_release(source, version)
            self._write_relay_unit(release, relay_port)
            _atomic_link(release, self.current)

            if not old_state:
                _atomic_write(self.snapshot_path, raw_snapshot if raw_snapshot.endswith("\n") else raw_snapshot + "\n")
                self._add_serve_handler(https_port, relay_port)
                serve_changed = True
                actual, _ = self._serve_config()
                if _canonical(actual) != _canonical(target_config):
                    raise InstallError("Tailscale Serve did not preserve the exact requested handler config")

            self.runner.run(["systemctl", "--user", "daemon-reload"])
            self.runner.run(["systemctl", "--user", "enable", "--now", RELAY_UNIT])
            if not self._wait_for(STATUS_PROBE, 200):
                raise InstallError("Hermes backend health check failed")
            if not self._wait_for(f"http://127.0.0.1:{relay_port}/", 200):
                raise InstallError("Hermes mobile relay health check failed")
            if self.http_status(SENSITIVE_PROBE) != 401:
                raise InstallError("Sensitive backend route stopped returning 401; restoring Tailscale")

            original = old_state.get("tailscale_original") if old_state else serve_before
            history = list(old_state.get("history", [])) if old_state else []
            if old_state and old_state.get("version") not in history:
                history.append(old_state["version"])
            state = {
                "schema_version": STATE_SCHEMA_VERSION,
                "version": version,
                "history": history,
                "relay_port": relay_port,
                "https_port": https_port,
                "dns_name": dns_name,
                "url": f"https://{dns_name}:{https_port}/",
                "backend_owned": bool((old_state or {}).get("backend_owned") or backend_owned),
                "tailscale_original": original,
            }
            self._write_state(state)
            transaction["phase"] = "committed"
            self._write_transaction(transaction)
            self._clear_transaction()
            return InstallResult(version, state["url"], relay_port, https_port)
        except BaseException as original_error:
            try:
                self._restore_interrupted_transaction(transaction)
            except Exception as recovery_error:
                raise InstallError(
                    f"Install failed and durable recovery remains pending: {recovery_error}"
                ) from original_error
            raise

    def rollback(self) -> InstallResult:
        with self._lifecycle_lock():
            self._validate_managed_paths()
            self._recover_pending()
            return self._rollback_locked()

    def _rollback_locked(self) -> InstallResult:
        self._validate_managed_paths()
        state = self._read_state()
        if not state:
            raise InstallError("Nothing is installed")
        history = list(state.get("history", []))
        if not history:
            raise InstallError("No previous release is available for rollback")
        version = history.pop()
        release = self.releases / version
        if not release.is_dir():
            raise InstallError(f"Rollback release is missing: {version}")
        current_version = state["version"]
        current_release = self.releases / current_version
        old_unit_path = self.unit_dir / RELAY_UNIT
        old_unit = old_unit_path.read_text(encoding="utf-8") if old_unit_path.is_file() else None
        backend_path = self.unit_dir / BACKEND_UNIT
        backend_unit = backend_path.read_text(encoding="utf-8") if backend_path.is_file() else None
        serve_before, _ = self._serve_config()
        transaction = self._transaction_record(
            operation="rollback",
            old_state=copy.deepcopy(state),
            old_current=current_release,
            unit_backups={RELAY_UNIT: old_unit, BACKEND_UNIT: backend_unit},
            snapshot_before=self.snapshot_path.read_text(encoding="utf-8") if self.snapshot_path.is_file() else None,
            serve_before=serve_before,
            dns_name=str(state["dns_name"]),
            relay_port=int(state["relay_port"]),
            https_port=int(state["https_port"]),
            release_version=version,
            release_existed_before=True,
            backend_will_create=False,
        )
        self._write_transaction(transaction)
        try:
            _atomic_link(release, self.current)
            self._write_relay_unit(release, int(state["relay_port"]))
            self.runner.run(["systemctl", "--user", "daemon-reload"])
            self.runner.run(["systemctl", "--user", "restart", RELAY_UNIT])
            if not self._wait_for(f"http://127.0.0.1:{state['relay_port']}/", 200):
                raise InstallError("Rolled-back relay failed its health check")
        except BaseException as original_error:
            try:
                self._restore_interrupted_transaction(transaction)
                self.runner.run(["systemctl", "--user", "restart", RELAY_UNIT], check=False)
            except Exception as recovery_error:
                raise InstallError(
                    f"Rollback failed and durable recovery remains pending: {recovery_error}"
                ) from original_error
            raise
        state["version"] = version
        state["history"] = history + [current_version]
        self._write_state(state)
        transaction["phase"] = "committed"
        self._write_transaction(transaction)
        self._clear_transaction()
        return InstallResult(version, state["url"], int(state["relay_port"]), int(state["https_port"]))

    def uninstall(self) -> None:
        with self._lifecycle_lock():
            self._validate_managed_paths()
            self._recover_pending()
            self._uninstall_locked()

    def _uninstall_locked(self) -> None:
        self._validate_managed_paths()
        state = self._read_state()
        if not state:
            return
        original = state.get("tailscale_original")
        if not isinstance(original, dict):
            raise InstallError("Cannot uninstall safely: original Tailscale snapshot is missing")
        current_serve, _ = self._serve_config()
        current_release = self.current.resolve(strict=False) if self.current.is_symlink() else None
        relay_path = self.unit_dir / RELAY_UNIT
        backend_path = self.unit_dir / BACKEND_UNIT
        transaction = self._transaction_record(
            operation="uninstall",
            old_state=copy.deepcopy(state),
            old_current=current_release,
            unit_backups={
                RELAY_UNIT: relay_path.read_text(encoding="utf-8") if relay_path.is_file() else None,
                BACKEND_UNIT: backend_path.read_text(encoding="utf-8") if backend_path.is_file() else None,
            },
            snapshot_before=self.snapshot_path.read_text(encoding="utf-8") if self.snapshot_path.is_file() else None,
            serve_before=current_serve,
            dns_name=str(state["dns_name"]),
            relay_port=int(state["relay_port"]),
            https_port=int(state["https_port"]),
            release_version=str(state["version"]),
            release_existed_before=True,
            backend_will_create=False,
        )
        self._write_transaction(transaction)
        self._complete_uninstall_transaction(transaction)


def _resolve_hermes(value: str | None) -> Path:
    candidate = value or shutil.which("hermes")
    if not candidate:
        raise InstallError("hermes is not on PATH; pass --hermes-executable")
    return Path(candidate).resolve()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Install the private Hermes mobile relay on Linux")
    parser.add_argument("command", choices=("install", "rollback", "uninstall"))
    parser.add_argument("bundle", type=Path, nargs="?", help="release bundle containing VERSION, dist, and server")
    parser.add_argument("--hermes-executable", help="exact Hermes executable (default: resolved from PATH)")
    args = parser.parse_args(argv)
    if args.command == "install" and args.bundle is None:
        parser.error("install requires BUNDLE")
    home = Path.home()
    hermes_home = Path(os.environ.get("HERMES_HOME", home / ".hermes"))
    app = FriendInstaller(home=home, hermes_home=hermes_home, hermes_executable=_resolve_hermes(args.hermes_executable))
    try:
        if args.command == "install":
            result = app.install(args.bundle)
            print("Installed Hermes mobile control center.")
            print(f"Private iPhone URL: {result.url}")
            print("Open it in Safari, then Share → Add to Home Screen.")
        elif args.command == "rollback":
            result = app.rollback()
            print(f"Rolled back to {result.version}. Private URL: {result.url}")
        else:
            app.uninstall()
            print("Hermes mobile control center uninstalled; Tailscale Serve restored exactly.")
    except InstallError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
