"""Git trampoline recovery; branch updates use the real target-identity suite."""

import subprocess
from unittest.mock import patch

import pytest

from hermes_cli import update_cmd


@pytest.fixture(autouse=True)
def _isolate_venv_holders(monkeypatch):
    """The update flow's venv-holder guard sees the live gateway processes on
    a dev machine and aborts with SystemExit 2 before reaching the branch
    logic under test.  Isolate it so the test exercises the intended path."""
    monkeypatch.setattr("hermes_cli.update_cmd_windows._detect_venv_python_processes", list)


class TestGitTrampolineSelfHeal:
    """Proactive Git-for-Windows trampoline self-heal (#87876).

    A broken bin\\git.exe / cmd\\git.exe shim (~46KB) refuses every git call
    with a "BUG (fork bomb)" guard instead of re-execing the real git-core
    binary. _ensure_non_trampoline_git detects this up front and swaps in a
    real git binary when one can be located, so the normal git update path
    survives instead of degrading to the ZIP fallback.
    """

    @staticmethod
    def _fake_run_healthy(command, **_kwargs):
        return subprocess.CompletedProcess(
            command, 0, stdout="git version 2.50.0.windows.1\n", stderr=""
        )

    @staticmethod
    def _fake_run_trampoline(command, **_kwargs):
        return subprocess.CompletedProcess(
            command,
            1,
            stdout="",
            stderr="BUG (fork bomb): tried to spawn itself, check your PATH\n",
        )

    @pytest.mark.platforms("windows")
    def test_healthy_git_command_unchanged(self):
        from hermes_cli import update_cmd

        git_cmd = ["git", "-c", "windows.appendAtomically=false"]
        with (
            patch(
                "hermes_cli.update_cmd.subprocess.run",
                side_effect=self._fake_run_healthy,
            ),
            patch("hermes_cli.update_cmd._locate_real_git") as locate,
        ):
            result = update_cmd._ensure_non_trampoline_git(git_cmd)
        assert result == git_cmd
        locate.assert_not_called()

    @pytest.mark.platforms("windows")
    def test_trampoline_swaps_to_real_git(self, capsys):
        from pathlib import Path

        from hermes_cli import update_cmd

        git_cmd = ["git", "-c", "windows.appendAtomically=false"]
        real = Path(r"C:\Program Files\Git\mingw64\libexec\git-core\git.exe")
        with (
            patch(
                "hermes_cli.update_cmd.subprocess.run",
                side_effect=self._fake_run_trampoline,
            ),
            patch(
                "hermes_cli.update_cmd._locate_real_git", return_value=real
            ),
        ):
            result = update_cmd._ensure_non_trampoline_git(git_cmd)
        assert result == [str(real), "-c", "windows.appendAtomically=false"]
        out = capsys.readouterr().out
        assert "switching to real git" in out

    @pytest.mark.platforms("windows")
    def test_trampoline_no_real_git_keeps_command(self, capsys):
        from hermes_cli import update_cmd

        git_cmd = ["git", "-c", "windows.appendAtomically=false"]
        with (
            patch(
                "hermes_cli.update_cmd.subprocess.run",
                side_effect=self._fake_run_trampoline,
            ),
            patch("hermes_cli.update_cmd._locate_real_git", return_value=None),
        ):
            result = update_cmd._ensure_non_trampoline_git(git_cmd)
        assert result == git_cmd
        out = capsys.readouterr().out
        assert "ZIP path" in out

    @pytest.mark.platforms("not windows")
    def test_off_windows_noop(self):
        from hermes_cli import update_cmd

        git_cmd = ["git"]
        with patch("hermes_cli.update_cmd.subprocess.run") as run:
            result = update_cmd._ensure_non_trampoline_git(git_cmd)
        assert result == git_cmd
        run.assert_not_called()

    def test_portable_git_candidates_check_shared_root_first(self, tmp_path, monkeypatch):
        # Profile-scoped layout: HERMES_HOME = <root>/profiles/foo, but the
        # PortableGit tree lives under the SHARED root (monerostar review on
        # #88136). The candidate list must check get_default_hermes_root()
        # before the profile home.
        import hermes_constants
        from hermes_cli.update_cmd_git import _portable_git_candidates

        root = tmp_path / "root"
        profile_home = root / "profiles" / "foo"

        monkeypatch.setattr(hermes_constants, "get_default_hermes_root", lambda: root)
        monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: profile_home)

        candidates = _portable_git_candidates()
        assert candidates[0] == (
            root / "git" / "mingw64" / "libexec" / "git-core" / "git.exe"
        )
        assert candidates[1] == (
            profile_home / "git" / "mingw64" / "libexec" / "git-core" / "git.exe"
        )

    def test_path_git_candidates_include_discovered_executable_and_real_layouts(self, monkeypatch):
        from pathlib import Path

        from hermes_cli.update_cmd_git import _path_git_candidates

        discovered = Path("/opt/Git/cmd/git.exe")
        monkeypatch.setattr("hermes_cli.update_cmd_git.shutil.which", lambda _name: str(discovered))

        candidates = _path_git_candidates()

        assert candidates[0] == discovered
        assert Path("/opt/Git/mingw64/libexec/git-core/git.exe") in candidates
        assert Path("/opt/Git/mingw64/bin/git.exe") in candidates

    def test_path_git_candidates_are_empty_without_a_path_git(self, monkeypatch):
        from hermes_cli.update_cmd_git import _path_git_candidates

        monkeypatch.setattr("hermes_cli.update_cmd_git.shutil.which", lambda _name: None)

        assert _path_git_candidates() == []

    def test_locate_real_git_requires_an_existing_healthy_candidate(self, tmp_path, monkeypatch):
        from hermes_cli.update_cmd_git import _locate_real_git

        missing = tmp_path / "missing" / "git.exe"
        broken = tmp_path / "broken" / "git.exe"
        healthy = tmp_path / "healthy" / "git.exe"
        broken.parent.mkdir()
        healthy.parent.mkdir()
        broken.touch()
        healthy.touch()

        monkeypatch.setattr(
            "hermes_cli.update_cmd_git._path_git_candidates",
            lambda: [missing, broken, healthy],
        )
        monkeypatch.setattr("hermes_cli.update_cmd_git._portable_git_candidates", list)
        monkeypatch.setattr(
            "hermes_cli.update_cmd_git._probe_fork_bomb",
            lambda command: command == [str(broken)],
        )

        assert _locate_real_git() == healthy
