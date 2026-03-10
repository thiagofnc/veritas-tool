"""FastAPI layer for project loading, queries, and basic UI serving."""

from dataclasses import asdict
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from app.json_exporter import project_to_dict
    from app.project_service import PARSER_CHOICES, ProjectService
except ImportError:  # Supports running as: python app/main.py
    from json_exporter import project_to_dict
    from project_service import PARSER_CHOICES, ProjectService


class LoadProjectRequest(BaseModel):
    folder: str = Field(..., description="Root folder to scan")
    parser_backend: str = Field(default="pyverilog", description="pyverilog or simple")


class _AppState:
    def __init__(self) -> None:
        self.service = ProjectService(parser_backend="pyverilog")
        self.loaded_folder: str | None = None


state = _AppState()
state_lock = Lock()

app = FastAPI(
    title="rtl_arch_visualizer API",
    version="0.1.0",
    description="Backend API for Verilog project loading and graph queries.",
)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/project/load")
def load_project(payload: LoadProjectRequest) -> dict[str, object]:
    if payload.parser_backend not in PARSER_CHOICES:
        raise _bad_request(
            f"Unsupported parser backend '{payload.parser_backend}'. "
            f"Use one of: {', '.join(PARSER_CHOICES)}"
        )

    try:
        with state_lock:
            state.service = ProjectService(parser_backend=payload.parser_backend)
            project = state.service.load_project(payload.folder)
            state.loaded_folder = payload.folder
            tops = state.service.get_top_candidates()
    except (FileNotFoundError, NotADirectoryError, ValueError, RuntimeError) as exc:
        raise _bad_request(str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load project: {exc}") from exc

    return {
        "loaded_folder": payload.folder,
        "parser_backend": payload.parser_backend,
        "root_path": project.root_path,
        "file_count": len(project.source_files),
        "module_count": len(project.modules),
        "top_candidates": tops,
    }


@app.get("/api/project")
def get_project() -> dict[str, object]:
    try:
        with state_lock:
            project = state.service.get_project()
            return project_to_dict(project)
    except RuntimeError as exc:
        raise _bad_request(str(exc)) from exc


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


@app.get("/api/project/modules/{module_name}")
def get_module(module_name: str) -> dict[str, object]:
    try:
        with state_lock:
            module = state.service.get_module(module_name)
            return asdict(module)
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/project/hierarchy/{top_module}")
def get_hierarchy_tree(top_module: str) -> dict[str, object]:
    try:
        with state_lock:
            return state.service.get_hierarchy_tree(top_module)
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/project/graph/{module_name}")
def get_module_graph(module_name: str) -> dict[str, object]:
    # Backward-compatible hierarchy graph route.
    try:
        with state_lock:
            return state.service.get_module_graph(module_name)
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc


@app.get("/api/project/connectivity/{module_name}")
def get_module_connectivity_graph(
    module_name: str,
    mode: str = Query(default="compact"),
    aggregate_edges: bool = Query(default=False),
    port_view: bool = Query(default=False),
) -> dict[str, object]:
    try:
        with state_lock:
            return state.service.get_module_connectivity_graph(
                module_name,
                mode=mode,
                aggregate_edges=aggregate_edges,
                port_view=port_view,
            )
    except (RuntimeError, ValueError) as exc:
        raise _bad_request(str(exc)) from exc


ROOT_DIR = Path(__file__).resolve().parent.parent
UI_DIR = ROOT_DIR / "ui"

if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")


@app.get("/", include_in_schema=False)
def ui_index() -> FileResponse:
    if not UI_DIR.exists():
        raise HTTPException(status_code=404, detail="UI directory not found")
    return FileResponse(UI_DIR / "index.html")


