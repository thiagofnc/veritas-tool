"""Small in-memory cache for per-file parser results.

The load path currently reparses every Verilog file on every project reload.
That scales poorly on larger repositories even when only a handful of files
changed. This module caches each file's parsed output by a cheap filesystem
signature so unchanged files can be reused across loads.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path

try:
    from app.models import Diagnostic, ModuleDef
except ImportError:  # Supports running as: python app/main.py
    from models import Diagnostic, ModuleDef


@dataclass(frozen=True)
class FileParseSignature:
    path: str
    size: int
    mtime_ns: int


@dataclass
class CachedFileParse:
    modules: list[ModuleDef] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)


_PARSE_CACHE: dict[tuple[str, FileParseSignature], CachedFileParse] = {}


def build_file_signature(file_path: str) -> FileParseSignature:
    resolved = str(Path(file_path).resolve())
    stat_result = Path(resolved).stat()
    return FileParseSignature(
        path=resolved,
        size=stat_result.st_size,
        mtime_ns=stat_result.st_mtime_ns,
    )


def get_cached_parse(parser_backend: str, signature: FileParseSignature) -> CachedFileParse | None:
    cached = _PARSE_CACHE.get((parser_backend, signature))
    if cached is None:
        return None
    return CachedFileParse(
        modules=deepcopy(cached.modules),
        diagnostics=deepcopy(cached.diagnostics),
    )


def store_cached_parse(
    parser_backend: str,
    signature: FileParseSignature,
    *,
    modules: list[ModuleDef],
    diagnostics: list[Diagnostic],
) -> None:
    _PARSE_CACHE[(parser_backend, signature)] = CachedFileParse(
        modules=deepcopy(modules),
        diagnostics=deepcopy(diagnostics),
    )
