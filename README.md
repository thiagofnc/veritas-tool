# rtl_arch_visualizer

Backend + API + UI MVP for scanning and analyzing Verilog/SystemVerilog projects, with hierarchy navigation and directed connectivity graphs.

## Naming

Still deciding on the final project name: Verilogix, Silica, Verilium, or ArchRTL.

## MVP Snapshot

This is how the first MVP currently looks:

![First MVP UI](docs/images/mvp_ui.png)

## Project Goal

Build an executable architecture explorer that lets a user choose a local RTL folder and then interactively inspect:

- project hierarchy
- module internals
- instance relationships
- signal connectivity

## What Works So Far

- recursive `.v` and `.sv` file discovery
- hidden-file/folder filtering (dot-path + Windows hidden attribute)
- parser backends:
  - `pyverilog` (AST-based, richer structure)
  - `simple` (regex fallback)
- normalized data model for:
  - source files
  - modules
  - ports
  - signals
  - instances
  - pin-level mappings
- top-module inference and hierarchy tree generation
- connectivity graph generation with directed edges and width-aware signal metadata
- compact graph edge aggregation (reduce edge clutter while preserving per-net details)
- JSON export of full parsed project
- FastAPI service layer + REST endpoints
- browser UI with graph rendering, drill-down, and inspector

## How The Pipeline Works

### 1) Scanner (`app/scanner.py`)

Input: root folder path

Output: deterministic sorted file list of Verilog/SystemVerilog files

What it does:

- recursively walks folders
- ignores hidden files/folders
- keeps only `.v` and `.sv`

### 2) Parser Backend (`app/pyverilog_parser.py` or `app/simple_parser.py`)

Input: file path list

Output: `Project` dataclass instance

What it extracts (MVP scope):

- module definitions
- module ports and directions
- signals/nets (backend-dependent detail)
- instances (`child_module instance_name`)
- named pin mappings (`.child_port(parent_signal)`)

### 3) Service Layer (`app/project_service.py`)

This is the backend orchestration layer used by CLI and API.

Key methods:

- `load_project(folder)`
- `get_top_candidates(include_testbenches=False)`
- `get_hierarchy_tree(top_module)`
- `get_module_connectivity_graph(module_name, mode, aggregate_edges)`
- `get_module_graph(module_name)` (legacy hierarchy graph route)
- `get_project()`, `get_module()`, `get_module_names()`

### 4) Graph Builder (`app/graph_builder.py`)

Generates graph JSON for visualization.

Connectivity graph modes:

- `compact`: endpoint-to-endpoint connections
- `detailed`: explicit `net` nodes in between endpoints (good for signal-level debugging)

Directed-flow behavior:

- uses port direction and instance pin direction when available
- marks uncertain links as `flow = "unknown"`
- tags edges as `wire`, `bus`, or `mixed` and includes inferred `bit_width` when available

Compact aggregation:

- optional collapse of parallel edges by `(source, target, flow)`
- keeps metadata:
  - `nets`
  - `net_count`
  - `connections`

### 5) Delivery Surfaces

- CLI (`app/main.py`) for project scan summaries and JSON export
- API (`app/api.py`) for UI and automation
- UI (`ui/`) with Cytoscape graph rendering and hierarchy navigation

## Data Model (MVP)

Defined in `app/models.py`.

- `SourceFile(path)`
- `Port(name, direction, width=None, bit_width=None, is_bus=False)`
- `Signal(name, width=None, kind="wire", bit_width=None, is_bus=False)`
- `PinConnection(child_port, parent_signal)`
- `Instance(name, module_name, connections, pin_connections)`
- `ModuleDef(name, ports, signals, instances, source_file)`
- `Project(root_path, source_files, modules)`

This model is intentionally simple but stable enough to support parser evolution and future UI features.

## CLI Usage

From repository root, replace `C:\path\to\your\verilog-project` with your folder.

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

Print hierarchy graph JSON (legacy graph builder output):

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --parser pyverilog --graph
```

## API + UI

Install runtime dependencies:

```bash
python -m pip install fastapi uvicorn
```

Run server:

```bash
python -m uvicorn app.api:app --reload
```

Open:

- UI: `http://127.0.0.1:8000/`
- API docs: `http://127.0.0.1:8000/docs`

## Main API Endpoints

- `GET /api/health`
- `POST /api/project/load`
- `GET /api/project`
- `GET /api/project/tops`
- `GET /api/project/modules`
- `GET /api/project/modules/{module_name}`
- `GET /api/project/hierarchy/{top_module}`
- `GET /api/project/graph/{module_name}`
- `GET /api/project/connectivity/{module_name}?mode=compact|detailed&aggregate_edges=true|false`

## UI Behavior (Current MVP)

Left panel:

- top module candidates
- hierarchy tree navigation

Center panel:

- graph mode selector (`compact` or `detailed`)
- aggregate toggle
- show-unknown toggle
- directed graph view with fit-to-screen and bus-vs-wire visual encoding (thicker blue bus edges, thinner green wire edges)

Graph interaction:

- select node/edge for inspector details
- hover tooltips
- double-click instance node to drill into child module
- breadcrumb path updates during drill-down

Right panel:

- loaded project summary
- current graph settings
- selected item details
- legend for node and edge types

## Testing

Run all tests:

```bash
python -m unittest discover -s tests -p "test_*.py"
```

Quick syntax checks used in development:

```bash
python -m py_compile app/graph_builder.py app/api.py app/project_service.py
node --check ui/app.js
```

## Repository Layout

- `app/main.py`: CLI entry point
- `app/api.py`: FastAPI routes + UI serving
- `app/project_service.py`: orchestration service
- `app/scanner.py`: file discovery
- `app/models.py`: core dataclasses
- `app/parser_base.py`: parser backend interface
- `app/pyverilog_parser.py`: AST parser backend
- `app/simple_parser.py`: regex parser backend
- `app/hierarchy.py`: top inference + hierarchy tree
- `app/graph_builder.py`: graph JSON builders
- `app/json_exporter.py`: project JSON export
- `ui/index.html`, `ui/styles.css`, `ui/app.js`: UI client
- `tests/`: unit tests
- `out/`: generated output files
- `artifacts/`: debug logs and summaries

## Known Limitations

- this is not a full elaborating Verilog compiler
- parser coverage for advanced SystemVerilog remains incomplete
- unknown-direction edges can still appear when direction inference is missing
- very large modules can still be visually dense without additional filtering
- UI currently runs in browser (packaging into desktop executable is a future step)

## Generated Files

Do not commit generated parser/cache artifacts.

- `parsetab.py`
- `parser.out`
- `__pycache__/`


