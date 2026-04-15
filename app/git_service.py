"""Helpers for local Git repository operations used by the API layer.

This service intentionally talks to the local ``git`` CLI instead of GitHub's
HTTP API. For the requested workflow, Git is the correct abstraction:
repositories are cloned locally, history is read locally, commits are created
locally, and pushes reuse the user's existing GitHub auth setup (SSH agent,
credential helper, PAT, etc.).
"""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import atexit
import os
import subprocess
import tarfile


class GitError(RuntimeError):
    """Raised when a git command fails or a repository is invalid."""


@dataclass
class RepoInfo:
    root: str
    branch: str
    detached: bool
    remotes: list[dict[str, str]]


class GitService:
    def __init__(self) -> None:
        self._snapshots: dict[tuple[str, str], TemporaryDirectory[str]] = {}
        atexit.register(self.close)

    def close(self) -> None:
        while self._snapshots:
            _, temp_dir = self._snapshots.popitem()
            temp_dir.cleanup()

    def ensure_git_available(self) -> None:
        self._run_git_raw(["--version"])

    def get_repo_root(self, folder: str) -> str:
        target = str(Path(folder).resolve())
        return self._run_git(["rev-parse", "--show-toplevel"], cwd=target)

    def get_repo_info(self, folder: str) -> RepoInfo:
        root = self.get_repo_root(folder)
        branch = self._run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=root)
        detached = branch == "HEAD"
        if detached:
            branch = self._run_git(["rev-parse", "--short", "HEAD"], cwd=root)
        remotes = self._list_remotes(root)
        return RepoInfo(root=root, branch=branch, detached=detached, remotes=remotes)

    def clone_repository(
        self,
        url: str,
        destination_parent: str,
        destination_name: str | None = None,
        branch: str | None = None,
    ) -> dict[str, object]:
        parent = Path(destination_parent).resolve()
        if not parent.exists():
            raise FileNotFoundError(f"Destination parent does not exist: {parent}")
        if not parent.is_dir():
            raise NotADirectoryError(f"Destination parent is not a directory: {parent}")

        cmd = ["clone"]
        if branch:
            cmd.extend(["--branch", branch])
        cmd.append(url)
        if destination_name:
            cmd.append(destination_name)

        self._run_git(cmd, cwd=str(parent))

        repo_path = (parent / destination_name).resolve() if destination_name else self._infer_clone_path(parent, url)
        info = self.get_repo_info(str(repo_path))
        return {
            "folder": str(repo_path),
            "repo_root": info.root,
            "branch": info.branch,
            "detached": info.detached,
            "remotes": info.remotes,
        }

    def get_status(self, folder: str) -> dict[str, object]:
        root = self.get_repo_root(folder)
        porcelain = self._run_git(["status", "--porcelain"], cwd=root)
        entries = []
        for line in porcelain.splitlines():
            if not line:
                continue
            code = line[:2]
            path = line[3:] if len(line) > 3 else ""
            entries.append({
                "code": code,
                "path": path,
            })
        return {
            "repo_root": root,
            "dirty": bool(entries),
            "entries": entries,
        }

    def list_history(self, folder: str, max_count: int = 50) -> dict[str, object]:
        root = self.get_repo_root(folder)
        if max_count < 1:
            raise ValueError("max_count must be at least 1")

        pretty = "%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%s%x1e"
        raw = self._run_git(
            ["log", f"--max-count={max_count}", "--date=iso-strict", f"--pretty=format:{pretty}"],
            cwd=root,
        )
        commits = []
        for record in raw.split("\x1e"):
            record = record.strip()
            if not record:
                continue
            full_sha, short_sha, author_name, author_email, authored_at, subject = record.split("\x1f", 5)
            commits.append({
                "commit": full_sha,
                "short_commit": short_sha,
                "author_name": author_name,
                "author_email": author_email,
                "authored_at": authored_at,
                "subject": subject,
            })
        return {
            "repo_root": root,
            "commits": commits,
        }

    def commit_and_push(
        self,
        folder: str,
        message: str,
        remote: str = "origin",
        branch: str | None = None,
        push: bool = True,
        author_name: str | None = None,
        author_email: str | None = None,
    ) -> dict[str, object]:
        root = self.get_repo_root(folder)
        message = message.strip()
        if not message:
            raise ValueError("Commit message is required.")

        status_before = self.get_status(root)
        if not status_before["dirty"]:
            raise GitError("No changes to commit.")

        self._run_git(["add", "-A"], cwd=root)
        env = self._build_commit_env(author_name=author_name, author_email=author_email)
        self._run_git(["commit", "-m", message], cwd=root, env=env)

        commit_sha = self._run_git(["rev-parse", "HEAD"], cwd=root)
        branch_name = branch or self._run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=root)
        if branch_name == "HEAD":
            raise GitError("Cannot push from detached HEAD without specifying a branch.")

        pushed = False
        if push:
            self._run_git(["push", remote, branch_name], cwd=root)
            pushed = True

        return {
            "repo_root": root,
            "commit": commit_sha,
            "branch": branch_name,
            "remote": remote,
            "pushed": pushed,
        }

    def materialize_commit_snapshot(self, folder: str, commit: str) -> dict[str, str]:
        root = self.get_repo_root(folder)
        commit_sha = self._run_git(["rev-parse", commit], cwd=root)
        key = (root, commit_sha)
        temp_dir = self._snapshots.get(key)
        if temp_dir is None:
            temp_dir = TemporaryDirectory(prefix="verilog-tool-git-snapshot-")
            archive_bytes = self._run_git_bytes(["archive", "--format=tar", commit_sha], cwd=root)
            with tarfile.open(fileobj=BytesIO(archive_bytes)) as archive:
                self._extract_tar_safely(archive, Path(temp_dir.name))
            self._snapshots[key] = temp_dir

        return {
            "repo_root": root,
            "commit": commit_sha,
            "snapshot_path": str(Path(temp_dir.name).resolve()),
        }

    def _list_remotes(self, root: str) -> list[dict[str, str]]:
        remote_names = self._run_git(["remote"], cwd=root).splitlines()
        remotes = []
        for name in remote_names:
            if not name:
                continue
            url = self._run_git(["remote", "get-url", name], cwd=root)
            remotes.append({"name": name, "url": url})
        return remotes

    def _infer_clone_path(self, parent: Path, url: str) -> Path:
        repo_name = url.rstrip("/").rsplit("/", 1)[-1]
        if repo_name.endswith(".git"):
            repo_name = repo_name[:-4]
        candidate = (parent / repo_name).resolve()
        if not candidate.exists():
            raise GitError(f"Cloned repository path could not be resolved from URL: {url}")
        return candidate

    def _build_commit_env(
        self,
        author_name: str | None = None,
        author_email: str | None = None,
    ) -> dict[str, str] | None:
        if not author_name and not author_email:
            return None

        env = os.environ.copy()
        if author_name:
            env["GIT_AUTHOR_NAME"] = author_name
            env["GIT_COMMITTER_NAME"] = author_name
        if author_email:
            env["GIT_AUTHOR_EMAIL"] = author_email
            env["GIT_COMMITTER_EMAIL"] = author_email
        return env

    def _extract_tar_safely(self, archive: tarfile.TarFile, destination: Path) -> None:
        dest_root = destination.resolve()
        for member in archive.getmembers():
            member_path = (dest_root / member.name).resolve()
            if os.path.commonpath([str(dest_root), str(member_path)]) != str(dest_root):
                raise GitError(f"Refusing to extract archive entry outside destination: {member.name}")
        archive.extractall(path=dest_root)

    def _run_git(
        self,
        args: list[str],
        cwd: str | None = None,
        env: dict[str, str] | None = None,
    ) -> str:
        return self._run_git_raw(args, cwd=cwd, env=env).stdout.strip()

    def _run_git_bytes(
        self,
        args: list[str],
        cwd: str | None = None,
        env: dict[str, str] | None = None,
    ) -> bytes:
        return self._run_git_raw(args, cwd=cwd, env=env, text=False).stdout

    def _run_git_raw(
        self,
        args: list[str],
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        text: bool = True,
    ) -> subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes]:
        cmd = ["git", *args]
        try:
            return subprocess.run(
                cmd,
                cwd=cwd,
                env=env,
                check=True,
                capture_output=True,
                text=text,
            )
        except FileNotFoundError as exc:
            raise GitError("Git is not installed or is not available on PATH.") from exc
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else str(exc.stderr or "")
            stdout = exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else str(exc.stdout or "")
            detail = stderr.strip() or stdout.strip() or f"git {' '.join(args)} failed"
            raise GitError(detail) from exc
