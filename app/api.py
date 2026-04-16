"""FastAPI layer for project loading, queries, and basic UI serving."""

from dataclasses import asdict, dataclass, field
from pathlib import Path
from threading import Lock, Thread

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from app.git_service import GitError, GitService
    from app.graph_builder import build_hierarchy_graph, build_module_connectivity_graph
    from app.hierarchy import build_hierarchy_tree
    from app.json_exporter import project_to_dict
    from app.project_service import ProjectService
    from app.schematic_layout import build_schematic_connectivity_graph
    from app.signal_tracer import trace_signal
    from app import simulation_service
    from app import agent_service
    from app.vcd_parser import parse_vcd
except ImportError:  # Supports running as: python app/main.py
    from git_service import GitError, GitService
    from graph_builder import build_hierarchy_graph, build_module_connectivity_graph
    from hierarchy import build_hierarchy_tree
    from json_exporter import project_to_dict
    from project_service import ProjectService
    from schematic_layout import build_schematic_connectivity_graph
    from signal_tracer import trace_signal
    import simulation_service
    import agent_service
    from vcd_parser import parse_vcd


class LoadProjectRequest(BaseModel):
    folder: str = Field(..., description="Root folder to scan")


class TraceSignalRequest(BaseModel):
    module: str = Field(..., description="Module scope in which the signal lives")
    signal: str = Field(..., description="Signal or port name to trace")
    max_hops: int = Field(default=500, description="Max hops per direction")


class ModuleSourceUpdate(BaseModel):
    content: str = Field(..., description="New full text content for the module's source file")


class CreateModuleRequest(BaseModel):
    name: str = Field(..., description="Name for the new Verilog module")


class InstantiateModuleRequest(BaseModel):
    child_module: str = Field(..., description="Module to instantiate")
    parent_module: str = Field(..., description="Module to add the instance into")
    instance_name: str = Field(default="", description="Optional instance name (auto-generated if empty)")


class LintRequest(BaseModel):
    content: str = Field(..., description="Verilog source text to syntax-check")


class CloneRepositoryRequest(BaseModel):
    url: str = Field(..., description="Repository URL, usually GitHub HTTPS or SSH")
    destination_parent: str = Field(..., description="Existing parent folder for the clone")
    destination_name: str | None = Field(default=None, description="Optional folder name for the new clone")
    branch: str | None = Field(default=None, description="Optional branch to clone")


class CommitAndPushRequest(BaseModel):
    message: str = Field(..., description="Commit message")
    folder: str | None = Field(default=None, description="Folder inside the target repository")
    remote: str = Field(default="origin", description="Remote name to push to")
    branch: str | None = Field(default=None, description="Branch to push; defaults to current branch")
    push: bool = Field(default=True, description="When false, only creates the commit locally")
    author_name: str | None = Field(default=None, description="Optional commit author name override")
    author_email: str | None = Field(default=None, description="Optional commit author email override")


class LoadCommitRequest(BaseModel):
    commit: str = Field(..., description="Commit SHA, tag, or ref to open in read-only mode")
    folder: str | None = Field(default=None, description="Folder inside the target repository")


class TestbenchCreateRequest(BaseModel):
    name: str = Field(..., description="File name for a new managed testbench (written under testbenches/)")
    content: str | None = Field(default=None, description="Optional initial content; a default scaffold is used when omitted")


class TestbenchSaveRequest(BaseModel):
    content: str = Field(..., description="Full testbench source text")


class RunSimulationRequest(BaseModel):
    path: str = Field(..., description="Absolute path to the testbench file (must live inside the loaded project)")
    top_module: str | None = Field(default=None, description="Optional override for the -s top-module passed to iverilog")
    timeout_sec: float = Field(default=30.0, ge=1.0, le=600.0, description="Per-phase timeout in seconds")
    expected_path: str | None = Field(default=None, description="Optional absolute path to a golden-output file to diff against run stdout")


class AgentRunRequest(BaseModel):
    goal: str = Field(..., description="Plain-language description of the task the agent should accomplish")
    max_iterations: int = Field(default=15, ge=1, le=50)
    model: str | None = Field(default=None, description="Optional Anthropic model ID override")


class AgentSettingsRequest(BaseModel):
    anthropic_api_key: str | None = Field(default=None, description="Key to persist to the local settings file. Pass null/empty to leave unchanged.")
    model: str | None = Field(default=None, description="Default model ID to use for future sessions")


@dataclass
class _LoadProgress:
    active: bool = False
    done: bool = False
    stage: str = "idle"           # idle | scanning | parsing | finalizing | done | error
    current: int = 0
    total: int = 0
    current_file: str = ""
    folder: str = ""
    parser_backend: str = "pyverilog"
    error: str | None = None
    summary: dict | None = None   # populated on success — same shape as load_project response


class _AppState:
    def __init__(self) -> None:
        self.service = ProjectService()
        self.git = GitService()
        self.loaded_folder: str | None = None
        self.loaded_repo_root: str | None = None
        self.loaded_commit: str | None = None
        self.read_only: bool = False
        self.load_progress: _LoadProgress = _LoadProgress()


state = _AppState()
state_lock = Lock()
# Separate lock for load progress so a long-running parse doesn't block fast
# read endpoints behind state_lock the entire time the user is loading.
progress_lock = Lock()

app = FastAPI(
    title="rtl_arch_visualizer API",
    version="0.38",
    description="Backend API for Verilog project loading and graph queries.",
)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def _select_folder_dialog(initial_dir: str | None = None) -> str | None:
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError as exc:  # pragma: no cover - standard library guard
        raise RuntimeError("Folder picker is unavailable in this Python environment.") from exc

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass

    chosen = filedialog.askdirectory(
        initialdir=initial_dir if initial_dir and Path(initial_dir).is_dir() else None,
        title="Select Verilog project folder",
        parent=root,
        mustexist=True,
    )
    root.destroy()

    if not chosen:
        return None
    return str(Path(chosen).resolve())


def _resolve_repo_folder(folder: str | None) -> str:
    target = folder
    if not target:
        with state_lock:
            target = state.loaded_folder
    if not target:
        raise _bad_request("No folder was provided and no project is currently loaded.")
    return target


def _update_loaded_repo_context(folder: str) -> None:
    target = str(Path(folder).resolve())
    try:
        info = state.git.get_repo_info(folder)
    except GitError:
        state.loaded_repo_root = None
        return
    # Only treat a normal project load as "repo-backed" when the loaded folder
    # itself is the repository root. This avoids showing Git history for
    # arbitrary subfolders that merely live somewhere inside another repo
    # (for example, sample projects under this tool's own workspace repo).
    state.loaded_repo_root = info.root if str(Path(info.root).resolve()) == target else None


def _ensure_project_writable() -> None:
    if state.read_only:
        commit_label = state.loaded_commit or "snapshot"
        raise _bad_request(
            f"Project is opened in read-only commit view ({commit_label}). "
            "Reload the live repository folder to edit files."
        )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/system/select-folder")
def select_folder(initial_dir: str | None = Query(default=None)) -> dict[str, str | None]:
    try:
        return {"selected_folder": _select_folder_dialog(initial_dir=initial_dir)}
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


def _run_load_in_background(folder: str) -> None:
    """Worker thread: parse the project locally, then publish under state_lock.

    Notes on locking:
    - The parse runs against a *local* ProjectService so other API endpoints
      can still read state.service while the (possibly long) parse is in flight.
    - state_lock is taken only briefly at the very end to swap in the new
      service. progress_lock is the only thing held during per-file updates.
    """

    def update(**fields) -> None:
        with progress_lock:
            for key, value in fields.items():
                setattr(state.load_progress, key, value)

    def on_file(current: int, total: int, current_file: str) -> None:
        update(stage="parsing", current=current, total=total, current_file=current_file)

    try:
        _load_project_into_state(
            folder=folder,
            update_progress=update,
            on_file=on_file,
            loaded_folder=folder,
            loaded_repo_root=None,
            loaded_commit=None,
            read_only=False,
        )
    except (FileNotFoundError, NotADirectoryError, ValueError, RuntimeError) as exc:
        update(stage="error", active=False, done=True, error=str(exc))
    except Exception as exc:  # pragma: no cover - unexpected backend failures
        update(stage="error", active=False, done=True, error=f"Failed to load project: {exc}")


def _load_project_into_state(
    *,
    folder: str,
    update_progress,
    on_file,
    loaded_folder: str,
    loaded_repo_root: str | None,
    loaded_commit: str | None,
    read_only: bool,
) -> None:
    update_progress(stage="scanning", current=0, total=0, current_file="")
    local_service = ProjectService()
    project = local_service.load_project(folder, progress_callback=on_file)

    update_progress(stage="finalizing", current_file="")
    tops = local_service.get_top_candidates()

    diagnostics = [
        {
            "severity": d.severity,
            "kind": d.kind,
            "message": d.message,
            "file": d.file,
            "line": d.line,
            "detail": d.detail,
        }
        for d in project.diagnostics
    ]
    summary = {
        "loaded_folder": loaded_folder,
        "parser_backend": "pyverilog",
        "root_path": project.root_path,
        "file_count": len(project.source_files),
        "module_count": len(project.modules),
        "top_candidates": tops,
        "diagnostics": diagnostics,
        "diagnostic_counts": {
            "error": sum(1 for d in project.diagnostics if d.severity == "error"),
            "warning": sum(1 for d in project.diagnostics if d.severity == "warning"),
            "info": sum(1 for d in project.diagnostics if d.severity == "info"),
        },
    }

    with state_lock:
        state.service = local_service
        state.loaded_folder = loaded_folder
        state.loaded_repo_root = loaded_repo_root
        state.loaded_commit = loaded_commit
        state.read_only = read_only
        if not read_only:
            _update_loaded_repo_context(loaded_folder)

    update_progress(stage="done", active=False, done=True, summary=summary, error=None)


def _run_commit_load_in_background(repo_folder: str, commit: str) -> None:
    def update(**fields) -> None:
        with progress_lock:
            for key, value in fields.items():
                setattr(state.load_progress, key, value)

    def on_file(current: int, total: int, current_file: str) -> None:
        update(stage="parsing", current=current, total=total, current_file=current_file)

    try:
        update(stage="scanning", current=0, total=0, current_file=f"Preparing commit {commit}")
        snapshot = state.git.materialize_commit_snapshot(repo_folder, commit)
        _load_project_into_state(
            folder=snapshot["snapshot_path"],
            update_progress=update,
            on_file=on_file,
            loaded_folder=snapshot["snapshot_path"],
            loaded_repo_root=snapshot["repo_root"],
            loaded_commit=snapshot["commit"],
            read_only=True,
        )
    except (FileNotFoundError, NotADirectoryError, ValueError, RuntimeError, GitError) as exc:
        update(stage="error", active=False, done=True, error=str(exc))
    except Exception as exc:  # pragma: no cover - unexpected backend failures
        update(stage="error", active=False, done=True, error=f"Failed to load commit: {exc}")


def _start_background_load(*, folder: str, worker_target, worker_args: tuple, current_file: str = "") -> dict[str, object]:
    with progress_lock:
        if state.load_progress.active:
            raise _bad_request("A project load is already in progress.")
        state.load_progress = _LoadProgress(
            active=True,
            done=False,
            stage="scanning",
            current=0,
            total=0,
            current_file=current_file,
            folder=folder,
            parser_backend="pyverilog",
            error=None,
            summary=None,
        )

    worker = Thread(
        target=worker_target,
        args=worker_args,
        daemon=True,
        name="project-load-worker",
    )
    worker.start()
    return {"started": True, "folder": folder, "parser_backend": "pyverilog"}


@app.post("/api/project/load")
def load_project(payload: LoadProjectRequest) -> dict[str, object]:
    return _start_background_load(
        folder=payload.folder,
        worker_target=_run_load_in_background,
        worker_args=(payload.folder,),
    )


@app.get("/api/project/load/progress")
def get_load_progress() -> dict[str, object]:
    with progress_lock:
        p = state.load_progress
        return {
            "active": p.active,
            "done": p.done,
            "stage": p.stage,
            "current": p.current,
            "total": p.total,
            "current_file": p.current_file,
            "folder": p.folder,
            "parser_backend": p.parser_backend,
            "error": p.error,
            "summary": p.summary,
        }


@app.get("/api/project")
def get_project() -> dict[str, object]:
    try:
        with state_lock:
            project = state.service.get_project()
            return project_to_dict(project)
    except RuntimeError as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/project/context")
def get_project_context() -> dict[str, object]:
    with state_lock:
        return {
            "loaded_folder": state.loaded_folder,
            "repo_root": state.loaded_repo_root,
            "read_only": state.read_only,
            "loaded_commit": state.loaded_commit,
        }


@app.get("/api/project/tops")
def get_top_candidates(
    include_testbenches: bool = Query(default=False),
) -> dict[str, object]:
    try:
        with state_lock:
            tops = state.service.get_top_candidates(include_testbenches=include_testbenches)
            return {"top_candidates": tops}
    except RuntimeError as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/project/modules")
def get_modules() -> dict[str, object]:
    try:
        with state_lock:
            names = state.service.get_module_names()
            return {"modules": names}
    except RuntimeError as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/project/files")
def get_source_files() -> dict[str, object]:
    try:
        with state_lock:
            project = state.service.get_project()
            files = []
            modules_by_path: dict[str, list[str]] = {}
            for module in project.modules:
                if module.source_file:
                    modules_by_path.setdefault(module.source_file, []).append(module.name)

            for source in project.source_files:
                path = str(Path(source.path).resolve())
                files.append({
                    "path": path,
                    "name": Path(path).name,
                    "modules": sorted(modules_by_path.get(path, [])),
                })
        files.sort(key=lambda item: (str(item["name"]).lower(), str(item["path"]).lower()))
        return {"files": files}
    except RuntimeError as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/project/modules/{module_name}")
def get_module(module_name: str) -> dict[str, object]:
    try:
        with state_lock:
            module = state.service.get_module(module_name)
            return asdict(module)
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc


@app.post("/api/project/modules")
def create_module(payload: CreateModuleRequest) -> dict[str, object]:
    try:
        with state_lock:
            _ensure_project_writable()
            result = state.service.create_module(payload.name)
            return result
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to create module: {exc}") from exc


@app.get("/api/project/unused_modules")
def get_unused_modules() -> dict[str, object]:
    try:
        with state_lock:
            unused = state.service.get_unused_modules()
            return {"unused_modules": unused}
    except RuntimeError as exc:
        raise _bad_request(str(exc)) from exc


@app.post("/api/project/instantiate")
def instantiate_module(payload: InstantiateModuleRequest) -> dict[str, object]:
    """Add an instance of child_module inside parent_module's source file."""
    try:
        with state_lock:
            _ensure_project_writable()
            parent_mod = state.service.get_module(payload.parent_module)
            child_mod = state.service.get_module(payload.child_module)
            top_modules = set(state.service.get_top_candidates())

            if payload.child_module in top_modules:
                raise _bad_request(f"Top module '{payload.child_module}' cannot be instantiated.")

            src_path = parent_mod.source_file
            if not src_path:
                raise _bad_request(f"Module '{payload.parent_module}' has no associated source file.")
            path = Path(src_path)
            if not path.exists():
                raise _bad_request(f"Source file not found: {src_path}")

            # Determine instance name.
            instance_name = payload.instance_name.strip()
            if not instance_name:
                existing = {inst.name for inst in parent_mod.instances}
                base = payload.child_module.lower()
                idx = 0
                instance_name = f"{base}_inst"
                while instance_name in existing:
                    idx += 1
                    instance_name = f"{base}_inst{idx}"

            # Build the instantiation snippet.
            port_lines = []
            for port in child_mod.ports:
                port_lines.append(f"    .{port.name}()")
            ports_str = ",\n".join(port_lines) if port_lines else ""

            snippet = f"\n  {payload.child_module} {instance_name} (\n{ports_str}\n  );\n"

            # Insert before the final `endmodule`.
            content = path.read_text(encoding="utf-8")
            endmodule_idx = content.rfind("endmodule")
            if endmodule_idx < 0:
                raise _bad_request(f"Could not find 'endmodule' in {src_path}")

            new_content = content[:endmodule_idx] + snippet + "\n" + content[endmodule_idx:]
            path.write_text(new_content, encoding="utf-8")

            # Re-parse.
            try:
                report = state.service.reparse_file(str(path))
            except Exception:
                report = {"warning": "Saved but re-parse failed."}

            if report.get("requires_full_reparse") and state.loaded_folder:
                state.service.load_project(state.loaded_folder)

            return {
                "parent_module": payload.parent_module,
                "child_module": payload.child_module,
                "instance_name": instance_name,
                "path": str(path),
                "instantiated": True,
            }
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write source: {exc}") from exc


@app.get("/api/project/modules/{module_name}/source")
def get_module_source(module_name: str) -> dict[str, object]:
    try:
        with state_lock:
            module = state.service.get_module(module_name)
            src_path = module.source_file
            if not src_path:
                raise _bad_request(f"Module '{module_name}' has no associated source file.")
            path = Path(src_path)
            if not path.exists():
                raise _bad_request(f"Source file not found: {src_path}")
        content = path.read_text(encoding="utf-8", errors="replace")
        return {"module": module_name, "path": str(path), "content": content}
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read source: {exc}") from exc


@app.get("/api/project/files/source")
def get_source_file(path: str = Query(..., description="Absolute path to a tracked Verilog source file")) -> dict[str, object]:
    try:
        requested = str(Path(path).resolve())
        with state_lock:
            project = state.service.get_project()
            known_paths = {str(Path(source.path).resolve()) for source in project.source_files}
            if requested not in known_paths:
                raise _bad_request(f"Source file not tracked in current project: {requested}")
        content = Path(requested).read_text(encoding="utf-8", errors="replace")
        return {"path": requested, "name": Path(requested).name, "content": content}
    except RuntimeError as exc:
        raise _bad_request(str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read source: {exc}") from exc


@app.put("/api/project/modules/{module_name}/source")
def update_module_source(module_name: str, payload: ModuleSourceUpdate) -> dict[str, object]:
    try:
        with state_lock:
            _ensure_project_writable()
            module = state.service.get_module(module_name)
            src_path = module.source_file
            if not src_path:
                raise _bad_request(f"Module '{module_name}' has no associated source file.")
            path = Path(src_path)
            if not path.exists():
                raise _bad_request(f"Source file not found: {src_path}")
            path.write_text(payload.content, encoding="utf-8")

            # Try an incremental reparse of just this file. If the set of
            # modules defined in the file changed, only fall back to a full
            # project reparse when no previously-known modules were lost —
            # otherwise a syntax error in the user's edit (which makes the
            # regex parser fail to recover any module headers) would wipe
            # the cached project state for this file's modules and any
            # cross-file references that depend on them.
            try:
                report = state.service.reparse_file(str(path))
            except Exception as exc:  # noqa: BLE001 - parser errors should not discard cached state
                report = {
                    "requires_full_reparse": True,
                    "fell_back_to_full_reparse": False,
                    "kept_cached_project": True,
                    "error": str(exc),
                    "warning": (
                        "Saved to disk, but the updated file no longer parses. "
                        "The in-memory project was left untouched - fix the "
                        "syntax error and save again to refresh."
                    ),
                }
            if report.get("requires_full_reparse"):
                old_names = set(report.get("old_modules", []))
                new_names = set(report.get("new_modules", []))
                lost = sorted(old_names - new_names)
                if report.get("kept_cached_project"):
                    pass
                elif lost:
                    report["fell_back_to_full_reparse"] = False
                    report["kept_cached_project"] = True
                    report["warning"] = (
                        "Saved to disk, but the updated file no longer parses "
                        f"into the previously-known modules ({', '.join(lost)}). "
                        "The in-memory project was left untouched - fix the "
                        "syntax error and save again to refresh."
                    )
                elif state.loaded_folder:
                    state.service.load_project(state.loaded_folder)
                    report["fell_back_to_full_reparse"] = True
            return {
                "module": module_name,
                "path": str(path),
                "saved": True,
                "reparse": report,
            }
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write source: {exc}") from exc


@app.put("/api/project/files/source")
def update_source_file(
    payload: ModuleSourceUpdate,
    path: str = Query(..., description="Absolute path to a tracked Verilog source file"),
) -> dict[str, object]:
    requested = str(Path(path).resolve())
    try:
        with state_lock:
            _ensure_project_writable()
            project = state.service.get_project()
            known_paths = {str(Path(source.path).resolve()) for source in project.source_files}
            if requested not in known_paths:
                raise _bad_request(f"Source file not tracked in current project: {requested}")

            file_modules = [module.name for module in project.modules if module.source_file == requested]
            Path(requested).write_text(payload.content, encoding="utf-8")

            report: dict[str, object]
            if file_modules:
                try:
                    report = state.service.reparse_file(requested)
                    if report.get("requires_full_reparse") and state.loaded_folder:
                        state.service.load_project(state.loaded_folder)
                        report["fell_back_to_full_reparse"] = True
                except Exception as exc:
                    if state.loaded_folder:
                        state.service.load_project(state.loaded_folder)
                        report = {
                            "warning": "Saved and refreshed project after parse failure.",
                            "error": str(exc),
                            "fell_back_to_full_reparse": True,
                        }
                    else:
                        report = {"warning": "Saved but re-parse failed.", "error": str(exc)}
            else:
                if state.loaded_folder:
                    state.service.load_project(state.loaded_folder)
                    report = {"reloaded_project": True}
                else:
                    report = {"reloaded_project": False}

        return {
            "path": requested,
            "name": Path(requested).name,
            "saved": True,
            "reparse": report,
        }
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write source: {exc}") from exc


@app.post("/api/lint/verilog")
def lint_verilog(payload: LintRequest) -> dict[str, object]:
    """Run the active parser against an in-memory Verilog snippet.

    Returns a list of error descriptors with line numbers and messages so the
    editor can highlight problems without having to save the file first.
    Pyverilog raises ``ParseError`` strings of the form
    ``"<filename> line:42: before: \"foo\""`` — we extract the line/token
    out of that and pass it through.
    """
    import re
    import tempfile

    errors: list[dict[str, object]] = []
    try:
        from pyverilog.vparser.parser import VerilogParser, ParseError  # type: ignore
        try:
            parser = VerilogParser(outputdir=tempfile.gettempdir(), debug=False)
            parser.parse(payload.content, debug=False)
        except ParseError as exc:
            msg = str(exc)
            line_match = re.search(r"line:(\d+)", msg)
            tok_match = re.search(r'before:\s*"([^"]*)"', msg)
            errors.append({
                "line": int(line_match.group(1)) if line_match else 1,
                "token": tok_match.group(1) if tok_match else None,
                "message": msg,
            })
        except Exception as exc:  # noqa: BLE001 — preprocessor or lexer errors
            errors.append({"line": 1, "token": None, "message": str(exc)})
    except ImportError:
        raise HTTPException(status_code=500, detail="PyVerilog is not installed") from None

    return {"errors": errors, "backend": "pyverilog"}


@app.post("/api/git/clone")
def clone_repository(payload: CloneRepositoryRequest) -> dict[str, object]:
    try:
        return state.git.clone_repository(
            url=payload.url,
            destination_parent=payload.destination_parent,
            destination_name=payload.destination_name,
            branch=payload.branch,
        )
    except (FileNotFoundError, NotADirectoryError, ValueError, GitError) as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/git/repo")
def get_repo_info(folder: str | None = Query(default=None)) -> dict[str, object]:
    try:
        target = _resolve_repo_folder(folder)
        info = state.git.get_repo_info(target)
        return {
            "repo_root": info.root,
            "branch": info.branch,
            "detached": info.detached,
            "remotes": info.remotes,
        }
    except (ValueError, GitError) as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/git/status")
def get_git_status(folder: str | None = Query(default=None)) -> dict[str, object]:
    try:
        target = _resolve_repo_folder(folder)
        return state.git.get_status(target)
    except (ValueError, GitError) as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/git/history")
def get_git_history(
    folder: str | None = Query(default=None),
    max_count: int = Query(default=50, ge=1, le=200),
) -> dict[str, object]:
    try:
        target = _resolve_repo_folder(folder)
        return state.git.list_history(target, max_count=max_count)
    except (ValueError, GitError) as exc:
        raise _bad_request(str(exc)) from exc


@app.post("/api/git/commit-and-push")
def commit_and_push(payload: CommitAndPushRequest) -> dict[str, object]:
    try:
        target = _resolve_repo_folder(payload.folder)
        return state.git.commit_and_push(
            folder=target,
            message=payload.message,
            remote=payload.remote,
            branch=payload.branch,
            push=payload.push,
            author_name=payload.author_name,
            author_email=payload.author_email,
        )
    except (ValueError, GitError) as exc:
        raise _bad_request(str(exc)) from exc


@app.post("/api/git/load-commit")
def load_commit_snapshot(payload: LoadCommitRequest) -> dict[str, object]:
    try:
        target = _resolve_repo_folder(payload.folder)
        return _start_background_load(
            folder=target,
            worker_target=_run_commit_load_in_background,
            worker_args=(target, payload.commit),
            current_file=f"Preparing commit {payload.commit}",
        )
    except (FileNotFoundError, NotADirectoryError, ValueError, RuntimeError, GitError) as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/project/hierarchy/{top_module}")
def get_hierarchy_tree(top_module: str) -> dict[str, object]:
    try:
        with state_lock:
            project = state.service.get_project()
            state.service.get_module(top_module)
        return build_hierarchy_tree(project.modules, top_module)
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/project/graph/{module_name}")
def get_module_graph(module_name: str) -> dict[str, object]:
    # Backward-compatible hierarchy graph route.
    try:
        with state_lock:
            project = state.service.get_project()
            state.service.get_module(module_name)
        return build_hierarchy_graph(project, module_name)
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/project/connectivity/{module_name}")
def get_module_connectivity_graph(
    module_name: str,
    mode: str = Query(default="compact"),
    aggregate_edges: bool = Query(default=False),
    port_view: bool = Query(default=False),
    schematic: bool = Query(default=False),
    schematic_mode: str = Query(default="full"),
) -> dict[str, object]:
    try:
        with state_lock:
            project = state.service.get_project()
            state.service.get_module(module_name)
        if schematic:
            return build_schematic_connectivity_graph(project, module_name, schematic_mode=schematic_mode)
        return build_module_connectivity_graph(
            project,
            module_name,
            mode=mode,
            aggregate_edges=aggregate_edges,
            port_view=port_view,
        )
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc


@app.post("/api/signal/trace")
def trace_signal_endpoint(payload: TraceSignalRequest) -> dict[str, object]:
    try:
        with state_lock:
            project = state.service.get_project()
            return trace_signal(
                project,
                module_name=payload.module,
                signal=payload.signal,
                max_hops=max(1, payload.max_hops),
            )
    except ValueError as exc:
        raise _bad_request(str(exc)) from exc
    except RuntimeError as exc:
        raise _bad_request(str(exc)) from exc


def _require_loaded_project() -> str:
    with state_lock:
        folder = state.loaded_folder
    if not folder:
        raise _bad_request("No project is currently loaded.")
    return folder


@app.get("/api/sim/tools")
def sim_tool_status() -> dict[str, object]:
    """Report whether Icarus Verilog is installed and where the binaries live."""
    return simulation_service.check_tools()


@app.get("/api/sim/testbenches")
def sim_list_testbenches() -> dict[str, object]:
    folder = _require_loaded_project()
    simulation_service.ensure_dirs(folder)
    return {
        "project_root": folder,
        "testbench_dir": str(Path(folder) / simulation_service.TESTBENCH_SUBDIR),
        "testbenches": simulation_service.list_testbenches(folder),
    }


@app.post("/api/sim/testbenches")
def sim_create_testbench(payload: TestbenchCreateRequest) -> dict[str, object]:
    """Create a new managed testbench under the project's testbenches/ folder."""
    folder = _require_loaded_project()
    try:
        _ensure_project_writable()
        return simulation_service.create_managed_testbench(folder, payload.name, payload.content)
    except simulation_service.SimulationError as exc:
        raise _bad_request(str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to write testbench: {exc}") from exc


@app.get("/api/sim/testbench")
def sim_read_testbench(path: str = Query(..., description="Absolute path to the testbench file")) -> dict[str, object]:
    folder = _require_loaded_project()
    try:
        return simulation_service.read_testbench_by_path(folder, path)
    except simulation_service.SimulationError as exc:
        raise _bad_request(str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read testbench: {exc}") from exc


@app.put("/api/sim/testbench")
def sim_save_testbench(
    payload: TestbenchSaveRequest,
    path: str = Query(..., description="Absolute path to the testbench file"),
) -> dict[str, object]:
    folder = _require_loaded_project()
    try:
        _ensure_project_writable()
        return simulation_service.write_testbench_by_path(folder, path, payload.content)
    except simulation_service.SimulationError as exc:
        raise _bad_request(str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save testbench: {exc}") from exc


@app.delete("/api/sim/testbench")
def sim_delete_testbench(path: str = Query(..., description="Absolute path to the testbench file")) -> dict[str, object]:
    folder = _require_loaded_project()
    try:
        _ensure_project_writable()
        simulation_service.delete_testbench_by_path(folder, path)
        return {"deleted": True, "path": path}
    except simulation_service.SimulationError as exc:
        raise _bad_request(str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete testbench: {exc}") from exc


@app.post("/api/sim/run")
def sim_run(payload: RunSimulationRequest) -> dict[str, object]:
    folder = _require_loaded_project()
    try:
        _ensure_project_writable()
        result = simulation_service.run_simulation(
            folder,
            payload.path,
            top_module=payload.top_module,
            timeout_sec=payload.timeout_sec,
            expected_path=payload.expected_path,
        )
        simulation_service.prune_old_runs(folder, keep=10)
        return simulation_service.result_to_dict(result)
    except simulation_service.SimulationError as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/sim/waveform")
def sim_waveform(path: str = Query(..., description="Absolute path to a VCD file produced by a sim run")) -> dict[str, object]:
    folder = _require_loaded_project()
    try:
        requested = Path(path).resolve()
        sim_root = (Path(folder) / simulation_service.SIM_OUT_SUBDIR).resolve()
        requested.relative_to(sim_root)  # sandbox guard
    except ValueError as exc:
        raise _bad_request("VCD path is outside the current project's simulation sandbox.") from exc
    try:
        return parse_vcd(str(requested))
    except FileNotFoundError as exc:
        raise _bad_request(f"VCD file not found: {requested}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read VCD: {exc}") from exc


# -----------------------------------------------------------------------------
# Agent (LLM) endpoints
# -----------------------------------------------------------------------------

@app.get("/api/agent/settings")
def agent_get_settings() -> dict[str, object]:
    return agent_service.get_settings_status()


@app.post("/api/agent/settings")
def agent_put_settings(payload: AgentSettingsRequest) -> dict[str, object]:
    updates: dict[str, object] = {}
    if payload.anthropic_api_key is not None and payload.anthropic_api_key.strip():
        updates["anthropic_api_key"] = payload.anthropic_api_key.strip()
    if payload.model is not None and payload.model.strip():
        updates["model"] = payload.model.strip()
    if updates:
        agent_service.save_settings(updates)
    return agent_service.get_settings_status()


@app.post("/api/agent/sessions")
def agent_start_session(payload: AgentRunRequest) -> dict[str, object]:
    try:
        with state_lock:
            _ensure_project_writable()
            session = agent_service.start_session(
                goal=payload.goal,
                state=state,
                state_lock=state_lock,
                simulation_service_mod=simulation_service,
                max_iterations=payload.max_iterations,
                model=payload.model,
            )
        return {
            "id": session.id,
            "status": session.status,
            "model": session.model,
            "max_iterations": session.max_iterations,
        }
    except agent_service.AgentError as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/agent/sessions")
def agent_list_sessions() -> dict[str, object]:
    return {"sessions": agent_service.list_sessions()}


@app.get("/api/agent/sessions/{session_id}")
def agent_session_status(session_id: str, since_seq: int = Query(default=0, ge=0)) -> dict[str, object]:
    try:
        session = agent_service.get_session(session_id)
    except agent_service.AgentError as exc:
        raise _bad_request(str(exc)) from exc
    return session.snapshot(since_seq=since_seq)


@app.post("/api/agent/sessions/{session_id}/stop")
def agent_stop_session(session_id: str) -> dict[str, object]:
    try:
        return agent_service.stop_session(session_id)
    except agent_service.AgentError as exc:
        raise _bad_request(str(exc)) from exc


ROOT_DIR = Path(__file__).resolve().parent.parent
UI_DIR = ROOT_DIR / "ui"

ICONS_DIR = ROOT_DIR / "docs" / "icons"
IMAGES_DIR = ROOT_DIR / "docs" / "images"

if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")

if ICONS_DIR.exists():
    app.mount("/icons", StaticFiles(directory=str(ICONS_DIR)), name="icons")

if IMAGES_DIR.exists():
    app.mount("/images", StaticFiles(directory=str(IMAGES_DIR)), name="images")


@app.get("/", include_in_schema=False)
def ui_index() -> FileResponse:
    if not UI_DIR.exists():
        raise HTTPException(status_code=404, detail="UI directory not found")
    return FileResponse(UI_DIR / "index.html")


