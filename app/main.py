"""CLI entry point for rtl_arch_visualizer."""

import argparse
import json

try:
    from app.graph_builder import build_hierarchy_graph
    from app.hierarchy import build_hierarchy_tree, infer_top_modules
    from app.json_exporter import save_project_json
    from app.models import ModuleDef
    from app.scanner import scan_verilog_files
    from app.simple_parser import SimpleRegexParser
except ImportError:  # Supports running as: python app/main.py
    from graph_builder import build_hierarchy_graph
    from hierarchy import build_hierarchy_tree, infer_top_modules
    from json_exporter import save_project_json
    from models import ModuleDef
    from scanner import scan_verilog_files
    from simple_parser import SimpleRegexParser


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rtl_arch_visualizer",
        description="Simple backend MVP for Verilog/SystemVerilog project scanning.",
    )

    # Subcommands keep room for future actions (parse/export/visualize).
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
        help="Print simple hierarchy graph JSON when a single top module is inferred.",
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


def _print_possible_tops(modules: list[ModuleDef]) -> list[str]:
    top_modules = infer_top_modules(modules)
    print("Possible top modules (testbench-filtered):")

    if not top_modules:
        print("  (none)")
        return top_modules

    for module_name in top_modules:
        print(f"  - {module_name}")

    return top_modules


def run_scan(root_path: str, output_path: str | None = None, print_graph: bool = False) -> int:
    """Scan files, run the simple parser, and print a readable summary."""
    file_paths = scan_verilog_files(root_path)
    project = SimpleRegexParser().parse_files(file_paths)

    print("Scan Summary")
    print(f"Files found: {len(file_paths)}")
    print(f"Modules found: {len(project.modules)}")
    print("Modules:")

    if not project.modules:
        print("  (none)")
    else:
        for module in project.modules:
            _print_module_details(module)

    top_modules = _print_possible_tops(project.modules)

    if len(top_modules) == 1:
        chosen_top = top_modules[0]
        hierarchy_tree = build_hierarchy_tree(project.modules, chosen_top)
        print(f"Hierarchy tree ({chosen_top}):")
        print(json.dumps(hierarchy_tree, indent=2))

        if print_graph:
            graph = build_hierarchy_graph(project, chosen_top)
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

    # Dispatch to the selected subcommand.
    if args.command == "scan":
        return run_scan(args.root_path, args.output_path, args.print_graph)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
