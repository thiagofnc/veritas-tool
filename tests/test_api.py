import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

try:
    from fastapi.testclient import TestClient

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

            load_response = self.client.post(
                "/api/project/load",
                json={"folder": str(root), "parser_backend": "simple"},
            )
            self.assertEqual(load_response.status_code, 200)
            summary = load_response.json()
            self.assertEqual(summary["file_count"], 2)
            self.assertEqual(summary["module_count"], 2)
            self.assertEqual(summary["top_candidates"], ["top"])

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

            port_view_response = self.client.get("/api/project/connectivity/top?mode=detailed&port_view=true")
            self.assertEqual(port_view_response.status_code, 200)
            port_view_graph = port_view_response.json()
            self.assertTrue(port_view_graph["port_view"])
            self.assertTrue(any(node["kind"] == "instance_port" for node in port_view_graph["nodes"]))

    def test_root_serves_ui_shell(self) -> None:
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("RTL Architecture Visualizer", response.text)


if __name__ == "__main__":
    unittest.main()



