import unittest

from app.graph_builder import build_hierarchy_graph
from app.models import Instance, ModuleDef, PinConnection, Port, Project, Signal, SourceFile


class TestGraphBuilder(unittest.TestCase):
    def test_builds_stable_schema_with_hierarchy_and_signal_edges(self) -> None:
        project = Project(
            root_path=".",
            source_files=[SourceFile(path="top.v"), SourceFile(path="child.v")],
            modules=[
                ModuleDef(
                    name="top",
                    ports=[Port(name="clk", direction="input")],
                    signals=[Signal(name="sig_a", kind="wire")],
                    instances=[
                        Instance(
                            name="u1",
                            module_name="child",
                            connections={"a": "sig_a", "clk": "clk"},
                            pin_connections=[
                                PinConnection(child_port="a", parent_signal="sig_a"),
                                PinConnection(child_port="clk", parent_signal="clk"),
                            ],
                        )
                    ],
                    source_file="top.v",
                ),
                ModuleDef(
                    name="child",
                    ports=[Port(name="a", direction="input"), Port(name="clk", direction="input")],
                    instances=[],
                    source_file="child.v",
                ),
            ],
        )

        graph = build_hierarchy_graph(project, "top")

        self.assertEqual(graph["schema_version"], "1.0")
        self.assertEqual(graph["top_module"], "top")

        node_ids = {node["id"] for node in graph["nodes"]}
        edge_tuples = {(edge["source"], edge["target"], edge["kind"]) for edge in graph["edges"]}
        node_kinds = {node["kind"] for node in graph["nodes"]}
        edge_kinds = {edge["kind"] for edge in graph["edges"]}

        self.assertTrue({"module", "instance", "port", "net"}.issubset(node_kinds))
        self.assertTrue({"hierarchy", "signal"}.issubset(edge_kinds))

        self.assertIn("module:top", node_ids)
        self.assertIn("instance:top/u1", node_ids)
        self.assertIn("module:top/u1:child", node_ids)

        self.assertIn("port:top:clk", node_ids)
        self.assertIn("net:top:clk", node_ids)
        self.assertIn("net:top:sig_a", node_ids)

        self.assertIn("port:instance:top/u1:a", node_ids)
        self.assertIn("port:instance:top/u1:clk", node_ids)

        self.assertIn(("module:top", "instance:top/u1", "hierarchy"), edge_tuples)
        self.assertIn(("instance:top/u1", "module:top/u1:child", "hierarchy"), edge_tuples)

        self.assertIn(("net:top:sig_a", "port:instance:top/u1:a", "signal"), edge_tuples)
        self.assertIn(("net:top:clk", "port:instance:top/u1:clk", "signal"), edge_tuples)


if __name__ == "__main__":
    unittest.main()
