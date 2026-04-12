"""Cross-module signal tracing.

Given a starting point `(module_name, signal_name)`, walks the design's
fan-in (everything that drives the signal) and fan-out (everything the
signal drives), crossing module boundaries in both directions.

The result is a flat list of "hops" — each hop is one driver or load of
a signal in a specific module scope. The frontend groups these by module
and renders them as navigable entries.

Hop schema:
    {
        "module": str,             # module scope where this hop lives
        "signal": str,             # signal name in that scope
        "kind": str,               # driver/load kind (see below)
        "label": str,              # human-readable short description
        "detail": str,             # secondary text (expression, pin, etc.)
        "depth": int,              # BFS depth from origin
        "direction": "fanin" | "fanout",
        "crosses": "down" | "up" | None,
        "next_module": str | None, # module scope the trace continues into
        "next_signal": str | None, # signal in next scope
    }

Hop kinds:
    "assign"              : continuous assignment
    "always"              : always block assignment
    "gate"                : gate primitive
    "instance_pin_in"     : signal drives an input pin of a child instance
    "instance_pin_out"    : signal is driven by an output pin of a child instance
    "module_port_in"      : trace escapes up via parent instantiation (input)
    "module_port_out"     : trace escapes up via parent instantiation (output)
    "dead_end"            : nothing drives/loads this signal in scope
"""

from __future__ import annotations

import re
from collections import deque
from typing import Any

from app.models import (
    AlwaysAssignment,
    AlwaysBlock,
    ContinuousAssign,
    GatePrimitive,
    Instance,
    ModuleDef,
    Project,
)


# Max BFS hops total (fanin + fanout) before we stop, to keep responses bounded
# on pathological designs. Users can raise via request if needed.
DEFAULT_MAX_HOPS = 500


# Expression classification. Order matters: checked in sequence; first match wins.
_OP_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("mux", re.compile(r"\?\s*[^:]+:|\bcase\b|\bcasez\b|\bcasex\b")),
    ("comparison", re.compile(r"==|!=|<=(?!\s)|>=|(?<![<>=])<(?![<=])|(?<![<>=])>(?![>=])")),
    ("arithmetic", re.compile(r"[+\-*/%]|<<|>>")),
    ("logic", re.compile(r"[&|^~!]")),
]


def _classify_expression(expression: str | None) -> str | None:
    if not expression:
        return None
    text = expression.strip()
    if not text:
        return None
    for category, pattern in _OP_PATTERNS:
        if pattern.search(text):
            return category
    return "wire"


def _classify_role(hop_kind: str, process_style: str | None, blocking: bool | None) -> str:
    if hop_kind == "dead_end":
        return "dead_end"
    if hop_kind in ("instance_pin_in", "instance_pin_out", "module_port_in", "module_port_out"):
        return "transport"
    if hop_kind == "always":
        # Non-blocking assignment inside a clocked process = state (pipeline register)
        if blocking is False and process_style == "seq":
            return "pipeline"
        return "compute"
    if hop_kind in ("assign", "gate"):
        return "compute"
    return "unknown"


def _is_noise_signal(signal: str) -> bool:
    if not signal:
        return True
    if signal.startswith("__open__:"):
        return True
    return False


def _module_lookup(project: Project) -> dict[str, ModuleDef]:
    return {m.name: m for m in project.modules}


def _parent_index(project: Project) -> dict[str, list[tuple[str, Instance]]]:
    """Return module_name → list of (parent_module_name, instance) that instantiate it."""
    index: dict[str, list[tuple[str, Instance]]] = {}
    for parent in project.modules:
        for inst in parent.instances:
            index.setdefault(inst.module_name, []).append((parent.name, inst))
    return index


_PIN_BITSELECT_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_$]*)\s*\[[^\]]*\]\s*$")


def _pin_signal_base(parent_signal: str) -> str:
    """Strip a trailing part-/bit-select from a pin connection text.

    Mirrors graph_builder._normalize_pin_signal_ref but does not require a
    known-signals set: the tracer always works against a single module scope
    where the answer to "is this name a signal here?" is checked downstream
    via _module_signal_lookup. Stripping unconditionally is safe because the
    only forms that match the regex are ``<bare_ident>[<anything>]``, which
    are exactly the cases we want to collapse.
    """
    cleaned = " ".join(parent_signal.split())
    m = _PIN_BITSELECT_RE.match(cleaned)
    if m:
        return m.group(1)
    return cleaned


def _iter_instance_pins(inst: Instance) -> list[tuple[str, str]]:
    """Yield (child_port, parent_signal_base) pairs for one instance.

    The parent-signal text is normalised so that ``foo[11:2]`` and ``foo[3]``
    are reported as ``foo`` — otherwise tracing the bus would skip every pin
    that consumes a slice of it.
    """
    if inst.pin_connections:
        return [
            (pc.child_port, _pin_signal_base(pc.parent_signal))
            for pc in inst.pin_connections
        ]
    return [(child_port, _pin_signal_base(sig)) for child_port, sig in inst.connections.items()]


def _port_direction(module: ModuleDef, port_name: str) -> str:
    for port in module.ports:
        if port.name == port_name:
            return (port.direction or "").lower()
    return ""


def _is_module_port(module: ModuleDef, signal: str) -> str | None:
    """If `signal` is a module port, return its direction; else None."""
    for port in module.ports:
        if port.name == signal:
            return (port.direction or "").lower()
    return None


def _always_assignments_targeting(block: AlwaysBlock, signal: str) -> list[AlwaysAssignment]:
    return [a for a in block.assignments if a.target == signal]


def _always_assignments_reading(block: AlwaysBlock, signal: str) -> list[AlwaysAssignment]:
    return [a for a in block.assignments if signal in (a.source_signals or [])]


def _find_fanin_local(module: ModuleDef, signal: str) -> list[dict[str, Any]]:
    """Find all local drivers of `signal` inside `module` (no cross-module walk)."""
    hops: list[dict[str, Any]] = []

    # Continuous assigns: target == signal
    for a in module.assigns:
        if a.target == signal:
            hops.append({
                "kind": "assign",
                "label": f"assign {signal}",
                "expression": a.expression or "",
                "detail": f"{signal} = {a.expression}".strip(),
                "sources": list(a.source_signals or []),
            })

    # Always blocks: find assignments whose target is `signal`
    for block in module.always_blocks:
        matches = _always_assignments_targeting(block, signal)
        if not matches:
            continue
        for m in matches:
            op = "=" if m.blocking else "<="
            hops.append({
                "kind": "always",
                "label": f"{block.kind or 'always'} {block.name}",
                "expression": m.expression or "",
                "detail": f"{m.target} {op} {m.expression}".strip(),
                "sources": list(m.source_signals or []),
                "block_name": block.name,
                "process_style": block.process_style or "generic",
                "blocking": bool(m.blocking),
                "condition": m.condition or "",
            })

    # Gates: output == signal
    for gate in module.gates:
        if gate.output == signal:
            hops.append({
                "kind": "gate",
                "label": f"{gate.gate_type} {gate.name}",
                "expression": ", ".join(gate.inputs),
                "detail": f"{gate.output} <- {', '.join(gate.inputs)}",
                "sources": list(gate.inputs),
            })

    # Child instance output pins wired to this signal
    for inst in module.instances:
        for child_port, parent_sig in _iter_instance_pins(inst):
            if parent_sig != signal:
                continue
            # We need to look up the child module to know the port direction.
            # That lookup is done by the walker, which has the module lookup.
            hops.append({
                "kind": "instance_pin_out",  # filtered later if not actually output
                "label": f"{inst.name}.{child_port}",
                "detail": f"from {inst.module_name}.{child_port}",
                "instance_name": inst.name,
                "child_module": inst.module_name,
                "child_port": child_port,
            })

    return hops


def _find_fanout_local(module: ModuleDef, signal: str) -> list[dict[str, Any]]:
    """Find all local loads of `signal` inside `module`."""
    hops: list[dict[str, Any]] = []

    # Continuous assigns: signal in source_signals
    for a in module.assigns:
        if signal in (a.source_signals or []):
            hops.append({
                "kind": "assign",
                "label": f"assign {a.target}",
                "expression": a.expression or "",
                "detail": f"{a.target} = {a.expression}".strip(),
                "target": a.target,
            })

    # Always blocks: assignments that read this signal
    for block in module.always_blocks:
        matches = _always_assignments_reading(block, signal)
        if not matches:
            continue
        for m in matches:
            op = "=" if m.blocking else "<="
            hops.append({
                "kind": "always",
                "label": f"{block.kind or 'always'} {block.name}",
                "expression": m.expression or "",
                "detail": f"{m.target} {op} {m.expression}".strip(),
                "target": m.target,
                "block_name": block.name,
                "process_style": block.process_style or "generic",
                "blocking": bool(m.blocking),
                "condition": m.condition or "",
            })

    # Gates: signal in inputs
    for gate in module.gates:
        if signal in gate.inputs:
            hops.append({
                "kind": "gate",
                "label": f"{gate.gate_type} {gate.name}",
                "expression": ", ".join(gate.inputs),
                "detail": f"{gate.output} <- {', '.join(gate.inputs)}",
                "target": gate.output,
            })

    # Child instance input pins wired to this signal
    for inst in module.instances:
        for child_port, parent_sig in _iter_instance_pins(inst):
            if parent_sig != signal:
                continue
            hops.append({
                "kind": "instance_pin_in",
                "label": f"{inst.name}.{child_port}",
                "detail": f"to {inst.module_name}.{child_port}",
                "instance_name": inst.name,
                "child_module": inst.module_name,
                "child_port": child_port,
            })

    return hops


def trace_signal(
    project: Project,
    module_name: str,
    signal: str,
    max_hops: int = DEFAULT_MAX_HOPS,
) -> dict[str, Any]:
    """Trace a signal's fan-in and fan-out across the whole design.

    Returns a dict:
        {
            "origin": {"module": ..., "signal": ...},
            "fanin":  [hop, ...],
            "fanout": [hop, ...],
            "truncated": bool,
        }
    """
    modules = _module_lookup(project)
    if module_name not in modules:
        raise ValueError(f"Module not found: {module_name}")

    parents = _parent_index(project)

    def make_entry(
        cur_mod: str,
        cur_sig: str,
        hop_kind: str,
        hop: dict[str, Any],
        depth: int,
        direction: str,
        *,
        crosses: str | None = None,
        next_module: str | None = None,
        next_signal: str | None = None,
        label_override: str | None = None,
        detail_override: str | None = None,
    ) -> dict[str, Any]:
        process_style = hop.get("process_style") if hop_kind == "always" else None
        blocking = hop.get("blocking") if hop_kind == "always" else None
        expression = hop.get("expression", "")
        role = _classify_role(hop_kind, process_style, blocking)
        op_category = _classify_expression(expression) if expression else None
        return {
            "module": cur_mod,
            "signal": cur_sig,
            "kind": hop_kind,
            "role": role,
            "op_category": op_category,
            "expression": expression,
            "label": label_override if label_override is not None else hop.get("label", ""),
            "detail": detail_override if detail_override is not None else hop.get("detail", ""),
            "block_name": hop.get("block_name"),
            "process_style": process_style,
            "blocking": blocking,
            "condition": hop.get("condition", ""),
            "depth": depth,
            "direction": direction,
            "crosses": crosses,
            "next_module": next_module,
            "next_signal": next_signal,
        }

    def walk(direction: str) -> tuple[list[dict[str, Any]], bool]:
        assert direction in {"fanin", "fanout"}
        collected: list[dict[str, Any]] = []
        visited: set[tuple[str, str]] = set()
        queue: deque[tuple[str, str, int]] = deque()
        signal_clean = " ".join(signal.split())
        queue.append((module_name, signal_clean, 0))
        visited.add((module_name, signal_clean))
        truncated = False

        while queue:
            if len(collected) >= max_hops:
                truncated = True
                break

            cur_mod, cur_sig, depth = queue.popleft()
            if _is_noise_signal(cur_sig):
                continue
            module = modules.get(cur_mod)
            if module is None:
                collected.append(
                    make_entry(
                        cur_mod,
                        cur_sig,
                        "dead_end",
                        {"label": f"module not found: {cur_mod}", "detail": f"Module '{cur_mod}' is not in the project", "expression": ""},
                        depth,
                        direction,
                    )
                )
                continue

            # Local drivers / loads
            if direction == "fanin":
                local = _find_fanin_local(module, cur_sig)
            else:
                local = _find_fanout_local(module, cur_sig)

            # Emit a dead_end hop when the signal has no local drivers/loads
            # AND is not a module port (ports escape upward, handled below).
            if not local and _is_module_port(module, cur_sig) is None:
                collected.append(
                    make_entry(
                        cur_mod,
                        cur_sig,
                        "dead_end",
                        {"label": f"dead end: {cur_sig}", "detail": f"No {direction} connections found", "expression": ""},
                        depth,
                        direction,
                    )
                )

            for hop in local:
                hop_kind = hop["kind"]

                # Instance pin hops: verify pin direction matches the walk and
                # recurse into the child module scope at that port.
                if hop_kind in ("instance_pin_in", "instance_pin_out"):
                    child_mod = modules.get(hop["child_module"])
                    if child_mod is not None:
                        child_port_dir = _port_direction(child_mod, hop["child_port"])
                        if direction == "fanin":
                            if child_port_dir not in ("output", "inout"):
                                continue
                            hop_kind = "instance_pin_out"
                        else:
                            if child_port_dir not in ("input", "inout"):
                                continue
                            hop_kind = "instance_pin_in"

                    collected.append(
                        make_entry(
                            cur_mod,
                            cur_sig,
                            hop_kind,
                            hop,
                            depth,
                            direction,
                            crosses="down",
                            next_module=hop["child_module"],
                            next_signal=hop["child_port"],
                        )
                    )

                    key = (hop["child_module"], hop["child_port"])
                    if key not in visited and not _is_noise_signal(hop["child_port"]):
                        visited.add(key)
                        queue.append((hop["child_module"], hop["child_port"], depth + 1))
                    continue

                # Simple local hop (assign / always / gate)
                collected.append(
                    make_entry(cur_mod, cur_sig, hop_kind, hop, depth, direction)
                )

                # Follow sources (fanin) or target (fanout) within this scope.
                next_sigs: list[str] = []
                if direction == "fanin":
                    next_sigs = list(hop.get("sources") or [])
                else:
                    tgt = hop.get("target")
                    if tgt:
                        next_sigs = [tgt]

                for ns in next_sigs:
                    ns_clean = " ".join(ns.split())
                    if _is_noise_signal(ns_clean):
                        continue
                    key = (cur_mod, ns_clean)
                    if key in visited:
                        continue
                    visited.add(key)
                    queue.append((cur_mod, ns_clean, depth + 1))

            # Module-port escape: continue into every parent that instantiates.
            port_dir = _is_module_port(module, cur_sig)
            if port_dir is not None:
                if (direction == "fanin" and port_dir in ("input", "inout")) or (
                    direction == "fanout" and port_dir in ("output", "inout")
                ):
                    for parent_mod, parent_inst in parents.get(cur_mod, []):
                        for child_port, parent_sig in _iter_instance_pins(parent_inst):
                            if child_port != cur_sig:
                                continue
                            if _is_noise_signal(parent_sig):
                                continue
                            entry_kind = (
                                "module_port_in" if direction == "fanin" else "module_port_out"
                            )
                            label = f"{parent_mod}.{parent_inst.name}"
                            arrow = "\u2191"
                            detail = f"{arrow} {parent_mod}.{parent_sig}"
                            collected.append(
                                make_entry(
                                    cur_mod,
                                    cur_sig,
                                    entry_kind,
                                    {"label": label, "detail": detail, "expression": ""},
                                    depth,
                                    direction,
                                    crosses="up",
                                    next_module=parent_mod,
                                    next_signal=parent_sig,
                                )
                            )
                            key = (parent_mod, parent_sig)
                            if key not in visited:
                                visited.add(key)
                                queue.append((parent_mod, parent_sig, depth + 1))

        return collected, truncated

    fanin, trunc_in = walk("fanin")
    fanout, trunc_out = walk("fanout")

    return {
        "origin": {"module": module_name, "signal": signal},
        "fanin": fanin,
        "fanout": fanout,
        "truncated": bool(trunc_in or trunc_out),
    }
