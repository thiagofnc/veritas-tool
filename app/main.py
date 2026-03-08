"""CLI entry point for rtl_arch_visualizer."""

import argparse

try:
    from app.scanner import scan_verilog_files
except ImportError:  # Supports running as: python app/main.py
    from scanner import scan_verilog_files


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="rtl_arch_visualizer",
        description="Simple backend MVP for Verilog/SystemVerilog project scanning.",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    scan_parser = subparsers.add_parser("scan", help="Recursively scan for Verilog files")
    scan_parser.add_argument(
        "root_path",
        nargs="?",
        default=".",
        help="Root directory to scan (default: current directory).",
    )

    return parser


def run_scan(root_path: str) -> int:
    files = scan_verilog_files(root_path)
    print(f"Found {len(files)} Verilog/SystemVerilog file(s):")

    if not files:
        print("  (none)")
        return 0

    for index, file_path in enumerate(files, start=1):
        print(f"  {index:>3}. {file_path}")

    return 0


def main() -> int:
    args = build_arg_parser().parse_args()

    if args.command == "scan":
        return run_scan(args.root_path)

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
