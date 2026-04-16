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


SETTINGS_DIR = Path.home() / ".veritas"
SETTINGS_FILE = SETTINGS_DIR / "settings.json"

DEFAULT_MAX_ITERATIONS = 15
MAX_TOOL_RESULT_CHARS = 6000

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
    key = settings.get("api_key", "")
    if isinstance(key, str) and key.strip():
        return key.strip(), "settings"
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
        "providers": {k: {"label": v["label"], "default_model": v["default_model"]} for k, v in PROVIDER_PRESETS.items()},
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
    status: str = "pending"      # pending | running | completed | failed | stopped
    iterations: int = 0
    final_text: str = ""
    events: list[AgentEvent] = field(default_factory=list)
    stop_requested: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _seq: int = 0
    # Approval mechanism
    _approval_event: threading.Event = field(default_factory=threading.Event)
    _approval_granted: bool | None = field(default=None, repr=False)
    _pending_approval: dict | None = field(default=None, repr=False)

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
    return {"id": s.id, "stop_requested": True}


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
            "ALWAYS run this to check your work."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "testbench_path": {"type": "string"},
                "top_module": {"type": "string", "description": "Optional top-module override."},
                "timeout_sec": {"type": "number", "description": "Timeout in seconds (default 30)."},
            },
            "required": ["testbench_path"],
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


def _summarize_sim(result: dict) -> dict:
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
        "warning_count": result.get("warning_count"),
        "exit_code": result.get("exit_code"),
        "timed_out": result.get("timed_out"),
        "compile_stderr": _truncate(result.get("compile_stderr") or "", 2000),
        "run_stdout": _truncate(result.get("run_stdout") or "", 2000),
        "run_stderr": _truncate(result.get("run_stderr") or "", 1000),
        "test_events": events[:30],
        "messages": messages[:30],
    }


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
            nav = f"simulate:{tb_path}"
            result = ctx.sim.run_simulation(
                ctx.project_root, tb_path,
                top_module=top_module, timeout_sec=timeout_sec,
            )
            ctx.sim.prune_old_runs(ctx.project_root, keep=10)
            full = ctx.sim.result_to_dict(result)
            return _summarize_sim(full), nav

        if name == "finish":
            return {"acknowledged": True}, None

        return {"error": f"Unknown tool: {name}"}, None

    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}, None


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
    if name == "finish":
        return "finish"
    return json.dumps(result, default=str)[:200]


# ---------------------------------------------------------------------------
# LLM HTTP client (stdlib only — zero SDK dependencies)
# ---------------------------------------------------------------------------

_MAX_RETRIES = 3
_RETRY_DELAYS = [2, 5, 15]   # seconds, one per retry


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
    resp = _http_json(url, headers=headers, body=body)
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
and run simulations (Icarus Verilog), and iterate until all tests pass.

Rules:
1. Orient first — call list_modules or list_testbenches.
2. Read before editing — call read_file to see current source.
3. Write clean, synthesizable RTL. Testbenches should emit:
     $display("PASS [t=%0t] <label>")  or  $display("FAIL [t=%0t] <detail>").
4. After edits, run_simulation. The verdict is ground truth.
5. On failure, read errors carefully and fix the root cause.
6. Call finish when done or blocked.

File write operations (create_file, edit_file) require user approval.
Do NOT ask the user for approval in normal assistant text.
If you need to change a file, call create_file or edit_file directly.
The system will pause and show an approval_request event automatically.
After approval, continue with the edit and then run_simulation.
If approval is denied, explain the blockage briefly and then call finish.
Keep messages concise — let tools do the work."""


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

def _run_loop(session: AgentSession, ctx: _Ctx, api_key: str,
              base_url: str, api_format: str) -> None:
    try:
        is_anthropic = api_format == "anthropic"
        tools = _tools_anthropic() if is_anthropic else _tools_openai()
        call_fn = _call_anthropic if is_anthropic else _call_openai

        if is_anthropic:
            messages: list[dict] = [
                {"role": "user", "content": f"Goal: {session.goal}\n\nProject root: {session.project_root}\n\nBegin."},
            ]
        else:
            messages = [
                {"role": "user", "content": f"Goal: {session.goal}\n\nProject root: {session.project_root}\n\nBegin."},
            ]

        session.status = "running"
        session.emit("status", {"message": f"Agent started · {session.model} via {api_format}."})

        finished = False

        while session.iterations < session.max_iterations and not finished:
            if session.stop_requested:
                session.status = "stopped"
                session.emit("status", {"message": "Stopped by user."})
                break

            session.iterations += 1
            session.emit("status", {"iteration": session.iterations, "message": f"Iteration {session.iterations}"})

            try:
                text, tool_calls = call_fn(
                    base_url=base_url, api_key=api_key, model=session.model,
                    system=SYSTEM_PROMPT, messages=messages, tools=tools,
                )
            except Exception as exc:
                session.status = "failed"
                session.emit("error", {"message": f"LLM API error: {exc}"})
                break

            if text:
                session.emit("message", {"role": "assistant", "text": text})

            # Build the assistant message for conversation history
            if is_anthropic:
                acontent: list[dict] = []
                if text:
                    acontent.append({"type": "text", "text": text})
                for tc in tool_calls:
                    acontent.append({"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": tc["arguments"]})
                messages.append({"role": "assistant", "content": acontent})
            else:
                amsg: dict[str, Any] = {"role": "assistant"}
                if text:
                    amsg["content"] = text
                else:
                    amsg["content"] = None
                if tool_calls:
                    amsg["tool_calls"] = [
                        {
                            "id": tc["id"],
                            "type": "function",
                            "function": {"name": tc["name"], "arguments": json.dumps(tc["arguments"])},
                        }
                        for tc in tool_calls
                    ]
                messages.append(amsg)

            if not tool_calls:
                session.final_text = text or ""
                session.status = "completed"
                break

            # Execute tools
            results_for_history: list[dict] = []
            for tc in tool_calls:
                if session.stop_requested:
                    break

                session.emit("tool_call", {"id": tc["id"], "name": tc["name"], "input": tc["arguments"]})
                result, nav = _dispatch(ctx, session, tc["name"], tc["arguments"])
                summary = _short_summary(tc["name"], result)
                session.emit("tool_result", {
                    "id": tc["id"], "name": tc["name"],
                    "summary": summary,
                    "is_error": bool(result.get("error")),
                })
                if nav:
                    session.emit("navigate", {"target": nav})

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
                    finished = True
                    inp = tc["arguments"]
                    session.final_text = str(inp.get("summary", ""))
                    session.status = "completed" if inp.get("success") else "failed"

            if is_anthropic:
                messages.append({"role": "user", "content": results_for_history})
            else:
                messages.extend(results_for_history)

        else:
            if not finished and session.status == "running":
                session.status = "failed"
                session.emit("status", {"message": f"Max iterations ({session.max_iterations}) reached."})

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
