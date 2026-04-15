"""Core data models for project scanning and future parsing."""

from dataclasses import dataclass, field
import re


_WIDTH_RANGE_RE = re.compile(r"\[\s*([^:\]]+)\s*:\s*([^\]]+)\s*\]")


@dataclass
class SourceLocation:
    """Exact source position for a parsed construct.

    ``file`` is the absolute path of the source file. ``line`` is 1-based.
    ``column`` is 1-based when available, 0 when unknown (PyVerilog does not
    surface reliable columns for every node).
    """

    file: str
    line: int
    column: int = 0
    end_line: int | None = None
    end_column: int | None = None


@dataclass
class Diagnostic:
    """A parser or tracer observation worth surfacing to the user.

    ``severity`` is one of "error", "warning", "info". ``kind`` is a short
    machine-readable category (e.g. ``parse_failure``, ``read_failure``,
    ``unresolved_module``). ``detail`` is free text. ``file`` and ``line`` are
    optional context.
    """

    severity: str
    kind: str
    message: str
    file: str = ""
    line: int | None = None
    detail: str = ""


def _parse_simple_int(token: str) -> int | None:
    text = token.strip().replace("_", "")
    if re.fullmatch(r"\d+", text):
        return int(text)
    return None


def _infer_bus_metadata(width: str | None) -> tuple[int | None, bool]:
    if not width:
        return (1, False)

    match = _WIDTH_RANGE_RE.search(width)
    if not match:
        return (None, True)

    msb = _parse_simple_int(match.group(1))
    lsb = _parse_simple_int(match.group(2))
    if msb is None or lsb is None:
        return (None, True)

    return (abs(msb - lsb) + 1, True)


@dataclass
class SourceFile:
    path: str


@dataclass
class Port:
    name: str
    direction: str
    width: str | None = None
    bit_width: int | None = None
    is_bus: bool = False
    location: SourceLocation | None = None

    def __post_init__(self) -> None:
        inferred_width, inferred_is_bus = _infer_bus_metadata(self.width)
        if self.bit_width is None:
            self.bit_width = inferred_width

        if inferred_is_bus:
            self.is_bus = True
        elif self.bit_width is not None and self.bit_width > 1:
            self.is_bus = True


@dataclass
class Signal:
    name: str
    width: str | None = None
    kind: str = "wire"
    bit_width: int | None = None
    is_bus: bool = False
    location: SourceLocation | None = None

    def __post_init__(self) -> None:
        inferred_width, inferred_is_bus = _infer_bus_metadata(self.width)
        if self.bit_width is None:
            self.bit_width = inferred_width

        if inferred_is_bus:
            self.is_bus = True
        elif self.bit_width is not None and self.bit_width > 1:
            self.is_bus = True


@dataclass
class PinConnection:
    child_port: str
    parent_signal: str
    location: SourceLocation | None = None


@dataclass
class Instance:
    name: str
    module_name: str
    connections: dict[str, str] = field(default_factory=dict)
    pin_connections: list[PinConnection] = field(default_factory=list)
    location: SourceLocation | None = None


@dataclass
class GatePrimitive:
    """A Verilog gate primitive such as ``and g1(out, in1, in2);``."""
    name: str
    gate_type: str  # and, or, not, xor, nand, nor, xnor, buf, etc.
    output: str
    inputs: list[str] = field(default_factory=list)
    location: SourceLocation | None = None


@dataclass
class ContinuousAssign:
    """A continuous assignment: ``assign target = expression;``."""
    target: str
    expression: str
    # Signal names referenced on the RHS, extracted by the parser.
    source_signals: list[str] = field(default_factory=list)
    location: SourceLocation | None = None


@dataclass
class AlwaysAssignment:
    """One assignment statement inside an always block.

    ``source_signals`` holds RHS (data) dependencies. ``condition_signals``
    holds identifiers that appear in the enclosing ``if``/``case`` condition(s)
    — i.e. control dependencies that directly influence whether this
    assignment fires. The tracer treats both as drivers of ``target`` so a
    fanin trace of ``target`` surfaces both mux-data and mux-select signals.
    """
    target: str                 # LHS signal name
    expression: str             # RHS expression text
    condition: str = ""         # enclosing if-condition context, e.g. "rst", "!rst"
    blocking: bool = False      # True for '=', False for '<='
    source_signals: list[str] = field(default_factory=list)
    condition_signals: list[str] = field(default_factory=list)
    location: SourceLocation | None = None


@dataclass
class AlwaysBlock:
    """An always block with its sensitivity list and read/written signals."""
    name: str  # auto-generated identifier (always_0, always_1, ...)
    sensitivity: str  # e.g. "posedge clk or posedge rst"
    kind: str = "always"  # always, always_ff, always_comb, always_latch
    process_style: str = "generic"  # comb, seq, latch, generic
    edge_polarity: str = ""  # posedge, negedge, level, mixed, or empty
    clock_signal: str = ""
    sensitivity_title: str = ""
    sensitivity_label: str = ""
    written_signals: list[str] = field(default_factory=list)
    read_signals: list[str] = field(default_factory=list)
    assignments: list[AlwaysAssignment] = field(default_factory=list)
    control_summary: list[str] = field(default_factory=list)
    summary_lines: list[str] = field(default_factory=list)
    location: SourceLocation | None = None


@dataclass
class ModuleDef:
    name: str
    ports: list[Port] = field(default_factory=list)
    signals: list[Signal] = field(default_factory=list)
    instances: list[Instance] = field(default_factory=list)
    gates: list[GatePrimitive] = field(default_factory=list)
    assigns: list[ContinuousAssign] = field(default_factory=list)
    always_blocks: list[AlwaysBlock] = field(default_factory=list)
    source_file: str = ""
    location: SourceLocation | None = None


@dataclass
class Project:
    root_path: str
    source_files: list[SourceFile] = field(default_factory=list)
    modules: list[ModuleDef] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)
