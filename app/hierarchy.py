"""Helpers for inferring top modules and building a simple hierarchy tree."""

from pathlib import Path
from typing import Any

try:
    from app.models import ModuleDef
except ImportError:  # Supports running as: python app/main.py
    from models import ModuleDef


def _looks_like_testbench(module: ModuleDef) -> bool:
    """Heuristic filter for common testbench naming patterns."""
    lower_name = module.name.lower()
    file_name = Path(module.source_file).name.lower()

    return (
        lower_name.startswith("tb_")
        or lower_name.endswith("_tb")
        or lower_name.startswith("test_")
        or "testbench" in lower_name
        or file_name.startswith("tb_")
        or "testbench" in file_name
    )


def _count_design_children(module: ModuleDef, project_module_names: set[str]) -> int:
    """Count child instances that point to modules also defined in this project."""
    return sum(1 for inst in module.instances if inst.module_name in project_module_names)


def infer_top_modules(modules: list[ModuleDef], include_testbenches: bool = False) -> list[str]:
    """Infer likely top modules with simple design/testbench heuristics.

    Rules:
    - Start from modules not instantiated by another design module.
    - Ignore testbench parents when deciding whether a module is instantiated.
    - Prefer roots that instantiate at least one project module (avoid isolated leaves).
    """
    module_lookup: dict[str, ModuleDef] = {}
    for module in modules:
        module_lookup.setdefault(module.name, module)

    module_names = set(module_lookup)
    if not module_names:
        return []

    testbench_names = {
        module_name
        for module_name, module in module_lookup.items()
        if _looks_like_testbench(module)
    }

    instantiated_by_any: set[str] = set()
    instantiated_by_design: set[str] = set()

    for module in modules:
        parent_is_testbench = module.name in testbench_names

        for instance in module.instances:
            if instance.module_name not in module_names:
                continue

            # Track all in-project references for the optional "include_testbenches" mode.
            instantiated_by_any.add(instance.module_name)
            # For default mode, treat testbench references as non-architectural.
            if not parent_is_testbench:
                instantiated_by_design.add(instance.module_name)

    if include_testbenches:
        return sorted(module_names - instantiated_by_any)

    # Focus default top inference on design modules and ignore testbench-only roots.
    design_module_names = module_names - testbench_names
    if not design_module_names:
        # If everything looks like testbench code, keep baseline behavior.
        return sorted(module_names - instantiated_by_any)

    # Preferred roots: not instantiated by any non-testbench parent.
    candidate_tops = design_module_names - instantiated_by_design
    if not candidate_tops:
        # Fallback if parsing noise removed too many design edges.
        candidate_tops = design_module_names - instantiated_by_any

    if not candidate_tops:
        # Last-resort fallback: surface design modules rather than returning empty.
        return sorted(design_module_names)

    # If possible, prioritize true integration roots over isolated leaf modules.
    driving_tops = [
        module_name
        for module_name in candidate_tops
        if _count_design_children(module_lookup[module_name], module_names) > 0
    ]

    return sorted(driving_tops or candidate_tops)


def build_hierarchy_tree(modules: list[ModuleDef], top_module: str) -> dict[str, Any]:
    """Build a nested dictionary tree from a selected top module name."""
    module_lookup: dict[str, ModuleDef] = {}
    for module in modules:
        # Keep first definition if duplicates exist; good enough for MVP.
        module_lookup.setdefault(module.name, module)

    def build_node(module_name: str, active_path: set[str]) -> dict[str, Any]:
        # Minimal node shape: module name plus child instance list.
        node: dict[str, Any] = {"module": module_name, "instances": []}

        if module_name in active_path:
            # Stop recursion when a cycle appears in malformed/complex netlists.
            node["cycle"] = True
            return node

        module_def = module_lookup.get(module_name)
        if module_def is None:
            # Mark unresolved references so callers can see missing definitions.
            node["unresolved"] = True
            return node

        next_path = set(active_path)
        next_path.add(module_name)

        children: list[dict[str, Any]] = []
        for instance in module_def.instances:
            child: dict[str, Any] = {
                "instance": instance.name,
                "module": instance.module_name,
            }

            if instance.module_name in module_lookup:
                # Recurse into in-project module definitions.
                child["children"] = build_node(instance.module_name, next_path)
            else:
                # Keep leaf placeholders for external/unparsed module references.
                child["children"] = {
                    "module": instance.module_name,
                    "instances": [],
                    "unresolved": True,
                }

            children.append(child)

        node["instances"] = children
        return node

    return build_node(top_module, set())
