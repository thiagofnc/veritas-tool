"""Graph builders for hierarchy and module-internal connectivity views."""

from collections import defaultdict
import re
from typing import Any

try:
    from app.models import AlwaysAssignment, AlwaysBlock, ContinuousAssign, GatePrimitive, Instance, ModuleDef, Port, Project, Signal
except ImportError:  # Supports running as: python app/main.py
    from models import AlwaysAssignment, AlwaysBlock, ContinuousAssign, GatePrimitive, Instance, ModuleDef, Port, Project, Signal


GRAPH_SCHEMA_VERSION = "1.0"
CONNECTIVITY_SCHEMA_VERSION = "1.1-connectivity"

_WIDTH_RANGE_RE = re.compile(r"\[\s*([^:\]]+)\s*:\s*([^\]]+)\s*\]")
_SIMPLE_SIGNAL_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_$]*)(?:\[(.+)\])?$")
_PARTSELECT_RE = re.compile(r"^(.+?)(\+:|-:)\s*(.+)$")
_POSITIONAL_ARG_RE = re.compile(r"^arg(\\d+)$")


def _parse_simple_int(token: str) -> int | None:
    text = token.strip().replace("_", "")
    if re.fullmatch(r"\d+", text):
        return int(text)
    return None


def _infer_decl_width(width: str | None) -> tuple[int | None, bool]:
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


def _build_module_lookup(modules: list[ModuleDef]) -> dict[str, ModuleDef]:
    lookup: dict[str, ModuleDef] = {}
    for module in modules:
        # Keep first definition if duplicates exist.
        lookup.setdefault(module.name, module)
    return lookup


def _port_metadata(module_def: ModuleDef, port_name: str) -> dict[str, Any]:
    for port in module_def.ports:
        if port.name != port_name:
            continue

        bit_width = getattr(port, "bit_width", None)
        is_bus = bool(getattr(port, "is_bus", False))
        if bit_width is None:
            inferred_width, inferred_bus = _infer_decl_width(getattr(port, "width", None))
            bit_width = inferred_width
            is_bus = is_bus or inferred_bus

        if bit_width is not None and bit_width > 1:
            is_bus = True

        return {
            "direction": (port.direction or "unknown").lower(),
            "declared_width": port.width,
            "bit_width": bit_width,
            "is_bus": is_bus,
            "signal_kind": "port",
        }

    return {
        "direction": "unknown",
        "declared_width": None,
        "bit_width": None,
        "is_bus": False,
        "signal_kind": "unknown",
    }


def _build_signal_lookup(module_def: ModuleDef) -> dict[str, dict[str, Any]]:
    lookup: dict[str, dict[str, Any]] = {}

    for signal in module_def.signals:
        bit_width = getattr(signal, "bit_width", None)
        is_bus = bool(getattr(signal, "is_bus", False))
        if bit_width is None:
            inferred_width, inferred_bus = _infer_decl_width(getattr(signal, "width", None))
            bit_width = inferred_width
            is_bus = is_bus or inferred_bus

        if bit_width is not None and bit_width > 1:
            is_bus = True

        lookup[signal.name] = {
            "declared_width": signal.width,
            "bit_width": bit_width,
            "is_bus": is_bus,
            "signal_kind": signal.kind,
        }

    # Port declarations can also serve as in-scope signal declarations.
    for port in module_def.ports:
        if port.name in lookup:
            continue

        bit_width = getattr(port, "bit_width", None)
        is_bus = bool(getattr(port, "is_bus", False))
        if bit_width is None:
            inferred_width, inferred_bus = _infer_decl_width(getattr(port, "width", None))
            bit_width = inferred_width
            is_bus = is_bus or inferred_bus

        if bit_width is not None and bit_width > 1:
            is_bus = True

        lookup[port.name] = {
            "declared_width": port.width,
            "bit_width": bit_width,
            "is_bus": is_bus,
            "signal_kind": "port",
        }

    return lookup


def _parse_signal_reference(signal_expr: str) -> dict[str, Any]:
    normalized = " ".join(signal_expr.split())
    match = _SIMPLE_SIGNAL_RE.match(normalized)
    if not match:
        return {
            "expr": normalized,
            "base_name": None,
            "slice": None,
            "bit_width": None,
            "is_bus": False,
        }

    base_name = match.group(1)
    selector = match.group(2)
    if selector is None:
        return {
            "expr": normalized,
            "base_name": base_name,
            "slice": None,
            "bit_width": None,
            "is_bus": False,
        }

    selector_text = selector.strip()

    partselect = _PARTSELECT_RE.match(selector_text)
    if partselect:
        width_token = partselect.group(3)
        width_value = _parse_simple_int(width_token)
        return {
            "expr": normalized,
            "base_name": base_name,
            "slice": f"[{selector_text}]",
            "bit_width": width_value,
            "is_bus": True if width_value is None else width_value > 1,
        }

    if ":" in selector_text:
        left, right = selector_text.split(":", maxsplit=1)
        left_int = _parse_simple_int(left)
        right_int = _parse_simple_int(right)
        if left_int is not None and right_int is not None:
            width_value = abs(left_int - right_int) + 1
            return {
                "expr": normalized,
                "base_name": base_name,
                "slice": f"[{selector_text}]",
                "bit_width": width_value,
                "is_bus": width_value > 1,
            }

        return {
            "expr": normalized,
            "base_name": base_name,
            "slice": f"[{selector_text}]",
            "bit_width": None,
            "is_bus": True,
        }

    # Single-bit index selection.
    return {
        "expr": normalized,
        "base_name": base_name,
        "slice": f"[{selector_text}]",
        "bit_width": 1,
        "is_bus": False,
    }


def _signal_metadata_for_reference(
    signal_expr: str,
    signal_lookup: dict[str, dict[str, Any]],
    endpoints: list[dict[str, Any]],
) -> dict[str, Any]:
    ref = _parse_signal_reference(signal_expr)
    base_name = ref["base_name"]
    declared = signal_lookup.get(base_name) if base_name else None

    bit_width = ref["bit_width"]
    if bit_width is None and declared is not None:
        bit_width = declared.get("bit_width")

    endpoint_widths = [ep.get("bit_width") for ep in endpoints if ep.get("bit_width") is not None]
    if bit_width is None and endpoint_widths:
        bit_width = max(endpoint_widths)

    is_bus = bool(ref["is_bus"])
    if declared is not None:
        is_bus = is_bus or bool(declared.get("is_bus", False))

    if not is_bus and any(bool(ep.get("is_bus", False)) for ep in endpoints):
        is_bus = True

    if not is_bus and bit_width is not None and bit_width > 1:
        is_bus = True

    return {
        "signal_name": ref["expr"],
        "signal_base": base_name,
        "signal_slice": ref["slice"],
        "declared_width": declared.get("declared_width") if declared else None,
        "bit_width": bit_width,
        "is_bus": is_bus,
        "sig_class": "bus" if is_bus else "wire",
        "signal_kind": declared.get("signal_kind") if declared else "unknown",
    }


def _port_direction(module_def: ModuleDef, port_name: str) -> str:
    for port in module_def.ports:
        if port.name == port_name:
            return (port.direction or "unknown").lower()
    return "unknown"


def _endpoint_role(direction: str) -> str:
    normalized = direction.lower()
    if normalized == "output":
        return "source"
    if normalized == "input":
        return "sink"
    if normalized == "inout":
        return "bidir"
    return "unknown"


def _endpoint_flow_role(endpoint: dict[str, Any]) -> str:
    """Map endpoint direction to signal flow role in the viewed module scope.

    Instance pin directions are interpreted as written on the child module.
    Module I/O directions are interpreted from inside the current module.
    """
    role = _endpoint_role(endpoint["direction"])
    if endpoint.get("endpoint_kind") != "module_io":
        return role

    # Module input pins feed logic in this scope, while module outputs consume it.
    if role == "source":
        return "sink"
    if role == "sink":
        return "source"
    return role


def _instance_pin_pairs(instance: Instance) -> list[tuple[str, str]]:
    if instance.pin_connections:
        pairs = [(pin.child_port, pin.parent_signal) for pin in instance.pin_connections]
    else:
        pairs = list(instance.connections.items())

    cleaned: list[tuple[str, str]] = []
    for child_port, parent_signal in pairs:
        signal = " ".join(parent_signal.split())
        if not signal:
            signal = f"__open__:{instance.name}.{child_port}"
        cleaned.append((child_port, signal))

    return cleaned


def _resolve_child_port_name(child_port: str, child_module_def: ModuleDef | None) -> str:
    """Map positional parser keys like arg0 to concrete child port names when possible."""
    if child_module_def is None:
        return child_port

    match = _POSITIONAL_ARG_RE.fullmatch(child_port)
    if not match:
        return child_port

    index = int(match.group(1))
    if 0 <= index < len(child_module_def.ports):
        return child_module_def.ports[index].name

    return child_port


def _always_signal_roles(block: AlwaysBlock) -> tuple[list[str], list[str], list[str]]:
    read_signals: list[str] = []
    written_signals: list[str] = []

    for signal_name in getattr(block, "read_signals", None) or []:
        if signal_name not in read_signals:
            read_signals.append(signal_name)

    for signal_name in getattr(block, "written_signals", None) or []:
        if signal_name not in written_signals:
            written_signals.append(signal_name)

    shared = [signal_name for signal_name in read_signals if signal_name in written_signals]
    inputs = [signal_name for signal_name in read_signals if signal_name not in shared]
    outputs = [signal_name for signal_name in written_signals if signal_name not in shared]
    return (inputs, outputs, shared)


def _aggregate_compact_edges(edges: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse parallel compact edges by source/target/flow for cleaner layouts."""
    grouped: dict[tuple[str, str, str], dict[str, Any]] = {}

    for edge in edges:
        key = (edge["source"], edge["target"], edge.get("flow", "directed"))
        group = grouped.get(key)
        if group is None:
            group = {
                "source": edge["source"],
                "target": edge["target"],
                "kind": edge.get("kind", "connection"),
                "flow": edge.get("flow", "directed"),
                "nets": [],
                "bus_nets": [],
                "wire_nets": [],
                "connections": [],
                "signal_kinds": [],
                "bit_width": None,
            }
            grouped[key] = group

        net_name = edge.get("net", "")
        if net_name and net_name not in group["nets"]:
            group["nets"].append(net_name)

        sig_class = edge.get("sig_class", "wire")
        if sig_class == "bus" and net_name and net_name not in group["bus_nets"]:
            group["bus_nets"].append(net_name)
        elif sig_class != "bus" and net_name and net_name not in group["wire_nets"]:
            group["wire_nets"].append(net_name)

        signal_kind = edge.get("signal_kind", "unknown")
        if signal_kind not in group["signal_kinds"]:
            group["signal_kinds"].append(signal_kind)

        bit_width = edge.get("bit_width")
        if isinstance(bit_width, int):
            existing = group.get("bit_width")
            group["bit_width"] = bit_width if existing is None else max(existing, bit_width)

        group["connections"].append(
            {
                "net": net_name,
                "source_port": edge.get("source_port", ""),
                "target_port": edge.get("target_port", ""),
                "sig_class": sig_class,
                "bit_width": edge.get("bit_width"),
                "signal_slice": edge.get("signal_slice"),
            }
        )

    aggregated: list[dict[str, Any]] = []
    for group in grouped.values():
        group["net_count"] = len(group["nets"])
        group["bus_net_count"] = len(group["bus_nets"])
        group["wire_net_count"] = len(group["wire_nets"])

        if group["bus_net_count"] and group["wire_net_count"]:
            group["sig_class"] = "mixed"
            group["is_bus"] = True
        elif group["bus_net_count"]:
            group["sig_class"] = "bus"
            group["is_bus"] = True
        else:
            group["sig_class"] = "wire"
            group["is_bus"] = False

        if group["net_count"] == 1:
            group["net"] = group["nets"][0]

        if len(group["signal_kinds"]) == 1:
            group["signal_kind"] = group["signal_kinds"][0]

        aggregated.append(group)

    aggregated.sort(key=lambda edge: (edge["source"], edge["target"], edge.get("flow", "")))
    return aggregated


def build_module_connectivity_graph(
    project: Project,
    module_name: str,
    mode: str = "compact",
    aggregate_edges: bool = False,
    port_view: bool = False,
) -> dict[str, Any]:
    """Build a module-scope connectivity graph from shared parent signals.

    Mode:
    - compact: instance/module-io nodes + direct connection edges with net metadata.
    - detailed: adds net nodes and routes connections through nets.

    Port view:
    - when enabled, exposes explicit instance port nodes so edges terminate on pins.
    """
    if mode not in {"compact", "detailed"}:
        raise ValueError("Unsupported connectivity mode. Use 'compact' or 'detailed'.")

    module_lookup = _build_module_lookup(project.modules)
    module_def = module_lookup.get(module_name)
    if module_def is None:
        raise ValueError(f"Module not found in project: {module_name}")

    signal_lookup = _build_signal_lookup(module_def)

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    seen_node_ids: set[str] = set()
    seen_edges: set[tuple[Any, ...]] = set()

    def add_node(node: dict[str, Any]) -> None:
        node_id = str(node["id"])
        if node_id in seen_node_ids:
            return
        seen_node_ids.add(node_id)
        nodes.append(node)

    def add_edge(edge: dict[str, Any]) -> None:
        key = (
            edge["source"],
            edge["target"],
            edge.get("kind", "connection"),
            edge.get("net", ""),
            edge.get("source_port", ""),
            edge.get("target_port", ""),
            edge.get("flow", ""),
        )
        if key in seen_edges:
            return
        seen_edges.add(key)
        edges.append(edge)

    attachments_by_signal: dict[str, list[dict[str, Any]]] = defaultdict(list)

    # Module I/O as first-class endpoints in this module-scope connectivity view.
    for port in sorted(module_def.ports, key=lambda p: p.name):
        port_meta = _port_metadata(module_def, port.name)
        node_id = f"io:{port.name}"

        label_suffix = f"[{port_meta['bit_width']}]" if port_meta["bit_width"] and port_meta["bit_width"] > 1 else ""
        add_node(
            {
                "id": node_id,
                "label": f"{port.name} ({port.direction}) {label_suffix}".strip(),
                "kind": "module_io",
                "port_name": port.name,
                "direction": (port.direction or "unknown").lower(),
                "declared_width": port_meta["declared_width"],
                "bit_width": port_meta["bit_width"],
                "is_bus": port_meta["is_bus"],
                "sig_class": "bus" if port_meta["is_bus"] else "wire",
                "signal_kind": "port",
            }
        )

        attachments_by_signal[port.name].append(
            {
                "node_id": node_id,
                "endpoint_kind": "module_io",
                "port_name": port.name,
                "direction": (port.direction or "unknown").lower(),
                "bit_width": port_meta["bit_width"],
                "is_bus": port_meta["is_bus"],
            }
        )

    # Instance-level endpoints attached to parent-module signals.
    for instance in sorted(module_def.instances, key=lambda i: i.name):
        instance_pin_pairs = _instance_pin_pairs(instance)
        instance_id = f"instance:{instance.name}"
        add_node(
            {
                "id": instance_id,
                "label": f"{instance.name}: {instance.module_name}",
                "kind": "instance",
                "instance_name": instance.name,
                "module_name": instance.module_name,
                "port_view": port_view,
                "port_count": len(instance_pin_pairs),
            }
        )

        child_module_def = module_lookup.get(instance.module_name)

        for child_port, parent_signal in instance_pin_pairs:
            resolved_child_port = _resolve_child_port_name(child_port, child_module_def)
            port_meta = {
                "direction": "unknown",
                "declared_width": None,
                "bit_width": None,
                "is_bus": False,
            }
            if child_module_def is not None:
                port_meta = _port_metadata(child_module_def, resolved_child_port)

            endpoint_node_id = instance_id
            if port_view:
                port_node_id = f"instance_port:{instance.name}.{resolved_child_port}"
                endpoint_node_id = port_node_id
                add_node(
                    {
                        "id": port_node_id,
                        "label": resolved_child_port,
                        "kind": "instance_port",
                        "instance_name": instance.name,
                        "instance_node_id": instance_id,
                        "module_name": instance.module_name,
                        "port_name": resolved_child_port,
                        "direction": port_meta["direction"],
                        "declared_width": port_meta["declared_width"],
                        "bit_width": port_meta["bit_width"],
                        "is_bus": port_meta["is_bus"],
                        "sig_class": "bus" if port_meta["is_bus"] else "wire",
                    }
                )

            attachments_by_signal[parent_signal].append(
                {
                    "node_id": endpoint_node_id,
                    "endpoint_kind": "instance_pin",
                    "instance_name": instance.name,
                    "module_name": instance.module_name,
                    "port_name": resolved_child_port,
                    "direction": port_meta["direction"],
                    "bit_width": port_meta["bit_width"],
                    "is_bus": port_meta["is_bus"],
                }
            )

    # Gate primitive nodes.
    for gate in sorted(getattr(module_def, "gates", None) or [], key=lambda g: g.name):
        gate_id = f"gate:{gate.name}"
        add_node(
            {
                "id": gate_id,
                "label": f"{gate.name} ({gate.gate_type})",
                "kind": "gate",
                "gate_type": gate.gate_type,
                "gate_name": gate.name,
            }
        )

        # Output signal attachment (gate drives this signal).
        output_base = _parse_signal_reference(gate.output).get("base_name") or gate.output
        attachments_by_signal[output_base].append(
            {
                "node_id": gate_id,
                "endpoint_kind": "gate_pin",
                "port_name": gate.output,
                "direction": "output",
                "bit_width": 1,
                "is_bus": False,
            }
        )

        # Input signal attachments (gate reads these signals).
        for inp in gate.inputs:
            inp_base = _parse_signal_reference(inp).get("base_name") or inp
            attachments_by_signal[inp_base].append(
                {
                    "node_id": gate_id,
                    "endpoint_kind": "gate_pin",
                    "port_name": inp,
                    "direction": "input",
                    "bit_width": 1,
                    "is_bus": False,
                }
            )

    # Continuous assign nodes — show full expression.
    for idx, assign in enumerate(getattr(module_def, "assigns", None) or []):
        assign_id = f"assign:{idx}:{assign.target}"
        target_base = _parse_signal_reference(assign.target).get("base_name") or assign.target
        sig_info = signal_lookup.get(target_base, {})

        add_node(
            {
                "id": assign_id,
                "label": f"{assign.target} = {assign.expression}",
                "kind": "assign",
                "expression": assign.expression,
                "target_signal": assign.target,
            }
        )

        # The assign drives the target signal.
        attachments_by_signal[target_base].append(
            {
                "node_id": assign_id,
                "endpoint_kind": "assign_out",
                "port_name": assign.target,
                "direction": "output",
                "bit_width": sig_info.get("bit_width"),
                "is_bus": sig_info.get("is_bus", False),
            }
        )

        # The assign reads source signals.
        for src in assign.source_signals:
            src_base = _parse_signal_reference(src).get("base_name") or src
            attachments_by_signal[src_base].append(
                {
                    "node_id": assign_id,
                    "endpoint_kind": "assign_in",
                    "port_name": src,
                    "direction": "input",
                    "bit_width": signal_lookup.get(src_base, {}).get("bit_width"),
                    "is_bus": signal_lookup.get(src_base, {}).get("is_bus", False),
                }
            )

    # Always blocks are rendered as collapsed process nodes with explicit read/write pins.
    for block in getattr(module_def, "always_blocks", None) or []:
        block_id = f"always:{block.name}"
        input_signals, output_signals, feedback_signals = _always_signal_roles(block)
        title = getattr(block, "sensitivity_title", None) or (f"ALWAYS @({block.sensitivity})" if block.sensitivity else "ALWAYS")
        label = getattr(block, "sensitivity_label", None) or title
        subtitle = title if label != title else ""
        summary_lines = list(getattr(block, "summary_lines", None) or [])[:8]
        control_summary = list(getattr(block, "control_summary", None) or [])[:6]

        add_node(
            {
                "id": block_id,
                "label": label,
                "title": title,
                "subtitle": subtitle,
                "kind": "always",
                "always_kind": block.kind,
                "process_style": getattr(block, "process_style", "generic"),
                "edge_polarity": getattr(block, "edge_polarity", ""),
                "clock_signal": getattr(block, "clock_signal", ""),
                "sensitivity": block.sensitivity,
                "sensitivity_title": title,
                "sensitivity_label": label,
                "block_name": block.name,
                "read_signals": list(getattr(block, "read_signals", None) or []),
                "written_signals": list(getattr(block, "written_signals", None) or []),
                "input_signals": input_signals,
                "output_signals": output_signals,
                "feedback_signals": feedback_signals,
                "control_summary": control_summary,
                "summary_lines": summary_lines,
                "collapsed": True,
                "port_count": len(input_signals) + len(output_signals) + len(feedback_signals),
            }
        )

        port_specs = [("input", sig_name) for sig_name in input_signals]
        port_specs.extend(("output", sig_name) for sig_name in output_signals)
        port_specs.extend(("inout", sig_name) for sig_name in feedback_signals)

        for direction, sig_name in port_specs:
            sig_base = _parse_signal_reference(sig_name).get("base_name") or sig_name
            sig_info = signal_lookup.get(sig_base, {})
            endpoint_node_id = block_id
            if port_view:
                port_node_id = f"process_port:{block.name}:{direction}:{sig_name}"
                endpoint_node_id = port_node_id
                add_node(
                    {
                        "id": port_node_id,
                        "label": sig_name,
                        "kind": "process_port",
                        "parent_node_id": block_id,
                        "process_node_id": block_id,
                        "block_name": block.name,
                        "port_name": sig_name,
                        "direction": direction,
                        "declared_width": sig_info.get("declared_width"),
                        "bit_width": sig_info.get("bit_width"),
                        "is_bus": sig_info.get("is_bus", False),
                        "sig_class": "bus" if sig_info.get("is_bus", False) else "wire",
                    }
                )

            attachments_by_signal[sig_base].append(
                {
                    "node_id": endpoint_node_id,
                    "endpoint_kind": "always_port",
                    "port_name": sig_name,
                    "direction": direction,
                    "bit_width": sig_info.get("bit_width"),
                    "is_bus": sig_info.get("is_bus", False),
                }
            )
    if mode == "detailed":
        for signal_name in sorted(attachments_by_signal):
            endpoints = attachments_by_signal[signal_name]
            signal_meta = _signal_metadata_for_reference(signal_name, signal_lookup, endpoints)

            net_id = f"net:{signal_name}"
            label_suffix = f"[{signal_meta['bit_width']}]" if signal_meta["bit_width"] and signal_meta["bit_width"] > 1 else ""
            add_node(
                {
                    "id": net_id,
                    "label": f"{signal_name} {label_suffix}".strip(),
                    "kind": "net",
                    "signal_name": signal_name,
                    "signal_base": signal_meta["signal_base"],
                    "signal_slice": signal_meta["signal_slice"],
                    "declared_width": signal_meta["declared_width"],
                    "bit_width": signal_meta["bit_width"],
                    "is_bus": signal_meta["is_bus"],
                    "sig_class": signal_meta["sig_class"],
                    "signal_kind": signal_meta["signal_kind"],
                }
            )

            for endpoint in endpoints:
                role = _endpoint_flow_role(endpoint)

                edge_meta = {
                    "kind": "connection",
                    "net": signal_name,
                    "signal_name": signal_meta["signal_name"],
                    "signal_base": signal_meta["signal_base"],
                    "signal_slice": signal_meta["signal_slice"],
                    "declared_width": signal_meta["declared_width"],
                    "bit_width": signal_meta["bit_width"],
                    "is_bus": signal_meta["is_bus"],
                    "sig_class": signal_meta["sig_class"],
                    "signal_kind": signal_meta["signal_kind"],
                }

                if role in {"source", "bidir"}:
                    add_edge(
                        {
                            "source": endpoint["node_id"],
                            "target": net_id,
                            "source_port": endpoint["port_name"],
                            "target_port": signal_name,
                            "flow": "directed",
                            **edge_meta,
                        }
                    )

                if role in {"sink", "bidir"}:
                    add_edge(
                        {
                            "source": net_id,
                            "target": endpoint["node_id"],
                            "source_port": signal_name,
                            "target_port": endpoint["port_name"],
                            "flow": "directed",
                            **edge_meta,
                        }
                    )

                if role == "unknown":
                    add_edge(
                        {
                            "source": net_id,
                            "target": endpoint["node_id"],
                            "source_port": signal_name,
                            "target_port": endpoint["port_name"],
                            "flow": "unknown",
                            **edge_meta,
                        }
                    )

    else:
        for signal_name in sorted(attachments_by_signal):
            endpoints = attachments_by_signal[signal_name]
            signal_meta = _signal_metadata_for_reference(signal_name, signal_lookup, endpoints)

            sources = [ep for ep in endpoints if _endpoint_flow_role(ep) in {"source", "bidir"}]
            sinks = [ep for ep in endpoints if _endpoint_flow_role(ep) in {"sink", "bidir"}]

            edge_meta = {
                "kind": "connection",
                "net": signal_name,
                "signal_name": signal_meta["signal_name"],
                "signal_base": signal_meta["signal_base"],
                "signal_slice": signal_meta["signal_slice"],
                "declared_width": signal_meta["declared_width"],
                "bit_width": signal_meta["bit_width"],
                "is_bus": signal_meta["is_bus"],
                "sig_class": signal_meta["sig_class"],
                "signal_kind": signal_meta["signal_kind"],
            }

            if sources and sinks:
                for source in sources:
                    for sink in sinks:
                        if source["node_id"] == sink["node_id"]:
                            continue

                        add_edge(
                            {
                                "source": source["node_id"],
                                "target": sink["node_id"],
                                "source_port": source["port_name"],
                                "target_port": sink["port_name"],
                                "flow": "directed",
                                **edge_meta,
                            }
                        )
            else:
                # Unknown directionality fallback keeps connectivity visible.
                ordered = sorted(endpoints, key=lambda ep: (ep["node_id"], ep.get("port_name", "")))
                for index, left in enumerate(ordered):
                    for right in ordered[index + 1 :]:
                        if left["node_id"] == right["node_id"]:
                            continue

                        add_edge(
                            {
                                "source": left["node_id"],
                                "target": right["node_id"],
                                "source_port": left["port_name"],
                                "target_port": right["port_name"],
                                "flow": "unknown",
                                **edge_meta,
                            }
                        )

    return {
        "schema_version": CONNECTIVITY_SCHEMA_VERSION,
        "view": "module_connectivity",
        "mode": mode,
        "port_view": port_view,
        "top_module": module_name,
        "focus_module": module_name,
        "nodes": nodes,
        "edges": _aggregate_compact_edges(edges) if mode == "compact" and aggregate_edges else edges,
    }


def build_hierarchy_graph(project: Project, top_module: str) -> dict[str, Any]:
    """Build a stable graph schema with module/instance/port/net nodes.

    Node shape: {id, label, kind}
    Edge shape: {source, target, kind}

    Edge kinds:
    - hierarchy: ownership/structure links (module->instance, module->port, etc.)
    - signal: wiring links (net->port, port->net)
    """
    module_lookup = _build_module_lookup(project.modules)

    nodes: list[dict[str, str]] = []
    edges: list[dict[str, str]] = []
    seen_node_ids: set[str] = set()
    seen_edges: set[tuple[str, str, str]] = set()

    def add_node(node_id: str, label: str, kind: str) -> None:
        if node_id in seen_node_ids:
            return
        seen_node_ids.add(node_id)
        nodes.append({"id": node_id, "label": label, "kind": kind})

    def add_edge(source: str, target: str, kind: str) -> None:
        key = (source, target, kind)
        if key in seen_edges:
            return
        seen_edges.add(key)
        edges.append({"source": source, "target": target, "kind": kind})

    def module_node_id(path_id: str) -> str:
        return f"module:{path_id}"

    def instance_node_id(parent_path_id: str, instance_name: str) -> str:
        return f"instance:{parent_path_id}/{instance_name}"

    def module_port_node_id(module_path_id: str, port_name: str) -> str:
        return f"port:{module_path_id}:{port_name}"

    def instance_port_node_id(instance_id: str, port_name: str) -> str:
        return f"port:{instance_id}:{port_name}"

    def net_node_id(module_path_id: str, signal_name: str) -> str:
        return f"net:{module_path_id}:{signal_name}"

    def add_module_interface_nodes(module_def: ModuleDef, module_id: str, module_path_id: str) -> set[str]:
        # Track names that exist as nets in this module scope.
        known_nets: set[str] = set()

        for port in sorted(module_def.ports, key=lambda p: p.name):
            port_id = module_port_node_id(module_path_id, port.name)
            add_node(port_id, f"{port.name} ({port.direction})", "port")
            add_edge(module_id, port_id, "hierarchy")

            # Treat interface names as addressable nets for parent/child wiring.
            net_id = net_node_id(module_path_id, port.name)
            add_node(net_id, port.name, "net")
            add_edge(port_id, net_id, "signal")
            known_nets.add(port.name)

        for signal in sorted(module_def.signals, key=lambda s: s.name):
            net_id = net_node_id(module_path_id, signal.name)
            add_node(net_id, signal.name, "net")
            add_edge(module_id, net_id, "hierarchy")
            known_nets.add(signal.name)

        return known_nets

    def connect_instance_pins(
        module_path_id: str,
        instance: Instance,
        instance_id: str,
        known_nets: set[str],
    ) -> None:
        if instance.pin_connections:
            pin_pairs = sorted(
                ((pin.child_port, pin.parent_signal) for pin in instance.pin_connections),
                key=lambda pair: pair[0],
            )
        else:
            pin_pairs = sorted(instance.connections.items(), key=lambda pair: pair[0])

        for child_port, parent_signal in pin_pairs:
            signal_name = parent_signal.strip()
            if not signal_name:
                # Preserve open/unconnected pins without generating empty net ids.
                signal_name = f"__open__:{instance.name}.{child_port}"

            pin_id = instance_port_node_id(instance_id, child_port)
            add_node(pin_id, f"{instance.name}.{child_port}", "port")
            add_edge(instance_id, pin_id, "hierarchy")

            if signal_name not in known_nets:
                # Connections may reference names that were not explicitly declared
                # (for example, implicit nets or parser-limited cases).
                implicit_net_id = net_node_id(module_path_id, signal_name)
                add_node(implicit_net_id, signal_name, "net")
                add_edge(module_node_id(module_path_id), implicit_net_id, "hierarchy")
                known_nets.add(signal_name)

            add_edge(net_node_id(module_path_id, signal_name), pin_id, "signal")

    def walk(module_name: str, module_path_id: str, active_modules: set[str]) -> None:
        module_def = module_lookup.get(module_name)
        module_id = module_node_id(module_path_id)
        add_node(module_id, module_name, "module")

        if module_def is None:
            return

        known_nets = add_module_interface_nodes(module_def, module_id, module_path_id)

        if module_name in active_modules:
            return

        next_active = set(active_modules)
        next_active.add(module_name)

        for instance in sorted(module_def.instances, key=lambda i: i.name):
            inst_id = instance_node_id(module_path_id, instance.name)
            add_node(inst_id, f"{instance.name}: {instance.module_name}", "instance")
            add_edge(module_id, inst_id, "hierarchy")

            connect_instance_pins(module_path_id, instance, inst_id, known_nets)

            child_path_id = f"{module_path_id}/{instance.name}:{instance.module_name}"
            child_module_id = module_node_id(child_path_id)
            add_node(child_module_id, instance.module_name, "module")
            add_edge(inst_id, child_module_id, "hierarchy")

            if instance.module_name in module_lookup:
                walk(instance.module_name, child_path_id, next_active)

    walk(top_module, top_module, set())

    return {
        "schema_version": GRAPH_SCHEMA_VERSION,
        "top_module": top_module,
        "nodes": nodes,
        "edges": edges,
    }











