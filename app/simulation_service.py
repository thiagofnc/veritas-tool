"""Icarus Verilog (iverilog + vvp) simulation runner.

Compiles the project sources together with a user-authored testbench,
executes the resulting vvp image, and hands back compile/run output plus
the path to the generated VCD. The service deliberately keeps its on-disk
footprint inside the loaded project folder:

    <project>/testbenches/        -- user testbench sources (.sv / .v)
    <project>/.veritas_sim/<id>/  -- per-run compile + run artifacts (vvp, vcd)
"""

from __future__ import annotations

import re
import shutil
import subprocess
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable


TESTBENCH_SUBDIR = "testbenches"
SIM_OUT_SUBDIR = ".veritas_sim"

_VALID_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:sv|v))?$")

# File-name heuristics for discovering testbenches anywhere in the project.
_TB_FILENAME_RE = re.compile(
    r"(?:^|[_\-])(?:tb|testbench)(?:[_\-]|$)|(?:^|[_\-])test(?:[_\-]|$)",
    re.IGNORECASE,
)
# If the file name is ambiguous, a quick content scan for these dump/finish
# tasks is a strong secondary signal that this is a simulation driver.
_TB_CONTENT_MARKERS = ("$dumpvars", "$dumpfile", "$finish", "$monitor")


@dataclass
class SimulationMessage:
    severity: str                    # "error" | "warning" | "info"
    message: str
    file: str | None = None
    line: int | None = None


@dataclass
class SimulationResult:
    id: str
    testbench: str
    status: str                      # ok | compile_error | runtime_error | tool_missing
    exit_code: int | None = None
    top_module: str | None = None
    compile_stdout: str = ""
    compile_stderr: str = ""
    run_stdout: str = ""
    run_stderr: str = ""
    vcd_path: str | None = None
    vvp_path: str | None = None
    duration_ms: int = 0
    messages: list[SimulationMessage] = field(default_factory=list)


class SimulationError(RuntimeError):
    pass


DEFAULT_TB_TEMPLATE = """`timescale 1ns/1ps

// Auto-generated testbench scaffold. Instantiate your DUT and drive its
// inputs inside the initial block below. $dumpvars controls what shows up
// in the waveform viewer.

module {name};

  reg clk = 1'b0;
  always #5 clk = ~clk;

  reg rst_n = 1'b0;

  // TODO: declare DUT I/O regs / wires here.

  // TODO: instantiate the DUT here, e.g.
  //   my_module dut (.clk(clk), .rst_n(rst_n), ...);

  initial begin
    $dumpfile("{name}.vcd");
    $dumpvars(0, {name});

    #20 rst_n = 1'b1;

    // Drive stimulus here.

    #200 $finish;
  end

endmodule
"""


def _which(name: str) -> str | None:
    return shutil.which(name) or shutil.which(f"{name}.exe")


def check_tools() -> dict[str, object]:
    iverilog = _which("iverilog")
    vvp = _which("vvp")
    return {
        "iverilog": iverilog,
        "vvp": vvp,
        "available": bool(iverilog and vvp),
    }


def _testbench_root(project_root: str) -> Path:
    return Path(project_root) / TESTBENCH_SUBDIR


def _sim_out_root(project_root: str) -> Path:
    return Path(project_root) / SIM_OUT_SUBDIR


def ensure_dirs(project_root: str) -> None:
    _testbench_root(project_root).mkdir(parents=True, exist_ok=True)
    _sim_out_root(project_root).mkdir(parents=True, exist_ok=True)


def _normalize_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise SimulationError("Testbench name cannot be empty.")
    # Disallow any path separator tricks
    if "/" in name or "\\" in name or name in ("..", "."):
        raise SimulationError(f"Invalid testbench name: {name!r}")
    if not name.lower().endswith((".sv", ".v")):
        name = name + ".sv"
    if not _VALID_NAME_RE.match(name):
        raise SimulationError(
            f"Invalid testbench name: {name!r}. "
            "Use letters, digits, underscores only."
        )
    return name


def _safe_testbench_path(project_root: str, name: str) -> Path:
    name = _normalize_name(name)
    root = _testbench_root(project_root).resolve()
    candidate = (root / name).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise SimulationError(f"Testbench escapes sandbox: {name!r}") from exc
    return candidate


def _looks_like_testbench(path: Path) -> bool:
    """Return True if `path` is plausibly a simulation testbench.

    Fast check: file-name heuristic (tb_*, *_tb, test_*, testbench*).
    Fallback: read a capped prefix of the file to look for the simulation
    system tasks ($dumpvars, $finish, ...). Keeps IO bounded so the scan
    stays cheap even on large projects.
    """
    stem = path.stem
    if _TB_FILENAME_RE.search(stem):
        return True
    try:
        with path.open("r", encoding="utf-8", errors="replace") as f:
            head = f.read(8192)
    except OSError:
        return False
    return any(marker in head for marker in _TB_CONTENT_MARKERS)


def _describe(path: Path, project_root: Path, source: str) -> dict:
    rp = path.resolve()
    try:
        rel = rp.relative_to(project_root.resolve())
        rel_display = str(rel).replace("\\", "/")
    except ValueError:
        rel_display = path.name
    try:
        size = path.stat().st_size
    except OSError:
        size = 0
    return {
        "name": path.name,
        "path": str(rp),
        "relative_path": rel_display,
        "source": source,
        "size": size,
    }


def list_testbenches(project_root: str) -> list[dict]:
    """List testbenches: managed ones under testbenches/ plus any files
    elsewhere in the project that look like simulation drivers."""
    project = Path(project_root).resolve()
    if not project.exists():
        return []

    tb_root = _testbench_root(project_root).resolve()
    out_root = _sim_out_root(project_root).resolve()

    items: list[dict] = []
    seen_paths: set[str] = set()

    # Managed: everything inside testbenches/ is considered a testbench.
    if tb_root.exists():
        for p in sorted(tb_root.iterdir(), key=lambda x: x.name.lower()):
            if not p.is_file():
                continue
            if p.suffix.lower() not in (".sv", ".v"):
                continue
            entry = _describe(p, project, "managed")
            if entry["path"] in seen_paths:
                continue
            seen_paths.add(entry["path"])
            items.append(entry)

    # Discovered: walk the rest of the project (skip hidden dirs and the
    # simulation output sandbox) and probe .v/.sv files heuristically.
    for p in project.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in (".v", ".sv"):
            continue
        try:
            rel_parts = p.relative_to(project).parts
        except ValueError:
            continue
        if any(part.startswith(".") for part in rel_parts):
            continue

        rp = p.resolve()
        try:
            rp.relative_to(tb_root)
            continue  # handled by managed pass above
        except ValueError:
            pass
        try:
            rp.relative_to(out_root)
            continue
        except ValueError:
            pass

        if not _looks_like_testbench(p):
            continue

        key = str(rp)
        if key in seen_paths:
            continue
        seen_paths.add(key)
        items.append(_describe(p, project, "discovered"))

    items.sort(key=lambda e: (e["source"] != "managed", e["name"].lower()))
    return items


def _resolve_managed_path(project_root: str, name: str) -> Path:
    return _safe_testbench_path(project_root, name)


def _resolve_sandboxed_path(project_root: str, path: str) -> Path:
    """Path-based access: allow any file under the project root, but block
    escapes (.., symlinks outside project, or arbitrary filesystem access).
    Used for opening/saving testbenches the user discovered outside the
    managed testbenches/ folder."""
    root = Path(project_root).resolve()
    candidate = Path(path).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise SimulationError(
            f"Path is outside the current project: {path!r}"
        ) from exc
    if candidate.suffix.lower() not in (".sv", ".v"):
        raise SimulationError(
            f"Only .v / .sv files can be opened as testbenches: {candidate.name}"
        )
    return candidate


def read_testbench_by_path(project_root: str, path: str) -> dict:
    target = _resolve_sandboxed_path(project_root, path)
    if not target.exists():
        raise SimulationError(f"File not found: {target.name}")
    project = Path(project_root).resolve()
    tb_root = _testbench_root(project_root).resolve()
    try:
        target.relative_to(tb_root)
        source = "managed"
    except ValueError:
        source = "discovered"
    info = _describe(target, project, source)
    info["content"] = target.read_text(encoding="utf-8", errors="replace")
    return info


def write_testbench_by_path(project_root: str, path: str, content: str) -> dict:
    target = _resolve_sandboxed_path(project_root, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return read_testbench_by_path(project_root, str(target))


def create_managed_testbench(project_root: str, name: str, content: str | None = None) -> dict:
    ensure_dirs(project_root)
    target = _resolve_managed_path(project_root, name)
    if target.exists():
        raise SimulationError(f"A testbench named {target.name!r} already exists.")
    if content is None:
        content = DEFAULT_TB_TEMPLATE.format(name=target.stem)
    target.write_text(content, encoding="utf-8")
    return read_testbench_by_path(project_root, str(target))


def delete_testbench_by_path(project_root: str, path: str) -> None:
    target = _resolve_sandboxed_path(project_root, path)
    if target.exists():
        target.unlink()


def _collect_source_files(project_root: str, *, exclude: set[str] | None = None) -> list[str]:
    """Gather .v/.sv files in the project, skipping hidden dirs, the sim
    output sandbox, and any paths listed in `exclude` (typically the active
    testbench, added explicitly later)."""
    root = Path(project_root).resolve()
    tb_root = _testbench_root(project_root).resolve()
    out_root = _sim_out_root(project_root).resolve()
    excluded = exclude or set()

    files: list[str] = []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        if p.suffix.lower() not in (".v", ".sv"):
            continue
        if any(part.startswith(".") for part in p.relative_to(root).parts):
            continue
        rp = p.resolve()
        if str(rp) in excluded:
            continue
        # Skip everything in the testbench sandbox; the caller picks the
        # active testbench explicitly. Discovered testbenches outside the
        # sandbox stay in the source list so their non-testbench modules
        # still compile, but we also skip any other files the user marked
        # as the active testbench above.
        try:
            rp.relative_to(tb_root)
            continue
        except ValueError:
            pass
        try:
            rp.relative_to(out_root)
            continue
        except ValueError:
            pass
        files.append(str(rp))
    return files


# iverilog emits messages like:
#   C:/path/tb_foo.sv:42: syntax error
#   tb_foo.sv:42: error: ...
_MSG_RE = re.compile(
    r"^(?P<file>.+?):(?P<line>\d+):\s*(?:(?P<sev>error|warning|note)\s*:?\s*)?(?P<msg>.*)$",
    re.IGNORECASE,
)


def _parse_messages(stderr: str, default_severity: str = "error") -> list[SimulationMessage]:
    out: list[SimulationMessage] = []
    for raw in (stderr or "").splitlines():
        raw = raw.rstrip()
        if not raw.strip():
            continue
        m = _MSG_RE.match(raw)
        if m and m.group("file") and m.group("line"):
            sev = (m.group("sev") or default_severity).lower()
            if sev == "note":
                sev = "info"
            message = m.group("msg").strip() or raw
            out.append(SimulationMessage(
                severity=sev,
                message=message,
                file=m.group("file").strip(),
                line=int(m.group("line")),
            ))
        else:
            out.append(SimulationMessage(severity="info", message=raw))
    return out


def run_simulation(
    project_root: str,
    testbench_path: str,
    *,
    top_module: str | None = None,
    timeout_sec: float = 30.0,
) -> SimulationResult:
    tools = check_tools()
    if not tools["available"]:
        missing = []
        if not tools["iverilog"]:
            missing.append("iverilog")
        if not tools["vvp"]:
            missing.append("vvp")
        return SimulationResult(
            id="",
            testbench=testbench_path,
            status="tool_missing",
            compile_stderr=(
                f"Icarus Verilog not found on PATH (missing: {', '.join(missing)}). "
                "Install it from https://bleyer.org/icarus/ (Windows), "
                "apt install iverilog (Linux), or brew install icarus-verilog (macOS), "
                "then restart the server."
            ),
        )

    ensure_dirs(project_root)
    tb_path = _resolve_sandboxed_path(project_root, testbench_path)
    if not tb_path.exists():
        raise SimulationError(f"Testbench not found: {tb_path.name}")

    testbench_name = tb_path.name
    resolved_top = (top_module or "").strip() or tb_path.stem

    sim_id = uuid.uuid4().hex[:12]
    out_dir = _sim_out_root(project_root) / sim_id
    out_dir.mkdir(parents=True, exist_ok=True)

    vvp_path = out_dir / f"{resolved_top}.vvp"

    # Avoid compiling the active testbench twice (once via the project scan
    # for discovered testbenches, once explicitly appended below).
    source_files = _collect_source_files(project_root, exclude={str(tb_path)})
    source_files.append(str(tb_path))

    compile_cmd = [
        str(tools["iverilog"]),
        "-g2012",
        "-o", str(vvp_path),
        "-s", resolved_top,
    ] + source_files

    t0 = time.time()
    try:
        compile_proc = subprocess.run(
            compile_cmd,
            cwd=str(out_dir),
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired:
        return SimulationResult(
            id=sim_id,
            testbench=testbench_name,
            top_module=resolved_top,
            status="compile_error",
            compile_stderr=f"Compilation timed out after {timeout_sec}s",
            duration_ms=int((time.time() - t0) * 1000),
        )

    if compile_proc.returncode != 0 or not vvp_path.exists():
        return SimulationResult(
            id=sim_id,
            testbench=testbench_name,
            top_module=resolved_top,
            status="compile_error",
            exit_code=compile_proc.returncode,
            compile_stdout=compile_proc.stdout,
            compile_stderr=compile_proc.stderr,
            messages=_parse_messages(compile_proc.stderr),
            duration_ms=int((time.time() - t0) * 1000),
        )

    try:
        run_proc = subprocess.run(
            [str(tools["vvp"]), str(vvp_path)],
            cwd=str(out_dir),
            capture_output=True,
            text=True,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired:
        return SimulationResult(
            id=sim_id,
            testbench=testbench_name,
            top_module=resolved_top,
            status="runtime_error",
            compile_stdout=compile_proc.stdout,
            compile_stderr=compile_proc.stderr,
            run_stderr=f"Simulation timed out after {timeout_sec}s (increase time limit or reduce runtime).",
            vvp_path=str(vvp_path),
            duration_ms=int((time.time() - t0) * 1000),
        )

    vcd_candidate = out_dir / f"{resolved_top}.vcd"
    found_vcd: Path | None = vcd_candidate if vcd_candidate.exists() else None
    if found_vcd is None:
        for cand in out_dir.glob("*.vcd"):
            found_vcd = cand
            break

    status = "ok" if run_proc.returncode == 0 else "runtime_error"
    messages = (
        _parse_messages(compile_proc.stderr, default_severity="warning")
        + _parse_messages(run_proc.stderr, default_severity="warning")
    )
    return SimulationResult(
        id=sim_id,
        testbench=testbench_name,
        top_module=resolved_top,
        status=status,
        exit_code=run_proc.returncode,
        compile_stdout=compile_proc.stdout,
        compile_stderr=compile_proc.stderr,
        run_stdout=run_proc.stdout,
        run_stderr=run_proc.stderr,
        vcd_path=str(found_vcd) if found_vcd else None,
        vvp_path=str(vvp_path),
        duration_ms=int((time.time() - t0) * 1000),
        messages=messages,
    )


def result_to_dict(result: SimulationResult) -> dict:
    d = asdict(result)
    d["messages"] = [asdict(m) for m in result.messages]
    return d


def prune_old_runs(project_root: str, keep: int = 10) -> None:
    """Keep only the most recent `keep` simulation output folders to avoid
    unbounded disk growth. Safe to call even if nothing exists yet."""
    root = _sim_out_root(project_root)
    if not root.exists():
        return
    runs = [p for p in root.iterdir() if p.is_dir()]
    runs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for stale in runs[keep:]:
        try:
            shutil.rmtree(stale, ignore_errors=True)
        except OSError:
            pass
