from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from app.project_service import ProjectService
from app.signal_tracer import trace_signal


class TestSignalTracer(unittest.TestCase):
    def test_simple_parser_traces_always_block_when_identifier_contains_end(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            (root / "child.v").write_text(
                """
module child(
    input wire dead_end_path,
    output wire passthrough
);
  reg trace_internal_dead_end_seen;
  assign passthrough = dead_end_path;
  always @(*) begin
    trace_internal_dead_end_seen = dead_end_path;
  end
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            (root / "top.v").write_text(
                """
module top(
    input wire src,
    output wire sink
);
  wire branch;
  assign branch = src;
  child u_child (
    .dead_end_path(branch),
    .passthrough(sink)
  );
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            service = ProjectService(parser_backend="simple")
            project = service.load_project(str(root))

            result = trace_signal(project, "top", "branch")
            fanout_kinds = [hop["kind"] for hop in result["fanout"]]
            fanout_details = [hop["detail"] for hop in result["fanout"]]

            self.assertIn("always", fanout_kinds)
            self.assertIn("dead_end", fanout_kinds)
            self.assertTrue(
                any("trace_internal_dead_end_seen = dead_end_path" in detail for detail in fanout_details),
                fanout_details,
            )


if __name__ == "__main__":
    unittest.main()
