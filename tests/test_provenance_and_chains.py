"""Coverage for source provenance, parser diagnostics, and trace chains.

These tests lock in the behavior that every major construct carries a
``SourceLocation`` and that the tracer emits end-to-end chains plus
diagnostics for unresolved modules and partial parses.
"""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from app.models import Project
from app.project_service import ProjectService
from app.signal_tracer import trace_signal
from app.simple_parser import SimpleRegexParser

try:
    from app.pyverilog_parser import PyVerilogParser
except Exception:  # pragma: no cover - optional dependency
    PyVerilogParser = None


SIMPLE_TOP = """
module top(
    input wire clk,
    input wire rst_n,
    input wire src,
    output reg sink
);
  wire branch;
  assign branch = src;

  child u_child (
    .in_sig(branch),
    .out_sig(inner_out)
  );

  wire inner_out;

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) sink <= 1'b0;
    else sink <= inner_out;
  end
endmodule
""".strip() + "\n"

SIMPLE_CHILD = """
module child(
    input wire in_sig,
    output wire out_sig
);
  assign out_sig = in_sig;
endmodule
""".strip() + "\n"


def _load_simple_project(root: Path) -> Project:
    (root / "top.v").write_text(SIMPLE_TOP, encoding="utf-8")
    (root / "child.v").write_text(SIMPLE_CHILD, encoding="utf-8")
    return SimpleRegexParser().parse_files([str(root / "child.v"), str(root / "top.v")])


class TestSimpleParserProvenance(unittest.TestCase):
    def test_module_assign_and_always_carry_line_numbers(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            project = _load_simple_project(root)
            top = next(m for m in project.modules if m.name == "top")

            # `module top(` is on line 1 of the file after strip+newline.
            self.assertIsNotNone(top.location)
            self.assertEqual(top.location.line, 1)
            self.assertTrue(top.location.file.endswith("top.v"))

            # The assign statement sits after the 5-line header.
            assign = next(a for a in top.assigns if a.target == "branch")
            self.assertIsNotNone(assign.location)
            self.assertEqual(Path(assign.location.file).name, "top.v")
            with open(root / "top.v", encoding="utf-8") as fh:
                lines = fh.readlines()
            self.assertIn("assign branch", lines[assign.location.line - 1])

            # The always block and its reset assignment resolve to real lines.
            always = next(b for b in top.always_blocks if b.kind.startswith("always"))
            self.assertIsNotNone(always.location)
            self.assertIn("always", lines[always.location.line - 1])

            reset_assign = next(
                a for a in always.assignments if "0" in a.expression and a.target == "sink"
            )
            self.assertIsNotNone(reset_assign.location)
            self.assertIn("sink", lines[reset_assign.location.line - 1])

    def test_comment_stripping_preserves_line_numbers(self) -> None:
        """A block comment that contains `module` must not shift offsets."""
        src = (
            "// leading comment\n"
            "/* multi\n"
            "   line\n"
            "   comment including the word module */\n"
            "module boxed(input a, output b);\n"
            "  assign b = a;\n"
            "endmodule\n"
        )
        with TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "boxed.v"
            path.write_text(src, encoding="utf-8")
            project = SimpleRegexParser().parse_files([str(path)])
            module = next(m for m in project.modules if m.name == "boxed")
            self.assertEqual(module.location.line, 5)
            assign = module.assigns[0]
            self.assertEqual(assign.location.line, 6)


class TestSimpleParserDiagnostics(unittest.TestCase):
    def test_read_failure_is_reported_as_diagnostic(self) -> None:
        # Point the parser at a .v path that doesn't exist on disk.
        missing = Path(TemporaryDirectory().name) / "ghost.v"
        project = SimpleRegexParser().parse_files([str(missing)])
        kinds = [d.kind for d in project.diagnostics]
        self.assertIn("read_failure", kinds)
        self.assertEqual(project.diagnostics[0].severity, "error")


@unittest.skipUnless(PyVerilogParser is not None, "pyverilog parser backend unavailable")
class TestPyVerilogProvenance(unittest.TestCase):
    def test_modules_and_instances_carry_line_numbers(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "top.v").write_text(SIMPLE_TOP, encoding="utf-8")
            (root / "child.v").write_text(SIMPLE_CHILD, encoding="utf-8")
            project = PyVerilogParser().parse_files([
                str(root / "child.v"), str(root / "top.v"),
            ])
            top = next(m for m in project.modules if m.name == "top")
            self.assertIsNotNone(top.location)
            self.assertGreaterEqual(top.location.line, 1)
            # Every instance must know where it was declared.
            for inst in top.instances:
                self.assertIsNotNone(inst.location)
                self.assertGreater(inst.location.line, 0)
            # At least one assign must carry a location.
            self.assertTrue(any(a.location is not None for a in top.assigns))
            # Each always assignment should carry a line.
            for block in top.always_blocks:
                for assign in block.assignments:
                    self.assertIsNotNone(assign.location)

    def test_parse_failure_produces_diagnostic_not_silent_drop(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "good.v").write_text(
                "module good(input a, output b); assign b = a; endmodule\n",
                encoding="utf-8",
            )
            # Gibberish that pyverilog cannot parse.
            (root / "bad.v").write_text(
                "moduel wrong!@#$ invalid verilog;;\nendmodule\n",
                encoding="utf-8",
            )
            project = PyVerilogParser().parse_files([
                str(root / "good.v"), str(root / "bad.v"),
            ])
            # The good module must still be parsed.
            self.assertIn("good", {m.name for m in project.modules})
            # The bad file must produce a diagnostic.
            parse_failures = [d for d in project.diagnostics if d.kind == "parse_failure"]
            self.assertTrue(parse_failures, "Expected parse_failure diagnostic for bad.v")
            self.assertTrue(Path(parse_failures[0].file).name == "bad.v")


class TestTracerChainsAndProvenance(unittest.TestCase):
    def test_cross_module_fanout_chain_stays_on_direct_relation(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _load_simple_project(root)
            service = ProjectService(parser_backend="simple")
            project = service.load_project(str(root))
            result = trace_signal(project, "top", "src")

            # Direct tracing should stop at the first local load.
            chains = result["chains"]["fanout"]
            self.assertTrue(chains, "Expected non-empty fanout chains")
            self.assertEqual(len(chains), 1, chains)
            self.assertEqual(len(chains[0]), 1, chains)
            hop = chains[0][0]
            self.assertEqual(hop["module"], "top")
            self.assertEqual(hop["kind"], "assign")
            self.assertEqual(hop["detail"], "branch = src")
            self.assertIn("source_file", hop)
            self.assertIn("location", hop)
            self.assertTrue(hop["resolved_module"])

    def test_fanin_chain_reaches_reset_assignment(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _load_simple_project(root)
            service = ProjectService(parser_backend="simple")
            project = service.load_project(str(root))
            # sink is driven by the reset always block — fanin must include it.
            result = trace_signal(project, "top", "sink")
            fanin = result["fanin"]
            self.assertTrue(
                any(h["kind"] == "always" for h in fanin),
                "Expected the sequential always block on the sink fanin",
            )
            chains = result["chains"]["fanin"]
            always_chains = [c for c in chains if any(h["kind"] == "always" for h in c)]
            self.assertTrue(always_chains)
            # At least one chain should include a reset condition (either
            # "!rst_n" as recorded by the simple parser or plain reset text).
            self.assertTrue(
                any(
                    any("rst_n" in (h.get("condition") or "") for h in c)
                    for c in always_chains
                ),
                "Expected at least one chain to capture the reset condition",
            )

    def test_unresolved_child_module_emits_diagnostic(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            # Only define top, with an instance of a child we never supply.
            (root / "top.v").write_text(
                """
module top(input wire src, output wire sink);
  missing_child u_missing (
    .in_sig(src),
    .out_sig(sink)
  );
endmodule
""".strip() + "\n",
                encoding="utf-8",
            )
            service = ProjectService(parser_backend="simple")
            project = service.load_project(str(root))
            result = trace_signal(project, "top", "src")
            kinds = [d["kind"] for d in result["diagnostics"]]
            self.assertIn(
                "unresolved_module", kinds,
                "Trace must surface a diagnostic when a child module is missing",
            )
            boundary_hops = [h for h in result["fanout"] if h["kind"] == "instance_pin_in"]
            self.assertTrue(boundary_hops, result["fanout"])
            self.assertEqual(boundary_hops[0]["next_module"], "missing_child")

    def test_hop_location_anchors_to_source_file(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _load_simple_project(root)
            service = ProjectService(parser_backend="simple")
            project = service.load_project(str(root))
            result = trace_signal(project, "top", "branch")
            assign_hops = [
                h for h in result["fanin"] if h["kind"] == "assign" and h["module"] == "top"
            ]
            self.assertTrue(assign_hops)
            loc = assign_hops[0]["location"]
            self.assertIsNotNone(loc)
            self.assertTrue(loc["file"].endswith("top.v"))
            self.assertGreater(loc["line"], 0)

    def test_bus_slice_pin_still_participates_in_chain(self) -> None:
        """Pin connections with part-selects must not break trace continuity.

        The tracer currently collapses ``foo[3:0]`` to ``foo`` for discovery.
        That's a known simplification; the important behavior this test locks
        in is that the chain still walks from ``top`` into ``child`` through
        the sliced pin, rather than terminating early because the sliced form
        didn't match the bus name.
        """
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "child.v").write_text(
                """
module child(input wire [3:0] in_bus, output wire y);
  assign y = |in_bus;
endmodule
""".strip() + "\n",
                encoding="utf-8",
            )
            (root / "top.v").write_text(
                """
module top(input wire [7:0] data, output wire y);
  child u1 (
    .in_bus(data[3:0]),
    .y(y)
  );
endmodule
""".strip() + "\n",
                encoding="utf-8",
            )
            service = ProjectService(parser_backend="simple")
            project = service.load_project(str(root))
            result = trace_signal(project, "top", "data")
            # The fanout must traverse into child.in_bus despite the slice.
            self.assertTrue(
                any(h.get("next_module") == "child" for h in result["fanout"]),
                "Trace must cross into child through the sliced pin",
            )


if __name__ == "__main__":
    unittest.main()
