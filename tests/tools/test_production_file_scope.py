"""Fail-closed filesystem scope for server-minted production sessions."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from tools.file_tools import patch_tool, read_file_tool, search_tool, write_file_tool
from tools.terminal_tool import clear_task_env_overrides, register_task_env_overrides


@pytest.fixture()
def production_scope(tmp_path: Path):
    workspace = tmp_path / "workspace"
    output = workspace / "output"
    outside = tmp_path / "outside"
    output.mkdir(parents=True)
    outside.mkdir()
    (outside / "secret.txt").write_text("private\n", encoding="utf-8")

    descriptor = os.open(workspace, os.O_RDONLY | os.O_DIRECTORY)
    capability = f"/proc/{os.getpid()}/fd/{descriptor}"
    task_id = "production-scope-test"
    register_task_env_overrides(
        task_id,
        {
            "cwd": capability,
            "cwd_source": "session",
            "file_scope_root": capability,
        },
    )
    try:
        yield task_id, workspace, output, outside
    finally:
        clear_task_env_overrides(task_id)
        os.close(descriptor)


def _payload(result: str) -> dict:
    return json.loads(result)


@pytest.mark.parametrize(
    "invoke",
    [
        lambda task_id, outside: read_file_tool(str(outside / "secret.txt"), task_id=task_id),
        lambda task_id, outside: search_tool("private", path=str(outside), task_id=task_id),
        lambda task_id, outside: write_file_tool(str(outside / "written.txt"), "no\n", task_id=task_id),
        lambda task_id, outside: patch_tool(
            mode="replace",
            path=str(outside / "secret.txt"),
            old_string="private",
            new_string="changed",
            task_id=task_id,
        ),
    ],
)
def test_production_scope_rejects_absolute_paths(production_scope, invoke):
    task_id, _workspace, _output, outside = production_scope

    result = _payload(invoke(task_id, outside))

    assert "error" in result
    assert "production file scope" in result["error"].lower()
    assert (outside / "secret.txt").read_text(encoding="utf-8") == "private\n"
    assert not (outside / "written.txt").exists()


@pytest.mark.parametrize(
    "invoke",
    [
        lambda task_id: read_file_tool("../outside/secret.txt", task_id=task_id),
        lambda task_id: search_tool("private", path="../outside", task_id=task_id),
        lambda task_id: write_file_tool("../outside/written.txt", "no\n", task_id=task_id),
        lambda task_id: patch_tool(
            mode="replace",
            path="../outside/secret.txt",
            old_string="private",
            new_string="changed",
            task_id=task_id,
        ),
    ],
)
def test_production_scope_rejects_parent_traversal(production_scope, invoke):
    task_id, _workspace, _output, outside = production_scope

    result = _payload(invoke(task_id))

    assert "error" in result
    assert "production file scope" in result["error"].lower()
    assert (outside / "secret.txt").read_text(encoding="utf-8") == "private\n"
    assert not (outside / "written.txt").exists()


@pytest.mark.parametrize(
    "invoke",
    [
        lambda task_id: read_file_tool("escape/secret.txt", task_id=task_id),
        lambda task_id: search_tool("private", path="escape", task_id=task_id),
        lambda task_id: write_file_tool("escape/written.txt", "no\n", task_id=task_id),
        lambda task_id: patch_tool(
            mode="replace",
            path="escape/secret.txt",
            old_string="private",
            new_string="changed",
            task_id=task_id,
        ),
    ],
)
def test_production_scope_rejects_symlink_escapes(production_scope, invoke):
    task_id, workspace, _output, outside = production_scope
    (workspace / "escape").symlink_to(outside, target_is_directory=True)

    result = _payload(invoke(task_id))

    assert "error" in result
    assert "production file scope" in result["error"].lower()
    assert (outside / "secret.txt").read_text(encoding="utf-8") == "private\n"
    assert not (outside / "written.txt").exists()


@pytest.mark.parametrize(
    "path",
    ["output ../outside", "output,/etc", "output ~/private"],
)
def test_production_scope_rejects_multiple_search_roots(production_scope, path):
    task_id, _workspace, _output, _outside = production_scope

    result = _payload(search_tool("needle", path=path, task_id=task_id))

    assert "error" in result
    assert "multiple search roots" in result["error"]


def test_production_scope_keeps_normal_file_workflow_inside_output(production_scope):
    task_id, _workspace, output, _outside = production_scope

    written = _payload(write_file_tool("output/result.txt", "old value\n", task_id=task_id))
    read = _payload(read_file_tool("output/result.txt", task_id=task_id))
    searched = _payload(search_tool("old value", path="output", task_id=task_id))
    patched = _payload(
        patch_tool(
            mode="replace",
            path="output/result.txt",
            old_string="old value",
            new_string="new value",
            task_id=task_id,
        )
    )

    assert "error" not in written
    assert "old value" in read["content"]
    assert searched["total_count"] == 1
    assert "error" not in patched
    assert (output / "result.txt").read_text(encoding="utf-8") == "new value\n"
