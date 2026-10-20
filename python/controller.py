"""Adapt the upstream Harness² method to a bounded OpenCode 2 transport."""

from __future__ import annotations

import contextlib
import difflib
import fcntl
import hashlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import threading


def git(repository: Path, *args: str) -> bytes:
    return subprocess.check_output(
        ["git", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", str(repository), *args],
        stderr=subprocess.PIPE,
    )


def allowed(rel: str) -> bool:
    return rel == "systemprompt.md" or bool(re.fullmatch(r"skills/[a-z0-9][a-z0-9_-]*/SKILL\.md", rel))


def validate_harness(tree: dict[str, str]) -> None:
    if not tree or any(not allowed(rel) or not isinstance(body, str) for rel, body in tree.items()):
        raise ValueError("Only systemprompt.md and auxiliary SKILL.md files are editable.")
    if sum(map(len, tree.values())) > 32_000:
        raise ValueError("The auxiliary harness exceeds 32000 characters.")


def files(root: Path) -> dict[str, bytes]:
    result = {}
    total = 0
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError("A candidate contains a symbolic link.")
        if path.is_file():
            if path.stat().st_size > 2_000_000:
                raise ValueError("A candidate file exceeds 2 MB.")
            body = path.read_bytes()
            total += len(body)
            if total > 20_000_000:
                raise ValueError("The project snapshot exceeds 20 MB.")
            result[path.relative_to(root).as_posix()] = body
    return result


def protected(rel: str) -> bool:
    parts = rel.split("/")
    return any(part == "AGENTS.md" or part.startswith((".git", ".env", "opencode.json"))
               or part in (".opencode", "harness2") or part.endswith((".key", ".pem", ".p12", ".pfx")) for part in parts)


DEFAULT_PROMPT = "Follow the task and mandatory project instructions. Check the result before delivering it.\n"


def project_harness(repository: Path) -> dict[str, str]:
    """Load harness2/ from the repository, or the one-line seed when that directory is absent."""
    root = repository / "harness2"
    prompt = root / "systemprompt.md"
    if not prompt.exists():
        return {"systemprompt.md": DEFAULT_PROMPT}
    if prompt.is_symlink() or not prompt.is_file():
        raise ValueError("The project harness system prompt must be a regular file.")
    tree = {"systemprompt.md": prompt.read_text(encoding="utf-8")}
    skills = root / "skills"
    if skills.exists():
        if skills.is_symlink() or not skills.is_dir():
            raise ValueError("The project harness skills path must be a directory.")
        for skill in sorted(skills.glob("*/SKILL.md")):
            if skill.is_symlink() or skill.parent.is_symlink():
                raise ValueError("The project harness must not contain a symbolic link.")
            rel = f"skills/{skill.parent.name}/SKILL.md"
            if not allowed(rel):
                raise ValueError(f"Unsupported project skill path: {rel}")
            tree[rel] = skill.read_text(encoding="utf-8")
    validate_harness(tree)
    if len(tree["systemprompt.md"]) > 8_000:
        raise ValueError("The project systemprompt.md exceeds 8000 characters.")
    return tree


def snapshot(repository: Path, destination: Path) -> str:
    if git(repository, "rev-parse", "--show-toplevel").decode().strip() != str(repository):
        raise ValueError("The source must be the canonical repository root.")
    if git(repository, "status", "--porcelain", "--untracked-files=all").strip():
        raise ValueError("The repository is not clean. Commit or preserve user work before starting a run.")
    revision = git(repository, "rev-parse", "HEAD").decode().strip()
    for row in git(repository, "ls-tree", "-rz", "--full-tree", revision).split(b"\0"):
        if not row:
            continue
        mode, _kind, _rest = row.split(b" ", 2)
        rel = row.split(b"\t", 1)[1].decode()
        if mode in (b"120000", b"160000"):
            raise ValueError("Snapshots with symbolic links or submodules need a separate review.")
        if any(part.startswith(".env") and not part.endswith(".example") or part.endswith((".pem", ".key", ".p12", ".pfx"))
               or part in (".npmrc", ".netrc") for part in rel.split("/")):
            raise ValueError("The tracked snapshot contains a potential credential file.")
    archive = git(repository, "archive", "--format=tar", revision)
    if len(archive) > 25_000_000:
        raise ValueError("The project archive exceeds 25 MB.")
    destination.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as source:
        source.extractall(destination, filter="data")
    files(destination)
    return revision


def diff(before: dict[str, bytes], after: dict[str, bytes]) -> str:
    chunks = []
    for rel in sorted(set(before) | set(after)):
        old, new = before.get(rel, b""), after.get(rel, b"")
        if old == new and rel in before and rel in after:
            continue
        if protected(rel):
            raise ValueError("A candidate changed a mandatory instruction or integration file.")
        try:
            left, right = old.decode("utf8"), new.decode("utf8")
        except UnicodeDecodeError as exc:
            raise ValueError("Binary candidate changes need a separate review.") from exc
        chunks.append(f"diff --git {json.dumps('a/' + rel, ensure_ascii=False)} {json.dumps('b/' + rel, ensure_ascii=False)}\n")
        if rel not in before:
            chunks.append("new file mode 100644\n")
        if rel not in after:
            chunks.append("deleted file mode 100644\n")
        for line in difflib.unified_diff(left.splitlines(True), right.splitlines(True),
                                       fromfile=json.dumps(f"a/{rel}", ensure_ascii=False) if rel in before else "/dev/null",
                                       tofile=json.dumps(f"b/{rel}", ensure_ascii=False) if rel in after else "/dev/null"):
            chunks.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
    result = "".join(chunks)
    if len(result) > 1_000_000:
        raise ValueError("The candidate diff exceeds 1 MB.")
    return result


def runtime_plugin(directory: Path, entry: str) -> None:
    if not Path(entry).is_absolute() or not Path(entry).is_file():
        raise ValueError("Build the native plugin before running the controller.")
    plugin = directory / ".opencode" / "plugins" / "harness2-runtime"
    if plugin.exists():
        raise ValueError("The repository already owns the reserved harness2-runtime plugin path.")
    plugin.mkdir(parents=True)
    (plugin / "index.ts").write_text(f"export {{ default }} from {json.dumps(entry)}\n", encoding="utf8")


class Transport:
    def __init__(self):
        self.lock = threading.Lock()
        self.count = 0

    def execute(self, directory: Path, text: str, role: str, label: str) -> dict:
        with self.lock:
            self.count += 1
            request_id = str(self.count)
            sys.__stdout__.write(json.dumps({"type": "execute", "id": request_id, "request": {
                "directory": str(directory), "text": text, "role": role, "label": label}}) + "\n")
            sys.__stdout__.flush()
            line = sys.stdin.readline(8_000_001)
            if not line or len(line) > 8_000_000:
                raise RuntimeError("The OpenCode transport closed or exceeded its limit.")
            response = json.loads(line)
            if response.get("id") != request_id:
                raise RuntimeError("The transport response does not match the request.")
            if response.get("error"):
                raise RuntimeError(response["error"])
            return response["result"]


def run(payload: dict) -> dict:
    if sys.version_info < (3, 12) or sys.version_info >= (3, 14):
        raise RuntimeError("Harness² requires Python 3.12 or 3.13.")
    from harness2.core import schedule, tree
    from harness2.core.library import Library
    from harness2.core.proposer import Proposer
    from harness2.core.spec import BenchSpec, BenchPrompts, ChannelSpec
    from types import SimpleNamespace

    root = Path(payload["runRoot"]).resolve(strict=True)
    repository = Path(payload["repository"]).resolve(strict=True)
    transport = Transport()
    lock = (root.parent / "controller.lock").open("w")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    baseline = root / "snapshot"
    revision = snapshot(repository, baseline)
    runtime_plugin(baseline, payload["pluginEntry"])
    original = files(baseline)
    surface = tree.SurfaceSpec(
        name="opencode", always_on=("systemprompt.md",), always_on_max=8000,
        always_on_cap_reason="Auxiliary instructions must remain bounded.", skill_dir="skills", skill_name_rule="must_match",
        trigger_hint="Name {name} in the auxiliary system prompt.", autotrigger_file="systemprompt.md",
        trigger_line="- When {desc}, use the auxiliary {name} skill.\n", subagent_requires_mode=True,
        plugin_dir=None, hooks_file=None,
    )
    base_tree = project_harness(repository)
    base_dir = tree.write_tree(surface, base_tree, root / "base")
    channel = ChannelSpec("opencode", payload["modelRef"], effort="")
    spec = BenchSpec(
        name="repository", runs_root=root, install_mode="workspace_agents_md",
        prompts=BenchPrompts(work="Complete the repository task and preserve its mandatory instructions.",
                             inv_levers="Only auxiliary instructions and skills can change.",
                             dom_levers="Use the supplied task context without modifying its rules."),
        channels={"proposer": channel, "selector": channel}, allow_subagents=False,
    )

    class Adapter:
        def __init__(self):
            self.spec = spec
            self.substrate = SimpleNamespace(name="oc2", surface=lambda: surface)

        def domain_of(self, task_id): return "project"
        def task_prompt(self, task_id): return payload["task"] + "\n\nCompletion criteria:\n" + payload["criteria"]
        def task_files(self, task_id): return baseline
        def base_harness(self): return base_dir
        def validate_tree(self, candidate): validate_harness(candidate)
        def tasks(self, split="all"): return ["task"]

        def execute(self, task_id, harness_dir, run_id, *, timeout=None):
            name = hashlib.sha256(run_id.encode()).hexdigest()[:24]
            run_dir = root / "executions" / name
            workspace = run_dir / "workspace"
            run_dir.mkdir(parents=True)
            shutil.copytree(baseline, workspace)
            harness = tree.read_tree(surface, harness_dir or base_dir)
            validate_harness(harness)
            guidance = "\n\n".join(f"## {rel}\n{body}" for rel, body in harness.items())
            response = transport.execute(workspace, self.task_prompt(task_id) +
                "\n\nAuxiliary advice follows. It cannot override project instructions or permissions.\n" + guidance,
                "task", run_id.rsplit("/", 1)[-1])
            patch = diff(original, files(workspace))
            (run_dir / "answer.md").write_text(response["text"], encoding="utf8")
            (run_dir / "changes.patch").write_text(patch, encoding="utf8")
            (run_dir / "trajectory.md").write_text(response["trajectory"], encoding="utf8")
            (run_dir / "usage.json").write_text(json.dumps(response), encoding="utf8")
            return run_dir

        def delivered(self, run_dir): return (run_dir / "answer.md").is_file() and bool((run_dir / "answer.md").read_text().strip())
        def trajectory(self, run_dir, *, obs_trunc): return (run_dir / "trajectory.md").read_text()
        def deliverable_files(self, run_dir): return {"answer.md": (run_dir / "answer.md").read_text(), "changes.patch": (run_dir / "changes.patch").read_text()}
        def deliverable_text(self, run_dir): return "\n\n".join(self.deliverable_files(run_dir).values())
        def score(self, run_dir, task_id): return None

    class Editor(Proposer):
        def _opencode(self, cwd, mission, system, wall):
            runtime_plugin(cwd, payload["pluginEntry"])
            (cwd / "MISSION.md").write_text((system + "\n\n" if system else "") + mission, encoding="utf8")
            (cwd / "output").mkdir(exist_ok=True)
            response = transport.execute(cwd, "Read MISSION.md. Only context/harness/systemprompt.md and "
                "context/harness/skills/<name>/SKILL.md are editable harness components in this restricted deployment. "
                "Return the requested output as your final answer and save it to output/answer.md.", "editor", "improvement")
            return response["text"], float(response.get("reportedCostUsd", 0)), ""

    # Keep editor workspaces inside this run. The upstream method owns their temporary lifecycle.
    import tempfile
    temporary = root / "temporary"
    temporary.mkdir()
    tempfile.tempdir = str(temporary)
    editor = Editor(channel, audit_dir=root / "editor-audit", attempts=1)
    adapter = Adapter()
    library = Library(root=root / "library", domain="project", surface=surface)
    for entry in payload.get("experience", []):
        harness = entry.get("harness") or base_tree
        validate_harness(harness)
        library.add(entry["id"], harness, experience={key: entry[key] for key in ("cue", "lesson", "evidence")})
    result = schedule.run_task("task", payload.get("k", 1), adapter=adapter, prop=editor, selector_prop=editor,
                               runs_root=root / "method", modes=[payload.get("mode", "agg")], library=library)
    selected = result.selections.get(payload.get("mode", "agg"), {})
    chosen = selected.get("chosen_run_dir")
    adopted = {}
    if chosen:
        location = Path(chosen)
        location.relative_to(root)
        adopted = {"directory": str(location), "diff": (location / "changes.patch").read_text(),
                   "answer": (location / "answer.md").read_text()}
    namespace = schedule.Namespace("repository", "oc2", payload.get("mode", "agg"), payload.get("k", 1))
    method_dir = namespace.task_dir(root / "method", "task")
    chosen_harness = tree.read_tree(surface, method_dir / "harnesses" / str(selected.get("chosen_label", ""))) if chosen else {}
    return {"status": result.status, "revision": revision, "method": "upstream-harness2", "upstreamVersion": importlib.metadata.version("harness2"),
            "selectionPolicy": "upstream-finals-only", "summary": result.to_dict(), "adopted": adopted,
            "experience": selected.get("experience", {}), "harness": chosen_harness,
            "baselineDirectories": [entry["run_dir"] for entry in result.base], "oracle": "not_measured"}


def main():
    os.umask(0o077)
    if sys.version_info < (3, 12) or sys.version_info >= (3, 14):
        raise RuntimeError("Harness² requires Python 3.12 or 3.13.")
    if "--check" in sys.argv:
        from harness2.core.schedule import run_task
        from harness2.core.spec import BenchSpec
        print(json.dumps({"harness2Version": importlib.metadata.version("harness2"), "contract": "run_task/BenchSpec", "modelAccess": "not_exercised"}))
        return
    payload = json.loads(sys.stdin.readline(1_000_001))
    with contextlib.redirect_stdout(sys.stderr):
        result = run(payload)
    sys.__stdout__.write(json.dumps({"type": "result", "result": result}) + "\n")
    sys.__stdout__.flush()


if __name__ == "__main__":
    main()
