"""Simple directory scanner for Verilog source files."""

import os
from pathlib import Path

try:
    from app.models import ScanResult, VerilogFile
    from app.parser_base import NoOpParser, ParserBase
except ImportError:  # Supports running as: python app/main.py
    from models import ScanResult, VerilogFile
    from parser_base import NoOpParser, ParserBase

VERILOG_EXTENSIONS = {".v", ".sv"}
WINDOWS_HIDDEN_ATTRIBUTE = 0x2


def _name_is_hidden(name: str) -> bool:
    return name.startswith(".")


def _path_is_hidden(path: Path) -> bool:
    if _name_is_hidden(path.name):
        return True

    try:
        stat_result = path.stat()
    except OSError:
        return False

    attributes = getattr(stat_result, "st_file_attributes", 0)
    return bool(attributes & WINDOWS_HIDDEN_ATTRIBUTE)


def scan_verilog_files(root_path: str) -> list[str]:
    root = Path(root_path).resolve()
    if not root.exists():
        raise FileNotFoundError(f"Root path does not exist: {root}")
    if not root.is_dir():
        raise NotADirectoryError(f"Root path is not a directory: {root}")

    discovered: list[str] = []
    for current_root, dirnames, filenames in os.walk(root):
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

    return sorted(discovered)


def scan_project(project_root: str, parser: ParserBase | None = None) -> ScanResult:
    active_parser = parser or NoOpParser()
    root = Path(project_root).resolve()

    result = ScanResult(project_root=str(root))
    for file_path_str in scan_verilog_files(project_root):
        file_path = Path(file_path_str)
        modules = active_parser.parse_file(file_path)
        result.files.append(VerilogFile(path=str(file_path), modules=modules))

    return result
