import unittest

from app.graph_builder import build_hierarchy_graph
from app.models import Instance, ModuleDef, Project, SourceFile


class TestGraphBuilder(unittest.TestCase):
    def test_builds_simple_nodes_and_edges(self) -> None:
        project = Project(
            root_path=".",
            source_files=[SourceFile(path="top.v"), SourceFile(path="child.v")],
            modules=[
                ModuleDef(
                    name="top",
                    instances=[
                        Instance(
                            name="u1",
                            module_name="child",
                            connections={"clk": "clk"},
                        )
                    ],
                    source_file="top.v",
                ),
                ModuleDef(name="child", instances=[], source_file="child.v"),
            ],
        )

        graph = build_hierarchy_graph(project, "top")

        self.assertEqual(
            graph["nodes"],
            [
                {"id": "top", "label": "top", "kind": "module"},
                {"id": "top/u1", "label": "u1: child", "kind": "instance"},
            ],
        )
        self.assertEqual(
            graph["edges"],
            [{"source": "top", "target": "top/u1", "kind": "hierarchy"}],
        )


if __name__ == "__main__":
    unittest.main()
