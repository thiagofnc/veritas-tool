"""Lightweight VCD (Value Change Dump) parser.

Produces a JSON-friendly structure the UI waveform viewer can render:

    {
      "timescale": "1ns",
      "end_time": 12345,
      "date": "...",
      "version": "...",
      "signals": [
        {
          "id": "!",
          "name": "clk",
          "scope": "tb.dut",
          "full_name": "tb.dut.clk",
          "kind": "reg",
          "width": 1,
          "changes": [[t0, "0"], [t1, "1"], ...]
        },
        ...
      ]
    }

Bus values are stored in the raw VCD form ("b0101"). The frontend is
responsible for radix conversion so the user can switch between binary,
hex, and decimal without re-parsing.
"""

from __future__ import annotations

import bisect
from pathlib import Path


def parse_vcd(path: str, *, max_signals: int = 4000) -> dict:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(str(p))

    text = p.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    n = len(lines)

    timescale = ""
    date = ""
    version = ""
    scope_stack: list[str] = []
    sig_by_id: dict[str, dict] = {}
    current_time = 0
    end_time = 0
    in_defs = True
    i = 0

    def read_block(parts: list[str], start: int) -> tuple[str, int]:
        """Read a `$keyword ... $end` block starting at line `start`."""
        buf = parts[1:]
        j = start
        if buf and buf[-1] == "$end":
            return " ".join(buf[:-1]).strip(), j
        while j < n:
            toks = lines[j].strip().split()
            j += 1
            if "$end" in toks:
                idx = toks.index("$end")
                buf.extend(toks[:idx])
                break
            buf.extend(toks)
        return " ".join(buf).strip(), j

    while i < n:
        line = lines[i].strip()
        i += 1
        if not line:
            continue

        if in_defs:
            parts = line.split()
            if not parts:
                continue
            head = parts[0]

            if head == "$timescale":
                timescale, i = read_block(parts, i)
                continue
            if head == "$date":
                date, i = read_block(parts, i)
                continue
            if head == "$version":
                version, i = read_block(parts, i)
                continue
            if head == "$scope":
                name = parts[2] if len(parts) >= 3 else "?"
                scope_stack.append(name)
                continue
            if head == "$upscope":
                if scope_stack:
                    scope_stack.pop()
                continue
            if head == "$var":
                # $var <kind> <width> <id> <name> [<bitrange>] $end
                # len(parts) can be 6 (no bitrange) or 7 (with bitrange)
                if len(parts) >= 6:
                    kind = parts[1]
                    width_raw = parts[2]
                    try:
                        width = int(width_raw)
                    except ValueError:
                        width = 1
                    ident = parts[3]
                    name = parts[4]
                    # attach bitrange to the name so the UI can show [7:0] etc.
                    if len(parts) >= 7 and parts[5].startswith("["):
                        name = f"{name} {parts[5]}"
                    scope = ".".join(scope_stack)
                    full_name = f"{scope}.{name}" if scope else name
                    if ident not in sig_by_id and len(sig_by_id) < max_signals:
                        sig_by_id[ident] = {
                            "id": ident,
                            "name": name,
                            "scope": scope,
                            "full_name": full_name,
                            "kind": kind,
                            "width": width,
                            "changes": [],
                        }
                continue
            if head == "$enddefinitions":
                in_defs = False
                continue
            # Ignore other definition-section keywords.
            continue

        # -------------------- value change section --------------------
        first = line[0]

        if first == "#":
            try:
                current_time = int(line[1:].split()[0])
            except (ValueError, IndexError):
                continue
            if current_time > end_time:
                end_time = current_time
            continue

        if line.startswith("$"):
            # $dumpvars / $dumpall / $dumpon / $dumpoff / $end — skip wrapper
            continue

        if first in ("b", "B", "r", "R"):
            rest = line[1:].split(None, 1)
            if len(rest) == 2:
                val, ident = rest
                sig = sig_by_id.get(ident)
                if sig is not None:
                    sig["changes"].append([current_time, val])
            continue

        # Scalar change: "0!" / "1!" / "x!" / "z!"
        val = first
        ident = line[1:].strip()
        sig = sig_by_id.get(ident)
        if sig is not None:
            sig["changes"].append([current_time, val])

    return {
        "timescale": timescale,
        "date": date,
        "version": version,
        "end_time": end_time,
        "signals": list(sig_by_id.values()),
    }


def _signal_value_at(changes: list[list], t: int) -> str | None:
    """Return the signal value at simulation time *t* using binary search.

    Each entry in *changes* is ``[time, value]``.  Returns the value of the
    last change whose time is <= *t*, or ``None`` if no change has occurred
    yet.
    """
    if not changes:
        return None
    # changes are already sorted by time from the parser
    times = [c[0] for c in changes]
    idx = bisect.bisect_right(times, t) - 1
    if idx < 0:
        return None
    return changes[idx][1]


def snapshot_at(vcd: dict, times: list[int],
                signal_filter: list[str] | None = None,
                max_signals: int = 60) -> list[dict]:
    """Return signal values at each requested simulation time.

    Parameters
    ----------
    vcd : dict
        Parsed VCD as returned by ``parse_vcd``.
    times : list[int]
        Simulation timestamps to sample.
    signal_filter : list[str] | None
        If given, only include signals whose ``full_name`` or ``name``
        contains one of these substrings (case-insensitive).
    max_signals : int
        Cap the number of signals per snapshot to keep output compact.

    Returns
    -------
    list[dict]
        One dict per requested time::

            {"time": 500, "signals": {"tb.dut.clk": "1", "tb.dut.out": "b1010"}}
    """
    signals = vcd.get("signals", [])

    # Apply optional filter
    if signal_filter:
        lc_filter = [f.lower() for f in signal_filter]
        filtered = []
        for sig in signals:
            fn = sig["full_name"].lower()
            nm = sig["name"].lower()
            if any(f in fn or f in nm for f in lc_filter):
                filtered.append(sig)
        signals = filtered

    signals = signals[:max_signals]

    snapshots = []
    for t in times:
        values: dict[str, str] = {}
        for sig in signals:
            val = _signal_value_at(sig["changes"], t)
            if val is not None:
                values[sig["full_name"]] = val
        snapshots.append({"time": t, "signals": values})
    return snapshots


def waveform_window(vcd: dict, t_center: int, window: int = 20,
                    signal_filter: list[str] | None = None,
                    max_signals: int = 40) -> list[dict]:
    """Return all signal transitions in a window around *t_center*.

    This gives the agent a view of how signals evolved leading up to
    and just after a point of interest (e.g. a test failure).

    Returns a list of change records sorted by time::

        [{"time": 490, "signal": "tb.dut.out", "value": "b1010"}, ...]
    """
    t_lo = max(0, t_center - window)
    t_hi = t_center + window

    signals = vcd.get("signals", [])
    if signal_filter:
        lc_filter = [f.lower() for f in signal_filter]
        signals = [
            s for s in signals
            if any(f in s["full_name"].lower() or f in s["name"].lower()
                   for f in lc_filter)
        ]
    signals = signals[:max_signals]

    changes = []
    for sig in signals:
        for t_val, val in sig["changes"]:
            if t_lo <= t_val <= t_hi:
                changes.append({
                    "time": t_val,
                    "signal": sig["full_name"],
                    "value": val,
                })
    changes.sort(key=lambda c: (c["time"], c["signal"]))
    return changes
