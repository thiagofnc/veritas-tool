# rtl_arch_visualizer

## Naming

Still deciding on the final project name: Verilogix, Silica, Verilium, or ArchRTL.

Backend-only MVP for scanning and structurally parsing Verilog/SystemVerilog projects.

## What It Does Today

- Recursively scans a root folder for visible `.v` and `.sv` files.
- Ignores hidden files and hidden folders.
- Parses files with one of two backends:
  - `pyverilog` (AST-based, better accuracy)
  - `simple` (regex-based fallback)
- Builds an internal project model with:
  - modules
  - ports
  - internal signals/nets (`wire`, `reg`, `logic`)
  - instances
  - pin-level mappings (`child_port -> parent_signal`)
- Infers possible top modules using a simple testbench-aware heuristic.
- Builds a nested hierarchy tree for a chosen top module.
- Optionally prints a simple graph JSON (`nodes` + `edges`) for hierarchy/instance relationships.
- Optionally exports parsed project data to JSON.

## Current CLI

From the project root, replace `C:\path\to\your\verilog-project` with your folder.

```bash
python -m app.main scan "C:\path\to\your\verilog-project"
```

Select parser backend:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog
python -m app.main scan "C:\path\to\your\verilog-project" --parser simple
```

Save parsed project JSON:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --out out/project.json
```

Print graph JSON (only when exactly one top module is inferred):

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --graph
```

Save console output to a text file:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --graph --out out/project_pyverilog.json | Tee-Object -FilePath artifacts/summaries/pyverilog_scan_output.txt
```

## Project Structure

- `app/main.py` - CLI entry point
- `app/scanner.py` - recursive Verilog file discovery
- `app/models.py` - dataclasses (`Project`, `ModuleDef`, `Instance`, `Signal`, `PinConnection`, etc.)
- `app/parser_base.py` - parser backend interface
- `app/simple_parser.py` - lightweight regex parser
- `app/pyverilog_parser.py` - AST parser backend
- `app/hierarchy.py` - top inference and hierarchy tree building
- `app/graph_builder.py` - simple `nodes`/`edges` graph output
- `app/json_exporter.py` - dataclass-to-dict and JSON writing
- `tests/` - unit tests for scanner/parsers/graph
- `out/` - JSON exports from CLI runs
- `artifacts/` - debug/summaries from manual test runs

## Requirements

- Python 3.10+
- For `--parser pyverilog`:

```bash
python -m pip install pyverilog
```

## How To Test

Run unit tests:

```bash
python -m unittest discover -s tests -p "test_*.py"
```

Run full flow on your own project folder:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --graph --out out/project_pyverilog.json
```

## Notes And Limitations

- This is still an MVP parser pipeline, not a full Verilog/SystemVerilog language implementation.
- Some advanced constructs are not fully covered yet.
- Top-module inference is heuristic and may need manual selection in multi-top or test-heavy projects.

## Generated Files

You do not need to commit parser/cache artifacts such as `parsetab.py`, `parser.out`, or `__pycache__/` contents.
A `.gitignore` is included to keep those generated files out of commits.
