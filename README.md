# rtl_arch_visualizer

Backend-only MVP for scanning and structurally analyzing Verilog/SystemVerilog projects.

## Naming

Still deciding on the final project name: Verilogix, Silica, Verilium, or ArchRTL.

## Project Goal

The long-term goal is an executable app with an interactive UI that can:

- let a user choose a project folder
- parse project structure reliably
- infer module hierarchy
- visualize modules, instances, ports, and nets
- support click-through architecture exploration

The current codebase is the backend foundation for that UI.

## Current Status (MVP)

What is working today:

- recursive file discovery for `.v` and `.sv`
- two parser backends (`pyverilog` and regex fallback)
- internal model for modules, ports, signals, instances, and pin mappings
- top-module inference with testbench-aware heuristics
- hierarchy-tree generation
- stable graph schema generation for visualization layers
- JSON export of parsed project model

## How The Pipeline Works

The `scan` command runs this flow:

1. **Scanner** (`app/scanner.py`)
   - walks the root folder recursively
   - keeps only `.v` / `.sv`
   - skips hidden files and hidden folders (dotfiles + Windows hidden attribute)
   - returns a sorted path list for deterministic behavior

2. **Parser Backend** (`app/pyverilog_parser.py` or `app/simple_parser.py`)
   - converts file text into structured objects
   - extracts:
     - `ModuleDef`
     - `Port`
     - `Signal` (internal `wire/reg/logic` declarations)
     - `Instance`
     - `PinConnection` (`child_port -> parent_signal`)

3. **Top Inference + Hierarchy** (`app/hierarchy.py`)
   - identifies likely top modules
   - filters likely testbenches by naming conventions
   - builds a recursive hierarchy tree from a selected top

4. **Graph Build** (`app/graph_builder.py`)
   - creates a stable, visualization-friendly graph schema
   - emits node kinds: `module`, `instance`, `port`, `net`
   - emits edge kinds: `hierarchy`, `signal`
   - uses stable IDs so frontend state can be preserved across refreshes

5. **Output**
   - console summary always
   - optional project model JSON via `--out`
   - optional graph JSON printed to console via `--graph`

## Feature Details

### 1) Scanner

Why it matters:

- avoids noise from hidden/system folders
- deterministic ordering makes tests and diffs reliable

Implementation notes:

- extension filter: `.v`, `.sv`
- hidden detection:
  - dot-prefixed names
  - Windows hidden file attribute

### 2) Parser Backends

`pyverilog` backend:

- AST-based extraction (preferred for accuracy)
- better for real project structure
- may skip files with unsupported syntax instead of crashing whole scan

`simple` backend:

- regex-based fallback
- fast and easy to reason about
- intentionally limited grammar support

### 3) Internal Data Model

Core dataclasses in `app/models.py`:

- `Project`
- `SourceFile`
- `ModuleDef`
- `Port`
- `Signal`
- `Instance`
- `PinConnection`

Why this matters:

- parser output is normalized before visualization
- frontend can consume stable concepts rather than raw parser-specific ASTs

### 4) Top Module Inference

The heuristic tries to pick architectural roots by:

- starting from modules not instantiated by other design modules
- ignoring testbench-driven references by default
- preferring roots that actually instantiate other project modules

This is a heuristic, not formal elaboration.

### 5) Stable Graph Schema

Graph output shape:

- top-level: `schema_version`, `top_module`, `nodes`, `edges`
- node: `{id, label, kind}`
- edge: `{source, target, kind}`

Current kinds:

- node kinds: `module`, `instance`, `port`, `net`
- edge kinds: `hierarchy`, `signal`

Semantics:

- hierarchy edges capture ownership/containment
- signal edges capture wiring between nets and ports

This is the bridge from parser output to future UI rendering.

## Outputs: What Each File Represents

`--out out/project.json` writes the **project model JSON**:

- `root_path`
- `source_files`
- `modules`

`--graph` prints the **graph JSON** to console:

- `schema_version`
- `top_module`
- `nodes`
- `edges`

If you want graph JSON saved, redirect stdout to a file.

## CLI Usage

From the project root, replace `C:\path\to\your\verilog-project` with your folder.

Default scan (uses `pyverilog`):

```bash
python -m app.main scan "C:\path\to\your\verilog-project"
```

Explicit parser backend:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog
python -m app.main scan "C:\path\to\your\verilog-project" --parser simple
```

Save parsed project model JSON:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --out out/project.json
```

Print graph JSON (only when exactly one top module is inferred):

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --graph
```

Save full console output (including graph block):

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --graph --out out/project.json > artifacts/summaries/scan_output.txt
```

## Requirements

- Python 3.10+
- For `--parser pyverilog`:

```bash
python -m pip install pyverilog
```

## Testing

Run unit tests:

```bash
python -m unittest discover -s tests -p "test_*.py"
```

Run full flow on your own project:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --graph --out out/project_pyverilog.json
```

## Repository Layout

- `app/main.py` - CLI orchestration
- `app/scanner.py` - file discovery
- `app/models.py` - dataclasses
- `app/parser_base.py` - backend interface
- `app/simple_parser.py` - regex parser backend
- `app/pyverilog_parser.py` - AST parser backend
- `app/hierarchy.py` - top inference + hierarchy tree
- `app/graph_builder.py` - stable graph schema generator
- `app/json_exporter.py` - model-to-JSON exporter
- `tests/` - unit tests
- `out/` - generated project model JSON files
- `artifacts/` - debug and summary artifacts

## Known Limitations

- not a full Verilog/SystemVerilog elaborator yet
- some advanced language constructs are not fully modeled
- top inference is heuristic and may need manual override in ambiguous projects
- graph is structural; it is not yet a complete semantic netlist engine

## Generated Files

You do not need to commit generated parser/cache artifacts such as:

- `parsetab.py`
- `parser.out`
- `__pycache__/`

A `.gitignore` is included to keep these out of commits.
