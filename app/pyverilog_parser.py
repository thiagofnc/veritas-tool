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
    Block,
    BlockingSubstitution,
    Cond,
    Decl,
    Identifier,
    IfStatement,
    Inout,
    Input,
    InstanceList,
    Ioport,
    Lvalue,
    ModuleDef as PVModuleDef,
    NonblockingSubstitution,
    Output,
    Ulnot,
)
from pyverilog.vparser.parser import VerilogParser

try:
    from app.models import (
        AlwaysAssignment, AlwaysBlock, ContinuousAssign, GatePrimitive,
        Instance, ModuleDef, PinConnection, Port, Project, Signal, SourceFile,
    )
    from app.parser_base import VerilogParserBackend
except ImportError:  # Supports running as: python app/main.py
    from models import (
        AlwaysAssignment, AlwaysBlock, ContinuousAssign, GatePrimitive,
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


def _walk_always_assignments(
    node: object,
    codegen: ASTCodeGenerator,
    known_signals: set[str],
    condition: str = "",
) -> list[AlwaysAssignment]:
    """Recursively walk an always-block AST subtree and extract individual assignments."""
    results: list[AlwaysAssignment] = []

    if isinstance(node, IfStatement):
        cond_text = _expr_to_text(node.cond, codegen)
        # true branch
        if node.true_statement is not None:
            results.extend(_walk_always_assignments(node.true_statement, codegen, known_signals, cond_text))
        # false branch
        if node.false_statement is not None:
            neg_cond = f"!({cond_text})"
            results.extend(_walk_always_assignments(node.false_statement, codegen, known_signals, neg_cond))
        return results

    if isinstance(node, (BlockingSubstitution, NonblockingSubstitution)):
        lv = getattr(node, "left", None)
        rv = getattr(node, "right", None)
        if lv is not None and rv is not None:
            target = _expr_to_text(lv, codegen)
            expression = _expr_to_text(rv, codegen)
            target_base = target.split("[")[0].strip()
            if target_base in known_signals:
                src_idents = [n for n in _collect_identifiers_from_ast(rv) if n in known_signals]
                seen: set[str] = set()
                deduped = [s for s in src_idents if not (s in seen or seen.add(s))]  # type: ignore[func-returns-value]
                results.append(AlwaysAssignment(
                    target=target,
                    expression=expression,
                    condition=condition,
                    blocking=isinstance(node, BlockingSubstitution),
                    source_signals=deduped,
                ))
        return results

    # Recurse into child nodes (Block, etc.)
    for child in getattr(node, "children", lambda: [])():
        results.extend(_walk_always_assignments(child, codegen, known_signals, condition))

    return results


def _classify_always_sensitivity(sensitivity: str, kind: str) -> tuple[str, str, str, str, str]:
    cleaned = " ".join((sensitivity or "").split())

    if kind == "always_comb" or cleaned in {"*", "(*)"}:
        return ("comb", "level", "", "ALWAYS @(*)", "COMB")

    edge_matches = list(re.finditer(r"\b(posedge|negedge)\s+([A-Za-z_][A-Za-z0-9_$]*)", cleaned))
    if kind == "always_ff" or edge_matches:
        if edge_matches:
            primary = edge_matches[0]
            edge = primary.group(1)
            clock_signal = primary.group(2)
            edge_polarity = edge_matches[0].group(1) if len({m.group(1) for m in edge_matches}) == 1 else "mixed"
            title = f"ALWAYS @({cleaned})" if cleaned else f"ALWAYS @({edge} {clock_signal})"
            return ("seq", edge_polarity, clock_signal, title, f"SEQ {edge} {clock_signal}")
        return ("seq", "level", "", f"ALWAYS @({cleaned})" if cleaned else "ALWAYS", "SEQ")

    if kind == "always_latch":
        return ("latch", "level", "", f"ALWAYS @({cleaned})" if cleaned else "ALWAYS", "LATCH")

    title = f"ALWAYS @({cleaned})" if cleaned else "ALWAYS"
    return ("generic", "", "", title, title)


def _summarize_always_controls(node: object, codegen: ASTCodeGenerator) -> list[str]:
    statement = getattr(node, "statement", None)
    if statement is None:
        return []

    top_level = getattr(statement, "statements", None)
    statements = top_level if isinstance(top_level, (list, tuple)) else [statement]
    summary: list[str] = []

    for stmt in statements:
        stmt_type = type(stmt).__name__
        if stmt_type == "IfStatement":
            cond = _expr_to_text(getattr(stmt, "cond", None), codegen)
            has_else = getattr(stmt, "false_statement", None) is not None
            summary.append(f"if ({cond})" + (" / else" if has_else else ""))
        elif stmt_type == "CaseStatement":
            expr = _expr_to_text(getattr(stmt, "comp", None), codegen)
            case_items = getattr(stmt, "caselist", None) or []
            summary.append(f"case ({expr}) [{len(case_items)} arms]")
        elif stmt_type in {"BlockingSubstitution", "NonblockingSubstitution"}:
            op = "=" if stmt_type == "BlockingSubstitution" else "<="
            summary.append(f"{_expr_to_text(getattr(stmt, 'left', None), codegen)} {op} {_expr_to_text(getattr(stmt, 'right', None), codegen)}")
        else:
            child_statements = getattr(stmt, "statements", None)
            if isinstance(child_statements, (list, tuple)):
                for child in child_statements:
                    child_type = type(child).__name__
                    if child_type == "IfStatement":
                        cond = _expr_to_text(getattr(child, "cond", None), codegen)
                        has_else = getattr(child, "false_statement", None) is not None
                        summary.append(f"if ({cond})" + (" / else" if has_else else ""))
                    elif child_type == "CaseStatement":
                        expr = _expr_to_text(getattr(child, "comp", None), codegen)
                        case_items = getattr(child, "caselist", None) or []
                        summary.append(f"case ({expr}) [{len(case_items)} arms]")
        if len(summary) >= 6:
            break

    return summary[:6]


def _collect_always_read_signals(
    assignments: list[AlwaysAssignment],
    control_summary: list[str],
    known_signals: set[str],
) -> list[str]:
    read: list[str] = []

    def append_names(names: list[str]) -> None:
        for name in names:
            if name in known_signals and name not in read:
                read.append(name)

    for assignment in assignments:
        append_names(list(assignment.source_signals))
        if assignment.condition:
            append_names(_extract_identifiers(assignment.condition, known_signals))

    for summary in control_summary:
        append_names(_extract_identifiers(summary, known_signals))

    return read


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
        process_style, edge_polarity, clock_signal, sensitivity_title, sensitivity_label = _classify_always_sensitivity(sensitivity, kind)
        body_text = _expr_to_text(item, codegen)

        written: list[str] = []

        def _walk_for_written(node: object) -> None:
            if isinstance(node, (BlockingSubstitution, NonblockingSubstitution)):
                lv = getattr(node, "left", None)
                if lv is not None:
                    for name in _collect_lvalue_names(lv):
                        if name in known_signals and name not in written:
                            written.append(name)
            for child in getattr(node, "children", lambda: [])():
                _walk_for_written(child)

        _walk_for_written(item)

        assignments = _walk_always_assignments(item, codegen, known_signals)
        control_summary = _summarize_always_controls(item, codegen)
        read = _collect_always_read_signals(assignments, control_summary, known_signals)
        summary_lines: list[str] = []
        for assignment in assignments:
            operator = "=" if assignment.blocking else "<="
            line = f"{assignment.target} {operator} {assignment.expression}"
            if assignment.condition:
                line += f" when {assignment.condition}"
            if line not in summary_lines:
                summary_lines.append(line)
            if len(summary_lines) >= 8:
                break

        blocks.append(AlwaysBlock(
            name=f"{kind}_{counter}",
            sensitivity=sensitivity,
            kind=kind,
            process_style=process_style,
            edge_polarity=edge_polarity,
            clock_signal=clock_signal,
            sensitivity_title=sensitivity_title,
            sensitivity_label=sensitivity_label,
            written_signals=written,
            read_signals=read,
            assignments=assignments,
            control_summary=control_summary,
            summary_lines=summary_lines,
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


