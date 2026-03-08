"""Simple directory scanner for Verilog source files."""

import os
from pathlib import Path

try:
    from app.models import Project, SourceFile
    from app.parser_base import VerilogParserBackend
except ImportError:  # Supports running as: python app/main.py
    from models import Project, SourceFile
    from parser_base import VerilogParserBackend

# MVP scope: only module source files, not headers/includes.
VERILOG_EXTENSIONS = {".v", ".sv"}
WINDOWS_HIDDEN_ATTRIBUTE = 0x2


def _name_is_hidden(name: str) -> bool:
    """Treat dot-prefixed names as hidden (works across platforms)."""
    return name.startswith(".")


def _path_is_hidden(path: Path) -> bool:
    """Handle both dotfiles and Windows hidden attributes."""
    if _name_is_hidden(path.name):
        return True

    try:
        stat_result = path.stat()
    except OSError:
        # If metadata cannot be read, do not block the scan.
        return False

    attributes = getattr(stat_result, "st_file_attributes", 0)
    return bool(attributes & WINDOWS_HIDDEN_ATTRIBUTE)


def scan_verilog_files(root_path: str) -> list[str]:
    """Recursively discover visible .v/.sv files and return sorted absolute paths."""
    root = Path(root_path).resolve()
    if not root.exists():
        raise FileNotFoundError(f"Root path does not exist: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"Root path is not a directory: {root}")

    discovered: list[str] = []
    for current_root, dirnames, filenames in os.walk(root):
        # In-place filtering tells os.walk which folders to skip entirely.
        dirnames[:] = [
            dirname
            for dirname in dirnames
            if not _name_is_hidden(dirname)
            and not _path_is_hidden(Path(current_root) / dirname)
        ]

        for filename in filenames:
            file_path = Path(current_root) / filename
            if _name_is_hidden(filename) or _path_is_hidden(file_path):
                continue
            if file_path.suffix.lower() in VERILOG_EXTENSIONS:
                discovered.append(str(file_path))

    # Stable ordering makes CLI output predictable and test-friendly.
    return sorted(discovered)


def scan_project(project_root: str, parser: VerilogParserBackend | None = None) -> Project:
    """Create a Project from discovered files or delegate to a parser backend."""
    root = Path(project_root).resolve()
    file_paths = scan_verilog_files(project_root)

    if parser is not None:
        return parser.parse_files(file_paths)

    # Default MVP behavior: scan file inventory only, no module parsing yet.
    return Project(
        root_path=str(root),
        source_files=[SourceFile(path=file_path) for file_path in file_paths],
        modules=[],
    )
