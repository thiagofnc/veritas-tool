"""Icarus Verilog (iverilog + vvp) simulation runner.

Compiles the project sources together with a user-authored testbench,
executes the resulting vvp image, and hands back compile/run output plus
the path to the generated VCD. The service deliberately keeps its on-disk
footprint inside the loaded project folder:

    <project>/testbenches/        -- user testbench sources (.sv / .v)
    <project>/.veritas_sim/<id>/  -- per-run compile + run artifacts (vvp, vcd)
"""

from __future__ import annotations

import difflib
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
class TestEvent:
    """A single PASS/FAIL check extracted from run output.

    Produced by scanning stdout/stderr line-by-line. When the testbench
    includes a simulation timestamp (e.g. ``$display("PASS [t=%0t] ...")``)
    the UI pins a marker on the waveform at that point so failures are easy
    to localize. Events without a timestamp still contribute to counts."""
    verdict: str                     # "pass" | "fail"
    name: str                        # short label shown in the results list
    time: int | None = None          # simulation time (same units as the VCD)
    detail: str = ""                 # remainder of the line (for hover / log)
    raw: str = ""                    # original line, for debugging


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
    # Verdict + counters computed from run output.
    verdict: str = "unknown"         # pass | fail | unknown
    verdict_reason: str = ""         # human-readable explanation of the verdict
    pass_count: int = 0
    fail_count: int = 0
    error_count: int = 0
    warning_count: int = 0
    assertion_count: int = 0
    fatal_count: int = 0
    # Expected-output comparison (populated when a golden file was found).
    expected_path: str | None = None
    expected_matched: bool | None = None
    diff: str = ""                   # unified diff excerpt (empty on match or absent)
    timed_out: bool = False
    test_events: list[TestEvent] = field(default_factory=list)


class SimulationError(RuntimeError):
    pass


DEFAULT_TB_TEMPLATE = """`timescale 1ns/1ps

// Auto-generated testbench scaffold.
//
// Conventions this tool understands:
//   * Emit one PASS / FAIL line per check. The helpers below use
//     $display("PASS [t=%0t] <name>")  and $display("FAIL [t=%0t] ...").
//     The [t=...] marker is parsed out and pinned to the waveform so you
//     can jump straight to the point of failure.
//   * $fatal / $error from SystemVerilog also count as failures.
//   * Drop a <tb_name>.expected.txt file next to this testbench to diff
//     stdout against a golden reference automatically.

module {name};

  reg clk = 1'b0;
  always #5 clk = ~clk;

  reg rst_n = 1'b0;

  // TODO: declare DUT I/O regs / wires here.

  // TODO: instantiate the DUT here, e.g.
  //   my_module dut (.clk(clk), .rst_n(rst_n), ...);

  integer errors = 0;
  integer checks = 0;

  // Compare `actual` against `expected`. Emits a single PASS or FAIL line,
  // tagged with $time so the tool can mark it on the waveform.
  task automatic check;
    input [255:0] label;           // short test name, padded string
    input [63:0]  expected;
    input [63:0]  actual;
    begin
      checks = checks + 1;
      if (actual === expected) begin
        $display("PASS [t=%0t] %0s", $time, label);
      end else begin
        $display("FAIL [t=%0t] %0s: expected 0x%0h, got 0x%0h",
                 $time, label, expected, actual);
        errors = errors + 1;
      end
    end
  endtask

  initial begin
    $dumpfile("{name}.vcd");
    $dumpvars(0, {name});

    #20 rst_n = 1'b1;

    // Example checks:
    //   check("reset clears count", 8'h00, dut.count);
    //   @(posedge clk);
    //   check("increment works",    8'h01, dut.count);

    #200;
    if (errors == 0)
      $display("PASS [t=%0t] %0d checks passed", $time, checks);
    else
      $display("FAIL [t=%0t] %0d of %0d checks failed", $time, errors, checks);
    $finish;
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


# Verdict / counter heuristics applied to run-phase stdout+stderr.
#
# PASS / FAIL markers: match on whole tokens so a normal word like "passed"
# inside a sentence still counts, but we avoid matching substrings like
# "Bypass" or "Unsurpassed". The regex is anchored by word boundaries and
# a small set of common testbench idioms (TEST PASSED, ALL TESTS PASSED).
_PASS_MARKER_RE = re.compile(
    r"\b(?:ALL\s+TESTS?\s+PASSED|TESTS?\s+PASSED|PASSED|PASS)\b",
    re.IGNORECASE,
)
_FAIL_MARKER_RE = re.compile(
    r"\b(?:TESTS?\s+FAILED|FAILED|FAILURE|FAIL)\b",
    re.IGNORECASE,
)
# Icarus formats $error / $fatal / $warning as lines that start (after any
# leading filename:line: prefix) with ERROR / WARNING / FATAL. We also catch
# the raw $error / $fatal / $warning tokens in case the testbench prints them
# verbatim with $display.
_ERROR_LINE_RE = re.compile(r"(?:^|[\s:])(?:ERROR|\$error|\$fatal)\b", re.IGNORECASE)
_FATAL_LINE_RE = re.compile(r"(?:^|[\s:])(?:FATAL|\$fatal)\b", re.IGNORECASE)
_WARN_LINE_RE = re.compile(r"(?:^|[\s:])(?:WARNING|\$warning)\b", re.IGNORECASE)
_ASSERT_LINE_RE = re.compile(r"\bassert(?:ion)?\b.*\b(?:fail|error|violat)", re.IGNORECASE)


@dataclass
class _RunAnalysis:
    pass_count: int = 0
    fail_count: int = 0
    error_count: int = 0
    warning_count: int = 0
    assertion_count: int = 0
    fatal_count: int = 0
    events: list[TestEvent] = field(default_factory=list)


# Timestamp qualifiers we understand inside a PASS/FAIL line.
# Ordered roughly by how common each form is in the wild; the first match
# on a line wins. All patterns capture the numeric time in group 1; an
# optional unit suffix (ns/ps/us) is ignored because the VCD is in the
# simulator's base time unit, which is the same base $time prints in.
_TIME_QUAL_PATTERNS = [
    re.compile(r"\[\s*t\s*=\s*(\d+)\s*[a-zA-Z]*\s*\]"),             # [t=123] / [t=123ns]
    re.compile(r"\(\s*t\s*=\s*(\d+)\s*[a-zA-Z]*\s*\)"),             # (t=123)
    re.compile(r"@\s*(\d+)\s*[a-zA-Z]*"),                           # @123 / @123ns
    re.compile(r"\bat\s+time\s*=?\s*(\d+)\s*[a-zA-Z]*", re.IGNORECASE),  # at time 123 ns
    re.compile(r"\bat\s+t\s*=\s*(\d+)\s*[a-zA-Z]*", re.IGNORECASE),      # at t=123 ns
    re.compile(r"\btime\s*=\s*(\d+)\s*[a-zA-Z]*", re.IGNORECASE),        # time=123 ns
]

# Verdict keyword anywhere in the line (captured with its original casing
# so we can tell PASS vs FAILED vs $error apart for counter buckets).
_EVENT_VERDICT_RE = re.compile(
    r"\b(?P<v>PASS(?:ED)?|FAIL(?:ED|URE)?|ERROR|\$error|\$fatal|FATAL)\b",
    re.IGNORECASE,
)


def _strip_time_qualifiers(s: str) -> str:
    out = s
    for pat in _TIME_QUAL_PATTERNS:
        out = pat.sub("", out)
    return out.strip(" \t:-")


def _extract_time(line: str) -> int | None:
    for pat in _TIME_QUAL_PATTERNS:
        m = pat.search(line)
        if m:
            try:
                return int(m.group(1))
            except (ValueError, TypeError):
                return None
    return None


def _analyze_run_output(text: str) -> _RunAnalysis:
    """Scan combined run stdout+stderr for test events + counters.

    Each line with a recognized verdict keyword (PASS / FAIL / ERROR /
    $error / $fatal / FATAL) becomes a TestEvent. If the line also carries
    a timestamp qualifier like ``[t=123]`` or ``@123``, that simulation
    time is extracted so the UI can pin the event to the waveform.

    Counters are derived from these events plus two extra scans for things
    that don't produce per-test events: WARNING/$warning lines and
    assertion-failure mentions (for testbenches that use raw `assert ...`).
    """
    a = _RunAnalysis()
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("VCD info:"):
            continue

        # WARNING and assertion counters run independently — they don't
        # produce per-test events (warnings aren't tests; a bare "assertion
        # failed" line is usually followed by an ERROR line anyway).
        if _WARN_LINE_RE.search(line):
            a.warning_count += 1
        if _ASSERT_LINE_RE.search(line):
            a.assertion_count += 1

        m = _EVENT_VERDICT_RE.search(line)
        if not m:
            continue

        v_raw = m.group("v").lower().lstrip("$")
        is_fatal = v_raw.startswith("fatal")
        is_error = v_raw.startswith("error")
        is_fail = v_raw.startswith("fail")
        is_pass = v_raw.startswith("pass")

        # Bucket into the counter breakdown shown in the Results tab.
        if is_fatal:
            a.fatal_count += 1
        if is_error:
            a.error_count += 1

        if is_pass:
            verdict = "pass"
            a.pass_count += 1
        elif is_fail or is_error or is_fatal:
            verdict = "fail"
            if is_fail:
                a.fail_count += 1
        else:
            continue

        # Build a short label: everything after the verdict token, with
        # the timestamp qualifier stripped so it doesn't duplicate the
        # event's `time` field in the UI.
        tail = line[m.end():].strip()
        tail = tail.lstrip(":-").strip()
        tail = _strip_time_qualifiers(tail)
        t = _extract_time(line)
        # Name = first sentence (up to colon/dash), detail = full tail.
        name = tail.split(":", 1)[0].strip()
        if not name:
            name = tail[:80].strip() or v_raw.upper()

        a.events.append(TestEvent(
            verdict=verdict,
            name=name[:160],
            time=t,
            detail=tail[:400],
            raw=line[:400],
        ))
    return a


def _discover_expected_file(tb_path: Path) -> Path | None:
    """Look for a golden-output file next to the testbench.

    Accepted names (checked in order):
        <stem>.expected.txt
        <stem>.expected
        <stem>.golden.txt
        <stem>.golden
    """
    stem = tb_path.stem
    parent = tb_path.parent
    for suffix in (".expected.txt", ".expected", ".golden.txt", ".golden"):
        cand = parent / f"{stem}{suffix}"
        if cand.is_file():
            return cand
    return None


def _compare_expected(actual: str, expected_path: Path) -> tuple[bool, str]:
    """Return (matched, diff_excerpt). Comparison normalizes line endings and
    trims trailing whitespace per line. Empty expected file => matches any
    output (treated as 'no expectation set')."""
    try:
        expected_raw = expected_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return False, f"(failed to read expected file: {exc})"

    def normalize(s: str) -> list[str]:
        return [ln.rstrip() for ln in s.replace("\r\n", "\n").split("\n")]

    exp_lines = normalize(expected_raw)
    got_lines = normalize(actual)
    # Drop a single trailing blank line on either side so files ending with a
    # newline don't spuriously mismatch.
    if exp_lines and exp_lines[-1] == "":
        exp_lines.pop()
    if got_lines and got_lines[-1] == "":
        got_lines.pop()
    if exp_lines == got_lines:
        return True, ""
    diff = list(difflib.unified_diff(
        exp_lines, got_lines,
        fromfile="expected", tofile="actual",
        lineterm="",
    ))
    # Cap diff size so a runaway log doesn't blow up the response payload.
    MAX_LINES = 200
    if len(diff) > MAX_LINES:
        diff = diff[:MAX_LINES] + [f"... ({len(diff) - MAX_LINES} more diff lines truncated)"]
    return False, "\n".join(diff)


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
    expected_path: str | None = None,
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
            timed_out=True,
            verdict="fail",
            verdict_reason=f"Compilation timed out after {timeout_sec}s.",
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
            verdict="fail",
            verdict_reason="Compilation failed — see the Messages tab for source locations.",
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
            timed_out=True,
            verdict="fail",
            verdict_reason=f"Simulation timed out after {timeout_sec}s.",
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

    # Verdict analysis: scan combined run output for PASS/FAIL markers and
    # error counters. Treat stderr the same as stdout here — Icarus routes
    # $error/$fatal messages to stderr, but user $display output lands on
    # stdout, and testbenches aren't consistent about which they use.
    analysis = _analyze_run_output((run_proc.stdout or "") + "\n" + (run_proc.stderr or ""))

    # Resolve an expected-output file. Explicit override (from API payload)
    # wins; otherwise look next to the testbench for a golden file.
    expected_file: Path | None = None
    if expected_path:
        try:
            expected_file = _resolve_sandboxed_path(project_root, expected_path)
        except SimulationError:
            expected_file = None
        if expected_file and not expected_file.is_file():
            expected_file = None
    if expected_file is None:
        expected_file = _discover_expected_file(tb_path)

    expected_matched: bool | None = None
    diff_text = ""
    if expected_file is not None:
        expected_matched, diff_text = _compare_expected(run_proc.stdout or "", expected_file)

    # Decide the verdict. Precedence, worst → best:
    #   compile/runtime failure from the shell, then golden mismatch, then
    #   explicit FAIL markers or error-counter signals, then PASS markers,
    #   then "unknown" (ran cleanly but said nothing about pass/fail).
    verdict = "unknown"
    reason = ""
    if status != "ok":
        verdict = "fail"
        reason = f"Simulation exited with code {run_proc.returncode}."
    elif expected_matched is False:
        verdict = "fail"
        reason = f"Output differs from {expected_file.name}."
    elif analysis.fatal_count > 0 or analysis.fail_count > 0 or analysis.error_count > 0 or analysis.assertion_count > 0:
        verdict = "fail"
        bits = []
        if analysis.fail_count:
            bits.append(f"{analysis.fail_count} FAIL marker(s)")
        if analysis.error_count:
            bits.append(f"{analysis.error_count} $error/ERROR line(s)")
        if analysis.fatal_count:
            bits.append(f"{analysis.fatal_count} $fatal line(s)")
        if analysis.assertion_count:
            bits.append(f"{analysis.assertion_count} assertion failure(s)")
        reason = "Run reported " + ", ".join(bits) + "."
    elif analysis.pass_count > 0 or expected_matched is True:
        verdict = "pass"
        if expected_matched is True:
            reason = f"Output matches {expected_file.name}."
        else:
            reason = f"{analysis.pass_count} PASS marker(s), no errors."
    else:
        verdict = "unknown"
        reason = "No PASS/FAIL markers and no golden file — add $display(\"PASS\") or a .expected.txt file next to the testbench."

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
        verdict=verdict,
        verdict_reason=reason,
        pass_count=analysis.pass_count,
        fail_count=analysis.fail_count,
        error_count=analysis.error_count,
        warning_count=analysis.warning_count,
        assertion_count=analysis.assertion_count,
        fatal_count=analysis.fatal_count,
        expected_path=str(expected_file) if expected_file else None,
        expected_matched=expected_matched,
        diff=diff_text,
        test_events=analysis.events,
    )


def result_to_dict(result: SimulationResult) -> dict:
    d = asdict(result)
    d["messages"] = [asdict(m) for m in result.messages]
    d["test_events"] = [asdict(e) for e in result.test_events]
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
