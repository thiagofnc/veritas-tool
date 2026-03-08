import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

try:
    from app.pyverilog_parser import PyVerilogParser
except Exception:  # pragma: no cover - dependency/setup guard
    PyVerilogParser = None


@unittest.skipUnless(PyVerilogParser is not None, "pyverilog parser backend is unavailable")
class TestPyVerilogParser(unittest.TestCase):
    def test_parses_modules_ports_instances_and_connections(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            (root / "child.v").write_text(
                """
module child(
  input clk,
  input rst,
  input a,
  output y
);
  wire [1:0] child_bus;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            (root / "top.v").write_text(
                """
module top(
  input clk,
  input rst,
  input signal_a,
  output signal_y
);
  wire local_wire;
  child u1 (
    .clk(clk),
    .rst(rst),
    .a(signal_a),
    .y(signal_y)
  );
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            parser = PyVerilogParser()
            project = parser.parse_files([str(root / "child.v"), str(root / "top.v")])

            module_names = sorted(module.name for module in project.modules)
            self.assertEqual(module_names, ["child", "top"])

            top_module = next(module for module in project.modules if module.name == "top")
            port_names = [port.name for port in top_module.ports]
            self.assertEqual(port_names, ["clk", "rst", "signal_a", "signal_y"])
            self.assertEqual([(s.name, s.kind) for s in top_module.signals], [("local_wire", "wire")])

            self.assertEqual(len(top_module.instances), 1)
            instance = top_module.instances[0]
            self.assertEqual(instance.name, "u1")
            self.assertEqual(instance.module_name, "child")
            self.assertEqual(
                instance.connections,
                {
                    "clk": "clk",
                    "rst": "rst",
                    "a": "signal_a",
                    "y": "signal_y",
                },
            )
            self.assertEqual(
                [(pc.child_port, pc.parent_signal) for pc in instance.pin_connections],
                [("clk", "clk"), ("rst", "rst"), ("a", "signal_a"), ("y", "signal_y")],
            )


if __name__ == "__main__":
    unittest.main()
