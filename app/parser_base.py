"""Base parser backend interface (no real parser implementation yet)."""

from abc import ABC, abstractmethod

try:
    from app.models import Project
except ImportError:  # Supports running as: python app/main.py
    from models import Project


class VerilogParserBackend(ABC):
    """Abstract interface for pluggable Verilog parser backends."""

    @abstractmethod
    def parse_files(self, file_paths: list[str]) -> Project:
        """Parse the provided Verilog file paths and return a Project model."""
        raise NotImplementedError


class DummyParser(VerilogParserBackend):
    """Placeholder backend used until a real parser is implemented."""

    def parse_files(self, file_paths: list[str]) -> Project:
        raise NotImplementedError("DummyParser does not implement parsing yet.")
