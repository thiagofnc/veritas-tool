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
        AlwaysAssignment, AlwaysBlock, ContinuousAssign, Diagnostic, GatePrimitive,
        Instance, ModuleDef, PinConnection, Port, Project, Signal, SourceFile,
        SourceLocation,
    )
    from app.parser_base import VerilogParserBackend
except ImportError:  # Supports running as: python app/main.py
    from models import (
        AlwaysAssignment, AlwaysBlock, ContinuousAssign, Diagnostic, GatePrimitive,
        Instance, ModuleDef, PinConnection, Port, Project, Signal, SourceFile,
        SourceLocation,
    )
    from parser_base import VerilogParserBackend


def _line_at(text: str, offset: int) -> int:
    """Return the 1-based line number in ``text`` at byte offset ``offset``.

    ``offset`` is expected to be valid for ``text``. If ``text`` is the
    offset-preserving comment-masked variant produced by ``_remove_comments``,
    the line number is identical to the original file's line numbering.
    """
    if offset <= 0:
        return 1
    return text.count("\n", 0, offset) + 1


def _col_at(text: str, offset: int) -> int:
    """Return a 1-based column number for ``offset`` in ``text``.

    Column counts from the last newline. Tabs are counted as a single column —
    the tracer only needs a best-effort anchor, not a render-accurate one.
    """
    if offset <= 0:
        return 1
    line_start = text.rfind("\n", 0, offset)
    return offset - line_start


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


def _is_ident_char(ch: str) -> bool:
    """Return True when ``ch`` can appear inside a Verilog identifier."""
    return ch.isalnum() or ch in {"_", "$"}


def _remove_comments(text: str) -> str:
    """Mask comments with spaces/newlines so offsets match the original file.

    The previous implementation stripped comments entirely, which made ``re``
    offsets point to shifted positions — useless for source-provenance line
    numbers. We now replace each comment character with a space, preserving
    newlines so line numbers stay correct in the cleaned text.
    """
    def _mask(match: re.Match[str]) -> str:
        return "".join(c if c == "\n" else " " for c in match.group(0))

    no_block = re.sub(r"/\*.*?\*/", _mask, text, flags=re.DOTALL)
    return re.sub(r"//[^\n]*", _mask, no_block)


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


def _parse_signals(
    module_body: str,
    full_text: str = "",
    body_offset: int = 0,
    file_path: str = "",
) -> list[Signal]:
    """Parse simple internal signal declarations (wire/reg/logic).

    When ``full_text``, ``body_offset``, and ``file_path`` are provided, each
    ``Signal`` is annotated with a ``SourceLocation`` pointing at the declaring
    line in the source file. These extra args are optional to preserve the
    older call sites that only need name/width/kind.
    """
    signals: list[Signal] = []

    for match in SIGNAL_DECL_RE.finditer(module_body):
        kind, width, names_blob = match.group(1), match.group(2), match.group(3)
        loc: SourceLocation | None = None
        if full_text and file_path:
            abs_offset = body_offset + match.start()
            loc = SourceLocation(
                file=file_path,
                line=_line_at(full_text, abs_offset),
                column=_col_at(full_text, abs_offset),
            )

        for raw_name in names_blob.split(","):
            # Drop optional initializer if present.
            name_text = raw_name.split("=", maxsplit=1)[0].strip()
            name_match = re.match(r"^[A-Za-z_][A-Za-z0-9_$]*$", name_text)
            if not name_match:
                continue

            signals.append(
                Signal(
                    name=name_match.group(0),
                    width=width.strip() if width else None,
                    kind=kind,
                    location=loc,
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


def _parse_gates(
    module_body: str,
    full_text: str = "",
    body_offset: int = 0,
    file_path: str = "",
) -> list[GatePrimitive]:
    """Parse gate primitive instantiations."""
    gates: list[GatePrimitive] = []
    unnamed_counter = 0

    for match in GATE_RE.finditer(module_body):
        gate_type, gate_name, args_text = match.group(1), match.group(2), match.group(3)
        args = [a.strip() for a in args_text.split(",") if a.strip()]
        if len(args) < 2:
            continue

        if not gate_name:
            gate_name = f"{gate_type}_{unnamed_counter}"
            unnamed_counter += 1

        loc: SourceLocation | None = None
        if full_text and file_path:
            abs_offset = body_offset + match.start()
            loc = SourceLocation(
                file=file_path,
                line=_line_at(full_text, abs_offset),
                column=_col_at(full_text, abs_offset),
            )

        gates.append(GatePrimitive(
            name=gate_name,
            gate_type=gate_type,
            output=args[0],
            inputs=args[1:],
            location=loc,
        ))

    return gates


def _parse_assigns(
    module_body: str,
    port_names: set[str],
    signal_names: set[str],
    full_text: str = "",
    body_offset: int = 0,
    file_path: str = "",
) -> list[ContinuousAssign]:
    """Parse continuous assign statements."""
    assigns: list[ContinuousAssign] = []

    for match in ASSIGN_RE.finditer(module_body):
        target = match.group(1).strip()
        expression = " ".join(match.group(2).split())
        source_signals = _extract_signal_names(expression, port_names, signal_names)

        loc: SourceLocation | None = None
        if full_text and file_path:
            abs_offset = body_offset + match.start()
            loc = SourceLocation(
                file=file_path,
                line=_line_at(full_text, abs_offset),
                column=_col_at(full_text, abs_offset),
            )

        assigns.append(ContinuousAssign(
            target=target,
            expression=expression,
            source_signals=source_signals,
            location=loc,
        ))

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
        if (
            text[pos:pos + 5] == "begin"
            and (pos == 0 or not _is_ident_char(text[pos - 1]))
            and (pos + 5 >= len(text) or not _is_ident_char(text[pos + 5]))
        ):
            depth += 1
            pos += 5
        elif (
            text[pos:pos + 3] == "end"
            and (pos == 0 or not _is_ident_char(text[pos - 1]))
            and (pos + 3 >= len(text) or not _is_ident_char(text[pos + 3]))
        ):
            depth -= 1
            if depth == 0:
                return text[start:pos + 3]
            pos += 3
        else:
            pos += 1
    return text[start:]


def _extract_always_assignments(
    body: str,
    port_names: set[str],
    signal_names: set[str],
    full_text: str = "",
    body_offset: int = 0,
    file_path: str = "",
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
    # Absolute line number of ``body[0]`` in the original file. 1 if we have no
    # full_text context — harmless for callers who only use the parsed
    # assignment text and not its location.
    first_abs_line = _line_at(full_text, body_offset) if full_text else 1
    for line_index, line in enumerate(lines):
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
            # Control-flow signals directly influence whether this assignment
            # fires. The tracer follows them as drivers of ``target`` so that
            # e.g. the select of a mux or the reset of a register appears in
            # the fanin chain, not just the RHS data signals.
            cond_sigs: list[str] = []
            if current_condition:
                cond_sigs = _extract_signal_names(current_condition, port_names, signal_names)

            loc: SourceLocation | None = None
            if file_path:
                loc = SourceLocation(file=file_path, line=first_abs_line + line_index)

            assignments.append(AlwaysAssignment(
                target=target,
                expression=expr,
                condition=current_condition,
                blocking=not is_nonblocking,
                source_signals=source_sigs,
                condition_signals=cond_sigs,
                location=loc,
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


def _parse_always_blocks(
    module_body: str,
    port_names: set[str],
    signal_names: set[str],
    full_text: str = "",
    body_offset: int = 0,
    file_path: str = "",
) -> list[AlwaysBlock]:
    """Parse always blocks, extracting read and written signals and individual assignments."""
    blocks: list[AlwaysBlock] = []
    known = port_names | signal_names

    for index, match in enumerate(ALWAYS_START_RE.finditer(module_body)):
        kind = match.group(1)
        sensitivity = " ".join((match.group(2) or "").split())
        process_style, edge_polarity, clock_signal, sensitivity_title, sensitivity_label = _classify_always_sensitivity(sensitivity, kind)
        block_start_abs = body_offset + match.start()
        body_start = match.end()

        while body_start < len(module_body) and module_body[body_start] in " \t\n\r":
            body_start += 1

        body_clean = _extract_balanced_block(module_body, body_start)
        block_body_offset = body_offset + body_start

        written: list[str] = []
        for lhs_match in re.finditer(r"([A-Za-z_][A-Za-z0-9_$]*)\s*(?:<)?=", body_clean):
            name = lhs_match.group(1)
            if name in known and name not in written and name not in _EXPR_IGNORE:
                written.append(name)

        assignments = _extract_always_assignments(
            body_clean,
            port_names,
            signal_names,
            full_text=full_text,
            body_offset=block_body_offset,
            file_path=file_path,
        )
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

        block_loc: SourceLocation | None = None
        if full_text and file_path:
            block_loc = SourceLocation(
                file=file_path,
                line=_line_at(full_text, block_start_abs),
                column=_col_at(full_text, block_start_abs),
            )

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
            location=block_loc,
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


def _parse_instances(
    module_body: str,
    full_text: str = "",
    body_offset: int = 0,
    file_path: str = "",
) -> list[Instance]:
    """Find basic instance declarations inside a module body."""
    instances: list[Instance] = []

    for match in INSTANCE_RE.finditer(module_body):
        module_name, inst_name, conn_text = match.group(1), match.group(2), match.group(3)
        if module_name in KEYWORDS or module_name in GATE_TYPES:
            continue

        loc: SourceLocation | None = None
        if full_text and file_path:
            abs_offset = body_offset + match.start()
            loc = SourceLocation(
                file=file_path,
                line=_line_at(full_text, abs_offset),
                column=_col_at(full_text, abs_offset),
            )

        connections = _parse_connections(conn_text)
        pin_connections = [
            PinConnection(child_port=port_name, parent_signal=signal, location=loc)
            for port_name, signal in connections.items()
        ]

        instances.append(
            Instance(
                name=inst_name,
                module_name=module_name,
                connections=connections,
                pin_connections=pin_connections,
                location=loc,
            )
        )

    return instances


def _parse_modules_from_file(file_path: str) -> list[ModuleDef]:
    """Extract module definitions from a single file using regex matching.

    ``clean_text`` masks comment bodies with spaces (keeping newlines) so every
    offset in it matches the same offset in the original source. That lets us
    derive reliable (file, line) provenance for any match without re-parsing.
    """
    text = Path(file_path).read_text(encoding="utf-8", errors="ignore")
    clean_text = _remove_comments(text)
    resolved = str(Path(file_path).resolve())

    modules: list[ModuleDef] = []
    for match in MODULE_RE.finditer(clean_text):
        module_name = match.group(1)
        header_text = match.group(2)
        body_text = match.group(3)
        body_offset = match.start(3)

        ports = _parse_ports_from_header(header_text)
        # Attach the module-start line as a best-effort location for every port
        # declared in the header. The simple parser has no header offsets so a
        # single shared anchor is better than nothing for jump-to-source.
        module_loc = SourceLocation(
            file=resolved,
            line=_line_at(clean_text, match.start()),
            column=_col_at(clean_text, match.start()),
        )
        for port in ports:
            if port.location is None:
                port.location = module_loc

        signals = _parse_signals(body_text, clean_text, body_offset, resolved)
        port_names = {p.name for p in ports}
        signal_names = {s.name for s in signals}

        modules.append(
            ModuleDef(
                name=module_name,
                ports=ports,
                signals=signals,
                instances=_parse_instances(body_text, clean_text, body_offset, resolved),
                gates=_parse_gates(body_text, clean_text, body_offset, resolved),
                assigns=_parse_assigns(
                    body_text, port_names, signal_names,
                    full_text=clean_text, body_offset=body_offset, file_path=resolved,
                ),
                always_blocks=_parse_always_blocks(
                    body_text, port_names, signal_names,
                    full_text=clean_text, body_offset=body_offset, file_path=resolved,
                ),
                source_file=resolved,
                location=module_loc,
            )
        )

    return modules


class SimpleRegexParser(VerilogParserBackend):
    """Approximate parser backend for quick MVP extraction of modules/ports/instances."""

    def parse_files(self, file_paths, progress_callback=None) -> Project:
        resolved_paths = [str(Path(path).resolve()) for path in file_paths]
        source_files = [SourceFile(path=path) for path in resolved_paths]

        eligible = [p for p in resolved_paths if Path(p).suffix.lower() in {".v", ".sv"}]
        total = len(eligible)

        modules: list[ModuleDef] = []
        diagnostics: list[Diagnostic] = []
        for index, file_path in enumerate(eligible):
            if progress_callback is not None:
                try:
                    progress_callback(index, total, file_path)
                except Exception:
                    pass
            try:
                modules.extend(_parse_modules_from_file(file_path))
            except OSError as exc:
                diagnostics.append(Diagnostic(
                    severity="error",
                    kind="read_failure",
                    message=f"Could not read {Path(file_path).name}: {exc}",
                    file=str(Path(file_path).resolve()),
                    detail=type(exc).__name__,
                ))

        if progress_callback is not None and total > 0:
            try:
                progress_callback(total, total, eligible[-1])
            except Exception:
                pass

        if resolved_paths:
            parent_dirs = [str(Path(path).parent) for path in resolved_paths]
            root_path = os.path.commonpath(parent_dirs)
        else:
            root_path = ""

        return Project(
            root_path=root_path,
            source_files=source_files,
            modules=modules,
            diagnostics=diagnostics,
        )

