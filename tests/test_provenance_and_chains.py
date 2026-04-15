"""Coverage for source provenance, parser diagnostics, and trace chains."""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from app.project_service import ProjectService
from app.pyverilog_parser import PyVerilogParser
from app.signal_tracer import trace_signal


TOP = """
module top(
    input wire clk,
    input wire rst_n,
    input wire src,
    output reg sink
);
  wire branch;
  wire inner_out;
  assign branch = src;

  child u_child (
    .in_sig(branch),
    .out_sig(inner_out)
  );

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) sink <= 1'b0;
    else sink <= inner_out;
  end
endmodule
""".strip() + "\n"

CHILD = """
module child(
    input wire in_sig,
    output wire out_sig
);
  assign out_sig = in_sig;
endmodule
""".strip() + "\n"


def _write_project(root: Path) -> None:
    (root / "top.v").write_text(TOP, encoding="utf-8")
    (root / "child.v").write_text(CHILD, encoding="utf-8")


class TestPyVerilogProvenance(unittest.TestCase):
    def test_modules_assigns_and_instances_carry_line_numbers(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _write_project(root)
            project = PyVerilogParser().parse_files([str(root / "child.v"), str(root / "top.v")])
            top = next(m for m in project.modules if m.name == "top")

            self.assertIsNotNone(top.location)
            self.assertGreaterEqual(top.location.line, 1)
            self.assertTrue(any(a.location is not None for a in top.assigns))
            self.assertTrue(all(inst.location is not None for inst in top.instances))
            for block in top.always_blocks:
                self.assertIsNotNone(block.location)
                for assign in block.assignments:
                    self.assertIsNotNone(assign.location)

    def test_parse_failure_produces_diagnostic(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            (root / "good.v").write_text(
                "module good(input a, output b); assign b = a; endmodule\n",
                encoding="utf-8",
            )
            (root / "bad.v").write_text(
                "moduel wrong!@#$ invalid verilog;;\nendmodule\n",
                encoding="utf-8",
            )
            project = PyVerilogParser().parse_files([str(root / "good.v"), str(root / "bad.v")])
            self.assertIn("good", {m.name for m in project.modules})
            parse_failures = [d for d in project.diagnostics if d.kind == "parse_failure"]
            self.assertTrue(parse_failures)
            self.assertEqual(Path(parse_failures[0].file).name, "bad.v")


class TestTracerChainsAndProvenance(unittest.TestCase):
    def test_cross_module_fanout_chain_shows_end_to_end_direct_path(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _write_project(root)
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "top", "src")

            chains = result["chains"]["fanout"]
            self.assertTrue(chains)
            cross_chains = [c for c in chains if any(h.get("crosses") == "down" for h in c)]
            self.assertTrue(cross_chains)
            chain = cross_chains[0]
            details = [hop["detail"] for hop in chain]
            self.assertIn("branch = src", details)
            self.assertTrue(any(h.get("next_module") == "child" for h in chain))
            self.assertTrue(any("out_sig = in_sig" in detail for detail in details))
            for hop in chain:
                self.assertIn("source_file", hop)
                self.assertIn("location", hop)
                self.assertTrue(hop["resolved_module"])

    def test_fanin_chain_reaches_reset_assignment(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _write_project(root)
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "top", "sink")
            fanin = result["fanin"]
            self.assertTrue(any(h["kind"] == "always" for h in fanin))
            always_chains = [c for c in result["chains"]["fanin"] if any(h["kind"] == "always" for h in c)]
            self.assertTrue(always_chains)
            self.assertTrue(
                any(any("rst_n" in (h.get("condition") or "") for h in c) for c in always_chains)
            )

    def test_unresolved_child_module_emits_diagnostic(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
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
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "top", "src")
            kinds = [d["kind"] for d in result["diagnostics"]]
            self.assertIn("unresolved_module", kinds)
            boundary_hops = [h for h in result["fanout"] if h["kind"] == "instance_pin_in"]
            self.assertTrue(boundary_hops)
            self.assertEqual(boundary_hops[0]["next_module"], "missing_child")

    def test_hop_location_anchors_to_source_file(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _write_project(root)
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "top", "branch")
            assign_hops = [h for h in result["fanin"] if h["kind"] == "assign" and h["module"] == "top"]
            self.assertTrue(assign_hops)
            loc = assign_hops[0]["location"]
            self.assertIsNotNone(loc)
            self.assertTrue(loc["file"].endswith("top.v"))
            self.assertGreater(loc["line"], 0)

    def test_bus_slice_pin_still_participates_in_chain(self) -> None:
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
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "top", "data")
            self.assertTrue(any(h.get("next_module") == "child" for h in result["fanout"]))


if __name__ == "__main__":
    unittest.main()
