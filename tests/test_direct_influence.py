"""Direct-influence semantics for the signal tracer.

The cross-module tracer should report only constructs immediately related to
the selected signal. Deeper exploration is an explicit user action.
"""

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from app.project_service import ProjectService
from app.signal_tracer import trace_signal


def _write(root: Path, name: str, body: str) -> None:
    (root / name).write_text(body.strip() + "\n", encoding="utf-8")


class TestControlDependenciesAreDirectDrivers(unittest.TestCase):
    def test_mux_select_is_a_fanin_driver_of_mux_output(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _write(root, "mux.v", """
module mux(input sel, input a, input b, output reg out);
  always @(*) begin
    if (sel) out = a;
    else     out = b;
  end
endmodule
""")
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "mux", "out")

            always_hops = [h for h in result["fanin"] if h["kind"] == "always"]
            self.assertTrue(always_hops, "fanin must list the always block that drives out")

            saw_sel_as_control = False
            saw_data = False
            for hop in always_hops:
                if "sel" in (hop.get("condition_sources") or []):
                    saw_sel_as_control = True
                if hop.get("data_sources"):
                    saw_data = True
            self.assertTrue(saw_sel_as_control)
            self.assertTrue(saw_data)

    def test_mux_select_fanout_reaches_the_mux_output(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _write(root, "mux.v", """
module mux(input sel, input a, input b, output reg out);
  always @(*) begin
    if (sel) out = a;
    else     out = b;
  end
endmodule
""")
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "mux", "sel")

            control_hops = [
                h for h in result["fanout"]
                if h["kind"] == "always" and h.get("dep_kind") == "control"
            ]
            self.assertTrue(control_hops)
            chains = result["chains"]["fanout"]
            self.assertTrue(any(any(h.get("target") == "out" for h in c) for c in chains))

    def test_reset_signal_is_a_fanin_driver_of_the_register(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _write(root, "ff.v", """
module ff(input clk, input rst_n, input d, output reg q);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) q <= 1'b0;
    else        q <= d;
  end
endmodule
""")
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "ff", "q")

            always_hops = [h for h in result["fanin"] if h["kind"] == "always"]
            self.assertTrue(always_hops)
            self.assertTrue(any("rst_n" in (h.get("condition_sources") or []) for h in always_hops))

            reset_result = trace_signal(project, "ff", "rst_n")
            self.assertTrue(
                any(
                    h["kind"] == "always" and h.get("dep_kind") in {"control", "data+control"}
                    for h in reset_result["fanout"]
                )
            )


class TestBitSelectLHSMatching(unittest.TestCase):
    def test_tracing_base_bus_finds_bit_select_assignments(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _write(root, "slicer.v", """
module slicer(input clk, input a, input b, output reg [3:0] q);
  always @(posedge clk) begin
    q[0] <= a;
    q[1] <= b;
  end
endmodule
""")
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "slicer", "q")

            always_hops = [h for h in result["fanin"] if h["kind"] == "always"]
            self.assertEqual(len(always_hops), 2, always_hops)
            details = " ".join(h["detail"] for h in always_hops)
            self.assertIn("q[0]", details)
            self.assertIn("q[1]", details)

    def test_continuous_assign_to_bit_select_matches_base(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _write(root, "slicer.v", """
module slicer(input a, input b, output wire [1:0] q);
  assign q[0] = a;
  assign q[1] = b;
endmodule
""")
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "slicer", "q")

            assign_hops = [h for h in result["fanin"] if h["kind"] == "assign"]
            self.assertEqual(len(assign_hops), 2, assign_hops)


class TestDirectTraceStopsAtCurrentBoundary(unittest.TestCase):
    def test_trace_reports_direct_hops_and_reconstructs_chain(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _write(root, "chain.v", """
module chain(input a, output c);
  wire b;
  assign b = a;
  assign c = b;
endmodule
""")
            project = ProjectService().load_project(str(root))
            result = trace_signal(project, "chain", "c")

            fanin = result["fanin"]
            self.assertEqual(len(fanin), 1, fanin)
            self.assertEqual(fanin[0]["kind"], "assign")
            self.assertEqual(fanin[0]["detail"], "c = b")

            chains = result["chains"]["fanin"]
            self.assertTrue(chains, chains)
            details = [hop["detail"] for hop in chains[0] if hop["kind"] == "assign"]
            self.assertIn("c = b", details)
            self.assertIn("b = a", details)


if __name__ == "__main__":
    unittest.main()
