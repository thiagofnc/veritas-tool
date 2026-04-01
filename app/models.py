"""Core data models for project scanning and future parsing."""

from dataclasses import dataclass, field
import re


_WIDTH_RANGE_RE = re.compile(r"\[\s*([^:\]]+)\s*:\s*([^\]]+)\s*\]")


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


@dataclass
class Instance:
    name: str
    module_name: str
    connections: dict[str, str] = field(default_factory=dict)
    pin_connections: list[PinConnection] = field(default_factory=list)


@dataclass
class GatePrimitive:
    """A Verilog gate primitive such as ``and g1(out, in1, in2);``."""
    name: str
    gate_type: str  # and, or, not, xor, nand, nor, xnor, buf, etc.
    output: str
    inputs: list[str] = field(default_factory=list)


@dataclass
class ContinuousAssign:
    """A continuous assignment: ``assign target = expression;``."""
    target: str
    expression: str
    # Signal names referenced on the RHS, extracted by the parser.
    source_signals: list[str] = field(default_factory=list)


@dataclass
class AlwaysBlock:
    """An always block with its sensitivity list and read/written signals."""
    name: str  # auto-generated identifier (always_0, always_1, ...)
    sensitivity: str  # e.g. "posedge clk or posedge rst"
    kind: str = "always"  # always, always_ff, always_comb, always_latch
    written_signals: list[str] = field(default_factory=list)
    read_signals: list[str] = field(default_factory=list)


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


@dataclass
class Project:
    root_path: str
    source_files: list[SourceFile] = field(default_factory=list)
    modules: list[ModuleDef] = field(default_factory=list)
