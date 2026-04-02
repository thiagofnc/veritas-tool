"""Schematic-specific layout engine for readable digital block diagrams."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Any

try:
    from app.graph_builder import build_module_connectivity_graph
    from app.models import ModuleDef, Project
except ImportError:  # Supports running as: python app/main.py
    from graph_builder import build_module_connectivity_graph
    from models import ModuleDef, Project


SCHEMATIC_SCHEMA_VERSION = "1.2-connectivity"
GRID = 20


@dataclass
class _Block:
    node_id: str
    label: str
    kind: str
    region: str
    layer: int = 0
    order: int = 0
    x: int = 0
    y: int = 0
    width: int = 0
    height: int = 0
    instance_name: str | None = None
    module_name: str | None = None
    direction: str | None = None


def _snap(value: float) -> int:
    return int(round(value / GRID) * GRID)


def _module_lookup(project: Project) -> dict[str, ModuleDef]:
    return {module.name: module for module in project.modules}


def _normalize(text: str | None) -> str:
    return (text or "").strip().lower().replace("-", "_")


def _classify_region(node: dict[str, Any], module_def: ModuleDef | None) -> str:
    if node.get("kind") == "module_io":
        direction = _normalize(node.get("direction"))
        return "input_interface" if direction == "input" else "output_interface"

    tokens = " ".join(
        [
            _normalize(node.get("instance_name")),
            _normalize(node.get("module_name")),
            _normalize(node.get("label")),
            " ".join(_normalize(port.name) for port in (module_def.ports if module_def else [])),
        ]
    )

    if any(word in tokens for word in ("clk", "clock", "rst", "reset", "sched", "ctrl", "control", "decode", "router", "arb", "status")):
        return "decode_control"
    if any(word in tokens for word in ("reg", "state", "fifo", "buffer", "counter", "latch")):
        return "registers"
    if any(word in tokens for word in ("ram", "rom", "mem", "spi", "uart", "i2c", "axi", "adc", "bridge", "iface", "interface", "bus")):
        return "memory_interface"
    if any(word in tokens for word in ("alu", "data", "packet", "crc", "mux", "filter", "frontend", "sample", "frame", "sensor")):
        return "alu_datapath"
    return "logic"


def _region_title(region: str) -> str:
    return {
        "input_interface": "Input Interface",
        "decode_control": "Decode / Control",
        "alu_datapath": "ALU / Datapath",
        "registers": "Registers / State",
        "memory_interface": "Memory / Interface",
        "output_interface": "Output Interface",
        "logic": "Logic",
    }.get(region, "Logic")


def _tarjan_scc(nodes: list[str], edges: dict[str, set[str]]) -> list[list[str]]:
    index = 0
    stack: list[str] = []
    on_stack: set[str] = set()
    index_by: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    components: list[list[str]] = []

    def visit(node_id: str) -> None:
        nonlocal index
        index_by[node_id] = index
        lowlink[node_id] = index
        index += 1
        stack.append(node_id)
        on_stack.add(node_id)

        for target in edges.get(node_id, set()):
            if target not in index_by:
                visit(target)
                lowlink[node_id] = min(lowlink[node_id], lowlink[target])
            elif target in on_stack:
                lowlink[node_id] = min(lowlink[node_id], index_by[target])

        if lowlink[node_id] != index_by[node_id]:
            return

        component: list[str] = []
        while stack:
            current = stack.pop()
            on_stack.discard(current)
            component.append(current)
            if current == node_id:
                break
        components.append(component)

    for node_id in nodes:
        if node_id not in index_by:
            visit(node_id)

    return components


def _port_role(port_name: str, is_bus: bool) -> tuple[int, str]:
    name = _normalize(port_name)
    if any(word in name for word in ("clk", "clock")):
        return (0, name)
    if any(word in name for word in ("rst", "reset", "clear")):
        return (1, name)
    if any(word in name for word in ("en", "enable", "start", "valid", "ready", "busy")):
        return (2, name)
    if is_bus:
        return (3, name)
    return (4, name)


def _expand_port_nodes(graph: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    by_parent: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for node in graph["nodes"]:
        if node.get("kind") not in {"instance_port", "process_port"}:
            continue
        parent_id = node.get("parent_node_id") or node.get("instance_node_id") or node.get("process_node_id")
        if parent_id:
            by_parent[str(parent_id)].append(node)
    return by_parent


def _block_edge_endpoints(node_map: dict[str, dict[str, Any]], edge: dict[str, Any]) -> tuple[str | None, str | None]:
    def to_block(node_id: str) -> str | None:
        node = node_map.get(node_id)
        if node is None:
            return None
        if node.get("kind") in {"instance_port", "process_port"}:
            return node.get("parent_node_id") or node.get("instance_node_id") or node.get("process_node_id")
        return node_id

    return (to_block(edge["source"]), to_block(edge["target"]))


def _compute_layers(
    blocks: dict[str, _Block],
    node_map: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
) -> dict[str, int]:
    layout_ids = [block_id for block_id, block in blocks.items() if block.kind in {"instance", "gate", "assign", "always"}]
    adjacency: dict[str, set[str]] = {block_id: set() for block_id in layout_ids}

    for edge in edges:
        source_id, target_id = _block_edge_endpoints(node_map, edge)
        if not source_id or not target_id or source_id == target_id:
            continue
        if source_id not in adjacency or target_id not in adjacency:
            continue
        adjacency[source_id].add(target_id)

    components = _tarjan_scc(layout_ids, adjacency)
    component_by_node: dict[str, int] = {}
    for index, component in enumerate(components):
        for node_id in component:
            component_by_node[node_id] = index

    dag_edges: dict[int, set[int]] = {index: set() for index in range(len(components))}
    indegree: dict[int, int] = {index: 0 for index in range(len(components))}
    for source_id, targets in adjacency.items():
        for target_id in targets:
            left = component_by_node[source_id]
            right = component_by_node[target_id]
            if left == right or right in dag_edges[left]:
                continue
            dag_edges[left].add(right)
            indegree[right] += 1

    level_by_component: dict[int, int] = {index: 0 for index in dag_edges}
    queue = sorted(index for index, value in indegree.items() if value == 0)
    while queue:
        current = queue.pop(0)
        for target in sorted(dag_edges[current]):
            level_by_component[target] = max(level_by_component[target], level_by_component[current] + 1)
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
                queue.sort()

    for component_index, component in enumerate(components):
        component_level = level_by_component.get(component_index, 0)
        for node_id in component:
            blocks[node_id].layer = component_level

    return {node_id: block.layer for node_id, block in blocks.items()}


def _order_layers(
    blocks: dict[str, _Block],
    node_map: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
) -> dict[int, list[str]]:
    incoming: dict[str, set[str]] = defaultdict(set)
    outgoing: dict[str, set[str]] = defaultdict(set)
    grouped: dict[int, list[str]] = defaultdict(list)

    for block_id, block in blocks.items():
        if block.kind in {"instance", "gate", "assign", "always"}:
            grouped[block.layer].append(block_id)

    for edge in edges:
        source_id, target_id = _block_edge_endpoints(node_map, edge)
        if not source_id or not target_id or source_id == target_id:
            continue
        if source_id not in blocks or target_id not in blocks:
            continue
        incoming[target_id].add(source_id)
        outgoing[source_id].add(target_id)

    order_index: dict[str, int] = {}
    for layer in sorted(grouped):
        grouped[layer].sort(key=lambda node_id: (blocks[node_id].region, blocks[node_id].label.lower(), node_id))
        for index, node_id in enumerate(grouped[layer]):
            order_index[node_id] = index

    def score(node_id: str, neighbors: set[str], compare_layer: int, prefer_incoming: bool) -> float | None:
        values = []
        for neighbor_id in neighbors:
            neighbor = blocks.get(neighbor_id)
            if neighbor is None:
                continue
            if prefer_incoming and neighbor.layer >= compare_layer:
                continue
            if not prefer_incoming and neighbor.layer <= compare_layer:
                continue
            if neighbor_id in order_index:
                values.append(order_index[neighbor_id])
        if not values:
            return None
        return sum(values) / len(values)

    for _ in range(4):
        for layer in sorted(grouped):
            grouped[layer].sort(
                key=lambda node_id: (
                    score(node_id, incoming.get(node_id, set()), layer, True) is None,
                    score(node_id, incoming.get(node_id, set()), layer, True) or 0.0,
                    blocks[node_id].region,
                    blocks[node_id].label.lower(),
                )
            )
            for index, node_id in enumerate(grouped[layer]):
                order_index[node_id] = index

        for layer in sorted(grouped, reverse=True):
            grouped[layer].sort(
                key=lambda node_id: (
                    score(node_id, outgoing.get(node_id, set()), layer, False) is None,
                    score(node_id, outgoing.get(node_id, set()), layer, False) or 0.0,
                    blocks[node_id].region,
                    blocks[node_id].label.lower(),
                )
            )
            for index, node_id in enumerate(grouped[layer]):
                order_index[node_id] = index

    return dict(grouped)


def _assign_block_geometry(
    blocks: dict[str, _Block],
    grouped_layers: dict[int, list[str]],
    ports_by_instance: dict[str, list[dict[str, Any]]],
) -> tuple[int, int]:
    column_gap = 300
    row_gap = 160
    origin_x = 320
    origin_y = 140
    max_y = origin_y

    for block in blocks.values():
        if block.kind == "module_io":
            block.width = 140 if block.direction == "output" else 130
            block.height = 38
            continue
        side_counts = {"input": 0, "output": 0}
        for port in ports_by_instance.get(block.node_id, []):
            direction = _normalize(port.get("direction")) or "input"
            if direction != "output":
                direction = "input"
            side_counts[direction] += 1
        max_side = max(side_counts.values() or [0])
        block.width = 220
        block.height = max(84, 54 + max_side * 24)

    for layer, node_ids in sorted(grouped_layers.items()):
        x = origin_x + layer * column_gap
        for order, node_id in enumerate(node_ids):
            block = blocks[node_id]
            block.order = order
            block.x = _snap(x)
            block.y = _snap(origin_y + order * row_gap)
            max_y = max(max_y, block.y + block.height)

    input_nodes = [block for block in blocks.values() if block.kind == "module_io" and block.direction == "input"]
    output_nodes = [block for block in blocks.values() if block.kind == "module_io" and block.direction == "output"]
    input_nodes.sort(key=lambda block: (block.region, block.label.lower()))
    output_nodes.sort(key=lambda block: (block.region, block.label.lower()))

    for index, block in enumerate(input_nodes):
        block.x = 100
        block.y = _snap(origin_y + index * 100)
        max_y = max(max_y, block.y + block.height)

    max_layer = max(grouped_layers.keys(), default=0)
    output_x = origin_x + (max_layer + 1) * column_gap + 80
    for index, block in enumerate(output_nodes):
        block.x = _snap(output_x)
        block.y = _snap(origin_y + index * 100)
        max_y = max(max_y, block.y + block.height)

    canvas_width = _snap(output_x + 220)
    canvas_height = _snap(max_y + 180)
    return (canvas_width, canvas_height)


def _build_port_layout(
    graph: dict[str, Any],
    blocks: dict[str, _Block],
    ports_by_instance: dict[str, list[dict[str, Any]]],
) -> dict[str, dict[str, Any]]:
    layout_by_port: dict[str, dict[str, Any]] = {}
    node_map = {node["id"]: node for node in graph["nodes"]}

    for instance_id, ports in ports_by_instance.items():
        block = blocks.get(instance_id)
        if block is None:
            continue

        left_ports = [port for port in ports if _normalize(port.get("direction")) not in {"output"}]
        right_ports = [port for port in ports if _normalize(port.get("direction")) == "output"]
        left_ports.sort(key=lambda port: _port_role(str(port.get("port_name", "")), bool(port.get("is_bus"))))
        right_ports.sort(key=lambda port: _port_role(str(port.get("port_name", "")), bool(port.get("is_bus"))))

        def place_side(items: list[dict[str, Any]], side: str) -> None:
            if not items:
                return
            top = block.y - block.height / 2 + 28
            step = max(20, (block.height - 56) / max(1, len(items) - 1)) if len(items) > 1 else 0
            for index, port in enumerate(items):
                y = _snap(top + index * step)
                x = block.x - block.width / 2 if side == "left" else block.x + block.width / 2
                layout_by_port[port["id"]] = {
                    "id": port["id"],
                    "kind": port.get("kind") or "instance_port",
                    "parent_id": instance_id,
                    "x": _snap(x),
                    "y": y,
                    "side": side,
                    "label": port.get("port_name") or port.get("label") or "",
                    "label_visible": len(items) <= 10 or bool(port.get("is_bus")) or _port_role(str(port.get("port_name", "")), bool(port.get("is_bus")))[0] <= 2,
                    "direction": port.get("direction") or "unknown",
                    "is_bus": bool(port.get("is_bus")),
                    "bit_width": port.get("bit_width"),
                }

        place_side(left_ports, "left")
        place_side(right_ports, "right")

    for block in blocks.values():
        if block.kind != "module_io":
            continue
        side = "left" if block.direction == "input" else "right"
        layout_by_port[block.node_id] = {
            "id": block.node_id,
            "kind": "module_io",
            "x": block.x,
            "y": block.y,
            "side": side,
            "label": block.label,
            "label_visible": True,
            "direction": block.direction or "unknown",
            "is_bus": bool(node_map.get(block.node_id, {}).get("is_bus")),
            "bit_width": node_map.get(block.node_id, {}).get("bit_width"),
            "width": block.width,
            "height": block.height,
        }

    # Internal logic nodes (gate, assign, always) can appear as edge endpoints.
    _LOGIC_KINDS = {"gate", "assign", "always"}
    for block in blocks.values():
        if block.kind not in _LOGIC_KINDS:
            continue
        if block.node_id in layout_by_port:
            continue
        layout_by_port[block.node_id] = {
            "id": block.node_id,
            "kind": block.kind,
            "x": block.x,
            "y": block.y,
            "side": "left",
            "label": block.label,
            "label_visible": True,
            "direction": "unknown",
            "is_bus": False,
            "bit_width": None,
            "width": block.width,
            "height": block.height,
        }

    # always_assign children: place at their parent always block's position.
    for node in graph["nodes"]:
        if node.get("kind") != "process_port":
            continue
        if node["id"] in layout_by_port:
            continue
        parent_id = node.get("parent_node_id") or node.get("process_node_id") or ""
        parent_block = blocks.get(parent_id)
        px = parent_block.x if parent_block else 0
        py = parent_block.y if parent_block else 0
        layout_by_port[node["id"]] = {
            "id": node["id"],
            "kind": "process_port",
            "x": px,
            "y": py,
            "side": "left",
            "label": node.get("label", ""),
            "label_visible": True,
            "direction": "unknown",
            "is_bus": False,
            "bit_width": None,
            "width": 16,
            "height": 16,
        }

    return layout_by_port


def _endpoint_point(port_layout: dict[str, dict[str, Any]], endpoint_id: str) -> tuple[int, int]:
    port = port_layout[endpoint_id]
    if port["kind"] == "module_io":
        return (port["x"] + (port["width"] // 2 if port["side"] == "left" else -(port["width"] // 2)), port["y"])
    offset = -18 if port["side"] == "left" else 18
    return (port["x"] + offset, port["y"])


def _route_metrics(polylines: list[list[dict[str, int]]], block_boxes: list[tuple[int, int, int, int]]) -> dict[str, int]:
    segments: list[tuple[tuple[int, int], tuple[int, int]]] = []
    bends = 0
    for polyline in polylines:
        if len(polyline) > 2:
            bends += len(polyline) - 2
        for start, end in zip(polyline, polyline[1:]):
            segments.append(((start["x"], start["y"]), (end["x"], end["y"])))

    crossings = 0
    for left_index, left in enumerate(segments):
        for right in segments[left_index + 1 :]:
            (x1, y1), (x2, y2) = left
            (x3, y3), (x4, y4) = right
            if x1 == x2 and y3 == y4:
                if min(y1, y2) < y3 < max(y1, y2) and min(x3, x4) < x1 < max(x3, x4):
                    crossings += 1
            elif y1 == y2 and x3 == x4:
                if min(x1, x2) < x3 < max(x1, x2) and min(y3, y4) < y1 < max(y3, y4):
                    crossings += 1

    overlaps = 0
    for start, end in segments:
        if start[0] == end[0]:
            x = start[0]
            top = min(start[1], end[1])
            bottom = max(start[1], end[1])
            for left, top_box, right, bottom_box in block_boxes:
                if left < x < right and top < bottom_box and bottom > top_box:
                    overlaps += 1
        elif start[1] == end[1]:
            y = start[1]
            left_seg = min(start[0], end[0])
            right_seg = max(start[0], end[0])
            for left, top_box, right, bottom_box in block_boxes:
                if top_box < y < bottom_box and left_seg < right and right_seg > left:
                    overlaps += 1

    return {"crossings": crossings, "bends": bends, "overlaps": overlaps}


def _build_routes(
    edges: list[dict[str, Any]],
    port_layout: dict[str, dict[str, Any]],
    blocks: dict[str, _Block],
    mode: str,
    canvas_height: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    grouped: dict[str, dict[str, Any]] = {}
    for edge in edges:
        net_name = str(edge.get("net") or edge.get("signal_name") or f"edge:{edge['source']}:{edge['target']}")
        group = grouped.setdefault(
            net_name,
            {
                "net": net_name,
                "sig_class": edge.get("sig_class", "wire"),
                "bit_width": edge.get("bit_width"),
                "sources": [],
                "sinks": [],
            },
        )
        if edge["source"] not in group["sources"]:
            group["sources"].append(edge["source"])
        if edge["target"] not in group["sinks"]:
            group["sinks"].append(edge["target"])

    routes: list[dict[str, Any]] = []
    top_lane = 60
    bottom_lane = canvas_height - 80
    center_lane = 120
    bus_lane = 160
    top_gap = 24
    center_gap = 28
    bottom_gap = 26
    top_index = 0
    center_index = 0
    bus_index = 0
    bottom_index = 0
    all_polylines: list[list[dict[str, int]]] = []

    for index, (_, group) in enumerate(sorted(grouped.items())):
        source_id = group["sources"][0]
        source_point = _endpoint_point(port_layout, source_id)
        sink_points = [(sink_id, _endpoint_point(port_layout, sink_id)) for sink_id in group["sinks"]]
        sink_points.sort(key=lambda item: (item[1][1], item[0]))

        label = group["net"]
        sig_class = group["sig_class"]
        bit_width = group.get("bit_width") or 1
        is_bus = bit_width > 1
        is_control = any(word in _normalize(label) for word in ("clk", "clock", "rst", "reset", "start", "enable", "valid", "ready", "busy"))
        source_block_x = source_point[0]
        target_xs = [point[0] for _, point in sink_points] or [source_block_x]
        far_x = max(target_xs + [source_block_x])
        back_edge = any(point[0] < source_block_x for _, point in sink_points)
        long_span = abs(far_x - source_block_x) > 520
        fanout = len(sink_points)
        collapse = long_span or back_edge or (fanout > 3 and is_control)

        important_control = any(word in _normalize(label) for word in ("clk", "clock", "rst", "reset", "start", "busy", "valid", "ready"))
        if mode == "simplified" and not (is_bus or fanout > 1 or important_control):
            continue
        if mode == "bus" and not is_bus:
            continue

        route: dict[str, Any] = {
            "id": f"route:{index}",
            "net": label,
            "label": label if fanout == 1 or is_bus or is_control else f"{label} x{fanout}",
            "sig_class": sig_class,
            "bit_width": group.get("bit_width"),
            "style_role": "control" if is_control else "bus" if is_bus else "wire",
            "collapsed": collapse,
            "polylines": [],
            "junctions": [],
            "labels": [],
            "sources": group["sources"],
            "sinks": group["sinks"],
        }

        if collapse:
            route["labels"].append({"x": source_point[0] + 14, "y": source_point[1] - 10, "text": label})
            for sink_id, sink_point in sink_points:
                source_stub = {"x": source_point[0] + 28, "y": source_point[1]}
                sink_stub = {"x": sink_point[0] - 28, "y": sink_point[1]}
                route["polylines"].append(
                    [
                        {"x": source_point[0], "y": source_point[1]},
                        source_stub,
                    ]
                )
                route["polylines"].append(
                    [
                        sink_stub,
                        {"x": sink_point[0], "y": sink_point[1]},
                    ]
                )
                route["labels"].append({"x": sink_stub["x"] - 8, "y": sink_stub["y"] - 10, "text": label})
            routes.append(route)
            all_polylines.extend(route["polylines"])
            continue

        if is_control:
            lane_y = top_lane + top_index * top_gap
            top_index += 1
        elif back_edge:
            lane_y = bottom_lane - bottom_index * bottom_gap
            bottom_index += 1
        elif is_bus:
            lane_y = bus_lane + bus_index * center_gap
            bus_index += 1
        else:
            preferred_y = sum(point[1] for _, point in sink_points) / max(1, len(sink_points))
            lane_y = max(center_lane + center_index * center_gap, _snap(preferred_y))
            center_index += 1

        trunk_start_x = _snap(source_point[0] + 36)
        trunk_end_x = _snap(max(point[0] for _, point in sink_points) - 32) if sink_points else trunk_start_x + 40
        trunk = [{"x": trunk_start_x, "y": _snap(lane_y)}, {"x": max(trunk_start_x + 20, trunk_end_x), "y": _snap(lane_y)}]

        source_polyline = [
            {"x": source_point[0], "y": source_point[1]},
            {"x": trunk_start_x, "y": source_point[1]},
            {"x": trunk_start_x, "y": _snap(lane_y)},
        ]
        route["polylines"].append(source_polyline)
        route["polylines"].append(trunk)
        route["labels"].append({"x": trunk_start_x + 10, "y": _snap(lane_y) - 10, "text": route["label"]})

        for sink_id, sink_point in sink_points:
            junction_x = _snap(sink_point[0] - 28)
            junction = {"x": junction_x, "y": _snap(lane_y)}
            route["junctions"].append(junction)
            route["polylines"].append(
                [
                    {"x": junction_x, "y": _snap(lane_y)},
                    {"x": junction_x, "y": sink_point[1]},
                    {"x": sink_point[0], "y": sink_point[1]},
                ]
            )

        routes.append(route)
        all_polylines.extend(route["polylines"])

    block_boxes = [
        (
            block.x - block.width // 2,
            block.y - block.height // 2,
            block.x + block.width // 2,
            block.y + block.height // 2,
        )
        for block in blocks.values()
    ]
    schematic_metrics = _route_metrics(all_polylines, block_boxes)

    baseline_polylines: list[list[dict[str, int]]] = []
    for edge in edges:
        source_point = _endpoint_point(port_layout, edge["source"])
        target_point = _endpoint_point(port_layout, edge["target"])
        mid_x = _snap((source_point[0] + target_point[0]) / 2)
        baseline_polylines.append(
            [
                {"x": source_point[0], "y": source_point[1]},
                {"x": mid_x, "y": source_point[1]},
                {"x": mid_x, "y": target_point[1]},
                {"x": target_point[0], "y": target_point[1]},
            ]
        )
    baseline_metrics = _route_metrics(baseline_polylines, block_boxes)
    return (
        routes,
        {
            "baseline": baseline_metrics,
            "schematic": schematic_metrics,
            "improvement": {
                "crossings_reduced_by": baseline_metrics["crossings"] - schematic_metrics["crossings"],
                "bends_reduced_by": baseline_metrics["bends"] - schematic_metrics["bends"],
                "overlaps_reduced_by": baseline_metrics["overlaps"] - schematic_metrics["overlaps"],
            },
        },
    )


def build_schematic_connectivity_graph(project: Project, module_name: str, schematic_mode: str = "full") -> dict[str, Any]:
    if schematic_mode not in {"full", "simplified", "bus"}:
        raise ValueError("Unsupported schematic mode. Use 'full', 'simplified', or 'bus'.")

    graph = build_module_connectivity_graph(project, module_name, mode="compact", aggregate_edges=False, port_view=True)
    module_defs = _module_lookup(project)
    ports_by_instance = _expand_port_nodes(graph)
    node_map = {node["id"]: node for node in graph["nodes"]}

    blocks: dict[str, _Block] = {}
    for node in graph["nodes"]:
        if node.get("kind") in ("instance_port", "process_port"):
            continue
        module_def = module_defs.get(str(node.get("module_name")))
        block = _Block(
            node_id=node["id"],
            label=str(node.get("label") or node.get("port_name") or node["id"]),
            kind=str(node.get("kind", "unknown")),
            region=_classify_region(node, module_def),
            instance_name=node.get("instance_name"),
            module_name=node.get("module_name"),
            direction=node.get("direction"),
        )
        blocks[node["id"]] = block

    _compute_layers(blocks, node_map, graph["edges"])
    grouped_layers = _order_layers(blocks, node_map, graph["edges"])
    canvas_width, canvas_height = _assign_block_geometry(blocks, grouped_layers, ports_by_instance)
    port_layout = _build_port_layout(graph, blocks, ports_by_instance)
    routes, metrics = _build_routes(graph["edges"], port_layout, blocks, schematic_mode, canvas_height)

    regions: list[dict[str, Any]] = []
    blocks_by_region: dict[str, list[_Block]] = defaultdict(list)
    for block in blocks.values():
        blocks_by_region[block.region].append(block)

    for region, members in sorted(blocks_by_region.items()):
        left = min(member.x - member.width / 2 for member in members) - 50
        right = max(member.x + member.width / 2 for member in members) + 50
        top = min(member.y - member.height / 2 for member in members) - 60
        bottom = max(member.y + member.height / 2 for member in members) + 50
        regions.append(
            {
                "id": f"region:{region}",
                "role": region,
                "label": _region_title(region),
                "x": _snap((left + right) / 2),
                "y": _snap((top + bottom) / 2),
                "width": _snap(right - left),
                "height": _snap(bottom - top),
            }
        )

    layout_nodes: list[dict[str, Any]] = []
    for block in sorted(blocks.values(), key=lambda item: (item.kind, item.layer, item.order, item.label)):
        layout_nodes.append(
            {
                "id": block.node_id,
                "kind": block.kind,
                "label": block.label,
                "region_id": f"region:{block.region}",
                "layer": block.layer,
                "x": block.x,
                "y": block.y,
                "width": block.width,
                "height": block.height,
                "instance_name": block.instance_name,
                "module_name": block.module_name,
                "direction": block.direction,
            }
        )

    layout_ports = sorted(port_layout.values(), key=lambda item: (item["kind"], item["id"]))
    dense_threshold = 12
    crowded_regions = [region for region, members in blocks_by_region.items() if len(members) >= dense_threshold]
    hierarchical = len([block for block in blocks.values() if block.kind == "instance"]) >= dense_threshold

    return {
        **graph,
        "schema_version": SCHEMATIC_SCHEMA_VERSION,
        "view": "schematic",
        "schematic_mode": schematic_mode,
        "layout": {
            "engine": "schematic-v2",
            "canvas": {
                "width": canvas_width,
                "height": canvas_height,
                "grid": GRID,
                "hierarchical": hierarchical,
                "crowded_regions": crowded_regions,
            },
            "regions": regions,
            "nodes": layout_nodes,
            "ports": layout_ports,
            "routes": routes,
            "metrics": metrics,
        },
    }

