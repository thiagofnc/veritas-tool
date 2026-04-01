"""PyVerilog-backed parser backend for more reliable structural extraction.

This parser uses PyVerilog AST parsing instead of regex heuristics.
It is still intentionally focused on module/port/instance extraction.
"""

import os
import tempfile
from pathlib import Path

import re

from pyverilog.ast_code_generator.codegen import ASTCodeGenerator
from pyverilog.vparser.ast import (
    Always,
    AlwaysComb,
    AlwaysFF,
    AlwaysLatch,
    Assign,
    BlockingSubstitution,
    Decl,
    Identifier,
    Inout,
    Input,
    InstanceList,
    Ioport,
    Lvalue,
    ModuleDef as PVModuleDef,
    NonblockingSubstitution,
    Output,
)
from pyverilog.vparser.parser import VerilogParser

try:
    from app.models import (
        AlwaysBlock, ContinuousAssign, GatePrimitive,
        Instance, ModuleDef, PinConnection, Port, Project, Signal, SourceFile,
    )
    from app.parser_base import VerilogParserBackend
except ImportError:  # Supports running as: python app/main.py
    from models import (
        AlwaysBlock, ContinuousAssign, GatePrimitive,
        Instance, ModuleDef, PinConnection, Port, Project, Signal, SourceFile,
    )
    from parser_base import VerilogParserBackend

_IDENT_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_$]*)\b")
_EXPR_IGNORE = {
    "if", "else", "begin", "end", "case", "for", "while",
    "posedge", "negedge", "or", "and", "not",
    "reg", "wire", "logic", "integer", "signed", "unsigned",
    "assign", "always", "always_ff", "always_comb", "always_latch",
    "initial", "generate", "endgenerate",
}

_GATE_TYPES = {
    "and", "nand", "or", "nor", "xor", "xnor", "not", "buf",
    "bufif0", "bufif1", "notif0", "notif1",
}


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
        # Skip gate primitives — they are handled by _parse_gates.
        if child_module_name in _GATE_TYPES:
            continue
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


def _extract_identifiers(text: str, known_signals: set[str]) -> list[str]:
    """Extract known signal identifiers from a code string."""
    names: list[str] = []
    for match in _IDENT_RE.finditer(text):
        name = match.group(1)
        if name in _EXPR_IGNORE or name[0].isdigit():
            continue
        if name in known_signals and name not in names:
            names.append(name)
    return names


def _collect_lvalue_names(node: object) -> list[str]:
    """Recursively collect identifier names from an Lvalue AST node."""
    if isinstance(node, Identifier):
        return [node.name]
    names: list[str] = []
    for child in getattr(node, "children", lambda: [])():
        names.extend(_collect_lvalue_names(child))
    return names


def _collect_identifiers_from_ast(node: object) -> list[str]:
    """Recursively collect all Identifier names from an AST subtree."""
    if isinstance(node, Identifier):
        return [node.name]
    names: list[str] = []
    for child in getattr(node, "children", lambda: [])():
        names.extend(_collect_identifiers_from_ast(child))
    return names


def _parse_assigns(module: PVModuleDef, codegen: ASTCodeGenerator, known_signals: set[str]) -> list[ContinuousAssign]:
    """Parse continuous assign statements from the AST."""
    assigns: list[ContinuousAssign] = []

    for item in module.items or []:
        if not isinstance(item, Assign):
            continue

        lvalue = item.left
        rvalue = item.right

        target = _expr_to_text(lvalue, codegen)
        expression = _expr_to_text(rvalue, codegen)
        source_signals = [n for n in _collect_identifiers_from_ast(rvalue) if n in known_signals]
        # Deduplicate preserving order.
        seen: set[str] = set()
        deduped: list[str] = []
        for s in source_signals:
            if s not in seen:
                seen.add(s)
                deduped.append(s)

        assigns.append(ContinuousAssign(target=target, expression=expression, source_signals=deduped))

    return assigns


def _parse_always_blocks(module: PVModuleDef, codegen: ASTCodeGenerator, known_signals: set[str]) -> list[AlwaysBlock]:
    """Parse always blocks from the AST."""
    blocks: list[AlwaysBlock] = []
    counter = 0

    for item in module.items or []:
        if isinstance(item, AlwaysFF):
            kind = "always_ff"
        elif isinstance(item, AlwaysComb):
            kind = "always_comb"
        elif isinstance(item, AlwaysLatch):
            kind = "always_latch"
        elif isinstance(item, Always):
            kind = "always"
        else:
            continue

        sens_node = getattr(item, "sens_list", None)
        sensitivity = _expr_to_text(sens_node, codegen) if sens_node else ""

        body_text = _expr_to_text(item, codegen)

        # Collect written signals from assignment nodes in the AST subtree.
        written: list[str] = []
        def _walk_for_assignments(node: object) -> None:
            if isinstance(node, (BlockingSubstitution, NonblockingSubstitution)):
                lv = getattr(node, "left", None)
                if lv is not None:
                    for name in _collect_lvalue_names(lv):
                        if name in known_signals and name not in written:
                            written.append(name)
            for child in getattr(node, "children", lambda: [])():
                _walk_for_assignments(child)

        _walk_for_assignments(item)

        # Collect all identifiers referenced in the body, excluding written ones.
        all_idents = _extract_identifiers(body_text, known_signals)
        read = [n for n in all_idents if n not in written]

        blocks.append(AlwaysBlock(
            name=f"{kind}_{counter}",
            sensitivity=sensitivity,
            kind=kind,
            written_signals=written,
            read_signals=read,
        ))
        counter += 1

    return blocks


def _parse_gates(module: PVModuleDef, codegen: ASTCodeGenerator) -> list[GatePrimitive]:
    """Parse gate primitives from the AST.

    PyVerilog represents gate primitives as InstanceList nodes whose module name
    matches a known gate type.
    """
    gates: list[GatePrimitive] = []
    unnamed_counter = 0

    for item in module.items or []:
        if not isinstance(item, InstanceList):
            continue

        gate_type = item.module
        if gate_type not in _GATE_TYPES:
            continue

        for inst in item.instances:
            name = inst.name
            if not name:
                name = f"{gate_type}_{unnamed_counter}"
                unnamed_counter += 1

            args = [_expr_to_text(port_arg.argname, codegen) for port_arg in (inst.portlist or [])]
            if len(args) < 2:
                continue

            gates.append(GatePrimitive(name=name, gate_type=gate_type, output=args[0], inputs=args[1:]))

    return gates


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

        ports = _parse_ports(definition, codegen)
        signals = _parse_signals(definition, codegen)
        instances = _parse_instances(definition, codegen)
        known_signals = {p.name for p in ports} | {s.name for s in signals}

        modules.append(
            ModuleDef(
                name=definition.name,
                ports=ports,
                signals=signals,
                instances=instances,
                gates=_parse_gates(definition, codegen),
                assigns=_parse_assigns(definition, codegen, known_signals),
                always_blocks=_parse_always_blocks(definition, codegen, known_signals),
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
