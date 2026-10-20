"""Check filesystem and harness boundaries without a model or OpenCode service."""

import importlib.util
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
        for path in ("AGENTS.md", ".opencode/opencode.json", "nested/AGENTS.md"):
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

    def test_upstream_contract_is_available(self):
        from harness2.core.schedule import run_task
        from harness2.core.selection import reflect_adoption
        self.assertTrue(callable(run_task))
        self.assertTrue(callable(reflect_adoption))


if __name__ == "__main__":
    unittest.main()
