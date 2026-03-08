"""CLI entry point for rtl_arch_visualizer."""

import argparse

try:
    from app.models import ModuleDef
    from app.scanner import scan_verilog_files
    from app.simple_parser import SimpleRegexParser
except ImportError:  # Supports running as: python app/main.py
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

    return parser


def _print_module_details(module: ModuleDef) -> None:
    print(f"  - {module.name}")

    if not module.instances:
        print("      instances: (none)")
        return

    print("      instances:")
    for instance in module.instances:
        print(f"        - {instance.name} ({instance.module_name})")


def run_scan(root_path: str) -> int:
    """Scan files, run the simple parser, and print a readable summary."""
    file_paths = scan_verilog_files(root_path)
    project = SimpleRegexParser().parse_files(file_paths)

    print("Scan Summary")
    print(f"Files found: {len(file_paths)}")
    print(f"Modules found: {len(project.modules)}")
    print("Modules:")

    if not project.modules:
        print("  (none)")
        return 0

    for module in project.modules:
        _print_module_details(module)

    return 0


def main() -> int:
    args = build_arg_parser().parse_args()

    # Dispatch to the selected subcommand.
    if args.command == "scan":
        return run_scan(args.root_path)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
