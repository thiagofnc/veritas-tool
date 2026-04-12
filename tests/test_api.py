import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from unittest.mock import patch

try:
    from fastapi.testclient import TestClient

    from app import api as api_module
    from app.api import app, state, state_lock
    from app.project_service import ProjectService
except Exception:  # pragma: no cover - dependency/setup guard
    TestClient = None


@unittest.skipUnless(TestClient is not None, "FastAPI test client is unavailable")
class TestApi(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        with state_lock:
            state.service = ProjectService(parser_backend="simple")
            state.loaded_folder = None

    def test_requires_loaded_project_for_query_endpoints(self) -> None:
        response = self.client.get("/api/project/tops")
        self.assertEqual(response.status_code, 400)
        self.assertIn("No project loaded", response.json()["detail"])

    def test_project_load_hierarchy_and_graph_endpoints(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            (root / "child.v").write_text(
                """
module child(input clk, input a, output y);
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            (root / "top.v").write_text(
                """
module top(input clk, output y);
  wire local_net;
  child u1 (
    .clk(clk),
    .a(local_net),
    .y(y)
  );
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            with state_lock:
                state.service = ProjectService(parser_backend="simple")
                project = state.service.load_project(str(root))
                state.loaded_folder = str(root)

            self.assertEqual(len(project.source_files), 2)
            self.assertEqual(len(project.modules), 2)

            tops_response = self.client.get("/api/project/tops")
            self.assertEqual(tops_response.status_code, 200)
            self.assertEqual(tops_response.json()["top_candidates"], ["top"])

            project_response = self.client.get("/api/project")
            self.assertEqual(project_response.status_code, 200)
            self.assertIn("modules", project_response.json())

            tops_response = self.client.get("/api/project/tops")
            self.assertEqual(tops_response.status_code, 200)
            self.assertEqual(tops_response.json()["top_candidates"], ["top"])

            modules_response = self.client.get("/api/project/modules")
            self.assertEqual(modules_response.status_code, 200)
            self.assertEqual(modules_response.json()["modules"], ["child", "top"])

            module_response = self.client.get("/api/project/modules/top")
            self.assertEqual(module_response.status_code, 200)
            self.assertEqual(module_response.json()["name"], "top")

            hierarchy_response = self.client.get("/api/project/hierarchy/top")
            self.assertEqual(hierarchy_response.status_code, 200)
            hierarchy = hierarchy_response.json()
            self.assertEqual(hierarchy["module"], "top")
            self.assertEqual(hierarchy["instances"][0]["instance"], "u1")

            hierarchy_graph_response = self.client.get("/api/project/graph/top")
            self.assertEqual(hierarchy_graph_response.status_code, 200)
            hierarchy_graph = hierarchy_graph_response.json()
            self.assertEqual(hierarchy_graph["schema_version"], "1.0")
            self.assertEqual(hierarchy_graph["top_module"], "top")

            connectivity_response = self.client.get("/api/project/connectivity/top?mode=compact")
            self.assertEqual(connectivity_response.status_code, 200)
            connectivity_graph = connectivity_response.json()
            self.assertEqual(connectivity_graph["schema_version"], "1.1-connectivity")
            self.assertEqual(connectivity_graph["focus_module"], "top")
            self.assertEqual(connectivity_graph["mode"], "compact")

            aggregated_response = self.client.get("/api/project/connectivity/top?mode=compact&aggregate_edges=true")
            self.assertEqual(aggregated_response.status_code, 200)
            aggregated_graph = aggregated_response.json()
            self.assertTrue(all("net_count" in edge for edge in aggregated_graph["edges"]))

            port_view_response = self.client.get("/api/project/connectivity/top?mode=compact&port_view=true")
            self.assertEqual(port_view_response.status_code, 200)
            port_view_graph = port_view_response.json()
            self.assertTrue(port_view_graph["port_view"])
            self.assertTrue(any(node.get("kind") == "instance_port" for node in port_view_graph["nodes"]))

            schematic_response = self.client.get("/api/project/connectivity/top?schematic=true&schematic_mode=full")
            self.assertEqual(schematic_response.status_code, 200)
            schematic_graph = schematic_response.json()
            self.assertEqual(schematic_graph["view"], "schematic")
            self.assertEqual(schematic_graph["layout"]["engine"], "schematic-v2")

    def test_root_serves_ui_shell(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("RTL Architecture Visualizer", response.text)

    def test_save_invalid_source_keeps_cached_modules_and_graph(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            (root / "child.v").write_text(
                """
module child(input clk, input a, output y);
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            (root / "top.v").write_text(
                """
module top(input clk, output y);
  wire local_net;
  child u1 (
    .clk(clk),
    .a(local_net),
    .y(y)
  );
endmodule
""".strip()
                + "\n",
                encoding="utf-8",
            )

            with state_lock:
                state.service = ProjectService(parser_backend="simple")
                state.service.load_project(str(root))
                state.loaded_folder = str(root)

            save_response = self.client.put(
                "/api/project/modules/top/source",
                json={
                    "content": """
module top(input clk, output y);
  wire local_net;
  child u1 (
    .clk(clk),
    .a(local_net),
    .y(y)
  );
// missing endmodule on purpose
""".strip()
                    + "\n"
                },
            )
            self.assertEqual(save_response.status_code, 200)
            payload = save_response.json()
            self.assertTrue(payload["saved"])
            self.assertTrue(payload["reparse"]["kept_cached_project"])
            self.assertIn("warning", payload["reparse"])

            modules_response = self.client.get("/api/project/modules")
            self.assertEqual(modules_response.status_code, 200)
            self.assertEqual(modules_response.json()["modules"], ["child", "top"])

            connectivity_response = self.client.get("/api/project/connectivity/top?mode=compact")
            self.assertEqual(connectivity_response.status_code, 200)
            self.assertEqual(connectivity_response.json()["focus_module"], "top")

    def test_source_endpoint_is_not_blocked_by_slow_connectivity_build(self) -> None:
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)

            source_text = """
module top(input clk, output y);
  assign y = clk;
endmodule
""".strip() + "\n"
            (root / "top.v").write_text(source_text, encoding="utf-8")

            with state_lock:
                state.service = ProjectService(parser_backend="simple")
                state.service.load_project(str(root))
                state.loaded_folder = str(root)

            build_started = Event()
            allow_build_finish = Event()
            original_build = api_module.build_module_connectivity_graph
            connectivity_status: dict[str, int] = {}
            source_status: dict[str, object] = {}

            def slow_build(project, module_name, **kwargs):
                build_started.set()
                self.assertTrue(
                    allow_build_finish.wait(timeout=5),
                    "Timed out waiting to release mocked connectivity build",
                )
                return original_build(project, module_name, **kwargs)

            def request_connectivity() -> None:
                with TestClient(app) as client:
                    resp = client.get("/api/project/connectivity/top?mode=compact")
                    connectivity_status["code"] = resp.status_code

            def request_source() -> None:
                with TestClient(app) as client:
                    resp = client.get("/api/project/modules/top/source")
                    source_status["code"] = resp.status_code
                    source_status["json"] = resp.json()

            with patch.object(api_module, "build_module_connectivity_graph", side_effect=slow_build):
                connectivity_thread = Thread(target=request_connectivity)
                connectivity_thread.start()

                self.assertTrue(build_started.wait(timeout=2), "Connectivity build did not start")

                source_thread = Thread(target=request_source)
                source_thread.start()
                source_thread.join(timeout=1)

                self.assertFalse(
                    source_thread.is_alive(),
                    "Module source request was blocked by connectivity graph generation",
                )
                self.assertEqual(source_status["code"], 200)
                self.assertEqual(source_status["json"]["content"], source_text)

                allow_build_finish.set()
                connectivity_thread.join(timeout=2)

            self.assertEqual(connectivity_status["code"], 200)


if __name__ == "__main__":
    unittest.main()



