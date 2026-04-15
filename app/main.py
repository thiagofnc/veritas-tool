"""CLI entry point for rtl_arch_visualizer."""

import argparse
import json

try:
    from app.hierarchy import build_hierarchy_tree
    from app.json_exporter import save_project_json
    from app.models import ModuleDef
    from app.project_service import ProjectService
except ImportError:  # Supports running as: python app/main.py
    from hierarchy import build_hierarchy_tree
    from json_exporter import save_project_json
    from models import ModuleDef
    from project_service import ProjectService


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rtl_arch_visualizer",
        description="Backend CLI for Verilog/SystemVerilog project scanning.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    scan_parser = subparsers.add_parser("scan", help="Scan and parse Verilog files")
    scan_parser.add_argument(
        "root_path",
        nargs="?",
        default=".",
        help="Root directory to scan (default: current directory).",
    )
    scan_parser.add_argument(
        "--out",
        dest="output_path",
        default=None,
        help="Optional JSON output path, e.g. out/project.json",
    )
    scan_parser.add_argument(
        "--graph",
        dest="print_graph",
        action="store_true",
        help="Print hierarchy graph JSON when a single top module is inferred.",
    )

    return parser


def _print_module_details(module: ModuleDef) -> None:
    print(f"  - {module.name}")
    if not module.instances:
        print("      instances: (none)")
        return

    print("      instances:")
    for instance in module.instances:
        print(f"        - {instance.name} ({instance.module_name})")


def _print_possible_tops(top_modules: list[str]) -> None:
    print("Possible top modules (testbench-filtered):")
    if not top_modules:
        print("  (none)")
        return
    for module_name in top_modules:
        print(f"  - {module_name}")


def run_scan(
    root_path: str,
    output_path: str | None = None,
    print_graph: bool = False,
) -> int:
    """Scan files, parse project, and print a readable summary."""
    service = ProjectService()

    try:
        project = service.load_project(root_path)
    except Exception as exc:
        print(f"Failed to load project: {exc}")
        return 2

    print("Scan Summary")
    print("Parser backend: pyverilog")
    print(f"Files found: {len(project.source_files)}")
    print(f"Modules found: {len(project.modules)}")
    print("Modules:")

    if not project.modules:
        print("  (none)")
    else:
        for module in project.modules:
            _print_module_details(module)

    top_modules = service.get_top_candidates()
    _print_possible_tops(top_modules)

    if len(top_modules) == 1:
        chosen_top = top_modules[0]
        hierarchy_tree = build_hierarchy_tree(project.modules, chosen_top)
        print(f"Hierarchy tree ({chosen_top}):")
        print(json.dumps(hierarchy_tree, indent=2))

        if print_graph:
            graph = service.get_module_graph(chosen_top)
            print(f"Graph JSON ({chosen_top}):")
            print(json.dumps(graph, indent=2))
    elif print_graph:
        print("Graph JSON not printed because multiple possible top modules were found.")

    if output_path:
        written_path = save_project_json(project, output_path)
        print(f"JSON saved to: {written_path.resolve()}")

    return 0


def main() -> int:
    args = build_arg_parser().parse_args()
    if args.command == "scan":
        return run_scan(
            root_path=args.root_path,
            output_path=args.output_path,
            print_graph=args.print_graph,
        )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
