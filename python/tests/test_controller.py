"""Check filesystem and harness boundaries without a model or OpenCode service."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("controller", Path(__file__).parents[1] / "controller.py")
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)


class ControllerTests(unittest.TestCase):
    def test_auxiliary_surface_does_not_accept_execution_or_permissions(self):
        controller.validate_harness({"systemprompt.md": "Advice"})
        for path in ("../AGENTS.md", "AGENTS.md", "plugins/code.ts", "scripts/run.py", "skills/example/scripts/code.py"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                controller.validate_harness({path: "not allowed"})

    def test_protected_changes_fail_instead_of_becoming_a_patch(self):
        for path in ("AGENTS.md", ".opencode/opencode.json", "nested/AGENTS.md", "harness2/systemprompt.md"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                controller.diff({path: b"original\n"}, {path: b"changed\n"})

    def test_regular_changes_produce_a_diff(self):
        patch = controller.diff({"file.txt": b"old\n"}, {"file.txt": b"new\n"})
        self.assertIn("-old\n+new\n", patch)

    def test_patches_apply_for_empty_files_spaces_and_missing_newlines(self):
        cases = [({"space name.txt": b"old"}, {"space name.txt": b"new"}),
                 ({}, {"empty.txt": b""}), ({"empty.txt": b""}, {})]
        for before, after in cases:
            with self.subTest(before=before, after=after), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for rel, body in before.items():
                    (root / rel).write_bytes(body)
                patch = controller.diff(before, after)
                result = subprocess.run(["git", "apply", "--check", "-"], input=patch.encode(), cwd=root, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_links_fail_before_file_contents_are_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "link").symlink_to("/outside")
            with self.assertRaises(ValueError):
                controller.files(root)

    def test_project_harness_replaces_the_one_line_seed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill = root / "harness2" / "skills" / "formula-change"
            skill.mkdir(parents=True)
            (root / "harness2" / "systemprompt.md").write_text("Use the formula-change skill.\n", encoding="utf-8")
            (skill / "SKILL.md").write_text("---\nname: formula-change\ndescription: Change a formula.\n---\n", encoding="utf-8")
            tree = controller.project_harness(root)
            self.assertIn("formula-change", tree["systemprompt.md"])
            self.assertIn("skills/formula-change/SKILL.md", tree)

    def test_missing_project_harness_keeps_the_one_line_seed(self):
        with tempfile.TemporaryDirectory() as directory:
            tree = controller.project_harness(Path(directory))
            self.assertEqual(set(tree), {"systemprompt.md"})
            self.assertIn("mandatory project instructions", tree["systemprompt.md"])

    def write_oracle(self, root, data):
        (root / "harness2").mkdir(parents=True, exist_ok=True)
        (root / "harness2" / "oracle.json").write_text(json.dumps(data), encoding="utf-8")

    def test_missing_oracle_keeps_the_run_unmeasured(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(controller.load_oracle(Path(directory)))

    def test_oracle_refuses_escapes_unknown_keys_and_unlisted_environment(self):
        bad = [{"checks": []},
               {"checks": [{"name": "a", "argv": ["true"]}], "timeoutSeconds": 0},
               {"checks": [{"name": "a", "dir": "../outside", "argv": ["true"]}]},
               {"checks": [{"name": "a", "dir": "/tmp", "argv": ["true"]}]},
               {"checks": [{"name": "a", "argv": ["true"], "shell": True}]},
               {"checks": [{"name": "a", "argv": ["true"], "env": {"PATH": "/tmp"}}]},
               {"checks": [{"name": "a", "argv": []}]},
               {"checks": [{"name": "a", "argv": ["true"]}, {"name": "a", "argv": ["true"]}]}]
        for data in bad:
            with self.subTest(data=data), tempfile.TemporaryDirectory() as directory:
                self.write_oracle(Path(directory), data)
                with self.assertRaises(ValueError):
                    controller.load_oracle(Path(directory))

    def test_measure_counts_exit_status_and_empty_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            workspace = root / "workspace"
            (workspace / "sub").mkdir(parents=True)
            self.write_oracle(root, {"timeoutSeconds": 30, "checks": [
                {"name": "passes", "dir": "sub", "argv": ["true"]},
                {"name": "fails", "argv": ["false"]},
                {"name": "quiet", "argv": ["sh", "-c", "exit 0"], "emptyOutput": True},
                {"name": "noisy", "argv": ["sh", "-c", "echo listed.go"], "emptyOutput": True},
                {"name": "environment", "argv": ["sh", "-c", "test \"$CGO_ENABLED\" = 0"], "env": {"CGO_ENABLED": "0"}},
                {"name": "missing", "argv": ["no-such-command-for-harness2"]}]})
            result = controller.measure(controller.load_oracle(root), workspace, root / "logs")
            self.assertEqual({c["name"]: c["passed"] for c in result["checks"]},
                             {"passes": True, "fails": False, "quiet": True, "noisy": False, "environment": True, "missing": False})
            self.assertEqual((result["n_passed"], result["n_criteria"], result["all_pass"]), (3, 6, False))
            self.assertIn("listed.go", (root / "logs" / "noisy.log").read_text())

    def test_integrated_ref_refuses_any_other_head(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "repo"
            root.mkdir()
            run = lambda *args: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
                                                "-C", str(root), *args], check=True, capture_output=True)
            run("init", "-q", "-b", "main")
            self.write_oracle(root, {"integratedRef": "refs/heads/main", "checks": [{"name": "a", "argv": ["true"]}]})
            run("add", ".")
            run("commit", "-q", "-m", "integrated")
            controller.snapshot(root.resolve(), Path(directory) / "accepted")
            run("checkout", "-q", "-b", "feature")
            run("commit", "-q", "--allow-empty", "-m", "not integrated")
            with self.assertRaisesRegex(ValueError, "only on integrated work"):
                controller.snapshot(root.resolve(), Path(directory) / "refused")
            self.assertFalse((Path(directory) / "refused").exists())
            self.write_oracle(root, {"integratedRef": "refs/remotes/origin/main", "checks": [{"name": "a", "argv": ["true"]}]})
            run("commit", "-q", "-am", "missing ref")
            with self.assertRaisesRegex(ValueError, "Fetch it first"):
                controller.snapshot(root.resolve(), Path(directory) / "missing")

    def test_upstream_contract_is_available(self):
        from harness2.core.schedule import run_task
        from harness2.core.selection import reflect_adoption
        self.assertTrue(callable(run_task))
        self.assertTrue(callable(reflect_adoption))


if __name__ == "__main__":
    unittest.main()
