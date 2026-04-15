import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from app import simulation_service


class TestSimulationService(unittest.TestCase):
    def test_run_simulation_returns_testbench_name_on_success(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            design = root / "top.v"
            tb = root / "testbenches" / "tb_top.sv"
            design.write_text(
                """
module top;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )
            tb.parent.mkdir(parents=True, exist_ok=True)
            tb.write_text(
                """
module tb_top;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            compile_result = subprocess.CompletedProcess(
                args=["iverilog"],
                returncode=0,
                stdout="compile ok",
                stderr="",
            )
            run_result = subprocess.CompletedProcess(
                args=["vvp"],
                returncode=0,
                stdout="run ok",
                stderr="",
            )

            call_index = {"count": 0}

            def fake_run(*args, **kwargs):
                idx = call_index["count"]
                call_index["count"] += 1
                if idx == 0:
                    vvp_path = Path(args[0][3])
                    vvp_path.parent.mkdir(parents=True, exist_ok=True)
                    vvp_path.write_text("", encoding="utf-8")
                    return compile_result
                return run_result

            with patch.object(
                simulation_service,
                "check_tools",
                return_value={"available": True, "iverilog": "iverilog", "vvp": "vvp"},
            ), patch.object(simulation_service.subprocess, "run", side_effect=fake_run):
                result = simulation_service.run_simulation(str(root), str(tb))

            self.assertEqual(result.status, "ok")
            self.assertEqual(result.testbench, "tb_top.sv")
            self.assertEqual(result.top_module, "tb_top")
            self.assertEqual(result.run_stdout, "run ok")

    def test_run_simulation_returns_testbench_name_on_compile_timeout(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            tb = root / "testbenches" / "tb_top.sv"
            tb.parent.mkdir(parents=True, exist_ok=True)
            tb.write_text(
                """
module tb_top;
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            with patch.object(
                simulation_service,
                "check_tools",
                return_value={"available": True, "iverilog": "iverilog", "vvp": "vvp"},
            ), patch.object(
                simulation_service.subprocess,
                "run",
                side_effect=subprocess.TimeoutExpired(cmd=["iverilog"], timeout=1.0),
            ):
                result = simulation_service.run_simulation(str(root), str(tb), timeout_sec=1.0)

            self.assertEqual(result.status, "compile_error")
            self.assertEqual(result.testbench, "tb_top.sv")
            self.assertEqual(result.top_module, "tb_top")
            self.assertIn("timed out", result.compile_stderr.lower())


if __name__ == "__main__":
    unittest.main()
