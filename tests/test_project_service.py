import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app.project_service import ProjectService


class TestProjectService(unittest.TestCase):
    def test_load_project_top_candidates_hierarchy_and_graphs(self) -> None:
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

            service = ProjectService(parser_backend="simple")
            project = service.load_project(str(root))

            self.assertEqual(len(project.source_files), 2)
            self.assertEqual(service.get_module_names(), ["child", "top"])

            top_candidates = service.get_top_candidates()
            self.assertEqual(top_candidates, ["top"])

            hierarchy = service.get_hierarchy_tree("top")
            self.assertEqual(hierarchy["module"], "top")
            self.assertEqual(hierarchy["instances"][0]["instance"], "u1")

            hierarchy_graph = service.get_module_graph("top")
            self.assertEqual(hierarchy_graph["schema_version"], "1.0")

            connectivity_graph = service.get_module_connectivity_graph("top", mode="compact")
            self.assertEqual(connectivity_graph["schema_version"], "1.1-connectivity")
            self.assertEqual(connectivity_graph["focus_module"], "top")

            node_ids = {node["id"] for node in connectivity_graph["nodes"]}
            self.assertIn("instance:u1", node_ids)
            self.assertIn("io:clk", node_ids)

            aggregated_graph = service.get_module_connectivity_graph("top", mode="compact", aggregate_edges=True)
            self.assertTrue(all("net_count" in edge for edge in aggregated_graph["edges"]))

            port_view_graph = service.get_module_connectivity_graph("top", mode="compact", port_view=True)
            self.assertTrue(port_view_graph["port_view"])
            self.assertTrue(any(node.get("kind") == "instance_port" for node in port_view_graph["nodes"]))

            with self.assertRaises(ValueError):
                service.get_hierarchy_tree("missing_module")

            with self.assertRaises(ValueError):
                service.get_module_connectivity_graph("missing_module")

    def test_requires_project_to_be_loaded(self) -> None:
        service = ProjectService(parser_backend="simple")

        with self.assertRaises(RuntimeError):
            service.get_top_candidates()

        with self.assertRaises(RuntimeError):
            service.get_hierarchy_tree("top")

        with self.assertRaises(RuntimeError):
            service.get_module_connectivity_graph("top")


if __name__ == "__main__":
    unittest.main()



