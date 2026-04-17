"""LLM agent runner: design modules, run simulations, iterate toward a goal.

Supports any LLM API that speaks the OpenAI chat-completions format (OpenAI,
Ollama, Together, Groq, Mistral, LM Studio, …) plus the native Anthropic
Messages API. The provider is selected in settings; raw HTTP is used so there
are zero SDK dependencies.

Sessions are held in-process. Clients create a session with ``start_session``,
poll ``get_session_snapshot`` for new events, and optionally call
``stop_session`` to interrupt the loop between iterations. Write operations
emit an ``approval_request`` event and block until the user approves or
denies via ``resolve_approval``.

Settings (API key, provider, base_url, model) live in
``~/.veritas/settings.json`` and are writable via ``POST /api/agent/settings``.
"""

from __future__ import annotations

from collections import deque
import json
import os
import re
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import vcd_parser


SETTINGS_DIR = Path.home() / ".veritas"
SETTINGS_FILE = SETTINGS_DIR / "settings.json"

DEFAULT_MAX_ITERATIONS = 15
MAX_TOOL_RESULT_CHARS = 2500
MAX_HISTORY_MESSAGES = 12

PROVIDER_PRESETS: dict[str, dict] = {
    "openai": {
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o",
        "format": "openai",
    },
    "anthropic": {
        "label": "Anthropic",
        "base_url": "https://api.anthropic.com",
        "default_model": "claude-sonnet-4-5-20250514",
        "format": "anthropic",
    },
    "ollama": {
        "label": "Ollama (local)",
        "base_url": "http://localhost:11434/v1",
        "default_model": "llama3",
        "format": "openai",
    },
    "together": {
        "label": "Together AI",
        "base_url": "https://api.together.xyz/v1",
        "default_model": "meta-llama/Llama-3-70b-chat-hf",
        "format": "openai",
    },
    "groq": {
        "label": "Groq",
        "base_url": "https://api.groq.com/openai/v1",
        "default_model": "llama3-70b-8192",
        "format": "openai",
    },
    "custom": {
        "label": "Custom (OpenAI-compatible)",
        "base_url": "",
        "default_model": "",
        "format": "openai",
    },
}


class AgentError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

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


def _resolve_key_info() -> tuple[str, str | None]:
    settings = load_settings()
    provider = settings.get("provider", "openai")
    provider_key_fields = {
        "anthropic": ("anthropic_api_key",),
        "openai": ("openai_api_key",),
    }
    for field_name in provider_key_fields.get(provider, ()):
        key = settings.get(field_name, "")
        if isinstance(key, str) and key.strip():
            return key.strip(), f"settings:{field_name}"
    key = settings.get("api_key", "")
    if isinstance(key, str) and key.strip():
        return key.strip(), "settings:api_key"
    for env_name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "LLM_API_KEY"):
        val = os.environ.get(env_name, "").strip()
        if val:
            return val, env_name
    return "", None


def _resolve_key() -> str:
    key, _source = _resolve_key_info()
    return key


def get_settings_status() -> dict:
    s = load_settings()
    key, key_source = _resolve_key_info()
    provider = s.get("provider", "openai")
    preset = PROVIDER_PRESETS.get(provider, PROVIDER_PRESETS["custom"])
    return {
        "has_api_key": bool(key),
        "key_source": key_source,
        "has_saved_api_key": bool(isinstance(s.get("api_key"), str) and s.get("api_key", "").strip()),
        "provider": provider,
        "provider_label": preset["label"],
        "base_url": s.get("base_url") or preset.get("base_url", ""),
        "model": s.get("model") or preset.get("default_model", ""),
        "format": s.get("format") or preset.get("format", "openai"),
        "auto_approve": s.get("auto_approve", False),
        "providers": {
            k: {
                "label": v["label"],
                "default_model": v["default_model"],
                "base_url": v.get("base_url", ""),
                "format": v.get("format", "openai"),
            }
            for k, v in PROVIDER_PRESETS.items()
        },
        "settings_path": str(SETTINGS_FILE),
    }


# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------

@dataclass
class AgentEvent:
    seq: int
    ts: float
    kind: str   # status | message | tool_call | tool_result | error | done
                # navigate | approval_request | approval_resolved
    data: dict


@dataclass
class AgentSession:
    id: str
    goal: str
    project_root: str
    model: str
    max_iterations: int
    auto_approve: bool = False
    status: str = "pending"      # pending | running | awaiting_input | completed | failed | stopped
    iterations: int = 0
    final_text: str = ""
    events: list[AgentEvent] = field(default_factory=list)
    stop_requested: bool = False
    messages: list[dict] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _seq: int = 0
    # Approval mechanism
    _approval_event: threading.Event = field(default_factory=threading.Event)
    _approval_granted: bool | None = field(default=None, repr=False)
    _pending_approval: dict | None = field(default=None, repr=False)
    # Follow-up input mechanism
    _input_event: threading.Event = field(default_factory=threading.Event)
    _pending_user_message: str | None = field(default=None, repr=False)

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
                "auto_approve": self.auto_approve,
                "pending_approval": self._pending_approval,
                "events": [
                    {"seq": e.seq, "ts": e.ts, "kind": e.kind, "data": e.data}
                    for e in new
                ],
                "last_seq": self._seq,
            }

    def request_approval(self, action: str, path: str, preview: str) -> bool:
        if self.auto_approve:
            self.emit("approval_resolved", {"path": path, "action": action, "approved": True, "auto": True})
            return True
        req = {"action": action, "path": path, "preview": preview[:2000]}
        with self._lock:
            self._pending_approval = req
            self._approval_event.clear()
            self._approval_granted = None
        self.emit("approval_request", req)
        self._approval_event.wait(timeout=300)
        with self._lock:
            self._pending_approval = None
            granted = self._approval_granted
        if granted is None:
            return False
        return granted

    def resolve_approval(self, approved: bool) -> None:
        with self._lock:
            self._approval_granted = approved
        self.emit("approval_resolved", {"approved": approved})
        self._approval_event.set()


_sessions: dict[str, AgentSession] = {}
_sessions_lock = threading.Lock()


def get_session(session_id: str) -> AgentSession:
    with _sessions_lock:
        s = _sessions.get(session_id)
    if not s:
        raise AgentError(f"Unknown agent session: {session_id}")
    return s


def list_sessions() -> list[dict]:
    with _sessions_lock:
        return [
            {"id": s.id, "goal": s.goal[:200], "status": s.status,
             "iterations": s.iterations, "model": s.model}
            for s in _sessions.values()
        ]


def stop_session(session_id: str) -> dict:
    s = get_session(session_id)
    s.stop_requested = True
    s.emit("status", {"message": "Stop requested."})
    s._approval_event.set()
    s._input_event.set()
    return {"id": s.id, "stop_requested": True}


def send_user_message(session_id: str, text: str) -> dict:
    """Append a follow-up user message; resumes the loop if it's paused."""
    s = get_session(session_id)
    text = (text or "").strip()
    if not text:
        raise AgentError("Message cannot be empty.")
    if s.status in ("failed", "stopped"):
        raise AgentError(f"Session is {s.status}; start a new session.")
    with s._lock:
        s._pending_user_message = text
    s._input_event.set()
    return {"id": s.id, "queued": True}


def resolve_approval(session_id: str, approved: bool) -> dict:
    s = get_session(session_id)
    s.resolve_approval(approved)
    return {"id": s.id, "approved": approved}


# ---------------------------------------------------------------------------
# Tool definitions (neutral schema — converted per-format before sending)
# ---------------------------------------------------------------------------

_TOOLS: list[dict] = [
    {
        "name": "list_modules",
        "description": "List all Verilog module names in the project.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "get_module_info",
        "description": (
            "Get detailed info about a module: ports (name, direction, width), "
            "internal signals, submodule instantiations with port connections, "
            "and always block summaries. Use this to understand the design "
            "structure before editing."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "module_name": {"type": "string", "description": "Name of the module."},
            },
            "required": ["module_name"],
        },
    },
    {
        "name": "read_file",
        "description": "Read any file inside the project folder. Returns its text content.",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to the file."},
            },
            "required": ["path"],
        },
    },
    {
        "name": "search_files",
        "description": (
            "Search for a text pattern (plain string or regex) across all files "
            "in the project. Returns matching lines with file paths and line "
            "numbers. Use this to find where a signal is driven, where a module "
            "is instantiated, or where a define/parameter lives."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Text or regex pattern to search for.",
                },
                "glob": {
                    "type": "string",
                    "description": "Optional file glob filter, e.g. '*.v' or '*.sv'. Defaults to all Verilog files.",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum matches to return (default 40).",
                },
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "create_file",
        "description": (
            "Create a new .v or .sv file inside the project folder. "
            "Requires user approval. The project is reloaded afterwards so "
            "new modules appear in the hierarchy."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path for the new file (must be inside the project and end in .v or .sv)."},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_file",
        "description": (
            "Overwrite an existing file inside the project with new content. "
            "Requires user approval. If the file contains modules the project "
            "is re-parsed automatically."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string", "description": "Full new content of the file."},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "patch_file",
        "description": (
            "Make a targeted edit to an existing file by replacing a specific "
            "string with new content. Much more efficient than edit_file for "
            "small changes — only send the fragment you want to change. "
            "Requires user approval. The old_string must match exactly one "
            "location in the file."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path to the file."},
                "old_string": {"type": "string", "description": "Exact text to find in the file (must be unique)."},
                "new_string": {"type": "string", "description": "Replacement text."},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
    {
        "name": "list_testbenches",
        "description": "List testbench files known to the project (managed and discovered).",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "create_testbench",
        "description": (
            "Create a new testbench under <project>/testbenches/ by file name. "
            "Returns the absolute path."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "File name, e.g. 'tb_uart_rx'."},
                "content": {"type": "string"},
            },
            "required": ["name", "content"],
        },
    },
    {
        "name": "run_simulation",
        "description": (
            "Compile the project with a testbench using Icarus Verilog and run it. "
            "Returns verdict (pass/fail/unknown), counters, stdout/stderr excerpts. "
            "ALWAYS run this to check your work. "
            "Use plusargs to pass +key=value flags to vvp (e.g. +test=fifo_write "
            "to run a specific test if the testbench supports $test$plusargs or $value$plusargs)."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "testbench_path": {"type": "string"},
                "top_module": {"type": "string", "description": "Optional top-module override."},
                "timeout_sec": {"type": "number", "description": "Timeout in seconds (default 30)."},
                "plusargs": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Optional vvp plusargs, e.g. [\"+test=fifo_write\", \"+verbose\"]. "
                        "These are passed directly to vvp before the .vvp file."
                    ),
                },
            },
            "required": ["testbench_path"],
        },
    },
    {
        "name": "read_waveform",
        "description": (
            "Read signal values from the most recent VCD waveform. "
            "Use this after a failing simulation to inspect actual signal values "
            "at specific timestamps. You can request snapshots at exact times "
            "(e.g. failure timestamps from test_events) or get a window of all "
            "signal transitions around a point of interest. "
            "Use signal_filter to focus on relevant signals (e.g. ['clk', 'out', 'expected'])."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "vcd_path": {
                    "type": "string",
                    "description": "Path to the VCD file (from the simulation result's vcd_path).",
                },
                "times": {
                    "type": "array",
                    "items": {"type": "integer"},
                    "description": "Simulation timestamps to snapshot signal values at.",
                },
                "window_center": {
                    "type": "integer",
                    "description": (
                        "If provided instead of times, returns all signal transitions "
                        "in a window around this timestamp."
                    ),
                },
                "window_size": {
                    "type": "integer",
                    "description": "Half-width of the window in simulation time units (default 20).",
                },
                "signal_filter": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Only include signals whose name contains one of these substrings "
                        "(case-insensitive). E.g. ['data_out', 'expected', 'clk']."
                    ),
                },
            },
            "required": ["vcd_path"],
        },
    },
    {
        "name": "finish",
        "description": "End the session with a summary. Call when the goal is met or impossible.",
        "parameters": {
            "type": "object",
            "properties": {
                "summary": {"type": "string"},
                "success": {"type": "boolean"},
            },
            "required": ["summary", "success"],
        },
    },
]


def _tools_openai() -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": t["name"],
                "description": t["description"],
                "parameters": t["parameters"],
            },
        }
        for t in _TOOLS
    ]


def _tools_anthropic() -> list[dict]:
    return [
        {
            "name": t["name"],
            "description": t["description"],
            "input_schema": t["parameters"],
        }
        for t in _TOOLS
    ]


# ---------------------------------------------------------------------------
# Tool dispatcher
# ---------------------------------------------------------------------------

def _truncate(text: str, limit: int = MAX_TOOL_RESULT_CHARS) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return f"{text[:half]}\n…[{len(text) - limit} chars truncated]…\n{text[-half:]}"


def _content_text_len(content: Any) -> int:
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        total = 0
        for item in content:
            if isinstance(item, dict):
                total += len(str(item.get("text", "")))
                total += len(str(item.get("content", "")))
                total += len(json.dumps(item.get("input") or {}, default=str))
            else:
                total += len(str(item))
        return total
    if content is None:
        return 0
    return len(str(content))


def _prepare_messages_for_api(messages: list[dict], *, is_anthropic: bool) -> list[dict]:
    """Trim older history to reduce repeated input-token load."""
    if len(messages) <= MAX_HISTORY_MESSAGES + 1:
        return messages

    head = messages[:1]
    tail = messages[-MAX_HISTORY_MESSAGES:]
    omitted = messages[1:-MAX_HISTORY_MESSAGES]
    omitted_chars = sum(_content_text_len(msg.get("content")) for msg in omitted)
    note = (
        f"Earlier conversation history was compacted to reduce token usage. "
        f"Omitted {len(omitted)} prior messages totaling about {omitted_chars} characters. "
        f"Use the remaining recent context and re-read files or rerun tools if older details are needed."
    )
    return head + [{"role": "user", "content": note}] + tail


def _failure_snapshots(vcd_path: str | None, events: list) -> list[dict]:
    """Auto-extract signal values at failure timestamps from the VCD.

    Returns a compact list of snapshots the agent can use immediately to
    understand what went wrong, without needing a separate tool call.
    """
    if not vcd_path:
        return []
    fail_times = []
    for ev in events:
        t = ev.get("time") if isinstance(ev, dict) else getattr(ev, "time", None)
        v = ev.get("verdict") if isinstance(ev, dict) else getattr(ev, "verdict", None)
        if v in ("fail", "error", "fatal") and t is not None:
            fail_times.append(int(t))
    if not fail_times:
        return []
    # Deduplicate and cap to avoid huge payloads
    fail_times = sorted(set(fail_times))[:10]
    try:
        vcd = vcd_parser.parse_vcd(vcd_path)
        return vcd_parser.snapshot_at(vcd, fail_times, max_signals=30)
    except Exception:
        return []


def _summarize_sim(result: dict) -> dict:
    events = result.get("test_events") or []
    messages = result.get("messages") or []
    vcd_path = result.get("vcd_path")

    summary = {
        "status": result.get("status"),
        "verdict": result.get("verdict"),
        "verdict_reason": result.get("verdict_reason"),
        "pass_count": result.get("pass_count"),
        "fail_count": result.get("fail_count"),
        "error_count": result.get("error_count"),
        "fatal_count": result.get("fatal_count"),
        "warning_count": result.get("warning_count"),
        "exit_code": result.get("exit_code"),
        "timed_out": result.get("timed_out"),
        "vcd_path": vcd_path,
        "testbench": result.get("testbench"),
        "compile_stderr": _truncate(result.get("compile_stderr") or "", 2000),
        "run_stdout": _truncate(result.get("run_stdout") or "", 2000),
        "run_stderr": _truncate(result.get("run_stderr") or "", 1000),
        "test_events": events[:30],
        "messages": messages[:30],
    }

    # Auto-attach signal snapshots at failure timestamps so the agent can
    # immediately see actual signal values without an extra tool call.
    if result.get("fail_count", 0) > 0 or result.get("error_count", 0) > 0:
        snaps = _failure_snapshots(vcd_path, events)
        if snaps:
            summary["failure_waveform_snapshots"] = snaps

    return summary


def _sandbox_path(project_root: str, path: str) -> Path:
    root = Path(project_root).resolve()
    candidate = Path(path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise AgentError(f"Path is outside the project: {path}") from exc
    return candidate


class _Ctx:
    def __init__(self, project_root, state, state_lock, sim_mod):
        self.project_root = project_root
        self.state = state
        self.state_lock = state_lock
        self.sim = sim_mod


def _dispatch(ctx: _Ctx, session: AgentSession, name: str, args: dict) -> tuple[dict, str | None]:
    """Returns (result_dict, navigate_target_or_None)."""
    nav = None
    try:
        if name == "list_modules":
            with ctx.state_lock:
                mods = ctx.state.service.get_module_names()
            nav = "modules"
            return {"modules": mods}, nav

        if name == "get_module_info":
            mod_name = str(args.get("module_name", "")).strip()
            with ctx.state_lock:
                try:
                    m = ctx.state.service.get_module(mod_name)
                except (RuntimeError, ValueError):
                    return {"error": f"Module not found: {mod_name}"}, None
            info: dict[str, Any] = {
                "name": m.name,
                "source_file": m.source_file,
                "ports": [
                    {"name": p.name, "direction": p.direction,
                     "width": p.width or "1", "bit_width": p.bit_width}
                    for p in m.ports
                ],
                "signals": [
                    {"name": s.name, "kind": s.kind,
                     "width": s.width or "1", "bit_width": s.bit_width}
                    for s in m.signals[:60]
                ],
                "instances": [
                    {"name": inst.name, "module_name": inst.module_name,
                     "connections": inst.connections}
                    for inst in m.instances[:30]
                ],
                "always_blocks": [
                    {"name": ab.name, "kind": ab.kind,
                     "sensitivity": ab.sensitivity,
                     "written_signals": ab.written_signals,
                     "read_signals": ab.read_signals,
                     "summary": ab.summary_lines[:4]}
                    for ab in m.always_blocks[:20]
                ],
            }
            nav = f"module:{mod_name}"
            return info, nav

        if name == "search_files":
            pattern = str(args.get("pattern", ""))
            if not pattern:
                return {"error": "pattern is required."}, None
            file_glob = args.get("glob") or "*.v,*.sv,*.vh,*.svh"
            max_results = int(args.get("max_results") or 40)
            root = Path(ctx.project_root)
            matches = []
            globs = [g.strip() for g in file_glob.split(",")]
            try:
                compiled = re.compile(pattern)
            except re.error:
                compiled = re.compile(re.escape(pattern))
            for g in globs:
                for fpath in root.rglob(g):
                    if not fpath.is_file():
                        continue
                    try:
                        text = fpath.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        continue
                    for line_no, line in enumerate(text.splitlines(), 1):
                        if compiled.search(line):
                            matches.append({
                                "file": str(fpath),
                                "line": line_no,
                                "text": line.rstrip()[:200],
                            })
                            if len(matches) >= max_results:
                                break
                    if len(matches) >= max_results:
                        break
                if len(matches) >= max_results:
                    break
            return {"pattern": pattern, "match_count": len(matches), "matches": matches}, None

        if name == "read_file":
            p = _sandbox_path(ctx.project_root, str(args.get("path", "")))
            if not p.exists():
                return {"error": f"File not found: {p}"}, None
            content = p.read_text(encoding="utf-8", errors="replace")
            # Try to figure out if it's a module source and navigate there
            stem = p.stem
            with ctx.state_lock:
                try:
                    ctx.state.service.get_module(stem)
                    nav = f"module:{stem}"
                except (RuntimeError, ValueError):
                    pass
            return {"path": str(p), "content": content}, nav

        if name == "create_file":
            p = _sandbox_path(ctx.project_root, str(args.get("path", "")))
            if p.suffix.lower() not in (".v", ".sv"):
                return {"error": "Only .v and .sv files can be created."}, None
            if p.exists():
                return {"error": f"File already exists: {p}. Use edit_file instead."}, None
            content = args.get("content") or ""
            preview = _truncate(content, 600)
            if not session.request_approval("create_file", str(p), preview):
                return {"error": "User denied file creation."}, None
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content, encoding="utf-8")
            # Reload project to pick up new modules
            with ctx.state_lock:
                if ctx.state.loaded_folder:
                    ctx.state.service.load_project(ctx.state.loaded_folder)
            nav = "refresh"
            return {"created": True, "path": str(p)}, nav

        if name == "edit_file":
            p = _sandbox_path(ctx.project_root, str(args.get("path", "")))
            if not p.exists():
                return {"error": f"File not found: {p}. Use create_file for new files."}, None
            content = args.get("content") or ""
            preview = _truncate(content, 600)
            if not session.request_approval("edit_file", str(p), preview):
                return {"error": "User denied file edit."}, None
            p.write_text(content, encoding="utf-8")
            # Trigger reparse if it's a known source
            with ctx.state_lock:
                try:
                    report = ctx.state.service.reparse_file(str(p))
                    if report.get("requires_full_reparse") and ctx.state.loaded_folder:
                        ctx.state.service.load_project(ctx.state.loaded_folder)
                except Exception:
                    if ctx.state.loaded_folder:
                        try:
                            ctx.state.service.load_project(ctx.state.loaded_folder)
                        except Exception:
                            pass
            # Navigate to the module if we can identify it
            stem = p.stem
            with ctx.state_lock:
                try:
                    ctx.state.service.get_module(stem)
                    nav = f"editor:{stem}"
                except (RuntimeError, ValueError):
                    nav = "refresh"
            return {"saved": True, "path": str(p)}, nav

        if name == "patch_file":
            p = _sandbox_path(ctx.project_root, str(args.get("path", "")))
            if not p.exists():
                return {"error": f"File not found: {p}. Use create_file for new files."}, None
            old_str = args.get("old_string") or ""
            new_str = args.get("new_string") or ""
            if not old_str:
                return {"error": "old_string is required and must not be empty."}, None
            content = p.read_text(encoding="utf-8", errors="replace")
            count = content.count(old_str)
            if count == 0:
                return {"error": "old_string not found in file. Read the file first to get the exact text."}, None
            if count > 1:
                return {"error": f"old_string matches {count} locations. Provide a larger, unique snippet."}, None
            new_content = content.replace(old_str, new_str, 1)
            # Build a compact diff preview for approval
            preview = f"--- {p.name}\n+++ {p.name}\n"
            old_lines = old_str.splitlines(keepends=True)
            new_lines = new_str.splitlines(keepends=True)
            for ln in old_lines:
                preview += f"- {ln}"
            if old_lines and not old_lines[-1].endswith("\n"):
                preview += "\n"
            for ln in new_lines:
                preview += f"+ {ln}"
            if new_lines and not new_lines[-1].endswith("\n"):
                preview += "\n"
            preview = _truncate(preview, 600)
            if not session.request_approval("patch_file", str(p), preview):
                return {"error": "User denied file patch."}, None
            p.write_text(new_content, encoding="utf-8")
            # Trigger reparse
            with ctx.state_lock:
                try:
                    report = ctx.state.service.reparse_file(str(p))
                    if report.get("requires_full_reparse") and ctx.state.loaded_folder:
                        ctx.state.service.load_project(ctx.state.loaded_folder)
                except Exception:
                    if ctx.state.loaded_folder:
                        try:
                            ctx.state.service.load_project(ctx.state.loaded_folder)
                        except Exception:
                            pass
            stem = p.stem
            with ctx.state_lock:
                try:
                    ctx.state.service.get_module(stem)
                    nav = f"editor:{stem}"
                except (RuntimeError, ValueError):
                    nav = "refresh"
            return {"patched": True, "path": str(p)}, nav

        if name == "list_testbenches":
            return {"testbenches": ctx.sim.list_testbenches(ctx.project_root)}, None

        if name == "create_testbench":
            tb_name = str(args.get("name", "")).strip()
            content = args.get("content")
            info = ctx.sim.create_managed_testbench(ctx.project_root, tb_name, content)
            nav = f"testbench:{info.get('path', '')}"
            return {"created": True, **info}, nav

        if name == "run_simulation":
            tb_path = str(args.get("testbench_path", "")).strip()
            top_module = args.get("top_module") or None
            timeout_sec = float(args.get("timeout_sec") or 30.0)
            plusargs = args.get("plusargs") or []
            nav = f"simulate:{tb_path}"
            result = ctx.sim.run_simulation(
                ctx.project_root, tb_path,
                top_module=top_module, timeout_sec=timeout_sec,
                plusargs=plusargs,
            )
            ctx.sim.prune_old_runs(ctx.project_root, keep=10)
            full = ctx.sim.result_to_dict(result)
            return _summarize_sim(full), nav

        if name == "read_waveform":
            vcd_path = str(args.get("vcd_path", "")).strip()
            p = _sandbox_path(ctx.project_root, vcd_path)
            if not p.exists():
                return {"error": f"VCD file not found: {p}"}, None
            vcd = vcd_parser.parse_vcd(str(p))
            sig_filter = args.get("signal_filter") or None

            window_center = args.get("window_center")
            if window_center is not None:
                window_size = int(args.get("window_size") or 20)
                changes = vcd_parser.waveform_window(
                    vcd, int(window_center), window=window_size,
                    signal_filter=sig_filter,
                )
                return {
                    "mode": "window",
                    "center": int(window_center),
                    "window_size": window_size,
                    "timescale": vcd.get("timescale", ""),
                    "changes": changes[:200],
                }, None

            times = args.get("times") or []
            if not times:
                return {"error": "Provide either 'times' or 'window_center'."}, None
            snapshots = vcd_parser.snapshot_at(
                vcd, [int(t) for t in times], signal_filter=sig_filter,
            )
            return {
                "mode": "snapshot",
                "timescale": vcd.get("timescale", ""),
                "snapshots": snapshots,
            }, None

        if name == "finish":
            return {"acknowledged": True}, None

        return {"error": f"Unknown tool: {name}"}, None

    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}, None


def _tool_detail(name: str, args: dict, result: dict) -> dict:
    """Small structured detail for the UI (kept compact to avoid noise)."""
    if result.get("error"):
        return {"error": str(result["error"])[:240]}
    if name == "run_simulation":
        return {
            "verdict": result.get("verdict"),
            "pass_count": result.get("pass_count"),
            "fail_count": result.get("fail_count"),
            "error_count": result.get("error_count"),
            "status": result.get("status"),
            "testbench": result.get("testbench") or args.get("testbench_path"),
            "vcd_path": result.get("vcd_path"),
        }
    if name == "list_modules":
        mods = result.get("modules") or []
        return {"count": len(mods), "preview": mods[:8]}
    if name == "list_testbenches":
        tbs = result.get("testbenches") or []
        return {
            "count": len(tbs),
            "preview": [t.get("name") for t in tbs[:8] if isinstance(t, dict)],
        }
    if name == "read_file":
        content = result.get("content") or ""
        return {
            "path": result.get("path"),
            "chars": len(content),
            "lines": content.count("\n") + (1 if content else 0),
        }
    if name in ("edit_file", "create_file", "create_testbench"):
        return {"path": result.get("path")}
    if name == "patch_file":
        return {"path": result.get("path")}
    if name == "get_module_info":
        ports = result.get("ports") or []
        instances = result.get("instances") or []
        return {
            "module": result.get("name"),
            "port_count": len(ports),
            "instance_count": len(instances),
            "ports_preview": [f"{p['direction']} {p['name']}" for p in ports[:6]],
        }
    if name == "search_files":
        return {
            "pattern": result.get("pattern"),
            "match_count": result.get("match_count", 0),
        }
    if name == "finish":
        return {"summary": str(args.get("summary", ""))[:240], "success": bool(args.get("success"))}
    return {}


def _short_summary(name: str, result: dict) -> str:
    if result.get("error"):
        return f"error: {str(result['error'])[:200]}"
    if name == "run_simulation":
        return (
            f"verdict={result.get('verdict')} "
            f"pass={result.get('pass_count')} fail={result.get('fail_count')} "
            f"errors={result.get('error_count')} status={result.get('status')}"
        )
    if name == "list_modules":
        return f"{len(result.get('modules', []))} modules"
    if name == "list_testbenches":
        return f"{len(result.get('testbenches', []))} testbenches"
    if name in ("read_file",):
        return f"read {result.get('path', '')[:120]} ({len(result.get('content', ''))} chars)"
    if name in ("edit_file", "create_file", "create_testbench"):
        return f"wrote {result.get('path', '')[:120]}"
    if name == "patch_file":
        return f"patched {result.get('path', '')[:120]}"
    if name == "get_module_info":
        ports = result.get("ports") or []
        insts = result.get("instances") or []
        return f"{result.get('name')}: {len(ports)} ports, {len(insts)} instances"
    if name == "search_files":
        return f"{result.get('match_count', 0)} matches for '{result.get('pattern', '')[:60]}'"
    if name == "finish":
        return "finish"
    return json.dumps(result, default=str)[:200]


# ---------------------------------------------------------------------------
# LLM HTTP client (stdlib only — zero SDK dependencies)
# ---------------------------------------------------------------------------

_MAX_RETRIES = 3
_RETRY_DELAYS = [2, 5, 15]   # seconds, one per retry
_ANTHROPIC_INPUT_TPM_LIMIT = 28000
_TOKEN_WINDOW_SECONDS = 60.0
_TPM_RESERVE_POLL_SECONDS = 1.0
_anthropic_input_window: deque[dict[str, float]] = deque()
_anthropic_input_lock = threading.Lock()


def _prune_token_window(window: deque[dict[str, float]], now: float) -> None:
    cutoff = now - _TOKEN_WINDOW_SECONDS
    while window and window[0]["ts"] < cutoff:
        window.popleft()


def _estimate_tokens_from_payload(payload: dict) -> int:
    text = json.dumps(payload, default=str, separators=(",", ":"))
    # Conservative approximation: roughly 1 token per 3 chars for mixed JSON/text.
    return max(1, (len(text) + 2) // 3)


def _reserve_anthropic_input_tokens(estimated_tokens: int) -> dict[str, float]:
    while True:
        now = time.time()
        with _anthropic_input_lock:
            _prune_token_window(_anthropic_input_window, now)
            used = sum(item["tokens"] for item in _anthropic_input_window)
            if used + estimated_tokens <= _ANTHROPIC_INPUT_TPM_LIMIT:
                record = {"ts": now, "tokens": float(estimated_tokens)}
                _anthropic_input_window.append(record)
                return record
            wait_for = max(_TPM_RESERVE_POLL_SECONDS, _TOKEN_WINDOW_SECONDS - (now - _anthropic_input_window[0]["ts"]))
        time.sleep(min(wait_for, _TPM_RESERVE_POLL_SECONDS))


def _finalize_anthropic_input_tokens(record: dict[str, float], actual_tokens: int | None) -> None:
    if actual_tokens is None or actual_tokens <= 0:
        return
    with _anthropic_input_lock:
        record["tokens"] = float(actual_tokens)


def _http_json(url: str, *, headers: dict, body: dict, timeout: float = 120) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    last_exc: Exception | None = None
    for attempt in range(_MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            if exc.code == 429:
                delay = _RETRY_DELAYS[min(attempt, len(_RETRY_DELAYS) - 1)]
                last_exc = RuntimeError(f"Rate limited (429). Retrying in {delay}s… {raw[:300]}")
                time.sleep(delay)
                continue
            raise RuntimeError(f"HTTP {exc.code}: {raw[:600]}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Connection error: {exc.reason}") from exc
    raise last_exc or RuntimeError("Max retries exceeded.")


def _call_openai(
    *, base_url: str, api_key: str, model: str,
    system: str, messages: list[dict], tools: list[dict],
) -> tuple[str | None, list[dict]]:
    """Returns (text_or_None, tool_calls_list).

    Each tool_call is {"id": str, "name": str, "arguments": dict}.
    """
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "system", "content": system}] + messages,
        "max_completion_tokens": 4096,
    }
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    resp = _http_json(url, headers=headers, body=body)
    choice = resp.get("choices", [{}])[0]
    msg = choice.get("message", {})
    text = msg.get("content")
    raw_calls = msg.get("tool_calls") or []
    calls = []
    for tc in raw_calls:
        fn = tc.get("function", {})
        try:
            parsed_args = json.loads(fn.get("arguments") or "{}")
        except json.JSONDecodeError:
            parsed_args = {}
        calls.append({"id": tc.get("id", uuid.uuid4().hex[:8]), "name": fn.get("name", ""), "arguments": parsed_args})
    return text, calls


def _openai_tool_results(tool_calls: list[dict], results: list[dict]) -> list[dict]:
    msgs = []
    for tc, res in zip(tool_calls, results):
        msgs.append({
            "role": "tool",
            "tool_call_id": tc["id"],
            "content": res["content"],
        })
    return msgs


def _call_anthropic(
    *, base_url: str, api_key: str, model: str,
    system: str, messages: list[dict], tools: list[dict],
) -> tuple[str | None, list[dict]]:
    url = f"{base_url.rstrip('/')}/v1/messages"
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    body: dict[str, Any] = {
        "model": model,
        "system": system,
        "messages": messages,
        "max_tokens": 4096,
    }
    if tools:
        body["tools"] = tools
    reservation = _reserve_anthropic_input_tokens(_estimate_tokens_from_payload(body))
    resp = _http_json(url, headers=headers, body=body)
    usage = resp.get("usage") or {}
    _finalize_anthropic_input_tokens(reservation, usage.get("input_tokens"))
    text_parts = []
    calls = []
    for block in resp.get("content", []):
        if block.get("type") == "text":
            text_parts.append(block["text"])
        elif block.get("type") == "tool_use":
            calls.append({
                "id": block["id"],
                "name": block["name"],
                "arguments": block.get("input") or {},
            })
    text = "\n\n".join(text_parts) if text_parts else None
    return text, calls


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are a Verilog/SystemVerilog design agent inside a user's RTL project.

You can: create new modules, edit existing files, write testbenches, compile
and run simulations (Icarus Verilog), inspect waveforms, and iterate until
all tests pass.

COMMUNICATION — Always briefly explain what you are about to do and why before
calling tools. After a tool returns, summarize what you learned or what changed.
The user is watching your progress in real time; keep them informed so they
understand your reasoning. For example:
  "The testbench is failing at t=500. Let me check the waveform to see what
   data_out actually is at that point."
  "The counter resets at 2 instead of 4 — the comparison uses == 2 but should
   use == 3 (0-indexed). I'll patch that line."
Keep explanations short (1-3 sentences) — do not write essays.

Rules:
1. Orient first — call list_modules and get_module_info on key modules to
   understand ports, signals, and submodule structure. Use search_files to
   find where signals are driven or modules instantiated.
2. Read before editing — call read_file to see current source.
3. Prefer patch_file over edit_file for targeted changes. Use edit_file only
   when rewriting most of a file. patch_file is cheaper and less error-prone.
4. Write clean, synthesizable RTL. Testbenches should emit:
     $display("PASS [t=%0t] <label>")  or  $display("FAIL [t=%0t] <detail>").
   Include expected and actual values in FAIL messages, e.g.:
     $display("FAIL [t=%0t] data_out: got %h, expected %h", $time, data_out, expected);
   When writing testbenches that have multiple test scenarios, support plusargs
   so individual tests can be run:
     if ($test$plusargs("test_write")) begin ... end
5. After edits, run_simulation. The verdict is ground truth. You can pass
   plusargs (e.g. ["+test=fifo_write"]) to run a subset of tests.
6. On failure, **diagnose before fixing**:
   - The simulation result includes failure_waveform_snapshots — a snapshot of
     ALL signal values at each failure timestamp. Study these to understand
     the actual state of the design at the moment of failure.
   - For deeper investigation, call read_waveform with specific timestamps or
     a window_center to see signal transitions over time. Use signal_filter
     to focus on relevant signals.
   - Use search_files to trace signal drivers across the design if the issue
     spans multiple modules.
   - Identify the root cause from actual signal values before editing code.
     Do not guess — let the waveform data guide your fix.
7. Call finish when done or blocked.

File write operations (create_file, edit_file, patch_file) require user approval.
Do NOT ask the user for approval in normal assistant text.
If you need to change a file, call the tool directly.
The system will pause and show an approval_request event automatically.
After approval, continue with the edit and then run_simulation.
If approval is denied, explain the blockage briefly and then call finish."""


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

def _run_loop(session: AgentSession, ctx: _Ctx, api_key: str,
              base_url: str, api_format: str) -> None:
    try:
        is_anthropic = api_format == "anthropic"
        tools = _tools_anthropic() if is_anthropic else _tools_openai()
        call_fn = _call_anthropic if is_anthropic else _call_openai

        # Seed with the initial goal as the first user message.
        initial_user = (
            f"Goal: {session.goal}\n\nProject root: {session.project_root}\n\nBegin."
        )
        session.messages.append({"role": "user", "content": initial_user})
        session.emit("user_message", {"text": session.goal, "initial": True})
        session.emit("status", {"message": f"Agent started · {session.model} via {api_format}."})
        session.status = "running"

        while not session.stop_requested:
            turn_iterations = 0
            turn_finished = False
            session.iterations = 0

            while (
                turn_iterations < session.max_iterations
                and not turn_finished
                and not session.stop_requested
            ):
                turn_iterations += 1
                session.iterations = turn_iterations
                session.emit(
                    "status",
                    {"iteration": turn_iterations, "message": f"Iteration {turn_iterations}"},
                )

                try:
                    api_messages = _prepare_messages_for_api(
                        session.messages,
                        is_anthropic=is_anthropic,
                    )
                    text, tool_calls = call_fn(
                        base_url=base_url, api_key=api_key, model=session.model,
                        system=SYSTEM_PROMPT, messages=api_messages, tools=tools,
                    )
                except Exception as exc:
                    session.status = "failed"
                    session.emit("error", {"message": f"LLM API error: {exc}"})
                    session.emit("done", {"status": session.status})
                    return

                if text:
                    session.emit("message", {"role": "assistant", "text": text})

                # Append assistant message to conversation history
                if is_anthropic:
                    acontent: list[dict] = []
                    if text:
                        acontent.append({"type": "text", "text": text})
                    for tc in tool_calls:
                        acontent.append({
                            "type": "tool_use", "id": tc["id"],
                            "name": tc["name"], "input": tc["arguments"],
                        })
                    session.messages.append({"role": "assistant", "content": acontent})
                else:
                    amsg: dict[str, Any] = {"role": "assistant", "content": text or None}
                    if tool_calls:
                        amsg["tool_calls"] = [
                            {
                                "id": tc["id"],
                                "type": "function",
                                "function": {
                                    "name": tc["name"],
                                    "arguments": json.dumps(tc["arguments"]),
                                },
                            }
                            for tc in tool_calls
                        ]
                    session.messages.append(amsg)

                if not tool_calls:
                    session.final_text = text or ""
                    turn_finished = True
                    break

                results_for_history: list[dict] = []
                for tc in tool_calls:
                    if session.stop_requested:
                        break

                    session.emit("tool_call", {
                        "id": tc["id"], "name": tc["name"], "input": tc["arguments"],
                    })
                    result, nav = _dispatch(ctx, session, tc["name"], tc["arguments"])
                    detail = _tool_detail(tc["name"], tc["arguments"], result)
                    session.emit("tool_result", {
                        "id": tc["id"], "name": tc["name"],
                        "summary": _short_summary(tc["name"], result),
                        "detail": detail,
                        "is_error": bool(result.get("error")),
                    })
                    if nav:
                        nav_data: dict = {"target": nav}
                        if tc["name"] == "run_simulation":
                            nav_data["vcd_path"] = result.get("vcd_path")
                            nav_data["testbench_path"] = tc["arguments"].get("testbench_path")
                            nav_data["verdict"] = result.get("verdict")
                        session.emit("navigate", nav_data)

                    payload = _truncate(json.dumps(result, default=str))
                    is_err = bool(result.get("error"))

                    if is_anthropic:
                        results_for_history.append({
                            "type": "tool_result",
                            "tool_use_id": tc["id"],
                            "content": payload,
                            "is_error": is_err,
                        })
                    else:
                        results_for_history.append({
                            "role": "tool",
                            "tool_call_id": tc["id"],
                            "content": payload,
                        })

                    if tc["name"] == "finish":
                        turn_finished = True
                        inp = tc["arguments"]
                        session.final_text = str(inp.get("summary", ""))

                if is_anthropic:
                    session.messages.append({"role": "user", "content": results_for_history})
                else:
                    session.messages.extend(results_for_history)

            if session.stop_requested:
                session.status = "stopped"
                session.emit("status", {"message": "Stopped by user."})
                break

            if not turn_finished:
                session.emit("status", {
                    "message": f"Max iterations ({session.max_iterations}) reached this turn.",
                })

            # Pause for the user to send a follow-up message.
            session.status = "awaiting_input"
            session.emit("awaiting_input", {"message": "Waiting for your next message."})
            session._input_event.clear()
            session._input_event.wait()

            if session.stop_requested:
                session.status = "stopped"
                session.emit("status", {"message": "Stopped by user."})
                break

            with session._lock:
                follow_up = session._pending_user_message
                session._pending_user_message = None

            if not follow_up:
                # Spurious wakeup — loop and wait again.
                continue

            session.messages.append({"role": "user", "content": follow_up})
            session.emit("user_message", {"text": follow_up, "initial": False})
            session.status = "running"
            # continue outer loop → next turn

        session.emit("done", {"status": session.status, "final_text": session.final_text})

    except Exception as exc:
        session.status = "failed"
        session.emit("error", {"message": f"Agent crashed: {exc}", "traceback": traceback.format_exc()})
        session.emit("done", {"status": session.status})


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def start_session(
    *, goal: str, state, state_lock, simulation_service_mod,
    max_iterations: int = DEFAULT_MAX_ITERATIONS,
    model: str | None = None,
    provider: str | None = None,
    auto_approve: bool = False,
) -> AgentSession:
    api_key = _resolve_key()
    s = load_settings()
    prov = provider or s.get("provider", "openai")
    preset = PROVIDER_PRESETS.get(prov, PROVIDER_PRESETS["custom"])
    base_url = s.get("base_url") or preset.get("base_url", "")
    api_format = s.get("format") or preset.get("format", "openai")
    chosen_model = (model or s.get("model") or preset.get("default_model", "")).strip()

    if not base_url:
        raise AgentError("No API base URL configured. Set one in Agent settings.")
    if prov not in ("ollama",) and not api_key:
        raise AgentError("No API key configured. Set one in Agent settings or via environment variable.")
    if not chosen_model:
        raise AgentError("No model configured.")

    project_root = state.loaded_folder
    if not project_root:
        raise AgentError("No project is currently loaded.")
    if state.read_only:
        raise AgentError("Project is in read-only commit view.")
    if not goal or not goal.strip():
        raise AgentError("Goal cannot be empty.")

    session = AgentSession(
        id=uuid.uuid4().hex[:12],
        goal=goal.strip(),
        project_root=project_root,
        model=chosen_model,
        max_iterations=max(1, min(int(max_iterations or DEFAULT_MAX_ITERATIONS), 50)),
        auto_approve=auto_approve,
    )

    ctx = _Ctx(project_root, state, state_lock, simulation_service_mod)

    with _sessions_lock:
        _sessions[session.id] = session

    threading.Thread(
        target=_run_loop,
        args=(session, ctx, api_key, base_url, api_format),
        daemon=True,
        name=f"agent-{session.id}",
    ).start()
    return session
