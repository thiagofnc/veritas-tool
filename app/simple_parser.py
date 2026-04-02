"""Very small regex-based Verilog parser backend for MVP use.

Assumptions / limitations:
- Targets simple Verilog/SystemVerilog module forms only.
- Expects module definitions to end with `endmodule`.
- Port extraction is based on module header text and may miss advanced syntax.
- Instance extraction supports basic `child_mod u1 (...);` style instantiations.
- Named connection parsing is intentionally simple (`.port(signal)`).
- Signal extraction targets simple `wire/reg/logic` declarations.
- Does not attempt to parse full language grammar.
"""

import os
import re
from pathlib import Path

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


MODULE_RE = re.compile(
    r"\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)"
    r"\s*(?:#\s*\(.*?\)\s*)?"
    r"(?:\((.*?)\))?\s*;"
    r"(.*?)"
    r"(?=\bendmodule\b)",
    flags=re.DOTALL,
)

INSTANCE_RE = re.compile(
    r"(?m)^\s*([A-Za-z_][A-Za-z0-9_$]*)\s+([A-Za-z_][A-Za-z0-9_$]*)\s*\((.*?)\)\s*;",
    flags=re.DOTALL,
)

# Matches simple named connections like: .clk(clk)
NAMED_CONNECTION_RE = re.compile(
    r"\.\s*([A-Za-z_][A-Za-z0-9_$]*)\s*\(\s*([^()]*?)\s*\)",
    flags=re.DOTALL,
)

# Matches simple internal net declarations (single line form).
SIGNAL_DECL_RE = re.compile(
    r"(?m)^\s*(wire|reg|logic)\b(?:\s+(?:signed|unsigned))*\s*(\[[^\]]+\])?\s*([^;]+);"
)

GATE_TYPES = {
    "and", "nand", "or", "nor", "xor", "xnor", "not", "buf",
    "bufif0", "bufif1", "notif0", "notif1",
}

# Matches: assign target = expression ;
ASSIGN_RE = re.compile(
    r"\bassign\s+([A-Za-z_][A-Za-z0-9_$]*(?:\[[^\]]*\])?)\s*=\s*([^;]+);",
    flags=re.DOTALL,
)

# Matches gate primitives: and g1(out, in1, in2);  or  and (out, in1, in2);
GATE_RE = re.compile(
    r"\b(" + "|".join(GATE_TYPES) + r")\s+(?:([A-Za-z_][A-Za-z0-9_$]*)\s*)?\(([^)]+)\)\s*;",
)

# Matches the start of an always block with sensitivity list.
ALWAYS_START_RE = re.compile(
    r"\b(always_ff|always_comb|always_latch|always)\s*(?:@\s*\(([^)]*)\))?\s*",
    flags=re.DOTALL,
)

# Extracts identifiers from expressions (for signal reference analysis).
_IDENT_RE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_$]*)\b")

# Matches nonblocking (<=) and blocking (=) assignments inside always blocks.
# Group 1: target, Group 2: '<' if nonblocking, Group 3: RHS expression.
_ALWAYS_ASSIGN_RE = re.compile(
    r"([A-Za-z_][A-Za-z0-9_$]*(?:\[[^\]]*\])?)\s*(<)?=\s*([^;]+);",
)

KEYWORDS = {
    "if",
    "for",
    "while",
    "case",
    "assign",
    "always",
    "always_ff",
    "always_comb",
    "always_latch",
    "initial",
    "generate",
    "endgenerate",
}

# Identifiers to ignore when extracting signal references from expressions.
_EXPR_IGNORE = KEYWORDS | {
    "begin", "end", "else", "posedge", "negedge", "or", "and", "not",
    "reg", "wire", "logic", "integer", "signed", "unsigned",
}


def _remove_comments(text: str) -> str:
    """Drop line/block comments so regexes do not match comment text."""
    no_block = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    return re.sub(r"//.*", "", no_block)


def _parse_ports_from_header(header_text: str | None) -> list[Port]:
    """Parse simple module header ports such as `input clk, output [3:0] data`."""
    if not header_text:
        return []

    ports: list[Port] = []
    current_direction: str | None = None
    current_width: str | None = None

    for raw_part in header_text.split(","):
        part = " ".join(raw_part.split())
        if not part:
            continue

        direction_match = re.match(r"^(input|output|inout)\b", part)
        if direction_match:
            current_direction = direction_match.group(1)
            part = part[direction_match.end() :].strip()

        width_match = re.search(r"\[[^\]]+\]", part)
        if width_match:
            current_width = width_match.group(0)
            part = (part[: width_match.start()] + part[width_match.end() :]).strip()

        # Remove common net/type tokens; this parser is intentionally lightweight.
        part = re.sub(r"\b(wire|reg|logic|signed|unsigned|var)\b", "", part).strip()

        name_match = re.search(r"([A-Za-z_][A-Za-z0-9_$]*)$", part)
        if not name_match:
            continue

        ports.append(
            Port(
                name=name_match.group(1),
                direction=current_direction or "unknown",
                width=current_width,
            )
        )

    return ports


def _parse_signals(module_body: str) -> list[Signal]:
    """Parse simple internal signal declarations (wire/reg/logic)."""
    signals: list[Signal] = []

    for kind, width, names_blob in SIGNAL_DECL_RE.findall(module_body):
        for raw_name in names_blob.split(","):
            # Drop optional initializer if present.
            name_text = raw_name.split("=", maxsplit=1)[0].strip()
            match = re.match(r"^[A-Za-z_][A-Za-z0-9_$]*$", name_text)
            if not match:
                continue

            signals.append(
                Signal(
                    name=match.group(0),
                    width=width.strip() if width else None,
                    kind=kind,
                )
            )

    return signals


def _extract_signal_names(expression: str, port_names: set[str], signal_names: set[str]) -> list[str]:
    """Extract signal identifiers from an expression, filtering out keywords and literals."""
    known = port_names | signal_names
    names: list[str] = []
    for match in _IDENT_RE.finditer(expression):
        name = match.group(1)
        if name in _EXPR_IGNORE:
            continue
        # Skip numeric-prefixed tokens that leaked through (e.g. from width specs).
        if name[0].isdigit():
            continue
        if name in known and name not in names:
            names.append(name)
    return names


def _parse_gates(module_body: str) -> list[GatePrimitive]:
    """Parse gate primitive instantiations."""
    gates: list[GatePrimitive] = []
    unnamed_counter = 0

    for gate_type, gate_name, args_text in GATE_RE.findall(module_body):
        args = [a.strip() for a in args_text.split(",") if a.strip()]
        if len(args) < 2:
            continue

        if not gate_name:
            gate_name = f"{gate_type}_{unnamed_counter}"
            unnamed_counter += 1

        output = args[0]
        inputs = args[1:]
        gates.append(GatePrimitive(name=gate_name, gate_type=gate_type, output=output, inputs=inputs))

    return gates


def _parse_assigns(module_body: str, port_names: set[str], signal_names: set[str]) -> list[ContinuousAssign]:
    """Parse continuous assign statements."""
    assigns: list[ContinuousAssign] = []

    for target, expression in ASSIGN_RE.findall(module_body):
        target = target.strip()
        expression = " ".join(expression.split())
        source_signals = _extract_signal_names(expression, port_names, signal_names)
        assigns.append(ContinuousAssign(target=target, expression=expression, source_signals=source_signals))

    return assigns


def _extract_balanced_block(text: str, start: int) -> str:
    """Extract a balanced begin...end block starting at position ``start``.

    ``start`` should point to the 'b' in 'begin'. Returns the full block text
    including outermost begin/end, or a single statement up to ';' if the body
    does not start with 'begin'.
    """
    if text[start:start + 5] != "begin":
        # Single statement body — up to next semicolon.
        end = text.find(";", start)
        return text[start:end + 1] if end != -1 else text[start:]

    depth = 0
    pos = start
    while pos < len(text):
        if text[pos:pos + 5] == "begin" and (pos == 0 or not text[pos - 1].isalnum()):
            depth += 1
            pos += 5
        elif text[pos:pos + 3] == "end" and (pos + 3 >= len(text) or not text[pos + 3].isalnum()):
            depth -= 1
            if depth == 0:
                return text[start:pos + 3]
            pos += 3
        else:
            pos += 1
    return text[start:]


def _extract_always_assignments(
    body: str, port_names: set[str], signal_names: set[str],
) -> list[AlwaysAssignment]:
    """Extract individual assignment statements from an always block body.

    Tracks enclosing ``if`` condition context so we can show it on each assignment.
    """
    known = port_names | signal_names
    assignments: list[AlwaysAssignment] = []

    # Build a simple condition stack by scanning for if/else before each assignment.
    condition_stack: list[str] = []
    # Walk lines to track if/else context.
    lines = body.split("\n")
    current_condition = ""
    for line in lines:
        stripped = line.strip()

        # Track if conditions.
        if_match = re.match(r"if\s*\((.+?)\)", stripped)
        else_if_match = re.match(r"end\s+else\s+if\s*\((.+?)\)", stripped)
        if else_if_match:
            current_condition = " ".join(else_if_match.group(1).split())
        elif if_match:
            condition_stack.append(" ".join(if_match.group(1).split()))
            current_condition = condition_stack[-1]
        elif re.match(r"(end\s+)?else\b", stripped):
            current_condition = f"!({condition_stack[-1]})" if condition_stack else ""
        elif stripped == "end" and condition_stack:
            condition_stack.pop()
            current_condition = condition_stack[-1] if condition_stack else ""

        # Look for assignments on this line.
        for m in _ALWAYS_ASSIGN_RE.finditer(stripped):
            target = m.group(1).strip()
            is_nonblocking = m.group(2) == "<"
            expr = " ".join(m.group(3).split())

            # Validate the target is a known signal.
            target_base = re.match(r"([A-Za-z_][A-Za-z0-9_$]*)", target)
            if not target_base or target_base.group(1) not in known:
                continue
            if target_base.group(1) in _EXPR_IGNORE:
                continue

            source_sigs = _extract_signal_names(expr, port_names, signal_names)

            assignments.append(AlwaysAssignment(
                target=target,
                expression=expr,
                condition=current_condition,
                blocking=not is_nonblocking,
                source_signals=source_sigs,
            ))

    return assignments


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
            edge_polarity = edge if len({m.group(1) for m in edge_matches}) == 1 else "mixed"
            title = f"ALWAYS @({cleaned})" if cleaned else f"ALWAYS @({edge} {clock_signal})"
            return ("seq", edge_polarity, clock_signal, title, f"SEQ {edge} {clock_signal}")
        return ("seq", "level", "", f"ALWAYS @({cleaned})" if cleaned else "ALWAYS", "SEQ")

    if kind == "always_latch":
        return ("latch", "level", "", f"ALWAYS @({cleaned})" if cleaned else "ALWAYS", "LATCH")

    title = f"ALWAYS @({cleaned})" if cleaned else "ALWAYS"
    return ("generic", "", "", title, title)


def _summarize_always_controls(body: str) -> list[str]:
    summary: list[str] = []
    for raw_line in body.splitlines():
        line = " ".join(raw_line.strip().split())
        if not line:
            continue
        if line.startswith("if ") or line.startswith("if("):
            condition_match = re.match(r"if\s*\((.+?)\)", line)
            if condition_match:
                summary.append(f"if ({condition_match.group(1)})")
        elif re.match(r"(end\s+)?else\b", line):
            summary.append("else")
        elif line.startswith("case ") or line.startswith("case("):
            expr_match = re.match(r"case\s*\((.+?)\)", line)
            if expr_match:
                summary.append(f"case ({expr_match.group(1)})")
        if len(summary) >= 6:
            break
    return summary[:6]


def _collect_always_read_signals(
    assignments: list[AlwaysAssignment],
    control_summary: list[str],
    port_names: set[str],
    signal_names: set[str],
) -> list[str]:
    read: list[str] = []

    def append_names(names: list[str]) -> None:
        for name in names:
            if name not in read:
                read.append(name)

    for assignment in assignments:
        append_names(assignment.source_signals)
        if assignment.condition:
            append_names(_extract_signal_names(assignment.condition, port_names, signal_names))

    for summary in control_summary:
        append_names(_extract_signal_names(summary, port_names, signal_names))

    return read


def _parse_always_blocks(module_body: str, port_names: set[str], signal_names: set[str]) -> list[AlwaysBlock]:
    """Parse always blocks, extracting read and written signals and individual assignments."""
    blocks: list[AlwaysBlock] = []
    known = port_names | signal_names

    for index, match in enumerate(ALWAYS_START_RE.finditer(module_body)):
        kind = match.group(1)
        sensitivity = " ".join((match.group(2) or "").split())
        process_style, edge_polarity, clock_signal, sensitivity_title, sensitivity_label = _classify_always_sensitivity(sensitivity, kind)
        body_start = match.end()

        while body_start < len(module_body) and module_body[body_start] in " \t\n\r":
            body_start += 1

        body_clean = _extract_balanced_block(module_body, body_start)

        written: list[str] = []
        for lhs_match in re.finditer(r"([A-Za-z_][A-Za-z0-9_$]*)\s*(?:<)?=", body_clean):
            name = lhs_match.group(1)
            if name in known and name not in written and name not in _EXPR_IGNORE:
                written.append(name)

        assignments = _extract_always_assignments(body_clean, port_names, signal_names)
        control_summary = _summarize_always_controls(body_clean)
        read = _collect_always_read_signals(assignments, control_summary, port_names, signal_names)
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
            name=f"{kind}_{index}",
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

    return blocks


def _parse_connections(connection_text: str) -> dict[str, str]:
    """Parse named connections first; fallback to positional args for basic coverage."""
    named_connections: dict[str, str] = {}
    for port_name, signal in NAMED_CONNECTION_RE.findall(connection_text):
        clean_signal = " ".join(signal.split())
        if clean_signal:
            named_connections[port_name] = clean_signal

    if named_connections:
        return named_connections

    # Fallback for simple positional instances: child u1(a, b, c);
    positional = [piece.strip() for piece in connection_text.split(",") if piece.strip()]
    return {f"arg{index}": signal for index, signal in enumerate(positional)}


def _parse_instances(module_body: str) -> list[Instance]:
    """Find basic instance declarations inside a module body."""
    instances: list[Instance] = []

    for module_name, inst_name, conn_text in INSTANCE_RE.findall(module_body):
        if module_name in KEYWORDS or module_name in GATE_TYPES:
            continue

        connections = _parse_connections(conn_text)
        pin_connections = [
            PinConnection(child_port=port_name, parent_signal=signal)
            for port_name, signal in connections.items()
        ]

        instances.append(
            Instance(
                name=inst_name,
                module_name=module_name,
                connections=connections,
                pin_connections=pin_connections,
            )
        )

    return instances


def _parse_modules_from_file(file_path: str) -> list[ModuleDef]:
    """Extract module definitions from a single file using regex matching."""
    text = Path(file_path).read_text(encoding="utf-8", errors="ignore")
    clean_text = _remove_comments(text)

    modules: list[ModuleDef] = []
    for module_name, header_text, body_text in MODULE_RE.findall(clean_text):
        ports = _parse_ports_from_header(header_text)
        signals = _parse_signals(body_text)
        port_names = {p.name for p in ports}
        signal_names = {s.name for s in signals}

        modules.append(
            ModuleDef(
                name=module_name,
                ports=ports,
                signals=signals,
                instances=_parse_instances(body_text),
                gates=_parse_gates(body_text),
                assigns=_parse_assigns(body_text, port_names, signal_names),
                always_blocks=_parse_always_blocks(body_text, port_names, signal_names),
                source_file=str(Path(file_path).resolve()),
            )
        )

    return modules


class SimpleRegexParser(VerilogParserBackend):
    """Approximate parser backend for quick MVP extraction of modules/ports/instances."""

    def parse_files(self, file_paths: list[str]) -> Project:
        resolved_paths = [str(Path(path).resolve()) for path in file_paths]
        source_files = [SourceFile(path=path) for path in resolved_paths]

        modules: list[ModuleDef] = []
        for file_path in resolved_paths:
            if Path(file_path).suffix.lower() not in {".v", ".sv"}:
                continue
            modules.extend(_parse_modules_from_file(file_path))

        if resolved_paths:
            parent_dirs = [str(Path(path).parent) for path in resolved_paths]
            root_path = os.path.commonpath(parent_dirs)
        else:
            root_path = ""

        return Project(root_path=root_path, source_files=source_files, modules=modules)


