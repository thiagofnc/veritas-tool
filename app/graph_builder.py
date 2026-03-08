"""Build a very simple node/edge graph from parsed module hierarchy."""

from typing import Any

try:
    from app.models import ModuleDef, Project
except ImportError:  # Supports running as: python app/main.py
    from models import ModuleDef, Project


def build_hierarchy_graph(project: Project, top_module: str) -> dict[str, list[dict[str, Any]]]:
    """Build a minimal graph with module/instance nodes and hierarchy edges."""
    module_lookup: dict[str, ModuleDef] = {}
    for module in project.modules:
        # Keep first definition if duplicates exist.
        module_lookup.setdefault(module.name, module)

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    seen_node_ids: set[str] = set()

    def add_node(node_id: str, label: str, kind: str) -> None:
        if node_id in seen_node_ids:
            return
        seen_node_ids.add(node_id)
        nodes.append({"id": node_id, "label": label, "kind": kind})

    add_node(top_module, top_module, "module")

    def walk(module_name: str, parent_node_id: str, active_path: set[str]) -> None:
        if module_name in active_path:
            return

        module_def = module_lookup.get(module_name)
        if module_def is None:
            return

        next_path = set(active_path)
        next_path.add(module_name)

        for instance in module_def.instances:
            instance_id = f"{parent_node_id}/{instance.name}"
            instance_label = f"{instance.name}: {instance.module_name}"
            add_node(instance_id, instance_label, "instance")
            edges.append({"source": parent_node_id, "target": instance_id, "kind": "hierarchy"})

            if instance.module_name in module_lookup:
                walk(instance.module_name, instance_id, next_path)

    walk(top_module, top_module, set())

    return {"nodes": nodes, "edges": edges}
