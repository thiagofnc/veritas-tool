import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest

from app.git_service import GitService


def _git(args: list[str], cwd: str, env: dict[str, str] | None = None) -> str:
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    proc = subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
        env=merged_env,
    )
    return proc.stdout.strip()


class TestGitService(unittest.TestCase):
    def setUp(self) -> None:
        self.service = GitService()

    def test_clone_history_commit_push_and_snapshot(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            remote = root / "remote.git"
            seed = root / "seed"
            clones = root / "clones"
            clones.mkdir()

            _git(["init", "--bare", str(remote)], cwd=temp_dir)
            seed.mkdir()
            _git(["init", "-b", "main"], cwd=str(seed))

            author_env = {
                "GIT_AUTHOR_NAME": "Test User",
                "GIT_AUTHOR_EMAIL": "test@example.com",
                "GIT_COMMITTER_NAME": "Test User",
                "GIT_COMMITTER_EMAIL": "test@example.com",
            }

            (seed / "top.v").write_text(
                """
module top(input a, output y);
  assign y = a;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )
            _git(["add", "-A"], cwd=str(seed))
            _git(["commit", "-m", "initial"], cwd=str(seed), env=author_env)
            first_commit = _git(["rev-parse", "HEAD"], cwd=str(seed))
            _git(["remote", "add", "origin", str(remote)], cwd=str(seed))
            _git(["push", "-u", "origin", "main"], cwd=str(seed))

            cloned = self.service.clone_repository(
                url=str(remote),
                destination_parent=str(clones),
                destination_name="work",
                branch="main",
            )
            worktree = Path(str(cloned["folder"]))
            self.assertTrue((worktree / "top.v").exists())

            history = self.service.list_history(str(worktree), max_count=10)
            self.assertEqual(len(history["commits"]), 1)
            self.assertEqual(history["commits"][0]["subject"], "initial")

            (worktree / "top.v").write_text(
                """
module top(input a, output y);
  assign y = ~a;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            commit_result = self.service.commit_and_push(
                folder=str(worktree),
                message="invert output",
                author_name="Test User",
                author_email="test@example.com",
            )
            self.assertTrue(commit_result["pushed"])

            history_after = self.service.list_history(str(worktree), max_count=10)
            self.assertEqual(len(history_after["commits"]), 2)
            self.assertEqual(history_after["commits"][0]["subject"], "invert output")

            snapshot = self.service.materialize_commit_snapshot(str(worktree), first_commit)
            snapshot_file = Path(snapshot["snapshot_path"]) / "top.v"
            self.assertTrue(snapshot_file.exists())
            self.assertIn("assign y = a;", snapshot_file.read_text(encoding="utf-8"))
            self.assertNotIn("assign y = ~a;", snapshot_file.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
