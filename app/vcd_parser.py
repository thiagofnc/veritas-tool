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
