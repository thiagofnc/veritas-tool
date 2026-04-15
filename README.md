# Veritas: Verilog Design Tool

 ## Vision for the project

 Veritas is not going to be just another HDL editor, it is going to be the backbone of RTL design, simulation and debugging. I intend on making it the central environment where engineers can move from idea to implementation to verification without constantly switching tools. Veritas will unify code editing, hierarchy exploration, connectivity visualization, signal tracing, simulation, diagnostics, and AI-assisted development into one coherent system built specifically for Verilog and SystemVerilog. Veritas will treat a design as a living system that can be explored, modified and validated continuously. Engineers should be able to open a module, understand how it fits into the larger architecture, trace signals across instances and processes, edit the source directly, run checks and simulations, and get immediate feedback in the same environment.

![Current state of the software](docs/images/mvp_ui.png)

## Current Capabilities

- Recursive `.v` / `.sv` discovery with hidden-file filtering and a few common directory exclusions.
- PyVerilog-based structural parsing of modules, ports, internal signals, instances, gate primitives, continuous assigns, and `always`-family blocks.
- Source-linked diagnostics for parse failures and unresolved trace boundaries.
- Top-module inference with heuristics that try to ignore obvious testbenches by default.
- Hierarchy queries and module-level connectivity graphs in `compact` and `detailed` modes.
- Schematic-style rendering derived from the connectivity graph, with `full`, `simplified`, and `bus` display modes.
- Width-aware metadata for ports and signals, including bus detection when the width can be inferred.
- Local and cross-module signal tracing, including both data dependencies and control dependencies.
- Source browsing and editing through the API, plus incremental reparse of changed files.
- Module creation and instance insertion helpers.
- Git workflows through the backend: clone, status, history, commit/push, and read-only loading of historical commits.
- Managed testbench creation plus discovered-testbench support, Icarus Verilog simulation runs, and VCD parsing for waveform display.
- Browser UI with hierarchy drill-down, file browsing, graph inspection, signal trace panels, Git panels, and read-only commit mode.

## How It Works

### Scan and Parse

`app/scanner.py` walks the project tree and keeps only visible `.v` and `.sv` files. The backend then parses those files with `PyVerilogParser` in [app/pyverilog_parser.py](app/pyverilog_parser.py).

The parser is intentionally centered on one backend right now: PyVerilog. That is a deliberate simplification. The older README described multiple parser backends, but the current codebase does not expose a selectable fallback parser anymore. Keeping one real parser reduces drift between the model, the graph builder, and the UI.

The parser also caches per-file results in memory and parses files in small parallel batches. That keeps reloads responsive on repeated scans without forcing the rest of the system to reason about multiple project-model formats.

### Normalized Project Model

Everything gets folded into the dataclasses in [app/models.py](app/models.py): files, modules, ports, signals, instances, assigns, gates, always blocks, locations, and diagnostics.

That normalized model is the key architectural choice in the project. Hierarchy, connectivity, tracing, editing, simulation, and UI inspection all consume the same structure instead of each feature reparsing the source independently. The main benefit is consistency: if parsing gets better, multiple downstream features improve automatically.

### Connectivity and Schematic Views

Connectivity graphs are built in [app/graph_builder.py](app/graph_builder.py). The compact mode emphasizes readable endpoint relationships; the detailed mode materializes more intermediate wiring structure.

The schematic view in [app/schematic_layout.py](app/schematic_layout.py) is not a separate parser or a separate truth source. It starts from the compact connectivity graph and then applies block placement and routing. That avoids having two graph-generation pipelines that can disagree.

### Signal Tracing

Signal tracing lives in [app/signal_tracer.py](app/signal_tracer.py). A useful implementation detail is that the tracer treats both RHS data sources and enclosing `if`/`case` condition signals as direct dependencies. That means tracing the fan-in of a muxed or conditionally assigned signal shows not just the data inputs, but also the select or enable signal that actually controls the assignment.

That choice makes the trace more useful for debugging real RTL behavior. A purely data-only trace tends to miss the exact signal users usually care about first: the control that decides which branch is active.

### Editing and Project State

The API in [app/api.py](app/api.py) supports reading and writing module or file source, creating modules, and inserting new instantiations.

File saves try an incremental reparse first. If the updated file no longer parses cleanly, the backend can keep the previous in-memory project model instead of immediately destroying the loaded graph state. That is an important usability decision: a temporary syntax error in the editor should not make the whole project view disappear while the user is mid-edit.

### Git Integration

Git operations live in [app/git_service.py](app/git_service.py). The service uses the local `git` CLI rather than a hosting API. That is the right abstraction for this workflow because the tool is operating on local working trees, local status, local commits, and the user's existing credentials.

Historical commit viewing is implemented by materializing a temporary snapshot of a commit and loading that snapshot as a read-only project. That keeps browsing old revisions safe without checking files in and out of the live working tree.

### Simulation and Waveforms

Simulation support is in [app/simulation_service.py](app/simulation_service.py) and [app/vcd_parser.py](app/vcd_parser.py).

The backend manages a `testbenches/` folder for authored testbenches and a `.veritas_sim/` folder for run artifacts. Keeping generated outputs inside a dedicated sandbox under the project root makes cleanup and path validation straightforward, and it avoids scattering temporary files across the machine.

Runs are executed through `iverilog` and `vvp`. The resulting VCD is parsed into a JSON-friendly structure so the frontend can render waveforms and change radix without reparsing the file.

## API Surface

Main groups of endpoints:

- Project loading and progress: `/api/project/load`, `/api/project/load/progress`, `/api/project/context`
- Project queries: `/api/project`, `/api/project/tops`, `/api/project/modules`, `/api/project/files`
- Source editing: `/api/project/modules/{module_name}/source`, `/api/project/files/source`
- Structure and graphs: `/api/project/hierarchy/{top_module}`, `/api/project/graph/{module_name}`, `/api/project/connectivity/{module_name}`
- Trace: `/api/signal/trace`
- Git: `/api/git/clone`, `/api/git/repo`, `/api/git/status`, `/api/git/history`, `/api/git/commit-and-push`, `/api/git/load-commit`
- Simulation: `/api/sim/tools`, `/api/sim/testbenches`, `/api/sim/testbench`, `/api/sim/run`, `/api/sim/waveform`

Useful connectivity query parameters:

- `mode=compact|detailed`
- `aggregate_edges=true|false`
- `port_view=true|false`
- `schematic=true|false`
- `schematic_mode=full|simplified|bus`

## CLI

From the repository root:

```bash
python -m app.main scan "C:\path\to\your\verilog-project"
```

Write the parsed project model to JSON:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --out out/project.json
```

Print the legacy hierarchy graph JSON when exactly one top module is inferred:

```bash
python -m app.main scan "C:\path\to\your\verilog-project" --graph
```

## Running the App

Install Python dependencies:

```bash
python -m pip install fastapi uvicorn pyverilog
```

Optional tools used by specific features:

- `git` on `PATH` for repository features
- `iverilog` and `vvp` on `PATH` for simulation

Start the server:

```bash
python -m uvicorn app.api:app --reload
```

Open:

- UI: `http://127.0.0.1:8000/`
- API docs: `http://127.0.0.1:8000/docs`

## Testing

Run the test suite:

```bash
python -m unittest discover -s tests -p "test_*.py"
```

## Repository Layout

- `app/main.py`: CLI entry point
- `app/api.py`: FastAPI routes and UI serving
- `app/project_service.py`: project orchestration
- `app/scanner.py`: source-file discovery
- `app/pyverilog_parser.py`: PyVerilog-based parser
- `app/models.py`: shared data model
- `app/graph_builder.py`: hierarchy and connectivity graph generation
- `app/schematic_layout.py`: schematic layout and routing
- `app/signal_tracer.py`: local and cross-module tracing
- `app/git_service.py`: local Git operations
- `app/simulation_service.py`: testbench and simulation workflow
- `app/vcd_parser.py`: waveform parsing
- `ui/`: browser client
- `tests/`: unit tests
- `sample_projects/`: bundled example RTL projects

## Notes and Limitations

- The tool is not a full Verilog/SystemVerilog elaborator or compiler.
- SystemVerilog coverage is still partial and bounded by what PyVerilog can parse well here.
- Direction and dependency inference are still heuristic in some cases, so unknown or approximate edges can remain.
- The UI now supports a custom folder picker, but it still also contains hardcoded preset paths in `ui/app.js` for local development.
- Simulation depends on external Icarus Verilog binaries and will report `tool_missing` when they are not installed.

## Verified README Corrections

The previous README no longer matched the code in a few places. These are the most important corrections reflected above:

- The current backend uses PyVerilog only; there is no user-selectable `simple` parser path in the CLI or API.
- The CLI does not currently accept `--parser`.
- The backend now includes Git, source-editing, commit-snapshot, testbench, simulation, and waveform features that were under-described before.
- The old statement that the UI only relies on preset project paths is no longer fully correct because there is now a folder-picker flow, even though preset paths are still present for development.
