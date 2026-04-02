# rtl_arch_visualizer

Backend + API + browser UI for scanning and analyzing Verilog/SystemVerilog projects, with hierarchy navigation, module connectivity views, and schematic-style layouts.

Still deciding on the final project name: Verilogix, Silica, Verilium, or ArchRTL.

## Current Status

This repo is still an MVP, but it is beyond the original "just hierarchy + basic graph" stage.

Implemented today:

- recursive `.v` / `.sv` discovery with hidden-file and hidden-folder filtering
- two parser backends:
  - `pyverilog` for AST-based parsing
  - `simple` for regex-based fallback
- normalized project model for files, modules, ports, signals, instances, and pin mappings
- top-module inference and hierarchy tree generation
- module connectivity graphs in:
  - `compact` mode
  - `detailed` mode
  - schematic view (`full`, `simplified`, `bus`)
- width-aware signal metadata with directed flow inference where possible
- optional compact-edge aggregation to reduce clutter
- extraction and visualization of:
  - module I/O
  - instance pins
  - gate primitives
  - continuous `assign` statements
  - `always` / `always_ff` / `always_comb` / `always_latch` blocks
- JSON export of parsed project data
- FastAPI endpoints for loading/querying projects
- browser UI for hierarchy drill-down, graph inspection, and schematic rendering

## MVP Snapshot

![First MVP UI](docs/images/mvp_ui.png)

## Project Goal

Build an architecture explorer that lets a user load a local RTL project and inspect:

- project hierarchy
- module internals
- instance relationships
- signal connectivity
- process-level behavior at a structural/debugging level

## Pipeline Overview

### 1) Scanner (`app/scanner.py`)

Input: root folder path

Output: deterministic sorted file list of Verilog/SystemVerilog files

Behavior:

- recursively walks the folder tree
- ignores hidden files and folders
- keeps `.v` and `.sv`

### 2) Parser Backend (`app/pyverilog_parser.py` or `app/simple_parser.py`)

Input: file path list

Output: `Project` dataclass instance

Current extraction scope:

- module definitions
- module ports and directions
- declared signals/nets
- instances and named pin mappings
- gate primitives
- continuous assigns
- always blocks and summarized read/write behavior

Notes:

- `pyverilog` is the richer backend and the default everywhere in the app
- `simple` is useful as a fallback when PyVerilog is unavailable or the source is outside current AST coverage

### 3) Service Layer (`app/project_service.py`)

Backend orchestration layer used by the CLI and API.

Key methods:

- `load_project(folder)`
- `get_top_candidates(include_testbenches=False)`
- `get_hierarchy_tree(top_module)`
- `get_module_connectivity_graph(module_name, mode, aggregate_edges, port_view, schematic, schematic_mode)`
- `get_module_graph(module_name)` for the legacy hierarchy graph route
- `get_project()`, `get_module()`, `get_module_names()`

### 4) Graph Builders (`app/graph_builder.py`, `app/schematic_layout.py`)

Connectivity graph modes:

- `compact`: endpoint-to-endpoint connections
- `detailed`: explicit `net` nodes between endpoints
- `schematic`: block-and-route style layout built from compact connectivity

Current graph node coverage includes:

- selected module I/O
- child instances
- instance port nodes
- gate primitives
- continuous assign nodes
- collapsed always/process nodes with process port nodes
- explicit net nodes in detailed mode

Current graph behavior:

- uses port direction and instance pin direction when available
- keeps uncertain links as `flow="unknown"`
- tags edges as `wire`, `bus`, or `mixed`
- keeps inferred `bit_width` where available
- can aggregate compact-mode parallel edges while preserving per-net metadata

### 5) Delivery Surfaces

- CLI: `app/main.py`
- API: `app/api.py`
- UI: `ui/`

## Data Model

Defined in `app/models.py`.

- `SourceFile(path)`
- `Port(name, direction, width=None, bit_width=None, is_bus=False)`
- `Signal(name, width=None, kind="wire", bit_width=None, is_bus=False)`
- `PinConnection(child_port, parent_signal)`
- `Instance(name, module_name, connections, pin_connections)`
- `GatePrimitive(name, gate_type, output, inputs)`
- `ContinuousAssign(target, expression, source_signals)`
- `AlwaysAssignment(target, expression, condition, blocking, source_signals)`
- `AlwaysBlock(name, sensitivity, kind, process_style, ..., assignments, control_summary, summary_lines)`
- `ModuleDef(name, ports, signals, instances, gates, assigns, always_blocks, source_file)`
- `Project(root_path, source_files, modules)`

## CLI Usage

From the repository root:

```bash
python -m app.main scan "C:\path\to\your\verilog-project"
```

Choose parser backend:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog
python -m app.main scan "C:\path\to\your\verilog-project" --parser simple
```

Write parsed project JSON:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --out out/project.json
```

Print the legacy hierarchy graph JSON when a single top module is inferred:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --graph
```

## API + UI

Install runtime dependencies:

```bash
python -m pip install fastapi uvicorn pyverilog
```

If you do not want to install `pyverilog`, use the `simple` parser backend instead.

Run the server:

```bash
python -m uvicorn app.api:app --reload
```

Open:

- UI: `http://127.0.0.1:8000/`
- API docs: `http://127.0.0.1:8000/docs`

Important current UI caveat:

- the project picker in `ui/app.js` is populated from hardcoded local paths
- for your own setup, update those paths or use the API directly to load a folder
- the browser UI also pulls Cytoscape/ELK scripts from CDN URLs in `ui/index.html`

## Main API Endpoints

- `GET /api/health`
- `POST /api/project/load`
- `GET /api/project`
- `GET /api/project/tops`
- `GET /api/project/modules`
- `GET /api/project/modules/{module_name}`
- `GET /api/project/hierarchy/{top_module}`
- `GET /api/project/graph/{module_name}`
- `GET /api/project/connectivity/{module_name}`

Useful connectivity query parameters:

- `mode=compact|detailed`
- `aggregate_edges=true|false`
- `port_view=true|false`
- `schematic=true|false`
- `schematic_mode=full|simplified|bus`

## UI Behavior

Left panel:

- top module candidates
- hierarchy tree navigation

Center panel:

- graph mode selector
- aggregate toggle
- show-unknown toggle
- schematic toggle
- schematic mode selector
- graph stats, graph canvas, and JSON preview

Graph interaction:

- select node or edge for inspector details
- hover tooltips
- double-click instance node to drill into the child module
- always-block detail overlay for process summaries and assignments
- breadcrumb path updates during drill-down

Right panel:

- loaded project summary
- current graph settings
- selected item details
- legend for node and edge types

## Sample Projects

Bundled examples live under `sample_projects/`:

- `01_linear_chain`
- `02_serial_subsystem`
- `03_sensor_hub`
- `04_three_module_chain`

## Testing

Run the test suite:

```bash
python -m unittest discover -s tests -p "test_*.py"
```

Quick syntax checks used during development:

```bash
python -m py_compile app/graph_builder.py app/project_service.py app/api.py app/schematic_layout.py
node --check ui/app.js
```

## Repository Layout

- `app/main.py`: CLI entry point
- `app/api.py`: FastAPI routes and UI serving
- `app/project_service.py`: orchestration service
- `app/scanner.py`: file discovery
- `app/models.py`: core dataclasses
- `app/parser_base.py`: parser backend interface
- `app/pyverilog_parser.py`: AST parser backend
- `app/simple_parser.py`: regex fallback parser
- `app/hierarchy.py`: top inference and hierarchy tree
- `app/graph_builder.py`: hierarchy and connectivity graph builders
- `app/schematic_layout.py`: schematic layout and routed view generation
- `app/json_exporter.py`: project JSON export
- `ui/index.html`, `ui/styles.css`, `ui/app.js`: browser client
- `tests/`: unit tests
- `sample_projects/`: bundled small RTL examples
- `out/`: generated output files
- `artifacts/`: debug logs and summaries

## Known Limitations

- this is not a full elaborating Verilog/SystemVerilog compiler
- advanced SystemVerilog coverage is still incomplete
- direction inference is still heuristic in some cases, so unknown-flow edges can remain
- dense modules can still produce visually busy graphs
- the UI project picker is not yet a general folder browser
- the UI is still browser-served, not packaged as a desktop app

## Generated Files

Do not commit generated parser/cache artifacts.

- `parsetab.py`
- `parser.out`
- `__pycache__/`
