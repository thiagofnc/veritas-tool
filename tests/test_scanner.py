import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app.scanner import scan_verilog_files


class TestScanVerilogFiles(unittest.TestCase):
    def test_scans_v_and_sv_and_ignores_hidden_entries(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            (root / "top.v").write_text("module top; endmodule\n", encoding="utf-8")
            (root / "alu.sv").write_text("module alu; endmodule\n", encoding="utf-8")
            (root / "notes.txt").write_text("ignore me\n", encoding="utf-8")
            (root / ".hidden.v").write_text("module hidden; endmodule\n", encoding="utf-8")

            rtl_dir = root / "rtl"
            rtl_dir.mkdir()
            (rtl_dir / "child.v").write_text("module child; endmodule\n", encoding="utf-8")

            hidden_dir = root / ".cache"
            hidden_dir.mkdir()
            (hidden_dir / "ghost.sv").write_text("module ghost; endmodule\n", encoding="utf-8")

            expected = sorted(
                [
                    str((root / "top.v").resolve()),
                    str((root / "alu.sv").resolve()),
                    str((rtl_dir / "child.v").resolve()),
                ]
            )

            self.assertEqual(scan_verilog_files(str(root)), expected)


if __name__ == "__main__":
    unittest.main()
