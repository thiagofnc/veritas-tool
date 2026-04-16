"""LLM agent runner: edit modules, run simulations, iterate toward a goal.

The agent drives a standard tool-use loop against Anthropic's Messages API.
It is intentionally sandboxed to the loaded project folder — every tool
either reads or writes files through the same guards the rest of the API
already enforces (see ``simulation_service._resolve_sandboxed_path`` and the
project-tracked file set).

Sessions are held in-process. Clients create a session with ``start_session``,
poll ``get_session_snapshot`` for new events, and optionally call
``stop_session`` to interrupt the loop between iterations.

API key handling: the key is read from the ``ANTHROPIC_API_KEY`` env var, or
(if absent) from a ``settings.json`` stored in the user's home directory at
``~/.veritas/settings.json``. The UI exposes a small endpoint to write that
file so users can paste their key without editing files manually.
"""

from __future__ import annotations

import json
import os
import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable


SETTINGS_DIR = Path.home() / ".veritas"
SETTINGS_FILE = SETTINGS_DIR / "settings.json"

DEFAULT_MODEL = "claude-sonnet-4-5"
DEFAULT_MAX_ITERATIONS = 15
MAX_TOOL_RESULT_CHARS = 8000   # cap tool-result payloads so a log dump
                               # doesn't blow the agent's context budget


class AgentError(RuntimeError):
    pass


# -----------------------------------------------------------------------------
# Settings (API key storage)
# -----------------------------------------------------------------------------

def load_settings() -> dict:
    if not SETTINGS_FILE.exists():
        return {}
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_settings(updates: dict) -> dict:
    SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
    current = load_settings()
    current.update({k: v for k, v in updates.items() if v is not None})
    SETTINGS_FILE.write_text(json.dumps(current, indent=2), encoding="utf-8")
    try:
        SETTINGS_FILE.chmod(0o600)
    except OSError:
        pass
    return current


def resolve_api_key() -> str | None:
    env = os.environ.get("ANTHROPIC_API_KEY")
    if env:
        return env.strip() or None
    settings = load_settings()
    key = settings.get("anthropic_api_key")
    return key.strip() if isinstance(key, str) and key.strip() else None


def get_settings_status() -> dict:
    key = resolve_api_key()
    source = None
    if os.environ.get("ANTHROPIC_API_KEY"):
        source = "env"
    elif key:
        source = "file"
    return {
        "has_api_key": bool(key),
        "source": source,
        "model": load_settings().get("model", DEFAULT_MODEL),
        "settings_path": str(SETTINGS_FILE),
    }


# -----------------------------------------------------------------------------
# Session state
# -----------------------------------------------------------------------------

@dataclass
class AgentEvent:
    seq: int
    ts: float
    kind: str                    # "status" | "message" | "tool_call" | "tool_result" | "error" | "done"
    data: dict


@dataclass
class AgentSession:
    id: str
    goal: str
    project_root: str
    model: str
    max_iterations: int
    status: str = "pending"      # pending | running | completed | failed | stopped
    iterations: int = 0
    final_text: str = ""
    events: list[AgentEvent] = field(default_factory=list)
    stop_requested: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _seq: int = 0

    def emit(self, kind: str, data: dict) -> None:
        with self._lock:
            self._seq += 1
            self.events.append(AgentEvent(seq=self._seq, ts=time.time(), kind=kind, data=data))

    def snapshot(self, since_seq: int = 0) -> dict:
        with self._lock:
            new = [e for e in self.events if e.seq > since_seq]
            return {
                "id": self.id,
                "goal": self.goal,
                "status": self.status,
                "iterations": self.iterations,
                "max_iterations": self.max_iterations,
                "model": self.model,
                "final_text": self.final_text,
                "events": [
                    {"seq": e.seq, "ts": e.ts, "kind": e.kind, "data": e.data}
                    for e in new
                ],
                "last_seq": self._seq,
            }


_sessions: dict[str, AgentSession] = {}
_sessions_lock = threading.Lock()


def get_session(session_id: str) -> AgentSession:
    with _sessions_lock:
        session = _sessions.get(session_id)
    if not session:
        raise AgentError(f"Unknown agent session: {session_id}")
    return session


def list_sessions() -> list[dict]:
    with _sessions_lock:
        return [
            {
                "id": s.id,
                "goal": s.goal[:200],
                "status": s.status,
                "iterations": s.iterations,
                "model": s.model,
            }
            for s in _sessions.values()
        ]


def stop_session(session_id: str) -> dict:
    session = get_session(session_id)
    session.stop_requested = True
    session.emit("status", {"message": "Stop requested — finishing current iteration."})
    return {"id": session.id, "stop_requested": True}


# -----------------------------------------------------------------------------
# Tool schema + dispatcher
# -----------------------------------------------------------------------------
#
# The schemas below are what the model sees. Keep them tight: every field the
# model doesn't need is a chance for it to guess wrong. Every write path is
# routed through the existing services (ProjectService / simulation_service)
# so the agent inherits their sandboxing and reparse logic for free.

TOOL_DEFINITIONS: list[dict] = [
    {
        "name": "list_modules",
        "description": "List every Verilog module name defined in the loaded project.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "read_module",
        "description": (
            "Read the full source of a module by name. Use this before editing "
            "a module so you see its current ports, parameters, and body."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "Module name, e.g. 'uart_rx'."}},
            "required": ["name"],
            "additionalProperties": False,
        },
    },
    {
        "name": "write_module",
        "description": (
            "Overwrite the source file of an existing module with new full content. "
            "The file is re-parsed immediately; returns a pass/fail status plus any "
            "parse errors so you can correct them."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "content": {"type": "string", "description": "Full new text of the module's source file."},
            },
            "required": ["name", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_testbenches",
        "description": "List testbench files known to the project (managed and discovered).",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "read_testbench",
        "description": "Read the contents of a testbench by its absolute path.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "write_testbench",
        "description": (
            "Write a testbench by absolute path. Creates it if missing (path must be "
            "inside the project). Use this for both new and existing testbenches."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "create_managed_testbench",
        "description": (
            "Create a new testbench under <project>/testbenches/ by file name. "
            "Returns the absolute path. Use this when you need a fresh testbench "
            "and don't have a path yet."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "File name, e.g. 'tb_uart_rx'."},
                "content": {"type": "string"},
            },
            "required": ["name", "content"],
            "additionalProperties": False,
        },
    },
    {
        "name": "run_simulation",
        "description": (
            "Compile the whole project plus the given testbench using Icarus Verilog "
            "and run it. Returns verdict (pass/fail/unknown), counters, stdout/stderr "
            "excerpts, parsed test events, and any compile/runtime messages. "
            "ALWAYS run this to check your work — the verdict is the ground truth."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "testbench_path": {"type": "string"},
                "top_module": {"type": "string", "description": "Optional override for the -s top module. Defaults to the testbench file stem."},
                "timeout_sec": {"type": "number", "default": 30, "minimum": 1, "maximum": 600},
            },
            "required": ["testbench_path"],
            "additionalProperties": False,
        },
    },
    {
        "name": "finish",
        "description": (
            "Call this when the goal is met (or cannot be met) to end the session "
            "with a clear final summary. After calling this, do not emit more tools."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "summary": {"type": "string", "description": "Short human-readable summary of what was done and the final verdict."},
                "success": {"type": "boolean"},
            },
            "required": ["summary", "success"],
            "additionalProperties": False,
        },
    },
]


def _truncate(text: str, limit: int = MAX_TOOL_RESULT_CHARS) -> str:
    if len(text) <= limit:
        return text
    head = text[: limit // 2]
    tail = text[-limit // 2 :]
    return f"{head}\n...[{len(text) - limit} chars truncated]...\n{tail}"


def _summarize_sim_result(result: dict) -> dict:
    """Shrink a full simulation result into something the model can digest.

    A full result can include 100KB of stdout and a huge message list. The
    agent cares about verdict, counters, a handful of events, and the tail of
    stderr/stdout — feeding back the whole thing bloats context fast.
    """
    events = result.get("test_events") or []
    messages = result.get("messages") or []
    return {
        "status": result.get("status"),
        "verdict": result.get("verdict"),
        "verdict_reason": result.get("verdict_reason"),
        "pass_count": result.get("pass_count"),
        "fail_count": result.get("fail_count"),
        "error_count": result.get("error_count"),
        "fatal_count": result.get("fatal_count"),
        "assertion_count": result.get("assertion_count"),
        "warning_count": result.get("warning_count"),
        "exit_code": result.get("exit_code"),
        "timed_out": result.get("timed_out"),
        "expected_matched": result.get("expected_matched"),
        "diff": _truncate(result.get("diff") or "", 2000),
        "compile_stderr": _truncate(result.get("compile_stderr") or "", 2000),
        "run_stdout": _truncate(result.get("run_stdout") or "", 2500),
        "run_stderr": _truncate(result.get("run_stderr") or "", 1500),
        "test_events": events[:40],
        "messages": messages[:40],
    }


class _ToolContext:
    """Bundles the services each tool needs.

    Built fresh per session so the tools see the currently-loaded project;
    passed by reference into ``dispatch_tool``.
    """
    def __init__(self, project_root: str, state, state_lock, simulation_service_mod):
        self.project_root = project_root
        self.state = state
        self.state_lock = state_lock
        self.simulation_service = simulation_service_mod


def dispatch_tool(ctx: _ToolContext, name: str, args: dict) -> dict:
    try:
        if name == "list_modules":
            with ctx.state_lock:
                return {"modules": ctx.state.service.get_module_names()}

        if name == "read_module":
            module_name = str(args.get("name", "")).strip()
            with ctx.state_lock:
                module = ctx.state.service.get_module(module_name)
                src_path = module.source_file
            if not src_path:
                return {"error": f"Module '{module_name}' has no associated source file."}
            content = Path(src_path).read_text(encoding="utf-8", errors="replace")
            return {"name": module_name, "path": src_path, "content": content}

        if name == "write_module":
            module_name = str(args.get("name", "")).strip()
            content = args.get("content") or ""
            with ctx.state_lock:
                module = ctx.state.service.get_module(module_name)
                src_path = module.source_file
                if not src_path:
                    return {"error": f"Module '{module_name}' has no associated source file."}
                path = Path(src_path)
                path.write_text(content, encoding="utf-8")
                try:
                    report = ctx.state.service.reparse_file(str(path))
                except Exception as exc:  # noqa: BLE001
                    return {
                        "saved": True,
                        "path": str(path),
                        "parse_ok": False,
                        "error": f"Saved but failed to parse: {exc}",
                    }
                if report.get("requires_full_reparse") and ctx.state.loaded_folder:
                    try:
                        ctx.state.service.load_project(ctx.state.loaded_folder)
                    except Exception:
                        pass
                return {"saved": True, "path": str(path), "parse_ok": True, "reparse": report}

        if name == "list_testbenches":
            return {"testbenches": ctx.simulation_service.list_testbenches(ctx.project_root)}

        if name == "read_testbench":
            path = str(args.get("path", "")).strip()
            return ctx.simulation_service.read_testbench_by_path(ctx.project_root, path)

        if name == "write_testbench":
            path = str(args.get("path", "")).strip()
            content = args.get("content") or ""
            info = ctx.simulation_service.write_testbench_by_path(ctx.project_root, path, content)
            return {"saved": True, **info}

        if name == "create_managed_testbench":
            tb_name = str(args.get("name", "")).strip()
            content = args.get("content")
            info = ctx.simulation_service.create_managed_testbench(ctx.project_root, tb_name, content)
            return {"created": True, **info}

        if name == "run_simulation":
            tb_path = str(args.get("testbench_path", "")).strip()
            top_module = args.get("top_module") or None
            timeout_sec = float(args.get("timeout_sec") or 30.0)
            result = ctx.simulation_service.run_simulation(
                ctx.project_root,
                tb_path,
                top_module=top_module,
                timeout_sec=timeout_sec,
            )
            ctx.simulation_service.prune_old_runs(ctx.project_root, keep=10)
            full = ctx.simulation_service.result_to_dict(result)
            return _summarize_sim_result(full)

        if name == "finish":
            return {"acknowledged": True}

        return {"error": f"Unknown tool: {name}"}

    except Exception as exc:  # noqa: BLE001 — every tool error must come back as data
        return {"error": f"{type(exc).__name__}: {exc}"}


# -----------------------------------------------------------------------------
# Agent loop
# -----------------------------------------------------------------------------

SYSTEM_PROMPT_TEMPLATE = """You are a Verilog design agent working inside a user's RTL project.

Your job: accomplish the user's goal by reading modules, editing them, writing
testbenches, running simulations via Icarus Verilog, and iterating on the
results until the verdict is 'pass' (or you can prove the goal is impossible).

Project root: {project_root}

Workflow rules:
- Always start by listing modules or testbenches to orient yourself.
- Read the full source of a module before editing it. Preserve formatting and
  unrelated code; only change what the goal requires.
- When writing Verilog, prefer clean synthesizable RTL. Testbenches should emit
  PASS / FAIL lines using the project convention:
    $display("PASS [t=%0t] <name>")  or  $display("FAIL [t=%0t] <detail>").
- After every meaningful edit, call run_simulation. The verdict is the ground
  truth; do not claim success without a passing simulation.
- On compile/runtime failure, read the returned messages carefully and fix the
  root cause rather than hiding the error.
- Call the 'finish' tool when the goal is achieved or you're blocked and need
  to stop.

Stay concise in your assistant turns — let the tools do the talking.
"""


def _build_tool_result_block(tool_use_id: str, result: Any) -> dict:
    if isinstance(result, (dict, list)):
        payload = json.dumps(result, default=str)
    else:
        payload = str(result)
    is_error = isinstance(result, dict) and bool(result.get("error"))
    return {
        "type": "tool_result",
        "tool_use_id": tool_use_id,
        "content": _truncate(payload),
        "is_error": is_error,
    }


def _run_agent_loop(
    session: AgentSession,
    ctx: _ToolContext,
    api_key: str,
) -> None:
    try:
        try:
            import anthropic  # type: ignore
        except ImportError:
            session.status = "failed"
            session.emit("error", {"message": "The 'anthropic' Python package is not installed. Run: pip install anthropic"})
            session.emit("done", {"status": session.status})
            return

        client = anthropic.Anthropic(api_key=api_key)
        system_prompt = SYSTEM_PROMPT_TEMPLATE.format(project_root=session.project_root)
        messages: list[dict] = [
            {"role": "user", "content": f"Goal: {session.goal}\n\nBegin when ready."},
        ]

        session.status = "running"
        session.emit("status", {"message": f"Agent started with model {session.model}."})

        finished_via_tool = False

        while session.iterations < session.max_iterations:
            if session.stop_requested:
                session.status = "stopped"
                session.emit("status", {"message": "Stopped by user before next iteration."})
                break

            session.iterations += 1
            session.emit("status", {"iteration": session.iterations, "message": f"Iteration {session.iterations} — calling model."})

            try:
                response = client.messages.create(
                    model=session.model,
                    max_tokens=4096,
                    system=system_prompt,
                    tools=TOOL_DEFINITIONS,
                    messages=messages,
                )
            except Exception as exc:  # noqa: BLE001 — surface API errors as events
                session.status = "failed"
                session.emit("error", {"message": f"Anthropic API error: {exc}"})
                break

            # Emit any assistant text blocks for UI display, and capture the
            # full assistant content back into the conversation history.
            assistant_content_blocks: list[dict] = []
            tool_uses: list[Any] = []
            for block in response.content:
                if block.type == "text":
                    session.emit("message", {"role": "assistant", "text": block.text})
                    assistant_content_blocks.append({"type": "text", "text": block.text})
                elif block.type == "tool_use":
                    tool_uses.append(block)
                    assistant_content_blocks.append({
                        "type": "tool_use",
                        "id": block.id,
                        "name": block.name,
                        "input": block.input,
                    })

            messages.append({"role": "assistant", "content": assistant_content_blocks})

            if not tool_uses:
                # No tools requested — treat as a natural stop (model is done talking).
                session.final_text = "\n\n".join(
                    b["text"] for b in assistant_content_blocks if b.get("type") == "text"
                )
                session.status = "completed"
                break

            tool_results: list[dict] = []
            for tu in tool_uses:
                session.emit("tool_call", {"id": tu.id, "name": tu.name, "input": tu.input})
                result = dispatch_tool(ctx, tu.name, dict(tu.input or {}))
                session.emit("tool_result", {
                    "id": tu.id,
                    "name": tu.name,
                    "summary": _short_summary(tu.name, result),
                    "is_error": isinstance(result, dict) and bool(result.get("error")),
                })
                tool_results.append(_build_tool_result_block(tu.id, result))
                if tu.name == "finish":
                    finished_via_tool = True
                    inp = dict(tu.input or {})
                    session.final_text = str(inp.get("summary", ""))
                    session.status = "completed" if inp.get("success") else "failed"

            messages.append({"role": "user", "content": tool_results})

            if finished_via_tool:
                break

        else:
            # Loop exited because we hit max_iterations without a break.
            session.status = "failed"
            session.emit("status", {"message": f"Max iterations ({session.max_iterations}) reached without finishing."})

        session.emit("done", {"status": session.status, "final_text": session.final_text})

    except Exception as exc:  # noqa: BLE001 — never let the worker thread die silently
        session.status = "failed"
        session.emit("error", {"message": f"Agent crashed: {exc}", "traceback": traceback.format_exc()})
        session.emit("done", {"status": session.status})


def _short_summary(tool_name: str, result: Any) -> str:
    if not isinstance(result, dict):
        return str(result)[:200]
    if result.get("error"):
        return f"error: {str(result['error'])[:200]}"
    if tool_name == "run_simulation":
        return (
            f"verdict={result.get('verdict')} "
            f"pass={result.get('pass_count')} fail={result.get('fail_count')} "
            f"errors={result.get('error_count')} status={result.get('status')}"
        )
    if tool_name == "list_modules":
        mods = result.get("modules") or []
        return f"{len(mods)} modules"
    if tool_name == "list_testbenches":
        tbs = result.get("testbenches") or []
        return f"{len(tbs)} testbenches"
    if tool_name in ("read_module", "read_testbench"):
        content = result.get("content") or ""
        return f"read {result.get('path', '')[:120]} ({len(content)} chars)"
    if tool_name in ("write_module", "write_testbench", "create_managed_testbench"):
        return f"wrote {result.get('path', '')[:120]}"
    if tool_name == "finish":
        return "finish acknowledged"
    return json.dumps(result, default=str)[:200]


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------

def start_session(
    *,
    goal: str,
    state,
    state_lock,
    simulation_service_mod,
    max_iterations: int = DEFAULT_MAX_ITERATIONS,
    model: str | None = None,
) -> AgentSession:
    api_key = resolve_api_key()
    if not api_key:
        raise AgentError(
            "Anthropic API key not configured. Set ANTHROPIC_API_KEY or save one via "
            "POST /api/agent/settings."
        )

    project_root = state.loaded_folder
    if not project_root:
        raise AgentError("No project is currently loaded.")
    if state.read_only:
        raise AgentError("Project is in read-only commit view; the agent cannot edit files in this mode.")

    if not goal or not goal.strip():
        raise AgentError("Goal cannot be empty.")

    chosen_model = (model or load_settings().get("model") or DEFAULT_MODEL).strip() or DEFAULT_MODEL

    session = AgentSession(
        id=uuid.uuid4().hex[:12],
        goal=goal.strip(),
        project_root=project_root,
        model=chosen_model,
        max_iterations=max(1, min(int(max_iterations or DEFAULT_MAX_ITERATIONS), 50)),
    )

    ctx = _ToolContext(
        project_root=project_root,
        state=state,
        state_lock=state_lock,
        simulation_service_mod=simulation_service_mod,
    )

    with _sessions_lock:
        _sessions[session.id] = session

    worker = threading.Thread(
        target=_run_agent_loop,
        args=(session, ctx, api_key),
        daemon=True,
        name=f"agent-{session.id}",
    )
    worker.start()
    return session
