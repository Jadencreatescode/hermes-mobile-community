from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("installer.py")
REPO_ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("strix_installer", MODULE_PATH)
assert spec and spec.loader
installer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = installer
spec.loader.exec_module(installer)


class FakeRunner:
    def __init__(self, serve_config: dict, *, fail_start: bool = False, fail_restart: bool = False):
        self.config = copy.deepcopy(serve_config)
        self.calls: list[tuple[tuple[str, ...], str | None]] = []
        self.fail_start = fail_start
        self.fail_restart = fail_restart

    def run(self, args, *, input_text=None, check=True):
        args = tuple(str(a) for a in args)
        self.calls.append((args, input_text))
        if args == ("tailscale", "serve", "status", "--json"):
            return json.dumps(self.config, separators=(",", ":"))
        if args[:4] == ("tailscale", "serve", "--bg", "--yes"):
            https_port = int(args[4].split("=", 1)[1])
            relay_port = int(args[5].rsplit(":", 1)[1])
            self.config = installer.FriendInstaller._add_handler(
                self.config,
                dns_name="strix.friend.ts.net",
                https_port=https_port,
                relay_port=relay_port,
            )
            return ""
        if args[:3] == ("tailscale", "serve", "--yes") and args[-1] == "off":
            https_port = int(args[3].split("=", 1)[1])
            self.config.get("TCP", {}).pop(str(https_port), None)
            self.config.get("Web", {}).pop(f"strix.friend.ts.net:{https_port}", None)
            return ""
        if args == ("tailscale", "status", "--json"):
            return json.dumps({"Self": {"DNSName": "strix.friend.ts.net."}})
        if args[:3] in {
            ("systemctl", "--user", "start"),
            ("systemctl", "--user", "enable"),
        } and self.fail_start:
            raise installer.CommandError("start failed")
        if args[:3] == ("systemctl", "--user", "restart") and self.fail_restart and check:
            raise installer.CommandError("restart failed")
        return ""


def bundle(root: Path, version: str, marker: str = "one") -> Path:
    path = root / f"bundle-{version}"
    (path / "dist").mkdir(parents=True)
    (path / "server").mkdir()
    (path / "dist" / "index.html").write_text(f"<html>{marker}</html>")
    (path / "server" / "mobile_relay.py").write_text("print('relay')\n")
    (path / "VERSION").write_text(version + "\n")
    entries = []
    for file_path in sorted(p for p in path.rglob("*") if p.is_file()):
        relative = file_path.relative_to(path).as_posix()
        entries.append(f"{hashlib.sha256(file_path.read_bytes()).hexdigest()}  {relative}")
    (path / "MANIFEST.sha256").write_text("\n".join(entries) + "\n")
    return path


class ReleaseSecurityWorkflowTests(unittest.TestCase):
    def test_codeql_is_scoped_to_the_mobile_release_surface(self):
        workflow = REPO_ROOT / ".github" / "workflows" / "codeql-mobile.yml"
        config = REPO_ROOT / ".github" / "codeql" / "mobile-config.yml"
        self.assertTrue(workflow.is_file())
        self.assertTrue(config.is_file())

        workflow_text = workflow.read_text(encoding="utf-8")
        config_text = config.read_text(encoding="utf-8")
        release_workflow_text = (
            REPO_ROOT / ".github" / "workflows" / "hermes-mobile-release.yml"
        ).read_text(encoding="utf-8")
        for language in ("actions", "javascript-typescript", "python"):
            self.assertIn(f"language: {language}", workflow_text)
        self.assertNotIn("language: c-cpp", workflow_text)
        self.assertNotIn("language: rust", workflow_text)
        self.assertIn("github/codeql-action/init@", workflow_text)
        self.assertIn("github/codeql-action/analyze@", workflow_text)

        for path in (
            "apps/desktop",
            "apps/shared",
            "deploy/strix-halo",
            "server/mobile_relay.py",
            "scripts/npm-audit-policy.mjs",
            "tests-js/npm-audit-policy.test.ts",
            ".github/workflows/hermes-mobile-release.yml",
        ):
            self.assertIn(f"- {path}", config_text)

        for ignored_path in (
            'apps/desktop/**/*.test.ts',
            'apps/desktop/**/*.test.tsx',
            'apps/desktop/scripts/perf',
        ):
            self.assertIn(f'- "{ignored_path}"', config_text)

        for path in (
            ".github/workflows/codeql-mobile.yml",
            ".github/codeql/mobile-config.yml",
        ):
            self.assertIn(f'- "{path}"', release_workflow_text)

        for branch in ("main", "contrib/**", "release/strix-halo-*"):
            self.assertIn(f'- "{branch}"', workflow_text)
            self.assertIn(f'- "{branch}"', release_workflow_text)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.hermes_home = self.home / ".custom-hermes"
        self.hermes_home.mkdir()
        (self.hermes_home / "keep.txt").write_text("do not touch")
        self.hermes = self.root / "bin" / "hermes"
        self.hermes.parent.mkdir()
        self.hermes.write_text("#!/bin/sh\n")
        self.hermes.chmod(0o755)
        self.original = {
            "TCP": {"443": {"HTTPS": True}},
            "Web": {
                "strix.friend.ts.net:443": {
                    "Handlers": {
                        "/": {"Proxy": "http://127.0.0.1:1234"},
                        "/notes": {"Proxy": "http://127.0.0.1:3000"},
                    }
                }
            },
        }

    def tearDown(self):
        self.temp.cleanup()

    def make_installer(self, runner, statuses=None):
        statuses = statuses or {
            "http://127.0.0.1:9119/api/config": 401,
            "http://127.0.0.1:9119/api/status": 200,
        }

        def http_status(url):
            if url.startswith("http://127.0.0.1:41"):
                return 200
            value = statuses.get(url, 0)
            if isinstance(value, list):
                return value.pop(0) if len(value) > 1 else value[0]
            return value

        return installer.FriendInstaller(
            home=self.home,
            hermes_home=self.hermes_home,
            hermes_executable=self.hermes,
            runner=runner,
            http_status=http_status,
            choose_port=lambda used: next(p for p in range(4175, 4200) if p not in used),
            choose_https_port=lambda used: next(p for p in range(8443, 8500) if p not in used),
        )

    def assert_existing_handlers_unchanged(self, after):
        before_handlers = self.original["Web"]["strix.friend.ts.net:443"]["Handlers"]
        after_handlers = after["Web"]["strix.friend.ts.net:443"]["Handlers"]
        self.assertEqual(before_handlers, after_handlers)

    def test_install_is_atomic_private_and_preserves_existing_hermes(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        result = app.install(bundle(self.root, "1.2.3"))

        self.assertEqual((self.hermes_home / "keep.txt").read_text(), "do not touch")
        self.assertEqual((app.current / "dist" / "index.html").read_text(), "<html>one</html>")
        self.assertTrue(app.current.is_symlink())
        self.assertEqual(result.url, "https://strix.friend.ts.net:8443/")
        self.assert_existing_handlers_unchanged(runner.config)
        added = runner.config["Web"]["strix.friend.ts.net:8443"]["Handlers"]
        self.assertEqual(added, {"/": {"Proxy": "http://127.0.0.1:4175"}})
        commands = [call[0] for call in runner.calls]
        self.assertIn(
            ("tailscale", "serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:4175"),
            commands,
        )

        relay_unit = (app.unit_dir / "hermes-mobile-relay.service").read_text()
        self.assertIn("--host 127.0.0.1", relay_unit)
        self.assertIn("--port 4175", relay_unit)
        self.assertIn("--backend-id strix-halo", relay_unit)
        self.assertIn('"Strix Halo"', relay_unit)
        self.assertIn(str(app.releases / "1.2.3" / "server" / "mobile_relay.py"), relay_unit)
        self.assertNotIn("password", relay_unit.lower())
        self.assertNotIn("token", relay_unit.lower())
        for private_dir in (app.install_root, app.releases, app.releases / "1.2.3"):
            self.assertEqual(os.stat(private_dir).st_mode & 0o777, 0o700)
        for private_file in (app.state_path, app.snapshot_path, app.releases / "1.2.3" / "VERSION"):
            self.assertEqual(os.stat(private_file).st_mode & 0o777, 0o600)
        state = json.loads(app.state_path.read_text())
        self.assertEqual(state["schema_version"], 1)
        self.assertFalse(app.transaction_path.exists())

    def test_state_rejects_missing_and_unknown_fields(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        app.install_root.mkdir(parents=True)
        app.state_path.write_text(json.dumps({"schema_version": 1, "unexpected": True}))

        with self.assertRaisesRegex(installer.InstallError, "state schema"):
            app.rollback()

    def test_lifecycle_lock_refuses_a_concurrent_installer(self):
        runner = FakeRunner(self.original)
        first = self.make_installer(runner)
        second = self.make_installer(runner)

        with first._lifecycle_lock():
            with self.assertRaisesRegex(installer.InstallError, "already running"):
                second.install(bundle(self.root, "1.0.0"))

    def test_pending_install_transaction_is_recovered_before_retry(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        first = bundle(self.root, "1.0.0", "first")
        app.install(first)
        old_state = json.loads(app.state_path.read_text())
        old_current = app.current.resolve()
        old_relay_unit = (app.unit_dir / "hermes-mobile-relay.service").read_text()
        serve_before = copy.deepcopy(runner.config)
        runner.config = installer.FriendInstaller._add_handler(
            runner.config,
            dns_name="strix.friend.ts.net",
            https_port=8444,
            relay_port=4176,
        )
        app._write_transaction(
            {
                "schema_version": 1,
                "operation": "install",
                "phase": "mutating",
                "old_state": old_state,
                "old_current": str(old_current),
                "unit_backups": {
                    "hermes-mobile-relay.service": old_relay_unit,
                    "hermes-mobile-backend.service": None,
                },
                "snapshot_before": app.snapshot_path.read_text(),
                "serve_before": serve_before,
                "dns_name": "strix.friend.ts.net",
                "relay_port": 4176,
                "https_port": 8444,
                "release_version": "2.0.0",
                "release_existed_before": False,
                "backend_will_create": False,
            }
        )
        partial = app.releases / "2.0.0"
        partial.mkdir()
        (app.unit_dir / "hermes-mobile-relay.service").write_text("partial")
        app.current.unlink()
        app.current.symlink_to(partial)

        app.install(first)

        self.assertFalse(app.transaction_path.exists())
        self.assertEqual(app.current.resolve(), old_current)
        self.assertEqual((app.unit_dir / "hermes-mobile-relay.service").read_text(), old_relay_unit)
        self.assertFalse(partial.exists())
        self.assertNotIn("8444", runner.config.get("TCP", {}))

    def test_pending_uninstall_transaction_completes_after_handler_was_removed(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        app.install(bundle(self.root, "1.0.0"))
        state = json.loads(app.state_path.read_text())
        serve_before = copy.deepcopy(runner.config)
        transaction = app._transaction_record(
            operation="uninstall",
            old_state=state,
            old_current=app.current.resolve(),
            unit_backups={
                "hermes-mobile-relay.service": (app.unit_dir / "hermes-mobile-relay.service").read_text(),
                "hermes-mobile-backend.service": None,
            },
            snapshot_before=app.snapshot_path.read_text(),
            serve_before=serve_before,
            dns_name=state["dns_name"],
            relay_port=state["relay_port"],
            https_port=state["https_port"],
            release_version=state["version"],
            release_existed_before=True,
            backend_will_create=False,
        )
        app._write_transaction(transaction)
        runner.run(("tailscale", "serve", "--yes", "--https=8443", "off"))

        app.uninstall()

        self.assertEqual(runner.config, self.original)
        self.assertFalse(app.install_root.exists())
        self.assertFalse(app.transaction_path.exists())

    def test_corrupt_transaction_fails_closed_before_external_changes(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        app.transaction_path.parent.mkdir(parents=True)
        app.transaction_path.write_text(json.dumps({"schema_version": 1, "operation": "install"}))

        with self.assertRaisesRegex(installer.InstallError, "transaction schema"):
            app.install(bundle(self.root, "1.0.0"))

        self.assertEqual(runner.calls, [])
        self.assertEqual(runner.config, self.original)

    def test_transaction_current_target_escape_fails_before_external_changes(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        candidate = bundle(self.root, "1.0.0")
        app.install(candidate)
        state = json.loads(app.state_path.read_text())
        transaction = app._transaction_record(
            operation="rollback",
            old_state=state,
            old_current=app.current.resolve(),
            unit_backups={
                "hermes-mobile-relay.service": (app.unit_dir / "hermes-mobile-relay.service").read_text(),
                "hermes-mobile-backend.service": None,
            },
            snapshot_before=app.snapshot_path.read_text(),
            serve_before=copy.deepcopy(runner.config),
            dns_name=state["dns_name"],
            relay_port=state["relay_port"],
            https_port=state["https_port"],
            release_version=state["version"],
            release_existed_before=True,
            backend_will_create=False,
        )
        transaction["old_current"] = str(self.root / "outside")
        app.transaction_path.write_text(json.dumps(transaction))
        calls_before = list(runner.calls)

        with self.assertRaisesRegex(installer.InstallError, "transaction schema"):
            app.install(candidate)

        self.assertEqual(runner.calls, calls_before)

    def test_boolean_ports_are_rejected_by_strict_state_validation(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        app.install(bundle(self.root, "1.0.0"))
        state = json.loads(app.state_path.read_text())
        state["relay_port"] = True
        app.state_path.write_text(json.dumps(state))
        calls_before = list(runner.calls)

        with self.assertRaisesRegex(installer.InstallError, "state schema"):
            app.rollback()

        self.assertEqual(runner.calls, calls_before)

    def test_exact_legacy_state_migrates_during_rollback(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        app.install(bundle(self.root, "1.0.0", "first"))
        app.install(bundle(self.root, "2.0.0", "second"))
        legacy = json.loads(app.state_path.read_text())
        del legacy["schema_version"]
        app.state_path.write_text(json.dumps(legacy))

        app.rollback()

        migrated = json.loads(app.state_path.read_text())
        self.assertEqual(migrated["schema_version"], 1)
        self.assertEqual(migrated["version"], "1.0.0")

    def test_missing_auth_fails_closed_before_tailscale_change(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner, {"http://127.0.0.1:9119/api/config": 200})
        with self.assertRaisesRegex(installer.InstallError, "401"):
            app.install(bundle(self.root, "1.0.0"))
        self.assertEqual(runner.config, self.original)
        self.assertFalse(app.state_path.exists())

    def test_absent_backend_installs_user_service_with_exact_hermes(self):
        runner = FakeRunner(self.original)
        statuses = {
            "http://127.0.0.1:9119/api/config": [0, 401],
            "http://127.0.0.1:9119/api/status": 200,
        }
        app = self.make_installer(runner, statuses)
        app.install(bundle(self.root, "1.0.0"))
        unit = (app.unit_dir / "hermes-mobile-backend.service").read_text()
        self.assertIn(
            f"ExecStart={self.hermes.resolve()} serve --host 127.0.0.1 --port 9119 --skip-build",
            unit,
        )
        self.assertIn(f"Environment=HERMES_HOME={self.hermes_home}", unit)
        self.assertEqual((self.hermes_home / "keep.txt").read_text(), "do not touch")

    def test_failure_restores_tailscale_exactly_and_removes_partial_release(self):
        runner = FakeRunner(self.original, fail_start=True)
        app = self.make_installer(runner)
        with self.assertRaises(installer.CommandError):
            app.install(bundle(self.root, "2.0.0"))
        self.assertEqual(runner.config, self.original)
        self.assertFalse((app.releases / "2.0.0").exists())
        self.assertFalse(app.current.exists())

    def test_idempotent_upgrade_rollback_and_uninstall(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        first = bundle(self.root, "1.0.0", "first")
        app.install(first)
        first_config = copy.deepcopy(runner.config)
        app.install(first)
        self.assertEqual(runner.config, first_config)

        app.install(bundle(self.root, "2.0.0", "second"))
        self.assertEqual((app.current / "VERSION").read_text().strip(), "2.0.0")
        app.rollback()
        self.assertEqual((app.current / "VERSION").read_text().strip(), "1.0.0")
        self.assert_existing_handlers_unchanged(runner.config)

        app.uninstall()
        self.assertEqual(runner.config, self.original)
        self.assertIn(
            ("tailscale", "serve", "--yes", "--https=8443", "off"),
            [call[0] for call in runner.calls],
        )
        self.assertFalse(app.install_root.exists())
        self.assertFalse((app.unit_dir / "hermes-mobile-relay.service").exists())
        self.assertEqual((self.hermes_home / "keep.txt").read_text(), "do not touch")

    def test_invalid_or_incomplete_bundle_is_rejected(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        bad = self.root / "bad"
        bad.mkdir()
        (bad / "VERSION").write_text("../../escape")
        with self.assertRaises(installer.InstallError):
            app.install(bad)
        self.assertEqual(runner.calls, [])

    def test_tampered_release_manifest_is_rejected_before_system_changes(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        candidate = bundle(self.root, "1.0.0")
        (candidate / "dist" / "index.html").write_text("tampered")

        with self.assertRaisesRegex(installer.InstallError, "digest"):
            app.install(candidate)

        self.assertEqual(runner.calls, [])
        self.assertEqual(runner.config, self.original)

    def test_installer_rejects_symlinked_managed_root_without_external_writes(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        outside = self.root / "outside"
        outside.mkdir()
        app.install_root.parent.mkdir(parents=True)
        app.install_root.symlink_to(outside, target_is_directory=True)

        with self.assertRaisesRegex(installer.InstallError, "symlink"):
            app.install(bundle(self.root, "1.0.0"))

        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(runner.config, self.original)

    def test_installer_rejects_symlinked_systemd_ancestor_without_external_writes(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        outside = self.root / "outside-config"
        outside.mkdir()
        (self.home / ".config").symlink_to(outside, target_is_directory=True)

        with self.assertRaisesRegex(installer.InstallError, "symlink"):
            app.install(bundle(self.root, "1.0.0"))

        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(runner.calls, [])

    def test_preexisting_release_cannot_bypass_verified_bundle_bytes(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        candidate = bundle(self.root, "1.0.0")
        poisoned = app.releases / "1.0.0"
        (poisoned / "dist").mkdir(parents=True)
        (poisoned / "server").mkdir()
        (poisoned / "dist" / "index.html").write_text("attacker")
        (poisoned / "server" / "mobile_relay.py").write_text("print('attacker')")
        (poisoned / "VERSION").write_text("1.0.0\n")

        with self.assertRaisesRegex(installer.InstallError, "(?i)existing release"):
            app.install(candidate)

        self.assertEqual(runner.calls, [])
        self.assertEqual((poisoned / "server" / "mobile_relay.py").read_text(), "print('attacker')")

    def test_uninstall_refuses_to_remove_a_replaced_tailscale_handler(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        app.install(bundle(self.root, "1.0.0"))
        runner.config["Web"]["strix.friend.ts.net:8443"]["Handlers"]["/"] = {
            "Proxy": "http://127.0.0.1:9999"
        }
        replaced = copy.deepcopy(runner.config)
        off_command = ("tailscale", "serve", "--yes", "--https=8443", "off")
        off_count = [call[0] for call in runner.calls].count(off_command)

        with self.assertRaisesRegex(installer.InstallError, "changed ownership"):
            app.uninstall()

        self.assertEqual(runner.config, replaced)
        self.assertTrue(app.install_root.exists())
        self.assertEqual([call[0] for call in runner.calls].count(off_command), off_count)

    def test_failed_install_removes_an_installer_owned_backend_service(self):
        runner = FakeRunner(self.original)
        statuses = {
            "http://127.0.0.1:9119/api/config": [0, 401],
            "http://127.0.0.1:9119/api/status": 0,
        }
        app = self.make_installer(runner, statuses)
        with self.assertRaisesRegex(installer.InstallError, "backend health"):
            app.install(bundle(self.root, "3.0.0"))
        commands = [call[0] for call in runner.calls]
        self.assertIn(("systemctl", "--user", "disable", "--now", "hermes-mobile-backend.service"), commands)
        self.assertFalse((app.unit_dir / "hermes-mobile-backend.service").exists())

    def test_failed_rollback_restores_current_release_and_state(self):
        runner = FakeRunner(self.original)
        app = self.make_installer(runner)
        app.install(bundle(self.root, "1.0.0", "first"))
        app.install(bundle(self.root, "2.0.0", "second"))
        runner.fail_restart = True
        with self.assertRaises(installer.CommandError):
            app.rollback()
        self.assertEqual((app.current / "VERSION").read_text().strip(), "2.0.0")
        self.assertEqual(json.loads(app.state_path.read_text())["version"], "2.0.0")


if __name__ == "__main__":
    unittest.main()
