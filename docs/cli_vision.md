# Veritas CLI Vision

The Veritas CLI should be the headless, scriptable interface to the same analysis engine that powers the UI and API. It is not meant to replace the browser experience. Its job is to make project inspection, connectivity analysis, tracing, export, and validation easy to run from a terminal, from CI, and eventually from agents.

## Why It Exists

Veritas is intended to become a central environment for RTL understanding, editing, verification, and debugging. A strong CLI supports that vision by giving the project a reliable automation layer.

The CLI should be useful for:

- quick local inspection without opening the UI
- repeatable analysis and export workflows
- CI checks and regression detection
- agent integration through stable commands and machine-readable output

## How It Should Work

The CLI should stay thin. It should call the existing backend service layer rather than reimplementing parsing or graph logic. The same project model and query behavior should be shared across the CLI, API, UI, and future agent tools.

The preferred style is explicit subcommands instead of a large interactive shell. That keeps behavior easy to test and easy to automate.

Typical usage should look like:

```bash
veritas scan .
veritas tops .
veritas hierarchy . --top system_top --format json
veritas graph . --module uart_bridge --mode compact --format json
veritas trace . --module tracer_validation_top --signal launch_valid --format json
```

## Core Design Rules

- Keep commands deterministic and script-friendly.
- Support both human-readable text output and stable JSON output.
- Use clear exit codes for failure cases such as parse errors or missing modules.
- Avoid hidden session state in the first version.
- Treat the CLI as a companion to the UI, not a separate product.

## Useful Command Areas

The first command groups should cover the parts of Veritas that already exist in the backend:

- project inspection: `scan`, `tops`, `modules`, `module-info`
- structure queries: `hierarchy`, `graph`, `schematic`
- signal analysis: `trace`
- export: `export project`, `export graph`
- validation: `check parse`, `check project`
- utility: `serve`

## Why This Matters For Agents

Agents will need a controlled action surface. A CLI gives them stable verbs such as "list modules", "build a graph", "trace a signal", and "run checks" without forcing them to drive the UI or depend directly on internal Python details.

That makes agent behavior easier to log, test, replay, and constrain. In practice, the CLI becomes one of the cleanest ways for future Veritas agents to inspect a design, propose a change, validate it, and report results.

## Scope Guidance

The early CLI should focus on headless analysis and validation. A Vivado-style interactive shell or scripting language may become useful later, but it should come after the non-interactive commands are stable and clearly mapped to the backend service layer.

## Automation And Scripted Workflows

Yes, this CLI direction should support automated workflows and script execution. That is useful for Veritas because many of its core capabilities are naturally repeatable: scanning a project, inferring top modules, exporting hierarchy, building connectivity graphs, tracing signals, and running structural checks.

That makes the CLI valuable for local batch work, CI regression checks, and future agent-driven flows. The main constraint is scope: automation should be built around clear, deterministic commands that reuse the backend service layer. Veritas should not rush into a large interactive shell or custom scripting language before the core non-interactive commands are stable.
