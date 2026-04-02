import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app.simple_parser import SimpleRegexParser


class TestSimpleParserConnections(unittest.TestCase):
    def test_named_connections_are_captured_from_multiline_instance(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            child_file = root / 'child.v'
            top_file = root / 'top.v'

            child_file.write_text(
                """
module child(input clk, input rst, input a);
  wire [3:0] child_bus;
endmodule
""".strip()
                + "\n",
                encoding='utf-8',
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
                encoding='utf-8',
            )

            parser = SimpleRegexParser()
            project = parser.parse_files([str(child_file), str(top_file)])

            top_module = next(module for module in project.modules if module.name == 'top')
            instance = next(inst for inst in top_module.instances if inst.name == 'u1')

            self.assertEqual(instance.module_name, 'child')
            self.assertEqual(
                instance.connections,
                {
                    'clk': 'clk',
                    'rst': 'rst',
                    'a': 'signal_a',
                },
            )
            self.assertEqual(
                [(pc.child_port, pc.parent_signal) for pc in instance.pin_connections],
                [('clk', 'clk'), ('rst', 'rst'), ('a', 'signal_a')],
            )

            self.assertEqual([(s.name, s.kind) for s in top_module.signals], [('local_wire', 'wire')])

    def test_extracts_always_process_metadata_and_summary(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            top_file = root / 'top.v'

            top_file.write_text(
                """
module top(input clk, input rst_n, input a, output reg y, output reg q);
  always @(*) begin
    if (a) y = q;
    else y = 1'b0;
  end

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) q <= 1'b0;
    else q <= a;
  end
endmodule
""".strip()
                + "\n",
                encoding='utf-8',
            )

            parser = SimpleRegexParser()
            project = parser.parse_files([str(top_file)])
            top_module = next(module for module in project.modules if module.name == 'top')

            self.assertEqual(len(top_module.always_blocks), 2)
            comb_block = top_module.always_blocks[0]
            seq_block = top_module.always_blocks[1]

            self.assertEqual(comb_block.process_style, 'comb')
            self.assertEqual(comb_block.sensitivity_title, 'ALWAYS @(*)')
            self.assertEqual(comb_block.sensitivity_label, 'COMB')
            self.assertIn('if (a)', comb_block.control_summary)
            self.assertIn('q', comb_block.read_signals)
            self.assertIn('y', comb_block.written_signals)

            self.assertEqual(seq_block.process_style, 'seq')
            self.assertEqual(seq_block.edge_polarity, 'mixed')
            self.assertEqual(seq_block.clock_signal, 'clk')
            self.assertEqual(seq_block.sensitivity_label, 'SEQ posedge clk')
            self.assertTrue(any('q <=' in line for line in seq_block.summary_lines))


if __name__ == '__main__':
    unittest.main()
