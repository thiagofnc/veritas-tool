# rtl_arch_visualizer

## Naming

Still deciding on the final project name: Verilogix, Silica, Verilium, Synthium or ArchRTL.

A very simple backend-only MVP scaffold for analyzing Verilog projects.

## Project Structure

- `app/main.py` - CLI entry point
- `app/scanner.py` - recursively finds `.v` and `.sv` files
- `app/models.py` - lightweight dataclasses for scan output
- `app/parser_base.py` - parser interface + no-op parser
- `app/json_exporter.py` - writes scan results to JSON (for later steps)
- `tests/` - unit tests

## Run Locally

1. Use Python 3.10+.
2. From this project root, run:

```bash
python -m app.main scan ./example_project
```

3. The CLI prints a sorted list of discovered Verilog/SystemVerilog files.


