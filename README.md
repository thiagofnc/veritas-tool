# rtl_arch_visualizer

## Naming

Still deciding on the final project name: Verilogix, Silica, Verilium, Synthium, or ArchRTL.

Backend-only MVP for scanning and lightly parsing Verilog/SystemVerilog projects.

## Current MVP Capabilities

- Recursively scan a folder for visible `.v` and `.sv` files
- Skip hidden files and hidden folders
- Parse simple module definitions with a regex-based parser
- Extract:
  - module names
  - simple header ports (`input/output/inout`, optional width)
  - simple instances like `child_mod u1 (...);`
- Print a readable CLI summary
- Optionally export parsed project data to JSON

## Project Structure

- `app/main.py` - CLI entry point and summary output
- `app/scanner.py` - file discovery and folder traversal
- `app/simple_parser.py` - simple regex parser backend
- `app/parser_base.py` - parser backend interface
- `app/models.py` - dataclasses (`Project`, `ModuleDef`, etc.)
- `app/json_exporter.py` - dataclass-to-dict conversion and JSON save
- `tests/test_scanner.py` - scanner unit test

## Requirements

- Python 3.10+

## How To Run

From the project root:

```bash
python -m app.main scan ./example_project
```

With JSON output:

```bash
python -m app.main scan ./example_project --out out/project.json
```

## How To Test

1. Run unit tests:

```bash
python -m unittest discover -s tests -p "test_*.py"
```

2. Run scan summary on your real project folder:

```bash
python -m app.main scan "C:\Users\costatf\OneDrive - Rose-Hulman Institute of Technology\Desktop\pipelined-processor-l2-2526a-05"
```

3. Run scan + JSON export:

```bash
python -m app.main scan "C:\Users\costatf\OneDrive - Rose-Hulman Institute of Technology\Desktop\pipelined-processor-l2-2526a-05" --out out/project.json
```

4. (Optional) Save CLI summary to a text file:

```bash
python -m app.main scan "C:\Users\costatf\OneDrive - Rose-Hulman Institute of Technology\Desktop\pipelined-processor-l2-2526a-05" > scan_summary.txt
```

## Notes and Limitations

- The parser is intentionally approximate and not a full Verilog parser.
- Complex syntax may be missed or produce false positives (especially in testbench code).
