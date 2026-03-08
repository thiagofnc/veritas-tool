import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app.simple_parser import SimpleRegexParser


class TestSimpleParserConnections(unittest.TestCase):
    def test_named_connections_are_captured_from_multiline_instance(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            child_file = root / "child.v"
            top_file = root / "top.v"

            child_file.write_text(
                """
module child(input clk, input rst, input a);
  wire [3:0] child_bus;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            top_file.write_text(
                """
module top(input clk, input rst, input signal_a);
  wire local_wire;
  child u1 (
    .clk(clk),
    .rst(rst),
    .a(signal_a)
  );
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            parser = SimpleRegexParser()
            project = parser.parse_files([str(child_file), str(top_file)])

            top_module = next(module for module in project.modules if module.name == "top")
            instance = next(inst for inst in top_module.instances if inst.name == "u1")

            self.assertEqual(instance.module_name, "child")
            self.assertEqual(
                instance.connections,
                {
                    "clk": "clk",
                    "rst": "rst",
                    "a": "signal_a",
                },
            )
            self.assertEqual(
                [(pc.child_port, pc.parent_signal) for pc in instance.pin_connections],
                [("clk", "clk"), ("rst", "rst"), ("a", "signal_a")],
            )

            self.assertEqual([(s.name, s.kind) for s in top_module.signals], [("local_wire", "wire")])


if __name__ == "__main__":
    unittest.main()
