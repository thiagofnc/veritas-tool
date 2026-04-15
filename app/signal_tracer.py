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
from typing import Any

from app.models import (
    AlwaysAssignment,
    AlwaysBlock,
    ContinuousAssign,
    Diagnostic,
    GatePrimitive,
    Instance,
    ModuleDef,
    Project,
    SourceLocation,
)


def _loc_dict(location: SourceLocation | None) -> dict[str, Any] | None:
    """Serialize a SourceLocation for API/JSON consumers, or return None."""
    if location is None:
        return None
    return {
        "file": location.file,
        "line": location.line,
        "column": location.column,
        "end_line": location.end_line,
        "end_column": location.end_column,
    }


# Max direct hops returned per direction. The tracer intentionally reports
# only constructs immediately related to the selected signal; deeper
# exploration happens via explicit user navigation instead of recursive
# expansion in one request.
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


def _target_matches(target: str, signal: str) -> bool:
    """Return True when ``target`` writes the same base signal as ``signal``.

    Handles bit-/part-select LHS like ``q[3] <= x`` or ``q[7:0] <= x`` when
    the caller is tracing the base bus ``q`` — otherwise those assignments
    would be invisible to a fanin trace.
    """
    if target == signal:
        return True
    base = target.split("[", 1)[0].strip()
    return base == signal


def _always_assignments_targeting(block: AlwaysBlock, signal: str) -> list[AlwaysAssignment]:
    return [a for a in block.assignments if _target_matches(a.target, signal)]


def _always_assignments_reading(
    block: AlwaysBlock, signal: str,
) -> list[tuple[AlwaysAssignment, bool, bool]]:
    """Return ``(assignment, is_data_dep, is_control_dep)`` for every assignment
    in ``block`` whose fire condition depends on ``signal``.

    ``is_data_dep`` is True when ``signal`` is on the RHS; ``is_control_dep``
    is True when it appears in an enclosing ``if``/``case`` condition.
    Reporting both flags lets the tracer label the hop so users can tell
    "X drives Y's value" from "X decides whether Y fires".
    """
    results: list[tuple[AlwaysAssignment, bool, bool]] = []
    for a in block.assignments:
        in_data = signal in (a.source_signals or [])
        in_cond = signal in (a.condition_signals or [])
        if in_data or in_cond:
            results.append((a, in_data, in_cond))
    return results


def _dep_kind(is_data: bool, is_control: bool) -> str:
    if is_data and is_control:
        return "data+control"
    if is_control:
        return "control"
    return "data"


def _hop_signature(hop: dict[str, Any]) -> tuple[Any, ...]:
    """Stable key for collapsing duplicate direct hops."""
    location = hop.get("location") or {}
    return (
        hop.get("module"),
        hop.get("signal"),
        hop.get("kind"),
        hop.get("direction"),
        hop.get("label"),
        hop.get("detail"),
        hop.get("target"),
        hop.get("dep_kind"),
        hop.get("next_module"),
        hop.get("next_signal"),
        hop.get("block_name"),
        hop.get("process_style"),
        hop.get("condition"),
        location.get("file"),
        location.get("line"),
        location.get("column"),
    )


def _dedupe_entries(hops: list[dict[str, Any]], *, limit: int) -> list[dict[str, Any]]:
    deduped: list[dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    for hop in hops:
        key = _hop_signature(hop)
        if key in seen:
            continue
        seen.add(key)
        hop["id"] = len(deduped)
        hop["parent_id"] = None
        deduped.append(hop)
        if len(deduped) >= limit:
            break
    return deduped


def _find_fanin_local(module: ModuleDef, signal: str) -> list[dict[str, Any]]:
    """Find all local drivers of `signal` inside `module` (no cross-module walk)."""
    hops: list[dict[str, Any]] = []

    # Continuous assigns: target == signal (or target writes a slice of it).
    for a in module.assigns:
        if not _target_matches(a.target, signal):
            continue
        hops.append({
            "kind": "assign",
            "label": f"assign {a.target}",
            "expression": a.expression or "",
            "detail": f"{a.target} = {a.expression}".strip(),
            "sources": list(a.source_signals or []),
            "data_sources": list(a.source_signals or []),
            "condition_sources": [],
            "dep_kind": "data",
            "location": a.location,
        })

    # Always blocks: find assignments whose target is (a slice of) `signal`.
    # Both RHS data dependencies and enclosing-condition control dependencies
    # are returned as drivers, so that e.g. tracing the fanin of ``out`` in
    # ``if (sel) out = a; else out = b;`` surfaces ``sel`` as a direct driver.
    for block in module.always_blocks:
        matches = _always_assignments_targeting(block, signal)
        if not matches:
            continue
        for m in matches:
            op = "=" if m.blocking else "<="
            data_sources = list(m.source_signals or [])
            cond_sources = list(m.condition_signals or [])
            # Dedupe while preserving order; a signal referenced in both RHS
            # and condition is still one queue entry, but the hop metadata
            # lets consumers see both roles.
            merged: list[str] = []
            for name in data_sources + cond_sources:
                if name and name not in merged:
                    merged.append(name)
            dep_kind = _dep_kind(bool(data_sources), bool(cond_sources))
            hops.append({
                "kind": "always",
                "label": f"{block.kind or 'always'} {block.name}",
                "expression": m.expression or "",
                "detail": f"{m.target} {op} {m.expression}".strip(),
                "sources": merged,
                "data_sources": data_sources,
                "condition_sources": cond_sources,
                "dep_kind": dep_kind,
                "block_name": block.name,
                "process_style": block.process_style or "generic",
                "blocking": bool(m.blocking),
                "condition": m.condition or "",
                "location": m.location or block.location,
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
                "location": gate.location,
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
                "location": inst.location,
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
                "dep_kind": "data",
                "location": a.location,
            })

    # Always blocks: assignments that read this signal on the RHS or through
    # a control condition. Fanout must reach both — otherwise a mux select
    # like ``if (sel) out = a`` would never show ``out`` on the fanout of
    # ``sel``, which is exactly the debug case users hit first.
    for block in module.always_blocks:
        matches = _always_assignments_reading(block, signal)
        if not matches:
            continue
        for m, in_data, in_cond in matches:
            op = "=" if m.blocking else "<="
            dep_kind = _dep_kind(in_data, in_cond)
            hops.append({
                "kind": "always",
                "label": f"{block.kind or 'always'} {block.name}",
                "expression": m.expression or "",
                "detail": f"{m.target} {op} {m.expression}".strip(),
                "target": m.target,
                "dep_kind": dep_kind,
                "block_name": block.name,
                "process_style": block.process_style or "generic",
                "blocking": bool(m.blocking),
                "condition": m.condition or "",
                "location": m.location or block.location,
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
                "location": gate.location,
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
                "location": inst.location,
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
    diagnostics: list[Diagnostic] = []
    # Track unresolved modules once so we don't explode the diagnostic list on
    # repeat hops into the same missing child.
    reported_unresolved: set[str] = set()

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
        parent_hop_id: int | None = None,
        hop_id: int = -1,
    ) -> dict[str, Any]:
        process_style = hop.get("process_style") if hop_kind == "always" else None
        blocking = hop.get("blocking") if hop_kind == "always" else None
        expression = hop.get("expression", "")
        role = _classify_role(hop_kind, process_style, blocking)
        op_category = _classify_expression(expression) if expression else None

        module_obj = modules.get(cur_mod)
        source_file = module_obj.source_file if module_obj is not None else ""
        # Prefer the construct's own location (assign/always-assignment/gate/
        # instance). Fall back to the owning module's location so every hop is
        # still jumpable even when the construct doesn't carry one.
        hop_loc = hop.get("location")
        if hop_loc is None and module_obj is not None:
            hop_loc = module_obj.location

        return {
            "id": hop_id,
            "parent_id": parent_hop_id,
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
            "dep_kind": hop.get("dep_kind"),
            "sources": hop.get("sources"),
            "data_sources": hop.get("data_sources"),
            "condition_sources": hop.get("condition_sources"),
            "target": hop.get("target"),
            "instance_name": hop.get("instance_name"),
            "depth": depth,
            "direction": direction,
            "crosses": crosses,
            "next_module": next_module,
            "next_signal": next_signal,
            "source_file": source_file,
            "location": _loc_dict(hop_loc),
            "resolved_module": module_obj is not None,
        }

    def collect_direct_entries(
        cur_module_name: str,
        cur_signal: str,
        direction: str,
        *,
        depth: int = 0,
    ) -> tuple[list[dict[str, Any]], bool]:
        assert direction in {"fanin", "fanout"}
        signal_clean = " ".join(cur_signal.split())
        collected: list[dict[str, Any]] = []

        module = modules.get(cur_module_name)
        if module is None:
            diagnostics.append(Diagnostic(
                severity="warning",
                kind="unresolved_module",
                message=(
                    f"Module '{cur_module_name}' is not in the loaded project; "
                    f"{direction} trace truncated at this boundary."
                ),
                detail=signal_clean,
            ))
            collected.append(make_entry(
                cur_module_name,
                signal_clean,
                "dead_end",
                {"label": f"module not found: {cur_module_name}", "detail": f"Module '{cur_module_name}' is not in the project", "expression": ""},
                depth,
                direction,
            ))
            return _dedupe_entries(collected, limit=max_hops), False

        local = _find_fanin_local(module, signal_clean) if direction == "fanin" else _find_fanout_local(module, signal_clean)

        for hop in local:
            hop_kind = hop["kind"]
            if hop_kind in ("instance_pin_in", "instance_pin_out"):
                child_mod_name = hop["child_module"]
                child_mod = modules.get(child_mod_name)
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
                elif child_mod_name not in reported_unresolved:
                    reported_unresolved.add(child_mod_name)
                    diagnostics.append(Diagnostic(
                        severity="warning",
                        kind="unresolved_module",
                        message=(
                            f"Module '{child_mod_name}' is not in the loaded project; "
                            f"{direction} trace stops at this instance boundary."
                        ),
                        detail=hop["child_port"],
                    ))

                collected.append(make_entry(
                    cur_module_name,
                    signal_clean,
                    hop_kind,
                    hop,
                    depth,
                    direction,
                    crosses="down",
                    next_module=child_mod_name,
                    next_signal=hop["child_port"],
                ))
                continue

            collected.append(make_entry(
                cur_module_name,
                signal_clean,
                hop_kind,
                hop,
                depth,
                direction,
            ))

        port_dir = _is_module_port(module, signal_clean)
        if port_dir is not None:
            if (direction == "fanin" and port_dir in ("input", "inout")) or (
                direction == "fanout" and port_dir in ("output", "inout")
            ):
                for parent_mod, parent_inst in parents.get(cur_module_name, []):
                    for child_port, parent_sig in _iter_instance_pins(parent_inst):
                        if child_port != signal_clean or _is_noise_signal(parent_sig):
                            continue
                        entry_kind = "module_port_in" if direction == "fanin" else "module_port_out"
                        collected.append(make_entry(
                            cur_module_name,
                            signal_clean,
                            entry_kind,
                            {
                                "label": f"{parent_mod}.{parent_inst.name}",
                                "detail": f"\u2191 {parent_mod}.{parent_sig}",
                                "expression": "",
                                "instance_name": parent_inst.name,
                                "location": parent_inst.location,
                            },
                            depth,
                            direction,
                            crosses="up",
                            next_module=parent_mod,
                            next_signal=parent_sig,
                        ))

        if not collected:
            collected.append(make_entry(
                cur_module_name,
                signal_clean,
                "dead_end",
                {"label": f"dead end: {signal_clean}", "detail": f"No {direction} connections found", "expression": ""},
                depth,
                direction,
            ))

        deduped = _dedupe_entries(collected, limit=max_hops)
        truncated = len(collected) > len(deduped)
        if len(deduped) >= max_hops and len(collected) > max_hops:
            truncated = True
        return deduped, truncated

    def walk(direction: str) -> tuple[list[dict[str, Any]], bool]:
        assert direction in {"fanin", "fanout"}
        return collect_direct_entries(module_name, signal, direction, depth=0)

    def build_chains(hops: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
        """Reconstruct whole chains of direct correlations from one origin."""
        direction = hops[0]["direction"] if hops else "fanout"
        chain_limit = max(1, max_hops)
        chains: list[list[dict[str, Any]]] = []
        emitted: set[tuple[tuple[Any, ...], ...]] = set()
        exploration_truncated = False

        def next_states_from_hop(hop: dict[str, Any]) -> list[tuple[str, str]]:
            next_states: list[tuple[str, str]] = []
            if hop.get("crosses") and hop.get("next_module") and hop.get("next_signal"):
                next_states.append((hop["next_module"], hop["next_signal"]))
                return next_states

            if direction == "fanin":
                for source_name in hop.get("sources") or []:
                    clean = " ".join(str(source_name).split())
                    if clean and not _is_noise_signal(clean):
                        next_states.append((hop["module"], clean))
            else:
                target = hop.get("target")
                clean = " ".join(str(target).split()) if target else ""
                if clean and not _is_noise_signal(clean):
                    next_states.append((hop["module"], clean))
            return next_states

        def record_chain(path: list[dict[str, Any]]) -> None:
            nonlocal exploration_truncated
            key = tuple(_hop_signature(h) for h in path)
            if key in emitted:
                return
            emitted.add(key)
            chains.append(path)
            if len(chains) >= chain_limit:
                exploration_truncated = True

        def descend(cur_module_name: str, cur_signal: str, path: list[dict[str, Any]], seen_states: set[tuple[str, str]]) -> None:
            nonlocal exploration_truncated
            if exploration_truncated:
                return

            direct_hops, _ = collect_direct_entries(cur_module_name, cur_signal, direction, depth=len(path))
            if not direct_hops:
                if path:
                    record_chain(path)
                return

            for hop in direct_hops:
                if exploration_truncated:
                    return

                next_path = [*path, hop]
                next_states = next_states_from_hop(hop)
                if not next_states or hop["kind"] == "dead_end":
                    record_chain(next_path)
                    continue

                progressed = False
                for next_module_name, next_signal_name in next_states:
                    state_key = (next_module_name, next_signal_name)
                    if state_key in seen_states:
                        continue
                    progressed = True
                    descend(next_module_name, next_signal_name, next_path, seen_states | {state_key})

                if not progressed:
                    record_chain(next_path)

        descend(module_name, signal, [], {(module_name, " ".join(signal.split()))})
        return chains[:chain_limit]

    fanin, trunc_in = walk("fanin")
    fanout, trunc_out = walk("fanout")

    fanin_chains = build_chains(fanin)
    fanout_chains = build_chains(fanout)

    return {
        "origin": {"module": module_name, "signal": signal},
        "fanin": fanin,
        "fanout": fanout,
        "chains": {
            "fanin": fanin_chains,
            "fanout": fanout_chains,
        },
        "truncated": bool(trunc_in or trunc_out),
        "diagnostics": [
            {
                "severity": d.severity,
                "kind": d.kind,
                "message": d.message,
                "file": d.file,
                "line": d.line,
                "detail": d.detail,
            }
            for d in diagnostics
        ],
    }
