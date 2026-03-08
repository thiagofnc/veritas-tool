"""Build a stable node/edge graph for hierarchy and signal visualization."""

from typing import Any

try:
    from app.models import Instance, ModuleDef, Project
except ImportError:  # Supports running as: python app/main.py
    from models import Instance, ModuleDef, Project


GRAPH_SCHEMA_VERSION = "1.0"


def build_hierarchy_graph(project: Project, top_module: str) -> dict[str, Any]:
    """Build a stable graph schema with module/instance/port/net nodes.

    Node shape: {id, label, kind}
    Edge shape: {source, target, kind}

    Edge kinds:
    - hierarchy: ownership/structure links (module->instance, module->port, etc.)
    - signal: wiring links (net->port, port->net)
    """
    module_lookup: dict[str, ModuleDef] = {}
    for module in project.modules:
        # Keep first definition if duplicates exist.
        module_lookup.setdefault(module.name, module)

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
