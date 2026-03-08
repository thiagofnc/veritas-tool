"""Core data models for project scanning and future parsing."""

from dataclasses import dataclass, field


@dataclass
class SourceFile:
    path: str


@dataclass
class Port:
    name: str
    direction: str
    width: str | None = None


@dataclass
class Instance:
    name: str
    module_name: str
    connections: dict[str, str] = field(default_factory=dict)


@dataclass
class ModuleDef:
    name: str
    ports: list[Port] = field(default_factory=list)
    instances: list[Instance] = field(default_factory=list)
    source_file: str = ""


@dataclass
class Project:
    root_path: str
    source_files: list[SourceFile] = field(default_factory=list)
    modules: list[ModuleDef] = field(default_factory=list)
