"""PyVerilog-backed parser backend for more reliable structural extraction.

This parser uses PyVerilog AST parsing instead of regex heuristics.
It is still intentionally focused on module/port/instance extraction.
"""

import os
import tempfile
from pathlib import Path

from pyverilog.ast_code_generator.codegen import ASTCodeGenerator
from pyverilog.vparser.ast import (
    Decl,
    Inout,
    Input,
    InstanceList,
    Ioport,
    ModuleDef as PVModuleDef,
    Output,
)
from pyverilog.vparser.parser import VerilogParser

try:
    from app.models import Instance, ModuleDef, PinConnection, Port, Project, Signal, SourceFile
    from app.parser_base import VerilogParserBackend
except ImportError:  # Supports running as: python app/main.py
    from models import Instance, ModuleDef, PinConnection, Port, Project, Signal, SourceFile
    from parser_base import VerilogParserBackend


def _direction_from_decl(decl: object) -> str:
    if isinstance(decl, Input):
        return "input"
    if isinstance(decl, Output):
        return "output"
    if isinstance(decl, Inout):
        return "inout"
    return "unknown"


def _expr_to_text(expr: object | None, codegen: ASTCodeGenerator) -> str:
    if expr is None:
        return ""

    try:
        return " ".join(codegen.visit(expr).split())
    except Exception:
        return str(expr)


def _parse_ports(module: PVModuleDef, codegen: ASTCodeGenerator) -> list[Port]:
    ports: list[Port] = []
    if module.portlist is None:
        return ports

    for port_node in module.portlist.ports:
        if isinstance(port_node, Ioport):
            decl = port_node.first
            width = _expr_to_text(decl.width, codegen) if getattr(decl, "width", None) else None
            ports.append(
                Port(
                    name=getattr(decl, "name", "unknown"),
                    direction=_direction_from_decl(decl),
                    width=width,
                )
            )
            continue

        # Fallback for non-ANSI headers where direction info may be elsewhere.
        name = getattr(port_node, "name", None)
        if name:
            ports.append(Port(name=name, direction="unknown", width=None))

    return ports


def _parse_signals(module: PVModuleDef, codegen: ASTCodeGenerator) -> list[Signal]:
    """Extract simple internal declarations (wire/reg/logic-like)."""
    signals: list[Signal] = []

    for item in module.items or []:
        if not isinstance(item, Decl):
            continue

        for decl in item.list:
            kind = type(decl).__name__.lower()
            if kind not in {"wire", "reg", "logic"}:
                continue

            width = _expr_to_text(getattr(decl, "width", None), codegen) if getattr(decl, "width", None) else None
            name = getattr(decl, "name", None)
            if not name:
                continue

            signals.append(Signal(name=name, width=width, kind=kind))

    return signals


def _parse_instances(module: PVModuleDef, codegen: ASTCodeGenerator) -> list[Instance]:
    instances: list[Instance] = []

    for item in module.items or []:
        if not isinstance(item, InstanceList):
            continue

        child_module_name = item.module
        for index, inst in enumerate(item.instances):
            inst_name = inst.name or f"inst_{index}"
            connections: dict[str, str] = {}
            pin_connections: list[PinConnection] = []

            for arg_index, port_arg in enumerate(inst.portlist or []):
                key = port_arg.portname or f"arg{arg_index}"
                signal = _expr_to_text(port_arg.argname, codegen)
                connections[key] = signal
                pin_connections.append(PinConnection(child_port=key, parent_signal=signal))

            instances.append(
                Instance(
                    name=inst_name,
                    module_name=child_module_name,
                    connections=connections,
                    pin_connections=pin_connections,
                )
            )

    return instances


def _parse_modules_from_file(
    parser: VerilogParser,
    codegen: ASTCodeGenerator,
    file_path: str,
) -> list[ModuleDef]:
    source_text = Path(file_path).read_text(encoding="utf-8", errors="ignore")
    ast = parser.parse(source_text)

    modules: list[ModuleDef] = []
    for definition in ast.description.definitions:
        if not isinstance(definition, PVModuleDef):
            continue

        modules.append(
            ModuleDef(
                name=definition.name,
                ports=_parse_ports(definition, codegen),
                signals=_parse_signals(definition, codegen),
                instances=_parse_instances(definition, codegen),
                source_file=str(Path(file_path).resolve()),
            )
        )

    return modules


class PyVerilogParser(VerilogParserBackend):
    """Parser backend backed by the PyVerilog AST parser."""

    def parse_files(self, file_paths: list[str]) -> Project:
        resolved_paths = [str(Path(path).resolve()) for path in file_paths]
        source_files = [SourceFile(path=path) for path in resolved_paths]

        # Send parser table artifacts to temp space instead of project root.
        parser = VerilogParser(outputdir=tempfile.gettempdir(), debug=False)
        codegen = ASTCodeGenerator()

        modules: list[ModuleDef] = []
        for file_path in resolved_paths:
            if Path(file_path).suffix.lower() not in {".v", ".sv"}:
                continue

            try:
                modules.extend(_parse_modules_from_file(parser, codegen, file_path))
            except Exception:
                # Keep parsing robust: unsupported syntax in one file should not
                # block extraction from the rest of the project.
                continue

        root_path = os.path.commonpath([str(Path(path).parent) for path in resolved_paths]) if resolved_paths else ""
        return Project(root_path=root_path, source_files=source_files, modules=modules)
